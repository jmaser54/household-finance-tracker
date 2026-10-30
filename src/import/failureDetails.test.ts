import { readdirSync, readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { environmentFacts, fileFacts, formatTechnicalDetails, summarizeError } from './failureDetails';
import type { PdfJs } from './pdfText';
import { readStatement, type FileOutcome } from './readStatement';

const real = pdfjs as unknown as PdfJs;
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/synthetic/${name}`));

/** A stand-in pdf.js that fails at a chosen point, to test each stage. */
function failingPdfJs(failAt: 'open' | 'text' | 'pages', error: unknown): PdfJs {
  return {
    getDocument: () => ({
      promise:
        failAt === 'open'
          ? Promise.reject(error)
          : Promise.resolve({
              numPages: failAt === 'pages' ? 500 : 1,
              getPage: async () => ({
                streamTextContent: () =>
                  new ReadableStream({
                    pull() {
                      throw error;
                    },
                  }),
              }),
            }),
      destroy: async () => undefined,
    }),
  } as unknown as PdfJs;
}

const unreadable = (outcome: FileOutcome) => {
  if (outcome.status !== 'unreadable') throw new Error(`expected unreadable, got ${outcome.status}`);
  return outcome.details;
};

describe('every failure says where it stopped and why', () => {
  it('reports a worker or open failure at the opening stage, with the error type', async () => {
    const workerError = Object.assign(new Error('Setting up fake worker failed: "Cannot load script at: tauri://localhost/assets/pdf.worker.min-123.mjs".'), { name: 'Error' });
    const details = unreadable(await readStatement(fixture('savings-2026-03.pdf'), failingPdfJs('open', workerError)));
    expect(details.stage).toBe('opening-pdf');
    expect(details.error.message).toBe('Setting up fake worker failed: ….');
    expect(details.file).toMatchObject({ header: '%PDF-1.7', encrypted: false });
  });

  it('reports a structure error by its pdf.js exception name', async () => {
    const invalid = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' });
    const details = unreadable(await readStatement(fixture('savings-2026-03.pdf'), failingPdfJs('open', invalid)));
    expect(details.error).toEqual({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' });
  });

  it('reports a missing browser feature while reading text at the text stage', async () => {
    const missing = new TypeError("undefined is not a function (near '...e of t...')");
    const details = unreadable(await readStatement(fixture('savings-2026-03.pdf'), failingPdfJs('text', missing)));
    expect(details.stage).toBe('reading-text');
    expect(details.error).toEqual({ name: 'TypeError', message: 'undefined is not a function (near …)' });
  });

  it('reports the page limit with the page count', async () => {
    const details = unreadable(await readStatement(fixture('savings-2026-03.pdf'), failingPdfJs('pages', null)));
    expect(details).toMatchObject({ stage: 'size-limits', file: { pages: 500 } });
  });

  it('reports a genuinely damaged file at the opening stage', async () => {
    const damaged = fixture('checking-2026-03.pdf').slice(0, 400);
    const outcome = await readStatement(damaged, real);
    if (outcome.status === 'unreadable') expect(outcome.details.stage).toBe('opening-pdf');
    else expect(['unsupported', 'scanned']).toContain(outcome.status);
  });
});

describe('real-world PDF structures (synthetic contents)', () => {
  const dir = 'tests/fixtures/synthetic/structure';
  const files = readdirSync(dir).filter((f) => f.endsWith('.pdf'));

  it('has the structure fixtures', () => expect(files.length).toBe(7));

  it.each(files.filter((f) => !f.startsWith('requires-user')))('reads %s completely', async (name) => {
    const outcome = await readStatement(new Uint8Array(readFileSync(`${dir}/${name}`)), real);
    expect(outcome.status).toBe('parsed');
    if (outcome.status === 'parsed') {
      expect(outcome.statements).toHaveLength(1);
      expect(outcome.statements[0]!.transactions).toHaveLength(2);
      expect(outcome.statements[0]!.validation.status).toBe('verified');
    }
  });

  it('reports a PDF that needs a password to open as password-protected, not damaged', async () => {
    const outcome = await readStatement(new Uint8Array(readFileSync(`${dir}/requires-user-password.pdf`)), real);
    expect(outcome.status).toBe('password_protected');
  });

  it('describes encryption, object streams and linearization structurally', () => {
    expect(fileFacts(new Uint8Array(readFileSync(`${dir}/aes256-owner-password.pdf`)))).toMatchObject({ encrypted: true });
    expect(fileFacts(new Uint8Array(readFileSync(`${dir}/object-streams.pdf`)))).toMatchObject({ objectStreams: true, xrefStream: true });
    expect(fileFacts(new Uint8Array(readFileSync(`${dir}/linearized.pdf`)))).toMatchObject({ linearized: true });
  });
});

describe('technical details never contain statement contents', () => {
  it('sanitizes error messages: no digits, no quoted text, short', () => {
    const summary = summarizeError(new Error('Bad value "EXAMPLE GROCER 84.23" at offset 12345 for account 4821'));
    expect(summary.message).toBe('Bad value … at offset ##### for account ####');
    expect(summarizeError({ name: 'Weird Name! 123', message: 'x'.repeat(500) })).toMatchObject({ name: 'Error' });
    expect(summarizeError(new Error('x'.repeat(500))).message.length).toBeLessThanOrEqual(120);
  });

  it('a full details text for a synthetic statement contains none of its values', async () => {
    const bytes = fixture('checking-2026-03.pdf');
    const details = unreadable(await readStatement(bytes, failingPdfJs('text', new TypeError('boom'))));
    const text = formatTechnicalDetails(details, environmentFacts('0.0.0-test'));
    for (const secret of ['PAYROLL', 'GROCER', '4821', '2,500.00', '03/01', 'Example', 'Community']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[reading-text]');
    expect(text).toMatch(/File: about \d+ KB, %PDF-1\.7/);
  });
});
