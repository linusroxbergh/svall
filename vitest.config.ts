import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { refusal } from './test/tmux-lock.js';

const isolate = fileURLToPath(new URL('./test/isolate.ts', import.meta.url));
const tmuxLock = fileURLToPath(new URL('./test/tmux-lock.ts', import.meta.url));
// what a developer's shell may hold, so the tests show that isolate.ts clears it
const shell = { CLAUDE_CONFIG_DIR: '/nonexistent/claude', SVALL_TERM: '2' };
// the tests that spawn tmux, tsx, daemons and shell scripts take seconds alone, and several times that on a loaded machine
const slow = { testTimeout: 20_000, hookTimeout: 20_000 };
// the files that start tmux servers, which skip without tmux. Many at once across worktrees can hang macOS's tty layer until
// a reboot, so they run after the rest, 4 at once, under the machine's one tmux test lock
const tmuxFiles = (root: string) => {
  const dir = fileURLToPath(new URL(`./${root}/`, import.meta.url));
  return fs.globSync('test/**/*.test.ts', { cwd: dir }).filter((f) => fs.readFileSync(dir + f, 'utf8').includes('hasTmux('));
};
// and on a Mac they are left out unless asked for, said once though vitest evaluates this file for each project
const refused = refusal();
const noted = globalThis as { svallTmuxNoted?: boolean };
if (refused && !noted.svallTmuxNoted) { noted.svallTmuxNoted = true; console.warn(refused); }

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'scripts', include: ['test/*.test.ts'], ...slow } },
      { test: { name: 'protocol', root: 'packages/protocol' } },
      { test: { name: 'feedback', root: 'services/feedback' } },
      ...['svalld', 'cli'].flatMap((name) => {
        const root = `packages/${name}`;
        const tmux = tmuxFiles(root);
        const test = { root, setupFiles: [isolate], env: shell, ...slow };
        return [
          { test: { name, ...test, exclude: [...configDefaults.exclude, ...tmux] } },
          ...(refused ? [] : [{ test: { name: `${name}-tmux`, ...test, include: tmux, globalSetup: [tmuxLock], maxWorkers: 4, sequence: { groupOrder: 1 } } }]),
        ];
      }),
      'apps/desktop/web',
    ],
  },
});
