import {
  EMBEDDING_API_KEY,
  EMBEDDING_BASE_URL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_DOCUMENT_PREFIX,
  EMBEDDING_MODEL,
  EMBEDDING_PROVIDER,
  EMBEDDING_QUERY_PREFIX,
  EMBEDDING_SOCKET_PATH,
  embeddingConfigProblem,
} from '../config.js';
import { createEmbeddingClient } from './client.js';
import type { EmbeddingClient } from './types.js';

/**
 * The embedding client the add-on is configured for, shared by the server and
 * the startup migration. Throws with the reason when a setting is missing.
 */
export function configuredEmbeddingClient(): EmbeddingClient {
  const problem = embeddingConfigProblem();
  if (problem) throw new Error(problem);

  return createEmbeddingClient(EMBEDDING_PROVIDER, {
    baseUrl: EMBEDDING_BASE_URL,
    // The socket only exists for the bundled sidecar.
    socketPath: EMBEDDING_PROVIDER === 'local' ? EMBEDDING_SOCKET_PATH : undefined,
    apiKey: EMBEDDING_API_KEY,
    model: EMBEDDING_MODEL,
    queryPrefix: EMBEDDING_QUERY_PREFIX,
    documentPrefix: EMBEDDING_DOCUMENT_PREFIX,
    dimensions: EMBEDDING_DIMENSIONS,
  });
}
