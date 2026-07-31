import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { deleteFact } from '../db/facts.js';
import { logError, logToolCall } from '../log.js';
import { deleteFactSchema } from './schemas.js';

export function registerDeleteTool(server: McpServer, db: DbConnection): void {
  server.registerTool(
    'delete',
    {
      description: 'Permanently delete a single fact by id.',
      inputSchema: deleteFactSchema,
    },
    async ({ id }) => {
      logToolCall('delete', { id });

      try {
        deleteFact(db, id);
        return { content: [{ type: 'text', text: JSON.stringify({ id, deleted: true }) }] };
      } catch (error) {
        logError('delete', error);
        throw error;
      }
    },
  );
}
