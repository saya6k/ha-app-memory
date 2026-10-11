import { CHUNK_SIZE } from '../config.js';

/**
 * Upper bound on a chunk, in characters (chunk_size). A bidirectional
 * embedding model has to see its whole input at once, so a chunk plus the
 * document prefix and manual title must fit the model's context — for the
 * bundled sidecar, context_size tokens. Korean runs close to one token per
 * character in the worst case, hence the default of 400 for a 512 context.
 */
export const MAX_CHUNK_CHARS = CHUNK_SIZE;

/** How much neighbouring chunks share, so a sentence cut at a boundary is still findable. */
export function overlapFor(maxChars: number): number {
  return Math.round(maxChars * 0.15);
}

export const CHUNK_OVERLAP_CHARS = overlapFor(MAX_CHUNK_CHARS);

/** Preferred cut points, best first: paragraph, line, sentence, word. */
const BREAKS = ['\n\n', '\n', '. ', '。', '? ', '! ', ' '];

function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Where to end a chunk that starts at `start`: the last good break in its second half. */
function cutPoint(text: string, start: number, maxChars: number): number {
  const hardEnd = start + maxChars;
  if (hardEnd >= text.length) return text.length;

  const half = Math.floor(maxChars / 2);
  const window = text.slice(start + half, hardEnd);
  for (const brk of BREAKS) {
    const at = window.lastIndexOf(brk);
    if (at !== -1) return start + half + at + brk.length;
  }
  return hardEnd;
}

/** Splits one page's text into overlapping chunks of at most `maxChars`. */
export function chunkPage(raw: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const overlap = overlapFor(maxChars);
  const text = normalize(raw);
  const chunks: string[] = [];

  let start = 0;
  while (start < text.length) {
    const end = cutPoint(text, start, maxChars);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    // end is at least half a chunk past start, and the overlap is less than
    // that, so this always moves forward.
    start = end - overlap;
  }

  return chunks;
}
