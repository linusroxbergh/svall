import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { FleetConfig, FleetId, MachineId, OwnerRecord, type Character, type MethodName, type Outcome } from '@svall/protocol';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { loadConfig } from '../../src/config.js';
import { AuthorityClient } from '../../src/gateway/client.js';
import { AuthorityFailure } from '../../src/gateway/authority.js';
import { startAuthorityServer, type AuthorityServer } from '../../src/gateway/server.js';
import { DURABLE_TEMP, DurableJson } from '../../src/handover/durable.js';
import { FAILPOINTS, armFailpoints, type Edge, type Failpoint, type FailSide } from '../../src/handover/failpoints.js';
import { JournalFile, type HandoverJournal } from '../../src/handover/journal.js';
import { ProcessTable, type Proc } from '../../src/handover/processes.js';
import { ReplicaStore } from '../../src/handover/replicas.js';
import type { Clock } from '../../src/handover/rest.js';
import { HandoverService } from '../../src/handover/service.js';
import { adoptAtStart, enterStartupMode, startupMode } from '../../src/handover/startup.js';
import type { CliRun } from '../../src/handover/sessions/types.js';
import type { GitRunner } from '../../src/links/git.js';
import type { Logger } from '../../src/log.js';
import { guardMethod } from '../../src/ownership/guard.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { installedScripts, resolvePaths, type Paths } from '../../src/paths.js';
import { reconcile } from '../../src/reconcile.js';
import { Store } from '../../src/store.js';
import { Handover, Refused, type Daemon, type HandoverDeps, type Side } from '../../../cli/src/controller/handover.js';
import { gatewayOf } from '../../../cli/src/controller/reach.js';
import { fileStore, forgettable, type ControllerStore } from '../../../cli/src/controller/recovery.js';
import type { RunRsync } from '../../../cli/src/controller/rsync.js';
import { transfer as runTransfer, type Master } from '../../../cli/src/controller/transfer.js';
import { callSite } from '../../../cli/test/controller/world.js';
import { makeHome } from '../helpers.js';
import { held, hold, opencode } from './fake-opencode.js';

export const fleetId = FleetId.parse(crypto.randomUUID());
export const MAC = MachineId.parse(crypto.randomUUID());
export const TRIFT = MachineId.parse(crypto.randomUUID());
export const G = 0;
// di's Claude session, launched with a flag its resume has to carry
const SID = crypto.randomUUID();
const DI_LAUNCH = 'claude --effort high';
const DI_RESUME = `claude --effort 'high' --resume ${SID}`;
// cy's OpenCode session, dormant since before the handover
const CY_SESSION = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
const CY_MESSAGES = [{ id: 'msg_0', text: 'remember PELICAN-42' }, { id: 'msg_1', text: 'PELICAN-42' }];
// ed's OpenCode runs in its terminal, and its private server lingers once its window closes until it is killed
const ED_SESSION = 'ses_1a2b3c4d5e6fAbCdEfGhIjKlMn';
const ED_MESSAGES = [{ id: 'msg_0', text: 'remember HERON-7' }, { id: 'msg_1', text: 'HERON-7' }];
const ED_RESUME = `opencode -s ${ED_SESSION}`;
const OC_SERVER = 'opencode serve --stdio';

/** What a process that dies at a failpoint throws: nothing after it runs. */
export class Crash extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Crash';
  }
}

/** One run of one party, from its start to its death. */
export type Life = { side: FailSide; epoch: number; dead: boolean; open: Map<Failpoint, number> };
export const als = new AsyncLocalStorage<Life>();

const alive = (life: Life): void => {
  if (life.dead) throw new Crash(`${life.side} #${life.epoch} is gone`);
};

export const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const wire = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
const noGit: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

type Win = { windowId: string; paneId: string; pid: number; name: string; path: string; job?: string[]; ignoresTerm?: true };
const runsOpenCode = (x: Win): boolean => psArgs(x.job?.[0] ?? '').split(' ')[0] === 'opencode';
type Instance = { life: Life; ownership: OwnershipState; handover: HandoverService; store: Store; active: boolean; ctx: Ctx };

/** A daemon's journal that dies with it. */
class MortalJournal extends JournalFile {
  constructor(paths: Paths, private life: Life) { super(paths); }
  override write(j: HandoverJournal): void { alive(this.life); super.write(j); }
  override close(): void { alive(this.life); super.close(); }
}

/** A machine: its tmux server and processes, which outlive any daemon, and the daemon running there now. */
export class Machine {
  windows = new Map<string, Win>();
  /** the private server an OpenCode TUI left running when its window closed, by that window's name */
  servers: { name: string; row: Proc }[] = [];
  current?: Instance;
  private next = 1;

  /** this machine's OpenCode, which keeps its sessions in a database of its own */
  readonly opencode: NodeJS.ProcessEnv;

  constructor(private w: World, readonly name: 'mac' | 'trift', readonly id: MachineId, readonly side: 'source' | 'destination', readonly paths: Paths) {
    this.opencode = { XDG_DATA_HOME: path.join(w.base, `opencode-${name}`) };
  }

  /** The OpenCode double run in this process, as a crash may cut it off between any two commands. */
  cli: CliRun = async (_cmd, args, o) => {
    // what a lingering server writes after the export that travels reads its database never travels; a dry export only reads
    const travels = o?.stdout !== undefined && path.dirname(o.stdout) === path.join(this.w.opencodeLogs, 'exports');
    if (args.includes('export') && travels && this.servers.length) {
      this.w.fail(`${this.name} wrote out an OpenCode session while the server ${this.servers.map((x) => x.name).join(', ')} left still ran`);
    }
    const r = opencode(args, this.opencode);
    if (o?.stdout === undefined) return r;
    fs.writeFileSync(o.stdout, r.stdout, { mode: 0o600 });
    return { ...r, stdout: '' };
  };

