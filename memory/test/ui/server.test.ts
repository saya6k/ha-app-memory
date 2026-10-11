import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../../src/config.js';
import { type DbConnection, openDb } from '../../src/db/client.js';
import { listManuals, replaceManual } from '../../src/db/manuals.js';
import type { EmbeddingClient } from '../../src/embedding/types.js';
import { ManualIndexer } from '../../src/manuals/indexer.js';
import { createUiServer, type UiServerDeps } from '../../src/ui/server.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/washer-ko.pdf', import.meta.url));

let dir: string;
let manualsDir: string;
let db: DbConnection;
let server: Server;
let base: string;

const embedding: EmbeddingClient = {
  async embed() {
    return new Array(EMBEDDING_DIMENSIONS).fill(0.1) as number[];
  },
};

async function start(overrides: Partial<UiServerDeps> = {}): Promise<void> {
  server = createUiServer({
    db,
    embeddingClient: embedding,
    indexer: new ManualIndexer(db, embedding, manualsDir),
    manualsDir,
    usersDir: join(dir, 'users'),
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-ui-'));
  manualsDir = join(dir, 'manuals');
  mkdirSync(manualsDir);
  db = openDb(join(dir, 'facts.sqlite'));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ui server', () => {
  it('serves the panel, its script and the pdf.js resources it needs', async () => {
    await start();
    for (const path of [
      '/',
      '/app.js',
      '/common.js',
      '/i18n.js',
      '/memories.js',
      '/style.css',
      '/pdfjs/pdf.min.mjs',
      '/pdfjs/pdf.worker.min.mjs',
      '/pdfjs/cmaps/KSC-EUC-H.bcmap',
      '/vendor/marked.esm.js',
      '/vendor/purify.es.mjs',
    ]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      // Read it all: an unread body holds the connection open past the test.
      await res.arrayBuffer();
    }
  });

  it('refuses anyone but the ingress proxy when restricted', async () => {
    await start({ allowedAddress: '172.30.32.2' });
    expect((await fetch(`${base}/`)).status).toBe(403);
    expect((await fetch(`${base}/api/manuals`)).status).toBe(403);
  });

  it('indexes on rescan and serves the PDF by id', async () => {
    copyFileSync(FIXTURE, join(manualsDir, 'Washer.pdf'));
    const indexer = new ManualIndexer(db, embedding, manualsDir);
    await start({ indexer });

    expect((await fetch(`${base}/api/rescan`, { method: 'POST' })).status).toBe(202);
    await indexer.sync();

    const { manuals } = (await (await fetch(`${base}/api/manuals`)).json()) as {
      manuals: { id: string; title: string; pageCount: number }[];
    };
    expect(manuals).toMatchObject([{ title: 'Washer', pageCount: 2 }]);

    const pdf = await fetch(`${base}/api/manuals/${manuals[0]?.id}/file`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');

    const hits = (await (
      await fetch(`${base}/api/search?q=${encodeURIComponent('통세척')}`)
    ).json()) as {
      title: string;
      page: number;
    }[];
    // The fake embedding is constant, so only membership is meaningful here.
    expect(hits.map((h) => [h.title, h.page]).sort()).toEqual([
      ['Washer', 1],
      ['Washer', 2],
    ]);
  });

  it('never serves a file outside the manuals folder, whatever the index says', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    replaceManual(
      db,
      {
        id: 'evil',
        owner: '',
        path: '../secret.txt',
        title: 'x',
        format: 'pdf',
        sha256: 'x',
        size: 1,
        mtimeMs: 1,
        pageCount: 1,
        indexedAt: '',
      },
      [],
    );
    await start();

    expect(listManuals(db)).toHaveLength(1);
    expect((await fetch(`${base}/api/manuals/evil/file`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/cmaps/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });

  it('serves Markdown as text, for the panel to render', async () => {
    writeFileSync(join(manualsDir, 'Dryer.md'), '# 필터\n비우세요\n');
    const indexer = new ManualIndexer(db, embedding, manualsDir);
    await indexer.sync();
    await start({ indexer });

    const [manual] = listManuals(db);
    expect(manual).toMatchObject({ title: 'Dryer', format: 'markdown' });
    const res = await fetch(`${base}/api/manuals/${manual?.id}/file`);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('# 필터\n비우세요\n');
  });

  it('clears the index on reset and rebuilds it on reindex', async () => {
    writeFileSync(join(manualsDir, 'Dryer.md'), '# 필터\n비우세요\n');
    const indexer = new ManualIndexer(db, embedding, manualsDir);
    await indexer.sync();
    await start({ indexer });

    const reset = await fetch(`${base}/api/reset`, { method: 'POST' });
    expect(reset.status).toBe(202);
    expect(await reset.json()).toMatchObject({ running: true });
    await indexer.sync(); // queued behind the reset, so it runs after it
    expect(listManuals(db)).toHaveLength(1);

    await fetch(`${base}/api/reset`, { method: 'POST' });
    await vi.waitFor(() => expect(indexer.status.running).toBe(false));
    expect(listManuals(db)).toHaveLength(0);

    expect((await fetch(`${base}/api/reindex`, { method: 'POST' })).status).toBe(202);
    await vi.waitFor(() => expect(listManuals(db)).toHaveLength(1));
  });

  it('only accepts index operations as POST', async () => {
    await start();
    expect((await fetch(`${base}/api/reset`)).status).toBe(405);
  });

  it('indexes an uploaded file, and asks before replacing one', async () => {
    const indexer = new ManualIndexer(db, embedding, manualsDir);
    await start({ indexer });
    const upload = (name: string, body: string, overwrite = false) =>
      fetch(
        `${base}/api/upload?name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`,
        {
          method: 'POST',
          body,
        },
      );

    const created = await upload('건조기.md', '# 필터\n비우세요\n');
    expect(created.status).toBe(201);
    await vi.waitFor(() => expect(listManuals(db).map((m) => m.title)).toEqual(['건조기']));

    const conflict = await upload('건조기.md', '# 새 판\n');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: expect.stringMatching(/already exists/) });

    const replaced = await upload('건조기.md', '# 새 판\n', true);
    expect(replaced.status).toBe(200);
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/api/search?q=x`);
      expect(await res.json()).toMatchObject([{ section: '새 판' }]);
    });

    expect((await upload('../escape.md', 'x')).status).toBe(400);
    expect((await upload('notes.txt', 'x')).status).toBe(400);
    expect((await fetch(`${base}/api/upload?name=a.md`)).status).toBe(405);
  });

  it('deletes a manual file and drops it from the index', async () => {
    writeFileSync(join(manualsDir, 'Dryer.md'), '# 필터\n비우세요\n');
    const indexer = new ManualIndexer(db, embedding, manualsDir);
    await indexer.sync();
    await start({ indexer });
    const [manual] = listManuals(db);

    const res = await fetch(`${base}/api/manuals/${manual?.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(existsSync(join(manualsDir, 'Dryer.md'))).toBe(false);
    await vi.waitFor(() => expect(listManuals(db)).toEqual([]));
    expect((await fetch(`${base}/api/manuals/${manual?.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  it('will not delete outside the manuals folder, whatever the index says', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'keep me');
    replaceManual(
      db,
      {
        id: 'evil',
        owner: '',
        path: '../secret.txt',
        title: 'x',
        format: 'pdf',
        sha256: 'x',
        size: 1,
        mtimeMs: 1,
        pageCount: 1,
        indexedAt: '',
      },
      [],
    );
    await start();

    expect((await fetch(`${base}/api/manuals/evil`, { method: 'DELETE' })).status).toBe(404);
    expect(existsSync(join(dir, 'secret.txt'))).toBe(true);
  });

  it('requires a query to search', async () => {
    await start();
    expect((await fetch(`${base}/api/search?q=%20`)).status).toBe(400);
  });

  describe('per user', () => {
    /**
     * Ingress headers as the Supervisor sets them for a signed-in user. aiohttp
     * sends header bytes as UTF-8; fetch only takes Latin-1 strings, so the
     * name is passed as its UTF-8 bytes spelled in Latin-1 — the same bytes.
     */
    function as(userId: string, name: string): Record<string, string> {
      return {
        'x-remote-user-id': userId,
        'x-remote-user-display-name': Buffer.from(name, 'utf8').toString('latin1'),
      };
    }
    const dad = as('u-dad', '아빠');
    const mina = as('u-mina', 'Mina');

    async function json(path: string, headers: Record<string, string>, init: RequestInit = {}) {
      const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    }

    it('knows who is signed in from the ingress headers', async () => {
      await start();
      expect((await json('/api/me', dad)).body).toEqual({ signedIn: true, name: '아빠' });
      expect((await json('/api/me', {})).body).toEqual({ signedIn: false, name: null });
    });

    it("keeps a personal document to its owner: listed, readable and deletable only by them", async () => {
      const indexer = new ManualIndexer(db, embedding, manualsDir, undefined, join(dir, 'users'));
      await start({ indexer });

      const anonymous = await fetch(`${base}/api/upload?name=Insurance.md&to=mine`, {
        method: 'POST',
        body: '# 보험\n',
      });
      expect(anonymous.status).toBe(403);

      const uploaded = await fetch(`${base}/api/upload?name=Insurance.md&to=mine`, {
        method: 'POST',
        body: '# 보험\n',
        headers: dad,
      });
      expect(uploaded.status).toBe(201);
      expect(existsSync(join(dir, 'users', 'u-dad', 'documents', 'Insurance.md'))).toBe(true);
      await vi.waitFor(() => expect(listManuals(db, 'u-dad')).toHaveLength(1));
      const [doc] = listManuals(db, 'u-dad');

      const forDad = (await json('/api/manuals', dad)).body as { manuals: object[] };
      expect(forDad.manuals).toMatchObject([{ title: 'Insurance', shared: false }]);
      expect(forDad.manuals[0]).not.toHaveProperty('owner');
      expect(((await json('/api/manuals', mina)).body as { manuals: object[] }).manuals).toEqual([]);

      expect((await fetch(`${base}/api/manuals/${doc?.id}/file`, { headers: mina })).status).toBe(404);
      expect((await fetch(`${base}/api/manuals/${doc?.id}/file`, { headers: dad })).status).toBe(200);
      expect(
        (await fetch(`${base}/api/manuals/${doc?.id}`, { method: 'DELETE', headers: mina })).status,
      ).toBe(404);
      expect(existsSync(join(dir, 'users', 'u-dad', 'documents', 'Insurance.md'))).toBe(true);
      expect(
        (await fetch(`${base}/api/manuals/${doc?.id}`, { method: 'DELETE', headers: dad })).status,
      ).toBe(200);
      expect(existsSync(join(dir, 'users', 'u-dad', 'documents', 'Insurance.md'))).toBe(false);
    });

    it("does not show one person's file names to another in the index status", async () => {
      const minaDocs = join(dir, 'users', 'u-mina', 'documents');
      mkdirSync(minaDocs, { recursive: true });
      writeFileSync(join(minaDocs, 'Diary.md'), '# same\n');
      writeFileSync(join(minaDocs, 'Diary copy.md'), '# same\n');
      const indexer = new ManualIndexer(db, embedding, manualsDir, undefined, join(dir, 'users'));
      await indexer.sync();
      await start({ indexer });

      type Status = { status: { lastSync: { duplicates: object[] } } };
      const forDad = (await json('/api/manuals', dad)).body as Status;
      expect(forDad.status.lastSync.duplicates).toEqual([]);
      const forMina = (await json('/api/manuals', mina)).body as Status;
      expect(forMina.status.lastSync.duplicates).toEqual([
        { path: 'Diary.md', of: 'Diary copy.md', shared: false },
      ]);
    });

    it('manages memories: own and shared, never other people\'s', async () => {
      await start();
      const post = (headers: Record<string, string>, body: object) =>
        json('/api/facts', headers, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        });

      const own = await post(dad, { content: '나는 땅콩 알레르기가 있다' });
      expect(own).toMatchObject({ status: 201, body: { shared: false } });
      expect(await post(dad, { content: '분리수거는 화요일', shared: true })).toMatchObject({
        status: 201,
        body: { shared: true },
      });
      expect((await post(dad, { content: '  ' })).status).toBe(400);

      const listed = (await json('/api/facts', dad)).body as {
        mine: { content: string }[];
        shared: { content: string }[];
      };
      expect(listed.mine.map((f) => f.content)).toEqual(['나는 땅콩 알레르기가 있다']);
      expect(listed.shared.map((f) => f.content)).toEqual(['분리수거는 화요일']);
      expect((await json('/api/facts', mina)).body).toMatchObject({
        mine: [],
        shared: [{ content: '분리수거는 화요일' }],
      });

      const id = (own.body as { id: string }).id;
      const put = (headers: Record<string, string>) =>
        json(`/api/facts/${id}`, headers, {
          method: 'PUT',
          body: JSON.stringify({ content: '땅콩과 호두 알레르기' }),
        });
      expect((await put(mina)).status).toBe(404);
      expect(await put(dad)).toMatchObject({ status: 200, body: { content: '땅콩과 호두 알레르기' } });

      expect((await json(`/api/facts/${id}`, mina, { method: 'DELETE' })).status).toBe(404);
      expect((await json(`/api/facts/${id}`, dad, { method: 'DELETE' })).status).toBe(200);
      expect(((await json('/api/facts', dad)).body as { mine: object[] }).mine).toEqual([]);
    });

    it("searches what the viewer may see: shared things and their own", async () => {
      await start();
      for (const [headers, content, shared] of [
        [dad, 'dad secret', false],
        [mina, 'mina secret', false],
        [dad, 'house rule', true],
      ] as const) {
        await json('/api/facts', headers, {
          method: 'POST',
          body: JSON.stringify({ content, shared }),
        });
      }

      const hits = (await json('/api/search?q=x&limit=20', mina)).body as { content: string }[];
      expect(hits.map((h) => h.content).sort()).toEqual(['house rule', 'mina secret']);
    });
  });
});
