import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEmbeddingClient,
  HttpEmbeddingClient,
  HuggingFaceEmbeddingClient,
  OllamaEmbeddingClient,
} from '../../src/embedding/client.js';
import { EmbeddingError } from '../../src/embedding/types.js';

/** One fake server per test; `reply` decides what it answers. */
let server: Server;
let base: string;
let requests: { url?: string; auth?: string; body: unknown }[];
let reply: (url: string) => unknown;

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(req.url ?? '')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('Ollama', () => {
  it('posts to /api/embed without truncation and reads embeddings[0]', async () => {
    reply = () => ({ model: 'embeddinggemma', embeddings: [[0.1, 0.2, 0.3]] });
    const client = new OllamaEmbeddingClient({
      baseUrl: base,
      model: 'embeddinggemma',
      queryPrefix: 'q: ',
      maxRetries: 0,
    });

    expect(await client.embed('hello', 'query')).toEqual([0.1, 0.2, 0.3]);
    expect(requests).toEqual([
      {
        url: '/api/embed',
        auth: undefined,
        body: { model: 'embeddinggemma', input: 'q: hello', truncate: false },
      },
    ]);
  });
});

describe('Hugging Face', () => {
  it('posts {inputs} to the URL as given, with the token', async () => {
    reply = () => [0.5, 0.5];
    const client = new HuggingFaceEmbeddingClient({
      baseUrl: `${base}/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction`,
      model: 'BAAI/bge-m3',
      apiKey: 'hf_x',
      maxRetries: 0,
    });

    expect(await client.embed('hello', 'document')).toEqual([0.5, 0.5]);
    expect(requests).toEqual([
      {
        url: '/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction',
        auth: 'Bearer hf_x',
        body: { inputs: 'hello' },
      },
    ]);
  });

  it('accepts a one-row answer, as Text Embeddings Inference gives', async () => {
    reply = () => [[0.5, 0.5]];
    const client = new HuggingFaceEmbeddingClient({ baseUrl: `${base}/embed`, model: 'm' });
    expect(await client.embed('hello', 'document')).toEqual([0.5, 0.5]);
  });

  it('refuses per-token embeddings from a model that is not a sentence-embedding model', async () => {
    reply = () => [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    const client = new HuggingFaceEmbeddingClient({
      baseUrl: `${base}/x`,
      model: 'm',
      maxRetries: 0,
    });
    await expect(client.embed('two tokens', 'document')).rejects.toThrow(/sentence-embedding/);
  });
});

describe('all providers', () => {
  it('report a model of the wrong width at once, naming the setting', async () => {
    reply = () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const client = new HttpEmbeddingClient({
      baseUrl: `${base}/v1`,
      model: 'text-embedding-3-small',
      dimensions: 768,
      retryDelayMs: 1,
    });

    await expect(client.embed('hello', 'document')).rejects.toThrow(
      'The embedding model returned 3 dimensions, but embedding_dimensions is 768. ' +
        'Set embedding_dimensions to 3.',
    );
    // A wrong width is a setting, not a passing failure: no retries.
    expect(requests).toHaveLength(1);
  });

  it('pick the client by provider', () => {
    const config = { baseUrl: base, model: 'm' };
    expect(createEmbeddingClient('local', config)).toBeInstanceOf(HttpEmbeddingClient);
    expect(createEmbeddingClient('openai', config)).toBeInstanceOf(HttpEmbeddingClient);
    expect(createEmbeddingClient('ollama', config)).toBeInstanceOf(OllamaEmbeddingClient);
    expect(createEmbeddingClient('huggingface', config)).toBeInstanceOf(HuggingFaceEmbeddingClient);
  });
});

describe('transient failures', () => {
  async function failureFor(status: number) {
    const failing = createServer((_req, res) => res.writeHead(status).end());
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const port = (failing.address() as AddressInfo).port;
    const client = new HttpEmbeddingClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'm',
      maxRetries: 0,
    });
    try {
      return await client.embed('x', 'document').then(
        () => undefined,
        (error: unknown) => error as EmbeddingError,
      );
    } finally {
      await new Promise((resolve) => failing.close(resolve));
    }
  }

  it('marks a busy or failing service as transient, so startup can wait for it', async () => {
    expect((await failureFor(503))?.transient).toBe(true);
    expect((await failureFor(429))?.transient).toBe(true);
  });

  it('does not mark a rejected request as transient', async () => {
    expect((await failureFor(401))?.transient).toBe(false);
    expect((await failureFor(404))?.transient).toBe(false);
  });

  it('marks a service that cannot be reached as transient', async () => {
    const client = new HttpEmbeddingClient({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'm',
      maxRetries: 0,
    });
    await expect(client.embed('x', 'document')).rejects.toMatchObject({ transient: true });
  });
});

describe('configuration', () => {
  const env = ['EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_BASE_URL'];
  afterEach(() => {
    for (const key of env) Reflect.deleteProperty(process.env, key);
    vi.resetModules();
  });

  async function configWith(vars: Record<string, string>) {
    vi.resetModules();
    for (const key of env) Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, vars);
    return import('../../src/config.js');
  }

  it('keeps the local model id unchanged, so existing databases still match', async () => {
    const config = await configWith({ EMBEDDING_MODEL: 'embeddinggemma-2-Q8_0.gguf' });
    expect(config.EMBEDDING_MODEL_ID).toBe('embeddinggemma-2-Q8_0.gguf');
    expect(config.embeddingConfigProblem()).toBeUndefined();
  });

  it('tells a remote model apart by its provider, and fills in well-known URLs', async () => {
    const openai = await configWith({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-small',
    });
    expect(openai.EMBEDDING_MODEL_ID).toBe('openai/text-embedding-3-small');
    expect(openai.EMBEDDING_BASE_URL).toBe('https://api.openai.com/v1');

    const hf = await configWith({
      EMBEDDING_PROVIDER: 'huggingface',
      EMBEDDING_MODEL: 'BAAI/bge-m3',
    });
    expect(hf.EMBEDDING_BASE_URL).toBe(
      'https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction',
    );
  });

  it('names the missing setting for a remote provider', async () => {
    expect((await configWith({ EMBEDDING_PROVIDER: 'openai' })).embeddingConfigProblem()).toBe(
      'embedding_model must be set when embedding_provider is openai',
    );
    expect(
      (
        await configWith({ EMBEDDING_PROVIDER: 'ollama', EMBEDDING_MODEL: 'm' })
      ).embeddingConfigProblem(),
    ).toBe('embedding_url must be set when embedding_provider is ollama');
  });
});
