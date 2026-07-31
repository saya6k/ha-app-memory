export const MCP_PORT = Number(process.env.MCP_PORT ?? 8099);

/** One of the Home Assistant log levels; see log.ts. Unknown values fall back to info. */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

export const DB_PATH = process.env.DB_PATH ?? './data/facts.sqlite';

/**
 * Local llama-server embedding sidecar. When EMBEDDING_SOCKET_PATH is set the
 * host part of this URL is never dialed — it only has to be a well-formed URL.
 */
export const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL ?? 'http://localhost';

/**
 * Unix domain socket for the sidecar. Preferred over TCP: it makes "the sidecar
 * is never network-reachable" structural rather than a config convention
 * (SPEC §8 Never). Unset falls back to dialing EMBEDDING_BASE_URL over TCP.
 */
export const EMBEDDING_SOCKET_PATH = process.env.EMBEDDING_SOCKET_PATH;

/** Optional: the local sidecar needs no auth. Only sent when set, so an external API stays usable. */
export const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY;

/** Echoed back by llama-server; only meaningful when pointed at an external API. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-0.6B';

/** Qwen3-Embedding-0.6B native output size (SPEC §8 Ask First to change). */
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
