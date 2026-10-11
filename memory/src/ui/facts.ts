import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { DbConnection } from '../db/client.js';
import { deleteFact, type Fact, getFact, insertFact, listFacts, updateFact } from '../db/facts.js';
import { type Owner, SHARED } from '../db/manuals.js';
import type { EmbeddingClient } from '../embedding/types.js';
import { FileError } from './files.js';

/** Plenty for a fact and its tags; anything larger is not a memory. */
const MAX_JSON_BYTES = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new FileError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new FileError(400, 'request body is not JSON');
  }
}

interface FactInput {
  content?: string;
  tags?: string[];
  shared?: boolean;
}

function parseFactInput(body: unknown, requireContent: boolean): FactInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const content = typeof input.content === 'string' ? input.content.trim() : undefined;
  if (requireContent && !content) throw new FileError(400, 'content is required');
  if (content === '') throw new FileError(400, 'content must not be empty');
  const tags = input.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
    throw new FileError(400, 'tags must be a list of strings');
  }
  return { content, tags: tags as string[] | undefined, shared: input.shared === true };
}

/** The panel's view of a fact: whose it is, without exposing user ids. */
function present(fact: Fact) {
  const { owner, ...rest } = fact;
  return { ...rest, shared: owner === SHARED };
}

/**
 * The panel's memory management. A viewer manages their own facts and the
 * shared ones; other people's personal facts are invisible — reported as not
 * found, like the tools do.
 */
export class FactsApi {
  constructor(
    private readonly db: DbConnection,
    private readonly embeddingClient: EmbeddingClient,
  ) {}

  list(userId: string | undefined) {
    return {
      mine: userId ? listFacts(this.db, userId).map(present) : [],
      shared: listFacts(this.db, SHARED).map(present),
    };
  }

  async create(userId: string | undefined, body: unknown) {
    const input = parseFactInput(body, true);
    const content = input.content as string;
    const owner: Owner = input.shared || !userId ? SHARED : userId;
    const embedding = await this.embeddingClient.embed(content, 'document');
    const fact = insertFact(this.db, {
      id: randomUUID(),
      owner,
      content,
      tags: input.tags ?? [],
      embedding,
      now: new Date().toISOString(),
    });
    return present(fact);
  }

  private visible(userId: string | undefined, id: string): Fact {
    const fact = getFact(this.db, id);
    if (!fact || (fact.owner !== SHARED && fact.owner !== userId)) {
      throw new FileError(404, 'not found');
    }
    return fact;
  }

  async update(userId: string | undefined, id: string, body: unknown) {
    const existing = this.visible(userId, id);
    const input = parseFactInput(body, false);
    const content = input.content ?? existing.content;
    const contentChanged = content !== existing.content;
    const embedding = contentChanged
      ? await this.embeddingClient.embed(content, 'document')
      : undefined;
    return present(
      updateFact(this.db, {
        id,
        content,
        tags: input.tags ?? existing.tags,
        embedding,
        now: new Date().toISOString(),
      }),
    );
  }

  delete(userId: string | undefined, id: string): void {
    this.visible(userId, id);
    deleteFact(this.db, id);
  }
}
