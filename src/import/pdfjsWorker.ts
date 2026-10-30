/**
 * Entry point of pdf.js's worker. The polyfills must be evaluated before
 * pdf.js, which an import placed first guarantees.
 */
import './pdfjsPolyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
