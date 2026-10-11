import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../../src/config.js';
import { type DbConnection, openDb } from '../../src/db/client.js';
import { replaceManual } from '../../src/db/manuals.js';
import type { EmbeddingClient } from '../../src/embedding/types.js';
import { registerDeleteTool } from '../../src/tools/delete.js';
import { registerGetTool } from '../../src/tools/get.js';
import { registerSaveTool } from '../../src/tools/save.js';
import { registerSearchTool } from '../../src/tools/search.js';
import { registerSimilarTool } from '../../src/tools/similar.js';
import { registerUpdateTool } from '../../src/tools/update.js';
import type { UserDirectory } from '../../src/users.js';

/**
 * Per-user memory through the tools: what each person (as named by the model)
 * can see and change, and how the one `search` merges facts with documents.
 */

let dir: string;
let db: DbConnection;
let client: Client;
/** Embedding angle per text; anything not listed points at the query. */
let angles: Record<string, number>;

const users: UserDirectory = {
  people: async () => [
    { userId: 'u-dad', name: '아빠', slug: 'dad' },
    { userId: 'u-mina', name: 'Mina', slug: 'mina' },
  ],
};

function angled(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  const vec = new Array(EMBEDDING_DIMENSIONS).fill(0) as number[];
  vec[0] = Math.cos(rad);
  vec[1] = Math.sin(rad);
  return vec;
}

const embedding: EmbeddingClient = {
  async embed(text) {
    return angled(angles[text] ?? 0);
  },
};

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  return { isError: result.isError === true, text: first?.text ?? '' };
}

async function ok(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await call(name, args);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text);
}

async function save(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  return ((await ok('save', { content, ...extra })) as { id: string }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-personal-'));
  db = openDb(join(dir, 'facts.sqlite'));
  angles = {};

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSearchTool(server, db, embedding, users);
  registerSaveTool(server, db, embedding, users);
  registerGetTool(server, db, users);
  registerUpdateTool(server, db, embedding, users);
  registerSimilarTool(server, db, users);
  registerDeleteTool(server, db, users);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('personal memories', () => {
  it('keeps a fact personal for the named user, and shared when asked or when nobody is named', async () => {
    expect(await ok('save', { content: '나는 땅콩 알레르기가 있다', user: '아빠' })).toMatchObject({
      shared: false,
    });
    expect(
      await ok('save', { content: 'Wi-Fi 비밀번호는 1234', user: '아빠', shared: true }),
    ).toMatchObject({ shared: true });
    expect(await ok('save', { content: '분리수거는 화요일' })).toMatchObject({ shared: true });
  });

  it("shows each person their own facts and the shared ones, never someone else's", async () => {
    await save('dad allergy', { user: 'dad' });
    await save('mina plan', { user: 'Mina' });
    await save('house wifi');

    const contents = async (user?: string) =>
      ((await ok('search', { query: 'q', user, limit: 20 })) as { content: string }[])
        .map((r) => r.content)
        .sort();

    expect(await contents('dad')).toEqual(['dad allergy', 'house wifi']);
    expect(await contents('mina')).toEqual(['house wifi', 'mina plan']);
    expect(await contents()).toEqual(['house wifi']);
  });

  it("treats someone else's fact as missing for get, update, delete and similar", async () => {
    const id = await save('dad allergy', { user: 'dad' });

    for (const [name, args] of [
      ['get', { id }],
      ['update', { id, fact: { content: 'changed' } }],
      ['delete', { id }],
      ['similar', { id }],
    ] as const) {
      const result = await call(name, { ...args, user: 'mina' });
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toMatch(/Fact not found/);
    }
    // Still there for its owner — labelled personal, without exposing the user id.
    const fact = await ok('get', { id, user: 'dad' });
    expect(fact).toMatchObject({ content: 'dad allergy', personal: true });
    expect(fact).not.toHaveProperty('owner');
  });

  it('leaves other people out of similar results', async () => {
    angles = { a: 0, 'dad b': 5, 'mina c': 6 };
    const a = await save('a');
    await save('dad b', { user: 'dad' });
    await save('mina c', { user: 'mina' });

    const results = (await ok('similar', { id: a, user: 'dad' })) as { content: string }[];
    expect(results.map((r) => r.content)).toEqual(['dad b']);
  });

  it('names the known people when the model gets a name wrong', async () => {
    const result = await call('search', { query: 'q', user: 'Bob' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Unknown user "Bob". Known people: 아빠, Mina/);
  });
});

describe('one search over everything', () => {
  function addDocument(owner: string, title: string, angle: number, format: 'pdf' | 'markdown') {
    replaceManual(
      db,
      {
        id: `${owner || 'shared'}-${title}`,
        owner,
        path: `${title}.${format === 'pdf' ? 'pdf' : 'md'}`,
        title,
        format,
        sha256: title,
        size: 1,
        mtimeMs: 1,
        pageCount: 3,
        indexedAt: '',
      },
      [
        {
          page: format === 'pdf' ? 3 : 1,
          section: format === 'pdf' ? undefined : '필터',
          content: `${title} passage`,
          embedding: angled(angle),
        },
      ],
    );
  }

  it('ranks facts, manuals and personal documents together, each labelled', async () => {
    angles = { 'shared fact': 30, 'dad fact': 10 };
    await save('shared fact');
    await save('dad fact', { user: 'dad' });
    addDocument('', 'Washer', 20, 'pdf');
    addDocument('u-dad', 'Dad notes', 5, 'markdown');
    addDocument('u-mina', 'Mina notes', 1, 'markdown');

    const results = (await ok('search', { query: 'q', user: 'dad', limit: 10 })) as Record<
      string,
      unknown
    >[];

    expect(results.map((r) => [r.type, r.title ?? r.content])).toEqual([
      ['document', 'Dad notes'],
      ['memory', 'dad fact'],
      ['manual', 'Washer'],
      ['memory', 'shared fact'],
    ]);
    expect(results[0]).toMatchObject({ file: 'Dad notes.md', section: '필터' });
    expect(results[0]).not.toHaveProperty('manualId');
    expect(results[1]).toMatchObject({ personal: true });
    expect(results[2]).toMatchObject({ page: 3 });
    expect(results[2]).not.toHaveProperty('section');
  });

  it('returns facts only when filtering by tag', async () => {
    await save('tagged', { tags: ['kitchen'] });
    addDocument('', 'Washer', 0, 'pdf');

    const results = (await ok('search', {
      query: 'q',
      filter: { tags: ['kitchen'] },
    })) as { type: string }[];
    expect(results.map((r) => r.type)).toEqual(['memory']);
  });
});
