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
import { registerSimilarTool } from '../../src/tools/similar.js';

let dir: string;
let db: DbConnection;
let client: Client;
let embeddings: Record<string, number[]>;

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
  embeddings = {};

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const embeddingClient = fakeEmbeddingClient();
  registerSaveTool(server, db, embeddingClient);
  registerGetTool(server, db);
  registerSimilarTool(server, db);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function save(content: string): Promise<string> {
  const result = await client.callTool({ name: 'save', arguments: { content } });
  const content0 = result.content as { type: string; text: string }[];
  return (JSON.parse(content0[0]?.text ?? '{}') as { id: string }).id;
}

interface SimilarResult {
  id: string;
  content: string;
  distance: number;
}

describe('similar', () => {
  it('excludes the query fact itself and orders the rest by distance', async () => {
    embeddings['origin'] = angledEmbedding(0);
    embeddings['close'] = angledEmbedding(10);
    embeddings['far'] = angledEmbedding(90);
    const originId = await save('origin');
    await save('close');
    await save('far');

    const result = await client.callTool({ name: 'similar', arguments: { id: originId } });
    expect(result.isError).toBeFalsy();

    const content = result.content as { type: string; text: string }[];
    const results = JSON.parse(content[0]?.text ?? '[]') as SimilarResult[];

    expect(results.map((r) => r.id)).not.toContain(originId);
    expect(results.map((r) => r.content)).toEqual(['close', 'far']);
    expect(results[0]?.distance).toBeLessThan(results[1]?.distance ?? Infinity);
  });

  it('returns an explicit error for an unknown id', async () => {
    const result = await client.callTool({
      name: 'similar',
      arguments: { id: 'does-not-exist' },
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a missing id with a Zod validation error', async () => {
    const result = await client.callTool({ name: 'similar', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
