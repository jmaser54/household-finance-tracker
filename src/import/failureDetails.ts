/**
 * Technical details for a statement that could not be read, so the cause can
 * be found without anyone seeing the statement. Shown on screen only; never
 * stored or sent. Everything here is either fixed vocabulary, structural
 * facts about the PDF file format, or an error message with every digit and
 * quoted fragment removed. It never contains text from the statement:
 * no dates, amounts, descriptions, names or account numbers.
 */

/** Where reading stopped. */
export type FailureStage =
  /** Loading the bundled PDF library (pdf.js) into the app window. */
  | 'loading-reader'
  /** Reading the chosen file's bytes from disk. */
  | 'reading-file'
  /** Computing the file's fingerprint (SHA-256, WebCrypto). */
  | 'fingerprint'
  /** pdf.js opening the document (worker start-up, file structure, decryption). */
  | 'opening-pdf'
  /** pdf.js extracting text from a page. */
  | 'reading-text'
  /** The file is empty, over 25 MB, or over 60 pages. */
  | 'size-limits'
  /** Anything after text extraction (parsing the statement layout). */
  | 'reading-statement';

export interface ErrorSummary {
  /** The error's type, e.g. "TypeError", "InvalidPDFException". */
  name: string;
  /** Sanitized message: digits replaced by #, quoted text removed, short. */
  message: string;
}

export interface FileFacts {
  sizeKb: number;
  /** "%PDF-1.7" style header version, or "missing". */
  header: string;
  encrypted: boolean;
  objectStreams: boolean;
  xrefStream: boolean;
  linearized: boolean;
  /** Number of %%EOF markers: more than one means the file was updated incrementally. */
  revisions: number;
  pages?: number;
}

export interface TechnicalDetails {
  stage: FailureStage;
  error: ErrorSummary;
  file?: FileFacts;
}

const SAFE_CHARS = /[^A-Za-z#.,:;()[\]{}<>=!?_/\- …]/g;

export function summarizeError(error: unknown): ErrorSummary {
  const e = error as { name?: unknown; message?: unknown } | null;
  const rawName = typeof e?.name === 'string' ? e.name : typeof error;
  const name = /^[A-Za-z]{1,40}$/.test(rawName) ? rawName : 'Error';
  const rawMessage = typeof e?.message === 'string' ? e.message : '';
  const message = rawMessage
    .replace(/(["'`]).*?\1/g, '…')
    .replace(/\d/g, '#')
    .replace(SAFE_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120);
  return { name, message };
}

/** Structural facts read from the raw file format; never page content. */
export function fileFacts(bytes: Uint8Array, pages?: number): FileFacts {
  const text = new TextDecoder('latin1').decode(bytes);
  const header = /%PDF-(\d\.\d)/.exec(text.slice(0, 1024))?.[1];
  return {
    sizeKb: Math.round(bytes.byteLength / 10_240) * 10,
    header: header ? `%PDF-${header}` : 'missing',
    encrypted: /\/Encrypt\b/.test(text),
    objectStreams: /\/Type\s*\/ObjStm\b/.test(text),
    xrefStream: /\/Type\s*\/XRef\b/.test(text),
    linearized: /\/Linearized\b/.test(text.slice(0, 2048)),
    revisions: (text.match(/%%EOF/g) ?? []).length,
    ...(pages !== undefined ? { pages } : {}),
  };
}

export interface EnvironmentFacts {
  appVersion: string;
  engine: string;
  secureContext: boolean;
  webCrypto: boolean;
  streamAsyncIteration: boolean;
  urlParse: boolean;
  promiseTry: boolean;
  decompressionStream: boolean;
  workers: boolean;
}

export function environmentFacts(appVersion: string): EnvironmentFacts {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const engine = [/AppleWebKit\/[\d.]+/, /Version\/[\d.]+/, /Chrome\/\d+/, /Mac OS X [\d_]+/]
    .map((pattern) => pattern.exec(ua)?.[0])
    .filter(Boolean)
    .join(' ');
  const stream = typeof ReadableStream === 'undefined' ? undefined : (ReadableStream.prototype as unknown as Record<symbol, unknown>);
  return {
    appVersion,
    engine: engine || 'unknown',
    secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : false,
    webCrypto: typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function',
    streamAsyncIteration: typeof stream?.[Symbol.asyncIterator] === 'function',
    urlParse: typeof (URL as unknown as { parse?: unknown }).parse === 'function',
    promiseTry: typeof (Promise as unknown as { try?: unknown }).try === 'function',
    decompressionStream: typeof DecompressionStream === 'function',
    workers: typeof Worker === 'function',
  };
}

const STAGE_TEXT: Record<FailureStage, string> = {
  'loading-reader': 'loading the PDF reader',
  'reading-file': 'reading the file from disk',
  fingerprint: "computing the file's fingerprint",
  'opening-pdf': 'opening the PDF',
  'reading-text': 'reading text from a page',
  'size-limits': 'checking size limits',
  'reading-statement': 'reading the statement layout',
};

/** Plain text to copy. Contains no statement contents. */
export function formatTechnicalDetails(details: TechnicalDetails, environment: EnvironmentFacts): string {
  const lines = [
    `Stopped while: ${STAGE_TEXT[details.stage]} [${details.stage}]`,
    `Error: ${details.error.name}${details.error.message ? `: ${details.error.message}` : ''}`,
  ];
  if (details.file) {
    const f = details.file;
    lines.push(
      `File: about ${f.sizeKb} KB, ${f.header}, encrypted ${yes(f.encrypted)}, object streams ${yes(f.objectStreams)}, ` +
        `xref stream ${yes(f.xrefStream)}, linearized ${yes(f.linearized)}, revisions ${f.revisions}` +
        (f.pages !== undefined ? `, pages ${f.pages}` : ''),
    );
  }
  const e = environment;
  lines.push(
    `App ${e.appVersion}; ${e.engine}`,
    `Secure context ${yes(e.secureContext)}, WebCrypto ${yes(e.webCrypto)}, workers ${yes(e.workers)}, ` +
      `stream iteration ${yes(e.streamAsyncIteration)}, URL.parse ${yes(e.urlParse)}, Promise.try ${yes(e.promiseTry)}, ` +
      `DecompressionStream ${yes(e.decompressionStream)}`,
  );
  return lines.join('\n');
}

const yes = (value: boolean) => (value ? 'yes' : 'no');
