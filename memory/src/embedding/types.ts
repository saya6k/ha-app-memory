export interface EmbeddingClientConfig {
  /**
   * Where requests go; what is appended depends on the provider (see
   * EMBEDDING_BASE_URL in config.ts). Host is unused when socketPath is set.
   */
  baseUrl: string;
  /** When set, connect over this unix domain socket instead of TCP. */
  socketPath?: string;
  /** Optional: omitted for the local sidecar; when set, sent as `Authorization: Bearer {apiKey}`. */
  apiKey?: string;
  /** Sent as the request body's `model` field. */
  model: string;
  /** Prepended to search queries. Asymmetric models (EmbeddingGemma) expect a task prefix here. */
  queryPrefix?: string;
  /** Prepended to stored facts. Changing it changes every stored vector. */
  documentPrefix?: string;
  /** The vector width the database expects; a model answering otherwise is an error. */
  dimensions?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

/** A search query, or a fact being stored. Asymmetric models embed the two differently. */
export type EmbeddingKind = 'query' | 'document';

/** Abstraction tools depend on, so tests can supply a fake without an HTTP round trip. */
export interface EmbeddingClient {
  embed(text: string, kind: EmbeddingKind): Promise<number[]>;
}

export class EmbeddingError extends Error {
  /**
   * True when trying again later may succeed: the service could not be
   * reached, was busy (429) or failed (5xx) — e.g. still loading the model.
   * A rejected key, a bad request or a model of the wrong width is not.
   */
  readonly transient: boolean;

  constructor(message: string, options: { transient?: boolean } = {}) {
    super(message);
    this.transient = options.transient ?? false;
  }
}

export interface EmbeddingRequestBody {
  input: string;
  model: string;
}

export interface EmbeddingResponseBody {
  data: { embedding: number[] }[];
}
