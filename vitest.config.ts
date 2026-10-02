import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const isolate = fileURLToPath(new URL('./test/isolate.ts', import.meta.url));
// what a developer's shell may hold, so the tests show that isolate.ts clears it
const shell = { CLAUDE_CONFIG_DIR: '/nonexistent/claude', SVALL_TERM: '2' };
// the tests that spawn tmux, tsx, daemons and shell scripts take seconds alone, and several times that on a loaded machine
const slow = { testTimeout: 20_000, hookTimeout: 20_000 };

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'scripts', include: ['test/*.test.ts'], ...slow } },
      { test: { name: 'protocol', root: 'packages/protocol' } },
      ...['svalld', 'cli'].map((name) => ({ test: { name, root: `packages/${name}`, setupFiles: [isolate], env: shell, ...slow } })),
      'apps/desktop/web',
    ],
  },
});
