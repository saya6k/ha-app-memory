export interface EmbeddingClientConfig {
  /** e.g. http://localhost — injected, never hardcoded. Host is unused when socketPath is set. */
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
  maxRetries?: number;
  retryDelayMs?: number;
}

/** A search query, or a fact being stored. Asymmetric models embed the two differently. */
export type EmbeddingKind = 'query' | 'document';

/** Abstraction tools depend on, so tests can supply a fake without an HTTP round trip. */
export interface EmbeddingClient {
  embed(text: string, kind: EmbeddingKind): Promise<number[]>;
}

export class EmbeddingError extends Error {}

export interface EmbeddingRequestBody {
  input: string;
  model: string;
}

export interface EmbeddingResponseBody {
  data: { embedding: number[] }[];
}
