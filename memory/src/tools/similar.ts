import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { FactNotFoundError, getFact, getFactsByIds } from '../db/facts.js';
import { getEmbedding, knnSearch } from '../db/vector.js';
import { logError, logToolCall } from '../log.js';
import type { UserDirectory } from '../users.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, similarFactsSchema } from './schemas.js';
import { canSee, presentFact, scopeFor } from './scope.js';

/** Over-fetch, since other people's personal facts are dropped after the KNN. */
const CANDIDATE_FLOOR = 50;

export function registerSimilarTool(
  server: McpServer,
  db: DbConnection,
  users: UserDirectory,
): void {
  server.registerTool(
    'similar',
    {
      description: 'Find remembered facts similar in meaning to an existing one, excluding itself.',
      inputSchema: similarFactsSchema,
    },
    async ({ id, user, limit }) => {
      const resolvedLimit = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      logToolCall('similar', { id, limit: resolvedLimit, user: user !== undefined });

      try {
        const scope = await scopeFor(users, user);
        const source = getFact(db, id);
        if (!source || !canSee(scope, source.owner)) {
          throw new FactNotFoundError(id);
        }

        // Reuse the fact's existing embedding — no re-embed call needed.
        const embedding = getEmbedding(db, id);
        if (!embedding) {
          throw new FactNotFoundError(id);
        }

        const matches = knnSearch(db, embedding, Math.max(resolvedLimit * 10, CANDIDATE_FLOOR), id);
        const factsById = new Map(getFactsByIds(db, matches.map((m) => m.id)).map((f) => [f.id, f]));

        const results = matches
          .flatMap((match) => {
            const fact = factsById.get(match.id);
            return fact && canSee(scope, fact.owner) ? [{ ...fact, distance: match.distance }] : [];
          })
          .slice(0, resolvedLimit);

        return { content: [{ type: 'text', text: JSON.stringify(results.map(presentFact)) }] };
      } catch (error) {
        logError('similar', error);
        throw error;
      }
    },
  );
}
