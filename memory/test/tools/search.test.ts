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

let dir: string;
let db: DbConnection;
let client: Client;
let embeddings: Record<string, number[]>;

/**
 * A unit vector with all "signal" in the first two dimensions (angle in
 * degrees) and zeros elsewhere. Cosine similarity depends only on direction,
 * so this gives exact, deterministic control over each fact's distance from
 * a query at angle 0 without depending on sqlite-vec's exact distance formula.
 */
function angledEmbedding(angleDeg: number): number[] {
  const rad = (angleDeg * Math.PI) / 180;
  const vec = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vec[0] = Math.cos(rad);
  vec[1] = Math.sin(rad);
  return vec;
}

function fakeEmbeddingClient(): EmbeddingClient {
  return {
    async embed(text: string) {
      const vec = embeddings[text];
      if (!vec) throw new Error(`no fixture embedding for "${text}"`);
      return vec;
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-test-'));
  db = openDb(join(dir, 'facts.sqlite'));
  embeddings = { query: angledEmbedding(0) };

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const embeddingClient = fakeEmbeddingClient();
  registerSaveTool(server, db, embeddingClient);
  registerGetTool(server, db);
  registerSearchTool(server, db, embeddingClient);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function save(content: string, tags?: string[]): Promise<void> {
  const result = await client.callTool({ name: 'save', arguments: { content, tags } });
  expect(result.isError).toBeFalsy();
}

interface SearchResult {
  id: string;
  content: string;
  tags: string[];
  distance: number;
}

async function search(args: {
  query: string;
  filter?: { tags?: string[] };
  limit?: number;
}): Promise<SearchResult[]> {
  const result = await client.callTool({ name: 'search', arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '[]') as SearchResult[];
}

describe('search', () => {
  it('orders results by cosine distance ascending', async () => {
    embeddings['near-fact'] = angledEmbedding(0);
    embeddings['mid-fact'] = angledEmbedding(30);
    embeddings['far-fact'] = angledEmbedding(90);
    await save('far-fact');
    await save('near-fact');
    await save('mid-fact');

    const results = await search({ query: 'query' });

    expect(results.map((r) => r.content)).toEqual(['near-fact', 'mid-fact', 'far-fact']);
    expect(results[0]?.distance).toBeLessThan(results[1]?.distance ?? Infinity);
    expect(results[1]?.distance).toBeLessThan(results[2]?.distance ?? Infinity);
  });

  it('excludes facts that have none of the requested tags (ANY-match)', async () => {
    embeddings['near-fact'] = angledEmbedding(0);
    embeddings['mid-fact'] = angledEmbedding(30);
    embeddings['far-fact'] = angledEmbedding(90);
    await save('near-fact', ['a']);
    await save('mid-fact', ['b']);
    await save('far-fact', ['a', 'b']);

    const results = await search({ query: 'query', filter: { tags: ['a'] } });

    expect(results.map((r) => r.content)).toEqual(['near-fact', 'far-fact']);
  });

  it('clamps limit to the 20-result cap instead of rejecting the request', async () => {
    for (let i = 0; i < 25; i++) {
      embeddings[`fact-${i}`] = angledEmbedding(i);
      await save(`fact-${i}`);
    }

    const results = await search({ query: 'query', limit: 999 });

    expect(results).toHaveLength(20);
  });

  it('rejects a missing query with a Zod validation error', async () => {
    const result = await client.callTool({ name: 'search', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
