import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractManual, manualFormat } from '../../src/manuals/extract.js';
import { splitMarkdown } from '../../src/manuals/markdown.js';

describe('splitMarkdown', () => {
  it('splits at top-level headings, numbering them from 1 with 0 for the preamble', () => {
    const sections = splitMarkdown('intro\n\n# 설치\nstep\n\n## 오류 **E3**\n배수 필터\n');

    expect(sections.map((s) => [s.index, s.heading])).toEqual([
      [0, undefined],
      [1, '설치'],
      [2, '오류 E3'],
    ]);
    expect(sections[2]?.text).toBe('## 오류 **E3**\n배수 필터\n');
  });

  it('counts setext headings, but not headings inside quotes or code', () => {
    const sections = splitMarkdown(
      'Usage\n=====\n\n> ## quoted\n\n```\n# code\n```\n\nErrors\n------\nE3\n',
    );

    expect(sections.map((s) => [s.index, s.heading])).toEqual([
      [1, 'Usage'],
      [2, 'Errors'],
    ]);
    expect(sections[0]?.text).toContain('## quoted');
    expect(sections[0]?.text).toContain('# code');
  });

  it('keeps section numbers stable when an empty part is dropped', () => {
    // No preamble: the first section is still number 1, matching the panel.
    expect(splitMarkdown('# A\n\n# B\ntext\n').map((s) => s.index)).toEqual([1, 2]);
  });
});

describe('extractManual', () => {
  it('knows manuals by extension, case-insensitively', () => {
    expect(['a.pdf', 'b.PDF', 'c.md', 'd.Markdown', 'e.txt', 'f'].map(manualFormat)).toEqual([
      'pdf',
      'pdf',
      'markdown',
      'markdown',
      undefined,
      undefined,
    ]);
  });

  it('turns Markdown sections into parts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-md-'));
    try {
      const path = join(dir, 'Dryer.md');
      writeFileSync(path, '# 필터 청소\n매번 비우세요.\n');

      expect(await extractManual(path, 'markdown')).toEqual({
        pageCount: 1,
        parts: [{ page: 1, section: '필터 청소', text: '# 필터 청소\n매번 비우세요.\n' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
