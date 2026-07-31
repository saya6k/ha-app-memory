import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../config.js';
import { META_EMBEDDING_MODEL, SCHEMA_SQL } from './schema.js';

export type DbConnection = Database.Database;

export class DimensionMismatchError extends Error {}
export class ModelMismatchError extends Error {}

/**
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` silently keeps an existing vec0 table's
 * original width, so changing embedding_dimensions against a populated database
 * opens cleanly and then fails on every save and search with a dimension
 * mismatch. Catch it at open time instead, while there is still something
 * useful to say about it.
 */
function assertDimensionsMatch(db: DbConnection): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_facts'").get() as
    { sql: string } | undefined;
  const stored = row?.sql.match(/FLOAT\[(\d+)\]/)?.[1];

  if (stored === undefined || Number(stored) === EMBEDDING_DIMENSIONS) {
    return;
  }

  throw new DimensionMismatchError(
    `This memory database stores ${stored}-dimension vectors, but embedding_dimensions ` +
      `is set to ${EMBEDDING_DIMENSIONS}. Set embedding_dimensions back to ${stored}, or ` +
      `delete the database file to start a fresh memory.`,
  );
}

/**
 * A same-width model swap is the failure the vec0 table cannot see: the inserts
 * and searches keep working, they just stop finding anything, because the old
 * vectors live in a different space. `meta` records which model wrote them.
 *
 * A database from before `meta` existed has no row; adopt the current model
 * rather than guessing, since there is nothing else to go on.
 */
function assertModelMatches(db: DbConnection): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_EMBEDDING_MODEL) as
    { value: string } | undefined;

  if (row === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      META_EMBEDDING_MODEL,
      EMBEDDING_MODEL,
    );
    return;
  }

  if (row.value === EMBEDDING_MODEL) {
    return;
  }

  throw new ModelMismatchError(
    `This memory database was written by the embedding model "${row.value}", but the ` +
      `add-on is now configured for "${EMBEDDING_MODEL}". Vectors from a different model ` +
      `are not comparable, so the stored memories would no longer be found by meaning. ` +
      `Set model_file back to "${row.value}", or delete the database file to start a ` +
      `fresh memory.`,
  );
}

export interface OpenDbOptions {
  /**
   * Skip the compatibility guards. Only the migration may do this — it is the
   * one caller whose job is to *resolve* a mismatch rather than refuse it.
   */
  unchecked?: boolean;
}

export function openDb(path: string, options: OpenDbOptions = {}): DbConnection {
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  if (options.unchecked) {
    return db;
  }

  try {
    assertDimensionsMatch(db);
    assertModelMatches(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}
