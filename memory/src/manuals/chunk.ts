/**
 * Upper bound on a chunk, in characters. The sidecar runs EmbeddingGemma with
 * --ubatch-size 512, and a bidirectional embedding model has to see its whole
 * input in one ubatch, so a chunk plus the document prefix and manual title
 * must stay under 512 tokens. Korean runs close to one token per character in
 * the worst case, hence well under that.
 */
export const MAX_CHUNK_CHARS = 400;

/** Carried over between neighbouring chunks so a sentence cut at a boundary is still findable. */
export const CHUNK_OVERLAP_CHARS = 60;

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
function cutPoint(text: string, start: number): number {
  const hardEnd = start + MAX_CHUNK_CHARS;
  if (hardEnd >= text.length) return text.length;

  const window = text.slice(start + MAX_CHUNK_CHARS / 2, hardEnd);
  for (const brk of BREAKS) {
    const at = window.lastIndexOf(brk);
    if (at !== -1) return start + MAX_CHUNK_CHARS / 2 + at + brk.length;
  }
  return hardEnd;
}

/** Splits one page's text into overlapping chunks of at most MAX_CHUNK_CHARS. */
export function chunkPage(raw: string): string[] {
  const text = normalize(raw);
  const chunks: string[] = [];

  let start = 0;
  while (start < text.length) {
    const end = cutPoint(text, start);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    // end is at least MAX/2 past start, so this always moves forward.
    start = end - CHUNK_OVERLAP_CHARS;
  }

  return chunks;
}