  window(name: string, cwd: string, job?: string[]): Win {
    const n = this.next++;
    const win = { windowId: `@${n}`, paneId: `%${n}`, pid: n * 1000, name, path: cwd, ...(job && { job }) };
    this.windows.set(win.windowId, win);
    return win;
  }

  /** Whether the daemon here would create, attach or type into a terminal. */
  can(): boolean {
    const d = this.current;
    if (!d || d.life.dead) return false;
    try {
      for (const m of ['term.attach', 'char.create', 'term.input'] as MethodName[]) guardMethod(d.ownership, m, 'app');
      return true;
    } catch {
      return false;
    }
  }

  // what a daemon asks of its tmux: a dead one asks nothing, and a window or a job ends only inside a failpoint
  private acting(what: string, step = true): void {
    const life = als.getStore();
    if (life) alive(life);
    if (step) this.w.guarded(life, `${this.name} ${what}`);
  }

  tmux = {
    listWindows: async () => [...this.windows.values()].map((x) => ({
      windowId: x.windowId, paneId: x.paneId, panePid: x.pid, name: x.name, command: '', path: x.path, activity: 0, dead: false,
    })),
    sendBytes: async () => { this.acting('keys', false); },
    sendLine: async () => { this.acting('line', false); },
    capture: async () => Buffer.from(''),
    ensureServer: async () => {},
    killWindow: async (windowId: string) => {
      this.acting(`kill ${windowId}`);
      const x = this.windows.get(windowId);
      if (x && runsOpenCode(x)) this.servers.push({ name: x.name, row: { ...this.server(x), ppid: 1 } });
      this.windows.delete(windowId);
      this.w.check(`${this.name} kill ${windowId}`);
    },
  };

  processes = async (): Promise<ProcessTable> => new ProcessTable([...this.windows.values()].flatMap((p): Proc[] => {
    const group = p.job ? p.pid + 1 : p.pid;
    const shell = { pid: p.pid, ppid: 1, pgid: p.pid, tpgid: group, stat: 'Ss', args: '-zsh' };
    const job = (p.job ?? []).map((job, i) => ({ pid: group + i, ppid: i ? group + i - 1 : p.pid, pgid: group, tpgid: group, stat: 'S+', args: psArgs(job) }));
    return [shell, ...job, ...(runsOpenCode(p) ? [this.server(p)] : [])];
  }).concat(this.servers.map((x) => x.row)), installedScripts(this.paths.home));

  // an OpenCode TUI's private server, in a group of its own off the terminal
  private server(p: Win): Proc {
    return { pid: p.pid + 60, ppid: p.pid + p.job!.length, pgid: p.pid + 60, tpgid: 0, stat: 'Ss', args: OC_SERVER };
  }

  kill = (group: number, signal: NodeJS.Signals): void => {
    this.acting(`signal ${group}`);
    for (const p of this.windows.values()) if (p.job && p.pid + 1 === group && (signal === 'SIGKILL' || !p.ignoresTerm)) delete p.job;
    // a lingering server, stuck shutting down, ends only on SIGKILL
    if (signal === 'SIGKILL') this.servers = this.servers.filter((x) => x.row.pgid !== group);
  };

  /**
   * The fleet as the daemon `life` runs it: opening a terminal is idempotent, as the real one's is, runs the command
   * it revives with, keeps that command while a handover carries the terminal, and an agent resumed there reports its
   * SessionStart. Starting it, and reconciling it, takes back each window named for a terminal, as the real one does.
   */
  fleet(life: Life, store: Store, instance: () => Instance | undefined) {
    const started = new Set<(id: string, term: 2 | undefined, sessionId: string) => void>();
    let carried: (id: string, term?: 2) => boolean = () => false;
    const reconcileNow = async () => {
      alive(life);
      if (!instance()?.ownership.writable()) return;
      store.update(reconcile(store.state, await this.tmux.listWindows(), this.w.now, undefined, carried).mutate);
    };
    const open = async (id: string, term?: 2) => {
      alive(life);
      const key = term ? `${id}-2` : id;
      this.w.guarded(life, `${this.name} open ${key}`);
      this.w.opened(this, key);
      if (this.servers.some((x) => x.name === key)) this.w.fail(`${this.name} opened ${key} beside the OpenCode server its closed window left running`);
      const c = store.state.characters[id];
      const slot = term ? c.second : c;
      if (slot?.tmux) return c;
      const command = slot?.revive?.command;
      // a window its main terminal left is gone back to, and nothing is run in it; a second terminal always opens a new one
      const left = term ? undefined : [...this.windows.values()].find((x) => x.name === key);
      const win = left ?? this.window(key, (term ? c.second?.cwd : undefined) ?? c.cwd, command ? [command] : undefined);
      const session = !left && command && slot?.agent?.sessionId;
      if (session) setImmediate(() => { if (!life.dead) for (const fn of started) fn(id, term, session); });
      store.update((d) => {
        const cur = d.characters[id];
        const s = term ? (cur.second ??= { cwd: cur.cwd, unread: false }) : cur;
        s.tmux = { windowId: win.windowId, paneId: win.paneId };
        if (!carried(id, term)) delete s.revive;
        delete s.resumeError;
      });
      this.w.check(`${this.name} opened ${key}`);
      return store.state.characters[id];
    };
    return {
      settle: async () => {},
      activate: async () => {
        alive(life);
        this.w.activated(this);
        const d = instance();
        if (d) d.active = true;
        await reconcileNow();
      },
      deactivate: async () => {
        alive(life);
        this.w.guarded(life, `${this.name} deactivate`);
        const d = instance();
        if (d) d.active = false;
        this.windows.clear();
      },
      reconcileNow,
      // every agent here is idle, so none is ever cut off mid-turn
      resumeInterrupted: async () => {},
      reviveCharacter: (id: string) => open(id),
      openSecond: (id: string) => open(id, 2),
      onSessionStart: (fn: (id: string, term: 2 | undefined, sessionId: string) => void) => {
        started.add(fn);
        return () => { started.delete(fn); };
      },
      carries: (fn: (id: string, term?: 2) => boolean) => { carried = fn; },
    };
  }
}

