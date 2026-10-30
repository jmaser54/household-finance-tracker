/**
 * pdf.js for the app window: the legacy build (it polyfills built-ins that
 * macOS Monterey's WebKit lacks), with its worker bundled and served from the
 * app itself. `?worker&url` makes Vite compile the worker like the app, down
 * to the engine floor (vite.config.ts); copied as is, its class static blocks
 * fail to parse on Monterey. Loaded only when statements are added.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url';
import type { PdfJs } from './pdfText';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const appPdfJs = pdfjs as unknown as PdfJs;
