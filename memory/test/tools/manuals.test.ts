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
import type { EmbeddingClient, EmbeddingKind } from '../../src/embedding/types.js';
import { registerListManualsTool, registerSearchManualsTool } from '../../src/tools/manuals.js';

let dir: string;
let db: DbConnection;
let client: Client;
let queryKinds: EmbeddingKind[];

/** Unit vector at `angleDeg` in the first two dimensions; see search.test.ts. */
function angled(angleDeg: number): number[] {
  const rad = (angleDeg * Math.PI) / 180;
  const vec = new Array(EMBEDDING_DIMENSIONS).fill(0) as number[];
  vec[0] = Math.cos(rad);
  vec[1] = Math.sin(rad);
  return vec;
}

const embedding: EmbeddingClient = {
  async embed(_text, kind) {
    queryKinds.push(kind);
    return angled(0);
  },
};

function addManual(
  id: string,
  title: string,
  chunks: { page: number; section?: string; content: string; angle: number }[],
  format: 'pdf' | 'markdown' = 'pdf',
) {
  replaceManual(
    db,
    {
      id,
      path: `${title}.${format === 'pdf' ? 'pdf' : 'md'}`,
      title,
      format,
      sha256: `${id}-${chunks.map((c) => c.content).join()}`,
      size: 1,
      mtimeMs: 1,
      pageCount: Math.max(1, ...chunks.map((c) => c.page)),
      indexedAt: '2026-01-01T00:00:00.000Z',
    },
    chunks.map((c) => ({
      page: c.page,
      section: c.section,
      content: c.content,
      embedding: angled(c.angle),
    })),
  );
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  const [first] = result.content as { text: string }[];
  return JSON.parse(first?.text ?? 'null');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-test-'));
  db = openDb(join(dir, 'facts.sqlite'));
  queryKinds = [];

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSearchManualsTool(server, db, embedding);
  registerListManualsTool(server, db);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('search_manuals', () => {
  it('returns the nearest passages with their manual and page, nearest first', async () => {
    addManual('w', 'Washer', [
      { page: 3, content: '통세척 방법', angle: 10 },
      { page: 7, content: 'E3 배수 필터', angle: 60 },
    ]);
    addManual('o', 'Oven', [{ page: 2, content: 'Preheat', angle: 30 }]);

    const results = (await call('search_manuals', { query: '통세척', limit: 2 })) as {
      manual: string;
      file: string;
      page: number;
      content: string;
    }[];

    expect(results.map((r) => [r.manual, r.file, r.page, r.content])).toEqual([
      ['Washer', 'Washer.pdf', 3, '통세척 방법'],
      ['Oven', 'Oven.pdf', 2, 'Preheat'],
    ]);
    expect(queryKinds).toEqual(['query']);
  });

  it('cites a Markdown passage by its section instead of a page', async () => {
    addManual(
      'd',
      'Dryer',
      [{ page: 2, section: '필터 청소', content: '매번 비우세요', angle: 0 }],
      'markdown',
    );

    expect(await call('search_manuals', { query: 'lint' })).toMatchObject([
      { manual: 'Dryer', file: 'Dryer.md', section: '필터 청소', content: '매번 비우세요' },
    ]);
    const [hit] = (await call('search_manuals', { query: 'lint' })) as object[];
    expect(hit).not.toHaveProperty('page');
  });

  it("finds nothing in a re-indexed manual's old text", async () => {
    addManual('w', 'Washer', [{ page: 1, content: 'old', angle: 0 }]);
    addManual('w', 'Washer', [{ page: 1, content: 'new', angle: 0 }]);

    const results = (await call('search_manuals', { query: 'x' })) as { content: string }[];
    expect(results.map((r) => r.content)).toEqual(['new']);
  });
});

describe('list_manuals', () => {
  it('lists manuals and flags the ones without text', async () => {
    addManual('w', 'Washer', [{ page: 4, content: 'a', angle: 0 }]);
    addManual('s', 'Scanned dryer', []);

    addManual('m', 'Fridge', [{ page: 1, section: 'Ice', content: 'b', angle: 0 }], 'markdown');

    expect(await call('list_manuals')).toEqual([
      { manual: 'Fridge', file: 'Fridge.md', format: 'markdown', searchable: true },
      {
        manual: 'Scanned dryer',
        file: 'Scanned dryer.pdf',
        format: 'pdf',
        pages: 1,
        searchable: false,
      },
      { manual: 'Washer', file: 'Washer.pdf', format: 'pdf', pages: 4, searchable: true },
    ]);
  });
});