/** What ps prints for a command `sh -c` ran: its words, single quotes and backslashes taken off, joined by spaces. */
const psArgs = (command: string): string =>
  (command.match(/(?:'[^']*'|\\.|[^\s'\\])+/g) ?? []).map((w) => w.replace(/'([^']*)'|\\(.)/g, (_, quoted, escaped) => quoted ?? escaped)).join(' ');

const char = (id: string, cwd: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

export type Target = { name: Failpoint; edge: Edge; nth: number };
export type Heal = 'crashed' | 'all';

/**
 * What can befall one request of the controller: its answer lost, the request lost, the request delivered twice,
 * the request held back until its retry has been answered, or its party cut off from the controller until recovery.
 */
export type MessageKind = 'lost' | 'dropped' | 'duplicate' | 'stale' | 'partition';
/** Where a controller runs: its machine, and the folder it keeps its journal in. */
export type Seat = { local: MachineId; dir: string };

/** A request that went unanswered for a reason of the network's, as against its party's refusal. */
class Unanswered extends Error {}

/**
 * Both machines, their daemons, the gateway's authority on its socket and a controller, sharing one home path as
 * the two machines of a handover do, with every durable file real. A target crashes the party that reaches it.
 */
export class World {
  readonly base = fs.realpathSync(makeHome());
  readonly home = path.join(this.base, 'home');
  readonly prefix = path.join(this.base, 'gw');
  readonly ctlDir = path.join(this.base, 'ctl');
  readonly claudeHome = path.join(this.home, '.claude');
  /** where Svall's plugin logs OpenCode sessions, in the one home both machines share */
  readonly opencodeLogs = path.join(this.home, '.svall/transcripts/opencode');
  readonly cy = path.join(this.home, 'work/cy');
  readonly ed = path.join(this.home, 'work/ed');
  readonly mac: Machine;
  readonly trift: Machine;
  violations: string[] = [];
  /** what a living daemon logged as an error */
  errors: string[] = [];
  trace: string[] = [];
  hits = new Map<string, number>();
  targets: Target[] = [];
  struck: string[] = [];
  onHit?: (key: string) => void;
  everMoved = false;
  /** every handover the gateway's record has named, as read at each step */
  transactions = new Set<string>();
  /** the gateway is out of reach, as against dead: nothing restarts it until a test brings it back */
  away = false;
  now = 1000;
  private epoch = 0;
  private watching = false;
  private server?: AuthorityServer;
  private closing?: Promise<void>;
  gatewayLife: Life = this.life('gateway');
  controllerLife: Life = this.life('controller');
  /** every request a controller sent, as `<party> <name>`, in the order sent */
  requests: string[] = [];
  /** the controller's source line each of `requests` was sent from */
  sites: (number | undefined)[] = [];
  /** the fault on the request at this index of `requests` */
  message?: { at: number; kind: MessageKind };
  /** awaited before a controller's `n`th request goes out, so a test can run another controller there */
  gate?: (at: { life: Life; n: number; label: string }) => Promise<void>;
  /** how each controller made from here on answers a blocker; with none, it cancels */
  decide?: HandoverDeps['decide'];
  /** the folder of every controller this world has run */
  readonly dirs = new Set<string>([this.ctlDir]);
  /** the parties cut off from every controller until recovery */
  readonly cut = new Set<string>();
  private held: { party: string; send: () => Promise<unknown> }[] = [];
  private sent = new Map<Life, number>();
  private lives = new WeakMap<Handover, Life>();

  constructor() {
    this.mac = new Machine(this, 'mac', MAC, 'source', resolvePaths(path.join(this.base, 'mac')));
    this.trift = new Machine(this, 'trift', TRIFT, 'destination', resolvePaths(path.join(this.base, 'trift')));
  }

  static async create(): Promise<World> {
    const w = new World();
    for (const d of ['work/ada', 'work/bo', 'work/cy', 'work/di', 'work/ed', 'mc', '.claude/projects/-work-di']) fs.mkdirSync(path.join(w.home, d), { recursive: true });
    fs.writeFileSync(path.join(w.home, 'work/ada/notes.md'), 'ada\n');
    fs.writeFileSync(path.join(w.home, 'work/bo/index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(w.home, 'work/di/plan.md'), 'di\n');
    fs.writeFileSync(path.join(w.home, 'mc/README.md'), 'mission control\n');
    const transcript = path.join(w.claudeHome, 'projects/-work-di', `${SID}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: SID, cwd: path.join(w.home, 'work/di') })}\n`);
    fs.writeFileSync(path.join(w.claudeHome, '.claude.json'), JSON.stringify({ projects: { [path.join(w.home, 'work/di')]: { hasTrustDialogAccepted: true } } }));
    const cyLog = path.join(w.opencodeLogs, `${CY_SESSION}.jsonl`);
    fs.mkdirSync(w.opencodeLogs, { recursive: true });
    fs.writeFileSync(cyLog, `${JSON.stringify({ kind: 'user', text: 'remember PELICAN-42' })}\n`);
    hold(w.mac.opencode, { info: { id: CY_SESSION, location: { directory: w.cy } }, messages: CY_MESSAGES });
    const edLog = path.join(w.opencodeLogs, `${ED_SESSION}.jsonl`);
    fs.writeFileSync(edLog, `${JSON.stringify({ kind: 'user', text: 'remember HERON-7' })}\n`);
    hold(w.mac.opencode, { info: { id: ED_SESSION, location: { directory: w.ed } }, messages: ED_MESSAGES });
    // trift keeps the copy an earlier handover left there, which the session has gone on past since
    hold(w.trift.opencode, { info: { id: CY_SESSION, location: { directory: w.cy } }, messages: CY_MESSAGES.slice(0, 1) });
    fs.mkdirSync(w.ctlDir, { recursive: true });
    for (const m of [w.mac, w.trift]) {
      fs.mkdirSync(m.paths.home, { recursive: true });
      fs.writeFileSync(m.paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, gatewayMachineId: TRIFT, home: { cwd: '~/mc' } })));
      fs.writeFileSync(m.paths.owner, JSON.stringify({ fleetId, generation: G, ownerMachineId: MAC }));
    }
    const work = (p: string) => path.join(w.home, 'work', p);
    const [ada, adaSecond, bo, di, ed] = [
      w.mac.window('c_ada', work('ada')), w.mac.window('c_ada-2', work('ada')), w.mac.window('c_bo', work('bo'), ['npm run dev']), w.mac.window('c_di', work('di'), [DI_LAUNCH]),
      w.mac.window('c_ed', work('ed'), ['opencode']),
    ];
    // bo's dev server holds on through a SIGTERM
    bo.ignoresTerm = true;
    // trift sealed cy once, and a file it held then has gone since: a diverged root, which the handover archives
    new ReplicaStore({ fleetId, paths: w.trift.paths }).seal({ id: 'cy', kind: 'cwd', entry: 'dir', path: w.cy }, {
      transactionId: crypto.randomUUID(), generation: G, manifestDigest: '0'.repeat(64),
      files: [{ type: 'file', path: 'draft.md', mode: 0o644, size: 3, mtimeMs: 0, sha256: '0'.repeat(64) }],
    }, 'source');
    const store = Store.load(w.mac.paths.state, () => {});
    store.update((d) => {
      for (const c of [
        char('c_ada', work('ada'), { tmux: { windowId: ada.windowId, paneId: ada.paneId }, second: { cwd: work('ada'), unread: false, tmux: { windowId: adaSecond.windowId, paneId: adaSecond.paneId } } }),
        char('c_bo', work('bo'), { tmux: { windowId: bo.windowId, paneId: bo.paneId } }),
        char('c_cy', work('cy'), {
          agent: { kind: 'opencode', sessionId: CY_SESSION, transcriptPath: cyLog, status: 'idle', lastActivityAt: 0 }, revive: { command: `opencode -s ${CY_SESSION}` },
        }),
        char('c_di', work('di'), {
          tmux: { windowId: di.windowId, paneId: di.paneId }, agent: { kind: 'claude', sessionId: SID, transcriptPath: transcript, status: 'idle', lastActivityAt: 0 },
        }),
        char('c_ed', work('ed'), {
          tmux: { windowId: ed.windowId, paneId: ed.paneId }, agent: { kind: 'opencode', sessionId: ED_SESSION, transcriptPath: edLog, status: 'idle', lastActivityAt: 0 },
        }),
      ]) d.characters[c.id] = c;
    });
    await w.startGateway();
    const client = await AuthorityClient.connect(w.prefix);
    try { await client.create({ fleetId, initialOwnerMachineId: MAC }); } finally { client.close(); }
    await w.boot(w.mac);
    await w.boot(w.trift);
    w.watching = true;
    return w;
  }

  private life(side: FailSide): Life {
    return { side, epoch: ++this.epoch, dead: false, open: new Map() };
  }

  // ---- failpoints

  hit(name: Failpoint, edge: Edge | 'threw'): void {
    const side = FAILPOINTS[name];
    // the gateway's socket handlers carry no async context of their own
    const life = side === 'gateway' ? this.gatewayLife : als.getStore() ?? this.lifeOf(side);
    if (edge === 'threw') {
      life.open.set(name, (life.open.get(name) ?? 0) - 1);
      return;
    }
    // a dead gateway's answer never goes out: its sockets are gone, and a throw there would reach nothing
    const contained = name !== 'gateway.commit.respond';
    if (life.dead) {
      if (contained) throw new Crash(`${life.side} #${life.epoch} is gone`);
      return;
    }
    if (life.side !== side) this.fail(`${name} ran on the ${life.side}`);
    life.open.set(name, (life.open.get(name) ?? 0) + (edge === 'before' ? 1 : -1));
    const key = `${name}:${edge}`;
    const count = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, count);
    this.trace.push(key);
    this.check(key);
    this.onHit?.(key);
    const t = this.targets[0];
    if (t?.name === name && t.edge === edge && t.nth === count) {
      this.targets.shift();
      this.struck.push(`${key}#${count}`);
      this.trace.push(`CRASH ${life.side} #${life.epoch}`);
      this.kill(life);
      if (contained) throw new Crash(`${life.side} crashed at ${key}`);
    }
  }

  private lifeOf(side: FailSide): Life {
    if (side === 'gateway') return this.gatewayLife;
    if (side === 'controller') return this.controllerLife;
    return (side === 'source' ? this.mac : this.trift).current!.life;
  }

  private kill(life: Life): void {
    life.dead = true;
    if (life.side === 'gateway') this.stopGateway();
  }

  /** A durable write, or a terminal closed or opened, that no failpoint surrounds is a step no case can crash at. */
  guarded(life: Life | undefined, what: string): void {
    if (!this.watching || !life) return;
    if (![...life.open.values()].some((n) => n > 0)) this.fail(`${what} by the ${life.side} ran outside every failpoint`);
  }

  /** Every rename, link or removal under a fleet home, the gateway's or the controller's is a step of the handover. */
  written(file: string, how: string, from?: string): void {
    if (!this.watching) return;
    const rel = path.relative(this.base, file);
    if (!/^(mac|trift|gw|ctl|ctl-trift)\//.test(rel)) return;
    // a durable write's temp is part of that write, state.json is written on every change but its promotion, and every
    // read of the gateway that finds its record lifts a quarantine
    if (DURABLE_TEMP.test(rel) || /^gw\/.*\.quarantined$/.test(rel)) return;
    if (/^(mac|trift)\/state\.json$/.test(rel) && !(from && path.basename(from).startsWith('prepared-'))) return;
    const life = rel.startsWith('gw/') ? this.gatewayLife : als.getStore();
    if (!life) this.fail(`${how} of ${rel} outside every party`);
    else this.guarded(life, `${how} of ${rel}`);
  }

  // ---- the invariant

  fail(why: string): void {
    this.violations.push(why);
  }

  record(): OwnerRecord {
    const r = new DurableJson(OwnerRecord, path.join(this.prefix, 'gateway', 'fleets', `${fleetId}.json`)).read();
    if (!r.ok) throw new Error(`the gateway's record cannot be read: ${r.reason}`);
    if (r.value.transaction) this.transactions.add(r.value.transaction.id);
    return r.value;
  }

  moved(): boolean {
    const r = this.record();
    return r.ownerMachineId === TRIFT && r.generation > G;
  }

  /** At most one machine may run terminals; before the commit only the source, after it only the destination. */
  check(at: string): void {
    if (!this.watching) return;
    const moved = this.moved();
    if (moved) this.everMoved = true;
    const [src, dst] = [this.mac.can(), this.trift.can()];
    if (src && dst) this.fail(`both machines may run terminals (${at})`);
    if (moved && src) this.fail(`the source may run terminals after the commit (${at})`);
    if (!moved && dst) this.fail(`the destination may run terminals before the commit (${at})`);
    if (!moved && this.trift.windows.size) this.fail(`the destination holds a window before the commit (${at})`);
    if (this.mac.windows.size && this.trift.windows.size) this.fail(`both machines hold windows (${at})`);
  }

  opened(m: Machine, key: string): void {
    const moved = this.moved();
    if (m === this.mac && moved) this.fail(`the source opened ${key} after the commit`);
    if (m === this.trift && !moved) this.fail(`the destination opened ${key} before the commit`);
  }

  activated(m: Machine): void {
    const moved = this.moved();
    if (m === this.mac && moved) this.fail('the source started its fleet after the commit');
    if (m === this.trift && !moved) this.fail('the destination started its fleet before the commit');
  }

  // ---- the parties

  async startGateway(): Promise<void> {
    await this.closing;
    this.away = false;
    this.gatewayLife = this.life('gateway');
    this.server = await startAuthorityServer({ prefix: this.prefix });
  }

  stopGateway(): void {
    this.gatewayLife.dead = true;
    this.closing = this.server?.close();
    this.server = undefined;
  }

  loseGateway(): void {
    this.away = true;
    this.stopGateway();
  }

  private async authorityGet(id: FleetId): Promise<OwnerRecord> {
    const client = await AuthorityClient.connect(this.prefix, { timeoutMs: 5000 });
    try { return await client.get({ fleetId: id }); } finally { client.close(); }
  }

  /** Starts the daemon on `m` from what its disk holds, as main does, until a start survives. */
  async boot(m: Machine): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.bootOnce(m);
        return;
      } catch (e) {
        if (!(e instanceof Crash) || attempt >= 3) throw e;
        await settle();
      }
    }
  }

  private async bootOnce(m: Machine): Promise<void> {
    const life = this.life(m.side);
    const log: Logger = { info() {}, error: (msg) => { if (!life.dead) this.errors.push(`${m.name}: ${msg}`); } };
    await als.run(life, async () => {
      const { paths } = m;
      const ownership = OwnershipState.load({ paths, fleetId, machineId: m.id, log });
      const store = Store.load(paths.state, () => {});
      const mortal = {
        get state() { return store.state; },
        update: (fn: Parameters<Store['update']>[0]) => { alive(life); return store.update(fn); },
        promote: (file: string) => { alive(life); return store.promote(file); },
        reload: () => { alive(life); return store.reload(); },
        subscribe: (fn: Parameters<Store['subscribe']>[0]) => store.subscribe(fn),
      } as Store;
      let instance: Instance | undefined;
      const fleet = m.fleet(life, mortal, () => instance);
      const config = loadConfig(paths);
      const clock: Clock = {
        now: () => this.now,
        sleep: (ms, signal) => new Promise((r) => setImmediate(() => { if (!signal?.aborted) { this.now += ms; r(); } })),
      };
      const authority = () => ({ get: (id: FleetId) => this.authorityGet(id) });
      const handover = new HandoverService({
        ownership, journal: new MortalJournal(paths, life), fleet,
        agents: async () => [
          { kind: 'claude', version: '2.1.280', home: this.claudeHome, loggedIn: true, hooks: true },
          { kind: 'opencode', version: '2.0.22', home: this.opencodeLogs, loggedIn: true, hooks: true },
        ],
        source: {
          paths, store: mortal, fleet, tmux: m.tmux, viewers: { detach: async () => {} }, processes: m.processes, kill: m.kill, clock, authority, git: noGit,
          rest: { pollMs: 500, settleMs: 1000, waitMs: 5000 }, cli: m.cli, log,
        },
        destination: {
          paths, config, store: mortal, fleet, tmux: m.tmux, processes: m.processes, authority, clock, git: noGit,
          homedir: () => this.home, sessionStartMs: 60_000, concurrency: 1, cli: m.cli, log,
        },
      });
      instance = { life, ownership, handover, store, active: false, ctx: { ownership, handover, viewer: { kind: 'app' } } as unknown as Ctx };
      const journal = handover.journalState();
      await enterStartupMode(startupMode({ ownership, journal, config }), { ownership, journal, log, standalone: false });
      await adoptAtStart({ handover, authority: authority(), fleetId, log, timeoutMs: 2000 });
      // what Fleet.start does: only a writable daemon runs its fleet
      if (ownership.writable()) await fleet.activate();
      // its API answers only now, so only now can anyone reach it
      m.current = instance;
    });
    this.trace.push(`BOOT ${m.name} #${life.epoch}`);
    this.check(`${m.name} started`);
  }

  /** One request of a controller to `party`, struck by the message fault aimed at it; a request held back goes out after the next one there. */
  private async request<T>(party: string, name: string, send: () => Promise<T>): Promise<T> {
    // read before the gate's await, while the controller's own frame is still on the stack
    const site = callSite();
    const life = als.getStore();
    if (life && this.gate) {
      const n = this.sent.get(life) ?? 0;
      this.sent.set(life, n + 1);
      await this.gate({ life, n, label: `${party} ${name}` });
      alive(life);
    }
    const unanswered = (why: string) => new Unanswered(`${party} did not answer ${name}: ${why}`);
    if (this.cut.has(party)) throw unanswered('connection refused');
    const k = this.requests.push(`${party} ${name}`) - 1;
    this.sites[k] = site;
    const kind = this.message?.at === k ? this.message.kind : undefined;
    if (kind) this.trace.push(`${kind.toUpperCase()} ${party} ${name}`);
    if (kind === 'dropped') throw unanswered('connection reset');
    if (kind === 'partition') {
      this.cut.add(party);
      throw unanswered('connection refused');
    }
    if (kind === 'stale') {
      this.held.push({ party, send });
      throw unanswered('no answer in time');
    }
    let answer: { ok: true; value: T } | { ok: false; error: unknown };
    try { answer = { ok: true, value: await send() }; } catch (error) { answer = { ok: false, error }; }
    await this.release(party);
    if (kind === 'duplicate') await send().catch(() => undefined);
    if (kind === 'lost') throw unanswered('the connection dropped before the answer');
    if (!answer.ok) throw answer.error;
    return answer.value;
  }

  /** Delivers what was held back from `party`, or from every party, its answers going nowhere. */
  private async release(party?: string): Promise<void> {
    const due = this.held.filter((h) => party === undefined || h.party === party);
    this.held = this.held.filter((h) => !due.includes(h));
    for (const h of due) {
      this.trace.push(`LATE ${h.party}`);
      await h.send().catch(() => undefined);
    }
  }

  /** Every party answers the controller again, and what was held back arrives. */
  async reconnect(): Promise<void> {
    this.message = undefined;
    this.cut.clear();
    await this.release();
  }

  private daemon(m: Machine, ctl: Life): Daemon {
    const call = async (method: MethodName, params: unknown): Promise<unknown> => {
      alive(ctl);
      return this.request(m.name, method, async () => {
        const d = m.current;
        if (!d || d.life.dead) throw new Error(`${m.name} did not answer ${method}: connection refused`);
        this.trace.push(`${m.name} ${method}`);
        const res = await als.run(d.life, () => dispatch({ id: 1, method, params: wire(params) } as never, d.ctx));
        if (d.life.dead) throw new Error(`${m.name} dropped the connection before it answered ${method}`);
        this.check(`${m.name} answered ${method}`);
        if ('error' in res) throw new Refused(res.error.code, res.error.message, res.error.data as Record<string, unknown> | undefined);
        return wire(res.result);
      });
    };
    return { call: call as Daemon['call'] };
  }

  private async gatewayOp(op: string, id: FleetId, params?: Record<string, unknown>) {
    let client: AuthorityClient;
    try { client = await AuthorityClient.connect(this.prefix, { timeoutMs: 5000 }); } catch (e) {
      return { error: { code: 'disconnected', message: String(e) } };
    }
    try {
      return { record: await client.call(`owner.${op}` as never, { fleetId: id, ...params }) };
    } catch (e) {
      if (e instanceof AuthorityFailure) return { error: { code: e.code, message: e.message, ...(e.data && { data: e.data }) } };
      throw e;
    } finally {
      client.close();
      this.check(`gateway ${op}`);
    }
  }

  /** Where a controller on trift keeps its journal. */
  get triftSeat(): Seat {
    return { local: TRIFT, dir: path.join(this.base, 'ctl-trift') };
  }

  /** A new controller process on `seat`, reading its journal from disk, whose every call dies with it. */
  controller(seat: Seat = { local: MAC, dir: this.ctlDir }): Handover {
    const life = (this.controllerLife = this.life('controller'));
    this.dirs.add(seat.dir);
    const inner = fileStore(seat.dir);
    const store: ControllerStore = {
      read: (aside) => inner.read(aside),
      write: (j) => { alive(life); inner.write(j); },
      saveManifest: (tx, m) => { alive(life); inner.saveManifest(tx, m); },
      manifest: (tx, digest) => inner.manifest(tx, digest),
      saveLanded: (tx, l) => { alive(life); inner.saveLanded(tx, l); },
      landed: (tx, digest) => inner.landed(tx, digest),
      clear: (tx) => { alive(life); inner.clear(tx); },
    };
    const gateway = gatewayOf(async (op, id, params) => {
      alive(life);
      return this.request('gateway', op, () => {
        this.trace.push(`gateway ${op}`);
        return this.gatewayOp(op, id, params);
      });
    }, fleetId);
    // an rsync the link dropped under ends as ssh ends one, with 255
    const link = async <T>(name: string, send: () => Promise<T>, cut: (why: string) => T): Promise<T> => {
      alive(life);
      try {
        return await this.request('link', name, send);
      } catch (e) {
        if (e instanceof Unanswered) return cut(e.message);
        throw e;
      }
    };
    const master: Master = {
      socket: path.join(seat.dir, 'ssh'), check: async () => true,
      run: (argv) => link(argv.join(' '), async () => ({ code: 0, signal: null, stdout: argv[0] === 'rsync' ? 'rsync  version 3.2.7  protocol version 31\n' : '', stderr: '', truncated: false }),
        (why) => ({ code: 255, signal: null, stdout: '', stderr: why, truncated: false })),
    };
    const route = (id: MachineId): Side['route'] => {
      const name = (id === MAC ? this.mac : this.trift).name;
      return { machineId: id, name, ...(id !== seat.local && { ssh: name }) };
    };
    const side = async (id: MachineId): Promise<Side> => {
      const m = id === MAC ? this.mac : this.trift;
      const far = id !== seat.local;
      return {
        route: route(id),
        daemon: this.daemon(m, life), home: this.home, fleetHome: m.paths.home,
        ...(far && { master: async () => master }),
      };
    };
    // both machines share one disk here, so every root already lies where rsync would put it; a session's files go to its stage
    const rsync: RunRsync = (_rsync, argv) => link(argv.includes('--dry-run') ? 'rsync --dry-run' : 'rsync', async () => {
      const list = argv.find((a) => a.startsWith('--files-from='))?.slice('--files-from='.length);
      if (list && !argv.includes('--dry-run')) {
        const [from, to] = argv.slice(-2).map((p) => p.replace(/^[^/]*:/, ''));
        for (const file of fs.readFileSync(list, 'utf8').split('\0').filter(Boolean)) {
          fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
          fs.copyFileSync(path.join(from, file), path.join(to, file));
        }
      }
      return { code: 0, signal: null, stderr: '' };
    }, (why) => ({ code: 255, signal: null, stderr: `rsync: connection unexpectedly closed (${why})` }));
    const c = new Handover({
      fleetId, store, gateway, local: seat.local, machines: [MAC, TRIFT], side, route,
      transfer: (o) => runTransfer({ ...o, deps: { run: rsync } }), rsync: async () => '/usr/bin/rsync', stateDir: seat.dir,
      clock: { now: () => this.now, sleep: async () => {} }, retry: { attempts: 3, firstDelayMs: 1 }, ...(this.decide && { decide: this.decide }),
    });
    this.lives.set(c, life);
    return c;
  }

  /** Runs a controller call in that controller's own process: `c`'s, or the one made last. */
  run<T>(work: () => Promise<T>, c?: Handover): Promise<T> {
    return als.run(c ? this.lives.get(c)! : this.controllerLife, work);
  }

  /** The life of controller `c`, for a gate to tell controllers apart. */
  lifeOfController(c: Handover): Life {
    return this.lives.get(c)!;
  }

  /** Every party that died starts again from its disk, or with `all`, every party does. */
  async heal(how: Heal): Promise<void> {
    await settle();
    if (!this.away && (how === 'all' || this.gatewayLife.dead)) {
      if (!this.gatewayLife.dead) this.stopGateway();
      await this.startGateway();
    }
    for (const m of [this.mac, this.trift]) {
      if (how === 'all' || m.current?.life.dead) {
        if (m.current) m.current.life.dead = true;
        await this.boot(m);
      }
    }
  }

  /**
   * New controllers on `seat`, each doing what `svall handover status` says is safe, preferring `prefer`, until
   * nothing is open; a journal status calls superseded is forgotten, as `--forget` does.
   */
  async recover(prefer: 'resume' | 'abort', seat?: Seat): Promise<string[]> {
    const said: string[] = [];
    await this.reconnect();
    for (let i = 0; i < 6; i++) {
      // whatever died meanwhile starts again, as launchd starts a daemon again
      await this.heal('crashed');
      const c = this.controller(seat);
      const { observation, verdict } = await this.run(() => c.status());
      said.push(`${verdict.standing}:${verdict.safe.join('+') || '-'}`);
      if (this.moved() && verdict.safe.includes('abort')) this.fail(`status offers an abort after the commit (${verdict.reason})`);
      if (verdict.action === 'none') {
        if (verdict.standing === 'superseded' && forgettable(observation, verdict).ok) {
          const id = verdict.transactionId ?? observation.controller?.transactionId;
          await this.run(async () => fileStore(seat?.dir ?? this.ctlDir).clear(id));
          said.push('forget');
          continue;
        }
        if (verdict.standing !== 'none') this.fail(`nothing is safe: ${verdict.reason}`);
        return said;
      }
      const act = ([prefer, prefer === 'abort' ? 'resume' : 'abort'] as const).find((a) => verdict.safe.includes(a));
      if (!act) {
        this.fail(`status offers nothing to do, yet says ${verdict.action} (${verdict.reason})`);
        return said;
      }
      const out: Outcome = await this.run(() => (act === 'abort' ? c.abort() : c.resume()));
      said.push(`${act}->${out.status}`);
      this.check(`after ${act}`);
    }
    this.fail(`no controller settled the handover: ${said.join(' ')}`);
    return said;
  }

  async stop(): Promise<void> {
    this.stopGateway();
    await this.closing;
  }
}

