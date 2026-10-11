import type { DbConnection } from '../db/client.js';
import { searchManualChunks, type ManualChunkMatch } from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';

/** Shared by the MCP tool and the ingress panel, so both rank results the same way. */
export async function searchManuals(
  db: DbConnection,
  embeddingClient: EmbeddingClient,
  query: string,
  limit: number,
): Promise<ManualChunkMatch[]> {
  const embedding = await embeddingClient.embed(query, 'query');
  return searchManualChunks(db, embedding, limit);
}
