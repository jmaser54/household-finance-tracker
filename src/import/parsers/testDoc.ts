// Test helper: builds positioned SYNTHETIC statement text without a PDF.
import type { PdfText, TextLine } from '../pdfText';

/** A piece of text and its left edge; its width is estimated from its length. */
export type Piece = [text: string, x0: number];

/** One line per entry: a plain string (at the left margin) or positioned pieces. `page` breaks start a new page. */
export function doc(rows: (string | Piece[] | 'page')[]): PdfText {
  const lines: TextLine[] = [];
  let page = 1;
  let y = 760;
  for (const row of rows) {
    if (row === 'page') {
      page++;
      y = 760;
      continue;
    }
    const pieces = (typeof row === 'string' ? [[row, 40] as Piece] : row).map(([text, x0]) => ({ text, x0, x1: x0 + text.length * 5 }));
    lines.push({ page, y, pieces, text: pieces.map((p) => p.text).join(' ') });
    y -= 12;
  }
  return { lines, pageCount: page, characterCount: 10_000 };
}

/** Right-aligned at `right`, as amounts are printed. */
export const at = (text: string, right: number): Piece => [text, right - text.length * 5];
