import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { emptyState, type AgentAdapter, type FleetState, type Robot } from '@svall/protocol';
import { answer, type Ctx } from '../../src/api/methods.js';
import { Config } from '../../src/config.js';
import { Fleet } from '../../src/fleet.js';
import { ProcessTable, type Proc } from '../../src/handover/processes.js';
import type { AgentProbe } from '../../src/handover/sessions/registry.js';
import { HomeLinks, type Transport } from '../../src/link/home.js';
import { HomeConnection } from '../../src/link/worker.js';
import { handoverGit, type GitRunner } from '../../src/links/git.js';
import { silentLogger } from '../../src/log.js';
import type { MachineEntry } from '../../src/machine.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { resolvePaths, type Paths } from '../../src/paths.js';
import { MoveFiles, Placement } from '../../src/placement/move.js';
import { PrepareService } from '../../src/placement/prepare.js';
import { Router, workerCalls } from '../../src/placement/router.js';
import { issueToken } from '../../src/placement/workers.js';
import { Store } from '../../src/store.js';
import { TerminalHub } from '../../src/terminals.js';
import type { Screen, Tmux } from '../../src/tmux/tmux.js';
import { Outbox } from '../../src/worker/outbox.js';
import { applyReport } from '../../src/worker/snapshot.js';
import { git } from '../handover/git-fixture.js';
import { makeHome } from '../helpers.js';
import { H, W, island } from './world.js';

