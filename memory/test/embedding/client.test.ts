import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpEmbeddingClient } from '../../src/embedding/client.js';
import { EmbeddingError } from '../../src/embedding/types.js';

let server: Server;
let baseUrl: string;
let requestCount: number;
let lastAuthHeader: string | undefined;
let lastRequestBody: unknown;
let handler: (count: number) => { status: number; body: unknown };

beforeEach(async () => {
  requestCount = 0;
  lastAuthHeader = undefined;
  lastRequestBody = undefined;
  handler = () => ({ status: 200, body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });

  server = createServer((req, res) => {
    requestCount += 1;
    lastAuthHeader = req.headers.authorization;
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/embeddings');
      expect(() => {
        lastRequestBody = JSON.parse(raw);
      }).not.toThrow();

      const { status, body } = handler(requestCount);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('EmbeddingClient', () => {
  it('sends the OpenAI-compatible /v1/embeddings contract and returns the vector', async () => {
    const client = new HttpEmbeddingClient({
      baseUrl,
      model: 'Qwen3-Embedding-0.6B',
      maxRetries: 0,
    });
    const embedding = await client.embed('hello world');
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(requestCount).toBe(1);
  });

  it('omits Authorization entirely for the unauthenticated local sidecar', async () => {
    const client = new HttpEmbeddingClient({
      baseUrl,
      model: 'Qwen3-Embedding-0.6B',
      maxRetries: 0,
    });
    await client.embed('hello world');

    expect(lastAuthHeader).toBeUndefined();
    expect(lastRequestBody).toMatchObject({
      input: 'hello world',
      model: 'Qwen3-Embedding-0.6B',
    });
  });

  it('sends the api key as a Bearer token when one is configured (external API escape hatch)', async () => {
    const client = new HttpEmbeddingClient({
      baseUrl,
      apiKey: 'sk-secret-123',
      model: 'text-embedding-3-large',
      maxRetries: 0,
    });
    await client.embed('hello world');

    expect(lastAuthHeader).toBe('Bearer sk-secret-123');
    expect(lastRequestBody).toMatchObject({
      input: 'hello world',
      model: 'text-embedding-3-large',
    });
  });

  it('retries transient failures and succeeds once the API recovers', async () => {
    handler = (count) =>
      count < 3
        ? { status: 500, body: { error: 'not ready' } }
        : { status: 200, body: { data: [{ embedding: [1, 2, 3] }] } };

    const client = new HttpEmbeddingClient({
      baseUrl,
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      maxRetries: 3,
      retryDelayMs: 1,
    });
    const embedding = await client.embed('retry me');

    expect(embedding).toEqual([1, 2, 3]);
    expect(requestCount).toBe(3);
  });

  it('connects over a unix domain socket when socketPath is set', async () => {
    // The add-on dials the sidecar this way so that "never network-reachable"
    // is structural, not a --host convention (SPEC §8 Never).
    const dir = mkdtempSync(join(tmpdir(), 'ha-memory-sock-'));
    const socketPath = join(dir, 'embed.sock');
    const unixServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [9, 8, 7] }] }));
    });
    await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));

    try {
      const client = new HttpEmbeddingClient({
        baseUrl: 'http://localhost',
        socketPath,
        model: 'Qwen3-Embedding-0.6B',
        maxRetries: 0,
      });
      await expect(client.embed('over a socket')).resolves.toEqual([9, 8, 7]);
    } finally {
      await new Promise<void>((resolve) => unixServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear EmbeddingError (never silent) once retries are exhausted', async () => {
    handler = () => ({ status: 500, body: { error: 'permanently down' } });

    const client = new HttpEmbeddingClient({
      baseUrl,
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      maxRetries: 2,
      retryDelayMs: 1,
    });

    await expect(client.embed('will fail')).rejects.toThrow(EmbeddingError);
    expect(requestCount).toBe(3); // initial attempt + 2 retries
  });
});
