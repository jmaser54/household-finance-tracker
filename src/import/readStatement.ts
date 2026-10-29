/**
 * Reads one chosen PDF into a statement, entirely in memory on this Mac.
 * Nothing here saves anything: saving happens only after the review screen.
 */
import { maskedLayout } from './diagnostics';
import { parseWithBestParser } from './parsers/registry';
import type { ParsedStatement, ParseFailure } from './parsers/types';
import { extractText, looksScanned, PdfReadError, type PdfJs } from './pdfText';

export type FileOutcome =
  | { status: 'parsed'; statement: ParsedStatement; diagnostics: string[] }
  | { status: 'not_pdf' | 'unreadable' | 'password_protected' | 'scanned' }
  | { status: 'unsupported'; reason: ParseFailure; diagnostics: string[] };

export async function readStatement(bytes: Uint8Array, pdfjs: PdfJs): Promise<FileOutcome> {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  if (!head.includes('%PDF-')) return { status: 'not_pdf' };
  let text;
  try {
    text = await extractText(bytes, pdfjs);
  } catch (error) {
    if (error instanceof PdfReadError) return { status: error.code };
    return { status: 'unreadable' };
  }
  if (looksScanned(text)) return { status: 'scanned' };
  const outcome = parseWithBestParser(text);
  const diagnostics = maskedLayout(text.lines);
  return outcome.ok
    ? { status: 'parsed', statement: outcome.statement, diagnostics }
    : { status: 'unsupported', reason: outcome.reason, diagnostics };
}

/** SHA-256 of the file, to recognise the same PDF imported again. Hex. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
