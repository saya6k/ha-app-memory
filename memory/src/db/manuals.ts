import type { DbConnection } from './client.js';
import { CHUNK_SIZE } from '../config.js';
import {
  MANUAL_INDEX_VERSION,
  MANUAL_SCHEMA_SQL,
  META_CHUNK_SIZE,
  META_MANUAL_INDEX_VERSION,
} from './schema.js';

export type ManualFormat = 'pdf' | 'markdown';

/** '' for the shared manuals, else the HA user id whose personal document it is. */
export type Owner = string;
export const SHARED: Owner = '';

export interface Manual {
  id: string;
  owner: Owner;
  /** Relative to the owner's folder, always with `/` separators. */
  path: string;
  title: string;
  format: ManualFormat;
  /** Hex SHA-256 of the file. Unique per owner: one manual per distinct content. */
  sha256: string;
  size: number;
  mtimeMs: number;
  /** PDF pages, or Markdown sections. */
  pageCount: number;
  /** 0 means there was no text to index (typically a scanned PDF), so it cannot be searched. */
  chunkCount: number;
  indexedAt: string;
}

export interface ManualChunk {
  /** PDF page, or Markdown section number (0 = before the first heading). */
  page: number;
  /** Markdown heading text; absent for PDFs. */
  section?: string;
  content: string;
  embedding: number[];
}

/** Where a file currently is; changes on a rename without touching its vectors. */
export type ManualLocation = Pick<Manual, 'path' | 'title' | 'size' | 'mtimeMs'>;

function rowToManual(row: {
  id: string;
  owner: string;
  path: string;
  title: string;
  format: ManualFormat;
  sha256: string;
  size: number;
  mtime_ms: number;
  page_count: number;
  chunk_count: number;
  indexed_at: string;
}): Manual {
  return {
    id: row.id,
    owner: row.owner,
    path: row.path,
    title: row.title,
    format: row.format,
    sha256: row.sha256,
    size: row.size,
    mtimeMs: row.mtime_ms,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    indexedAt: row.indexed_at,
  };
}

type ManualRow = Parameters<typeof rowToManual>[0];

/** One owner's manuals, or every manual when `owner` is omitted. */
export function listManuals(db: DbConnection, owner?: Owner): Manual[] {
  const rows = (
    owner === undefined
      ? db.prepare('SELECT * FROM manuals ORDER BY title COLLATE NOCASE').all()
      : db.prepare('SELECT * FROM manuals WHERE owner = ? ORDER BY title COLLATE NOCASE').all(owner)
  ) as ManualRow[];
  return rows.map(rowToManual);
}

export function getManual(db: DbConnection, id: string): Manual | undefined {
  const row = db.prepare('SELECT * FROM manuals WHERE id = ?').get(id) as ManualRow | undefined;
  return row ? rowToManual(row) : undefined;
}

export function getManualByHash(
  db: DbConnection,
  owner: Owner,
  sha256: string,
): Manual | undefined {
  const row = db
    .prepare('SELECT * FROM manuals WHERE owner = ? AND sha256 = ?')
    .get(owner, sha256) as ManualRow | undefined;
  return row ? rowToManual(row) : undefined;
}

function deleteChunks(db: DbConnection, manualId: string): void {
  db.prepare(
    'DELETE FROM vec_manual_chunks WHERE id IN (SELECT id FROM manual_chunks WHERE manual_id = ?)',
  ).run(manualId);
  db.prepare('DELETE FROM manual_chunks WHERE manual_id = ?').run(manualId);
}

/**
 * Writes a manual and all of its chunks, replacing whatever was indexed for it
 * before, in one transaction — a search never sees half a manual.
 */
