import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FleetConfig, FleetId, MachineId, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState,
  type Agent, type Robot, type Event, type HandoverChoices, type OwnerRecord, type ParsedParams, type SystemInfo, type TransactionRecord,
} from '@svall/protocol';
import { handlers, type Ctx } from '../../src/api/methods.js';
import { Config } from '../../src/config.js';
import { AuthorityFailure } from '../../src/gateway/authority.js';
import { SourceJournal, openJournal } from '../../src/handover/journal.js';
import { extensionBlockers } from '../../src/handover/git-extensions.js';
import { manifestDigest, readManifest, realScanFs } from '../../src/handover/manifest.js';
import { ProcessTable, type Proc } from '../../src/processes.js';
import { ReplicaStore, replicaRoots } from '../../src/handover/replicas.js';
import type { Clock } from '../../src/placement/rest.js';
import { HandoverService } from '../../src/handover/service.js';
import { agentProber, cliRunner, resumeFolders, type AgentProbe, type AgentRun } from '../../src/sessions/registry.js';
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
import { fakeEnv, hold } from '../sessions/fake-opencode.js';

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
// a repository with one commit, standing where a robot works
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
const robot = (id: string, cwd: string, over: Partial<Robot> = {}): Robot => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

// what the destination said of itself: the same release, logged in to Claude with the hooks in
const destinationInfo = (over: Partial<SystemInfo> = {}): SystemInfo => ({
  machineId: trift, release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: emptyState().version, transferSchema: TRANSFER_SCHEMA_VERSION,
  platform: 'linux', arch: 'x64',
  agentAdapters: [{ kind: 'claude', version: '2.1.280', adapter: 1, home: '/home/linus/.claude', loggedIn: true, hooks: true }],
  git: '2.43.0', heapLimit: 2 ** 32,
  ...over,
});

// a pane as tmux and ps show it: a shell at its prompt unless a job holds it
type Pane = { windowId: string; paneId: string; pid: number; path: string; job?: string[] };

class World {
  panes = new Map<string, Pane>();
  // processes outside any pane, each running until its group is killed
  extra: Proc[] = [];
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
  }).concat(this.extra), installedScripts('/Users/ada/.svall'));

  kill = (group: number, signal: NodeJS.Signals): void => {
    this.log.push(`${signal} ${group}`);
    for (const p of this.panes.values()) if (p.job && p.pid + 1 === group) delete p.job;
    this.extra = this.extra.filter((p) => p.pgid !== group);
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

// no robot stands in Git unless a test says so, and then real git reads it
const noGit: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

type Boot = { standalone?: boolean; probes?: AgentProbe[]; record?: object; robots?: (work: string) => Robot[]; realGit?: boolean };

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
  const robots = o.robots?.(work) ?? [
    robot('c_ada', path.join(work, 'ada'), { tmux: win(1), second: { cwd: path.join(work, 'ada'), unread: false, tmux: win(2) } }),
    robot('c_bo', path.join(work, 'bo'), { tmux: win(3), agent: agent('idle') }),
    robot('c_cy', path.join(work, 'cy'), { revive: { command: '' } }),
  ];
  store.update((d) => { for (const c of robots) d.robots[c.id] = c; });
  const world = new World();
  for (const c of robots) {
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
      for (const c of Object.values(store.state.robots)) if (c.revive?.interrupted) await fleet.reviveRobot(c.id);
    },
    reviveRobot: async (id) => {
      world.log.push(`revive ${id}`);
      store.update((d) => { d.robots[id].tmux = win(9); delete d.robots[id].revive; });
      return store.state.robots[id];
    },
    openSecond: async (id) => {
      // as the fleet does, a second terminal that still names its window keeps it
      if (store.state.robots[id].second?.tmux) return store.state.robots[id];
      world.log.push(`second ${id}`);
      store.update((d) => { const s = d.robots[id].second!; s.tmux = win(10); delete s.revive; });
      return store.state.robots[id];
    },
  };
  const probes = o.probes ?? [{ kind: 'claude', version: '2.1.280', home: path.join(work, '.claude'), loggedIn: true, hooks: true }];
  const deps: SourceDeps = {
    paths, store, fleet, tmux: world.tmux, viewers: world.viewers, processes: world.processes, kill: world.kill, clock: world.clock,
    ...(!o.standalone && { authority: () => gateway }), ...(!o.realGit && { git: noGit }), rest: { pollMs: 500, settleMs: 1000, waitMs: 5000 }, log: silentLogger,
  };
  const start = () => {
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger, standalone: o.standalone });
    const journal = openJournal(paths);
    const handover = new HandoverService({ ownership, journal, agents: async () => probes, fleet, ...idleSides(paths, { store }), source: deps });
    const events: Event[] = [];
    handover.onEvent((e) => events.push(e));
    return { ownership, journal, handover, events };
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
function opencodeBoot(loggedIn = true) {
  let logs = '';
  const b = boot({
    probes: [
      { kind: 'claude', version: '2.1.280', home: '/home/linus/.claude', loggedIn: true, hooks: true },
      { kind: 'opencode', version: '2.0.22', home: '/home/linus/.svall/transcripts/opencode', loggedIn, hooks: true },
    ],
    robots: (work) => {
      logs = path.join(work, '.svall/transcripts/opencode');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, `${OC}.jsonl`), `${JSON.stringify({ kind: 'user', text: 'remember PELICAN-42' })}\n`);
      return [
        robot('c_ada', path.join(work, 'ada'), {
          agent: { kind: 'opencode', sessionId: OC, transcriptPath: path.join(logs, `${OC}.jsonl`), status: 'idle', lastActivityAt: 0 }, revive: { command: `opencode -s ${OC}` },
        }),
        robot('c_bo', path.join(work, 'bo'), {
          tmux: win(3), agent: { kind: 'claude', sessionId: SID, transcriptPath: path.join(work, `.claude/projects/-bo/${SID}.jsonl`), status: 'idle', lastActivityAt: 0 },
        }),
      ];
    },
  });
  const env = fakeEnv(path.join(b.work, 'opencode'));
  const run = cliRunner(env);
  // where each export only checked, not carried, was written
  const checked: string[] = [];
  b.deps.cli = async (cmd, args, o) => {
    if (args[1] === 'export') {
      const carried = o?.stdout?.startsWith(`${logs}/`);
      if (!carried && o?.stdout) checked.push(o.stdout);
      b.world.log.push(`export ${carried ? 'written' : 'checked'}`);
    }
    return run(cmd, args, o);
  };
  const info = destinationInfo({
    agentAdapters: [...destinationInfo().agentAdapters, { kind: 'opencode', version: '2.0.22', adapter: 1, home: path.join(b.work, 'trift/transcripts/opencode'), loggedIn: true, hooks: true }],
  });
  return { ...b, env, logs, info, checked };
}

