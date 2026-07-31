import { EMBEDDING_DIMENSIONS } from '../config.js';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id          TEXT PRIMARY KEY,
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

export const META_EMBEDDING_MODEL = 'embedding_model';
