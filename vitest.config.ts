import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const isolate = fileURLToPath(new URL('./test/isolate.ts', import.meta.url));
// what a developer's shell may hold, so the tests show that isolate.ts clears it
const shell = { CLAUDE_CONFIG_DIR: '/nonexistent/claude', SVALL_TERM: '2' };

export default defineConfig({
  test: {
    // the tests that spawn tmux, tsx and daemons take seconds alone, and several times that on a loaded machine
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      { test: { name: 'scripts', include: ['test/*.test.ts'] } },
      { test: { name: 'protocol', root: 'packages/protocol' } },
      ...['svalld', 'cli'].map((name) => ({ test: { name, root: `packages/${name}`, setupFiles: [isolate], env: shell } })),
      'apps/desktop/web',
    ],
  },
});
