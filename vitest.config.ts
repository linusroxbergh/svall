import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const isolate = fileURLToPath(new URL('./test/isolate.ts', import.meta.url));
// what a developer's shell may hold, so the tests show that isolate.ts clears it
const shell = { CLAUDE_CONFIG_DIR: '/nonexistent/claude', ARCHI_TERM: '2' };

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'scripts', include: ['test/*.test.ts'] } },
      { test: { name: 'protocol', root: 'packages/protocol' } },
      ...['archid', 'cli'].map((name) => ({ test: { name, root: `packages/${name}`, setupFiles: [isolate], env: shell } })),
      'apps/desktop/web',
    ],
  },
});
