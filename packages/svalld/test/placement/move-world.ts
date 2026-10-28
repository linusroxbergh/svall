import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { emptyState, type AgentAdapter, type FleetState, type Mutation, type Robot } from '@svall/protocol';
import { answer, type Ctx } from '../../src/api/methods.js';
import { Config } from '../../src/config.js';
import { Fleet } from '../../src/fleet.js';
import { ProcessTable, type Proc } from '../../src/processes.js';
import type { AgentProbe } from '../../src/sessions/registry.js';
import type { CliRun } from '../../src/sessions/types.js';
import { HomeLinks, type Transport } from '../../src/link/home.js';
import { HomeConnection } from '../../src/link/worker.js';
import { hooklessGit, type GitRunner } from '../../src/links/git.js';
import { silentLogger } from '../../src/log.js';
import type { MachineEntry } from '../../src/machine.js';
import { realPath } from '../../src/path-tools.js';
import { resolvePaths, type Paths } from '../../src/paths.js';
import { FarViewers } from '../../src/placement/far-viewers.js';
import type { Mirror } from '../../src/placement/mirror.js';
import { MoveFiles, Placement } from '../../src/placement/move.js';
import { PrepareService } from '../../src/placement/prepare.js';
import { Replay } from '../../src/placement/replay.js';
import type { Clock } from '../../src/placement/rest.js';
import { Router, forgetRobot, workerCalls } from '../../src/placement/router.js';
import { issueToken } from '../../src/placement/workers.js';
import { Store } from '../../src/store.js';
import { TerminalHub } from '../../src/terminals.js';
import type { Screen, Tmux } from '../../src/tmux/tmux.js';
import { WorkerMutations } from '../../src/worker/mutations.js';
import { Outbox } from '../../src/worker/outbox.js';
import { applyReport } from '../../src/worker/snapshot.js';
import { git } from '../git-fixture.js';
import { makeHome } from '../helpers.js';
import { H, W, island } from './world.js';

