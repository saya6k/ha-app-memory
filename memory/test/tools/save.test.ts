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
import { registerSaveTool } from '../../src/tools/save.js';

let dir: string;
let db: DbConnection;
let client: Client;
let embedCalls: string[];
let embedShouldFail: boolean;

function fakeEmbeddingClient(): EmbeddingClient {
  return {
    async embed(text: string) {
      embedCalls.push(text);
      if (embedShouldFail) {
        throw new Error('embedding sidecar unreachable');
      }
      return new Array(EMBEDDING_DIMENSIONS).fill(0.1) as number[];
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-test-'));
  db = openDb(join(dir, 'facts.sqlite'));
  embedCalls = [];
  embedShouldFail = false;

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSaveTool(server, db, fakeEmbeddingClient());

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('save', () => {
  it('saves a fact and returns an id, writing both facts and vec_facts rows', async () => {
    const result = await client.callTool({
      name: 'save',
      arguments: { content: 'the sky is blue', tags: ['color'] },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    const { id } = JSON.parse(content[0]?.text ?? '{}') as { id: string };
    expect(id).toBeTruthy();

    const factRow = db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
    expect(factRow).toBeDefined();
    const vecRow = db.prepare('SELECT id FROM vec_facts WHERE id = ?').get(id);
    expect(vecRow).toBeDefined();
  });

  it('rejects missing content with a Zod validation error and writes nothing', async () => {
    const result = await client.callTool({ name: 'save', arguments: { tags: ['x'] } });

    expect(result.isError).toBe(true);
    const count = db.prepare('SELECT COUNT(*) as n FROM facts').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('leaves no partial write when the embedding client fails', async () => {
    embedShouldFail = true;

    const result = await client.callTool({
      name: 'save',
      arguments: { content: 'this will fail' },
    });

    expect(result.isError).toBe(true);
    const factCount = db.prepare('SELECT COUNT(*) as n FROM facts').get() as { n: number };
    const vecCount = db.prepare('SELECT COUNT(*) as n FROM vec_facts').get() as { n: number };
    expect(factCount.n).toBe(0);
    expect(vecCount.n).toBe(0);
  });
});
