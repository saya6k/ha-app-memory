import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { insertFact } from '../db/facts.js';
import { SHARED } from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError, logToolCall } from '../log.js';
import type { UserDirectory } from '../users.js';
import { saveFactSchema } from './schemas.js';
import { scopeFor } from './scope.js';

export function registerSaveTool(
  server: McpServer,
  db: DbConnection,
  embeddingClient: EmbeddingClient,
  users: UserDirectory,
): void {
  server.registerTool(
    'save',
    {
      description:
        'Remember something for later. Write `content` as one complete, ' +
        'self-contained sentence that still makes sense on its own months later. ' +
        'Keep it in the language the user used — do not translate it. Use `tags` ' +
        'for a few broad topic labels, not for words already in the content. Pass ' +
        "`user`; it is kept as that person's own unless `shared` is true.",
      inputSchema: saveFactSchema,
    },
    async ({ content, tags, user, shared }) => {
      const resolvedTags = tags ?? [];
      logToolCall('save', {
        contentLength: content.length,
        tagCount: resolvedTags.length,
        user: user !== undefined,
        shared,
      });

      try {
        const scope = await scopeFor(users, user);
        const embedding = await embeddingClient.embed(content, 'document');
        const fact = insertFact(db, {
          id: randomUUID(),
          owner: shared || !scope.userId ? SHARED : scope.userId,
          content,
          tags: resolvedTags,
          embedding,
          now: new Date().toISOString(),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: fact.id, shared: fact.owner === SHARED }),
            },
          ],
        };
      } catch (error) {
        logError('save', error);
        throw error;
      }
    },
  );
}
