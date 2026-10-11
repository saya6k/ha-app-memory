import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../../src/config.js';
import { type DbConnection, openDb } from '../../src/db/client.js';
import { listManuals, type ManualFormat } from '../../src/db/manuals.js';
import type { EmbeddingClient } from '../../src/embedding/types.js';
import type { ExtractedManual } from '../../src/manuals/extract.js';
import { ManualIndexer } from '../../src/manuals/indexer.js';

let dir: string;
let manualsDir: string;
let db: DbConnection;
let embedded: string[];
let extracted: string[];
/** Files the fake extractor refuses, by name — stands in for a corrupt PDF. */
let broken: Set<string>;

const embedding: EmbeddingClient = {
  async embed(text) {
    embedded.push(text);
    return new Array(EMBEDDING_DIMENSIONS).fill(0.1) as number[];
  },
};

/**
 * Reads pages back out of what writeManual wrote, so the fake extractor and
 * the indexer's hashing see the same bytes.
 */
async function extract(path: string, format: ManualFormat): Promise<ExtractedManual> {
  const name = path.slice(manualsDir.length + 1);
  extracted.push(name);
  if (broken.has(name)) throw new Error(`not a ${format}: ${name}`);
  const { readFileSync } = await import('node:fs');
  const pages = readFileSync(path, 'utf8').split('|');
  return { pageCount: pages.length, parts: pages.map((text, i) => ({ page: i + 1, text })) };
}

/** The content is the pages joined, so equal pages mean an identical file. */
function writeManual(name: string, pages: string[], mtime = new Date('2026-01-01')): void {
  const path = join(manualsDir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, pages.join('|'));
  utimesSync(path, mtime, mtime);
}

function chunkCount(): number {
  return (db.prepare('SELECT count(*) AS c FROM vec_manual_chunks').get() as { c: number }).c;
}

function paths(): string[] {
  return listManuals(db)
    .map((m) => m.path)
    .sort();
}

