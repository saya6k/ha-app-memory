import { EMBEDDING_DIMENSIONS } from '../config.js';
import type { DbConnection } from './client.js';

export type ManualFormat = 'pdf' | 'markdown';

export interface Manual {
  id: string;
  /** Relative to MANUALS_DIR, always with `/` separators. */
  path: string;
  title: string;
  format: ManualFormat;
  /** Hex SHA-256 of the file. Unique: one manual per distinct content. */
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

export function listManuals(db: DbConnection): Manual[] {
  const rows = db
    .prepare('SELECT * FROM manuals ORDER BY title COLLATE NOCASE')
    .all() as ManualRow[];
  return rows.map(rowToManual);
}

export function getManual(db: DbConnection, id: string): Manual | undefined {
  const row = db.prepare('SELECT * FROM manuals WHERE id = ?').get(id) as ManualRow | undefined;
  return row ? rowToManual(row) : undefined;
}

export function getManualByHash(db: DbConnection, sha256: string): Manual | undefined {
  const row = db.prepare('SELECT * FROM manuals WHERE sha256 = ?').get(sha256) as
    ManualRow | undefined;
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
         (id, path, title, format, sha256, size, mtime_ms, page_count, chunk_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      manual.id,
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

/**
 * Empties the manual index. The vec0 table is recreated rather than emptied,
 * which both frees its space and picks up the configured width — the
 * migration relies on that after a dimension change.
 */
export function clearManualIndex(db: DbConnection): void {
  db.transaction(() => {
    db.exec('DELETE FROM manuals');
    db.exec('DELETE FROM manual_chunks');
    db.exec('DROP TABLE IF EXISTS vec_manual_chunks');
    db.exec(
      `CREATE VIRTUAL TABLE vec_manual_chunks USING vec0(
         id INTEGER PRIMARY KEY,
         embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
       )`,
    );
  })();
}

export interface ManualChunkMatch {
  manualId: string;
  title: string;
  path: string;
  format: ManualFormat;
  page: number;
  section: string | null;
  content: string;
  distance: number;
}

/** KNN over every indexed chunk, nearest first. */
export function searchManualChunks(
  db: DbConnection,
  embedding: number[],
  k: number,
): ManualChunkMatch[] {
  return db
    .prepare(
      `SELECT m.id AS manualId, m.title, m.path, m.format, c.page, c.section, c.content, v.distance
         FROM (SELECT id, distance FROM vec_manual_chunks
                WHERE embedding MATCH ? AND k = ?) v
         JOIN manual_chunks c ON c.id = v.id
         JOIN manuals m ON m.id = c.manual_id
        ORDER BY v.distance`,
    )
    .all(new Float32Array(embedding), k) as ManualChunkMatch[];
}
