/**
 * Startup migration, run as a s6 oneshot before mcp-server.
 *
 * Vectors from a different embedding model — or of a different width — are not
 * comparable with the stored ones, so rather than refusing to start, re-embed
 * every fact from its content. Runs after llama-server, since it needs the
 * sidecar to produce the new vectors.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  DB_PATH,
  EMBEDDING_API_KEY,
  EMBEDDING_BASE_URL,
  EMBEDDING_MODEL,
  EMBEDDING_SOCKET_PATH,
} from './config.js';
import { migrate } from './db/migrate.js';
import { HttpEmbeddingClient } from './embedding/client.js';

mkdirSync(dirname(DB_PATH), { recursive: true });

const client = new HttpEmbeddingClient({
  baseUrl: EMBEDDING_BASE_URL,
  socketPath: EMBEDDING_SOCKET_PATH,
  apiKey: EMBEDDING_API_KEY,
  model: EMBEDDING_MODEL,
});

let lastReported = 0;

try {
  const result = await migrate(DB_PATH, client, (done, total) => {
    // One line per 10%, so a large memory shows progress without flooding.
    const step = Math.max(1, Math.ceil(total / 10));
    if (done === total || done - lastReported >= step) {
      lastReported = done;
      console.log(`[db-migrate] re-embedded ${done}/${total} facts`);
    }
  });

  if (result.status === 'up-to-date') {
    console.log(`[db-migrate] up to date (${result.factCount} facts, model ${EMBEDDING_MODEL})`);
  } else {
    console.log(
      `[db-migrate] migrated ${result.factCount} facts — ${result.reason ?? 'reason unknown'}`,
    );
  }
} catch (error) {
  console.error(`[db-migrate] ${error instanceof Error ? error.message : String(error)}`);
  console.error('[db-migrate] the database was left unchanged.');
  process.exit(1);
}
