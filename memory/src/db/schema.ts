import { EMBEDDING_DIMENSIONS } from '../config.js';

export const SCHEMA_SQL = `
-- owner: '' for a fact shared by the household, else the HA user id of the
-- person it belongs to. '' rather than NULL so it compares like any value.
CREATE TABLE IF NOT EXISTS facts (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
);

-- Which embedding model produced the stored vectors. The vec0 table already
-- records their width, but not their meaning: vectors from a different model
-- are in a different space even at the same width, so old memories silently
-- stop matching. Nothing else can tell us that, hence this table.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * The document index, kept apart from SCHEMA_SQL because it is versioned: a
 * database whose index has an older shape has it dropped and recreated (see
 * client.ts), which costs nothing but a background re-index of the files.
 */
export const MANUAL_INDEX_VERSION = '2';

export const MANUAL_SCHEMA_SQL = `
-- Indexed documents: the shared appliance manuals (owner '') and each user's
-- personal documents (owner = HA user id), PDF or Markdown. Unlike facts, the
-- files are the source of truth and this is only an index of them, which may be
-- dropped and rebuilt at any time. Within an owner a document is its content:
-- (owner, sha256) is unique, so a renamed or moved file keeps its vectors and an
-- identical copy is not indexed twice. size + mtime only decide whether a file
-- needs re-hashing. path is relative to the owner's folder.
CREATE TABLE IF NOT EXISTS manuals (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL,
  title       TEXT NOT NULL,
  format      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  page_count  INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL,
  UNIQUE (owner, path),
  UNIQUE (owner, sha256)
);

-- page: the PDF page, or for Markdown the section — the number of top-level
-- headings up to and including this one, 0 for text before the first.
-- section: that heading's text (Markdown only).
CREATE TABLE IF NOT EXISTS manual_chunks (
  id        INTEGER PRIMARY KEY,
  manual_id TEXT NOT NULL,
  page      INTEGER NOT NULL,
  section   TEXT,
  content   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS manual_chunks_manual_id ON manual_chunks (manual_id);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_manual_chunks USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
);
`;

export const META_MANUAL_INDEX_VERSION = 'manual_index_version';
/** The chunk_size the document index was cut with; a different one rebuilds it. */
export const META_CHUNK_SIZE = 'chunk_size';

export const META_EMBEDDING_MODEL = 'embedding_model';
/**
 * The prefix stored facts were embedded with. Part of what a vector means just
 * like the model is; only the document side is recorded, since queries are
 * never stored. Absent means "", which is all a database written before
 * prefixes existed can have used.
 */
export const META_DOCUMENT_PREFIX = 'document_prefix';
