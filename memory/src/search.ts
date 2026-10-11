import type { DbConnection } from './db/client.js';
import { getFactsByIds } from './db/facts.js';
import { type Owner, SHARED, searchManualChunks } from './db/manuals.js';
import { knnSearch } from './db/vector.js';
import type { EmbeddingClient } from './embedding/types.js';

/**
 * sqlite-vec KNN doesn't compose safely with an arbitrary WHERE pre-filter,
 * so we over-fetch candidates and filter by owner and tags in the application
 * layer (tags ANY-match) before truncating to the requested limit. Fine at
 * personal scale (hundreds-thousands of facts).
 */
const CANDIDATE_FLOOR = 50;
const CANDIDATE_MULTIPLIER = 10;

export interface MemoryHit {
  type: 'memory';
  id: string;
  content: string;
  tags: string[];
  /** True for the user's own fact, false for a shared one. */
  personal: boolean;
  createdAt: string;
  updatedAt: string;
  distance: number;
}

export interface PassageHit {
  /** A shared appliance manual, or the user's own document. */
  type: 'manual' | 'document';
  manualId: string;
  title: string;
  file: string;
  format: 'pdf' | 'markdown';
  page?: number;
  section?: string;
  content: string;
  distance: number;
}

export type SearchHit = MemoryHit | PassageHit;

/**
 * Remembered facts, shared manuals and personal documents visible to `owners`,
 * ranked together by meaning. All are document-side embeddings from the same
 * model, so their distances compare. A tag filter means facts only, since
 * documents carry no tags. Used by the search tool and the panel alike.
 */
export async function searchAll(
  db: DbConnection,
  embeddingClient: EmbeddingClient,
  params: { query: string; limit: number; owners: Owner[]; tags?: string[] },
): Promise<SearchHit[]> {
  const { limit, owners, tags } = params;
  const embedding = await embeddingClient.embed(params.query, 'query');
  const matches = knnSearch(db, embedding, Math.max(limit * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR));
  const factsById = new Map(
    getFactsByIds(
      db,
      matches.map((m) => m.id),
    ).map((f) => [f.id, f]),
  );
  const tagged = tags !== undefined && tags.length > 0;

  const memories = matches.flatMap((match): MemoryHit[] => {
    const fact = factsById.get(match.id);
    if (!fact || !owners.includes(fact.owner)) return [];
    if (tagged && !tags.some((t) => fact.tags.includes(t))) return [];
    return [
      {
        type: 'memory',
        id: fact.id,
        content: fact.content,
        tags: fact.tags,
        personal: fact.owner !== SHARED,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
        distance: match.distance,
      },
    ];
  });

  const passages = tagged
    ? []
    : searchManualChunks(db, embedding, limit, owners).map((m): PassageHit => ({
        type: m.owner === SHARED ? 'manual' : 'document',
        manualId: m.manualId,
        title: m.title,
        file: m.path,
        format: m.format,
        ...(m.format === 'pdf' ? { page: m.page } : { section: m.section ?? undefined }),
        content: m.content,
        distance: m.distance,
      }));

  return [...memories, ...passages].sort((a, b) => a.distance - b.distance).slice(0, limit);
}
