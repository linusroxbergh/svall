import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FleetConfig, FleetId, MachineId, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState,
  type Agent, type Character, type Event, type OwnerRecord, type ParsedParams, type SystemInfo, type TransactionRecord,
} from '@svall/protocol';
import { handlers, type Ctx } from '../../src/api/methods.js';
import { Config } from '../../src/config.js';
import { AuthorityFailure } from '../../src/gateway/authority.js';
import { SourceJournal, openJournal } from '../../src/handover/journal.js';
import { extensionBlockers } from '../../src/handover/git-extensions.js';
import { manifestDigest, readManifest, realScanFs } from '../../src/handover/manifest.js';
import { ProcessTable, type Proc } from '../../src/handover/processes.js';
import { ReplicaStore, replicaRoots } from '../../src/handover/replicas.js';
import type { Clock } from '../../src/handover/rest.js';
import { HandoverService } from '../../src/handover/service.js';
import { agentProber, cliRunner, resumeFolders, type AgentProbe, type AgentRun } from '../../src/handover/sessions/registry.js';
import { HEAP_PER_FILE, type Authority, type SourceDeps } from '../../src/handover/source.js';
import { adoptAtStart, enterStartupMode, startupMode } from '../../src/handover/startup.js';
import { silentLogger } from '../../src/log.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { installedScripts, resolvePaths, type Paths } from '../../src/paths.js';
import { PRIVATE, profileHome } from '../../src/profile.js';
import { reconcile } from '../../src/reconcile.js';
import { releaseVersion } from '../../src/release.js';
import { Store } from '../../src/store.js';
import type { GitRunner } from '../../src/links/git.js';
import type { LiveWindow } from '../../src/tmux/tmux.js';
import { cleanHomes, idleSides, makeHome, waitFor } from '../helpers.js';
import { fakeEnv, hold } from './fake-opencode.js';

afterEach(cleanHomes);

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const fleetId = FleetId.parse(crypto.randomUUID());
const me = MachineId.parse(crypto.randomUUID());
const trift = MachineId.parse(crypto.randomUUID());
const elsewhere = MachineId.parse(crypto.randomUUID());
const TX = 'tx-1';

const codeOf = (e: unknown): string => (e as { code?: string }).code ?? '';
const dataOf = (e: unknown): Record<string, unknown> => (e as { data?: Record<string, unknown> }).data ?? {};
const refusal = (p: Promise<unknown>): Promise<{ code: string; data: Record<string, unknown>; message: string }> =>
  p.then(() => { throw new Error('the call succeeded'); }, (e: Error) => ({ code: codeOf(e), data: dataOf(e), message: e.message }));

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const withGit = hasGit ? it : it.skip;
// a repository with one commit, standing where a character works
function repo(dir: string, files: Record<string, string> = {}): void {
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'first');
}

const win = (n: number) => ({ windowId: `@${n}`, paneId: `%${n}` });
const char = (id: string, cwd: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

// what the destination said of itself: the same release, logged in to Claude with the hooks in
const destinationInfo = (over: Partial<SystemInfo> = {}): SystemInfo => ({
  machineId: trift, release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: emptyState().version, transferSchema: TRANSFER_SCHEMA_VERSION,
  platform: 'linux', arch: 'x64',
  agentAdapters: [{ kind: 'claude', version: '2.1.280', adapter: 1, home: '/home/linus/.claude', loggedIn: true, hooks: true }],
  git: '2.43.0',
  ...over,
});

// a pane as tmux and ps show it: a shell at its prompt unless a job holds it
type Pane = { windowId: string; paneId: string; pid: number; path: string; job?: string[] };

class World {
  panes = new Map<string, Pane>();
  log: string[] = [];
  now = 0;
  onKill?: () => void;
  private sleepers: { at: number; wake: () => void }[] = [];

  pane(n: number, dir: string, job?: string[]): Pane {
    const p = { ...win(n), pid: n * 1000, path: dir, ...(job && { job }) };
    this.panes.set(p.windowId, p);
    return p;
  }

  clock: Clock = {
    now: () => this.now,
    sleep: (ms, signal) => new Promise((wake) => {
      const s = { at: this.now + ms, wake };
      this.sleepers.push(s);
      signal?.addEventListener('abort', () => { this.sleepers = this.sleepers.filter((x) => x !== s); });
    }),
  };

  tmux: SourceDeps['tmux'] = {
    listWindows: async (): Promise<LiveWindow[]> => [...this.panes.values()].map((p) => ({
      windowId: p.windowId, paneId: p.paneId, panePid: p.pid, name: '', command: '', path: p.path, activity: 0, dead: false,
    })),
    sendBytes: async (paneId, bytes) => { this.log.push(`keys ${paneId} ${bytes.toString('hex')}`); },
    killWindow: async (windowId) => { this.onKill?.(); this.log.push(`kill ${windowId}`); this.panes.delete(windowId); },
    ensureServer: async () => { this.log.push('ensure-server'); },
  };

  viewers: SourceDeps['viewers'] = { detach: async (id) => { this.log.push(`detach ${id}`); } };

  processes = async (): Promise<ProcessTable> => new ProcessTable([...this.panes.values()].flatMap((p): Proc[] => {
    const group = p.job ? p.pid + 1 : p.pid;
    const shell = { pid: p.pid, ppid: 1, pgid: p.pid, tpgid: group, stat: 'Ss', args: '-zsh' };
    const job = (p.job ?? []).map((args, i) => ({ pid: group + i, ppid: i ? group + i - 1 : p.pid, pgid: group, tpgid: group, stat: 'S+', args }));
    return [shell, ...job];
  }), installedScripts('/Users/ada/.svall'));

  kill = (group: number, signal: NodeJS.Signals): void => {
    this.log.push(`${signal} ${group}`);
    for (const p of this.panes.values()) if (p.job && p.pid + 1 === group) delete p.job;
  };

  // timers still set: a rest waiting on a terminal holds one
  timers(): number {
    return this.sleepers.length;
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }

  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = this.sleepers.filter((s) => s.at <= this.now);
    this.sleepers = this.sleepers.filter((s) => s.at > this.now);
    for (const s of due) s.wake();
    await this.settle();
  }
}

/** The gateway as this daemon asks it: the record it holds, or no answer at all. */
class Gateway implements Authority {
  asked = 0;
  down = false;
  refuses?: Error;
  constructor(public record: OwnerRecord) {}
  async get(id: FleetId): Promise<OwnerRecord> {
    this.asked++;
    if (this.down) throw new Error('connect ECONNREFUSED /home/linus/.local/share/svall/gateway/authority.sock');
    if (this.refuses) throw this.refuses;
    if (id !== this.record.fleetId) throw new Error(`asked about ${id}`);
    return structuredClone(this.record);
  }
  begin(over: Partial<TransactionRecord> = {}, generation = 4): void {
    this.record = { fleetId, generation, ownerMachineId: me, transaction: { id: TX, fromMachineId: me, toMachineId: trift, phase: 'preparing', startedAt: 1, ...over } };
  }
  abort(): void {
    const { transaction: _gone, ...rest } = this.record;
    this.record = rest;
  }
}

