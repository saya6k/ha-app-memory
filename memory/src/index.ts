import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  DB_PATH,
  EMBEDDING_API_KEY,
  EMBEDDING_BASE_URL,
  EMBEDDING_MODEL,
  EMBEDDING_SOCKET_PATH,
  MCP_PORT,
} from './config.js';
import { openDb } from './db/client.js';
import { HttpEmbeddingClient } from './embedding/client.js';
import { logError } from './log.js';
import { registerDeleteTool } from './tools/delete.js';
import { registerGetTool } from './tools/get.js';
import { registerSaveTool } from './tools/save.js';
import { registerSearchTool } from './tools/search.js';
import { registerSimilarTool } from './tools/similar.js';
import { registerUpdateTool } from './tools/update.js';

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const embeddingClient = new HttpEmbeddingClient({
  baseUrl: EMBEDDING_BASE_URL,
  socketPath: EMBEDDING_SOCKET_PATH,
  apiKey: EMBEDDING_API_KEY,
  model: EMBEDDING_MODEL,
});

function createMcpServer(): McpServer {
  const server = new McpServer({
    // Surfaced to clients in the initialize response — this is the name Home
    // Assistant shows for the MCP server, so keep it matching config.yaml's
    // `name`, not the npm package name.
    name: 'Memory',
    version: '0.1.0',
  });

  registerSaveTool(server, db, embeddingClient);
  registerGetTool(server, db);
  registerSearchTool(server, db, embeddingClient);
  registerUpdateTool(server, db, embeddingClient);
  registerSimilarTool(server, db);
  registerDeleteTool(server, db);

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

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
