import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  DB_PATH,
  EMBEDDING_API_KEY,
  EMBEDDING_BASE_URL,
  EMBEDDING_DOCUMENT_PREFIX,
  EMBEDDING_MODEL,
  EMBEDDING_QUERY_PREFIX,
  EMBEDDING_SOCKET_PATH,
  HA_API_URL,
  MANUALS_DIR,
  MCP_PORT,
  UI_ALLOWED_ADDRESS,
  UI_PORT,
  SUPERVISOR_TOKEN,
  USERS_DIR,
} from './config.js';
import { openDb } from './db/client.js';
import { HttpEmbeddingClient } from './embedding/client.js';
import { logError } from './log.js';
import { ManualIndexer } from './manuals/indexer.js';
import { registerDeleteTool } from './tools/delete.js';
import { registerGetTool } from './tools/get.js';
import { registerSaveTool } from './tools/save.js';
import { registerSearchTool } from './tools/search.js';
import { registerSimilarTool } from './tools/similar.js';
import { registerUpdateTool } from './tools/update.js';
import { createUiServer } from './ui/server.js';
import { HomeAssistantUsers, NO_USERS } from './users.js';

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const embeddingClient = new HttpEmbeddingClient({
  baseUrl: EMBEDDING_BASE_URL,
  socketPath: EMBEDDING_SOCKET_PATH,
  apiKey: EMBEDDING_API_KEY,
  model: EMBEDDING_MODEL,
  queryPrefix: EMBEDDING_QUERY_PREFIX,
  documentPrefix: EMBEDDING_DOCUMENT_PREFIX,
});
const indexer = new ManualIndexer(db, embeddingClient, MANUALS_DIR, undefined, USERS_DIR);
const users = SUPERVISOR_TOKEN ? new HomeAssistantUsers(HA_API_URL, SUPERVISOR_TOKEN) : NO_USERS;

function createMcpServer(): McpServer {
  const server = new McpServer({
    // Surfaced to clients in the initialize response — this is the name Home
    // Assistant shows for the MCP server, so keep it matching config.yaml's
    // `name`, not the npm package name.
    name: 'Memory',
    version: '0.1.0',
  });

  registerSearchTool(server, db, embeddingClient, users);
  registerSaveTool(server, db, embeddingClient, users);
  registerGetTool(server, db, users);
  registerUpdateTool(server, db, embeddingClient, users);
  registerSimilarTool(server, db, users);
  registerDeleteTool(server, db, users);

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }

  try {
    // Stateless mode (sessionIdGenerator: undefined): a fresh server+transport
    // pair per request, since a McpServer instance can only ever connect to
    // one transport (matches the SDK's own stateless example).
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    res.on('close', () => {
      transport.close();
      void server.close();
    });
  } catch (error) {
    logError('mcp-request', error);
    if (!res.headersSent) {
      res.writeHead(500).end();
    }
  }
});

httpServer.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`mcp-server listening on 0.0.0.0:${MCP_PORT} (/mcp)`);
});

const uiServer = createUiServer({
  db,
  embeddingClient,
  indexer,
  manualsDir: MANUALS_DIR,
  usersDir: USERS_DIR,
  allowedAddress: UI_ALLOWED_ADDRESS,
});

uiServer.listen(UI_PORT, '0.0.0.0', () => {
  console.log(`ui listening on 0.0.0.0:${UI_PORT}`);
});

// In the background: the MCP server is usable at once, and a large first
// index (or a re-index after a model change) only delays manual search.
void indexer
  .sync()
  .then((result) => {
    if (!result.dirFound) {
      console.log(
        `[manuals] ${MANUALS_DIR} not found — put PDF manuals there to make them searchable`,
      );
      return;
    }
    console.log(
      `[manuals] indexed: ${result.added} added, ${result.updated} updated, ` +
        `${result.moved} moved, ${result.removed} removed, ${result.unchanged} unchanged, ` +
        `${result.duplicates.length} duplicates skipped, ${result.failed.length} failed`,
    );
  })
  .catch((error: unknown) => logError('manual-index', error));

function shutdown(): void {
  uiServer.close();
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