// every file under a folder with its size and mtime, so a check can prove it wrote nothing
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const st = fs.lstatSync(path.join(dir, name));
    out[name] = st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}:${(st.mode & 0o777).toString(8)}`;
  }
  return out;
}

// no character stands in Git unless a test says so, and then real git reads it
const noGit: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

type Boot = { standalone?: boolean; probes?: AgentProbe[]; record?: object; characters?: (work: string) => Character[]; realGit?: boolean };

function boot(o: Boot = {}) {
  const home = makeHome();
  // git answers in real paths, and a root travels by its real path
  const work = fs.realpathSync(makeHome());
  const paths = resolvePaths(home);
  fs.writeFileSync(paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, ...(!o.standalone && { gatewayMachineId: trift }) })));
  fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 4, ownerMachineId: me, ...o.record }));
  for (const d of ['ada', 'bo', 'cy', '.claude/projects/-bo']) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.writeFileSync(path.join(work, 'ada/notes.md'), 'ada\n');
  fs.writeFileSync(path.join(work, 'bo/index.ts'), 'export {};\n');
  const transcript = path.join(work, `.claude/projects/-bo/${SID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: path.join(work, 'bo'), sessionId: SID, version: '2.1.280', message: { role: 'user', content: 'hi' } })}\n`);
  const agent = (status: Agent['status'], over: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: SID, transcriptPath: transcript, status, lastActivityAt: 0, ...over });

  const store = Store.load(paths.state, () => {});
  const characters = o.characters?.(work) ?? [
    char('c_ada', path.join(work, 'ada'), { tmux: win(1), second: { cwd: path.join(work, 'ada'), unread: false, tmux: win(2) } }),
    char('c_bo', path.join(work, 'bo'), { tmux: win(3), agent: agent('idle') }),
    char('c_cy', path.join(work, 'cy'), { revive: { command: '' } }),
  ];
  store.update((d) => { for (const c of characters) d.characters[c.id] = c; });
  const world = new World();
  for (const c of characters) {
    if (c.tmux) world.pane(Number(c.tmux.windowId.slice(1)), c.cwd, c.agent ? ['claude'] : undefined);
    if (c.second?.tmux) world.pane(Number(c.second.tmux.windowId.slice(1)), c.second.cwd);
  }
  const gateway = new Gateway({ fleetId, generation: 4, ownerMachineId: me });
  const fleet: SourceDeps['fleet'] & { deactivate(): Promise<void> } = {
    settle: async () => { world.log.push('settle'); },
    deactivate: async () => { world.log.push('deactivate'); },
    activate: async () => { world.log.push('activate'); },
    reconcileNow: async () => { world.log.push('reconcile'); },
    // as the fleet does: each terminal a crash cut off mid-turn is revived
    resumeInterrupted: async () => {
      for (const c of Object.values(store.state.characters)) if (c.revive?.interrupted) await fleet.reviveCharacter(c.id);
    },
    reviveCharacter: async (id) => {
      world.log.push(`revive ${id}`);
      store.update((d) => { d.characters[id].tmux = win(9); delete d.characters[id].revive; });
      return store.state.characters[id];
    },
    openSecond: async (id) => {
      // as the fleet does, a second terminal that still names its window keeps it
      if (store.state.characters[id].second?.tmux) return store.state.characters[id];
      world.log.push(`second ${id}`);
      store.update((d) => { const s = d.characters[id].second!; s.tmux = win(10); delete s.revive; });
      return store.state.characters[id];
    },
  };
  const probes = o.probes ?? [{ kind: 'claude', version: '2.1.280', home: path.join(work, '.claude'), loggedIn: true, hooks: true }];
  const deps: SourceDeps = {
    paths, store, fleet, tmux: world.tmux, viewers: world.viewers, processes: world.processes, kill: world.kill, clock: world.clock,
    ...(!o.standalone && { authority: () => gateway }), ...(!o.realGit && { git: noGit }), rest: { pollMs: 500, settleMs: 1000, waitMs: 5000 }, log: silentLogger,
  };
  const start = () => {
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger, standalone: o.standalone });
    const handover = new HandoverService({ ownership, journal: openJournal(paths), agents: async () => probes, fleet, ...idleSides(paths, { store }), source: deps });
    const events: Event[] = [];
    handover.onEvent((e) => events.push(e));
    return { ownership, handover, events };
  };
  // a restarted daemon: the journal and owner.json read again, and put into the mode they call for
  const restart = async () => {
    const s = start();
    const journal = s.handover.journalState();
    const mode = startupMode({ ownership: s.ownership, journal, config: Config.parse({ id: fleetId, ...(!o.standalone && { gatewayMachineId: trift }) }) });
    await enterStartupMode(mode, { ownership: s.ownership, journal, log: silentLogger, standalone: !!o.standalone });
    return s;
  };
  const machines = (over: Partial<ParsedParams<'handover.freeze'>['destination']> = {}) => ({
    source: { home: work },
    destination: { info: destinationInfo(), home: work, fleetHome: path.join(work, '.svall'), ...over },
  });
  const freezeParams = (over: Partial<ParsedParams<'handover.freeze'>> = {}): ParsedParams<'handover.freeze'> =>
    ({ transactionId: TX, generation: 4, choices: {}, ...machines(), ...over });
  return { home, work, paths, store, world, gateway, deps, transcript, agent, machines, freezeParams, start, restart, ...start() };
}

const journalOf = (paths: Paths): SourceJournal | undefined => {
  const s = openJournal(paths).load();
  return s.kind === 'open' && s.journal.role === 'source' ? s.journal : undefined;
};
const ownerFile = (paths: Paths): Record<string, unknown> => JSON.parse(fs.readFileSync(paths.owner, 'utf8'));

const OC = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
const blockersOf = (r: { data: Record<string, unknown> }): { code: string; message: string }[] => (r.data.blockers ?? []) as { code: string; message: string }[];

/**
 * A fleet whose ada left an OpenCode session dormant, logged where Svall's plugin logs it, beside bo's running Claude,
 * on a machine whose `opencode` is the double, and a destination that has OpenCode too.
 */
function opencodeBoot() {
  let logs = '';
  const b = boot({
    probes: [
      { kind: 'claude', version: '2.1.280', home: '/home/linus/.claude', loggedIn: true, hooks: true },
      { kind: 'opencode', version: '2.0.22', home: '/home/linus/.svall/transcripts/opencode', loggedIn: true, hooks: true },
    ],
    characters: (work) => {
      logs = path.join(work, '.svall/transcripts/opencode');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, `${OC}.jsonl`), `${JSON.stringify({ kind: 'user', text: 'remember PELICAN-42' })}\n`);
      return [
        char('c_ada', path.join(work, 'ada'), {
          agent: { kind: 'opencode', sessionId: OC, transcriptPath: path.join(logs, `${OC}.jsonl`), status: 'idle', lastActivityAt: 0 }, revive: { command: `opencode -s ${OC}` },
        }),
        char('c_bo', path.join(work, 'bo'), {
          tmux: win(3), agent: { kind: 'claude', sessionId: SID, transcriptPath: path.join(work, `.claude/projects/-bo/${SID}.jsonl`), status: 'idle', lastActivityAt: 0 },
        }),
      ];
    },
  });
  const env = fakeEnv(path.join(b.work, 'opencode'));
  const run = cliRunner(env);
  b.deps.cli = async (cmd, args, o) => {
    if (args[1] === 'export') b.world.log.push(`export ${o?.stdout === os.devNull ? 'checked' : 'written'}`);
    return run(cmd, args, o);
  };
  const info = destinationInfo({
    agentAdapters: [...destinationInfo().agentAdapters, { kind: 'opencode', version: '2.0.22', adapter: 1, home: path.join(b.work, 'trift/transcripts/opencode'), loggedIn: true, hooks: true }],
  });
  return { ...b, env, logs, info };
}

describe('source preflight', () => {
  it('reports what would stop the move without writing, fencing or signalling, and only reads who the gateway says owns it', async () => {
    const b = boot({
      characters: (work) => {
        fs.symlinkSync(path.join(work, 'cy'), path.join(work, 'linked'));
        return [
          char('c_ada', path.join(work, 'ada'), { tmux: win(1) }),
          char('c_bo', path.join(work, 'bo'), { tmux: win(3) }),
          char('c_cy', path.join(work, 'linked')),
        ];
      },
    });
    b.world.panes.get('@3')!.job = ['npm run dev'];
    const before = { home: tree(b.home), work: tree(b.work), state: structuredClone(b.store.state) };

    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });

    expect(r.blockers.map((x) => [x.code, x.entity?.id])).toEqual([
      ['path_symlinked', 'c_cy'],
      ['shell_busy', 'c_bo'],
    ]);
    expect(r.manifestSummary).toMatchObject({ roots: 2, files: 2, sessions: 0 });
    // the manifest it counted, for the controller to check the destination's roots against
    expect(r.manifest.transactionId).toBeUndefined();
    expect(manifestDigest(r.manifest)).toBe(r.manifestSummary.digest);
    expect(r.manifest.roots.map((x) => x.path).sort()).toEqual([path.join(b.work, 'ada'), path.join(b.work, 'bo')]);
    expect(tree(b.home)).toEqual(before.home);
    expect(tree(b.work)).toEqual(before.work);
    expect(b.store.state).toEqual(before.state);
    expect(b.world.log).toEqual([]);
    expect(b.gateway.asked).toBe(1);
    expect(b.ownership.writable()).toBe(true);
    expect(b.handover.journalState()).toEqual({ kind: 'none' });
  });

  it('says what in fleet.json is wrong when it no longer reads as a fleet config', async () => {
    const b = boot();
    fs.writeFileSync(b.paths.fleetConfig, JSON.stringify({ id: fleetId, gatewayMachineId: 'trift' }));
    await expect(b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() }))
      .rejects.toThrow(`invalid config ${b.paths.fleetConfig}: gatewayMachineId:`);
  });

  it('lets the choices a freeze will carry approve a busy shell and a blocked agent', async () => {
    const b = boot();
    b.world.panes.get('@1')!.job = ['npm run dev'];
    b.store.update((d) => { d.characters.c_bo.agent!.status = 'blocked'; });
    const ask = (choices: ParsedParams<'handover.preflight'>['choices']) => b.handover.preflight({ toMachineId: trift, choices, ...b.machines() });
    expect((await ask({})).blockers.map((x) => x.code)).toEqual(['agent_blocked', 'shell_busy']);
    expect((await ask({ interruptAfterMs: 0, terminateShells: ['c_ada'] })).blockers).toEqual([]);
  });

  it('blocks a destination that is not the machine named, is this one, or has no gateway to hand it through', async () => {
    const b = boot();
    const codes = async (p: Partial<ParsedParams<'handover.preflight'>>, bb = b) =>
      (await bb.handover.preflight({ toMachineId: trift, choices: {}, ...bb.machines(), ...p })).blockers.map((x) => x.code);
    expect(await codes({})).toEqual([]);
    expect(await codes({ toMachineId: elsewhere })).toEqual(['identity_mismatch']);
    expect(await codes({ toMachineId: me, destination: { ...b.machines().destination, info: destinationInfo({ machineId: me }) } })).toEqual(['identity_mismatch']);
    const alone = boot({ standalone: true });
    expect(await codes({}, alone)).toEqual(['identity_mismatch']);
  });

  it('blocks a destination whose home is not this machine\'s, at preflight and at freeze, naming the commands that make one that is', async () => {
    const b = boot();
    const elsewhere = { home: '/home/linus' };
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines(elsewhere) });
    expect(r.blockers).toEqual([{
      code: 'home_mismatch',
      message: `the destination's home is /home/linus and this machine's ${b.work}; a fleet moves only between accounts with the same home path. On the destination, sudo mkdir -p ${path.dirname(b.work)}, then sudo useradd -m -d ${b.work} <user> for a new account, or sudo usermod -d ${b.work} -m <user> for an existing one you are not logged in as; then svall host remove <name>, svall host add at that account, and svall host enable <name> --fleet <fleet>`,
    }]);
    b.gateway.begin();
    const refused = await refusal(b.handover.freeze(b.freezeParams(b.machines(elsewhere))));
    expect((refused.data.blockers as { code: string }[]).map((x) => x.code)).toEqual(['home_mismatch']);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
  });

  it('asks the gateway who owns the fleet, as Freeze will, and blocks when it cannot be asked without a prompt', async () => {
    const b = boot();
    const ask = async () => (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() })).blockers;
    const asked = b.gateway.asked;
    expect(await ask()).toEqual([]);
    expect(b.gateway.asked).toBe(asked + 1);
    b.gateway.down = true;
    expect(await ask()).toEqual([{ code: 'ssh_interactive', message: expect.stringContaining('ECONNREFUSED') }]);
  });

  it('blocks with identity_mismatch when the route to its gateway now reaches another machine', async () => {
    const b = boot();
    const said = `ssh linus@trift reaches machine ${crypto.randomUUID()}, not the gateway ${trift}`;
    b.gateway.refuses = new AuthorityFailure('identity_mismatch', said);
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });
    expect(r.blockers).toEqual([{ code: 'identity_mismatch', message: expect.stringContaining(said) }]);
  });

  it('refuses a manifest too large to travel whole, answering preflight without its file lists, and freezing nothing it would carry', async () => {
    const b = boot();
    b.deps.manifestBytes = 200;
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'manifest_too_large', message: expect.stringMatching(/more than a handover carries/) })]);
    expect(r.manifest.roots.every((x) => x.files.length === 0)).toBe(true);
    b.gateway.begin();
    const refused = await refusal(b.handover.freeze(b.freezeParams()));
    expect(refused.code).toBe('blocked');
    expect(refused.data.blockers).toEqual([expect.objectContaining({ code: 'manifest_too_large' })]);
    expect(b.ownership.writable()).toBe(true);
  });

  it('refuses at preflight, with nothing frozen, more files than the smaller of the two heaps holds through a handover, and again at freeze', async () => {
    const b = boot();
    const { files } = (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() })).manifestSummary;
    // a heap that holds exactly `n` files: half of it at HEAP_PER_FILE a file
    const holding = (n: number) => n * 2 * HEAP_PER_FILE;
    const ask = (own: number, destination: number) => {
      b.deps.heapLimit = own;
      return b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: destinationInfo({ heapLimit: destination }) }) });
    };
    expect((await ask(holding(files), holding(files))).blockers).toEqual([]);
    const mine = await ask(holding(files - 1), holding(files) * 8);
    expect(mine.blockers).toEqual([{
      code: 'too_many_files',
      message: `this handover carries ${files} files, and this machine's daemon, with a ${(holding(files - 1) / 2 ** 30).toFixed(1)} GiB heap, holds at most ${files - 1} through a handover; exclude what need not move, such as build output, in fleet.json handover.exclude`,
    }]);
    expect(mine.manifestSummary.files).toBe(files);
    expect(mine.manifest.roots.every((x) => x.files.length === 0)).toBe(true);
    const theirs = await ask(holding(files) * 8, holding(files - 1));
    expect(theirs.blockers).toEqual([expect.objectContaining({ code: 'too_many_files', message: expect.stringContaining("the destination's daemon") })]);
    expect(b.world.log).toEqual([]);
    expect(b.ownership.writable()).toBe(true);

    b.gateway.begin();
    const refused = await refusal(b.handover.freeze(b.freezeParams(b.machines({ info: destinationInfo({ heapLimit: holding(files - 1) }) }))));
    expect(refused.code).toBe('blocked');
    expect(refused.data.blockers).toEqual([expect.objectContaining({ code: 'too_many_files' })]);
    expect(b.ownership.writable()).toBe(true);
  });

  it('refuses a fleet past the bound from its names, reading no file, at preflight and at freeze before any terminal rests', async () => {
    const b = boot();
    const { files } = (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() })).manifestSummary;
    // a heap that holds half the files, so reading every one to count them would be past it
    b.deps.heapLimit = Math.floor(files / 2) * 2 * HEAP_PER_FILE;
    let reads = 0;
    b.deps.scanFs = { ...realScanFs, read: (p) => { reads++; throw new Error(`${p} read past the bound`); } };
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });
    expect(r.blockers).toEqual([{
      code: 'too_many_files',
      message: expect.stringContaining(`this handover carries ${files} files, and this machine's daemon`),
    }]);
    expect(r.manifestSummary.files).toBe(files);
    expect(r.manifest.roots.every((x) => x.files.length === 0)).toBe(true);
    expect(reads).toBe(0);

    b.gateway.begin();
    const refused = await refusal(b.handover.freeze(b.freezeParams()));
    expect(refused.data.blockers).toEqual([expect.objectContaining({ code: 'too_many_files' })]);
    expect(reads).toBe(0);
    // settled and taken back, and no terminal sent a key or closed
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    expect(b.ownership.writable()).toBe(true);
  });

  it('blocks a destination on another release, protocol or schema, and one whose agent CLI cannot resume the sessions', async () => {
    const b = boot();
    const codes = async (info: Partial<SystemInfo>) =>
      (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: destinationInfo(info) }) })).blockers.map((x) => x.code);
    expect(await codes({ release: '0.0.1' })).toEqual(['incompatible_release']);
    expect(await codes({ protocol: PROTOCOL_VERSION + 1 })).toEqual(['incompatible_protocol']);
    expect(await codes({ stateSchema: 99, transferSchema: 99 })).toEqual(['incompatible_schema', 'incompatible_schema']);
    const claude = destinationInfo().agentAdapters[0];
    expect(await codes({ agentAdapters: [] })).toEqual(['agent_cli_missing', 'agent_cli_missing']);
    expect(await codes({ agentAdapters: [{ ...claude, loggedIn: false }] })).toEqual(['agent_logged_out']);
    expect(await codes({ agentAdapters: [{ ...claude, hooks: undefined }] })).toEqual(['agent_hooks_missing']);
    expect(await codes({ agentAdapters: [{ ...claude, version: '2.1.200' }] })).toEqual(['incompatible_adapter']);
    // a fleet running no Codex does not care how Codex is there
    expect(await codes({ agentAdapters: [claude, { kind: 'codex', adapter: 0 }] })).toEqual([]);
  });

  it('blocks an OpenCode session its CLI does not hold, at preflight and at freeze before any terminal rests', async () => {
    const b = opencodeBoot();
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: b.info }) });
    expect(r.blockers).toEqual([{ code: 'transcript_missing', message: expect.stringContaining(`Session not found: ${OC}`), entity: { kind: 'character', id: 'c_ada' } }]);
    expect(fs.existsSync(path.join(b.logs, 'exports'))).toBe(false);
    b.gateway.begin();
    expect(blockersOf(await refusal(b.handover.freeze(b.freezeParams({ destination: b.machines({ info: b.info }).destination })))).map((x) => x.code)).toEqual(['transcript_missing']);
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toEqual([]);
  });

  it('blocks a character kept on this machine', async () => {
    const b = boot();
    b.store.update((d) => { d.characters.c_ada.keepHere = true; });
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });
    expect(r.blockers).toEqual([{ code: 'character_pinned', message: 'ada is kept on this machine', entity: { kind: 'character', id: 'c_ada' } }]);
  });

  withGit('blocks a repository that names the platforms it runs on without the destination, and warns of an Xcode project', async () => {
    const b = boot({ realGit: true });
    const bo = path.join(b.work, 'bo');
    repo(bo, { '.svall/handover.json': '{ "platforms": ["darwin"] }\n', 'App.xcodeproj/project.pbxproj': '// Xcode\n' });
    const file = path.join(bo, '.svall/handover.json');
    const ask = async (platform: 'darwin' | 'linux') => {
      const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: destinationInfo({ platform }) }) });
      return { blockers: r.blockers.map((x) => [x.code, x.message]), warnings: r.warnings.filter((w) => w.code === 'platform_heuristic').map((w) => w.message) };
    };

    const linux = await ask('linux');
    expect(linux.blockers).toEqual([['platform_unsupported', `${file} says this repository runs on darwin, and the destination is linux`]]);
    expect(linux.warnings).toEqual([`${bo} holds an Xcode project, App.xcodeproj, which does not build on linux`]);
    expect(await ask('darwin')).toEqual({ blockers: [], warnings: [] });

    fs.writeFileSync(file, '{ "platforms": "linux" }');
    expect((await ask('linux')).blockers).toEqual([['platform_unsupported', expect.stringContaining(`${file} is not a handover file`)]]);
    fs.writeFileSync(file, '{ "platforms": ["darwin", "linux"] }');
    expect((await ask('linux')).blockers).toEqual([]);
  });

  withGit('reads a handover file only as a regular file of at most 64 KiB, and a file named .svall as none', async () => {
    const b = boot({ realGit: true });
    const bo = path.join(b.work, 'bo');
    repo(bo);
    const dir = path.join(bo, '.svall');
    const file = path.join(dir, 'handover.json');
    const ask = async () => (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() })).blockers.map((x) => [x.code, x.message]);
    const said: Record<string, unknown> = {};

    fs.writeFileSync(dir, '{ "platforms": ["darwin"] }');
    said.notFolder = await ask();
    fs.rmSync(dir);
    // a linked folder is carried as a link, so the file read through it is not what arrives
    const outside = path.join(b.work, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'handover.json'), '{ "platforms": ["linux"] }');
    fs.symlinkSync(outside, dir);
    said.linkedFolder = await ask();
    fs.rmSync(dir);
    fs.mkdirSync(dir);
    // a link is carried as a link, so what it points at is not what arrives
    const elsewhere = path.join(b.work, 'handover.json');
    fs.writeFileSync(elsewhere, '{ "platforms": ["linux"] }');
    fs.symlinkSync(elsewhere, file);
    said.link = await ask();
    fs.rmSync(file);
    fs.writeFileSync(file, `{ "platforms": ["linux"] }${' '.repeat(64 * 1024)}`);
    said.large = await ask();
    fs.rmSync(file);
    execFileSync('mkfifo', [file]);
    // a reader stuck opening the pipe is let go, so a check that opens it fails instead of hanging
    const release = setTimeout(() => { try { fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* no reader */ } }, 1000);
    said.pipe = await ask();
    clearTimeout(release);
    fs.rmSync(file);
    // one that grows past the limit after it was measured is read no further than the limit
    fs.writeFileSync(file, `{ "platforms": ["linux"] }${' '.repeat(64 * 1024)}`);
    b.deps.scanFs = { ...realScanFs, lstat: async (p) => Object.assign(await realScanFs.lstat(p), p === file ? { size: 26 } : {}) };
    said.grown = await ask();
    // a link or a pipe put in its place after it was looked at is not read through
    const regular = Object.assign(await realScanFs.lstat(file), { size: 26 });
    b.deps.scanFs = { ...realScanFs, lstat: async (p) => (p === file ? regular : realScanFs.lstat(p)) };
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    said.swappedLink = await ask();
    fs.rmSync(file);
    execFileSync('mkfifo', [file]);
    // the manifest's own walk is told the same, and waits on the pipe until a writer lets it go
    const writer = setTimeout(() => { try { fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* no reader */ } }, 1000);
    said.swappedPipe = await ask();
    clearTimeout(writer);

    expect(said).toEqual({
      notFolder: [],
      linkedFolder: [['platform_unsupported', `${dir} is a symbolic link, and a handover file must lie in the repository itself`]],
      link: [['platform_unsupported', `${file} is a symbolic link, and a handover file must be a regular file`]],
      large: [['platform_unsupported', `${file} is over 64 KiB, more than a handover file may hold`]],
      pipe: [['platform_unsupported', `${file} is not a regular file, and a handover file must be one`]],
      grown: [['platform_unsupported', `${file} is over 64 KiB, more than a handover file may hold`]],
      swappedLink: [['platform_unsupported', expect.stringMatching(/cannot be read: ELOOP|is a symbolic link/)]],
      swappedPipe: [['platform_unsupported', `${file} is not a regular file, and a handover file must be one`]],
    });
  });

  withGit("blocks a repository using a Git extension the destination's git cannot open, before anything is moved", async () => {
    const b = boot({ realGit: true });
    const bo = path.join(b.work, 'bo');
    repo(bo);
    const config = (...args: string[]) => execFileSync('git', ['config', ...args], { cwd: bo, stdio: 'ignore' });
    const ask = async (git?: string) => (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: destinationInfo({ git }) }) }))
      .blockers.map((x) => [x.code, x.message]);
    expect(await ask('2.19.0')).toEqual([]);
    config('core.repositoryformatversion', '1');
    config('extensions.worktreeConfig', 'true');
    expect(await ask('2.19.0')).toEqual([['git_extension', `${path.join(bo, '.git')} uses the Git extension worktreeconfig, which needs git 2.20.0 or newer, and the destination runs git 2.19.0`]]);
    expect(await ask('2.43.0')).toEqual([]);
    config('extensions.relativeWorktrees', 'true');
    expect((await ask('2.43.0')).map(([, m]) => m)).toEqual([expect.stringContaining('relativeworktrees, which needs git 2.48.0')]);
    expect(await ask()).toEqual([['git_extension', `the destination reported no git, and ${path.join(bo, '.git')} is carried as a Git repository`]]);
  });

  it('reads an extension no table knows as needing the git that opened it here', () => {
    const graph = (extensions: Record<string, string>, version = 1) => ({ id: 'g_1', commonDir: '/w/a/.git', version, extensions });
    expect(extensionBlockers([graph({ fancy: 'true' })], { destination: '2.49.0', source: '2.50.1' }).map((x) => x.message))
      .toEqual(['/w/a/.git uses the Git extension fancy, which needs git 2.50.1 or newer, and the destination runs git 2.49.0']);
    expect(extensionBlockers([graph({ fancy: 'true' })], { destination: '2.50.1', source: '2.50.1' })).toEqual([]);
    expect(extensionBlockers([graph({ refstorage: 'reftable' })], { destination: '2.44.9', source: '2.55.0' })).toHaveLength(1);
    // a version 0 repository's extensions are not read by any git, old or new
    expect(extensionBlockers([graph({ refstorage: 'reftable' }, 0)], { destination: '2.30.0', source: '2.55.0' })).toEqual([]);
    expect(extensionBlockers([graph({ noop: 'true' })], { destination: '2.1.0', source: '2.55.0' })).toEqual([]);
  });

  it("blocks a session this machine's own CLI release wrote and no adapter reads", async () => {
    const b = boot({ probes: [{ kind: 'claude', version: '2.1.200', home: '/x', loggedIn: true, hooks: true }] });
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });
    expect(r.blockers.map((x) => x.code)).toEqual(['incompatible_adapter']);
  });

  it("passes the Mac's Claude Code 2.1.283 on both machines, and a destination release newer than any fixture", async () => {
    const b = boot({ probes: [{ kind: 'claude', version: '2.1.283', home: '/x', loggedIn: true, hooks: true }] });
    const claude = destinationInfo().agentAdapters[0];
    for (const version of ['2.1.283', '2.4.0']) {
      const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: destinationInfo({ agentAdapters: [{ ...claude, version }] }) }) });
      expect(r.blockers, version).toEqual([]);
    }
  });

  it('carries each running agent with the revive its rest will record, launch flags read from its process, so a bypass resume shows in either terminal', async () => {
    const [ADA, ADA2, BO, CY] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const b = boot({
      characters: (work) => {
        const claude = (sessionId: string): Agent => {
          const transcriptPath = path.join(work, `.claude/projects/-work/${sessionId}.jsonl`);
          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', sessionId })}\n`);
          return { kind: 'claude', sessionId, transcriptPath, status: 'idle', lastActivityAt: 0 };
        };
        const ada = path.join(work, 'ada');
        return [
          char('c_ada', ada, { tmux: win(1), agent: claude(ADA), second: { cwd: ada, unread: false, tmux: win(2), agent: claude(ADA2) } }),
          char('c_bo', path.join(work, 'bo'), { tmux: win(3), agent: claude(BO) }),
          char('c_cy', path.join(work, 'cy'), { agent: claude(CY), revive: { command: `claude --dangerously-skip-permissions --resume ${CY}` } }),
        ];
      },
    });
    b.world.panes.get('@1')!.job = ['claude --dangerously-skip-permissions'];
    b.world.panes.get('@2')!.job = ['claude --permission-mode bypassPermissions'];
    b.world.panes.get('@3')!.job = ['claude --effort high'];
    const before = structuredClone(b.store.state);

    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });

    expect(r.blockers).toEqual([]);
    const { c_ada: ada, c_bo: bo, c_cy: cy } = r.manifest.snapshot.characters;
    expect([ada.revive, ada.second?.revive, bo.revive, cy.revive]).toEqual([
      { command: `claude --dangerously-skip-permissions --resume ${ADA}` },
      { command: `claude --permission-mode 'bypassPermissions' --resume ${ADA2}` },
      { command: `claude --effort 'high' --resume ${BO}` },
      { command: `claude --dangerously-skip-permissions --resume ${CY}` },
    ]);
    expect(resumeFolders(r.manifest).map((f) => [f.characterId, f.bypass ?? false])).toEqual([['c_ada', true], ['c_ada', true], ['c_bo', false], ['c_cy', true]]);
    expect(b.store.state).toEqual(before);
    expect(b.world.log).toEqual([]);
  });
});

