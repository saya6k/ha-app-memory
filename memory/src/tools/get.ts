import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { FactNotFoundError, getFact } from '../db/facts.js';
import { logError, logToolCall } from '../log.js';
import type { UserDirectory } from '../users.js';
import { getFactSchema } from './schemas.js';
import { canSee, presentFact, scopeFor } from './scope.js';

export function registerGetTool(server: McpServer, db: DbConnection, users: UserDirectory): void {
  server.registerTool(
    'get',
    {
      description: 'Retrieve a single remembered fact by id.',
      inputSchema: getFactSchema,
    },
    async ({ id, user }) => {
      logToolCall('get', { id, user: user !== undefined });

      try {
        const scope = await scopeFor(users, user);
        const fact = getFact(db, id);
        // Someone else's personal fact is reported as missing, not as forbidden.
        if (!fact || !canSee(scope, fact.owner)) {
          throw new FactNotFoundError(id);
        }

        return { content: [{ type: 'text', text: JSON.stringify(presentFact(fact)) }] };
      } catch (error) {
        logError('get', error);
        throw error;
      }
    },
  );
}