export const SID = '0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0';
export const SID2 = '1c2d3e4f-5061-4273-84a5-b6c7d8e9f0a1';
export const OSID = 'ses_0123456789abAbCdEfGhIjKlMn';
const CLAUDE = '2.1.300';
const OPENCODE = '2.1.4';
const RELEASE = '1.2.3';
const entry: MachineEntry = { id: W, record: { name: 'w1', ssh: 'w1', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.svall' } };

/** What a crash leaves of a daemon: nothing it does after counts. */
export class Crash extends Error {}
export type Life = { dead: boolean };

// `o` as a daemon that dies with `life` reaches it: every call after the death throws and changes nothing
function mortal<T extends object>(o: T, life: Life): T {
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

type Win = { windowId: string; paneId: string; pid: number; name: string; path: string; job?: string; holdsOn?: true };

const runsOpencode = (w: Win): boolean => /^opencode\b/.test(w.job ?? '');
// an OpenCode TUI's private server, in a group of its own off the terminal
const serverOf = (w: Win): Proc => ({ pid: w.pid + 60, ppid: w.pid + 1, pgid: w.pid + 60, tpgid: 0, stat: 'Ss', args: 'opencode serve --stdio' });

/** A machine's tmux server and processes, which outlive its daemon. */
export class Box {
  windows = new Map<string, Win>();
  /** each window opened, by name */
  opened: string[] = [];
  lines: { paneId: string; text: string }[] = [];
  keys: { paneId: string; text: string }[] = [];
  screens = new Map<string, string[]>();
  /** what an agent started by a line does: by default it reports its SessionStart */
  started?: (robotId: string, sessionId: string) => void;
  /** whether each OpenCode TUI runs a private server that outlives its window until SIGKILL, as one stuck shutting down does */
  lingers = false;
  /** the servers closed windows left running */
  left: Proc[] = [];
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
      const resumed = /^claude\b.*--resume (\S+)/.exec(text) ?? /^opencode\b.* -s (\S+)/.exec(text);
      if (!w || !resumed) return;
      w.job = text;
      setImmediate(() => this.started?.(w.name, resumed[1]));
    },
    sendBytes: async (paneId: string, bytes: Buffer) => { this.keys.push({ paneId, text: bytes.toString('latin1') }); },
    killWindow: async (windowId: string) => {
      const w = this.windows.get(windowId);
      if (w && this.lingers && runsOpencode(w)) this.left.push({ ...serverOf(w), ppid: 1 });
      this.windows.delete(windowId);
    },
    screen: async (paneId: string): Promise<Screen> => ({ rows: this.screens.get(paneId) ?? [], cursor: 0, shown: true, command: '' }),
    capture: async () => Buffer.from(''),
    detachClients: async () => {},
    ensureServer: async () => {},
  };

  readonly processes = async (): Promise<ProcessTable> => new ProcessTable([...this.windows.values()].flatMap((w): Proc[] => {
    const group = w.job ? w.pid + 1 : w.pid;
    const shell = { pid: w.pid, ppid: 1, pgid: w.pid, tpgid: group, stat: 'Ss', args: '-zsh' };
    if (!w.job) return [shell];
    return [shell, { pid: group, ppid: w.pid, pgid: group, tpgid: group, stat: 'S+', args: w.job }, ...(this.lingers && runsOpencode(w) ? [serverOf(w)] : [])];
  }).concat(this.left));

  /** Signals a group: a job ends on SIGTERM unless it holds on, and on SIGKILL, as does a server a closed window left. */
  readonly kill = (group: number, signal: NodeJS.Signals): void => {
    for (const w of this.windows.values()) if (w.job && w.pid + 1 === group && (signal === 'SIGKILL' || !w.holdsOn)) delete w.job;
    if (signal === 'SIGKILL') this.left = this.left.filter((p) => p.pgid !== group);
  };
}

type Held = { directory: string; messages: { id: string }[] };

/** A machine's OpenCode: the sessions its database holds, as `opencode session export|import|delete --standalone` reads and writes them. */
export class FakeOpencode {
  sessions = new Map<string, Held>();
  /** how many imports to come fail */
  failImports = 0;
  readonly run: CliRun = async (cmd, args, o = {}) => {
    const no = (stderr: string) => ({ code: 1, stdout: '', stderr });
    if (cmd !== 'opencode' || args[0] !== 'session' || args[2] !== '--standalone') return no(`${args.join(' ')} is not faked`);
    const verb = args[1];
    const id = args.at(-1)!;
    if (verb === 'import' && this.failImports > 0) {
      this.failImports--;
      return no('Error: database is locked');
    }
    if (verb === 'import') {
      const { info, messages } = JSON.parse(fs.readFileSync(id, 'utf8')) as { info: { id: string }; messages: Held['messages'] };
      if (this.sessions.has(info.id)) return { code: 0, stdout: '', stderr: '' };
      this.sessions.set(info.id, { directory: args[4], messages });
      return { code: 0, stdout: `Imported session: ${info.id}\n`, stderr: '' };
    }
    const held = this.sessions.get(id);
    if (!held) return no(`Error: Session not found: ${id}`);
    if (verb === 'delete') this.sessions.delete(id);
    else if (verb === 'export') fs.writeFileSync(o.stdout!, JSON.stringify({ info: { id, location: { directory: held.directory } }, messages: held.messages }));
    else return no(`${verb} is not faked`);
    return { code: 0, stdout: '', stderr: '' };
  };
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
 * A Mac under `base/Users/ada` holding robot c_1 in a dirty worktree kanban of code/app, and worker w1, whose user home
 * is this test's HOME, holding nothing yet; both daemons run here, linked over w1's real link.sock.
 */
export function moveWorld(o: {
  agent?: Partial<NonNullable<Robot['agent']>>; second?: boolean; notInRepo?: boolean; mirror?: Pick<Mirror, 'push' | 'settled'>; opencode?: boolean; agentRunsThere?: boolean;
  busy?: boolean; pollMs?: number;
} = {}) {
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
  // or an OpenCode robot, whose session its OpenCode keeps and Svall's plugin logs under the fleet home
  const macOpencode = path.join(mac, '.svall/transcripts/opencode');
  const farOpencode = path.join(far, '.svall/transcripts/opencode');
  const opencode = { mac: new FakeOpencode(), far: new FakeOpencode() };
  const agent = (): NonNullable<Robot['agent']> => {
    if (!o.opencode) return { kind: 'claude', sessionId: SID, transcriptPath: transcript(SID, cwd), status: 'idle', lastActivityAt: 0 };
    put(path.join(macOpencode, `${OSID}.jsonl`), `${JSON.stringify({ kind: 'agent', text: 'built the board' })}\n`);
    opencode.mac.sessions.set(OSID, { directory: cwd, messages: [{ id: 'msg_1' }, { id: 'msg_2' }] });
    return { kind: 'opencode', sessionId: OSID, transcriptPath: path.join(macOpencode, `${OSID}.jsonl`), status: 'idle', lastActivityAt: 0 };
  };
  const window = mac1.window('c_1', cwd, o.opencode ? 'opencode' : 'claude');
  const c1: Robot = {
    id: 'c_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'kanban', note: '', portrait: 'owl', instructions: '', cwd, context: [], shell: { lastOutputAt: 0 }, unread: false,
    ...(!o.notInRepo && { repo: { root: wt, mainRoot: main, branch: 'kanban', isWorktree: true } }),
    agent: { ...agent(), ...o.agent },
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
  // or c_1 with a second terminal whose job holds on through a SIGTERM, and OpenCode servers that outlive their windows
  if (o.busy) {
    const job = mac1.window('c_1-2', cwd, 'npm run dev');
    job.holdsOn = true;
    c1.second = { cwd, unread: false, tmux: { windowId: job.windowId, paneId: job.paneId } };
    mac1.lingers = vault.lingers = true;
  }

  const config = Config.parse({});
  const { mirror } = o;
  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  const token = issueToken(homePaths, W);
  const seed = (paths: Paths, state: Partial<FleetState>): void => {
    const store = Store.load(paths.state, () => {});
    store.update((d) => { Object.assign(d, { ...emptyState(), islands: { i_1: island }, ...structuredClone(state) }); });
  };
  seed(homePaths, { robots });
  // a worker's scribe is off, as main.ts has it
  seed(workerPaths, { scribeOff: true });

  // the worker's Claude has been logged in, so its config file is there
  fs.mkdirSync(farClaude, { recursive: true });
  fs.writeFileSync(path.join(far, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  const macProbe: AgentProbe = o.opencode
    ? { kind: 'opencode', version: OPENCODE, home: macOpencode, loggedIn: true, hooks: true }
    : { kind: 'claude', version: CLAUDE, home: macClaude, loggedIn: true, hooks: true };
  const farHome = o.opencode ? farOpencode : farClaude;
  const farAdapter: AgentAdapter = { kind: macProbe.kind, version: macProbe.version, adapter: 1, home: farHome, loggedIn: true, hooks: true };
  const viewers = { detach: async () => {} };
  const stops: (() => unknown)[] = [];
  // a rest's polls pass at once and move its clock on; a call's time limit runs in real time
  let skew = 0;
  const clock: Clock = {
    now: () => Date.now() + skew,
    sleep: (ms, signal) => new Promise((resolve) => {
      const done = () => { skew += Math.max(0, ms); resolve(); };
      if (ms >= 1000) {
        const late = setTimeout(done, ms);
        signal?.addEventListener('abort', () => clearTimeout(late), { once: true });
        return;
      }
      const next = setImmediate(done);
      signal?.addEventListener('abort', () => clearImmediate(next), { once: true });
    }),
  };
  /** what each home took from the worker's outbox, in order: a report by its robot, a mutation by its method and robot */
  const applied: string[] = [];

  // the worker's daemon, started again after a crash from what it left on disk
  let boots = 0;
  let worker: Awaited<ReturnType<typeof bootWorker>> | undefined;
  const bootWorker = async (life: Life = { dead: false }) => {
    const store = Store.load(workerPaths.state, () => {});
    const outbox = Outbox.open(workerPaths);
    const tmux = mortal(vault.tmux, life) as unknown as Tmux;
    const handlers: Record<string, (p: unknown) => Promise<unknown>> = {};
    const connection = new HomeConnection({
      paths: workerPaths, worker: { homeMachineId: H, fleetId: config.id, token, homeName: 'mac' }, me: W, store, outbox: mortal(outbox, life),
      log: silentLogger, release: RELEASE, bootId: `boot-${++boots}`, handlers, onAcked: (dropped) => mutations.acked(dropped),
    });
    const router = new Router({ store, me: W, log: silentLogger, home: { id: H, connection } });
    const fleet = new Fleet({
      store, tmux, paths: workerPaths, config, log: silentLogger, remote: router, pollMs: o.pollMs,
      report: (r) => connection.report(r), created: (c, p) => mutations.created(c, p), readProcs: async () => [], processes: async () => [],
    });
    const mutations = new WorkerMutations({
      store: mortal(store, life), fleet: mortal(fleet, life), connection: mortal(connection, life), outbox: mortal(outbox, life), me: W, paths: workerPaths, log: silentLogger,
      forget: (id) => forgetRobot({ fleet: mortal(fleet, life), store: mortal(store, life), me: W, log: silentLogger }, id),
    });
    vault.started = (id, sid) => fleet.emit('session-start', id, undefined, sid);
    const box = mortal(vault, life);
    const prepare = new PrepareService({
      store: mortal(store, life), fleet: mortal(fleet, life), tmux, viewers, connection: mortal(connection, life), me: W, homeName: 'mac', paths: workerPaths,
      git: mortalGit(hooklessGit, life), cloneGit: mortalGit(hooklessGit, life), agents: async () => [{ ...macProbe, home: farHome }], homedir: far, processes: box.processes, kill: box.kill, clock,
      agentRunning: async () => !!o.agentRunsThere, log: silentLogger, moves: mortal(new MoveFiles(workerPaths.moves), life), watchMs: 5000, cli: opencode.far.run,
    });
    const terminals = new TerminalHub(fleet, tmux, store, silentLogger);
    Object.assign(handlers, workerCalls({ fleet, store, me: W, log: silentLogger, terminals, viewers: new FarViewers({ connection }) }), prepare.handlers, {
      'system.info': async () => ({ agentAdapters: [farAdapter] }),
    });
    await fleet.reconcileNow();
    if (o.pollMs) {
      fleet['poll'].start();
      stops.push(() => fleet['poll'].stop());
    }
    await connection.start();
    stops.push(() => connection.stop());
    const daemon = { store, fleet, connection, prepare, handlers, outbox, mutations, life };
    worker = daemon;
    return daemon;
  };

  // the home's daemon, started again after a crash from what it left on disk; `syncAfterMs` holds off each link's sync
  let home: Awaited<ReturnType<typeof bootHome>> | undefined;
  const bootHome = async (life: Life = { dead: false }, o: { syncAfterMs?: number } = {}) => {
    const store = Store.load(homePaths.state, () => {});
    let version = Date.now();
    let ctx: Ctx | undefined;
    const replay = new Replay({ store, paths: homePaths, log: silentLogger, synced: (m) => links.for(m)?.synced === true, homedir: mac });
    const links: HomeLinks = new HomeLinks({
      paths: homePaths, store, log: silentLogger, release: RELEASE, machines: () => [entry], connect: socketTo(workerPaths.linkSock),
      onReport: (r, machine) => {
        applied.push(`robot.sync ${r.robotId}`);
        applyReport(store, r, machine);
      },
      onEvent: async (kind, data, machine) => {
        if (kind !== 'mutation') throw new Error(`no ${kind}`);
        const m = data as Mutation;
        const staged = await replay.prepare(data, machine);
        return { ...staged, change: () => { applied.push(`${m.method} ${m.robot?.id ?? (m.params as { id: string }).id}`); staged.change(); } };
      },
      onInventory: async (inv, machine) => {
        if (o.syncAfterMs) await new Promise((resolve) => setTimeout(resolve, o.syncAfterMs));
        return router.reconcileWorker(inv, machine);
      },
      onCall: (method, params) => answer(method, params, ctx!),
      snapshot: () => ({ version: ++version, state: store.state, agentHomes: { claude: macClaude, codex: path.join(mac, '.codex'), opencode: path.join(mac, '.config/opencode') }, home: mac }),
      ...(mirror && { mirror }),
    });
    const router = new Router({ store, me: H, log: silentLogger, links });
    const fleet = new Fleet({ store, tmux: mortal(mac1.tmux, life) as unknown as Tmux, paths: homePaths, config, log: silentLogger, remote: router });
    ctx = { store, fleet, router, viewer: { kind: 'app', send: () => {}, backlog: () => 0 } } as unknown as Ctx;
    mac1.started = (id, sid) => fleet.emit('session-start', id, undefined, sid);
    const placement = new Placement({
      store: mortal(store, life), fleet: mortal(fleet, life), links: mortal(links, life), me: H, paths: homePaths,
      git: mortalGit(hooklessGit, life), agents: async () => [macProbe], release: RELEASE, homedir: mac,
      tmux: mortal(mac1.tmux, life) as unknown as Tmux, viewers, processes: mac1.processes, kill: mortal(mac1, life).kill, clock, log: silentLogger,
      moves: mortal(new MoveFiles(homePaths.moves), life), watchMs: 5000, cli: opencode.mac.run,
    });
    await fleet.reconcileNow();
    links.start();
    stops.push(() => placement.stop(), () => links.stop());
    const daemon = { store, fleet, links, router, placement, life };
    home = daemon;
    // one that dies on the way waits no longer
    await until(() => { if (!life.dead && !links.for(W)?.synced) throw new Error('w1 is not synced yet'); });
    return daemon;
  };

  return {
    base, g, mac, far, main, wt, wt2, notes, macClaude, farClaude, macOpencode, farOpencode, opencode, origin, mac1, vault, homePaths, workerPaths,
    /** where the worker's clone and the robot's worktree land */
    clone: path.join(far, 'code/app'),
    farWt: path.join(far, 'code/app/.claude/worktrees/kanban'),
    applied,
    /** the worker's daemon booted last */
    get worker() {
      if (!worker) throw new Error('no worker has booted');
      return worker;
    },
    /** the home's daemon booted last */
    get home() {
      if (!home) throw new Error('no home has booted');
      return home;
    },
    async start() {
      await bootWorker();
      return bootHome();
    },
    bootHome,
    bootWorker,
    async stop(): Promise<void> {
      for (const s of stops.splice(0).reverse()) await s();
      for (const f of ['code', '.claude', '.claude.json', '.svall']) fs.rmSync(path.join(far, f), { recursive: true, force: true });
    },
  };
}
export type MoveWorld = ReturnType<typeof moveWorld>;

// what `git worktree list` says of the worktree at `root`, or undefined when git lists none there
export function listed(w: MoveWorld, repo: string, root: string): { locked?: string } | undefined {
  const entries = w.g(repo, 'worktree', 'list', '--porcelain').split('\n\n');
  const entry = entries.find((e) => e.split('\n')[0] === `worktree ${realPath(root)}`);
  if (!entry) return undefined;
  const locked = entry.split('\n').find((l) => l.startsWith('locked'));
  return locked === undefined ? {} : { locked: locked.slice('locked'.length).trim() };
}

export const state = (w: MoveWorld, root: string) => ({
  head: w.g(root, 'rev-parse', 'HEAD'), branch: w.g(root, 'symbolic-ref', '--short', 'HEAD'),
  staged: w.g(root, 'diff', '--cached', '--name-status'), unstaged: w.g(root, 'diff', '--name-status'),
  // a credential file travels only when ticked
  untracked: w.g(root, 'ls-files', '--others', '--exclude-standard').split('\n').filter((f) => f && f !== '.env').sort(),
});
