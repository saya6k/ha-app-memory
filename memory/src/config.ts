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
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'embeddinggemma-2';

/**
 * Prepended to search queries and to stored facts respectively. The add-on
 * always sets both (config.yaml holds EmbeddingGemma 2's
 * "task: search result | query: " and "title: none | text: "); empty here
 * means plain text, for running the server outside the add-on.
 */
export const EMBEDDING_QUERY_PREFIX = process.env.EMBEDDING_QUERY_PREFIX ?? '';
export const EMBEDDING_DOCUMENT_PREFIX = process.env.EMBEDDING_DOCUMENT_PREFIX ?? '';

/** EmbeddingGemma 2 native output size (SPEC §8 Ask First to change). */
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 768);

/**
 * Appliance manuals: PDFs the user drops into this directory (the add-on maps
 * /share read-only and points this at /share/manuals). Only ever read.
 */
export const MANUALS_DIR = process.env.MANUALS_DIR ?? './data/manuals';

/** Ingress panel. Kept off MCP_PORT so the UI can be restricted on its own. */
export const UI_PORT = Number(process.env.UI_PORT ?? 8100);

/**
 * When set, the UI only answers this remote address — the add-on sets the
 * Supervisor's ingress proxy (172.30.32.2). Unset accepts anyone, for local runs.
 */
export const UI_ALLOWED_ADDRESS = process.env.UI_ALLOWED_ADDRESS;

/**
 * Per-user data: <USERS_DIR>/<HA user id>/documents holds that person's
 * personal documents, uploaded through the panel. Inside /data in the add-on,
 * so it is private to the add-on and backed up with it.
 */
export const USERS_DIR = process.env.USERS_DIR ?? './data/users';

/**
 * Home Assistant's REST API through the Supervisor proxy, used to look up the
 * household's people. SUPERVISOR_TOKEN is provided by the Supervisor; without
 * it (running outside Home Assistant) nobody is known and everything is shared.
 */
export const HA_API_URL = process.env.HA_API_URL ?? 'http://supervisor/core/api';
export const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
