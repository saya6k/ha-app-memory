import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DbConnection } from '../db/client.js';
import { getManual, listManuals } from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError } from '../log.js';
import type { ManualIndexer } from '../manuals/indexer.js';
import { PDFJS_DIR } from '../manuals/pdf.js';
import { searchManuals } from '../manuals/search.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../tools/schemas.js';

/** memory/ui in a checkout, /opt/mcp-server/ui in the image — both two levels up from here. */
const STATIC_DIR = fileURLToPath(new URL('../../ui/', import.meta.url));

const require = createRequire(import.meta.url);
const MARKED_DIR = dirname(require.resolve('marked/package.json'));
// dompurify's exports do not include package.json; its entry point sits in dist/.
const DOMPURIFY_DIST = dirname(require.resolve('dompurify'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
};

/**
 * Every file the panel serves, by URL. Anything else is a 404, so no request
 * path is ever joined onto a directory except the two pdf.js resource folders,
 * whose file names are checked against a strict pattern first.
 */
const STATIC_FILES: Record<string, string> = {
  '/': join(STATIC_DIR, 'index.html'),
  '/app.js': join(STATIC_DIR, 'app.js'),
  '/style.css': join(STATIC_DIR, 'style.css'),
  '/pdfjs/pdf.min.mjs': join(PDFJS_DIR, 'build', 'pdf.min.mjs'),
  '/pdfjs/pdf.worker.min.mjs': join(PDFJS_DIR, 'build', 'pdf.worker.min.mjs'),
  '/vendor/marked.esm.js': join(MARKED_DIR, 'lib', 'marked.esm.js'),
  '/vendor/purify.es.mjs': join(DOMPURIFY_DIST, 'purify.es.mjs'),
};
const PDFJS_RESOURCE = /^\/pdfjs\/(cmaps|standard_fonts)\/([\w.-]+)$/;

export interface UiServerDeps {
  db: DbConnection;
  embeddingClient: EmbeddingClient;
  indexer: ManualIndexer;
  manualsDir: string;
  /** Only this remote address is answered; undefined answers anyone. */
  allowedAddress?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, path: string, cache: boolean): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cache ? 'max-age=86400' : 'no-cache',
  });
  createReadStream(path).pipe(res);
}

/** IPv4 peers show up as ::ffff:a.b.c.d on a dual-stack socket. */
function remoteAddress(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

async function handle(
  deps: UiServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://ui');
  const path = url.pathname;

  // Answer straight away; the panel polls /api/manuals for progress.
  const operations: Record<string, () => Promise<unknown>> = {
    '/api/rescan': () => deps.indexer.sync(),
    '/api/reindex': () => deps.indexer.reindex(),
    '/api/reset': () => deps.indexer.reset(),
  };
  const operation = operations[path];
  if (operation) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    void operation().catch((error: unknown) => logError('manual-index', error));
    sendJson(res, 202, deps.indexer.status);
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  if (path === '/api/manuals') {
    sendJson(res, 200, { manuals: listManuals(deps.db), status: deps.indexer.status });
    return;
  }

  if (path === '/api/search') {
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (!query) {
      sendJson(res, 400, { error: 'q is required' });
      return;
    }
    const limit = Math.min(
      Number(url.searchParams.get('limit')) || DEFAULT_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
    );
    sendJson(res, 200, await searchManuals(deps.db, deps.embeddingClient, query, limit));
    return;
  }

  const fileMatch = /^\/api\/manuals\/([\w-]+)\/file$/.exec(path);
  if (fileMatch?.[1]) {
    const manual = getManual(deps.db, fileMatch[1]);
    const root = resolve(deps.manualsDir);
    const full = manual ? resolve(root, manual.path) : undefined;
    // The path came from our own directory scan, but check anyway: this is the
    // one place a stored string turns into a file read.
    if (!full?.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    await sendFile(res, full, false);
    return;
  }

  const staticFile = STATIC_FILES[path];
  if (staticFile) {
    await sendFile(res, staticFile, path.startsWith('/pdfjs/') || path.startsWith('/vendor/'));
    return;
  }

  const resource = PDFJS_RESOURCE.exec(path);
  if (resource?.[1] && resource[2]) {
    await sendFile(res, join(PDFJS_DIR, resource[1], resource[2]), true);
    return;
  }

  res.writeHead(404).end();
}

/** The ingress panel: browse, search and read the manuals. */
export function createUiServer(deps: UiServerDeps): Server {
  return createServer((req, res) => {
    if (deps.allowedAddress && remoteAddress(req) !== deps.allowedAddress) {
      res.writeHead(403).end();
      return;
    }

    handle(deps, req, res).catch((error: unknown) => {
      logError('ui', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
}
