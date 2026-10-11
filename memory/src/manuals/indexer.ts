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
  /** Files whose content is already indexed under another path; skipped. */
  duplicates: { path: string; of: string }[];
  /** Files that could not be read or embedded; the rest of the sync still went through. */
  failed: { path: string; error: string }[];
  /** False when MANUALS_DIR does not exist — nothing was scanned, and nothing removed. */
  dirFound: boolean;
}

export type IndexOperation = 'sync' | 'reindex' | 'reset';

export interface IndexStatus {
  running: boolean;
  operation?: IndexOperation;
  /** The file being indexed right now, relative to the manuals directory. */
  current?: string;
  lastSync?: SyncResult & { finishedAt: string };
}

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
 * Keeps the manual index in step with the files on disk. A manual is identified
 * by its content hash, so only content the index has never seen is embedded:
 *
 * - same path, same size and mtime: skipped without reading the file
 * - otherwise the file is hashed, and if that content is already indexed —
 *   under a path that is gone (a rename or move) or this same path (a touched
 *   file) — only the path is updated; under a path that still exists, the file
 *   is an identical copy and is skipped
 * - new content is extracted, chunked and embedded
 * - manuals whose file is gone are dropped
 *
 * One operation at a time: a sync requested while one runs gets that run's
 * result, and a reset or reindex waits for whatever is running.
 */
export class ManualIndexer {
  private queue: Promise<unknown> = Promise.resolve();
  /** Queued or running operations; counted at once so status never lags a request. */
  private pending = 0;
  private pendingSync: Promise<SyncResult> | undefined;
  private operation: IndexOperation | undefined;
  private current: string | undefined;
  private lastSync: IndexStatus['lastSync'];

  constructor(
    private readonly db: DbConnection,
    private readonly embedding: EmbeddingClient,
    private readonly dir: string,
    private readonly extract: (
      path: string,
      format: ManualFormat,
    ) => Promise<ExtractedManual> = extractManual,
  ) {}

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
    this.pendingSync ??= this.enqueue('sync', () => this.run()).finally(() => {
      this.pendingSync = undefined;
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

    const files = await scan(this.dir);
    if (files === undefined) {
      result.dirFound = false;
    } else {
      const onDisk = new Set(files.map((f) => f.path));
      const byPath = new Map(listManuals(this.db).map((m) => [m.path, m]));

      // Known paths first: a file edited in place must give up its old content
      // before another file is matched against it, or a copy of the old
      // version would be taken for a duplicate of a file that no longer has it.
      const known = files.filter((f) => byPath.has(f.path));
      const unknown = files.filter((f) => !byPath.has(f.path));

      for (const file of [...known, ...unknown]) {
        this.current = file.path;
        try {
          await this.syncFile(file, byPath.get(file.path), onDisk, result);
        } catch (error) {
          logError('manual-index', error);
          result.failed.push({
            path: file.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Whatever still points at a missing file was neither moved nor kept.
      for (const manual of listManuals(this.db)) {
        if (!onDisk.has(manual.path)) {
          deleteManual(this.db, manual.id);
          result.removed += 1;
        }
      }
    }

    this.lastSync = { ...result, finishedAt: new Date().toISOString() };
    return result;
  }

  private async syncFile(
    file: ManualFile,
    existing: Manual | undefined,
    onDisk: Set<string>,
    result: SyncResult,
  ): Promise<void> {
    if (existing && existing.size === file.size && existing.mtimeMs === file.mtimeMs) {
      result.unchanged += 1;
      return;
    }

    const hash = await sha256(join(this.dir, file.path));
    const location = {
      path: file.path,
      title: titleOf(file.path),
      size: file.size,
      mtimeMs: file.mtimeMs,
    };
    const indexed = getManualByHash(this.db, hash);

    if (indexed) {
      if (indexed.path === file.path) {
        // Touched or copied over with identical content.
        relocateManual(this.db, indexed.id, location);
        result.unchanged += 1;
      } else if (onDisk.has(indexed.path)) {
        result.duplicates.push({ path: file.path, of: indexed.path });
        // This path's own previous content, if any, is gone now.
        if (existing) deleteManual(this.db, existing.id);
      } else {
        if (existing) deleteManual(this.db, existing.id);
        relocateManual(this.db, indexed.id, location);
        result.moved += 1;
      }
      return;
    }

    await this.index(file, hash, existing?.id ?? randomUUID());
    result[existing ? 'updated' : 'added'] += 1;
  }

  private async index(file: ManualFile, hash: string, id: string): Promise<void> {
    const title = titleOf(file.path);
    const { pageCount, parts } = await this.extract(join(this.dir, file.path), file.format);

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
