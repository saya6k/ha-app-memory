import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../config.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { openDb, type DbConnection } from './client.js';
import { META_EMBEDDING_MODEL } from './schema.js';

export type MigrationStatus = 'up-to-date' | 'migrated';

export interface MigrationResult {
  status: MigrationStatus;
  /** Why a migration was needed; absent when already up to date. */
  reason?: string;
  factCount: number;
}

interface StoredState {
  model: string | undefined;
  dimensions: number | undefined;
}

function readState(db: DbConnection): StoredState {
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_EMBEDDING_MODEL) as
    | { value: string }
    | undefined;
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_facts'").get() as
    | { sql: string }
    | undefined;
  const width = ddl?.sql.match(/FLOAT\[(\d+)\]/)?.[1];

  return {
    model: meta?.value,
    dimensions: width === undefined ? undefined : Number(width),
  };
}

/** Null when the database already matches the configured model and width. */
function migrationReason(state: StoredState, factCount: number): string | undefined {
  if (state.dimensions !== undefined && state.dimensions !== EMBEDDING_DIMENSIONS) {
    return `vector width changed (${state.dimensions} -> ${EMBEDDING_DIMENSIONS})`;
  }

  if (state.model === undefined) {
    // Written before `meta` existed, so the model that produced these vectors
    // is unknown. Re-embedding is the only way to be sure they are usable;
    // assuming the current model would risk a silently broken memory.
    return factCount > 0 ? 'database predates model tracking' : undefined;
  }

  if (state.model !== EMBEDDING_MODEL) {
    return `embedding model changed ("${state.model}" -> "${EMBEDDING_MODEL}")`;
  }

  return undefined;
}

/**
 * Brings the vector table in line with the configured embedding model, by
 * re-embedding every stored fact from its content.
 *
 * Embeddings are all computed *before* anything is written, so a failure
 * part-way leaves the database exactly as it was — there is no half-migrated
 * state to recover from. The rewrite itself is a single transaction.
 */
export async function migrate(
  path: string,
  embedding: EmbeddingClient,
  onProgress?: (done: number, total: number) => void,
): Promise<MigrationResult> {
  const db = openDb(path, { unchecked: true });

  try {
    const facts = db.prepare('SELECT id, content FROM facts ORDER BY created_at').all() as {
      id: string;
      content: string;
    }[];
    const reason = migrationReason(readState(db), facts.length);

    if (reason === undefined) {
      return { status: 'up-to-date', factCount: facts.length };
    }

    const vectors: { id: string; embedding: Float32Array }[] = [];
    for (const [index, fact] of facts.entries()) {
      vectors.push({
        id: fact.id,
        embedding: new Float32Array(await embedding.embed(fact.content)),
      });
      onProgress?.(index + 1, facts.length);
    }

    db.transaction(() => {
      // vec0 fixes a table's width at creation, so a width change means
      // recreating it rather than rewriting rows in place.
      db.exec('DROP TABLE IF EXISTS vec_facts');
      db.exec(
        `CREATE VIRTUAL TABLE vec_facts USING vec0(
           id TEXT PRIMARY KEY,
           embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
         )`,
      );

      const insert = db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)');
      for (const vector of vectors) {
        insert.run(vector.id, vector.embedding);
      }

      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        META_EMBEDDING_MODEL,
        EMBEDDING_MODEL,
      );
    })();

    return { status: 'migrated', reason, factCount: facts.length };
  } finally {
    db.close();
  }
}
