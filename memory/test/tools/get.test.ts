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
  registerSaveTool(server, db, fakeEmbeddingClient());
  registerGetTool(server, db);

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

describe('get', () => {
  it('round-trips a fact saved via save, including tags and timestamps', async () => {
    const id = await save('paris is the capital of france', ['geography']);

    const result = await client.callTool({ name: 'get', arguments: { id } });
    expect(result.isError).toBeFalsy();

    const content = result.content as { type: string; text: string }[];
    const fact = JSON.parse(content[0]?.text ?? '{}') as {
      id: string;
      content: string;
      tags: string[];
      createdAt: string;
      updatedAt: string;
    };

    expect(fact.id).toBe(id);
    expect(fact.content).toBe('paris is the capital of france');
    expect(fact.tags).toEqual(['geography']);
    expect(fact.createdAt).toBeTruthy();
    expect(fact.updatedAt).toBeTruthy();
  });

  it('returns an explicit error for an unknown id rather than failing silently', async () => {
    const result = await client.callTool({
      name: 'get',
      arguments: { id: 'does-not-exist' },
    });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain('does-not-exist');
  });

  it('rejects a missing id with a Zod validation error', async () => {
    const result = await client.callTool({ name: 'get', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
