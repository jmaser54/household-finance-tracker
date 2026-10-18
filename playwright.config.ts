import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  reporter: 'list',
  // Never record screenshots, video or traces: in future these tests may run
  // against pages that render (synthetic) financial data, and artifacts get
  // uploaded by CI. Keep this policy even though fixtures are synthetic.
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
