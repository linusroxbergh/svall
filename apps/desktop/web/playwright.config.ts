import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: { baseURL: 'http://localhost:5173', headless: true, viewport: { width: 1280, height: 800 } },
  // not `pnpm exec`: pnpm starts vite in a process group of its own, which Playwright's kill misses and then waits on
  webServer: { command: './node_modules/.bin/vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: false, timeout: 30_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
