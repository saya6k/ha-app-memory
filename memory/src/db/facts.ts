import type { DbConnection } from './client.js';

export class FactNotFoundError extends Error {
  constructor(id: string) {
    super(`Fact not found: ${id}`);
  }
}

export interface Fact {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function toFloat32(embedding: number[]): Float32Array {
  return new Float32Array(embedding);
}

function rowToFact(row: {
  id: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
}): Fact {
  return {
    id: row.id,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertFact(
  db: DbConnection,
  params: { id: string; content: string; tags: string[]; embedding: number[]; now: string },
): Fact {
  const insert = db.transaction(() => {
    db.prepare(
      'INSERT INTO facts (id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(params.id, params.content, JSON.stringify(params.tags), params.now, params.now);
    db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(
      params.id,
      toFloat32(params.embedding),
    );
  });
  insert();

  return {
    id: params.id,
    content: params.content,
    tags: params.tags,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function getFact(db: DbConnection, id: string): Fact | undefined {
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as
    | Parameters<typeof rowToFact>[0]
    | undefined;
  return row ? rowToFact(row) : undefined;
}

/**
 * Updates a fact's content/tags, and its vec_facts embedding only when the
 * caller supplies one (the caller decides whether content actually changed
 * and only pays for a re-embed when it did — see tools/update.ts).
 */
export function updateFact(
  db: DbConnection,
  params: { id: string; content: string; tags: string[]; embedding?: number[]; now: string },
): Fact {
  const update = db.transaction(() => {
    db.prepare('UPDATE facts SET content = ?, tags = ?, updated_at = ? WHERE id = ?').run(
      params.content,
      JSON.stringify(params.tags),
      params.now,
      params.id,
    );
    if (params.embedding) {
      db.prepare('UPDATE vec_facts SET embedding = ? WHERE id = ?').run(
        toFloat32(params.embedding),
        params.id,
      );
    }
  });
  update();

  const fact = getFact(db, params.id);
  if (!fact) throw new FactNotFoundError(params.id);
  return fact;
}

/** Hard-deletes a single fact from both tables, transactionally. No whole-DB path exists (SPEC §8 Never). */
export function deleteFact(db: DbConnection, id: string): void {
  if (!getFact(db, id)) {
    throw new FactNotFoundError(id);
  }

  const del = db.transaction(() => {
    db.prepare('DELETE FROM facts WHERE id = ?').run(id);
    db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
  });
  del();
}

/** Fetches facts by id, returned in the same order as `ids` (unknown ids are skipped). */
export function getFactsByIds(db: DbConnection, ids: string[]): Fact[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`)
    .all(...ids) as Parameters<typeof rowToFact>[0][];

  const byId = new Map(rows.map((row) => [row.id, rowToFact(row)]));
  return ids.flatMap((id) => {
    const fact = byId.get(id);
    return fact ? [fact] : [];
  });
}
