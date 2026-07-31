import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { FactNotFoundError, getFact, getFactsByIds } from '../db/facts.js';
import { getEmbedding, knnSearch } from '../db/vector.js';
import { logError, logToolCall } from '../log.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, similarFactsSchema } from './schemas.js';

export function registerSimilarTool(server: McpServer, db: DbConnection): void {
  server.registerTool(
    'similar',
    {
      description: 'Find facts semantically similar to an existing fact, excluding itself.',
      inputSchema: similarFactsSchema,
    },
    async ({ id, limit }) => {
      const resolvedLimit = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      logToolCall('similar', { id, limit: resolvedLimit });

      try {
        if (!getFact(db, id)) {
          throw new FactNotFoundError(id);
        }

        // Reuse the fact's existing embedding — no re-embed call needed.
        const embedding = getEmbedding(db, id);
        if (!embedding) {
          throw new FactNotFoundError(id);
        }

        const matches = knnSearch(db, embedding, resolvedLimit, id);
        const factsById = new Map(getFactsByIds(db, matches.map((m) => m.id)).map((f) => [f.id, f]));

        const results = matches.flatMap((match) => {
          const fact = factsById.get(match.id);
          return fact ? [{ ...fact, distance: match.distance }] : [];
        });

        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        logError('similar', error);
        throw error;
      }
    },
  );
}
