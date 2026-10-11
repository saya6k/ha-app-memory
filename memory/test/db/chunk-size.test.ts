import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The document index records the chunk size it was cut with; opening it with
 * another one empties it, for the next sync to rebuild. config.ts reads the
 * env once at import, hence resetModules between sizes.
 */
let dir: string;
let path: string;

async function openWith(chunkSize: string | undefined) {
  vi.resetModules();
  if (chunkSize === undefined) delete process.env.CHUNK_SIZE;
  else process.env.CHUNK_SIZE = chunkSize;
  const { openDb } = await import('../../src/db/client.js');
  const { replaceManual } = await import('../../src/db/manuals.js');
  return { db: openDb(path, { unchecked: true }), replaceManual };
}

function count(db: { prepare(sql: string): { get(): unknown } }): number {
  return (db.prepare('SELECT count(*) AS c FROM manuals').get() as { c: number }).c;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-chunk-'));
  path = join(dir, 'facts.sqlite');
});

afterEach(() => {
  delete process.env.CHUNK_SIZE;
  rmSync(dir, { recursive: true, force: true });
});

async function seed(chunkSize: string | undefined): Promise<void> {
  const { db, replaceManual } = await openWith(chunkSize);
  replaceManual(
    db,
    {
      id: 'm',
      owner: '',
      path: 'a.pdf',
      title: 'a',
      format: 'pdf',
      sha256: 'h',
      size: 1,
      mtimeMs: 1,
      pageCount: 1,
      indexedAt: '',
    },
    [],
  );
  db.close();
}

describe('chunk size and the document index', () => {
  it('keeps the index while the chunk size is unchanged', async () => {
    await seed('400');
    const { db } = await openWith('400');
    expect(count(db)).toBe(1);
    db.close();
  });

  it('empties the index when the chunk size changes', async () => {
    await seed('400');
    const { db } = await openWith('800');
    expect(count(db)).toBe(0);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'chunk_size'").get()).toEqual({
      value: '800',
    });
    db.close();
  });

  it('takes an index from before the option to have used 400', async () => {
    await seed(undefined);
    const first = await openWith(undefined);
    first.db.exec("DELETE FROM meta WHERE key = 'chunk_size'");
    first.db.close();

    const { db } = await openWith('400');
    expect(count(db)).toBe(1);
    db.close();
  });
});
