import { describe, expect, it } from 'vitest';

import { CHUNK_OVERLAP_CHARS, MAX_CHUNK_CHARS, chunkPage } from '../../src/manuals/chunk.js';

describe('chunkPage', () => {
  it('returns nothing for a page without text', () => {
    expect(chunkPage('')).toEqual([]);
    expect(chunkPage('  \n \n  ')).toEqual([]);
  });

  it('keeps a short page as one chunk, with whitespace tidied', () => {
    expect(chunkPage('  통세척   방법\n\n\n\n전원을 켜세요.  ')).toEqual([
      '통세척 방법\n\n전원을 켜세요.',
    ]);
  });

  it('never exceeds the chunk size, even without any break to cut at', () => {
    const chunks = chunkPage('가'.repeat(MAX_CHUNK_CHARS * 3));
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('cuts at sentence ends and overlaps neighbouring chunks', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `문장 번호 ${i}번은 여기서 끝납니다.`);
    const chunks = chunkPage(sentences.join(' '));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith('.')).toBe(true);
    // Every sentence survives intact in at least one chunk.
    for (const sentence of sentences) {
      expect(chunks.some((c) => c.includes(sentence))).toBe(true);
    }
    const [first, second] = chunks as [string, string];
    expect(first.slice(-CHUNK_OVERLAP_CHARS)).toContain(second.slice(0, 20));
  });
});
