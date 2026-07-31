import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { FactNotFoundError, getFact, updateFact } from '../db/facts.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError, logToolCall } from '../log.js';
import { updateFactSchema } from './schemas.js';

export function registerUpdateTool(
  server: McpServer,
  db: DbConnection,
  embeddingClient: EmbeddingClient,
): void {
  server.registerTool(
    'update',
    {
      description:
        'Update a fact\'s content and/or tags. Keep `content` in the language the ' +
        'user used — do not translate it. Re-embeds only when content actually changes.',
      inputSchema: updateFactSchema,
    },
    async ({ id, fact }) => {
      logToolCall('update', {
        id,
        contentProvided: fact.content !== undefined,
        tagsProvided: fact.tags !== undefined,
      });

      try {
        const existing = getFact(db, id);
        if (!existing) {
          throw new FactNotFoundError(id);
        }

        const nextContent = fact.content ?? existing.content;
        const nextTags = fact.tags ?? existing.tags;
        const contentChanged = fact.content !== undefined && fact.content !== existing.content;

        const embedding = contentChanged ? await embeddingClient.embed(nextContent) : undefined;

        const updated = updateFact(db, {
          id,
          content: nextContent,
          tags: nextTags,
          embedding,
          now: new Date().toISOString(),
        });

        return { content: [{ type: 'text', text: JSON.stringify(updated) }] };
      } catch (error) {
        logError('update', error);
        throw error;
      }
    },
  );
}
