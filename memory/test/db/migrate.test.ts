import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmbeddingClient } from '../../src/embedding/types.js';

/**
 * The migration is the one path allowed to rewrite existing vectors, so its
 * failure modes matter as much as its happy path. config.ts reads the env once
 * at import, hence resetModules between configurations.
 */
async function moduleFor({ dims = 1024, model = 'model-a.gguf' }: { dims?: number; model?: string }) {
  vi.resetModules();
  process.env.EMBEDDING_DIMENSIONS = String(dims);
  process.env.EMBEDDING_MODEL = model;
  const { migrate } = await import('../../src/db/migrate.js');
  const { openDb } = await import('../../src/db/client.js');
  return { migrate, openDb };
}

/** Distinct per model, so a re-embed is observable in the stored vectors. */
function fakeClient(fill: number, dims = 1024): EmbeddingClient & { calls: number } {
  return {
    calls: 0,
    async embed(this: { calls: number }) {
      this.calls += 1;
      return new Array(dims).fill(fill) as number[];
    },
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-migrate-'));
  path = join(dir, 'facts.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_MODEL;
});

async function seed(opts: { dims?: number; model?: string }, contents: string[]): Promise<void> {
  const { openDb } = await moduleFor(opts);
  const db = openDb(path);
  const dims = opts.dims ?? 1024;
  contents.forEach((content, i) => {
    db.prepare(
      'INSERT INTO facts (id, content, tags, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run(`id-${i}`, content, '[]', `2026-01-0${i + 1}`, `2026-01-0${i + 1}`);
    db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(
      `id-${i}`,
      new Float32Array(dims).fill(0.1),
    );
  });
  db.close();
}

describe('re-embedding migration', () => {
  it('passes without touching the sidecar when the model is unchanged', async () => {
    await seed({ model: 'model-a.gguf' }, ['one', 'two']);

    const { migrate } = await moduleFor({ model: 'model-a.gguf' });
    const client = fakeClient(0.5);
    const result = await migrate(path, client);

    expect(result.status).toBe('up-to-date');
    expect(result.factCount).toBe(2);
    expect(client.calls).toBe(0);
  });

  it('re-embeds every fact when the model changes, and records the new model', async () => {
    await seed({ model: 'model-a.gguf' }, ['one', 'two', 'three']);

    const { migrate, openDb } = await moduleFor({ model: 'model-b.gguf' });
    const client = fakeClient(0.9);
    const result = await migrate(path, client);

    expect(result.status).toBe('migrated');
    expect(result.reason).toMatch(/embedding model changed/);
    expect(client.calls).toBe(3);

    // openDb applies the compatibility guards, so this only succeeds if the
    // migration recorded the new model.
    const db = openDb(path);
    const row = db
      .prepare('SELECT embedding FROM vec_facts WHERE id = ?')
      .get('id-0') as { embedding: Buffer };
    expect(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, 1)[0]).toBeCloseTo(
      0.9,
    );
    db.close();
  });

  it('rebuilds the vector table at the new width when dimensions change', async () => {
    await seed({ dims: 1024, model: 'model-a.gguf' }, ['one']);

    const { migrate, openDb } = await moduleFor({ dims: 384, model: 'model-a.gguf' });
    const result = await migrate(path, fakeClient(0.2, 384));

    expect(result.status).toBe('migrated');
    expect(result.reason).toMatch(/vector width changed \(1024 -> 384\)/);

    const db = openDb(path);
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_facts'").get() as {
      sql: string;
    };
    expect(ddl.sql).toContain('FLOAT[384]');
    expect(db.prepare('SELECT count(*) AS c FROM vec_facts').get()).toEqual({ c: 1 });
    db.close();
  });

  it('keeps the facts themselves untouched across a migration', async () => {
    await seed({ model: 'model-a.gguf' }, ['백엔드는 타입스크립트로 쓴다', 'second']);

    const { migrate, openDb } = await moduleFor({ model: 'model-b.gguf' });
    await migrate(path, fakeClient(0.4));

    const db = openDb(path);
    const rows = db.prepare('SELECT id, content FROM facts ORDER BY created_at').all();
    expect(rows).toEqual([
      { id: 'id-0', content: '백엔드는 타입스크립트로 쓴다' },
      { id: 'id-1', content: 'second' },
    ]);
    db.close();
  });

  it('leaves the database completely unchanged when embedding fails part-way', async () => {
    await seed({ model: 'model-a.gguf' }, ['one', 'two', 'three']);

    const failing: EmbeddingClient = {
      async embed() {
        throw new Error('sidecar went away');
      },
    };

    const { migrate } = await moduleFor({ model: 'model-b.gguf' });
    await expect(migrate(path, failing)).rejects.toThrow(/sidecar went away/);

    // Still the old model, still the old vectors — nothing half-written.
    const { openDb } = await moduleFor({ model: 'model-a.gguf' });
    const db = openDb(path);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get()).toEqual({
      value: 'model-a.gguf',
    });
    expect(db.prepare('SELECT count(*) AS c FROM vec_facts').get()).toEqual({ c: 3 });
    db.close();
  });

  it('re-embeds a database that predates model tracking rather than assuming', async () => {
    await seed({ model: 'model-a.gguf' }, ['one']);

    const pre = await moduleFor({ model: 'model-a.gguf' });
    const db = pre.openDb(path);
    db.exec('DELETE FROM meta');
    db.close();

    const { migrate } = await moduleFor({ model: 'model-a.gguf' });
    const client = fakeClient(0.7);
    const result = await migrate(path, client);

    expect(result.status).toBe('migrated');
    expect(result.reason).toMatch(/predates model tracking/);
    expect(client.calls).toBe(1);
  });

  it('adopts the model on an empty database without calling the sidecar', async () => {
    const { migrate } = await moduleFor({ model: 'model-a.gguf' });
    const client = fakeClient(0.5);
    const result = await migrate(path, client);

    expect(result.status).toBe('up-to-date');
    expect(result.factCount).toBe(0);
    expect(client.calls).toBe(0);
  });
});