export const SID = '0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0';
export const SID2 = '1c2d3e4f-5061-4273-84a5-b6c7d8e9f0a1';
const CLAUDE = '2.1.300';
const RELEASE = '1.2.3';
const entry: MachineEntry = { id: W, record: { name: 'w1', ssh: 'w1', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.svall', gateway: false } };

/** What a crash leaves of a daemon: nothing it does after counts. */
export class Crash extends Error {}
export type Life = { dead: boolean };

// `o` as a daemon that dies with `life` reaches it: every call after the death throws and changes nothing
export function mortal<T extends object>(o: T, life: Life): T {
  return new Proxy(o, {
    get(target, key) {
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (life.dead) throw new Crash('the daemon is gone');
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
const mortalGit = (g: GitRunner, life: Life): GitRunner => (args, cwd) => {
  if (life.dead) throw new Crash('the daemon is gone');
  return g(args, cwd);
};

type Win = { windowId: string; paneId: string; pid: number; name: string; path: string; job?: string };

/** A machine's tmux server and processes, which outlive its daemon. */
export class Box {
  windows = new Map<string, Win>();
  /** each window opened, by name */
  opened: string[] = [];
  /** each line typed, by pane */
  lines: { paneId: string; text: string }[] = [];
  /** each key sent, by pane */
  keys: { paneId: string; text: string }[] = [];
  screens = new Map<string, string[]>();
  /** what an agent started by a line does: by default it reports its SessionStart */
  started?: (robotId: string, sessionId: string) => void;
  private next = 1;

  constructor(readonly name: string) {}

  window(name: string, cwd: string, job?: string): Win {
    const n = this.next++;
    const w = { windowId: `@${n}`, paneId: `%${n}`, pid: n * 1000, name, path: cwd, ...(job && { job }) };
    this.windows.set(w.windowId, w);
    return w;
  }

  private byPane(paneId: string): Win | undefined {
    return [...this.windows.values()].find((w) => w.paneId === paneId);
  }

  readonly tmux = {
    listWindows: async () => [...this.windows.values()].map((w) => ({
      windowId: w.windowId, paneId: w.paneId, panePid: w.pid, name: w.name, command: w.job ? 'claude' : 'zsh', path: w.path, activity: 0, dead: false,
    })),
    newWindow: async (name: string, cwd: string) => {
      const w = this.window(name, cwd);
      this.opened.push(name);
      return { windowId: w.windowId, paneId: w.paneId };
    },
    sendLine: async (paneId: string, text: string) => {
      this.lines.push({ paneId, text });
      const w = this.byPane(paneId);
      const resumed = /^claude\b.*--resume (\S+)/.exec(text);
      if (!w || !resumed) return;
      w.job = text;
      setImmediate(() => this.started?.(w.name, resumed[1]));
    },
    sendBytes: async (paneId: string, bytes: Buffer) => { this.keys.push({ paneId, text: bytes.toString('latin1') }); },
    killWindow: async (windowId: string) => { this.windows.delete(windowId); },
    screen: async (paneId: string): Promise<Screen> => ({ rows: this.screens.get(paneId) ?? [], cursor: 0, shown: true, command: '' }),
    capture: async () => Buffer.from(''),
    detachClients: async () => {},
    ensureServer: async () => {},
  };

  readonly processes = async (): Promise<ProcessTable> => new ProcessTable([...this.windows.values()].flatMap((w): Proc[] => {
    const group = w.job ? w.pid + 1 : w.pid;
    const shell = { pid: w.pid, ppid: 1, pgid: w.pid, tpgid: group, stat: 'Ss', args: '-zsh' };
    return w.job ? [shell, { pid: group, ppid: w.pid, pgid: group, tpgid: group, stat: 'S+', args: w.job }] : [shell];
  }));
}

const socketTo = (sock: string): Transport => async () => {
  const stream = net.connect(sock);
  await once(stream, 'connect');
  return { stream, via: { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' } };
};

export const until = (check: () => void, timeout = 10_000) => vi.waitFor(check, { timeout, interval: 50 });

const put = (file: string, data: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

/**
 * A Mac under `base/Users/ada` holding robot c_1 in worktree kanban of code/app, with commits past origin, a staged, an
 * unstaged and an untracked change and a .env, and its Claude session; and worker w1, whose user home is this test's
 * HOME, holding nothing yet. Both daemons run here, linked over w1's real link.sock.
 */
export function moveWorld(o: { agent?: Partial<NonNullable<Robot['agent']>>; second?: boolean; notInRepo?: boolean } = {}) {
  const base = fs.realpathSync(makeHome());
  fs.writeFileSync(path.join(base, 'gitconfig'), '');
  const g = (cwd: string, ...args: string[]): string => git(base, cwd, ...args);
  const mac = path.join(base, 'Users/ada');
  const far = os.homedir();
  const macClaude = path.join(mac, '.claude');
  const farClaude = path.join(far, '.claude');
  const main = path.join(mac, 'code/app');
  const origin = path.join(base, 'origins/app.git');

  g(base, 'init', '-q', main);
  put(path.join(main, 'a.txt'), 'one\n');
  put(path.join(main, 'b.txt'), 'two\n');
  g(main, 'add', '.');
  g(main, 'commit', '-qm', 'base');
  g(base, 'clone', '-q', '--bare', main, origin);
  g(main, 'remote', 'add', 'origin', origin);
  g(main, 'fetch', '-q', 'origin');
  g(main, 'remote', 'set-head', 'origin', 'main');

  // a worktree of `main` on a new branch, one commit past origin, dirty every way a move carries
  const worktree = (slug: string): string => {
    const wt = path.join(main, '.claude/worktrees', slug);
    g(main, 'worktree', 'add', '-q', '-b', slug, wt);
    put(path.join(wt, `${slug}.txt`), `${slug}\n`);
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', `${slug} work`);
    put(path.join(wt, 'a.txt'), 'one\nstaged\n');
    g(wt, 'add', 'a.txt');
    put(path.join(wt, 'b.txt'), 'two\nunstaged\n');
    put(path.join(wt, 'notes.md'), 'untracked\n');
    put(path.join(wt, '.env'), 'TOKEN=secret\n');
    return wt;
  };
  const wt = worktree('kanban');
  const project = path.join(macClaude, 'projects', '-Users-ada-code-app');
  const transcript = (sid: string, cwd: string): string => {
    const file = path.join(project, `${sid}.jsonl`);
    put(file, `${JSON.stringify({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'build the board' } })}\n`);
    return file;
  };

  const mac1 = new Box('mac');
  const vault = new Box('w1');
  // or a shell in a folder of the Mac home that is no repository
  const notes = path.join(mac, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  const cwd = o.notInRepo ? notes : wt;
  const window = mac1.window('c_1', cwd, 'claude');
  const c1: Robot = {
    id: 'c_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'kanban', note: '', portrait: 'owl', instructions: '', cwd, context: [], shell: { lastOutputAt: 0 }, unread: false,
    ...(!o.notInRepo && { repo: { root: wt, mainRoot: main, branch: 'kanban', isWorktree: true } }),
    agent: { kind: 'claude', sessionId: SID, transcriptPath: transcript(SID, cwd), status: 'idle', lastActivityAt: 0, ...o.agent },
    tmux: { windowId: window.windowId, paneId: window.paneId },
  };
  const robots: Record<string, Robot> = { c_1: c1 };
  let wt2: string | undefined;
  if (o.second) {
    wt2 = worktree('board');
    const w2 = mac1.window('c_2', wt2, 'claude');
    robots.c_2 = {
      ...c1, id: 'c_2', name: 'board', cell: { x: 1, y: 0 }, cwd: wt2, repo: { root: wt2, mainRoot: main, branch: 'board', isWorktree: true },
      agent: { kind: 'claude', sessionId: SID2, transcriptPath: transcript(SID2, wt2), status: 'idle', lastActivityAt: 0 },
      tmux: { windowId: w2.windowId, paneId: w2.paneId },
    };
  }

  const config = Config.parse({});
  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  const token = issueToken(homePaths, W);
  const seed = (paths: Paths, state: Partial<FleetState>): void => {
    const store = Store.load(paths.state, () => {});
    store.update((d) => { Object.assign(d, { ...emptyState(), islands: { i_1: island }, ...structuredClone(state) }); });
    store.flush();
  };
  seed(homePaths, { robots });
  seed(workerPaths, {});

  // the worker's Claude has been logged in, so its config file is there
  fs.mkdirSync(farClaude, { recursive: true });
  fs.writeFileSync(path.join(far, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  const macProbe: AgentProbe = { kind: 'claude', version: CLAUDE, home: macClaude, loggedIn: true, hooks: true };
  const farAdapter: AgentAdapter = { kind: 'claude', version: CLAUDE, adapter: 1, home: farClaude, loggedIn: true, hooks: true };
  const viewers = { detach: async () => {} };
  const stops: (() => unknown)[] = [];

  // the worker's daemon: it runs for the whole test
  const workerStore = Store.load(workerPaths.state, () => {});
  const workerOwnership = OwnershipState.load({ paths: workerPaths, fleetId: config.id, machineId: W, log: silentLogger, standalone: true });
  const handlers: Record<string, (p: unknown) => Promise<unknown>> = {};
  const connection = new HomeConnection({
    paths: workerPaths, worker: { homeMachineId: H, fleetId: config.id, token, homeName: 'mac' }, me: W, store: workerStore, outbox: Outbox.open(workerPaths),
    log: silentLogger, release: RELEASE, bootId: 'boot-1', handlers,
  });
  const workerRouter = new Router({ store: workerStore, me: W, log: silentLogger, home: { id: H, connection } });
  const workerFleet = new Fleet({
    store: workerStore, tmux: vault.tmux as unknown as Tmux, paths: workerPaths, config, log: silentLogger, ownership: workerOwnership, remote: workerRouter,
    report: (r) => connection.report(r), readProcs: async () => [], processes: async () => [],
  });
  vault.started = (id, sid) => workerFleet.emit('session-start', id, undefined, sid);
  const prepare = new PrepareService({
    store: workerStore, fleet: workerFleet, tmux: vault.tmux as unknown as Tmux, viewers, connection, me: W, fleetId: config.id, homeName: 'mac', paths: workerPaths,
    git: handoverGit, cloneGit: handoverGit, agents: async () => [{ ...macProbe, home: farClaude }], processes: vault.processes,
    agentRunning: async () => false, log: silentLogger, watchMs: 5000,
  });
  const terminals = new TerminalHub(workerFleet, vault.tmux as unknown as Tmux, workerStore, silentLogger);
  Object.assign(handlers, workerCalls({ fleet: workerFleet, store: workerStore, me: W, log: silentLogger, terminals }), prepare.handlers, {
    'system.info': async () => ({ agentAdapters: [farAdapter] }),
  });
  stops.push(() => connection.stop());

  // the home's daemon, started again after a crash from what it left on disk; `syncAfterMs` holds off each link's sync
  const bootHome = async (life: Life = { dead: false }, o: { syncAfterMs?: number } = {}) => {
    const store = Store.load(homePaths.state, () => {});
    const ownership = OwnershipState.load({ paths: homePaths, fleetId: config.id, machineId: H, log: silentLogger, standalone: true });
    let version = Date.now();
    let ctx: Ctx | undefined;
    const links: HomeLinks = new HomeLinks({
      paths: homePaths, store, log: silentLogger, release: RELEASE, machines: () => [entry], connect: socketTo(workerPaths.linkSock),
      onReport: (r, machine) => { applyReport(store, r, machine); },
      onEvent: (kind) => Promise.reject(new Error(`no ${kind}`)),
      onInventory: async (inv, machine) => {
        if (o.syncAfterMs) await new Promise((resolve) => setTimeout(resolve, o.syncAfterMs));
        return router.reconcileWorker(inv, machine);
      },
      onCall: (method, params) => answer(method, params, ctx!),
      snapshot: () => ({ version: ++version, state: store.state, agentHomes: { claude: macClaude, codex: path.join(mac, '.codex'), opencode: path.join(mac, '.config/opencode') } }),
    });
    const router = new Router({ store, me: H, log: silentLogger, links });
    const fleet = new Fleet({ store, tmux: mortal(mac1.tmux, life) as unknown as Tmux, paths: homePaths, config, log: silentLogger, ownership, remote: router });
    ctx = { store, fleet, ownership, router, viewer: { kind: 'app', send: () => {}, backlog: () => 0 } } as unknown as Ctx;
    mac1.started = (id, sid) => fleet.emit('session-start', id, undefined, sid);
    const placement = new Placement({
      store: mortal(store, life), fleet: mortal(fleet, life), links: mortal(links, life), me: H, fleetId: config.id, paths: homePaths,
      git: mortalGit(handoverGit, life), agents: async () => [macProbe], config: {}, release: RELEASE, homedir: mac,
      tmux: mortal(mac1.tmux, life) as unknown as Tmux, viewers, processes: mac1.processes, log: silentLogger,
      moves: mortal(new MoveFiles(homePaths.moves), life), watchMs: 5000,
    });
    links.start();
    stops.push(() => placement.stop(), () => links.stop());
    await until(() => { if (!links.for(W)?.synced) throw new Error('w1 is not synced yet'); });
    return { store, fleet, links, router, placement, life };
  };

  return {
    base, g, mac, far, main, wt, wt2, notes, macClaude, farClaude, origin, mac1, vault, homePaths, workerPaths,
    /** where the worker's clone and the robot's worktree land */
    clone: path.join(far, 'code/app'),
    farWt: path.join(far, 'code/app/.claude/worktrees/kanban'),
    worker: { store: workerStore, fleet: workerFleet, connection, prepare },
    async start() {
      await connection.start();
      return bootHome();
    },
    bootHome,
    async stop(): Promise<void> {
      for (const s of stops.splice(0).reverse()) await s();
      for (const f of ['code', '.claude', '.claude.json']) fs.rmSync(path.join(far, f), { recursive: true, force: true });
    },
  };
}
export type MoveWorld = ReturnType<typeof moveWorld>;
