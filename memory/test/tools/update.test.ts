import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../../src/config.js';
import { type DbConnection, openDb } from '../../src/db/client.js';
import type { EmbeddingClient } from '../../src/embedding/types.js';
import { registerGetTool } from '../../src/tools/get.js';
import { registerSaveTool } from '../../src/tools/save.js';
import { registerSearchTool } from '../../src/tools/search.js';
import { registerUpdateTool } from '../../src/tools/update.js';

let dir: string;
let db: DbConnection;
let client: Client;
let embedCallCount: number;

function fakeEmbeddingClient(): EmbeddingClient {
  return {
    async embed(text: string) {
      embedCallCount += 1;
      // Deterministic, distinguishable-by-content vector for the search-visibility check.
      const seed = text.length % 10;
      return new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => (i === 0 ? seed : 0));
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-test-'));
  db = openDb(join(dir, 'facts.sqlite'));
  embedCallCount = 0;

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const embeddingClient = fakeEmbeddingClient();
  registerSaveTool(server, db, embeddingClient);
  registerGetTool(server, db);
  registerSearchTool(server, db, embeddingClient);
  registerUpdateTool(server, db, embeddingClient);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function save(content: string, tags?: string[]): Promise<string> {
  const result = await client.callTool({ name: 'save', arguments: { content, tags } });
  const content0 = result.content as { type: string; text: string }[];
  return (JSON.parse(content0[0]?.text ?? '{}') as { id: string }).id;
}

async function get(id: string): Promise<{
  content: string;
  tags: string[];
  updatedAt: string;
}> {
  const result = await client.callTool({ name: 'get', arguments: { id } });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '{}');
}

describe('update', () => {
  it('re-embeds and updates the stored vector when content changes', async () => {
    const id = await save('original content', ['a']);
    embedCallCount = 0; // reset after the save's own embed call

    const result = await client.callTool({
      name: 'update',
      arguments: { id, fact: { content: 'brand new content' } },
    });

    expect(result.isError).toBeFalsy();
    expect(embedCallCount).toBe(1);

    const fact = await get(id);
    expect(fact.content).toBe('brand new content');
  });

  it('does not call the embedding client when only tags change', async () => {
    const id = await save('stable content', ['a']);
    embedCallCount = 0;

    const result = await client.callTool({
      name: 'update',
      arguments: { id, fact: { tags: ['b', 'c'] } },
    });

    expect(result.isError).toBeFalsy();
    expect(embedCallCount).toBe(0);

    const fact = await get(id);
    expect(fact.content).toBe('stable content');
    expect(fact.tags).toEqual(['b', 'c']);
  });

  it('bumps updated_at on a successful update', async () => {
    const id = await save('time check', []);
    const before = await get(id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await client.callTool({ name: 'update', arguments: { id, fact: { tags: ['x'] } } });

    const after = await get(id);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
  });

  it('returns an explicit error for an unknown id', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { id: 'does-not-exist', fact: { tags: ['x'] } },
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a missing fact object with a Zod validation error', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { id: 'whatever' },
    });
    expect(result.isError).toBe(true);
  });
});