function indexer(): ManualIndexer {
  return new ManualIndexer(db, embedding, manualsDir, extract);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-manuals-'));
  manualsDir = join(dir, 'manuals');
  mkdirSync(manualsDir);
  db = openDb(join(dir, 'facts.sqlite'));
  embedded = [];
  extracted = [];
  broken = new Set();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ManualIndexer', () => {
  it('indexes PDFs and Markdown, including in subfolders, and ignores other files', async () => {
    writeManual('Washer.pdf', ['통세척 방법', 'E3 배수 필터']);
    writeManual('kitchen/Oven.PDF', ['Preheat']);
    writeManual('Dryer.md', ['# Lint']);
    writeManual('Fridge.markdown', ['# Ice']);
    writeFileSync(join(manualsDir, 'notes.txt'), 'not a manual');

    const result = await indexer().sync();

    expect(result).toMatchObject({ added: 4, updated: 0, removed: 0, failed: [], duplicates: [] });
    expect(listManuals(db).map((m) => [m.title, m.path, m.format, m.pageCount])).toEqual([
      ['Dryer', 'Dryer.md', 'markdown', 1],
      ['Fridge', 'Fridge.markdown', 'markdown', 1],
      ['Oven', 'kitchen/Oven.PDF', 'pdf', 1],
      ['Washer', 'Washer.pdf', 'pdf', 2],
    ]);
    expect(listManuals(db).every((m) => /^[0-9a-f]{64}$/.test(m.sha256))).toBe(true);
    expect(chunkCount()).toBe(5);
  });

  it('embeds each chunk with its manual title in front', async () => {
    writeManual('Washer.pdf', ['E3 배수 필터']);
    await indexer().sync();
    expect(embedded).toEqual(['Washer\nE3 배수 필터']);
  });

  it('does not even read a file whose size and mtime are unchanged', async () => {
    writeManual('Washer.pdf', ['one']);
    const idx = indexer();
    await idx.sync();
    extracted = [];

    const result = await idx.sync();

    expect(result.unchanged).toBe(1);
    expect(extracted).toEqual([]);
  });

  it('re-indexes a file whose content changed, under the same id', async () => {
    writeManual('Washer.pdf', ['one']);
    writeManual('Oven.pdf', ['two']);
    const idx = indexer();
    await idx.sync();
    const washerId = listManuals(db).find((m) => m.title === 'Washer')?.id;

    embedded = [];
    writeManual('Washer.pdf', ['one, revised', 'page two'], new Date('2026-02-01'));
    const result = await idx.sync();

    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(embedded).toEqual(['Washer\none, revised', 'Washer\npage two']);
    // Same id, so links into the panel keep working across an update.
    expect(listManuals(db).find((m) => m.title === 'Washer')).toMatchObject({
      id: washerId,
      pageCount: 2,
    });
    expect(chunkCount()).toBe(3);
  });

  it('does not re-embed a file that was only touched', async () => {
    writeManual('Washer.pdf', ['one']);
    const idx = indexer();
    await idx.sync();
    embedded = [];

    writeManual('Washer.pdf', ['one'], new Date('2026-03-01'));
    const result = await idx.sync();

    expect(result).toMatchObject({ unchanged: 1, updated: 0 });
    expect(embedded).toEqual([]);
    // The new mtime is recorded, so the next sync skips it without hashing.
    expect(listManuals(db)[0]?.mtimeMs).toBe(new Date('2026-03-01').getTime());
  });

  it('follows a renamed or moved file without re-embedding it', async () => {
    writeManual('Washer.pdf', ['one', 'two']);
    const idx = indexer();
    await idx.sync();
    const id = listManuals(db)[0]?.id;
    embedded = [];

    mkdirSync(join(manualsDir, 'laundry'));
    renameSync(join(manualsDir, 'Washer.pdf'), join(manualsDir, 'laundry', 'Drum washer.pdf'));
    const result = await idx.sync();

    expect(result).toMatchObject({ moved: 1, added: 0, removed: 0 });
    expect(embedded).toEqual([]);
    expect(listManuals(db)).toMatchObject([
      { id, path: 'laundry/Drum washer.pdf', title: 'Drum washer' },
    ]);
    expect(chunkCount()).toBe(2);
  });

  it('indexes identical copies once and reports the rest as duplicates', async () => {
    writeManual('a/Washer.pdf', ['same']);
    writeManual('b/Washer copy.pdf', ['same']);

    const result = await indexer().sync();

    expect(result.added).toBe(1);
    expect(result.duplicates).toEqual([
      { owner: '', path: 'b/Washer copy.pdf', of: 'a/Washer.pdf' },
    ]);
    expect(paths()).toEqual(['a/Washer.pdf']);
    expect(embedded).toHaveLength(1);
  });

  it('hands a manual over to its copy when the original is deleted', async () => {
    writeManual('a/Washer.pdf', ['same']);
    writeManual('b/Washer copy.pdf', ['same']);
    const idx = indexer();
    await idx.sync();
    embedded = [];

    rmSync(join(manualsDir, 'a', 'Washer.pdf'));
    const result = await idx.sync();

    expect(result).toMatchObject({ moved: 1, removed: 0, duplicates: [] });
    expect(paths()).toEqual(['b/Washer copy.pdf']);
    expect(embedded).toEqual([]);
  });

  it('drops a file edited to match another manual, as a duplicate of it', async () => {
    writeManual('Washer.pdf', ['washer']);
    writeManual('Oven.pdf', ['oven']);
    const idx = indexer();
    await idx.sync();

    writeManual('Washer.pdf', ['oven'], new Date('2026-02-01'));
    const result = await idx.sync();

    expect(result.duplicates).toEqual([{ owner: '', path: 'Washer.pdf', of: 'Oven.pdf' }]);
    expect(paths()).toEqual(['Oven.pdf']);
    expect(chunkCount()).toBe(1);
  });

  it('indexes a copy of the old version when the original was edited in place', async () => {
    // Known paths are synced before new ones, so the copy is not mistaken for
    // a duplicate of content the original no longer has.
    writeManual('Washer.pdf', ['v1']);
    const idx = indexer();
    await idx.sync();

    writeManual('Washer v1.pdf', ['v1']);
    writeManual('Washer.pdf', ['v2'], new Date('2026-02-01'));
    const result = await idx.sync();

    expect(result).toMatchObject({ added: 1, updated: 1, duplicates: [] });
    expect(paths()).toEqual(['Washer v1.pdf', 'Washer.pdf']);
  });

  it('drops manuals whose file was deleted', async () => {
    writeManual('Washer.pdf', ['one']);
    const idx = indexer();
    await idx.sync();

    rmSync(join(manualsDir, 'Washer.pdf'));
    const result = await idx.sync();

    expect(result.removed).toBe(1);
    expect(listManuals(db)).toEqual([]);
    expect(chunkCount()).toBe(0);
  });

  it('records a manual without text as unsearchable instead of retrying it every time', async () => {
    writeManual('Scan.pdf', ['', '  ']);
    const idx = indexer();
    await idx.sync();

    expect(listManuals(db)[0]).toMatchObject({ title: 'Scan', pageCount: 2, chunkCount: 0 });
    expect((await idx.sync()).unchanged).toBe(1);
  });

  it('carries on past a file that fails, keeping its previous index', async () => {
    writeManual('Good.pdf', ['fine']);
    writeManual('Bad.pdf', ['old text']);
    const idx = indexer();
    await idx.sync();

    writeManual('Bad.pdf', ['new text'], new Date('2026-02-01'));
    writeManual('New.pdf', ['also fine']);
    broken.add('Bad.pdf');
    const result = await idx.sync();

    expect(result.added).toBe(1);
    expect(result.failed).toEqual([
      { owner: '', path: 'Bad.pdf', error: expect.stringMatching(/not a pdf/) },
    ]);
    expect(listManuals(db).map((m) => m.title)).toEqual(['Bad', 'Good', 'New']);
    expect(chunkCount()).toBe(3);
    expect(idx.status.lastSync?.failed).toHaveLength(1);
  });

  it('does nothing, and removes nothing, when the folder is missing', async () => {
    writeManual('Washer.pdf', ['one']);
    await indexer().sync();

    const result = await new ManualIndexer(db, embedding, join(dir, 'missing'), extract).sync();

    expect(result.dirFound).toBe(false);
    expect(listManuals(db)).toHaveLength(1);
  });

  it('reset empties the index without touching the files', async () => {
    writeManual('Washer.pdf', ['one']);
    const idx = indexer();
    await idx.sync();

    await idx.reset();

    expect(listManuals(db)).toEqual([]);
    expect(chunkCount()).toBe(0);
    expect(idx.status.lastSync).toBeUndefined();
    // The next sync finds it again, as new.
    expect((await idx.sync()).added).toBe(1);
  });

  it('reindex re-embeds everything, even unchanged files', async () => {
    writeManual('Washer.pdf', ['one']);
    writeManual('Oven.pdf', ['two']);
    const idx = indexer();
    await idx.sync();
    embedded = [];

    const result = await idx.reindex();

    expect(result).toMatchObject({ added: 2, unchanged: 0 });
    expect(embedded.sort()).toEqual(['Oven\ntwo', 'Washer\none']);
    expect(chunkCount()).toBe(2);
  });

  it('runs one operation at a time, and reports it as running the moment it is queued', async () => {
    writeManual('Washer.pdf', ['one']);
    const idx = indexer();

    const [a, b] = [idx.sync(), idx.sync()];
    expect(a).toBe(b);
    const reset = idx.reset();
    expect(idx.status.running).toBe(true);

    // The reset waited for the sync: it indexed the file, then the reset ran.
    expect((await a).added).toBe(1);
    await reset;
    expect(listManuals(db)).toHaveLength(0);
    expect(idx.status.running).toBe(false);
  });

  it('queues a fresh sync when one is asked for while another is running', async () => {
    writeManual('Washer.pdf', ['one']);
    // Hold the first sync inside extraction, after it has scanned the folder.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const idx = new ManualIndexer(db, embedding, manualsDir, async (path, format) => {
      entered();
      await gate;
      return extract(path, format);
    });

    const first = idx.sync();
    await inside;
    // Written after the first sync scanned the folder — an upload, say.
    writeManual('Oven.pdf', ['two']);
    const second = idx.sync();
    expect(second).not.toBe(first);
    expect(idx.sync()).toBe(second);

    release();
    expect((await first).added).toBe(1);
    expect((await second).added).toBe(1);
    expect(paths()).toEqual(['Oven.pdf', 'Washer.pdf']);
  });

  describe('personal documents', () => {
    /** Writes into <dir>/users/<id>/documents, the way the panel's upload does. */
    function writePersonal(userId: string, name: string, pages: string[]): void {
      const path = join(dir, 'users', userId, 'documents', name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, pages.join('|'));
      utimesSync(path, new Date('2026-01-01'), new Date('2026-01-01'));
    }

    // The fake extractor finds files relative to the shared folder; read any path.
    async function extractAnywhere(path: string): Promise<ExtractedManual> {
      const { readFileSync } = await import('node:fs');
      const pages = readFileSync(path, 'utf8').split('|');
      return { pageCount: pages.length, parts: pages.map((text, i) => ({ page: i + 1, text })) };
    }

    function withUsers(): ManualIndexer {
      return new ManualIndexer(db, embedding, manualsDir, extractAnywhere, join(dir, 'users'));
    }

    function owners(): [string, string][] {
      return listManuals(db)
        .map((m): [string, string] => [m.owner, m.path])
        .sort();
    }

    it("indexes each user's folder under their id, next to the shared manuals", async () => {
      writeManual('Washer.pdf', ['shared']);
      writePersonal('u-dad', 'Insurance.pdf', ['dad']);
      writePersonal('u-mina', 'notes/School.md', ['mina']);

      expect((await withUsers().sync()).added).toBe(3);
      expect(owners()).toEqual([
        ['', 'Washer.pdf'],
        ['u-dad', 'Insurance.pdf'],
        ['u-mina', 'notes/School.md'],
      ]);
    });

    it('treats the same content as a duplicate only within one owner', async () => {
      writeManual('Washer.pdf', ['same']);
      writePersonal('u-dad', 'Washer.pdf', ['same']);
      writePersonal('u-dad', 'Washer copy.pdf', ['same']);

      const result = await withUsers().sync();

      expect(result.added).toBe(2);
      expect(result.duplicates).toEqual([
        { owner: 'u-dad', path: 'Washer.pdf', of: 'Washer copy.pdf' },
      ]);
    });

    it("drops a user's documents when their folder is gone, but keeps shared ones without a folder", async () => {
      writeManual('Washer.pdf', ['shared']);
      writePersonal('u-dad', 'Insurance.pdf', ['dad']);
      const idx = withUsers();
      await idx.sync();

      rmSync(join(dir, 'users', 'u-dad'), { recursive: true });
      rmSync(manualsDir, { recursive: true });
      const result = await idx.sync();

      expect(result).toMatchObject({ removed: 1, dirFound: false });
      expect(owners()).toEqual([['', 'Washer.pdf']]);
    });

    it('ignores folders that cannot be user ids', async () => {
      writePersonal('u-dad', 'a.pdf', ['a']);
      mkdirSync(join(dir, 'users', '.trash', 'documents'), { recursive: true });
      writeFileSync(join(dir, 'users', '.trash', 'documents', 'b.pdf'), 'b');

      await withUsers().sync();
      expect(owners()).toEqual([['u-dad', 'a.pdf']]);
    });
  });
});
