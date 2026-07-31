import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../../src/config.js';
import { type DbConnection, openDb } from '../../src/db/client.js';

let dir: string;
let db: DbConnection;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-test-'));
  db = openDb(join(dir, 'facts.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeEmbedding(seed: number): Float32Array {
  return new Float32Array(EMBEDDING_DIMENSIONS).fill(seed);
}

describe('sqlite-vec schema', () => {
  it('creates the facts and vec_facts tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('facts');
    expect(names).toContain('vec_facts');
  });

  it('inserts and reads back a fact via parameter binding (no string concatenation)', () => {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO facts (id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('fact-1', 'the sky is blue', JSON.stringify(['color']), now, now);
    db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(
      'fact-1',
      fakeEmbedding(0.1),
    );

    const row = db.prepare('SELECT * FROM facts WHERE id = ?').get('fact-1') as {
      id: string;
      content: string;
    };
    expect(row.content).toBe('the sky is blue');

    const vecRow = db.prepare('SELECT id FROM vec_facts WHERE id = ?').get('fact-1');
    expect(vecRow).toBeDefined();
  });

  it('supports cosine KNN search over vec_facts', () => {
    const now = new Date().toISOString();
    for (const [id, seed] of [
      ['a', 0.1],
      ['b', 0.5],
      ['c', 0.9],
    ] as const) {
      db.prepare(
        'INSERT INTO facts (id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, `content-${id}`, '[]', now, now);
      db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(id, fakeEmbedding(seed));
    }

    const results = db
      .prepare(
        `SELECT id, distance FROM vec_facts WHERE embedding MATCH ? AND k = 3 ORDER BY distance`,
      )
      .all(fakeEmbedding(0.1)) as { id: string; distance: number }[];

    expect(results).toHaveLength(3);
    expect(results[0]?.id).toBe('a');
  });

  it('deletes a fact from both tables via parameter binding', () => {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO facts (id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('fact-2', 'to be deleted', '[]', now, now);
    db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(
      'fact-2',
      fakeEmbedding(0.2),
    );

    db.prepare('DELETE FROM facts WHERE id = ?').run('fact-2');
    db.prepare('DELETE FROM vec_facts WHERE id = ?').run('fact-2');

    expect(db.prepare('SELECT id FROM facts WHERE id = ?').get('fact-2')).toBeUndefined();
    expect(db.prepare('SELECT id FROM vec_facts WHERE id = ?').get('fact-2')).toBeUndefined();
  });
});
