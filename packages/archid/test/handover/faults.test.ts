import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetConfig, FleetId, MachineId, OwnerRecord, type Character, type MethodName } from '@archipelago/protocol';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { loadConfig } from '../../src/config.js';
import { AuthorityClient } from '../../src/gateway/client.js';
import { AuthorityFailure } from '../../src/gateway/authority.js';
import { startAuthorityServer, type AuthorityServer } from '../../src/gateway/server.js';
import { DURABLE_TEMP, DurableJson, writeDurable } from '../../src/handover/durable.js';
import { FAILPOINTS, armFailpoints, boundary, type Edge, type Failpoint, type FailSide } from '../../src/handover/failpoints.js';
import { JournalFile, type HandoverJournal } from '../../src/handover/journal.js';
import { ProcessTable, type Proc } from '../../src/handover/processes.js';
import { ReplicaStore } from '../../src/handover/replicas.js';
import type { Clock } from '../../src/handover/rest.js';
import { HandoverService } from '../../src/handover/service.js';
import { adoptAtStart, enterStartupMode, startupMode } from '../../src/handover/startup.js';
import type { GitRunner } from '../../src/links/git.js';
import type { Logger } from '../../src/log.js';
import { guardMethod } from '../../src/ownership/guard.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { installedScripts, resolvePaths, type Paths } from '../../src/paths.js';
import { reconcile } from '../../src/reconcile.js';
import { Store } from '../../src/store.js';
import type { Outcome } from '../../../cli/src/controller/events.js';
import { Handover, Refused, type Daemon, type Side } from '../../../cli/src/controller/handover.js';
import { gatewayOf } from '../../../cli/src/controller/reach.js';
import { fileStore, type ControllerStore } from '../../../cli/src/controller/recovery.js';
import type { RunRsync } from '../../../cli/src/controller/rsync.js';
import { transfer as runTransfer, type Master } from '../../../cli/src/controller/transfer.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const REPO = path.join(import.meta.dirname, '../../../..');
const NAMES = Object.keys(FAILPOINTS) as Failpoint[];

describe('the failpoint registry', () => {
  it('runs a step as it is while nothing arms it', async () => {
    expect(boundary('source.freeze.journal', () => 7)).toBe(7);
    await expect(boundary('source.freeze.surrender', async () => 8)).resolves.toBe(8);
  });

  it('calls the armed hook on both edges of a step, after a promise only once it fulfils, and tells it of a step that throws', async () => {
    const seen: string[] = [];
    const disarm = armFailpoints((name, edge) => { seen.push(`${name}:${edge}`); });
    try {
      boundary('source.freeze.journal', () => seen.push('step'));
      await boundary('source.freeze.surrender', async () => { seen.push('async step'); });
      await boundary('source.rest.kill', async () => { throw new Error('tmux went away'); }).catch(() => seen.push('refused'));
      expect(() => boundary('source.rest.stopped', () => { throw new Error('disk full'); })).toThrow('disk full');
    } finally {
      disarm();
    }
    boundary('source.freeze.digest', () => seen.push('disarmed'));
    expect(seen).toEqual([
      'source.freeze.journal:before', 'step', 'source.freeze.journal:after',
      'source.freeze.surrender:before', 'async step', 'source.freeze.surrender:after',
      'source.rest.kill:before', 'source.rest.kill:threw', 'refused',
      'source.rest.stopped:before', 'source.rest.stopped:threw', 'disarmed',
    ]);
  });

  it('stops a step at the edge where its hook throws', () => {
    const ran: Edge[] = [];
    const disarm = armFailpoints((_name, edge) => { if (edge === 'before') throw new Error('crashed'); });
    try {
      expect(() => boundary('source.freeze.journal', () => ran.push('after'))).toThrow('crashed');
    } finally {
      disarm();
    }
    expect(ran).toEqual([]);
  });

  it('cannot be armed in a release', () => {
    process.env.ARCHI_RELEASE_ROOT = makeHome();
    try {
      expect(() => armFailpoints(() => {})).toThrow(/release/);
    } finally {
      delete process.env.ARCHI_RELEASE_ROOT;
    }
  });

  it('names every failpoint where a step of the code runs it', () => {
    const sources = ['packages/archid/src', 'packages/cli/src'].flatMap((dir) => (fs.readdirSync(path.join(REPO, dir), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('failpoints.ts')).map((f) => fs.readFileSync(path.join(REPO, dir, f), 'utf8')));
    expect(NAMES.filter((name) => !sources.some((text) => text.includes(`'${name}'`)))).toEqual([]);
  });
});

// ---- the world: a controller, both daemons and the gateway, in one process over real durable files

const fleetId = FleetId.parse(crypto.randomUUID());
const MAC = MachineId.parse(crypto.randomUUID());
const TRIFT = MachineId.parse(crypto.randomUUID());
const G = 0;
// di's Claude session, launched with a flag its resume has to carry
const SID = crypto.randomUUID();
const DI_LAUNCH = 'claude --effort high';
const DI_RESUME = `claude --effort 'high' --resume ${SID}`;

/** What a process that dies at a failpoint throws: nothing after it runs. */
class Crash extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Crash';
  }
}

