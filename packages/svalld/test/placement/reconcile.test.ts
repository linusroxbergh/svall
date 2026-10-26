import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Robot } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { placed, robot, until, world } from './world.js';

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

  it('robots started on a worker while linked are checked for a shared branch at its next reconnect, and flagged only when shared then', async () => {
    // a clone in the worker's user folder and the same clone in this Mac's
    const repo = (home: string, branch: string) => ({ root: path.join(home, 'src', 'kanban'), mainRoot: path.join(home, 'src', 'kanban'), branch, isWorktree: false });
    const sockets: net.Socket[] = [];
    let sock = '';
    const w = world({
      home: { robots: { board: robot({ id: 'board', repo: repo('/Users/ada', 'main') }) } },
      tmux: { newWindow: async (id: string) => ({ windowId: `@${id}`, paneId: `%${id}` }), killWindow: async () => {}, listWindows: async () => [], serverPid: async () => undefined },
      connect: async () => {
        const s = net.connect(sock);
        await once(s, 'connect');
        sockets.push(s);
        return { stream: s, via: { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' } };
      },
    });
    sock = w.worker.paths.linkSock;
    worlds.push(w);
    await w.link();
    // a create takes the offline path until the worker has read the home's first ack
    await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
    const start = async () => (await dispatch({ id: 1, method: 'robot.create', params: { islandId: 'i_1', cwd: os.tmpdir() } }, w.worker.ctx) as { result: Robot }).result.id;
    const kb = await start();
    const solo = await start();
    w.worker.store.update((d) => { d.robots[kb].repo = repo(os.homedir(), 'kb'); d.robots[solo].repo = repo(os.homedir(), 'solo'); });
    await until(() => expect(w.home.store.state.robots[solo]?.repo?.branch).toBe('solo'));
    expect(w.home.store.state.robots[kb].note).toBe('');
    // board takes kb before w1 links again
    w.home.store.update((d) => { d.robots.board.repo = repo('/Users/ada', 'kb'); });
    sockets.at(-1)!.destroy();
    await until(() => expect(w.home.store.state.robots[kb].note).toBe('shares branch kb with board'));
    expect(w.home.store.state.robots[solo].note).toBe('');
    expect(w.home.store.state.robots.board.note).toBe('');
  });
});
