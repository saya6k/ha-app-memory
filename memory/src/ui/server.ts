import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DbConnection } from '../db/client.js';
import { getManual, listManuals, type Manual, type Owner, SHARED } from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError } from '../log.js';
import { type IndexStatus, type ManualIndexer, userDocumentsDir } from '../manuals/indexer.js';
import { PDFJS_DIR } from '../manuals/pdf.js';
import { searchAll } from '../search.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../tools/schemas.js';
import { FactsApi, readJson } from './facts.js';
import { deleteManualFile, FileError, insideRoot, saveUpload } from './files.js';

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
  '/common.js': join(STATIC_DIR, 'common.js'),
  '/i18n.js': join(STATIC_DIR, 'i18n.js'),
  '/memories.js': join(STATIC_DIR, 'memories.js'),
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
  /** Parent of the per-user folders (see userDocumentsDir). */
  usersDir: string;
  /** Only this remote address is answered; undefined answers anyone. */
  allowedAddress?: string;
}

/** Who is using the panel, as the Supervisor's ingress proxy says. */
interface Viewer {
  userId?: string;
  name?: string;
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

/**
 * A header value as text. The Supervisor (aiohttp) writes headers as UTF-8,
 * while Node reads header bytes as Latin-1, so a Korean display name arrives as
 * mojibake; re-reading the bytes as UTF-8 restores it. ASCII is unchanged, and
 * a value that is not valid UTF-8 is kept as it came.
 */
function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const utf8 = Buffer.from(value, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? value : utf8;
}

/**
 * The Supervisor sets these on every ingress request from a session it can tie
 * to a HA user, and strips any copies the browser sent (supervisor/api/ingress.py),
 * so they can be trusted as long as only the proxy can reach this server.
 */
function viewerOf(req: IncomingMessage): Viewer {
  const userId = header(req, 'x-remote-user-id');
  return {
    userId: userId && /^[0-9a-zA-Z_-]+$/.test(userId) ? userId : undefined,
    name: header(req, 'x-remote-user-display-name') ?? header(req, 'x-remote-user-name'),
  };
}

function ownersOf(viewer: Viewer): Owner[] {
  return viewer.userId ? [SHARED, viewer.userId] : [SHARED];
}

/** The folder a document of `owner` lives in. */
function rootOf(deps: UiServerDeps, owner: Owner): string {
  return owner === SHARED ? deps.manualsDir : userDocumentsDir(deps.usersDir, owner);
}

/** Starts a sync in the background; one already running queues another. */
function resync(deps: UiServerDeps): void {
  void deps.indexer.sync().catch((error: unknown) => logError('manual-index', error));
}

/**
 * The indexer's status as one viewer may see it. It covers every owner's
 * folder, so other people's file names are left out, and owners become a
 * shared flag rather than user ids.
 */
function presentStatus(status: IndexStatus, owners: Owner[]) {
  const visible = <T extends { owner: Owner }>(items: T[]) =>
    items
      .filter((item) => owners.includes(item.owner))
      .map(({ owner, ...rest }) => ({ ...rest, shared: owner === SHARED }));
  const { current, lastSync, ...rest } = status;
  return {
    ...rest,
    current: current && owners.includes(current.owner) ? current.path : undefined,
    lastSync: lastSync && {
      ...lastSync,
      duplicates: visible(lastSync.duplicates),
      failed: visible(lastSync.failed),
    },
  };
}

/** A manual as the panel sees it: whose it is, without exposing user ids. */
function presentManual(manual: Manual) {
  const { owner, ...rest } = manual;
  return { ...rest, shared: owner === SHARED };
}

async function handle(
  deps: UiServerDeps,
  facts: FactsApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://ui');
  const path = url.pathname;
  const viewer = viewerOf(req);
  const owners = ownersOf(viewer);

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
    sendJson(res, 202, presentStatus(deps.indexer.status, owners));
    return;
  }

