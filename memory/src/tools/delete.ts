import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { deleteFact, FactNotFoundError, getFact } from '../db/facts.js';
import { logError, logToolCall } from '../log.js';
import type { UserDirectory } from '../users.js';
import { deleteFactSchema } from './schemas.js';
import { canSee, scopeFor } from './scope.js';

export function registerDeleteTool(
  server: McpServer,
  db: DbConnection,
  users: UserDirectory,
): void {
  server.registerTool(
    'delete',
    {
      description: 'Permanently delete a single remembered fact by id.',
      inputSchema: deleteFactSchema,
    },
    async ({ id, user }) => {
      logToolCall('delete', { id, user: user !== undefined });

      try {
        const scope = await scopeFor(users, user);
        const fact = getFact(db, id);
        if (!fact || !canSee(scope, fact.owner)) throw new FactNotFoundError(id);
        deleteFact(db, id);
        return { content: [{ type: 'text', text: JSON.stringify({ id, deleted: true }) }] };
      } catch (error) {
        logError('delete', error);
        throw error;
      }
    },
  );
}
