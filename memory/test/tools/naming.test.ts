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
import { registerSimilarTool } from '../../src/tools/similar.js';
import { registerUpdateTool } from '../../src/tools/update.js';

/**
 * OpenAI rejects the whole request with HTTP 400 if any tool name falls outside
 * this pattern — notably it excludes `.`, which the original `memory.save`
 * naming used. Home Assistant forwards MCP tool names straight through as
 * function names, so one bad name breaks every conversation turn, not just ours.
 *
 * The names are deliberately bare: Home Assistant namespaces them by server, so
 * `search` reaches the model as `memory__search`. Prefixing them here as well
 * produced `memory__memory_search`.
 */
const OPENAI_FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/;

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
  const embedding = fakeEmbeddingClient();
  registerSaveTool(server, db, embedding);
  registerGetTool(server, db);
  registerSearchTool(server, db, embedding);
  registerUpdateTool(server, db, embedding);
  registerSimilarTool(server, db);
  registerDeleteTool(server, db);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tool naming', () => {
  it('exposes exactly the six documented tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['delete', 'get', 'save', 'search', 'similar', 'update']);
  });

  it('every tool name is accepted by OpenAI function-calling', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of names) {
      expect(name, `${name} must match ${String(OPENAI_FUNCTION_NAME)}`).toMatch(
        OPENAI_FUNCTION_NAME,
      );
    }
  });
});