  if (path === '/api/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    // to=mine puts it among the viewer's personal documents; otherwise it is
    // a shared manual.
    const personal = url.searchParams.get('to') === 'mine';
    if (personal && !viewer.userId) throw new FileError(403, 'not signed in to Home Assistant');
    const owner = personal && viewer.userId ? viewer.userId : SHARED;
    const saved = await saveUpload(
      rootOf(deps, owner),
      url.searchParams.get('name') ?? '',
      req,
      url.searchParams.get('overwrite') === '1',
    );
    resync(deps);
    sendJson(res, saved.replaced ? 200 : 201, { ...saved, status: presentStatus(deps.indexer.status, owners) });
    return;
  }

  const manualMatch = /^\/api\/manuals\/([\w-]+)$/.exec(path);
  if (manualMatch?.[1] && req.method === 'DELETE') {
    const manual = getManual(deps.db, manualMatch[1]);
    // Someone else's document is reported as missing, not as forbidden.
    if (!manual || !owners.includes(manual.owner)) throw new FileError(404, 'not found');
    await deleteManualFile(rootOf(deps, manual.owner), manual.path);
    // The sync drops it from the index (or hands it to an identical copy).
    resync(deps);
    sendJson(res, 200, { path: manual.path, status: presentStatus(deps.indexer.status, owners) });
    return;
  }

  if (path === '/api/facts' && req.method === 'POST') {
    sendJson(res, 201, await facts.create(viewer.userId, await readJson(req)));
    return;
  }

  const factMatch = /^\/api\/facts\/([\w-]+)$/.exec(path);
  if (factMatch?.[1] && req.method === 'PUT') {
    sendJson(res, 200, await facts.update(viewer.userId, factMatch[1], await readJson(req)));
    return;
  }
  if (factMatch?.[1] && req.method === 'DELETE') {
    facts.delete(viewer.userId, factMatch[1]);
    sendJson(res, 200, { id: factMatch[1], deleted: true });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  if (path === '/api/me') {
    sendJson(res, 200, { signedIn: viewer.userId !== undefined, name: viewer.name ?? null });
    return;
  }

  if (path === '/api/manuals') {
    const manuals = listManuals(deps.db).filter((m) => owners.includes(m.owner));
    sendJson(res, 200, { manuals: manuals.map(presentManual), status: presentStatus(deps.indexer.status, owners) });
    return;
  }

  if (path === '/api/facts') {
    sendJson(res, 200, facts.list(viewer.userId));
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
    sendJson(res, 200, await searchAll(deps.db, deps.embeddingClient, { query, limit, owners }));
    return;
  }

  const fileMatch = /^\/api\/manuals\/([\w-]+)\/file$/.exec(path);
  if (fileMatch?.[1]) {
    const manual = getManual(deps.db, fileMatch[1]);
    // The path came from our own directory scan, but check anyway: this is
    // where a stored string turns into a file read.
    const full =
      manual && owners.includes(manual.owner)
        ? insideRoot(rootOf(deps, manual.owner), manual.path)
        : undefined;
    if (!full) {
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

/**
 * The ingress panel: search everything, read and manage the shared manuals and
 * the viewer's own documents, and manage remembered facts.
 */
export function createUiServer(deps: UiServerDeps): Server {
  const facts = new FactsApi(deps.db, deps.embeddingClient);
  return createServer((req, res) => {
    if (deps.allowedAddress && remoteAddress(req) !== deps.allowedAddress) {
      res.writeHead(403).end();
      return;
    }

    handle(deps, facts, req, res).catch((error: unknown) => {
      // Expected refusals (bad name, too large, already exists) go back to the
      // panel as they are; anything else is a bug worth logging.
      if (error instanceof FileError) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.message });
        // Stop reading a body we have already refused, e.g. an oversized upload.
        req.resume();
        return;
      }
      logError('ui', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
}
