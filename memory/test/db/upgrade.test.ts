import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../../src/config.js';
import { openDb } from '../../src/db/client.js';
import { listFacts } from '../../src/db/facts.js';

/**
 * A v0.3.0 database: facts without an owner, and a manual index whose
 * uniqueness ignored owners. Opening it with this version must keep every
 * fact (as shared) and replace the index with the per-owner shape.
 */
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-upgrade-'));
  path = join(dir, 'facts.sqlite');

  const db = new Database(path);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE facts (id TEXT PRIMARY KEY, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE vec_facts USING vec0(id TEXT PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE manuals (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      format TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL, page_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      indexed_at TEXT NOT NULL);
    CREATE TABLE manual_chunks (id INTEGER PRIMARY KEY, manual_id TEXT NOT NULL,
      page INTEGER NOT NULL, section TEXT, content TEXT NOT NULL);
    CREATE VIRTUAL TABLE vec_manual_chunks USING vec0(id INTEGER PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine);
  `);
  db.prepare(
    "INSERT INTO facts VALUES ('f1', 'wifi is 1234', '[]', '2026-01-01', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO manuals VALUES ('m1', 'Washer.pdf', 'Washer', 'pdf', 'abc', 1, 1, 1, 1, '')",
  ).run();
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('opening a v0.3.0 database', () => {
  it('keeps every fact, now shared', () => {
    const db = openDb(path, { unchecked: true });
    expect(listFacts(db, '')).toMatchObject([{ id: 'f1', owner: '', content: 'wifi is 1234' }]);
    db.close();
  });

  it('replaces the manual index with the per-owner shape, to be rebuilt from the files', () => {
    const db = openDb(path, { unchecked: true });
    const columns = (db.prepare('PRAGMA table_info(manuals)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('owner');
    expect(db.prepare('SELECT count(*) AS c FROM manuals').get()).toEqual({ c: 0 });

    // The same content may now be indexed once per owner.
    const insert = db.prepare(
      "INSERT INTO manuals VALUES (?, ?, 'a.pdf', 'a', 'pdf', 'same', 1, 1, 1, 0, '')",
    );
    insert.run('shared', '');
    insert.run('dad', 'u-dad');
    expect(() => insert.run('again', '')).toThrow(/UNIQUE/);
    db.close();
  });

  it('only replaces the index once', () => {
    openDb(path, { unchecked: true }).close();
    const db = openDb(path, { unchecked: true });
    db.prepare(
      "INSERT INTO manuals VALUES ('x', '', 'a.pdf', 'a', 'pdf', 'h', 1, 1, 1, 0, '')",
    ).run();
    db.close();

    const reopened = openDb(path, { unchecked: true });
    expect(reopened.prepare('SELECT count(*) AS c FROM manuals').get()).toEqual({ c: 1 });
    reopened.close();
  });
});