describe('source freeze', () => {
  it('freezes only for a Begin record naming this source, the destination and the generation, and changes nothing otherwise', async () => {
    const cases: [string, (b: ReturnType<typeof boot>) => void, string][] = [
      ['no handover', () => {}, 'transaction_mismatch'],
      ['another handover', (b) => b.gateway.begin({ id: 'tx-2' }), 'transaction_mismatch'],
      ['another destination', (b) => b.gateway.begin({ toMachineId: elsewhere }), 'transaction_mismatch'],
      ['a handover past preparing', (b) => b.gateway.begin({ phase: 'ready-to-commit' }), 'transaction_mismatch'],
      ['another generation', (b) => b.gateway.begin({}, 5), 'generation_mismatch'],
      ['another owner', (b) => { b.gateway.begin(); b.gateway.record.ownerMachineId = elsewhere; }, 'not_owner'],
      ['no answer', (b) => { b.gateway.begin(); b.gateway.down = true; }, 'authority_unreachable'],
    ];
    for (const [what, set, code] of cases) {
      const b = boot();
      set(b);
      const owner = fs.readFileSync(b.paths.owner, 'utf8');
      expect((await refusal(b.handover.freeze(b.freezeParams()))).code, what).toBe(code);
      expect(fs.readFileSync(b.paths.owner, 'utf8'), what).toBe(owner);
      expect(fs.existsSync(b.paths.journal), what).toBe(false);
      expect(b.world.log, what).toEqual([]);
      expect(b.ownership.writable(), what).toBe(true);
    }
    const alone = boot({ standalone: true });
    expect((await refusal(alone.handover.freeze(alone.freezeParams()))).code).toBe('transaction_mismatch');
  });

  it('fences the fleet, rests its terminals and has the surrender and journal on disk before it answers the manifest it kept', async () => {
    const b = boot();
    b.gateway.begin();
    const order: string[] = [];
    b.handover.onEvent((e) => {
      if (e.event === 'handover.changed') order.push(`journal ${e.data.phase} ${JSON.stringify(ownerFile(b.paths).surrendered ?? false)}`);
    });

    const { manifest } = await b.handover.freeze(b.freezeParams());

    expect(manifest.transactionId).toBe(TX);
    expect(manifest.generation).toBe(4);
    expect(manifest.toMachineId).toBe(trift);
    // the journal is written first; the surrender is on disk before anything is closed
    expect(order[0]).toBe('journal freeze false');
    expect(ownerFile(b.paths)).toMatchObject({ frozen: true, surrendered: true, transaction: { id: TX, toMachineId: trift } });
    const j = journalOf(b.paths)!;
    expect(j).toMatchObject({ transactionId: TX, generation: 4, phase: 'freeze', fromMachineId: me, toMachineId: trift, manifestDigest: manifestDigest(manifest) });
    expect(j.stoppedTerminals).toEqual([{ characterId: 'c_ada' }, { characterId: 'c_ada', term: 2 }, { characterId: 'c_bo' }]);
    const kept = readManifest(b.paths.manifest(TX));
    expect(kept.digest).toBe(j.manifestDigest);
    expect(fs.statSync(b.paths.manifest(TX)).mode & 0o777).toBe(0o600);
    // background writers settled before any window closed, then every window closed
    expect(b.world.log).toEqual(['settle', 'detach c_ada', 'detach c_bo', 'kill @1', 'kill @2', 'kill @3']);
    expect(b.store.state.characters.c_bo.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(Object.values(manifest.snapshot.characters).every((c) => !c.tmux && !c.second?.tmux)).toBe(true);
    expect(manifest.sessions.map((s) => s.sessionId)).toEqual([SID]);
    expect(() => b.ownership.assertOwner('mutation')).toThrow(/frozen/);
    const progress = b.events.filter((e) => e.event === 'handover.entity').map((e) => e.data);
    expect(progress).toEqual([
      { transactionId: TX, kind: 'character', id: 'c_ada', phase: 'freeze' },
      { transactionId: TX, kind: 'character', id: 'c_bo', phase: 'freeze' },
      { transactionId: TX, kind: 'character', id: 'c_cy', phase: 'freeze' },
      { transactionId: TX, kind: 'character', id: 'c_ada', phase: 'freeze', done: 2, total: 2 },
      { transactionId: TX, kind: 'character', id: 'c_bo', phase: 'freeze', done: 1, total: 1 },
      { transactionId: TX, kind: 'character', id: 'c_cy', phase: 'freeze', done: 0, total: 0 },
    ]);
  });

  it('writes each OpenCode session out once its terminal rests, and carries that export with the log Svall keeps of it', async () => {
    const b = opencodeBoot();
    const session = { info: { id: OC, location: { directory: path.join(b.work, 'ada') } }, messages: [{ id: 'msg_0', text: 'remember PELICAN-42' }] };
    hold(b.env, session);
    b.gateway.begin();
    const { manifest } = await b.handover.freeze(b.freezeParams({ destination: b.machines({ info: b.info }).destination }));
    expect(b.world.log).toEqual(['settle', 'export checked', 'detach c_bo', 'kill @3', 'export written']);
    const [s] = manifest.sessions;
    expect(s).toMatchObject({ agent: 'opencode', sessionId: OC, adapter: 1, sourceHome: b.logs, destinationPath: path.join(b.work, `trift/transcripts/opencode/${OC}.jsonl`) });
    const exported = path.join(b.logs, `exports/${OC}.json`);
    expect(s.files.map((f) => f.path)).toEqual([`${OC}.jsonl`, `exports/${OC}.json`]);
    expect(s.files[1]).toMatchObject({ size: fs.statSync(exported).size });
    expect(JSON.parse(fs.readFileSync(exported, 'utf8'))).toEqual(session);
    expect(manifest.snapshot.characters.c_ada.revive).toEqual({ command: `opencode -s ${OC}` });
  });

  it('answers a freeze asked again, at once or after a restart, from what it kept, without resting or asking again', async () => {
    const b = boot();
    b.gateway.begin();
    const [one, two] = await Promise.all([b.handover.freeze(b.freezeParams()), b.handover.freeze(b.freezeParams())]);
    expect(two).toEqual(one);
    const closed = b.world.log.filter((l) => l.startsWith('kill')).length;
    expect(closed).toBe(3);
    const asked = b.gateway.asked;
    expect(await b.handover.freeze(b.freezeParams())).toEqual(one);

    // the gateway has moved on to ready-to-commit, which a repeated freeze does not need to ask about
    b.gateway.begin({ phase: 'ready-to-commit' });
    const again = await b.restart();
    expect(again.ownership.writable()).toBe(false);
    expect(await again.handover.freeze(b.freezeParams())).toEqual(one);
    expect(b.gateway.asked).toBe(asked);
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toHaveLength(closed);
  });

  it('finishes a freeze a crash cut short after the journal and before its manifest, replacing a manifest no journal names', async () => {
    const b = boot();
    b.gateway.begin();
    const { manifest } = await b.handover.freeze(b.freezeParams());
    // as if the daemon died after writing a manifest and before the journal named it
    const j = journalOf(b.paths)!;
    const { manifestDigest: _digest, ...cut } = j;
    fs.writeFileSync(b.paths.journal, JSON.stringify(cut));
    fs.writeFileSync(b.paths.manifest(TX), JSON.stringify({ ...manifest, generation: 3 }));
    fs.appendFileSync(path.join(b.work, 'ada/notes.md'), 'more\n');

    const again = await b.restart();
    const r = await again.handover.freeze(b.freezeParams());

    expect(r.manifest.roots.find((x) => x.path.endsWith('/ada'))?.files[0]).toMatchObject({ path: 'notes.md', size: 9 });
    expect(journalOf(b.paths)?.manifestDigest).toBe(manifestDigest(r.manifest));
    expect(readManifest(b.paths.manifest(TX)).digest).toBe(manifestDigest(r.manifest));
    expect(journalOf(b.paths)?.stoppedTerminals).toEqual(j.stoppedTerminals);
    expect(ownerFile(b.paths)).toMatchObject({ frozen: true, surrendered: true, transaction: { id: TX } });
  });

  it('gives a blocked agent back to its user without closing a window, and freezes again under the same handover once it is answered', async () => {
    const b = boot();
    b.gateway.begin();
    b.store.update((d) => { d.characters.c_bo.agent!.status = 'blocked'; d.characters.c_bo.agent!.prompt = 'Run rm -rf build?'; });

    const first = await refusal(b.handover.freeze(b.freezeParams()));

    expect(first.code).toBe('blocked');
    expect(first.data.blockers).toEqual([{ code: 'agent_blocked', message: "bo's terminal is waiting on an answer: Run rm -rf build?", entity: { kind: 'character', id: 'c_bo' } }]);
    expect(b.world.log.filter((l) => /^(kill|keys|SIG)/.test(l))).toEqual([]);
    // back to normal ownership, so the user can answer it, with the gateway's handover still open
    expect(b.ownership.writable()).toBe(true);
    expect(ownerFile(b.paths)).not.toHaveProperty('surrendered');
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    expect(b.events.filter((e) => e.event === 'handover.entity').at(-1)).toEqual({
      event: 'handover.entity', data: { transactionId: TX, kind: 'character', id: 'c_bo', phase: 'freeze', error: "bo's terminal is waiting on an answer: Run rm -rf build?" },
    });

    b.store.update((d) => { d.characters.c_bo.agent!.status = 'idle'; delete d.characters.c_bo.agent!.prompt; });
    const { manifest } = await b.handover.freeze(b.freezeParams());
    expect(manifest.transactionId).toBe(TX);
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toEqual(['kill @1', 'kill @2', 'kill @3']);
  });

  it('interrupts a blocked agent when asked again with Interrupt and carry', async () => {
    const b = boot();
    b.gateway.begin();
    b.store.update((d) => { d.characters.c_bo.agent!.status = 'blocked'; });
    expect((await refusal(b.handover.freeze(b.freezeParams()))).code).toBe('blocked');
    const run = b.handover.freeze(b.freezeParams({ choices: { interruptAfterMs: 0 } }));
    await waitFor(() => b.world.log.includes('keys %3 1b'));
    await b.world.settle();
    await b.world.advance(500);
    expect((await run).manifest.transactionId).toBe(TX);
  });

  it('takes Interrupt and carry asked while it waits on a working agent, in place of the wait it was resting with', async () => {
    const b = boot();
    b.gateway.begin();
    b.store.update((d) => { d.characters.c_bo.agent!.status = 'working'; });
    const waiting = refusal(b.handover.freeze(b.freezeParams()));
    await waitFor(() => b.world.timers() > 0);
    await b.world.advance(500);
    expect(b.world.log).toEqual(['settle']);

    const carried = b.handover.freeze(b.freezeParams({ choices: { interruptAfterMs: 0 } }));
    await waitFor(() => b.world.log.includes('keys %3 1b'));
    expect(b.world.log).toEqual(['settle', 'settle', 'keys %3 1b']);
    await b.world.settle();
    await b.world.advance(500);

    expect((await carried).manifest.transactionId).toBe(TX);
    expect((await waiting).code).toBe('not_ready');
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toEqual(['kill @1', 'kill @2', 'kill @3']);
  });

  withGit('carries the graph of a repository a character stands in', async () => {
    const b = boot({ realGit: true });
    b.gateway.begin();
    const bo = path.join(b.work, 'bo');
    repo(bo, { 'index.ts': 'export {};\n' });
    const { manifest } = await b.handover.freeze(b.freezeParams());
    expect(manifest.git?.map((g) => ({ main: g.main?.path, characters: g.main?.characters }))).toEqual([{ main: bo, characters: ['c_bo'] }]);
    expect(manifest.roots.find((r) => r.path === bo)?.kind).toBe('repo');
  });

  it('finds a name it cannot carry, a transcript that is gone or a character kept here before it touches a terminal', async () => {
    const b = boot();
    b.gateway.begin();
    fs.writeFileSync(path.join(b.work, 'ada', 'bad\x01name'), '');
    fs.rmSync(b.transcript);
    b.store.update((d) => { d.characters.c_cy.keepHere = true; });
    const r = await refusal(b.handover.freeze(b.freezeParams()));
    expect(r.code).toBe('blocked');
    expect((r.data.blockers as { code: string }[]).map((x) => x.code)).toEqual(['character_pinned', 'path_unsupported', 'transcript_missing']);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    expect(b.ownership.writable()).toBe(true);
    expect(fs.existsSync(b.paths.journal)).toBe(false);
  });

  it('blocks a character working in the folder this daemon\'s Claude keeps its login in, wherever CLAUDE_CONFIG_DIR puts it', async () => {
    const b = boot();
    const config = path.join(b.work, 'claude-config');
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, '.credentials.json'), '{}');
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    b.store.update((d) => { d.characters.c_cy.cwd = config; });
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() }).finally(() => vi.unstubAllEnvs());
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'path_unsupported', message: `${config} holds ${path.join(config, '.credentials.json')}, which stays on its machine` }));
  });

  it("blocks a character working in this daemon's OpenCode data folder, wherever XDG_DATA_HOME puts it", async () => {
    const b = boot();
    const data = path.join(b.work, 'xdg-data/opencode');
    fs.mkdirSync(data, { recursive: true });
    vi.stubEnv('XDG_DATA_HOME', path.dirname(data));
    b.store.update((d) => { d.characters.c_cy.cwd = data; });
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() }).finally(() => vi.unstubAllEnvs());
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'path_unsupported', message: `${data} stays on its machine` }));
  });

  it('refuses a cwd the fence finds reached through a link before it touches a terminal, and lets the fleet run again', async () => {
    const b = boot();
    b.gateway.begin();
    fs.symlinkSync(path.join(b.work, 'cy'), path.join(b.work, 'linked'));
    b.store.update((d) => { d.characters.c_cy.cwd = path.join(b.work, 'linked'); });
    const r = await refusal(b.handover.freeze(b.freezeParams()));
    expect(r.code).toBe('blocked');
    expect((r.data.blockers as { code: string }[]).map((x) => x.code)).toEqual(['path_symlinked']);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    expect(b.ownership.writable()).toBe(true);
  });

  it('reopens exactly the terminals it stopped and lets the fleet run again when a blocker turns up only after windows closed', async () => {
    const b = boot();
    b.gateway.begin();
    // the session goes while its window closes, which nothing before the rest could have seen
    b.world.onKill = () => { fs.rmSync(b.transcript, { force: true }); };
    const r = await refusal(b.handover.freeze(b.freezeParams()));
    expect(r.code).toBe('blocked');
    expect((r.data.blockers as { code: string }[]).map((x) => x.code)).toEqual(['transcript_missing']);
    expect(b.world.log).toEqual([
      'settle', 'detach c_ada', 'detach c_bo', 'kill @1', 'kill @2', 'kill @3',
      'ensure-server', 'revive c_ada', 'second c_ada', 'revive c_bo', 'activate', 'reconcile',
    ]);
    expect(b.store.state.characters.c_cy.tmux).toBeUndefined();
    expect(b.ownership.writable()).toBe(true);
    expect(ownerFile(b.paths)).toEqual({ fleetId, generation: 4, ownerMachineId: me });
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(fs.existsSync(b.paths.manifest(TX))).toBe(false);
  });

  it('gives way to an abort while it waits on a working agent, closing nothing', async () => {
    const b = boot();
    b.gateway.begin();
    b.store.update((d) => { d.characters.c_bo.agent!.status = 'working'; });
    const freezing = refusal(b.handover.freeze(b.freezeParams()));
    await b.world.settle();
    expect(b.ownership.writable()).toBe(false);

    b.gateway.abort();
    await b.handover.abort({ transactionId: TX, generation: 4 });

    expect((await freezing).code).not.toBe('');
    expect(b.world.log.filter((l) => /^(kill|keys|SIG|revive|second)/.test(l))).toEqual([]);
    expect(b.ownership.writable()).toBe(true);
    expect(fs.existsSync(b.paths.journal)).toBe(false);
  });

  it('answers a freeze resumed after its tmux server died with every window, carrying each terminal dormant and none as rested', async () => {
    const b = boot();
    b.gateway.begin();
    // the daemon died mid-rest before it closed a window, and its tmux server, windows and agents went with it
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze', updatedAt: 0,
    }));
    await b.ownership.freeze(b.gateway.record.transaction!);
    b.world.panes.clear();
    const sock = b.paths.tmuxSock;
    b.world.tmux.listWindows = async () => {
      throw Object.assign(new Error(`Command failed: /usr/bin/tmux -S ${sock} -f ${b.paths.tmuxConf} list-panes -s -t fleet\nno server running on ${sock}\n`), {
        code: 1, stderr: `no server running on ${sock}\n`,
      });
    };
    const again = await b.restart();
    expect(again.ownership.writable()).toBe(false);

    const { manifest } = await again.handover.freeze(b.freezeParams());

    expect(journalOf(b.paths)).toMatchObject({ manifestDigest: manifestDigest(manifest), stoppedTerminals: [] });
    const carried = Object.values(manifest.snapshot.characters);
    expect(carried.every((c) => !c.tmux && !c.second?.tmux && !c.restedBy && !c.second?.restedBy)).toBe(true);
    expect(manifest.snapshot.characters.c_bo).toMatchObject({ agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` } });
    expect(b.world.log.filter((l) => /^(kill|detach)/.test(l))).toEqual([]);
  });

  it('refuses to freeze again a handover it is aborting', async () => {
    const b = boot();
    b.gateway.begin();
    await b.handover.freeze(b.freezeParams());
    const j = journalOf(b.paths)!;
    b.handover.write({ ...j, phase: 'aborted' });
    expect((await refusal(b.handover.freeze(b.freezeParams()))).code).toBe('transaction_mismatch');
  });
});

describe('source abort', () => {
  async function frozen(o: Boot = {}) {
    const b = boot(o);
    b.gateway.begin();
    await b.handover.freeze(b.freezeParams());
    b.world.log.length = 0;
    return b;
  }

  it('takes the fleet back once the gateway names this machine at the generation with the handover closed, reviving only what it stopped', async () => {
    const b = await frozen();
    b.gateway.abort();
    const surrenderAtClose: unknown[] = [];
    b.handover.onEvent((e) => { if (e.event === 'handover.changed') surrenderAtClose.push(ownerFile(b.paths).surrendered); });

    expect(await b.handover.abort({ transactionId: TX, generation: 4 })).toEqual({});

    expect(b.world.log).toEqual(['ensure-server', 'revive c_ada', 'second c_ada', 'revive c_bo', 'activate', 'reconcile']);
    // c_cy was dormant before the handover and stays so
    expect(b.store.state.characters.c_cy.tmux).toBeUndefined();
    // the journal is closed while the surrender still stands, so no start in between reads an aborted journal as a live one
    expect(surrenderAtClose).toEqual([true, true]);
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(ownerFile(b.paths)).toEqual({ fleetId, generation: 4, ownerMachineId: me });
    expect(fs.existsSync(b.paths.manifest(TX))).toBe(false);
    expect(b.ownership.writable()).toBe(true);
    expect(b.handover.status()).toEqual({});

    // again: nothing is left to abort, and nothing is done
    expect(await b.handover.abort({ transactionId: TX, generation: 4 })).toEqual({});
    expect(b.world.log).toHaveLength(6);
  });

  it('stays frozen while the gateway cannot be asked, holds the handover open, has moved on or has committed it', async () => {
    const cases: [string, (g: Gateway) => void, string][] = [
      ['no answer', (g) => { g.down = true; }, 'authority_unreachable'],
      ['still open', () => {}, 'not_ready'],
      ['another generation', (g) => { g.abort(); g.record.generation = 5; }, 'generation_mismatch'],
      ['committed', (g) => { g.record = { fleetId, generation: 5, ownerMachineId: trift, transaction: { ...g.record.transaction!, phase: 'committed' } }; }, 'handover_committed'],
      ['another handover from here past preparing', (g) => g.begin({ id: 'tx-2', phase: 'ready-to-commit' }), 'not_ready'],
    ];
    for (const [what, set, code] of cases) {
      const b = await frozen();
      set(b.gateway);
      expect((await refusal(b.handover.abort({ transactionId: TX, generation: 4 }))).code, what).toBe(code);
      expect(b.ownership.writable(), what).toBe(false);
      expect(journalOf(b.paths)?.phase, what).toBe('freeze');
      expect(b.world.log, what).toEqual([]);
    }
  });

  it('refuses an abort of a journal that has committed, whatever the gateway says', async () => {
    const b = await frozen();
    b.gateway.abort();
    b.handover.write({ ...journalOf(b.paths)!, phase: 'commit' });
    expect((await refusal(b.handover.abort({ transactionId: TX, generation: 4 }))).code).toBe('handover_committed');
    expect(b.ownership.writable()).toBe(false);
  });

  it('lets a standalone fleet out of a freeze without any gateway', async () => {
    const b = boot({ standalone: true });
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze',
      stoppedTerminals: [{ characterId: 'c_cy' }], updatedAt: 1,
    }));
    const again = await b.restart();
    expect(again.ownership.writable()).toBe(false);
    expect(ownerFile(b.paths)).toMatchObject({ surrendered: true });

    await again.handover.abort({ transactionId: TX, generation: 4 });

    expect(b.world.log).toEqual(['ensure-server', 'revive c_cy', 'activate', 'reconcile']);
    expect(again.ownership.writable()).toBe(true);
    expect(ownerFile(b.paths)).toEqual({ fleetId, generation: 4, ownerMachineId: me });
  });

  it('keeps the window a rest that died left open for a terminal it stopped, and opens none beside it', async () => {
    const b = boot();
    b.gateway.begin();
    // the rest journaled the terminals it stops, and died before it closed ada's second window
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze',
      stoppedTerminals: [{ characterId: 'c_ada', term: 2 }], updatedAt: 1,
    }));
    await b.ownership.freeze(b.gateway.record.transaction!);
    const again = await b.restart();
    b.gateway.abort();

    expect(await again.handover.abort({ transactionId: TX, generation: 4 })).toEqual({});

    expect(b.store.state.characters.c_ada.second?.tmux).toEqual(win(2));
    expect(b.world.log.filter((l) => l.startsWith('second'))).toEqual([]);
    expect(again.ownership.writable()).toBe(true);
  });

  it('revives a working agent whose window a rest that died closed without telling it a restart cut it off', async () => {
    const b = boot();
    b.store.update((d) => { d.characters.c_bo.agent!.status = 'working'; });
    b.gateway.begin();
    // the rest killed bo's window and died before it laid bo dormant
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze',
      stoppedTerminals: [{ characterId: 'c_bo' }], updatedAt: 1,
    }));
    b.world.panes.delete('@3');
    await b.ownership.freeze(b.gateway.record.transaction!);
    const again = await b.restart();
    b.gateway.abort();
    const revives: unknown[] = [];
    const revive = b.deps.fleet.reviveCharacter;
    b.deps.fleet.reviveCharacter = async (id) => { revives.push(structuredClone(b.store.state.characters[id].revive)); return revive(id); };

    await again.handover.abort({ transactionId: TX, generation: 4 });

    expect(revives).toEqual([{ command: `claude --resume ${SID}` }]);
  });

  it('resumes an agent a lost tmux cut off mid-turn during the freeze once the abort lets the fleet run again', async () => {
    const b = boot({ characters: (work) => [char('c_bo', path.join(work, 'bo'), { tmux: win(3) })] });
    b.store.update((d) => { d.characters.c_bo.agent = b.agent('working'); });
    b.gateway.begin();
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze', updatedAt: 1,
    }));
    await b.ownership.freeze(b.gateway.record.transaction!);
    // the machine restarted frozen, and bo's window went with its tmux server
    b.world.panes.delete('@3');
    const again = await b.restart();
    b.gateway.abort();
    // the fleet's own reconcile, which lays a terminal whose window went mid-turn dormant as interrupted
    b.deps.fleet.reconcileNow = async () => {
      b.world.log.push('reconcile');
      b.store.update(reconcile(b.store.state, await b.world.tmux.listWindows(), 0).mutate);
    };
    const revives: unknown[] = [];
    const revive = b.deps.fleet.reviveCharacter;
    b.deps.fleet.reviveCharacter = async (id) => { revives.push(structuredClone(b.store.state.characters[id].revive)); return revive(id); };

    await again.handover.abort({ transactionId: TX, generation: 4 });

    expect(b.world.log).toEqual(['activate', 'reconcile', 'revive c_bo']);
    // interrupted, so the fleet's revive hands the agent RESUME_NOTE
    expect(revives).toEqual([{ command: `claude --resume ${SID}`, interrupted: true }]);
  });

  it('finishes an abort a crash cut short after the journal closed and before the fleet was unfrozen', async () => {
    const b = await frozen();
    b.gateway.abort();
    fs.rmSync(b.paths.journal);
    const again = await b.restart();
    expect(again.ownership.writable()).toBe(false);

    await again.handover.abort({ transactionId: TX, generation: 4 });

    expect(again.ownership.writable()).toBe(true);
    expect(b.world.log).toEqual(['activate', 'reconcile']);
  });

  it('refuses to take back a fleet frozen for another handover', async () => {
    const b = await frozen();
    b.gateway.abort();
    fs.rmSync(b.paths.journal);
    const again = await b.restart();
    const r = await refusal(again.handover.abort({ transactionId: 'tx-2', generation: 4 }));
    expect(r.code).toBe('transaction_mismatch');
    expect(again.ownership.writable()).toBe(false);
  });

  it('keeps going when one terminal will not reopen, and says which', async () => {
    const b = await frozen();
    b.gateway.abort();
    b.deps.fleet.reviveCharacter = async (id) => { throw new Error(`no such directory for ${id}`); };
    await b.handover.abort({ transactionId: TX, generation: 4 });
    expect(b.ownership.writable()).toBe(true);
    expect(b.events.filter((e) => e.event === 'handover.entity' && e.data.error).map((e) => e.event === 'handover.entity' && e.data)).toEqual([
      { transactionId: TX, kind: 'character', id: 'c_ada', phase: 'aborted', error: 'no such directory for c_ada' },
      { transactionId: TX, kind: 'character', id: 'c_bo', phase: 'aborted', error: 'no such directory for c_bo' },
    ]);
  });
});

describe('source under a forced record', () => {
  async function frozen() {
    const b = boot();
    b.gateway.begin();
    await b.handover.freeze(b.freezeParams());
    b.world.log.length = 0;
    return b;
  }
  const forced = (ownerMachineId: MachineId): OwnerRecord => ({ fleetId, generation: 6, ownerMachineId });
  const revived = ['ensure-server', 'revive c_ada', 'second c_ada', 'revive c_bo'];

  it('lets its handover go, revives only what that handover stopped and runs the fleet again when the record names this machine', async () => {
    const b = await frozen();
    expect(await b.handover.adopt(forced(me))).toMatchObject({ adopted: true, superseded: TX, ownership: { generation: 6, ownerMachineId: me, frozen: false } });
    expect(b.world.log).toEqual([...revived, 'activate', 'reconcile']);
    // c_cy was dormant before the handover and stays so
    expect(b.store.state.characters.c_cy.tmux).toBeUndefined();
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(fs.existsSync(b.paths.manifest(TX))).toBe(false);
    expect(ownerFile(b.paths)).toEqual(forced(me));
    expect(b.ownership.writable()).toBe(true);
  });

  it('lets its handover go and stays a read-only replica, reviving nothing, when the record names another machine', async () => {
    const b = await frozen();
    expect(await b.handover.adopt(forced(elsewhere))).toMatchObject({ adopted: true, superseded: TX });
    expect(b.world.log).toEqual(['deactivate']);
    expect(journalOf(b.paths)).toBeUndefined();
    expect(ownerFile(b.paths)).toEqual(forced(elsewhere));
    expect(b.ownership.writable()).toBe(false);
    expect(b.store.state.characters.c_ada.tmux).toBeUndefined();
  });

  it('leaves its handover alone for the record that handover itself commits', async () => {
    const b = await frozen();
    const committed: OwnerRecord = { fleetId, generation: 5, ownerMachineId: trift, transaction: { ...b.gateway.record.transaction!, phase: 'committed' } };
    expect(await b.handover.adopt(committed)).toMatchObject({ adopted: false });
    expect(await b.handover.adopt({ fleetId, generation: 5, ownerMachineId: trift })).toMatchObject({ adopted: false });
    expect(journalOf(b.paths)?.phase).toBe('freeze');
    expect(b.ownership.isFrozen()).toBe(true);
    expect(b.world.log).toEqual([]);
  });

  it('removes its manifest before it closes the journal that names it, so a start finishes what a crash between left', async () => {
    const b = await frozen();
    const manifest = b.paths.manifest(TX);
    const rm = fs.rmSync;
    const crash = vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => { if (p === manifest) throw new Error('crashed'); rm(p, o); });
    await expect(b.handover.adopt(forced(me))).rejects.toThrow('crashed');
    crash.mockRestore();
    const again = await b.restart();
    b.gateway.record = forced(me);
    await adoptAtStart({ handover: again.handover, authority: b.gateway, fleetId, log: silentLogger });
    for (const f of [b.paths.journal, manifest]) expect(fs.existsSync(f), f).toBe(false);
    expect(ownerFile(b.paths)).toEqual(forced(me));
  });

  it('takes the record at start, and finishes letting go a handover a crash left open after the record was taken', async () => {
    const b = await frozen();
    fs.writeFileSync(b.paths.owner, JSON.stringify(forced(me)));
    const again = await b.restart();
    expect(again.ownership.writable()).toBe(false);
    b.gateway.record = forced(me);

    await adoptAtStart({ handover: again.handover, authority: b.gateway, fleetId, log: silentLogger });

    expect(again.ownership.writable()).toBe(true);
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(ownerFile(b.paths)).toEqual(forced(me));
    expect(b.world.log).toEqual([...revived, 'activate', 'reconcile']);
  });
});

describe('source complete', () => {
  async function frozen() {
    const b = boot();
    b.gateway.begin();
    const { manifest } = await b.handover.freeze(b.freezeParams());
    b.world.log.length = 0;
    // what the transfer verified: here one file changed after the freeze and before the last pass
    const landed = replicaRoots(manifest).map((r) => ({ id: r.id, files: manifest.roots.find((x) => x.id === r.id)!.files.map((f) => (f.type === 'file' ? { ...f, mtimeMs: f.mtimeMs + 1 } : f)) }));
    const committed = (): OwnerRecord => ({ fleetId, generation: 5, ownerMachineId: trift, transaction: { ...b.gateway.record.transaction!, phase: 'committed' } });
    return { b, manifest, landed, committed };
  }

  it('seals what the transfer verified in each root at the next generation, takes the committed record, and closes its journal', async () => {
    const { b, manifest, landed, committed } = await frozen();
    b.gateway.record = committed();

    expect(await b.handover.complete({ transactionId: TX, generation: 4, landed })).toEqual({});

    for (const r of replicaRoots(manifest)) {
      expect(JSON.parse(fs.readFileSync(b.paths.replicaRecord(fleetId, r.path), 'utf8')), r.path).toMatchObject({
        state: 'sealed', sealedBy: TX, generation: 5, manifestDigest: manifestDigest(manifest), baseline: landed.find((x) => x.id === r.id)!.files,
      });
    }
    expect(ownerFile(b.paths)).toEqual(committed());
    expect(b.ownership.writable()).toBe(false);
    expect(() => b.ownership.assertOwner('mutation')).toThrow(/moved to another machine/);
    for (const f of [b.paths.journal, b.paths.manifest(TX)]) expect(fs.existsSync(f)).toBe(false);
    // ended here, so the fleet coming back starts afresh
    expect(b.world.log).toEqual(['deactivate']);
    // again: nothing is left to complete
    expect(await b.handover.complete({ transactionId: TX, generation: 4, landed })).toEqual({});
    // the fleet's way back finds each root holding only what this handover left
    const replicas = new ReplicaStore({ fleetId, paths: b.paths });
    for (const r of replicaRoots(manifest)) {
      expect(await replicas.inspect(r, { transactionId: 'tx-2', excludes: manifest.excludes }), r.path).toMatchObject({ ok: true, kind: 'replica' });
    }
    const again = await b.restart();
    expect(again.handover.journalState()).toEqual({ kind: 'none' });
    expect(again.ownership.writable()).toBe(false);
  });

  it('completes after the gateway has cleared the handover it committed', async () => {
    const { b, landed } = await frozen();
    b.gateway.record = { fleetId, generation: 5, ownerMachineId: trift };
    expect(await b.handover.complete({ transactionId: TX, generation: 4, landed })).toEqual({});
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(ownerFile(b.paths)).toEqual({ fleetId, generation: 5, ownerMachineId: trift });
  });

  it('stays frozen with its journal while the handover has not committed, or the gateway cannot say', async () => {
    const cases: [string, (g: Gateway) => void, string][] = [
      ['preparing', () => {}, 'not_ready'],
      ['ready to commit', (g) => { g.record.transaction!.phase = 'ready-to-commit'; }, 'not_ready'],
      ['aborted', (g) => g.abort(), 'not_ready'],
      ['no answer', (g) => { g.down = true; }, 'authority_unreachable'],
    ];
    for (const [what, set, code] of cases) {
      const { b, landed } = await frozen();
      set(b.gateway);
      expect((await refusal(b.handover.complete({ transactionId: TX, generation: 4, landed }))).code, what).toBe(code);
      expect(journalOf(b.paths)?.phase, what).toBe('freeze');
      expect(ownerFile(b.paths), what).toMatchObject({ generation: 4, ownerMachineId: me, surrendered: true });
      expect(fs.existsSync(b.paths.manifest(TX)), what).toBe(true);
    }
  });
});

describe("this machine's agent CLIs", () => {
  it('are probed once a minute at most, shared between callers, and probed afresh for system.info, which preflight and freeze read', async () => {
    let calls = 0;
    const run: AgentRun = async (cmd, args) => {
      calls++;
      const line = [cmd, ...args].join(' ');
      if (line === 'claude --version') return { code: 0, stdout: '2.1.280 (Claude Code)\n' };
      if (line === 'claude auth status') return { code: 0, stdout: JSON.stringify({ loggedIn: true, configDirectory: '/cfg/claude' }) };
      throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    };
    let now = 0;
    const probe = agentProber({ run, read: async () => undefined, env: {}, homedir: '/home/t' }, 60_000, () => now);
    const [a, b] = await Promise.all([probe(), probe()]);
    expect(a).toBe(b);
    const once = calls;
    now = 59_999;
    await probe();
    expect(calls).toBe(once);
    now = 60_000;
    await probe();
    expect(calls).toBe(once * 2);

    const paths = resolvePaths(makeHome());
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger });
    const handover = new HandoverService({ ownership, journal: openJournal(paths), agents: probe, ...idleSides(paths) });
    const before = calls;
    const info = await handlers['system.info']({}, { ownership, handover } as Ctx);
    // a login fixed a moment ago counts at the next preflight
    expect(calls).toBe(before + once);
    expect(info.agentAdapters).toEqual([
      { kind: 'claude', version: '2.1.280', adapter: 1, home: '/cfg/claude', loggedIn: true, hooks: false },
      { kind: 'codex', adapter: 0, home: '/home/t/.codex', loggedIn: false, hooks: false },
      { kind: 'opencode', adapter: 0, home: path.join(profileHome(PRIVATE, '/home/t'), 'transcripts/opencode'), loggedIn: false, hooks: false },
    ]);
  });
});
