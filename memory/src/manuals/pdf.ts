import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** pdfjs-dist's install directory; its cmaps and fonts are read from here. */
export const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | undefined;

/**
 * On import, pdfjs tries to polyfill canvas APIs from @napi-rs/canvas and
 * warns when it cannot. Rendering is never done here — only text extraction,
 * which needs none of it — so the image leaves the ~30 MB package out, and
 * these warnings would only alarm whoever reads the log.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (/^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/.test(String(args[0]))) return;
      warn(...args);
    };
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.warn = warn;
    }
  })();
  return pdfjs;
}

/**
 * Text of each page, in order; a page without a text layer comes back as "".
 *
 * cMapUrl is not optional for real manuals: Korean, Japanese and Chinese PDFs
 * mostly use CID fonts, and without the cmaps pdfjs drops every CJK glyph and
 * returns just the ASCII around them.
 */
export async function extractPages(path: string): Promise<string[]> {
  const { getDocument, VerbosityLevel } = await loadPdfJs();
  const data = new Uint8Array(await readFile(path));
  const task = getDocument({
    data,
    cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const { items } = await page.getTextContent();
      pages.push(
        items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''),
      );
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
