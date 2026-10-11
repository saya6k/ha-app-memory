import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { DbConnection } from '../db/client.js';
import {
  clearManualIndex,
  deleteManual,
  getManualByHash,
  listManuals,
  relocateManual,
  replaceManual,
  type Manual,
  type ManualChunk,
  type ManualFormat,
  type Owner,
  SHARED,
} from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError } from '../log.js';
import { chunkPage } from './chunk.js';
import { extractManual, manualFormat, type ExtractedManual } from './extract.js';

export interface SyncResult {
  /** New content, embedded. */
  added: number;
  /** A known path whose content changed, re-embedded. */
  updated: number;
  /** Known content at a new path (renamed or moved): path updated, nothing embedded. */
  moved: number;
  removed: number;
  unchanged: number;
  /** Files whose content the same owner already has indexed under another path; skipped. */
  duplicates: { owner: Owner; path: string; of: string }[];
  /** Files that could not be read or embedded; the rest of the sync still went through. */
  failed: { owner: Owner; path: string; error: string }[];
  /**
   * False when the shared manuals folder does not exist — nothing in it was
   * scanned, and no shared manual removed.
   */
  dirFound: boolean;
}

export type IndexOperation = 'sync' | 'reindex' | 'reset';

export interface IndexStatus {
  running: boolean;
  operation?: IndexOperation;
  /** The file being indexed right now, relative to its owner's folder. */
  current?: { owner: Owner; path: string };
  lastSync?: SyncResult & { finishedAt: string };
}

/** A folder of documents and whose they are. */
interface IndexRoot {
  owner: Owner;
  dir: string;
}

/** Where a user's personal documents live: <usersDir>/<HA user id>/documents. */
export function userDocumentsDir(usersDir: string, userId: string): string {
  return join(usersDir, userId, 'documents');
}

/** HA user ids are hex; anything else in the users folder is not ours. */
const USER_ID = /^[0-9a-zA-Z_-]+$/;

interface ManualFile {
  path: string;
  format: ManualFormat;
  size: number;
  mtimeMs: number;
}

async function scan(dir: string): Promise<ManualFile[] | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const files: ManualFile[] = [];
  for (const entry of entries) {
    const format = entry.isFile() ? manualFormat(entry.name) : undefined;
    if (!format) continue;
    const full = join(entry.parentPath, entry.name);
    const info = await stat(full);
    files.push({
      path: relative(dir, full).split(sep).join('/'),
      format,
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs),
    });
  }
  // Stable order, so which of two identical copies wins does not depend on readdir.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function titleOf(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

/**
 * Keeps the index in step with the files on disk: the shared manuals folder and
 * each user's documents folder. Within an owner a document is identified by its
 * content hash, so only content the index has never seen is embedded:
 *
 * - same path, same size and mtime: skipped without reading the file
 * - otherwise the file is hashed, and if that content is already indexed —
 *   under a path that is gone (a rename or move) or this same path (a touched
 *   file) — only the path is updated; under a path that still exists, the file
 *   is an identical copy and is skipped
 * - new content is extracted, chunked and embedded
 * - manuals whose file is gone are dropped
 *
 * One operation at a time. A sync requested while one is running queues
 * another, so a file written meanwhile (an upload) is not missed; requests
 * made before that queued sync starts share it. A reset or reindex waits for
 * whatever is running.
 */
export class ManualIndexer {
  private queue: Promise<unknown> = Promise.resolve();
  /** Queued or running operations; counted at once so status never lags a request. */
  private pending = 0;
  /** A sync that is queued but has not started yet, for later requests to join. */
  private pendingSync: Promise<SyncResult> | undefined;
  private operation: IndexOperation | undefined;
  private current: IndexStatus['current'];
  private lastSync: IndexStatus['lastSync'];

  constructor(
    private readonly db: DbConnection,
    private readonly embedding: EmbeddingClient,
    /** The shared manuals folder. */
    private readonly dir: string,
    private readonly extract: (
      path: string,
      format: ManualFormat,
    ) => Promise<ExtractedManual> = extractManual,
    /** Parent of the per-user folders; personal documents are not indexed without it. */
    private readonly usersDir?: string,
  ) {}

