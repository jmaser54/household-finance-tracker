/**
 * pdf.js for the app window: the legacy build (it includes the language
 * features Safari 17 on macOS Monterey lacks), with its worker bundled and
 * served from the app itself. Loaded only when statements are added.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PdfJs } from './pdfText';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const appPdfJs = pdfjs as unknown as PdfJs;
