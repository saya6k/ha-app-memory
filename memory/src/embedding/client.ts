// undici (not global fetch) so the unix-socket dispatcher and the fetch that
// honours it come from the same copy.
import { Agent, fetch, type Dispatcher } from 'undici';

import {
  EmbeddingError,
  type EmbeddingClient,
  type EmbeddingClientConfig,
  type EmbeddingRequestBody,
  type EmbeddingResponseBody,
} from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP client for an external OpenAI-compatible Embeddings API. Tools depend on the EmbeddingClient interface, not this class. */
export class HttpEmbeddingClient implements EmbeddingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(config: EmbeddingClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.dispatcher = config.socketPath
      ? new Agent({ connect: { socketPath: config.socketPath } })
      : undefined;
  }

  /**
   * Requests an embedding for `text`, retrying transient failures with a
   * fixed backoff (bounded by maxRetries). Never fails silently: exhausting
   * retries throws EmbeddingError with the last cause attached.
   */
  async embed(text: string): Promise<number[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.retryDelayMs * attempt);
      }

      try {
        return await this.requestEmbedding(text);
      } catch (error) {
        lastError = error;
      }
    }

    throw new EmbeddingError(
      `Embedding API failed after ${this.maxRetries + 1} attempt(s): ${String(lastError)}`,
    );
  }

  private async requestEmbedding(text: string): Promise<number[]> {
    const body: EmbeddingRequestBody = { input: text, model: this.model };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // The local sidecar is unauthenticated; only send the header when a key is configured.
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });

    if (!response.ok) {
      throw new EmbeddingError(`Embedding API returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as EmbeddingResponseBody;
    const embedding = json.data[0]?.embedding;
    if (!embedding) {
      throw new EmbeddingError('Embedding API response missing data[0].embedding');
    }

    return embedding;
  }
}