/**
 * A shell open in a projects folder, and a robot working in one of its repositories with its second terminal in
 * the folder; three others there no robot works in, and a repository inside one of them and inside the robot's.
 */
function developer() {
  const b = boot({
    realGit: true,
    robots: (work) => [
      robot('c_shell', path.join(work, 'Developer'), { tmux: win(1) }),
      robot('c_app', path.join(work, 'Developer/app'), { tmux: win(3), second: { cwd: path.join(work, 'Developer'), unread: false, tmux: win(4) } }),
    ],
  });
  const dev = path.join(b.work, 'Developer');
  for (const name of ['app', 'unrelated', 'unrelated-2', 'old-stuff', 'unrelated/vendor/lib', 'app/vendor/kit']) {
    fs.mkdirSync(path.join(dev, name), { recursive: true });
    repo(path.join(dev, name), { 'a.txt': name });
  }
  fs.writeFileSync(path.join(dev, 'notes.md'), 'notes\n');
  const holds = `is in ${dev}, which holds 3 Git repositories no robot works in (old-stuff, unrelated, unrelated-2), so the handover would carry them too; cd it to ~ or into the repository it works on`;
  const out = 'or leave them out with handover.exclude in fleet.json, such as /old-stuff/';
  const unused = [
    { code: 'repository_unused', entity: { kind: 'robot', id: 'c_app' }, message: `app's second terminal ${holds}, close app, ${out}` },
    { code: 'repository_unused', entity: { kind: 'robot', id: 'c_shell' }, message: `shell's terminal ${holds}, close shell, ${out}` },
  ];
  return { b, dev, unused };
}

