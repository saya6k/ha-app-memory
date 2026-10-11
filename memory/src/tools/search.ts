import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError, logToolCall } from '../log.js';
import { searchAll } from '../search.js';
import type { UserDirectory } from '../users.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchFactsSchema } from './schemas.js';
import { scopeFor } from './scope.js';

/**
 * The one lookup tool: remembered facts, the shared appliance manuals and the
 * user's personal documents, ranked together (see searchAll).
 */
export function registerSearchTool(
  server: McpServer,
  db: DbConnection,
  embeddingClient: EmbeddingClient,
  users: UserDirectory,
): void {
  server.registerTool(
    'search',
    {
      description:
        "Look things up in the household's knowledge: what has been remembered, the " +
        "appliance and device manuals, and the user's own documents. Use it first " +
        'whenever the user asks you to find, check or recall something, asks what ' +
        'they told you, or asks how to operate, clean or fix a device or what an ' +
        'error code means. Matching is by meaning and works across languages, so ' +
        'phrase `query` as the information wanted. Pass `user`. Each result has a ' +
        '`type`: "memory" (a remembered fact; `personal` says whose), "manual" or ' +
        '"document" (a passage, with its `page` or `section` to cite).',
      inputSchema: searchFactsSchema,
    },
    async ({ query, user, filter, limit }) => {
      const resolvedLimit = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      logToolCall('search', {
        queryLength: query.length,
        limit: resolvedLimit,
        tagFilterCount: filter?.tags?.length,
        user: user !== undefined,
      });

      try {
        const scope = await scopeFor(users, user);
        const hits = await searchAll(db, embeddingClient, {
          query,
          limit: resolvedLimit,
          owners: scope.owners,
          tags: filter?.tags,
        });
        // The panel needs a passage's manual id and format; the model does not,
        // and an id there could be mistaken for a fact id to pass to get.
        const results = hits.map((hit) =>
          hit.type === 'memory'
            ? hit
            : {
                type: hit.type,
                title: hit.title,
                file: hit.file,
                page: hit.page,
                section: hit.section,
                content: hit.content,
                distance: hit.distance,
              },
        );
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        logError('search', error);
        throw error;
      }
    },
  );
}
