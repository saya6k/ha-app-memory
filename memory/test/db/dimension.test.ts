import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Changing model or embedding_dimensions against an existing database is the
 * one config change that can corrupt the add-on's behaviour, so pin down what
 * actually happens. config.ts reads the env once at import, hence resetModules.
 */
const DEFAULT_MODEL = 'model-a.gguf';

async function openAs(
  { dims = 1024, model = DEFAULT_MODEL }: { dims?: number; model?: string },
  path: string,
) {
  vi.resetModules();
  process.env.EMBEDDING_DIMENSIONS = String(dims);
  process.env.EMBEDDING_MODEL = model;
  const { openDb, DimensionMismatchError, ModelMismatchError } =
    await import('../../src/db/client.js');
  return { openDb: () => openDb(path), DimensionMismatchError, ModelMismatchError };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-dim-'));
  path = join(dir, 'facts.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_MODEL;
});

async function seed(opts: { dims?: number; model?: string } = {}): Promise<void> {
  const { openDb } = await openAs(opts, path);
  const db = openDb();
  db.prepare(
    "INSERT INTO facts (id, content, tags, created_at, updated_at) VALUES ('a','x','[]','t','t')",
  ).run();
  db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(
    'a',
    new Float32Array(opts.dims ?? 1024).fill(0.1),
  );
  db.close();
}

describe('embedding_dimensions vs an existing database', () => {
  it('reopening at the same width keeps the data usable', async () => {
    await seed({ dims: 1024 });

    const { openDb } = await openAs({ dims: 1024 }, path);
    const db = openDb();
    const rows = db
      .prepare('SELECT id FROM vec_facts WHERE embedding MATCH ? AND k = 5')
      .all(new Float32Array(1024).fill(0.1)) as { id: string }[];

    expect(rows.map((r) => r.id)).toEqual(['a']);
    db.close();
  });

  it('rejects a changed width at open time, naming both values', async () => {
    await seed({ dims: 1024 });

    const { openDb, DimensionMismatchError } = await openAs({ dims: 768 }, path);
    expect(openDb).toThrow(DimensionMismatchError);
    expect(openDb).toThrow(/stores 1024-dimension vectors/);
    expect(openDb).toThrow(/set to 768/);
  });

  it('leaves the existing vectors intact after a rejected open', async () => {
    await seed({ dims: 1024 });

    const rejected = await openAs({ dims: 768 }, path);
    expect(rejected.openDb).toThrow(rejected.DimensionMismatchError);

    // Reverting the option must bring the memory back, not find it truncated.
    const { openDb } = await openAs({ dims: 1024 }, path);
    const db = openDb();
    expect(db.prepare('SELECT count(*) AS c FROM vec_facts').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT count(*) AS c FROM facts').get()).toEqual({ c: 1 });
    db.close();
  });

  it('a fresh database simply adopts the configured width', async () => {
    const { openDb } = await openAs({ dims: 384 }, path);
    const db = openDb();
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_facts'").get() as {
      sql: string;
    };

    expect(ddl.sql).toContain('FLOAT[384]');
    db.close();
  });
});

describe('embedding model vs an existing database', () => {
  it('records the model that wrote a fresh database', async () => {
    const { openDb } = await openAs({ model: 'model-a.gguf' }, path);
    const db = openDb();

    expect(db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get()).toEqual({
      value: 'model-a.gguf',
    });
    db.close();
  });

  it('reopening with the same model is fine', async () => {
    await seed({ model: 'model-a.gguf' });

    const { openDb } = await openAs({ model: 'model-a.gguf' }, path);
    const db = openDb();
    expect(db.prepare('SELECT count(*) AS c FROM facts').get()).toEqual({ c: 1 });
    db.close();
  });

  it('rejects a model swap at the same width, naming both models', async () => {
    // The width still matches, so nothing in the vec0 table can catch this —
    // searches would simply stop finding the old memories.
    await seed({ dims: 1024, model: 'model-a.gguf' });

    const { openDb, ModelMismatchError } = await openAs(
      { dims: 1024, model: 'model-b.gguf' },
      path,
    );
    expect(openDb).toThrow(ModelMismatchError);
    expect(openDb).toThrow(/"model-a\.gguf"/);
    expect(openDb).toThrow(/"model-b\.gguf"/);
  });

  it('leaves the data intact after a rejected model swap', async () => {
    await seed({ model: 'model-a.gguf' });

    const rejected = await openAs({ model: 'model-b.gguf' }, path);
    expect(rejected.openDb).toThrow(rejected.ModelMismatchError);

    const { openDb } = await openAs({ model: 'model-a.gguf' }, path);
    const db = openDb();
    expect(db.prepare('SELECT count(*) AS c FROM facts').get()).toEqual({ c: 1 });
    db.close();
  });

  it('adopts the current model for a database written before meta existed', async () => {
    await seed({ model: 'model-a.gguf' });

    // Simulate the older schema: facts and vectors present, no meta row.
    const { openDb: reopen } = await openAs({ model: 'model-a.gguf' }, path);
    const pre = reopen();
    pre.exec('DELETE FROM meta');
    pre.close();

    const { openDb } = await openAs({ model: 'model-b.gguf' }, path);
    const db = openDb();

    expect(db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get()).toEqual({
      value: 'model-b.gguf',
    });
    expect(db.prepare('SELECT count(*) AS c FROM facts').get()).toEqual({ c: 1 });
    db.close();
  });
});
