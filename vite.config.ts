/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';

// The strict Content-Security-Policy in index.html is what ships. The dev
// server alone needs inline styles and a websocket for hot reload, so it gets
// a relaxed copy. This plugin is serve-only and never affects `vite build`.
function devOnlyCsp(): Plugin {
  return {
    name: 'dev-only-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace("connect-src 'none'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
    },
  };
}

// Relative base so the same build works at https://<user>.github.io/<repo>/
// and on a dedicated custom domain (see docs/ARCHITECTURE.md, "Origin isolation").
export default defineConfig({
  base: './',
  plugins: [devOnlyCsp()],
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Keep every asset a same-origin file rather than a data: URL.
    assetsInlineLimit: 0,
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
