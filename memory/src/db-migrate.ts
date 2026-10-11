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

import { DB_PATH, EMBEDDING_MODEL_ID } from './config.js';
import { migrate } from './db/migrate.js';
import { configuredEmbeddingClient } from './embedding/configured.js';
import { EmbeddingError, type EmbeddingClient } from './embedding/types.js';

mkdirSync(dirname(DB_PATH), { recursive: true });

/** How long to wait for a service that is up but not ready, e.g. still loading its model. */
const STARTUP_WAIT_MS = 5 * 60_000;
const STARTUP_RETRY_MS = 5_000;

/**
 * One embedding up front, so a rejected key, a missing model or one of the
 * wrong width stops the add-on now, with the reason, rather than at the first
 * save or search. A service that is only not ready yet (unreachable, 429, 5xx)
 * is waited for, up to STARTUP_WAIT_MS.
 */
async function checkEmbeddings(client: EmbeddingClient): Promise<void> {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      await client.embed('Startup check.', 'document');
      if (announced) console.log('[db-migrate] the embedding service is ready');
      return;
    } catch (error) {
      if (!(error instanceof EmbeddingError) || !error.transient || Date.now() > deadline) {
        throw error;
      }
      if (!announced) {
        console.log(`[db-migrate] waiting for the embedding service: ${error.message}`);
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, STARTUP_RETRY_MS));
    }
  }
}

let lastReported = 0;

try {
  // Inside the try: a missing setting stops the add-on here, with the reason.
  const client = configuredEmbeddingClient();
  await checkEmbeddings(client);
  const result = await migrate(DB_PATH, client, (done, total) => {
    // One line per 10%, so a large memory shows progress without flooding.
    const step = Math.max(1, Math.ceil(total / 10));
    if (done === total || done - lastReported >= step) {
      lastReported = done;
      console.log(`[db-migrate] re-embedded ${done}/${total} facts`);
    }
  });

  if (result.status === 'up-to-date') {
    console.log(`[db-migrate] up to date (${result.factCount} facts, model ${EMBEDDING_MODEL_ID})`);
  } else {
    console.log(
      `[db-migrate] migrated ${result.factCount} facts — ${result.reason ?? 'reason unknown'}`,
    );
    if (result.manualCount > 0) {
      console.log(
        `[db-migrate] ${result.manualCount} manuals will be re-indexed in the background`,
      );
    }
  }
} catch (error) {
  console.error(`[db-migrate] ${error instanceof Error ? error.message : String(error)}`);
  console.error('[db-migrate] the database was left unchanged.');
  process.exit(1);
}
