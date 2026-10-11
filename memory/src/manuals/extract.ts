import { readFile } from 'node:fs/promises';

import type { ManualFormat } from '../db/manuals.js';
import { splitMarkdown } from './markdown.js';
import { extractPages } from './pdf.js';

/** What a manual is split into before chunking: PDF pages, or Markdown sections. */
export interface ManualPart {
  page: number;
  section?: string;
  text: string;
}

export interface ExtractedManual {
  /** PDF pages, or Markdown sections. */
  pageCount: number;
  parts: ManualPart[];
}

export const MANUAL_EXTENSIONS: Record<string, ManualFormat> = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

/** The format a file name implies, or undefined when it is not a manual. */
export function manualFormat(name: string): ManualFormat | undefined {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? undefined : MANUAL_EXTENSIONS[name.slice(dot).toLowerCase()];
}

export async function extractManual(path: string, format: ManualFormat): Promise<ExtractedManual> {
  if (format === 'pdf') {
    const pages = await extractPages(path);
    return { pageCount: pages.length, parts: pages.map((text, i) => ({ page: i + 1, text })) };
  }

  const sections = splitMarkdown(await readFile(path, 'utf8'));
  return {
    pageCount: sections.length,
    parts: sections.map((s) => ({ page: s.index, section: s.heading, text: s.text })),
  };
}