describe('source preflight', () => {
  it('reports what would stop the move without writing, fencing or signalling, and only reads who the gateway says owns it', async () => {
    const b = boot({
      robots: (work) => {
        fs.symlinkSync(path.join(work, 'cy'), path.join(work, 'linked'));
        return [
          robot('c_ada', path.join(work, 'ada'), { tmux: win(1) }),
          robot('c_bo', path.join(work, 'bo'), { tmux: win(3) }),
          robot('c_cy', path.join(work, 'linked')),
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
    b.store.update((d) => { d.robots.c_bo.agent!.status = 'blocked'; });
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

  it('takes a destination whose home is not this machine\'s at preflight', async () => {
    const b = boot();
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ home: '/home/linus' }) });
    expect(r.blockers).toEqual([]);
  });

  it('asks the gateway who owns the fleet, as Freeze will, and blocks with why it could not, ssh_interactive only for an ssh that would have to ask', async () => {
    const b = boot();
    const ask = async () => (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() })).blockers;
    const asked = b.gateway.asked;
    expect(await ask()).toEqual([]);
    expect(b.gateway.asked).toBe(asked + 1);
    b.gateway.down = true;
    expect(await ask()).toEqual([{ code: 'authority_unreachable', message: expect.stringContaining('ECONNREFUSED') }]);
    b.gateway.down = false;
    const cases: [AuthorityFailure, string, RegExp][] = [
      [new AuthorityFailure('disconnected', 'ssh linus@trift exited 255 without an answer: Permission denied (publickey).', { prompt: 'auth', ssh: 'linus@trift' }), 'ssh_interactive', /Permission denied.*ssh-add.*ssh-copy-id linus@trift/],
      [new AuthorityFailure('disconnected', 'ssh linus@trift exited 255 without an answer: Host key verification failed.', { prompt: 'host_key', ssh: 'linus@trift' }), 'ssh_interactive', /host key.*run ssh linus@trift once/],
      [new AuthorityFailure('disconnected', 'ssh linus@trift exited -1 without an answer: # Tailscale SSH requires an additional check.', { prompt: 'approval', ssh: 'linus@trift' }), 'ssh_interactive', /approve it in the browser, or run ssh linus@trift once/],
      [new AuthorityFailure('invalid_request', '/Users/linus/.config/svall/machines.json names no ssh route to the gateway 1111'), 'authority_unreachable', /no ssh route.*svall host add/],
      [new AuthorityFailure('timeout', 'the gateway authority did not answer owner.get within 10000ms'), 'authority_unreachable', /did not answer owner\.get/],
      [new AuthorityFailure('authority_corrupt', `the record for fleet ${fleetId} is unreadable`), 'authority_corrupt', /unreadable.*svall fleet recover/],
      [new AuthorityFailure('not_found', `the gateway holds no record for fleet ${fleetId}`), 'identity_mismatch', /holds no record.*svall -p <fleet> host upgrade <gateway>/],
    ];
    for (const [failure, code, says] of cases) {
      b.gateway.refuses = failure;
      expect(await ask(), failure.code).toEqual([{ code, message: expect.stringMatching(says) }]);
    }
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

  it('warns of an OpenCode logged in on neither machine whose agent answers here, and blocks one that has not answered', async () => {
    const b = opencodeBoot(false);
    const preflight = async () => {
      const zen = { ...b.info, agentAdapters: b.info.agentAdapters.map((a) => (a.kind === 'opencode' ? { ...a, loggedIn: false } : a)) };
      const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: zen }) });
      return { blockers: r.blockers.map((x) => x.code), warnings: r.warnings.map((x) => x.code) };
    };
    expect(await preflight()).toMatchObject({ blockers: expect.arrayContaining(['agent_logged_out']), warnings: expect.not.arrayContaining(['agent_logged_out']) });
    fs.appendFileSync(path.join(b.logs, `${OC}.jsonl`), `${JSON.stringify({ kind: 'agent', text: 'PELICAN-42' })}\n`);
    expect(await preflight()).toMatchObject({ blockers: expect.not.arrayContaining(['agent_logged_out']), warnings: expect.arrayContaining(['agent_logged_out']) });
  });

  it('blocks an OpenCode session its CLI does not hold, at preflight and at freeze before any terminal rests', async () => {
    const b = opencodeBoot();
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: b.info }) });
    expect(r.blockers).toEqual([{ code: 'transcript_missing', message: expect.stringContaining(`Session not found: ${OC}`), entity: { kind: 'robot', id: 'c_ada' } }]);
    expect(fs.existsSync(path.join(b.logs, 'exports'))).toBe(false);
    b.gateway.begin();
    expect(blockersOf(await refusal(b.handover.freeze(b.freezeParams({ destination: b.machines({ info: b.info }).destination })))).map((x) => x.code)).toEqual(['transcript_missing']);
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toEqual([]);
  });

  it('blocks an OpenCode session with an undo pending, at preflight and at freeze before any terminal rests, and keeps no copy of it', async () => {
    const b = opencodeBoot();
    hold(b.env, { info: { id: OC, location: { directory: path.join(b.work, 'ada') }, revert: { messageID: 'msg_1' } }, messages: [{ id: 'msg_0', text: 'one' }, { id: 'msg_1', text: 'two' }] });
    const pending = { code: 'transcript_missing', message: expect.stringMatching(/^ada: .*an undo pending: send a message or \/redo, then move it$/), entity: { kind: 'robot', id: 'c_ada' } };
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines({ info: b.info }) });
    expect(r.blockers).toEqual([pending]);
    expect(b.checked.length).toBe(1);
    expect(b.checked.filter((f) => fs.existsSync(f))).toEqual([]);
    b.gateway.begin();
    expect(blockersOf(await refusal(b.handover.freeze(b.freezeParams({ destination: b.machines({ info: b.info }).destination }))))).toEqual([pending]);
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toEqual([]);
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

  withGit('blocks a repository whose config names a path in this home, which a move to another home leaves behind', async () => {
    const b = boot({ realGit: true });
    const bo = path.join(b.work, 'bo');
    repo(bo);
    execFileSync('git', ['config', 'core.hooksPath', path.join(b.work, 'hooks')], { cwd: bo });
    const ask = async (over: { home?: string } = {}) => (await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines(over) }))
      .blockers.filter((x) => x.code === 'path_unsupported').map((x) => x.message);
    expect(await ask({ home: '/home/linus' })).toEqual([expect.stringContaining(`${bo}: core.hookspath names ${path.join(b.work, 'hooks')}, a path in ${b.work}`)]);
    expect(await ask()).toEqual([]);
  });

  withGit('blocks a folder a terminal is in that holds repositories no robot works in, naming each terminal, unless they are chosen to be carried', async () => {
    const { b, dev, unused } = developer();
    const ask = async (choices: HandoverChoices = {}) => (await b.handover.preflight({ toMachineId: trift, choices, ...b.machines() })).blockers;
    expect(await ask()).toEqual(unused);
    expect(await ask({ carryUnused: true })).toEqual([]);

    // past the bound, the names alone find them
    b.deps.heapLimit = 2 * HEAP_PER_FILE;
    expect((await ask()).map((x) => x.code)).toEqual(['repository_unused', 'repository_unused', 'too_many_files']);
    delete b.deps.heapLimit;

    for (const name of ['unrelated', 'unrelated-2', 'old-stuff']) fs.rmSync(path.join(dev, name), { recursive: true });
    expect(await ask()).toEqual([]);
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
      robots: (work) => {
        const claude = (sessionId: string): Agent => {
          const transcriptPath = path.join(work, `.claude/projects/-work/${sessionId}.jsonl`);
          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', sessionId })}\n`);
          return { kind: 'claude', sessionId, transcriptPath, status: 'idle', lastActivityAt: 0 };
        };
        const ada = path.join(work, 'ada');
        return [
          robot('c_ada', ada, { tmux: win(1), agent: claude(ADA), second: { cwd: ada, unread: false, tmux: win(2), agent: claude(ADA2) } }),
          robot('c_bo', path.join(work, 'bo'), { tmux: win(3), agent: claude(BO) }),
          robot('c_cy', path.join(work, 'cy'), { agent: claude(CY), revive: { command: `claude --dangerously-skip-permissions --resume ${CY}` } }),
        ];
      },
    });
    b.world.panes.get('@1')!.job = ['claude --dangerously-skip-permissions'];
    b.world.panes.get('@2')!.job = ['claude --permission-mode bypassPermissions'];
    b.world.panes.get('@3')!.job = ['claude --effort high'];
    const before = structuredClone(b.store.state);

    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });

    expect(r.blockers).toEqual([]);
    const { c_ada: ada, c_bo: bo, c_cy: cy } = r.manifest.snapshot.robots;
    expect([ada.revive, ada.second?.revive, bo.revive, cy.revive]).toEqual([
      { command: `claude --dangerously-skip-permissions --resume ${ADA}` },
      { command: `claude --permission-mode 'bypassPermissions' --resume ${ADA2}` },
      { command: `claude --effort 'high' --resume ${BO}` },
      { command: `claude --dangerously-skip-permissions --resume ${CY}` },
    ]);
    expect(resumeFolders(r.manifest).map((f) => [f.robotId, f.bypass ?? false])).toEqual([['c_ada', true], ['c_ada', true], ['c_bo', false], ['c_cy', true]]);
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

  it('reads at freeze only the root files whose stat changed since its preflight read them', async () => {
    const b = boot();
    fs.writeFileSync(path.join(b.work, 'ada/big.bin'), 'x'.repeat(4096));
    // each stat as it reads once the files have sat for a while, so a hash of them is kept
    const older = <T extends { ctimeMs?: number }>(st: T): T => Object.assign(st, { ctimeMs: (st.ctimeMs ?? 0) - 10_000 });
    const aged = { ...realScanFs, stat: async (p: string) => older(await realScanFs.stat(p)), lstat: async (p: string) => older(await realScanFs.lstat(p)) };
    b.deps.scanFs = aged;
    await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() });
    fs.writeFileSync(path.join(b.work, 'bo/index.ts'), 'export const changed = 1;\n');
    const reads: string[] = [];
    b.deps.scanFs = { ...aged, read: (p) => { reads.push(p); return realScanFs.read(p); } };
    b.gateway.begin();
    const { manifest } = await b.handover.freeze(b.freezeParams());
    expect(reads.filter((p) => p.startsWith(path.join(b.work, 'ada')) || p.startsWith(path.join(b.work, 'bo')))).toEqual([path.join(b.work, 'bo/index.ts')]);
    const big = manifest.roots.flatMap((r) => r.files).find((f) => f.path === 'big.bin');
    expect(big).toMatchObject({ size: 4096, sha256: crypto.createHash('sha256').update('x'.repeat(4096)).digest('hex') });
  });

  it('fences the fleet, rests its terminals and has the surrender and journal on disk before it answers the manifest it kept', async () => {
    const b = boot();
    b.gateway.begin();
    const order: string[] = [];
    const write = b.journal.write.bind(b.journal);
    b.journal.write = (j) => { write(j); order.push(`journal ${j.phase} ${JSON.stringify(ownerFile(b.paths).surrendered ?? false)}`); };

    const { manifest } = await b.handover.freeze(b.freezeParams());

    expect(manifest.transactionId).toBe(TX);
    expect(manifest.generation).toBe(4);
    expect(manifest.toMachineId).toBe(trift);
    // the journal is written first; the surrender is on disk before anything is closed
    expect(order[0]).toBe('journal freeze false');
    expect(ownerFile(b.paths)).toMatchObject({ frozen: true, surrendered: true, transaction: { id: TX, toMachineId: trift } });
    const j = journalOf(b.paths)!;
    expect(j).toMatchObject({ transactionId: TX, generation: 4, phase: 'freeze', fromMachineId: me, toMachineId: trift, manifestDigest: manifestDigest(manifest) });
    expect(j.stoppedTerminals).toEqual([{ robotId: 'c_ada' }, { robotId: 'c_ada', term: 2 }, { robotId: 'c_bo' }]);
    const kept = readManifest(b.paths.manifest(TX));
    expect(kept.digest).toBe(j.manifestDigest);
    expect(fs.statSync(b.paths.manifest(TX)).mode & 0o777).toBe(0o600);
    // background writers settled before any window closed, then every window closed
    expect(b.world.log).toEqual(['settle', 'detach c_ada', 'detach c_bo', 'kill @1', 'kill @2', 'kill @3']);
    expect(b.store.state.robots.c_bo.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(Object.values(manifest.snapshot.robots).every((c) => !c.tmux && !c.second?.tmux)).toBe(true);
    expect(manifest.sessions.map((s) => s.sessionId)).toEqual([SID]);
    expect(() => b.ownership.assertOwner('mutation')).toThrow(/frozen/);
    const progress = b.events.filter((e) => e.event === 'handover.entity').map((e) => e.data);
    expect(progress).toEqual([
      { transactionId: TX, kind: 'robot', id: 'c_ada', phase: 'freeze' },
      { transactionId: TX, kind: 'robot', id: 'c_bo', phase: 'freeze' },
      { transactionId: TX, kind: 'robot', id: 'c_cy', phase: 'freeze' },
      { transactionId: TX, kind: 'robot', id: 'c_ada', phase: 'freeze', done: 2, total: 2 },
      { transactionId: TX, kind: 'robot', id: 'c_bo', phase: 'freeze', done: 1, total: 1 },
      { transactionId: TX, kind: 'robot', id: 'c_cy', phase: 'freeze', done: 0, total: 0 },
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
    expect(manifest.snapshot.robots.c_ada.revive).toEqual({ command: `opencode -s ${OC}` });
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
    b.store.update((d) => { d.robots.c_bo.agent!.status = 'blocked'; d.robots.c_bo.agent!.prompt = 'Run rm -rf build?'; });

    const first = await refusal(b.handover.freeze(b.freezeParams()));

    expect(first.code).toBe('blocked');
    expect(first.data.blockers).toEqual([{ code: 'agent_blocked', message: "bo's terminal is waiting on an answer: Run rm -rf build?", entity: { kind: 'robot', id: 'c_bo' } }]);
    expect(b.world.log.filter((l) => /^(kill|keys|SIG)/.test(l))).toEqual([]);
    // back to normal ownership, so the user can answer it, with the gateway's handover still open
    expect(b.ownership.writable()).toBe(true);
    expect(ownerFile(b.paths)).not.toHaveProperty('surrendered');
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    expect(b.events.filter((e) => e.event === 'handover.entity').at(-1)).toEqual({
      event: 'handover.entity', data: { transactionId: TX, kind: 'robot', id: 'c_bo', phase: 'freeze', error: "bo's terminal is waiting on an answer: Run rm -rf build?" },
    });

    b.store.update((d) => { d.robots.c_bo.agent!.status = 'idle'; delete d.robots.c_bo.agent!.prompt; });
    const { manifest } = await b.handover.freeze(b.freezeParams());
    expect(manifest.transactionId).toBe(TX);
    expect(b.world.log.filter((l) => l.startsWith('kill'))).toEqual(['kill @1', 'kill @2', 'kill @3']);
  });

  it('interrupts a blocked agent when asked again with Interrupt and carry', async () => {
    const b = boot();
    b.gateway.begin();
    b.store.update((d) => { d.robots.c_bo.agent!.status = 'blocked'; });
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
    b.store.update((d) => { d.robots.c_bo.agent!.status = 'working'; });
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

  withGit('carries the graph of a repository a robot stands in', async () => {
    const b = boot({ realGit: true });
    b.gateway.begin();
    const bo = path.join(b.work, 'bo');
    repo(bo, { 'index.ts': 'export {};\n' });
    const { manifest } = await b.handover.freeze(b.freezeParams());
    expect(manifest.git?.map((g) => ({ main: g.main?.path, robots: g.main?.robots }))).toEqual([{ main: bo, robots: ['c_bo'] }]);
    expect(manifest.roots.find((r) => r.path === bo)?.kind).toBe('repo');
  });

  withGit('refuses a folder that holds repositories no robot works in before any terminal rests, and carries it whole when chosen', async () => {
    const { b, dev, unused } = developer();
    b.gateway.begin();
    const refused = await refusal(b.handover.freeze(b.freezeParams()));
    expect(refused.data.blockers).toEqual(unused);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    const { manifest } = await b.handover.freeze(b.freezeParams({ choices: { carryUnused: true } }));
    expect(manifest.roots.find((r) => r.path === dev)!.files.map((f) => f.path)).toEqual(expect.arrayContaining(['notes.md', 'old-stuff/a.txt', 'unrelated/vendor/lib/a.txt']));
  });

  withGit('refuses a folder holding repositories no robot works in that a second terminal moved into unseen, once the rest records it there', async () => {
    const moved = () => {
      const b = boot({
        realGit: true,
        robots: (work) => [robot('c_app', path.join(work, 'Developer/app'), { tmux: win(3), second: { cwd: path.join(work, 'Developer/app'), unread: false, tmux: win(4) } })],
      });
      const dev = path.join(b.work, 'Developer');
      for (const name of ['app', 'old-stuff']) {
        fs.mkdirSync(path.join(dev, name), { recursive: true });
        repo(path.join(dev, name), { 'a.txt': name });
      }
      // its shell went up to the projects folder since the fleet last read where it stands
      b.world.panes.get('@4')!.path = dev;
      b.gateway.begin();
      return { b, dev };
    };
    const refused = moved();
    const r = await refusal(refused.b.handover.freeze(refused.b.freezeParams()));
    expect(r.data.blockers).toEqual([{
      code: 'repository_unused', entity: { kind: 'robot', id: 'c_app' },
      message: expect.stringContaining(`app's second terminal is in ${refused.dev}, which holds 1 Git repository no robot works in (old-stuff)`),
    }]);
    expect(refused.b.world.log).toContain('kill @4');

    const carried = moved();
    const { manifest } = await carried.b.handover.freeze(carried.b.freezeParams({ choices: { carryUnused: true } }));
    expect(manifest.roots.find((x) => x.path === carried.dev)!.files.map((f) => f.path)).toContain('old-stuff/a.txt');
  });

  withGit('refuses a repository a second terminal moved into unseen whose config names a path the move to another home leaves behind', async () => {
    const b = boot({
      realGit: true,
      robots: (work) => [robot('c_app', path.join(work, 'app'), { tmux: win(3), second: { cwd: path.join(work, 'app'), unread: false, tmux: win(4) } })],
    });
    for (const name of ['app', 'hooked']) {
      fs.mkdirSync(path.join(b.work, name), { recursive: true });
      repo(path.join(b.work, name), { 'a.txt': name });
    }
    const hooks = path.join(b.work, 'hooks');
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: path.join(b.work, 'hooked') });
    // its shell went into another repository since the fleet last read where it stands
    b.world.panes.get('@4')!.path = path.join(b.work, 'hooked');
    b.gateway.begin();
    const r = await refusal(b.handover.freeze(b.freezeParams(b.machines({ home: '/home/linus' }))));
    expect(r.data.blockers).toEqual([expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining(`core.hookspath names ${hooks}`) })]);
  });

  it('finds a name it cannot carry or a transcript that is gone before it touches a terminal', async () => {
    const b = boot();
    b.gateway.begin();
    fs.writeFileSync(path.join(b.work, 'ada', 'bad\x01name'), '');
    fs.rmSync(b.transcript);
    const r = await refusal(b.handover.freeze(b.freezeParams()));
    expect(r.code).toBe('blocked');
    expect((r.data.blockers as { code: string }[]).map((x) => x.code)).toEqual(['path_unsupported', 'transcript_missing']);
    expect(b.world.log).toEqual(['settle', 'activate', 'reconcile']);
    expect(b.ownership.writable()).toBe(true);
    expect(fs.existsSync(b.paths.journal)).toBe(false);
  });

  it('blocks a robot working in the folder this daemon\'s Claude keeps its login in, wherever CLAUDE_CONFIG_DIR puts it', async () => {
    const b = boot();
    const config = path.join(b.work, 'claude-config');
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, '.credentials.json'), '{}');
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    b.store.update((d) => { d.robots.c_cy.cwd = config; });
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() }).finally(() => vi.unstubAllEnvs());
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'path_unsupported', message: `${config} holds ${path.join(config, '.credentials.json')}, which stays on its machine` }));
  });

  it("blocks a robot working in this daemon's OpenCode data folder, wherever XDG_DATA_HOME puts it", async () => {
    const b = boot();
    const data = path.join(b.work, 'xdg-data/opencode');
    fs.mkdirSync(data, { recursive: true });
    vi.stubEnv('XDG_DATA_HOME', path.dirname(data));
    b.store.update((d) => { d.robots.c_cy.cwd = data; });
    const r = await b.handover.preflight({ toMachineId: trift, choices: {}, ...b.machines() }).finally(() => vi.unstubAllEnvs());
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'path_unsupported', message: `${data} stays on its machine` }));
  });

  it('refuses a cwd the fence finds reached through a link before it touches a terminal, and lets the fleet run again', async () => {
    const b = boot();
    b.gateway.begin();
    fs.symlinkSync(path.join(b.work, 'cy'), path.join(b.work, 'linked'));
    b.store.update((d) => { d.robots.c_cy.cwd = path.join(b.work, 'linked'); });
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
    expect(b.store.state.robots.c_cy.tmux).toBeUndefined();
    expect(b.ownership.writable()).toBe(true);
    expect(ownerFile(b.paths)).toEqual({ fleetId, generation: 4, ownerMachineId: me });
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(fs.existsSync(b.paths.manifest(TX))).toBe(false);
  });

  it('gives way to an abort while it waits on a working agent, closing nothing', async () => {
    const b = boot();
    b.gateway.begin();
    b.store.update((d) => { d.robots.c_bo.agent!.status = 'working'; });
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
    const carried = Object.values(manifest.snapshot.robots);
    expect(carried.every((c) => !c.tmux && !c.second?.tmux && !c.restedBy && !c.second?.restedBy)).toBe(true);
    expect(manifest.snapshot.robots.c_bo).toMatchObject({ agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` } });
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
    const [write, close] = [b.journal.write.bind(b.journal), b.journal.close.bind(b.journal)];
    b.journal.write = (j) => { write(j); surrenderAtClose.push(ownerFile(b.paths).surrendered); };
    b.journal.close = () => { close(); surrenderAtClose.push(ownerFile(b.paths).surrendered); };

    expect(await b.handover.abort({ transactionId: TX, generation: 4 })).toEqual({});

    expect(b.world.log).toEqual(['ensure-server', 'revive c_ada', 'second c_ada', 'revive c_bo', 'activate', 'reconcile']);
    // c_cy was dormant before the handover and stays so
    expect(b.store.state.robots.c_cy.tmux).toBeUndefined();
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
      stoppedTerminals: [{ robotId: 'c_cy' }], updatedAt: 1,
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
      stoppedTerminals: [{ robotId: 'c_ada', term: 2 }], updatedAt: 1,
    }));
    await b.ownership.freeze(b.gateway.record.transaction!);
    const again = await b.restart();
    b.gateway.abort();

    expect(await again.handover.abort({ transactionId: TX, generation: 4 })).toEqual({});

    expect(b.store.state.robots.c_ada.second?.tmux).toEqual(win(2));
    expect(b.world.log.filter((l) => l.startsWith('second'))).toEqual([]);
    expect(again.ownership.writable()).toBe(true);
  });

  it('waits for, and kills, the OpenCode server a window a rest that died closed left running before it reopens that terminal, and leaves one whose window is open', async () => {
    const b = boot();
    b.gateway.begin();
    const args = '/Users/ada/.opencode/bin/opencode serve --stdio --port 0';
    // the rest closed bo's window and died while its server lingered; ada's second window it never closed
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze', updatedAt: 1,
      stoppedTerminals: [{ robotId: 'c_bo', server: { pid: 3060, pgid: 3060, args } }, { robotId: 'c_ada', term: 2, server: { pid: 2060, pgid: 2060, args } }],
    }));
    b.world.panes.delete('@3');
    b.world.extra.push({ pid: 3060, ppid: 1, pgid: 3060, tpgid: 0, stat: 'Ss', args }, { pid: 2060, ppid: 2001, pgid: 2060, tpgid: 0, stat: 'Ss', args });
    await b.ownership.freeze(b.gateway.record.transaction!);
    const again = await b.restart();
    b.gateway.abort();

    const abort = again.handover.abort({ transactionId: TX, generation: 4 });
    await b.world.settle();
    await b.world.advance(500);
    expect(b.world.log).toEqual(['ensure-server']);
    await b.world.advance(500);
    await abort;

    expect(b.world.log).toEqual(['ensure-server', 'SIGKILL 3060', 'revive c_bo', 'activate', 'reconcile']);
    expect(b.world.extra.map((p) => p.pid)).toEqual([2060]);
  });

  it('revives a working agent whose window a rest that died closed without telling it a restart cut it off', async () => {
    const b = boot();
    b.store.update((d) => { d.robots.c_bo.agent!.status = 'working'; });
    b.gateway.begin();
    // the rest killed bo's window and died before it laid bo dormant
    b.handover.write(SourceJournal.parse({
      role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze',
      stoppedTerminals: [{ robotId: 'c_bo' }], updatedAt: 1,
    }));
    b.world.panes.delete('@3');
    await b.ownership.freeze(b.gateway.record.transaction!);
    const again = await b.restart();
    b.gateway.abort();
    const revives: unknown[] = [];
    const revive = b.deps.fleet.reviveRobot;
    b.deps.fleet.reviveRobot = async (id) => { revives.push(structuredClone(b.store.state.robots[id].revive)); return revive(id); };

    await again.handover.abort({ transactionId: TX, generation: 4 });

    expect(revives).toEqual([{ command: `claude --resume ${SID}` }]);
  });

  it('tells an agent a rest that died terminated that a restart cut it off, once an abort revives it, and no other', async () => {
    // the rest terminated bo's agent, or what ran in bo's second terminal, killed bo's window and died before it laid bo dormant
    for (const [terminated, interrupted] of [[{ robotId: 'c_bo' }, true], [{ robotId: 'c_bo', term: 2 as const }, false]] as const) {
      const b = boot();
      b.gateway.begin();
      b.handover.write(SourceJournal.parse({
        role: 'source', transactionId: TX, generation: 4, fleetId, fromMachineId: me, toMachineId: trift, phase: 'freeze',
        stoppedTerminals: [{ robotId: 'c_bo' }], terminated: [{ ...terminated, processes: [] }], updatedAt: 1,
      }));
      b.world.panes.delete('@3');
      await b.ownership.freeze(b.gateway.record.transaction!);
      const again = await b.restart();
      b.gateway.abort();
      const revives: unknown[] = [];
      const revive = b.deps.fleet.reviveRobot;
      b.deps.fleet.reviveRobot = async (id) => { revives.push(structuredClone(b.store.state.robots[id].revive)); return revive(id); };

      await again.handover.abort({ transactionId: TX, generation: 4 });

      expect(revives).toEqual([{ command: `claude --resume ${SID}`, ...(interrupted && { interrupted }) }]);
    }
  });

  it('resumes an agent a lost tmux cut off mid-turn during the freeze once the abort lets the fleet run again', async () => {
    const b = boot({ robots: (work) => [robot('c_bo', path.join(work, 'bo'), { tmux: win(3) })] });
    b.store.update((d) => { d.robots.c_bo.agent = b.agent('working'); });
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
    const revive = b.deps.fleet.reviveRobot;
    b.deps.fleet.reviveRobot = async (id) => { revives.push(structuredClone(b.store.state.robots[id].revive)); return revive(id); };

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

  it('reopens the terminals it rested when its journal could not be read, by the handover each one names as having rested it', async () => {
    const b = await frozen();
    b.gateway.abort();
    fs.writeFileSync(b.paths.journal, '{ not json');
    const again = await b.restart();
    expect(again.handover.status()).toEqual({ quarantined: expect.stringContaining(`${b.paths.journal}.broken-`) });
    expect(again.ownership.writable()).toBe(false);

    await again.handover.abort({ transactionId: TX, generation: 4 });

    expect(b.world.log).toEqual(['ensure-server', 'revive c_ada', 'second c_ada', 'revive c_bo', 'activate', 'reconcile']);
    // c_cy was dormant before the handover and stays so
    expect(b.store.state.robots.c_cy.tmux).toBeUndefined();
    expect(again.ownership.writable()).toBe(true);
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
    b.deps.fleet.reviveRobot = async (id) => { throw new Error(`no such directory for ${id}`); };
    await b.handover.abort({ transactionId: TX, generation: 4 });
    expect(b.ownership.writable()).toBe(true);
    expect(b.events.filter((e) => e.event === 'handover.entity' && e.data.error).map((e) => e.event === 'handover.entity' && e.data)).toEqual([
      { transactionId: TX, kind: 'robot', id: 'c_ada', phase: 'aborted', error: 'no such directory for c_ada' },
      { transactionId: TX, kind: 'robot', id: 'c_bo', phase: 'aborted', error: 'no such directory for c_bo' },
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
    expect(b.store.state.robots.c_cy.tmux).toBeUndefined();
    expect(fs.existsSync(b.paths.journal)).toBe(false);
    expect(fs.existsSync(b.paths.manifest(TX))).toBe(false);
    expect(ownerFile(b.paths)).toEqual(forced(me));
    expect(b.ownership.writable()).toBe(true);
  });

  it('revives what its handover rested when its journal could not be read, by the handover each terminal names, and runs the fleet', async () => {
    const b = await frozen();
    fs.writeFileSync(b.paths.journal, '{ not json');
    const again = await b.restart();
    expect(again.handover.status()).toEqual({ quarantined: expect.stringContaining(`${b.paths.journal}.broken-`) });
    expect(await again.handover.adopt(forced(me))).toMatchObject({ adopted: true, superseded: TX, ownership: { generation: 6, ownerMachineId: me, frozen: false } });
    expect(b.world.log).toEqual([...revived, 'activate', 'reconcile']);
    expect(b.store.state.robots.c_cy.tmux).toBeUndefined();
    expect(again.handover.journalState()).toEqual({ kind: 'none' });
    expect(fs.existsSync(b.paths.manifest(TX))).toBe(false);
    expect(again.ownership.writable()).toBe(true);
  });

  it('lets its handover go and stays a read-only replica, reviving nothing, when the record names another machine', async () => {
    const b = await frozen();
    expect(await b.handover.adopt(forced(elsewhere))).toMatchObject({ adopted: true, superseded: TX });
    expect(b.world.log).toEqual(['deactivate']);
    expect(journalOf(b.paths)).toBeUndefined();
    expect(ownerFile(b.paths)).toEqual(forced(elsewhere));
    expect(b.ownership.writable()).toBe(false);
    expect(b.store.state.robots.c_ada.tmux).toBeUndefined();
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

describe("this machine's lingering", () => {
  it('is what system.info says where loginctl answers, and nothing on a Mac or where it does not', async () => {
    const paths = resolvePaths(makeHome());
    const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger });
    const info = (linger?: () => Promise<{ user: string; on: boolean }>) =>
      handlers['system.info']({}, { ownership, handover: new HandoverService({ ownership, journal: openJournal(paths), ...(linger && { linger }), ...idleSides(paths) }) } as Ctx);
    expect((await info(async () => ({ user: 'linus', on: false }))).linger).toEqual({ user: 'linus', on: false });
    expect((await info(async () => { throw new Error('loginctl is not installed'); })).linger).toBeUndefined();
    expect((await info()).linger).toBeUndefined();
  });
});
