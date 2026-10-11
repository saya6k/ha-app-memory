import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DbConnection } from '../db/client.js';
import { listManuals } from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { logError, logToolCall } from '../log.js';
import { searchManuals } from '../manuals/search.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchManualsSchema } from './schemas.js';

export function registerSearchManualsTool(
  server: McpServer,
  db: DbConnection,
  embeddingClient: EmbeddingClient,
): void {
  server.registerTool(
    'search_manuals',
    {
      description:
        "Search the household's appliance and device manuals by meaning. Use it for " +
        'how to operate, clean, maintain or troubleshoot a device, or what an error ' +
        'code means. Name the device in `query` when you know it. Each result is a ' +
        'passage with its manual and its page (PDF) or section (Markdown); answer from ' +
        'the passages and cite the manual and page or section.',
      inputSchema: searchManualsSchema,
    },
    async ({ query, limit }) => {
      const resolvedLimit = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      logToolCall('search_manuals', { queryLength: query.length, limit: resolvedLimit });

      try {
        const matches = await searchManuals(db, embeddingClient, query, resolvedLimit);
        const results = matches.map((m) => ({
          manual: m.title,
          file: m.path,
          ...(m.format === 'pdf' ? { page: m.page } : { section: m.section ?? undefined }),
          content: m.content,
          distance: m.distance,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        logError('search_manuals', error);
        throw error;
      }
    },
  );
}

export function registerListManualsTool(server: McpServer, db: DbConnection): void {
  server.registerTool(
    'list_manuals',
    {
      description:
        'List the appliance and device manuals available to search_manuals. A manual ' +
        'with `searchable: false` has no text (typically a scanned PDF) and never ' +
        'appears in search results.',
    },
    async () => {
      logToolCall('list_manuals', {});

      try {
        const manuals = listManuals(db).map((m) => ({
          manual: m.title,
          file: m.path,
          format: m.format,
          ...(m.format === 'pdf' ? { pages: m.pageCount } : {}),
          searchable: m.chunkCount > 0,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(manuals) }] };
      } catch (error) {
        logError('list_manuals', error);
        throw error;
      }
    },
  );
}
