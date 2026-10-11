import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import { searchFactsSchema, similarFactsSchema } from '../../src/tools/schemas.js';

describe('tool limit schemas', () => {
  it.each([
    ['search', searchFactsSchema],
    ['similar', similarFactsSchema],
  ] as const)(
    '%s exposes an inclusive minimum for HA schema conversion',
    async (name, inputSchema) => {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      server.registerTool(name, { inputSchema }, async () => ({ content: [] }));
      const client = new Client({ name: 'test-client', version: '0.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([client.connect(a), server.connect(b)]);
        const [tool] = (await client.listTools()).tools;
        if (!tool) throw new Error(`Missing tool: ${name}`);
        // Avoid exclusive bounds: HA's schema round-trip can emit booleans
        // for these keywords, which OpenAI rejects.
        expect(tool.inputSchema.properties?.limit).toEqual({ type: 'integer', minimum: 1 });
        expect(tool.inputSchema.required).not.toContain('limit');
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it.each([searchFactsSchema, similarFactsSchema])(
    'preserves positive integer validation',
    (schema) => {
      for (const value of [undefined, 1, 20, 999]) {
        expect(schema.limit.safeParse(value).success).toBe(true);
      }
      for (const value of [0, -1, 1.5, true]) {
        expect(schema.limit.safeParse(value).success).toBe(false);
      }
    },
  );
});
