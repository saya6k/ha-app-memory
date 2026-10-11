import { Lexer, type Token } from 'marked';

export interface MarkdownSection {
  /**
   * Top-level headings up to and including this section's own; 0 for text
   * before the first heading. The panel renders with the same parser and
   * counts the article's top-level heading elements the same way, which is
   * what lets a search hit open at its section.
   */
  index: number;
  /** Plain text of the heading; absent for the part before the first. */
  heading?: string;
  /** The section's Markdown source, heading line included. */
  text: string;
}

/** Inline tokens to plain text: `**E3** [error](x)` -> `E3 error`. */
function plainText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens
    .map((token) =>
      'tokens' in token && token.tokens
        ? plainText(token.tokens, '')
        : ((token as { text?: string }).text ?? ''),
    )
    .join('')
    .trim();
}

/**
 * Splits a Markdown document at its top-level headings (ATX `#` and setext
 * `===` alike). Headings inside block quotes, lists or code blocks are not
 * top level, so they stay inside the section around them.
 */
export function splitMarkdown(source: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [{ index: 0, text: '' }];

  for (const token of new Lexer().lex(source)) {
    if (token.type === 'heading') {
      const heading = token as Token & { text: string; tokens?: Token[] };
      sections.push({
        index: sections.length,
        heading: plainText(heading.tokens, heading.text),
        text: '',
      });
    }
    const current = sections[sections.length - 1];
    if (current) current.text += token.raw;
  }

  return sections.filter((section) => section.text.trim() !== '');
}
