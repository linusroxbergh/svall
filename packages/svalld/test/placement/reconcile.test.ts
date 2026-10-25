import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanHomes, makeHome } from '../helpers.js';
import { placed, until, world } from './world.js';

const worlds: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

// a clone on the worker with the worktree a robot works in
function clone(): { main: string; tree: string } {
  const dir = fs.realpathSync(makeHome());
  const main = path.join(dir, 'kanban');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'first');
  const tree = path.join(main, '.worktrees', 'feat');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', tree);
  return { main, tree };
}

describe('reconciling a worker on reconnect', () => {
  it('a robot the inventory lacks goes dormant on the home; one the home lacks is told robot.forget', async () => {
    const { main, tree } = clone();
    const lost = placed({ id: 'c_lost', tmux: { windowId: '@4', paneId: '%4' }, agent: { kind: 'claude', sessionId: '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d', status: 'working', lastActivityAt: 1 } });
    const closed = placed({ id: 'c_closed', cwd: tree, repo: { root: tree, mainRoot: main, branch: 'feat', isWorktree: true }, tmux: { windowId: '@2', paneId: '%2' } });
    const both = placed({ id: 'c_both', cwd: '/srv/at-home' });
    const killed: string[] = [];
    const w = world({
      home: { robots: { c_lost: lost, c_both: both } },
      worker: { robots: { c_closed: closed, c_both: { ...both, cwd: '/srv/on-w1' } } },
      tmux: { listWindows: async () => [], serverPid: async () => undefined, killWindow: async (id: string) => { killed.push(id); } },
    });
    worlds.push(w);
    await w.link();

    const home = w.home.store.state.robots;
    expect(home.c_lost.tmux).toBeUndefined();
    expect(home.c_lost.revive).toEqual({ command: 'claude --resume 3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d', interrupted: true });
    expect(home.c_lost.note).toBe('w1 no longer has this robot\'s window');
    expect(home.c_both.cwd).toBe('/srv/on-w1');
    expect(home.c_closed).toBeUndefined();

    expect(w.worker.store.state.robots.c_closed).toBeUndefined();
    expect(killed).toEqual(['@2']);
    expect(git(main, 'worktree', 'list', '--porcelain')).toContain(`worktree ${tree}\nHEAD`);
    expect(git(main, 'worktree', 'list', '--porcelain')).toContain('locked closed robot c_closed');
    // the next snapshot gives the worker the dormant record of the robot it lost
    await until(() => { if (w.worker.store.state.robots.c_lost?.revive === undefined) throw new Error('no snapshot yet'); });
    expect(w.worker.store.state.robots.c_lost.tmux).toBeUndefined();
  });
});
