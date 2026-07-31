import type { DbConnection } from './client.js';

export interface KnnMatch {
  id: string;
  distance: number;
}

/**
 * Raw KNN over vec_facts, cosine distance ascending. `excludeId` skips a row
 * (used by the `similar` tool to exclude the query fact itself) — done here via
 * an extra `k` pad since vec0 doesn't support a WHERE id != ? pre-filter
 * alongside MATCH.
 */
export function knnSearch(
  db: DbConnection,
  embedding: number[],
  k: number,
  excludeId?: string,
): KnnMatch[] {
  const fetchK = excludeId ? k + 1 : k;
  const rows = db
    .prepare('SELECT id, distance FROM vec_facts WHERE embedding MATCH ? AND k = ? ORDER BY distance')
    .all(new Float32Array(embedding), fetchK) as KnnMatch[];

  return (excludeId ? rows.filter((r) => r.id !== excludeId) : rows).slice(0, k);
}

export function getEmbedding(db: DbConnection, id: string): number[] | undefined {
  const row = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return undefined;
  return Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
}
