// undici (not global fetch) so the unix-socket dispatcher and the fetch that
// honours it come from the same copy.
import { Agent, fetch, type Dispatcher } from 'undici';

import type { EmbeddingProvider } from '../config.js';
import {
  EmbeddingError,
  type EmbeddingClient,
  type EmbeddingClientConfig,
  type EmbeddingKind,
  type EmbeddingRequestBody,
  type EmbeddingResponseBody,
} from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 200;
/** A remote service that has not answered by then is not going to. */
const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What every provider shares: the prefix for the kind of text, bounded
 * retries, auth, a timeout, and a check that the vector has the configured
 * width — a model of a different size would otherwise fail later and far less
 * clearly, inside sqlite-vec. Subclasses only build the request and read the
 * vector out of the response.
 */
abstract class BaseEmbeddingClient implements EmbeddingClient {
  protected readonly config: EmbeddingClientConfig;
  private readonly prefixes: Record<EmbeddingKind, string>;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(config: EmbeddingClientConfig) {
    this.config = config;
    this.prefixes = { query: config.queryPrefix ?? '', document: config.documentPrefix ?? '' };
    this.dispatcher = config.socketPath
      ? new Agent({ connect: { socketPath: config.socketPath } })
      : undefined;
  }

  /**
   * Requests an embedding for `text`, with the prefix for its `kind` prepended,
   * retrying transient failures with a fixed backoff (bounded by maxRetries).
   * Never fails silently: exhausting retries throws EmbeddingError with the
   * last cause attached.
   */
  async embed(text: string, kind: EmbeddingKind): Promise<number[]> {
    const input = this.prefixes[kind] + text;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelayMs * attempt);
      }

      let embedding: number[];
      try {
        embedding = await this.request(input);
      } catch (error) {
        lastError = error;
        continue;
      }
      // Outside the retry: a wrong width is a setting, not a passing failure.
      return this.checkWidth(embedding);
    }

    throw new EmbeddingError(
      `Embedding API failed after ${maxRetries + 1} attempt(s): ${String(lastError)}`,
      { transient: isTransient(lastError) },
    );
  }

  private checkWidth(embedding: number[]): number[] {
    const expected = this.config.dimensions;
    if (expected !== undefined && embedding.length !== expected) {
      throw new EmbeddingError(
        `The embedding model returned ${embedding.length} dimensions, but ` +
          `embedding_dimensions is ${expected}. Set embedding_dimensions to ${embedding.length}.`,
      );
    }
    return embedding;
  }

  protected abstract request(input: string): Promise<number[]>;

  /** POSTs JSON and returns the parsed response, with auth when a key is set. */
  protected async post(url: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // The local sidecar is unauthenticated; only send the header when a key is configured.
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });

    if (!response.ok) {
      throw new EmbeddingError(`Embedding API returned HTTP ${response.status}`, {
        transient: response.status === 429 || response.status >= 500,
      });
    }
    return response.json();
  }
}

/** Network failures and timeouts are transient; so is what post() marked so. */
function isTransient(error: unknown): boolean {
  if (error instanceof EmbeddingError) return error.transient;
  // fetch rejects with a TypeError when it cannot connect, and with a
  // DOMException named TimeoutError when AbortSignal.timeout fires.
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number');
}

/**
 * The OpenAI embeddings API (`POST {baseUrl}/embeddings`), which the local
 * llama.cpp sidecar also speaks, as do many self-hosted servers.
 */
export class HttpEmbeddingClient extends BaseEmbeddingClient {
  protected async request(input: string): Promise<number[]> {
    const body: EmbeddingRequestBody = { input, model: this.config.model };
    const json = (await this.post(`${this.config.baseUrl}/embeddings`, body)) as
      EmbeddingResponseBody | undefined;
    const embedding = json?.data?.[0]?.embedding;
    if (!isVector(embedding)) {
      throw new EmbeddingError('Embedding API response missing data[0].embedding');
    }
    return embedding;
  }
}

/**
 * Ollama's `POST {baseUrl}/api/embed`. truncate is turned off: Ollama would
 * otherwise silently cut a long chunk to fit the model's context, and the
 * rest of it would never be found.
 */
export class OllamaEmbeddingClient extends BaseEmbeddingClient {
  protected async request(input: string): Promise<number[]> {
    const json = (await this.post(`${this.config.baseUrl}/api/embed`, {
      model: this.config.model,
      input,
      truncate: false,
    })) as { embeddings?: unknown[] } | undefined;
    const embedding = json?.embeddings?.[0];
    if (!isVector(embedding)) {
      throw new EmbeddingError('Ollama response missing embeddings[0]');
    }
    return embedding;
  }
}

/**
 * Hugging Face feature extraction: `POST {baseUrl}` with `{"inputs": text}`,
 * as served by the Inference Providers router and by Text Embeddings
 * Inference's /embed. The answer is the vector, or a one-row list of it. A
 * model that is not a sentence-embedding model answers with one vector per
 * token instead, which cannot be used as is.
 */
export class HuggingFaceEmbeddingClient extends BaseEmbeddingClient {
  protected async request(input: string): Promise<number[]> {
    const json = await this.post(this.config.baseUrl, { inputs: input });
    if (isVector(json)) return json;
    if (Array.isArray(json) && json.length === 1 && isVector(json[0])) return json[0];
    throw new EmbeddingError(
      'Hugging Face did not return a single sentence embedding; use a sentence-embedding ' +
        'model (one listed for feature extraction, e.g. a sentence-transformers model)',
    );
  }
}

/** The client for a provider. */
export function createEmbeddingClient(
  provider: EmbeddingProvider,
  config: EmbeddingClientConfig,
): EmbeddingClient {
  switch (provider) {
    case 'ollama':
      return new OllamaEmbeddingClient(config);
    case 'huggingface':
      return new HuggingFaceEmbeddingClient(config);
    case 'local':
    case 'openai':
      return new HttpEmbeddingClient(config);
  }
}