/** One run of one party, from its start to its death. */
type Life = { side: FailSide; epoch: number; dead: boolean; open: Map<Failpoint, number> };
const als = new AsyncLocalStorage<Life>();

const alive = (life: Life): void => {
  if (life.dead) throw new Crash(`${life.side} #${life.epoch} is gone`);
};

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const wire = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
const noGit: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

type Win = { windowId: string; paneId: string; pid: number; name: string; path: string; job?: string[]; ignoresTerm?: true };
type Instance = { life: Life; ownership: OwnershipState; handover: HandoverService; store: Store; active: boolean; ctx: Ctx };

/** A daemon's journal that dies with it. */
class MortalJournal extends JournalFile {
  constructor(paths: Paths, private life: Life) { super(paths); }
  override write(j: HandoverJournal): void { alive(this.life); super.write(j); }
  override close(): void { alive(this.life); super.close(); }
}

/** A machine: its tmux server and processes, which outlive any daemon, and the daemon running there now. */
class Machine {
  windows = new Map<string, Win>();
  current?: Instance;
  private next = 1;

  constructor(private w: World, readonly name: 'mac' | 'trift', readonly id: MachineId, readonly side: 'source' | 'destination', readonly paths: Paths) {}

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
      this.windows.delete(windowId);
      this.w.check(`${this.name} kill ${windowId}`);
    },
  };

  processes = async (): Promise<ProcessTable> => new ProcessTable([...this.windows.values()].flatMap((p): Proc[] => {
    const group = p.job ? p.pid + 1 : p.pid;
    const shell = { pid: p.pid, ppid: 1, pgid: p.pid, tpgid: group, stat: 'Ss', args: '-zsh' };
    return [shell, ...(p.job ?? []).map((args, i) => ({ pid: group + i, ppid: i ? group + i - 1 : p.pid, pgid: group, tpgid: group, stat: 'S+', args }))];
  }), installedScripts(this.paths.home));

  kill = (group: number, signal: NodeJS.Signals): void => {
    this.acting(`signal ${group}`);
    for (const p of this.windows.values()) if (p.job && p.pid + 1 === group && (signal === 'SIGKILL' || !p.ignoresTerm)) delete p.job;
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
      store.update(reconcile(store.state, await this.tmux.listWindows(), this.w.now, undefined, undefined, carried).mutate);
    };
    const open = async (id: string, term?: 2) => {
      alive(life);
      const key = term ? `${id}-2` : id;
      this.w.guarded(life, `${this.name} open ${key}`);
      this.w.opened(this, key);
      const c = store.state.characters[id];
      const slot = term ? c.second : c;
      if (slot?.tmux) return c;
      const command = slot?.revive?.command;
      // a window its terminal left is gone back to, and nothing is run in it
      const left = [...this.windows.values()].find((x) => x.name === key);
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

const char = (id: string, cwd: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

type Target = { name: Failpoint; edge: Edge; nth: number };
type Heal = 'crashed' | 'all';

/**
 * Both machines, their daemons, the gateway's authority on its socket and a controller, sharing one home path as
 * the two machines of a handover do, with every durable file real. A target crashes the party that reaches it.
 */
class World {
  readonly base = fs.realpathSync(makeHome());
  readonly home = path.join(this.base, 'home');
  readonly prefix = path.join(this.base, 'gw');
  readonly ctlDir = path.join(this.base, 'ctl');
  readonly claudeHome = path.join(this.home, '.claude');
  readonly cy = path.join(this.home, 'work/cy');
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

  constructor() {
    this.mac = new Machine(this, 'mac', MAC, 'source', resolvePaths(path.join(this.base, 'mac')));
    this.trift = new Machine(this, 'trift', TRIFT, 'destination', resolvePaths(path.join(this.base, 'trift')));
  }

  static async create(): Promise<World> {
    const w = new World();
    for (const d of ['work/ada', 'work/bo', 'work/cy', 'work/di', 'mc', '.claude/projects/-work-di']) fs.mkdirSync(path.join(w.home, d), { recursive: true });
    fs.writeFileSync(path.join(w.home, 'work/ada/notes.md'), 'ada\n');
    fs.writeFileSync(path.join(w.home, 'work/bo/index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(w.home, 'work/di/plan.md'), 'di\n');
    fs.writeFileSync(path.join(w.home, 'mc/README.md'), 'mission control\n');
    const transcript = path.join(w.claudeHome, 'projects/-work-di', `${SID}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: SID, cwd: path.join(w.home, 'work/di') })}\n`);
    fs.writeFileSync(path.join(w.claudeHome, '.claude.json'), JSON.stringify({ projects: { [path.join(w.home, 'work/di')]: { hasTrustDialogAccepted: true } } }));
    fs.mkdirSync(w.ctlDir, { recursive: true });
    for (const m of [w.mac, w.trift]) {
      fs.mkdirSync(m.paths.home, { recursive: true });
      fs.writeFileSync(m.paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, gatewayMachineId: TRIFT, home: { cwd: '~/mc' } })));
      fs.writeFileSync(m.paths.owner, JSON.stringify({ fleetId, generation: G, ownerMachineId: MAC }));
    }
    const work = (p: string) => path.join(w.home, 'work', p);
    const [ada, adaSecond, bo, di] = [
      w.mac.window('c_ada', work('ada')), w.mac.window('c_ada-2', work('ada')), w.mac.window('c_bo', work('bo'), ['npm run dev']), w.mac.window('c_di', work('di'), [DI_LAUNCH]),
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
        char('c_cy', work('cy'), { revive: { command: '' } }),
        char('c_di', work('di'), {
          tmux: { windowId: di.windowId, paneId: di.paneId }, agent: { kind: 'claude', sessionId: SID, transcriptPath: transcript, status: 'idle', lastActivityAt: 0 },
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
    if (!/^(mac|trift|gw|ctl)\//.test(rel)) return;
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
        agents: async () => [{ kind: 'claude', version: '2.1.280', home: this.claudeHome, loggedIn: true, hooks: true }],
        source: {
          paths, store: mortal, fleet, tmux: m.tmux, viewers: { detach: async () => {} }, processes: m.processes, kill: m.kill, clock, authority, git: noGit,
          rest: { pollMs: 500, settleMs: 1000, waitMs: 5000 }, log,
        },
        destination: {
          paths, config, store: mortal, fleet, tmux: m.tmux, processes: m.processes, authority, clock, git: noGit,
          homedir: () => this.home, sessionStartMs: 60_000, concurrency: 1, log,
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

  private daemon(m: Machine, ctl: Life): Daemon {
    const call = async (method: MethodName, params: unknown): Promise<unknown> => {
      alive(ctl);
      const d = m.current;
      if (!d || d.life.dead) throw new Error(`${m.name} did not answer ${method}: connection refused`);
      this.trace.push(`${m.name} ${method}`);
      const res = await als.run(d.life, () => dispatch({ id: 1, method, params: wire(params) } as never, d.ctx));
      if (d.life.dead) throw new Error(`${m.name} dropped the connection before it answered ${method}`);
      this.check(`${m.name} answered ${method}`);
      if ('error' in res) throw new Refused(res.error.code, res.error.message, res.error.data as Record<string, unknown> | undefined);
      return wire(res.result);
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

  /** A new controller process, reading its journal from disk, whose every call dies with it. */
  controller(): Handover {
    const life = (this.controllerLife = this.life('controller'));
    const inner = fileStore(this.ctlDir);
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
      this.trace.push(`gateway ${op}`);
      return this.gatewayOp(op, id, params);
    }, fleetId);
    const master: Master = {
      socket: path.join(this.ctlDir, 'ssh'), check: async () => true,
      run: async (argv) => { alive(life); return { code: 0, signal: null, stdout: argv[0] === 'rsync' ? 'rsync  version 3.2.7  protocol version 31\n' : '', stderr: '', truncated: false }; },
    };
    const side = async (id: MachineId): Promise<Side> => {
      const m = id === MAC ? this.mac : this.trift;
      return {
        route: { machineId: id, name: m.name, ...(m === this.trift && { ssh: 'trift' }) },
        daemon: this.daemon(m, life), home: this.home, fleetHome: m.paths.home,
        ...(m === this.trift && { master: async () => master }),
      };
    };
    // both machines share one disk here, so every root already lies where rsync would put it; a session's files go to its stage
    const rsync: RunRsync = async (_rsync, argv) => {
      alive(life);
      const list = argv.find((a) => a.startsWith('--files-from='))?.slice('--files-from='.length);
      if (list && !argv.includes('--dry-run')) {
        const [from, to] = argv.slice(-2).map((p) => p.replace(/^[^/]*:/, ''));
        for (const file of fs.readFileSync(list, 'utf8').split('\0').filter(Boolean)) {
          fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
          fs.copyFileSync(path.join(from, file), path.join(to, file));
        }
      }
      return { code: 0, signal: null, stderr: '' };
    };
    return new Handover({
      fleetId, store, gateway, local: MAC, machines: [MAC, TRIFT], side,
      transfer: (o) => runTransfer({ ...o, deps: { run: rsync } }), rsync: async () => '/usr/bin/rsync', stateDir: this.ctlDir,
      clock: { now: () => this.now, sleep: async () => {} }, retry: { attempts: 3, firstDelayMs: 1 },
    });
  }

  /** Runs a controller call in that controller's own process. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return als.run(this.controllerLife, work);
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

  /** New controllers, each doing what `archi handover status` says is safe, preferring `prefer`, until nothing is open. */
  async recover(prefer: 'resume' | 'abort'): Promise<string[]> {
    const said: string[] = [];
    for (let i = 0; i < 6; i++) {
      // whatever died meanwhile starts again, as launchd starts a daemon again
      await this.heal('crashed');
      const c = this.controller();
      const { verdict } = await this.run(() => c.status());
      said.push(`${verdict.standing}:${verdict.safe.join('+') || '-'}`);
      if (this.moved() && verdict.safe.includes('abort')) this.fail(`status offers an abort after the commit (${verdict.reason})`);
      if (verdict.action === 'none') {
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
const entries = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).sort() : []);

/**
 * Where the fleet came to rest: whole on one machine, nothing open anywhere, no file a transaction wrote left behind,
 * and only the terminals the handover stopped running.
 */
function settledOn(w: World): 'source' | 'destination' {
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
  expect(other.current!.ownership.record()).toMatchObject({ generation: record.generation, ownerMachineId: owner.id });
  expect([...owner.windows.values()].map((x) => x.name).sort()).toEqual(['c_ada', 'c_ada-2', 'c_bo', 'c_di']);
  // di's Claude runs as it was launched, or resumed with the flags it was launched with
  expect([DI_LAUNCH, DI_RESUME]).toContain([...owner.windows.values()].find((x) => x.name === 'c_di')?.job?.join(' | '));
  expect(other.windows.size).toBe(0);
  // the folder that holds each transaction's own may stay, empty
  expect(entries(w.ctlDir).filter((e) => e !== 'handover')).toEqual([]);
  expect(entries(w.base).filter((e) => [...w.transactions].some((tx) => e.includes(tx)))).toEqual([]);
  expect(w.errors).toEqual([]);
  return where;
}

/** A world for each test, whose durable writes are watched, and whose failpoints are armed once it stands. */
function worlds(): () => World {
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

type Scenario = 'move' | 'abort' | 'cancel';

/** What the user chose: to end bo's dev server, and to archive the diverged cy. */
const choices = (w: World) => ({ terminateShells: true, archiveRoots: [w.cy] });

/** The first run: a handover to trift, or one the user cancels once the destination has prepared, or during the transfer, which aborts it. */
async function play(w: World, scenario: Scenario): Promise<Outcome> {
  const c = w.controller();
  const cancelAt = { move: undefined, abort: 'destination.prepare.journal:after', cancel: 'controller.rsync:after' }[scenario];
  if (cancelAt) w.onHit = (key) => { if (key === cancelAt) { w.onHit = undefined; c.cancel(); } };
  try {
    return await w.run(() => c.start(TRIFT, choices(w)));
  } finally {
    w.onHit = undefined;
  }
}

/**
 * Where each step runs, and how many times: the scenario whose first run reaches it, the times it runs there, and a
 * crash that has to come first for the step to run at all, with what changes while that party is down. A failpoint
 * without an entry here does not typecheck.
 */
type Reach = { scenario: Scenario; times: number; after?: Target; setup?: (w: World) => void };
const REACH: Record<Failpoint, Reach> = {
  'source.freeze.journal': { scenario: 'move', times: 1 },
  'source.freeze.surrender': { scenario: 'move', times: 1 },
  'source.rest.terminated': { scenario: 'move', times: 1 },
  'source.rest.terminate': { scenario: 'move', times: 1 },
  'source.rest.forcekill': { scenario: 'move', times: 1 },
  'source.rest.stopped': { scenario: 'move', times: 1 },
  'source.rest.kill': { scenario: 'move', times: 4 },
  'source.freeze.manifest': { scenario: 'move', times: 1 },
  'source.freeze.digest': { scenario: 'move', times: 1 },
  // only a source that died between its journal and its surrender starts by surrendering
  'source.startup.surrender': { scenario: 'move', times: 0, after: { name: 'source.freeze.journal', edge: 'after', nth: 1 } },
  'source.abort.journal': { scenario: 'abort', times: 1 },
  'source.revive': { scenario: 'abort', times: 4 },
  'source.release.manifest': { scenario: 'abort', times: 1 },
  'source.release.journal': { scenario: 'abort', times: 1 },
  'source.release.unfreeze': { scenario: 'abort', times: 1 },
  'source.release.activate': { scenario: 'abort', times: 1 },
  'source.complete.seal': { scenario: 'move', times: 1 },
  'source.complete.install': { scenario: 'move', times: 1 },
  'source.complete.manifest': { scenario: 'move', times: 1 },
  'source.complete.journal': { scenario: 'move', times: 1 },
  'destination.claim.root': { scenario: 'move', times: 6 },
  'destination.claim.archive': { scenario: 'move', times: 1 },
  'destination.verify.journal': { scenario: 'move', times: 1 },
  'destination.verify.landed': { scenario: 'move', times: 1 },
  'destination.verify.record': { scenario: 'move', times: 1 },
  'destination.prepare.seal': { scenario: 'move', times: 1 },
  'destination.prepare.state': { scenario: 'move', times: 1 },
  'destination.prepare.journal': { scenario: 'move', times: 1 },
  'destination.prepare.stage': { scenario: 'move', times: 1 },
  'destination.activate.install': { scenario: 'move', times: 1 },
  'destination.commit.journal': { scenario: 'move', times: 1 },
  'destination.promote.fleet': { scenario: 'move', times: 1 },
  'destination.promote.state': { scenario: 'move', times: 1 },
  'destination.activate.journal': { scenario: 'move', times: 1 },
  'destination.activate.fleet': { scenario: 'move', times: 1 },
  // only an activation retried over a window whose agent has since exited back to its shell closes a window first
  'destination.activate.kill': {
    scenario: 'move', times: 0, after: { name: 'destination.activate.open', edge: 'after', nth: 4 },
    setup: (w) => { for (const x of w.trift.windows.values()) if (x.name === 'c_di') delete x.job; },
  },
  'destination.activate.open': { scenario: 'move', times: 4 },
  'destination.activate.record': { scenario: 'move', times: 4 },
  'destination.complete.seal': { scenario: 'move', times: 1 },
  'destination.complete.clear': { scenario: 'move', times: 1 },
  'destination.complete.journal': { scenario: 'move', times: 1 },
  'destination.abort.stage': { scenario: 'cancel', times: 1 },
  'destination.abort.seal': { scenario: 'abort', times: 1 },
  'destination.abort.clear': { scenario: 'abort', times: 1 },
  'destination.abort.journal': { scenario: 'abort', times: 1 },
  'gateway.begin.write': { scenario: 'move', times: 1 },
  'gateway.ready.write': { scenario: 'move', times: 1 },
  'gateway.commit.write': { scenario: 'move', times: 1 },
  'gateway.abort.write': { scenario: 'abort', times: 1 },
  'gateway.complete.write': { scenario: 'move', times: 1 },
  'gateway.commit.respond': { scenario: 'move', times: 1 },
  'controller.journal': { scenario: 'move', times: 15 },
  'controller.manifest': { scenario: 'move', times: 1 },
  'controller.landed': { scenario: 'move', times: 1 },
  'controller.clear': { scenario: 'move', times: 1 },
  'controller.rsync': { scenario: 'move', times: 6 },
  'controller.verify': { scenario: 'move', times: 6 },
  'controller.commit': { scenario: 'move', times: 1 },
};

type Case = Target & Omit<Reach, 'times'>;

// every run of each step
const CASES: Case[] = NAMES.flatMap((name) => {
  const { times, ...reach } = REACH[name];
  return (['before', 'after'] as const).flatMap((edge) => Array.from({ length: Math.max(1, times) }, (_, i) => ({ name, edge, nth: i + 1, ...reach })));
});

const label = (k: Target): string => `${k.name}:${k.edge}#${k.nth}`;

describe('the guard on steps outside every failpoint', () => {
  const world = worlds();

  it('watches a party after one of its steps throws, and whatever it renames, links or removes under the homes', async () => {
    const w = world();
    w.controller();
    await w.run(async () => {
      await boundary('controller.commit', async () => { throw new Error('the gateway refused'); }).catch(() => {});
      writeDurable(path.join(w.ctlDir, 'stray.json'), {});
    });
    const stage = path.join(w.mac.paths.handoverDir, 'stage-x.json');
    als.run(w.mac.current!.life, () => {
      writeDurable(stage, {});
      fs.rmSync(stage);
    });
    expect(w.violations).toEqual([
      'rename of ctl/stray.json by the controller ran outside every failpoint',
      'rename of mac/handover/stage-x.json by the source ran outside every failpoint',
      'removal of mac/handover/stage-x.json by the source ran outside every failpoint',
    ]);
  });
});

describe('a crash at every failpoint', () => {
  const world = worlds();

  it('strikes both edges of every failpoint in the registry', () => {
    expect(new Set(CASES.map((k) => `${k.name}:${k.edge}`))).toEqual(new Set(NAMES.flatMap((n) => [`${n}:before`, `${n}:after`])));
  });

  for (const scenario of ['move', 'abort', 'cancel'] as const) {
    it(`reaches each step of the ${scenario} run as many times as its entry says, while nothing crashes`, async () => {
      const w = world();
      const out = await play(w, scenario);
      expect(out.status).toBe(scenario === 'move' ? 'complete' : 'aborted');
      expect(w.violations).toEqual([]);
      expect(settledOn(w)).toBe(scenario === 'move' ? 'destination' : 'source');
      const ran = (name: Failpoint) => w.hits.get(`${name}:before`) ?? 0;
      for (const name of NAMES.filter((n) => REACH[n].scenario === scenario)) expect(ran(name), name).toBe(REACH[name].times);
      for (const name of NAMES) expect(w.hits.get(`${name}:after`) ?? 0, name).toBe(ran(name));
    });
  }

  for (const k of CASES) {
    for (const [prefer, heal] of [['resume', 'crashed'], ['abort', 'all']] as const) {
      it(`${label(k)} (${k.scenario}), then ${prefer} after restarting ${heal === 'all' ? 'every party' : 'what died'}`, async () => {
        const w = world();
        w.targets = [...(k.after ? [k.after] : []), { name: k.name, edge: k.edge, nth: k.nth }];
        const first = await play(w, k.scenario);
        k.setup?.(w);
        await w.heal(heal);
        const said = await w.recover(prefer);
        const why = () => `${JSON.stringify(first)}\n${said.join(' ')}\n${w.violations.join('\n')}\n${w.trace.join(' | ')}`;
        expect(w.struck, why()).toEqual([...(k.after ? [label(k.after)] : []), label(k)]);
        expect(w.violations, why()).toEqual([]);
        let where: string;
        try { where = settledOn(w); } catch (e) { throw new Error(`${(e as Error).message}\n${why()}`); }
        if (w.everMoved) expect(where, why()).toBe('destination');
      });
    }
  }
});

describe('a freeze asked again that refuses', () => {
  const world = worlds();

  it('leaves no manifest behind that a freeze before it wrote and did not live to answer', async () => {
    const w = world();
    w.targets = [{ name: 'source.freeze.manifest', edge: 'after', nth: 1 }];
    await play(w, 'move');
    // meanwhile the user keeps cy on the source, so the freeze asked again refuses
    Store.load(w.mac.paths.state, () => {}).update((d) => { d.characters.c_cy.keepHere = true; });
    const said = await w.recover('resume');
    expect(said, w.violations.join('\n')).toContain('resume->blocked');
    expect(w.violations).toEqual([]);
    expect(settledOn(w)).toBe('source');
  });
});

/** What each party holds while the gateway is away: each daemon started again from its disk, and what status allows. */
async function whileAway(w: World): Promise<{ source: boolean; destination: boolean; safe: string[] }> {
  for (const m of [w.mac, w.trift]) {
    m.current!.life.dead = true;
    await w.boot(m);
  }
  const c = w.controller();
  const { verdict } = await w.run(() => c.status());
  // nothing a controller asks while the gateway cannot say who owns the fleet changes anything
  const before = [w.mac, w.trift].map((m) => fs.readFileSync(m.paths.owner, 'utf8'));
  for (const act of ['resume', 'abort'] as const) {
    const out = await w.run(() => (act === 'abort' ? c.abort() : c.resume()));
    if (verdict.standing !== 'none') expect(out.status, act).toBe('interrupted');
  }
  expect([w.mac, w.trift].map((m) => fs.readFileSync(m.paths.owner, 'utf8'))).toEqual(before);
  return { source: w.mac.can(), destination: w.trift.can(), safe: verdict.safe };
}

describe('the gateway lost', () => {
  const world = worlds();
  // where the gateway goes away, who may run the fleet until it comes back, and where each way on then takes it
  type Loss = { when: string; at?: string; first: Partial<Outcome>; source: boolean; destination: boolean; settles: Record<'resume' | 'abort', 'source' | 'destination'> };
  const losses: Loss[] = [
    { when: 'before Begin', first: { status: 'interrupted' }, source: true, destination: false, settles: { resume: 'source', abort: 'source' } },
    {
      when: 'during Freeze', at: 'source.freeze.surrender:after', first: { status: 'interrupted', phase: 'transfer' }, source: false, destination: false,
      settles: { resume: 'destination', abort: 'source' },
    },
    {
      when: 'after Ready', at: 'controller.commit:before', first: { status: 'interrupted', phase: 'commit' }, source: false, destination: false,
      settles: { resume: 'destination', abort: 'source' },
    },
    {
      when: 'after Commit', at: 'gateway.commit.respond:after', first: { status: 'interrupted', phase: 'activate' }, source: false, destination: false,
      settles: { resume: 'destination', abort: 'destination' },
    },
    {
      when: 'during Complete', at: 'destination.complete.journal:after', first: { status: 'complete', pending: ['source', 'gateway'] } as Partial<Outcome>,
      source: false, destination: true, settles: { resume: 'destination', abort: 'destination' },
    },
  ];

  for (const loss of losses) {
    for (const prefer of ['resume', 'abort'] as const) {
      it(`${loss.when} leaves the fleet on at most one machine until it returns, and then ${prefer} settles it`, async () => {
        const w = world();
        if (loss.at) w.onHit = (key) => { if (key === loss.at) { w.onHit = undefined; w.loseGateway(); } };
        else w.loseGateway();
        const c = w.controller();
        const first = await w.run(() => c.start(TRIFT, choices(w)));
        w.onHit = undefined;
        expect(first).toMatchObject(loss.first);
        const away = await whileAway(w);
        expect({ source: away.source, destination: away.destination }).toEqual({ source: loss.source, destination: loss.destination });
        expect(away.safe).toEqual([]);
        await w.startGateway();
        const said = await w.recover(prefer);
        const why = `${JSON.stringify(first)}\n${said.join(' ')}\n${w.violations.join('\n')}`;
        expect(w.violations, why).toEqual([]);
        expect(settledOn(w), why).toBe(loss.settles[prefer]);
      });
    }
  }
});

describe('a preflight of a Claude running in bypass mode', () => {
  const world = worlds();

  it("warns before anything moves that di's Claude will ask trift to accept the bypass mode it runs in, until trift's Claude has accepted it", async () => {
    const w = world();
    const di = [...w.mac.windows.values()].find((x) => x.name === 'c_di')!;
    const warned = async () => {
      const c = w.controller();
      return (await w.run(() => c.preflight(TRIFT, choices(w)))).warnings.filter((x) => x.code === 'claude_bypass').map((x) => x.entity?.id);
    };
    expect(await warned()).toEqual([]);
    di.job = ['claude --dangerously-skip-permissions'];
    expect(await warned()).toEqual(['c_di']);
    fs.writeFileSync(path.join(w.claudeHome, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    expect(await warned()).toEqual([]);
    expect(w.violations).toEqual([]);
  });
});

describe('a stale owner.json beside a surrendered journal', () => {
  const world = worlds();
  const surrendered = (w: World) => JSON.parse(fs.readFileSync(w.mac.paths.owner, 'utf8')) as { surrendered?: true };

  /** The source's owner.json rolled back to the record it held before it froze, as a restore from a backup would leave it. */
  const rollBack = (w: World) => fs.writeFileSync(w.mac.paths.owner, JSON.stringify({ fleetId, generation: G, ownerMachineId: MAC }));

  for (const where of ['with the gateway away', 'with the gateway answering'] as const) {
    it(`starts the source fenced ${where} while the destination runs the fleet, and the source never runs it again`, async () => {
      const w = world();
      // the destination activated and completed; the source died before it could complete
      w.targets = [{ name: 'source.complete.seal', edge: 'before', nth: 1 }];
      const c = w.controller();
      await w.run(() => c.start(TRIFT, choices(w)));
      expect(w.trift.can()).toBe(true);
      rollBack(w);
      if (where === 'with the gateway away') w.loseGateway();
      await w.boot(w.mac);
      expect(w.mac.can()).toBe(false);
      expect(w.mac.current!.ownership.writable()).toBe(false);
      expect(surrendered(w).surrendered).toBe(true);
      // and once more, now that the surrender is on disk
      w.mac.current!.life.dead = true;
      await w.boot(w.mac);
      expect(w.mac.can()).toBe(false);
      if (w.away) await w.startGateway();
      await w.recover('abort');
      expect(w.violations).toEqual([]);
      expect(settledOn(w)).toBe('destination');
    });

    it(`starts the source fenced ${where} when it died between its journal and its surrender`, async () => {
      const w = world();
      w.targets = [{ name: 'source.freeze.journal', edge: 'after', nth: 1 }];
      const c = w.controller();
      await w.run(() => c.start(TRIFT, choices(w)));
      expect(surrendered(w).surrendered).toBeUndefined();
      if (where === 'with the gateway away') w.loseGateway();
      await w.boot(w.mac);
      expect(w.mac.can()).toBe(false);
      expect(surrendered(w).surrendered).toBe(true);
      expect(w.mac.windows.size).toBe(4);
      if (w.away) await w.startGateway();
      await w.recover('resume');
      expect(w.violations).toEqual([]);
      expect(settledOn(w)).toBe('destination');
    });
  }
});
