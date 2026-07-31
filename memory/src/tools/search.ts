import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { getFactsByIds } from '../db/facts.js';
import { knnSearch } from '../db/vector.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError, logToolCall } from '../log.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchFactsSchema } from './schemas.js';

/**
 * sqlite-vec KNN doesn't compose safely with an arbitrary WHERE pre-filter,
 * so we over-fetch candidates and filter by tags in the application layer
 * (tags ANY-match) before truncating to the requested limit. Fine at
 * personal scale (hundreds-thousands of facts) — see tasks/plan.md Open
 * Questions for the large-scale caveat.
 */
const CANDIDATE_FLOOR = 50;
const CANDIDATE_MULTIPLIER = 10;

export function registerSearchTool(
  server: McpServer,
  db: DbConnection,
  embeddingClient: EmbeddingClient,
): void {
  server.registerTool(
    'search',
    {
      description:
        'Search saved facts by meaning rather than keywords, optionally filtered by ' +
        'tags. Phrase `query` as the information you are looking for; it may be in ' +
        'any language, since matching works across languages.',
      inputSchema: searchFactsSchema,
    },
    async ({ query, filter, limit }) => {
      const resolvedLimit = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      logToolCall('search', {
        queryLength: query.length,
        limit: resolvedLimit,
        tagFilterCount: filter?.tags?.length,
      });

      try {
        const embedding = await embeddingClient.embed(query);
        const candidateK = Math.max(resolvedLimit * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR);
        const matches = knnSearch(db, embedding, candidateK);

        const factsById = new Map(getFactsByIds(db, matches.map((m) => m.id)).map((f) => [f.id, f]));
        const filterTags = filter?.tags;

        const results = matches
          .flatMap((match) => {
            const fact = factsById.get(match.id);
            if (!fact) return [];
            if (filterTags && filterTags.length > 0 && !filterTags.some((t) => fact.tags.includes(t))) {
              return [];
            }
            return [{ ...fact, distance: match.distance }];
          })
          .slice(0, resolvedLimit);

        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        logError('search', error);
        throw error;
      }
    },
  );
}
