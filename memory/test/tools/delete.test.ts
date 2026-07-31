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
import { registerDeleteTool } from '../../src/tools/delete.js';
import { registerGetTool } from '../../src/tools/get.js';
import { registerSaveTool } from '../../src/tools/save.js';
import { registerSearchTool } from '../../src/tools/search.js';

let dir: string;
let db: DbConnection;
let client: Client;

function fakeEmbeddingClient(): EmbeddingClient {
  return {
    async embed() {
      return new Array(EMBEDDING_DIMENSIONS).fill(0.1) as number[];
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-test-'));
  db = openDb(join(dir, 'facts.sqlite'));

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const embeddingClient = fakeEmbeddingClient();
  registerSaveTool(server, db, embeddingClient);
  registerGetTool(server, db);
  registerSearchTool(server, db, embeddingClient);
  registerDeleteTool(server, db);

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

describe('delete', () => {
  it('removes the fact from both tables, get, and search', async () => {
    const id = await save('to be forgotten');

    const deleteResult = await client.callTool({ name: 'delete', arguments: { id } });
    expect(deleteResult.isError).toBeFalsy();

    expect(db.prepare('SELECT id FROM facts WHERE id = ?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM vec_facts WHERE id = ?').get(id)).toBeUndefined();

    const getResult = await client.callTool({ name: 'get', arguments: { id } });
    expect(getResult.isError).toBe(true);

    const searchResult = await client.callTool({
      name: 'search',
      arguments: { query: 'to be forgotten' },
    });
    const content = searchResult.content as { type: string; text: string }[];
    const results = JSON.parse(content[0]?.text ?? '[]') as { id: string }[];
    expect(results.map((r) => r.id)).not.toContain(id);
  });

  it('returns an explicit error for an unknown id rather than a silent success', async () => {
    const result = await client.callTool({
      name: 'delete',
      arguments: { id: 'does-not-exist' },
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a missing id with a Zod validation error', async () => {
    const result = await client.callTool({ name: 'delete', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
