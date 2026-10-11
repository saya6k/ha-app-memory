export const MCP_PORT = Number(process.env.MCP_PORT ?? 8099);

/** One of the Home Assistant log levels; see log.ts. Unknown values fall back to info. */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

export const DB_PATH = process.env.DB_PATH ?? './data/facts.sqlite';

export const EMBEDDING_PROVIDERS = ['local', 'openai', 'huggingface', 'ollama'] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * Where embeddings come from: the bundled llama.cpp sidecar (`local`), or a
 * remote service speaking the OpenAI, Hugging Face or Ollama embeddings API.
 * Anything remote sends the text of every fact, document and query there.
 */
export const EMBEDDING_PROVIDER: EmbeddingProvider = EMBEDDING_PROVIDERS.includes(
  process.env.EMBEDDING_PROVIDER as EmbeddingProvider,
)
  ? (process.env.EMBEDDING_PROVIDER as EmbeddingProvider)
  : 'local';

/** Echoed back by llama-server; the model to ask for when the service is remote. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'embeddinggemma-2';

/**
 * Where to send embedding requests, per provider:
 * - local, openai: an OpenAI-compatible base URL including /v1, to which
 *   /embeddings is appended. For the sidecar the host is never dialed when
 *   EMBEDDING_SOCKET_PATH is set — it only has to be a well-formed URL.
 * - huggingface: the full feature-extraction URL; by default the Inference
 *   Providers router's hf-inference endpoint for the model. A self-hosted Text
 *   Embeddings Inference server works too, as http://host/embed.
 * - ollama: the server, e.g. http://192.168.1.10:11434, to which /api/embed is
 *   appended. Required: Ollama has no well-known public address.
 */
export const EMBEDDING_BASE_URL =
  process.env.EMBEDDING_BASE_URL ||
  {
    local: 'http://localhost/v1',
    openai: 'https://api.openai.com/v1',
    huggingface: `https://router.huggingface.co/hf-inference/models/${EMBEDDING_MODEL}/pipeline/feature-extraction`,
    ollama: '',
  }[EMBEDDING_PROVIDER];

/**
 * Unix domain socket for the sidecar. Preferred over TCP: it makes "the sidecar
 * is never network-reachable" structural rather than a config convention
 * (SPEC §8 Never). Unset falls back to dialing EMBEDDING_BASE_URL over TCP.
 */
export const EMBEDDING_SOCKET_PATH = process.env.EMBEDDING_SOCKET_PATH;

/** Optional: the local sidecar needs no auth. Only sent when set, so an external API stays usable. */
export const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY;

/**
 * Names the space the stored vectors live in, recorded in the database so a
 * change of model is noticed and everything re-embedded. The local sidecar's
 * id is the model file name alone, as it always was, so existing databases
 * keep matching; a remote model is told apart by its provider.
 */
export const EMBEDDING_MODEL_ID =
  EMBEDDING_PROVIDER === 'local' ? EMBEDDING_MODEL : `${EMBEDDING_PROVIDER}/${EMBEDDING_MODEL}`;

/**
 * Why the embedding settings cannot work, or undefined when they can. Checked
 * at startup so a missing setting stops the add-on with a clear message rather
 * than failing on the first save.
 */
export function embeddingConfigProblem(): string | undefined {
  if (EMBEDDING_PROVIDER === 'local') return undefined;
  if (!process.env.EMBEDDING_MODEL) {
    return `embedding_model must be set when embedding_provider is ${EMBEDDING_PROVIDER}`;
  }
  if (!EMBEDDING_BASE_URL) {
    return `embedding_url must be set when embedding_provider is ${EMBEDDING_PROVIDER}`;
  }
  return undefined;
}

/**
 * Longest stretch of text, in characters, embedded as one chunk of a manual or
 * document. It has to fit the model's context with the title and prefix in
 * front: Korean runs close to one token per character in the worst case.
 * Changing it re-indexes the documents; facts are always embedded whole.
 */
export const CHUNK_SIZE = Number(process.env.CHUNK_SIZE) || 400;

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
 * Shared appliance manuals: PDF and Markdown files in this directory (the
 * add-on points it at /share/manuals). Written only by the panel's upload and
 * delete.
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
