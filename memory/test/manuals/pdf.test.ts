import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractPages } from '../../src/manuals/pdf.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/washer-ko.pdf', import.meta.url));

describe('extractPages', () => {
  it('extracts Korean text page by page', async () => {
    // Without cMapUrl this comes back as ": 3 ." — every Hangul glyph dropped.
    const pages = await extractPages(FIXTURE);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('통세척 방법');
    expect(pages[1]).toContain('Error code E3: 배수 필터를 청소하세요.');
  });
});
