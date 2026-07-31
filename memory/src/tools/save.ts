import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { insertFact } from '../db/facts.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError, logToolCall } from '../log.js';
import { saveFactSchema } from './schemas.js';

export function registerSaveTool(
  server: McpServer,
  db: DbConnection,
  embeddingClient: EmbeddingClient,
): void {
  server.registerTool(
    'save',
    {
      description:
        'Save a fact to memory for later semantic recall. Write `content` as one ' +
        'complete, self-contained sentence that still makes sense on its own months ' +
        'later. Keep it in the language the user used — do not translate it. Use ' +
        '`tags` for a few broad topic labels, not for words already in the content.',
      inputSchema: saveFactSchema,
    },
    async ({ content, tags }) => {
      const resolvedTags = tags ?? [];
      logToolCall('save', { contentLength: content.length, tagCount: resolvedTags.length });

      try {
        const embedding = await embeddingClient.embed(content);
        const fact = insertFact(db, {
          id: randomUUID(),
          content,
          tags: resolvedTags,
          embedding,
          now: new Date().toISOString(),
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ id: fact.id }) }],
        };
      } catch (error) {
        logError('save', error);
        throw error;
      }
    },
  );
}
