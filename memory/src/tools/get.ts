import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { FactNotFoundError, getFact } from '../db/facts.js';
import { logError, logToolCall } from '../log.js';
import { getFactSchema } from './schemas.js';

export function registerGetTool(server: McpServer, db: DbConnection): void {
  server.registerTool(
    'get',
    {
      description: 'Retrieve a single fact by id.',
      inputSchema: getFactSchema,
    },
    async ({ id }) => {
      logToolCall('get', { id });

      try {
        const fact = getFact(db, id);
        if (!fact) {
          throw new FactNotFoundError(id);
        }

        return { content: [{ type: 'text', text: JSON.stringify(fact) }] };
      } catch (error) {
        logError('get', error);
        throw error;
      }
    },
  );
}