/** Everything under `dir`, by its path there. */
export const entries = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).sort() : []);

/**
 * Where the fleet came to rest: whole on one machine, nothing open anywhere, no file a transaction wrote left behind,
 * and only the terminals the handover stopped running.
 */
export function settledOn(w: World): 'source' | 'destination' {
  const record = w.record();
  const where = record.generation === G ? 'source' : 'destination';
  const [owner, other] = where === 'source' ? [w.mac, w.trift] : [w.trift, w.mac];
  expect(record).toEqual({ fleetId, generation: where === 'source' ? G : G + 1, ownerMachineId: owner.id });
  for (const m of [w.mac, w.trift]) {
    expect(m.current!.handover.journalState(), m.name).toEqual({ kind: 'none' });
    expect(entries(m.paths.handoverDir), m.name).toEqual([]);
  }
  expect(owner.can()).toBe(true);
  expect(owner.current!.active).toBe(true);
  expect(other.can()).toBe(false);
  // a fleet coming back to it later starts afresh there
  expect(other.current!.active).toBe(false);
  expect(other.current!.ownership.record()).toMatchObject({ generation: record.generation, ownerMachineId: owner.id });
  expect([...owner.windows.values()].map((x) => x.name).sort()).toEqual(['c_ada', 'c_ada-2', 'c_bo', 'c_di', 'c_ed']);
  // di's Claude runs as it was launched, or resumed with the flags it was launched with
  expect([DI_LAUNCH, DI_RESUME]).toContain([...owner.windows.values()].find((x) => x.name === 'c_di')?.job?.join(' | '));
  expect(['opencode', ED_RESUME]).toContain([...owner.windows.values()].find((x) => x.name === 'c_ed')?.job?.join(' | '));
  expect(other.windows.size).toBe(0);
  for (const m of [w.mac, w.trift]) expect(m.servers, m.name).toEqual([]);
  // cy's and ed's OpenCode sessions are in the OpenCode of the machine running the fleet, each in its character's folder
  expect(held(owner.opencode)[CY_SESSION]).toEqual({ info: { id: CY_SESSION, location: { directory: w.cy } }, messages: CY_MESSAGES });
  expect(held(owner.opencode)[ED_SESSION]).toEqual({ info: { id: ED_SESSION, location: { directory: w.ed } }, messages: ED_MESSAGES });
  // and the other machine's OpenCode keeps a copy: the one the source carried, or the destination's own or the one that came
  expect(held(other.opencode)[CY_SESSION]?.messages[0], other.name).toEqual(CY_MESSAGES[0]);
  // the folder that holds each transaction's own may stay, empty, and a journal a controller could not read stays for a person to look at
  for (const dir of w.dirs) expect(entries(dir).filter((e) => e !== 'handover' && !e.startsWith('handover.json.broken-')), dir).toEqual([]);
  expect(entries(w.base).filter((e) => [...w.transactions].some((tx) => e.includes(tx)))).toEqual([]);
  expect(w.errors).toEqual([]);
  return where;
}

