import { defineConfig } from '@playwright/test';
import { WEB_ORIGIN, WEB_PORT } from './e2e/daemon.js';

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: { baseURL: WEB_ORIGIN, headless: true, viewport: { width: 1280, height: 800 } },
  // not `pnpm exec`: pnpm starts vite in a process group of its own, which Playwright's kill misses and then waits on
  webServer: { command: `./node_modules/.bin/vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`, url: WEB_ORIGIN, reuseExistingServer: false, timeout: 30_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
