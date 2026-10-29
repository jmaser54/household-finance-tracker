/**
 * Turns a PDF into positioned lines of text, locally (PROJECT_PRINCIPLES.md §7).
 * pdf.js is passed in so the same code runs in the app (bundled, in a worker)
 * and in Node tests. The PDF bytes are read from the chosen file in memory and
 * are never stored or sent anywhere.
 */

export interface TextPiece {
  text: string;
  /** Left and right edges, in PDF points. */
  x0: number;
  x1: number;
}

export interface TextLine {
  page: number;
  /** Baseline height on the page (larger is higher up). */
  y: number;
  pieces: TextPiece[];
  /** The pieces joined left to right with single spaces. */
  text: string;
}

export interface PdfText {
  pageCount: number;
  lines: TextLine[];
  /** Non-space characters found; near zero for scanned or image-only PDFs. */
  characterCount: number;
}

export type PdfReadErrorCode = 'password_protected' | 'unreadable';

export class PdfReadError extends Error {
  constructor(readonly code: PdfReadErrorCode) {
    super(`PDF could not be read: ${code}`);
    this.name = 'PdfReadError';
  }
}

/** The small part of the pdf.js API used here. */
export interface PdfJs {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfPage {
  streamTextContent(): ReadableStream<{ items: unknown[] }>;
}
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

/** Hard limits so a huge or hostile file cannot exhaust memory. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES = 60;

/** Below this many characters per page, the PDF is treated as scanned. */
const SCANNED_CHARS_PER_PAGE = 25;

/** pdf.js options: no eval, no font loading, no network, quiet. */
export const SAFE_PDFJS_OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  enableXfa: false,
  disableAutoFetch: true,
  disableStream: true,
  verbosity: 0,
} as const;

export async function extractText(bytes: Uint8Array, pdfjs: PdfJs): Promise<PdfText> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) throw new PdfReadError('unreadable');
  // pdf.js may take ownership of the buffer; give it a copy.
  const task = pdfjs.getDocument({ ...SAFE_PDFJS_OPTIONS, data: bytes.slice() });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new PdfReadError(name === 'PasswordException' ? 'password_protected' : 'unreadable');
  }
  try {
    if (doc.numPages > MAX_PAGES) throw new PdfReadError('unreadable');
    const lines: TextLine[] = [];
    let characterCount = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const items = await readTextItems(await doc.getPage(n));
      const pieces = (items as PdfTextItem[])
        .filter((item) => typeof item.str === 'string' && item.str.trim() !== '' && Array.isArray(item.transform))
        .map((item) => ({ text: item.str.trim(), x0: item.transform[4]!, x1: item.transform[4]! + item.width, y: item.transform[5]! }));
      for (const piece of pieces) characterCount += piece.text.replace(/\s/g, '').length;
      lines.push(...groupIntoLines(n, pieces));
    }
    return { pageCount: doc.numPages, lines, characterCount };
  } catch (error) {
    if (error instanceof PdfReadError) throw error;
    throw new PdfReadError('unreadable');
  } finally {
    // Releases the document and its worker resources.
    await task.destroy().catch(() => undefined);
  }
}

/**
 * Reads a page's text stream with an explicit reader. pdf.js's own
 * getTextContent() uses `for await` over a ReadableStream, which Safari's
 * WebKit (including Safari 17 on macOS Monterey, and the Mac app's window)
 * does not support; this loop works everywhere.
 */
async function readTextItems(page: PdfPage): Promise<unknown[]> {
  const reader = page.streamTextContent().getReader();
  const items: unknown[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && Array.isArray(value.items)) items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
  return items;
}

export function looksScanned(text: PdfText): boolean {
  return text.pageCount > 0 && text.characterCount < SCANNED_CHARS_PER_PAGE * text.pageCount;
}

/** Pieces whose baselines are within 2 points belong to the same line. */
function groupIntoLines(page: number, pieces: { text: string; x0: number; x1: number; y: number }[]): TextLine[] {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines: { y: number; pieces: TextPiece[] }[] = [];
  for (const piece of sorted) {
    const line = lines.find((l) => Math.abs(l.y - piece.y) <= 2);
    const entry = { text: piece.text, x0: piece.x0, x1: piece.x1 };
    if (line) line.pieces.push(entry);
    else lines.push({ y: piece.y, pieces: [entry] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => {
      const ordered = line.pieces.sort((a, b) => a.x0 - b.x0);
      return { page, y: line.y, pieces: ordered, text: ordered.map((p) => p.text).join(' ') };
    });
}