  /** The shared folder, then every user folder that exists. */
  private async roots(): Promise<IndexRoot[]> {
    const roots: IndexRoot[] = [{ owner: SHARED, dir: this.dir }];
    if (!this.usersDir) return roots;
    const entries = await readdir(this.usersDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && USER_ID.test(entry.name)) {
        roots.push({ owner: entry.name, dir: userDocumentsDir(this.usersDir, entry.name) });
      }
    }
    return roots;
  }

  get status(): IndexStatus {
    return {
      running: this.pending > 0,
      operation: this.operation,
      current: this.current,
      lastSync: this.lastSync,
    };
  }

  /** Index new and changed files, drop deleted ones. */
  sync(): Promise<SyncResult> {
    this.pendingSync ??= this.enqueue('sync', () => {
      this.pendingSync = undefined;
      return this.run();
    });
    return this.pendingSync;
  }

  /** Empty the manual index. Nothing is rebuilt until the next sync. */
  reset(): Promise<void> {
    return this.enqueue('reset', async () => {
      clearManualIndex(this.db);
      this.lastSync = undefined;
    });
  }

  /** Empty the manual index and rebuild it from every file. */
  reindex(): Promise<SyncResult> {
    return this.enqueue('reindex', async () => {
      clearManualIndex(this.db);
      return this.run();
    });
  }

  private enqueue<T>(operation: IndexOperation, work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.queue.then(async () => {
      this.operation = operation;
      try {
        return await work();
      } finally {
        this.pending -= 1;
        this.operation = undefined;
        this.current = undefined;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<SyncResult> {
    const result: SyncResult = {
      added: 0,
      updated: 0,
      moved: 0,
      removed: 0,
      unchanged: 0,
      duplicates: [],
      failed: [],
      dirFound: true,
    };

    // Owners whose folder was read, with the paths found in it.
    const scanned = new Map<Owner, Set<string>>();
    for (const root of await this.roots()) {
      const files = await scan(root.dir);
      if (files === undefined) {
        if (root.owner === SHARED) result.dirFound = false;
        else scanned.set(root.owner, new Set()); // documents folder gone: nothing left
        continue;
      }
      scanned.set(root.owner, new Set(files.map((f) => f.path)));
      await this.syncRoot(root, files, result);
    }

    // Whatever still points at a missing file was neither moved nor kept. An
    // owner with no folder at all (a removed user) loses everything; the
    // shared manuals are kept when their folder could not be read.
    for (const manual of listManuals(this.db)) {
      const onDisk = scanned.get(manual.owner);
      const gone = onDisk ? !onDisk.has(manual.path) : manual.owner !== SHARED;
      if (gone) {
        deleteManual(this.db, manual.id);
        result.removed += 1;
      }
    }

    this.lastSync = { ...result, finishedAt: new Date().toISOString() };
    return result;
  }

  private async syncRoot(root: IndexRoot, files: ManualFile[], result: SyncResult): Promise<void> {
    const onDisk = new Set(files.map((f) => f.path));
    const byPath = new Map(listManuals(this.db, root.owner).map((m) => [m.path, m]));

    // Known paths first: a file edited in place must give up its old content
    // before another file is matched against it, or a copy of the old
    // version would be taken for a duplicate of a file that no longer has it.
    const known = files.filter((f) => byPath.has(f.path));
    const unknown = files.filter((f) => !byPath.has(f.path));

    for (const file of [...known, ...unknown]) {
      this.current = { owner: root.owner, path: file.path };
      try {
        await this.syncFile(root, file, byPath.get(file.path), onDisk, result);
      } catch (error) {
        logError('manual-index', error);
        result.failed.push({
          owner: root.owner,
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async syncFile(
    root: IndexRoot,
    file: ManualFile,
    existing: Manual | undefined,
    onDisk: Set<string>,
    result: SyncResult,
  ): Promise<void> {
    if (existing && existing.size === file.size && existing.mtimeMs === file.mtimeMs) {
      result.unchanged += 1;
      return;
    }

    const hash = await sha256(join(root.dir, file.path));
    const location = {
      path: file.path,
      title: titleOf(file.path),
      size: file.size,
      mtimeMs: file.mtimeMs,
    };
    const indexed = getManualByHash(this.db, root.owner, hash);

    if (indexed) {
      if (indexed.path === file.path) {
        // Touched or copied over with identical content.
        relocateManual(this.db, indexed.id, location);
        result.unchanged += 1;
      } else if (onDisk.has(indexed.path)) {
        result.duplicates.push({ owner: root.owner, path: file.path, of: indexed.path });
        // This path's own previous content, if any, is gone now.
        if (existing) deleteManual(this.db, existing.id);
      } else {
        if (existing) deleteManual(this.db, existing.id);
        relocateManual(this.db, indexed.id, location);
        result.moved += 1;
      }
      return;
    }

    await this.index(root, file, hash, existing?.id ?? randomUUID());
    result[existing ? 'updated' : 'added'] += 1;
  }

  private async index(root: IndexRoot, file: ManualFile, hash: string, id: string): Promise<void> {
    const title = titleOf(file.path);
    const { pageCount, parts } = await this.extract(join(root.dir, file.path), file.format);

    // Embedded before anything is written, so a failure leaves the previous
    // index of this file in place rather than half of a new one.
    const chunks: ManualChunk[] = [];
    for (const part of parts) {
      for (const content of chunkPage(part.text)) {
        // The title goes into the embedded text but not the stored content:
        // a page about "E3" rarely says which appliance it belongs to, and
        // "washer E3" should still land on it.
        const embedding = await this.embedding.embed(`${title}\n${content}`, 'document');
        chunks.push({ page: part.page, section: part.section, content, embedding });
      }
    }

    replaceManual(
      this.db,
      {
        id,
        owner: root.owner,
        path: file.path,
        title,
        format: file.format,
        sha256: hash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        pageCount,
        indexedAt: new Date().toISOString(),
      },
      chunks,
    );
  }
}
