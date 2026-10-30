/**
 * Reads one chosen PDF into statements (one per account it covers), entirely
 * in memory on this Mac. Nothing here saves anything: saving happens only
 * after the review screen.
 */
import { describeRead } from './diagnostics';
import { fileFacts, summarizeError, type TechnicalDetails } from './failureDetails';
import { parseWithBestParser } from './parsers/registry';
import type { ParsedStatement, ParseFailure } from './parsers/types';
import { extractText, looksScanned, PdfReadError, type PdfJs } from './pdfText';

export type FileOutcome =
  /** One statement per account in the PDF; a combined statement gives several. */
  | { status: 'parsed'; statements: ParsedStatement[]; diagnostics: string[] }
  | { status: 'not_pdf' | 'password_protected' | 'scanned' }
  /** `details` says where and why, without any statement contents. */
  | { status: 'unreadable'; details: TechnicalDetails }
  | { status: 'unsupported'; reason: ParseFailure; diagnostics: string[] };

export async function readStatement(bytes: Uint8Array, pdfjs: PdfJs): Promise<FileOutcome> {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  if (!head.includes('%PDF-')) return { status: 'not_pdf' };
  let text;
  try {
    text = await extractText(bytes, pdfjs);
  } catch (error) {
    if (error instanceof PdfReadError) {
      if (error.code === 'password_protected') return { status: 'password_protected' };
      return { status: 'unreadable', details: { stage: error.stage, error: error.summary, file: fileFacts(bytes, error.pages) } };
    }
    return { status: 'unreadable', details: { stage: 'opening-pdf', error: summarizeError(error), file: fileFacts(bytes) } };
  }
  if (looksScanned(text)) return { status: 'scanned' };
  let outcome;
  try {
    outcome = parseWithBestParser(text);
  } catch (error) {
    return { status: 'unreadable', details: { stage: 'reading-statement', error: summarizeError(error), file: fileFacts(bytes, text.pageCount) } };
  }
  const diagnostics = describeRead(text, outcome);
  return outcome.ok
    ? { status: 'parsed', statements: outcome.statements, diagnostics }
    : { status: 'unsupported', reason: outcome.reason, diagnostics };
}

/** SHA-256 of the file, to recognise the same PDF imported again. Hex. */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
