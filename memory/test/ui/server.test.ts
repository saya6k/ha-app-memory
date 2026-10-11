import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('requires a query to search', async () => {
    await start();
    expect((await fetch(`${base}/api/search?q=%20`)).status).toBe(400);
  });
});