export function replaceManual(
  db: DbConnection,
  manual: Omit<Manual, 'chunkCount'>,
  chunks: ManualChunk[],
): void {
  db.transaction(() => {
    deleteChunks(db, manual.id);
    db.prepare(
      `INSERT OR REPLACE INTO manuals
         (id, owner, path, title, format, sha256, size, mtime_ms, page_count, chunk_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      manual.id,
      manual.owner,
      manual.path,
      manual.title,
      manual.format,
      manual.sha256,
      manual.size,
      manual.mtimeMs,
      manual.pageCount,
      chunks.length,
      manual.indexedAt,
    );

    const insertChunk = db.prepare(
      'INSERT INTO manual_chunks (manual_id, page, section, content) VALUES (?, ?, ?, ?)',
    );
    const insertVector = db.prepare('INSERT INTO vec_manual_chunks (id, embedding) VALUES (?, ?)');
    for (const chunk of chunks) {
      const { lastInsertRowid } = insertChunk.run(
        manual.id,
        chunk.page,
        chunk.section ?? null,
        chunk.content,
      );
      // vec0 only accepts an integer primary key bound as BigInt.
      insertVector.run(BigInt(lastInsertRowid), new Float32Array(chunk.embedding));
    }
  })();
}

/** Points a manual at a new path (a rename, or a touched file), keeping its vectors. */
export function relocateManual(db: DbConnection, id: string, location: ManualLocation): void {
  db.prepare('UPDATE manuals SET path = ?, title = ?, size = ?, mtime_ms = ? WHERE id = ?').run(
    location.path,
    location.title,
    location.size,
    location.mtimeMs,
    id,
  );
}

export function deleteManual(db: DbConnection, id: string): void {
  db.transaction(() => {
    deleteChunks(db, id);
    db.prepare('DELETE FROM manuals WHERE id = ?').run(id);
  })();
}

const MANUAL_TABLES = ['vec_manual_chunks', 'manual_chunks', 'manuals'];

/**
 * Empties the document index. The tables are recreated rather than emptied,
 * which frees the vectors' space and picks up the configured width — the
 * migration relies on that after a dimension change.
 */
export function clearManualIndex(db: DbConnection): void {
  db.transaction(() => {
    for (const table of MANUAL_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(MANUAL_SCHEMA_SQL);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      META_MANUAL_INDEX_VERSION,
      MANUAL_INDEX_VERSION,
    );
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      META_CHUNK_SIZE,
      String(CHUNK_SIZE),
    );
  })();
}

/** Chunks were always 400 characters before chunk_size could be set. */
const CHUNK_SIZE_BEFORE_OPTION = '400';

function readMeta(db: DbConnection, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

/**
 * Creates the document index, or replaces one built differently: of an older
 * shape, or cut into chunks of another size. Its contents are rebuilt from the
 * files by the next sync, so replacing it loses nothing.
 */
export function ensureManualIndex(db: DbConnection): void {
  const version = readMeta(db, META_MANUAL_INDEX_VERSION);
  const chunkSize = readMeta(db, META_CHUNK_SIZE) ?? CHUNK_SIZE_BEFORE_OPTION;
  if (version === MANUAL_INDEX_VERSION && chunkSize === String(CHUNK_SIZE)) {
    db.exec(MANUAL_SCHEMA_SQL);
    return;
  }
  clearManualIndex(db);
}

export interface ManualChunkMatch {
  manualId: string;
  owner: Owner;
  title: string;
  path: string;
  format: ManualFormat;
  page: number;
  section: string | null;
  content: string;
  distance: number;
}

/**
 * KNN over the chunks visible to `owners` (shared, plus the asking user's own),
 * nearest first. vec0 cannot filter by owner inside the MATCH, so candidates
 * are over-fetched and filtered here, as search does for tags; fine at
 * household scale.
 */
export function searchManualChunks(
  db: DbConnection,
  embedding: number[],
  k: number,
  owners: Owner[],
): ManualChunkMatch[] {
  const candidates = db
    .prepare(
      `SELECT m.id AS manualId, m.owner, m.title, m.path, m.format, c.page, c.section, c.content,
              v.distance
         FROM (SELECT id, distance FROM vec_manual_chunks
                WHERE embedding MATCH ? AND k = ?) v
         JOIN manual_chunks c ON c.id = v.id
         JOIN manuals m ON m.id = c.manual_id
        ORDER BY v.distance`,
    )
    .all(new Float32Array(embedding), Math.max(k * 10, 50)) as ManualChunkMatch[];
  return candidates.filter((c) => owners.includes(c.owner)).slice(0, k);
}