/** A world for each test, whose durable writes are watched, and whose failpoints are armed once it stands. */
export function worlds(): () => World {
  let w: World | undefined;
  let watched: World | undefined;
  let disarm = () => {};
  beforeEach(async () => {
    // a crash here never loses the page cache, so an fsync proves nothing and only costs time
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
    const rename = fs.renameSync.bind(fs);
    const link = fs.linkSync.bind(fs);
    const rm = fs.rmSync.bind(fs);
    const unlink = fs.unlinkSync.bind(fs);
    const rmdir = fs.rmdirSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { watched?.written(String(to), 'rename', String(from)); rename(from, to); });
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => { watched?.written(String(to), 'link'); link(from, to); });
    vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => { watched?.written(String(p), 'removal'); rm(p, o); });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => { watched?.written(String(p), 'removal'); unlink(p); });
    vi.spyOn(fs, 'rmdirSync').mockImplementation((p, o) => { watched?.written(String(p), 'removal'); rmdir(p, o); });
    watched = w = await World.create();
    disarm = armFailpoints((name, edge) => w!.hit(name, edge));
  });
  afterEach(async () => {
    disarm();
    watched = undefined;
    await w?.stop();
    vi.restoreAllMocks();
  });
  return () => w!;
}

export type Scenario = 'move' | 'abort' | 'cancel';

/** What the user chose: to end bo's dev server, and to archive the diverged cy. */
export const choices = (w: World) => ({ terminateShells: true, archiveRoots: [w.cy] });

/** The first run: a handover to trift, or one the user cancels once the destination has prepared, or during the transfer, which aborts it. */
export async function play(w: World, scenario: Scenario): Promise<Outcome> {
  const c = w.controller();
  const cancelAt = { move: undefined, abort: 'destination.prepare.journal:after', cancel: 'controller.rsync:after' }[scenario];
  if (cancelAt) w.onHit = (key) => { if (key === cancelAt) { w.onHit = undefined; c.cancel(); } };
  try {
    return await w.run(() => c.start(TRIFT, choices(w)));
  } finally {
    w.onHit = undefined;
  }
}
