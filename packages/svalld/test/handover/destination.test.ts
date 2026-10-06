import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  FleetConfig, FleetId, FleetState, Home, MachineId, emptyState,
  type Character, type Event, type Island, type LandedRoot, type OwnerRecord, type ParsedParams, type TransferManifestV1,
} from '@svall/protocol';
import { readAgentProfile } from '../../src/agent-profiles.js';
import { startApi } from '../../src/api/server.js';
import { Config, loadConfig } from '../../src/config.js';
import { docFolders, docsDir, fleetDir, repoSlug } from '../../src/docs.js';
import { Fleet } from '../../src/fleet.js';
import { DestinationJournal, openJournal, type HandoverJournal } from '../../src/handover/journal.js';
import { SealRecord, type DestinationDeps } from '../../src/handover/destination.js';
import { discoverGit } from '../../src/handover/git-graph.js';
import { graphsHere } from '../../src/handover/git-import.js';
import { canonicalDigest } from '../../src/handover/hash.js';
import { DEFAULT_EXCLUDES, buildInventory, rootMatcher } from '../../src/handover/inventory.js';
import { buildManifest, manifestDigest, scanPath } from '../../src/handover/manifest.js';
import { ProcessTable, type Proc } from '../../src/handover/processes.js';
import { ReplicaStore, replicaRoots } from '../../src/handover/replicas.js';
import type { Clock } from '../../src/handover/rest.js';
import { HandoverService } from '../../src/handover/service.js';
import { opencodeAdapter } from '../../src/handover/sessions/opencode.js';
import { cliRunner, type AgentProbe } from '../../src/handover/sessions/registry.js';
import type { CliRun } from '../../src/handover/sessions/types.js';
import type { Authority } from '../../src/handover/source.js';
import { adoptAtStart, enterStartupMode, startupMode } from '../../src/handover/startup.js';
import { linkProblem } from '../../src/handover/validate.js';
import { silentLogger } from '../../src/log.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { resolvePaths, type Paths } from '../../src/paths.js';
import { Phones } from '../../src/phones.js';
import { Store } from '../../src/store.js';
import { runGit, type GitRunner } from '../../src/links/git.js';
import { tmuxConfText } from '../../src/tmux/conf.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes, hasTmux, idleSides, makeHome, stubMobile, stubUsage, waitFor } from '../helpers.js';
import { fakeEnv, held, hold, type Exported } from './fake-opencode.js';
import { crew as gitCrew, git, hasGit, park, parkedAt, seedHere, unpark, type Layout } from './git-fixture.js';

const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanHomes();
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const OC = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
const ocSession = (directory: string, texts: string[]): Exported => ({ info: { id: OC, location: { directory } }, messages: texts.map((text, i) => ({ id: `msg_${i}`, text })) });
const CODEX_ID = '01a0cd02-8ea0-75c1-89b3-89718ecbd91f';
const ROLLOUT = `sessions/2026/09/23/rollout-2026-09-23T08-44-52-${CODEX_ID}.jsonl`;
const fleetId = FleetId.parse(crypto.randomUUID());
const mac = MachineId.parse(crypto.randomUUID());
const trift = MachineId.parse(crypto.randomUUID());
const elsewhere = MachineId.parse(crypto.randomUUID());
const TX = 'tx-1';

const codeOf = (e: unknown): string => (e as { code?: string }).code ?? '';
const refusal = (p: Promise<unknown>): Promise<{ code: string; data: Record<string, unknown>; message: string }> =>
  p.then(() => { throw new Error('the call succeeded'); }, (e: Error & { data?: Record<string, unknown> }) => ({ code: codeOf(e), data: e.data ?? {}, message: e.message }));
const blockersOf = (r: { data: Record<string, unknown> }): { code: string; message: string }[] => (r.data.blockers ?? []) as { code: string; message: string }[];

const win = (n: number) => ({ windowId: `@${n}`, paneId: `%${n}` });
const char = (id: string, cwd: string, over: Partial<Character> = {}): Character => ({
  id, islandId: 'home', cell: { x: 0, y: 1 }, name: id.slice(2), portrait: 'fox', note: '', instructions: '', cwd, context: [],
  shell: { lastOutputAt: 0 }, unread: false, revive: { command: '' }, ...over,
});
// a character whose terminals this handover's rest closed, as the source's rest leaves them
const rested = (c: Character): Character => ({ ...c, restedBy: TX, ...(c.second && { second: { ...c.second, restedBy: TX } }) });

// every file under a folder with its size, mtime and mode, so a check can prove nothing was written there
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const st = fs.lstatSync(path.join(dir, name));
    out[name] = st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}:${(st.mode & 0o777).toString(8)}`;
  }
  return out;
}

const mode = (file: string): string => (fs.statSync(file).mode & 0o777).toString(8);

/** The gateway as this daemon asks it. */
class Gateway implements Authority {
  down = false;
  /** holds the next answer back until it resolves */
  gate?: Promise<void>;
  record: OwnerRecord = { fleetId, generation: 4, ownerMachineId: mac, transaction: { id: TX, fromMachineId: mac, toMachineId: trift, phase: 'preparing', startedAt: 1 } };
  async get(id: FleetId): Promise<OwnerRecord> {
    const gate = this.gate;
    this.gate = undefined;
    await gate;
    if (this.down) throw new Error('connect ECONNREFUSED /home/linus/.local/share/svall/gateway/authority.sock');
    if (id !== this.record.fleetId) throw new Error(`asked about ${id}`);
    return structuredClone(this.record);
  }
  ready(preparedDigest: string): void {
    this.record = { ...this.record, transaction: { ...this.record.transaction!, phase: 'ready-to-commit', preparedDigest } };
  }
  commit(preparedDigest: string): void {
    this.record = { fleetId, generation: 5, ownerMachineId: trift, transaction: { ...this.record.transaction!, phase: 'committed', preparedDigest } };
  }
}

/** A clock that moves only when a test says so. */
class Hands implements Clock {
  now = () => this.at;
  private at = 0;
  private sleepers: { at: number; wake: () => void }[] = [];
  sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((wake) => {
    const s = { at: this.at + ms, wake };
    this.sleepers.push(s);
    signal?.addEventListener('abort', () => { this.sleepers = this.sleepers.filter((x) => x !== s); });
  });
  async advance(ms: number): Promise<void> {
    this.at += ms;
    const due = this.sleepers.filter((s) => s.at <= this.at);
    this.sleepers = this.sleepers.filter((s) => s.at > this.at);
    for (const s of due) s.wake();
    await settle();
  }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

type Window = { key: string; paneId: string; pid: number; command: string; screen: string[]; dead?: true };

/**
 * The crew as the destination's fleet runs it: each terminal opens a window a moment later, and a resumed
 * agent reports its SessionStart unless the test keeps it silent.
 */
class Crew {
  log: string[] = [];
  lines: string[] = [];
  opening = 0;
  peak = 0;
  failing = new Set<string>();
  silent = new Set<string>();
  /** resumes that end at once, back at the shell, without a SessionStart */
  exiting = new Set<string>();
  /**
   * terminals whose window opens and then never another step, as the daemon dies there: with its resume typed and
   * not entered, or entered with the agent starting and its SessionStart gone with that daemon
   */
  dies = new Map<string, 'typed' | 'entered'>();
  /** each window open, by id: the terminal it is, what runs in its pane (a shell at its prompt is bash), and its screen */
  windows = new Map<string, Window>();
  /** which terminals the destination says it has yet to start */
  carried: (id: string, term?: 2) => boolean = () => false;
  private next = 10;
  private starts = new Set<(id: string, term: 2 | undefined, sessionId: string) => void>();

  constructor(private store: Store) {}

  fleet: DestinationDeps['fleet'] = {
    activate: async () => { this.log.push('activate'); },
    reconcileNow: async () => { this.log.push('reconcile'); },
    reviveCharacter: (id) => this.open(id),
    openSecond: (id) => this.open(id, 2),
    onSessionStart: (fn) => { this.starts.add(fn); return () => { this.starts.delete(fn); }; },
    carries: (fn) => { this.carried = fn; },
  };

  tmux: DestinationDeps['tmux'] = {
    sendLine: async (paneId, text, enter) => {
      this.lines.push(`${paneId} ${text}${enter ? ' ⏎' : ''}`);
      this.byPane(paneId)?.screen.push(text);
    },
    listWindows: async () => [...this.windows].map(([windowId, w]) => ({
      windowId, paneId: w.paneId, panePid: w.pid, name: w.key, command: w.command, path: '/', activity: 0, dead: w.dead === true,
    })),
    killWindow: async (windowId) => {
      const w = this.windows.get(windowId);
      this.windows.delete(windowId);
      if (w) this.log.push(`kill ${w.key}`);
    },
    capture: async (paneId) => Buffer.from((this.byPane(paneId)?.screen ?? []).join('\r\n')),
  };

  // each pane as ps shows it: its shell, and the job holding its terminal unless the shell is at its prompt
  processes = async (): Promise<ProcessTable> => new ProcessTable([...this.windows.values()].flatMap((w): Proc[] => {
    const job = w.command === 'bash' ? undefined : { pid: w.pid + 1, ppid: w.pid, pgid: w.pid + 1, tpgid: w.pid + 1, stat: 'S+', args: `${w.command} --resume` };
    return [{ pid: w.pid, ppid: 1, pgid: w.pid, tpgid: job?.pgid ?? w.pid, stat: 'Ss', args: '-bash' }, ...(job ? [job] : [])];
  }));

  window(key: string): Window | undefined {
    return [...this.windows.values()].find((w) => w.key === key);
  }

  private byPane(paneId: string): Window | undefined {
    return [...this.windows.values()].find((w) => w.paneId === paneId);
  }

  started(id: string, term: 2 | undefined, sessionId: string): void {
    for (const fn of this.starts) fn(id, term, sessionId);
  }

  private async open(id: string, term?: 2): Promise<Character> {
    const key = term ? `${id}-2` : id;
    this.opening++;
    this.peak = Math.max(this.peak, this.opening);
    await settle();
    this.opening--;
    this.log.push(`open ${key}`);
    if (this.failing.has(key)) throw new Error(`tmux could not open a window for ${key}`);
    const n = this.next++;
    this.store.update((d) => {
      const slot = term ? d.characters[id].second! : d.characters[id];
      slot.tmux = win(n);
      delete slot.revive;
    });
    const c = this.store.state.characters[id];
    const agent = (term ? c.second : c)?.agent;
    const dies = this.dies.get(key);
    const running = agent && dies !== 'typed' && !this.exiting.has(key);
    this.windows.set(win(n).windowId, { key, paneId: win(n).paneId, pid: n * 1000, command: running ? agent.kind : 'bash', screen: [] });
    if (dies) await new Promise(() => {});
    if (agent && !this.silent.has(key) && !this.exiting.has(key)) setImmediate(() => this.started(id, term, agent.sessionId));
    return c;
  }
}

/**
 * Copies what the manifest carries the way the controller's transfer would: each root under its claim, each session
 * into its stage, from where `from` says the source machine keeps a path.
 */
async function transfer(paths: Paths, manifest: TransferManifestV1, from: (p: string) => string): Promise<LandedRoot[]> {
  const replicas = new ReplicaStore({ fleetId, paths });
  const landed: LandedRoot[] = [];
  for (const r of replicaRoots(manifest)) {
    const root = manifest.roots.find((x) => x.id === r.id)!;
    const check = await replicas.claim(r, { transactionId: TX, excludes: manifest.excludes, incoming: root.files });
    if (!check.ok) throw new Error(`claim refused: ${check.blocker.message}`);
    fs.cpSync(from(root.path), check.path, { recursive: true, verbatimSymlinks: true });
    landed.push({ id: r.id, files: (await scanPath(check.path, rootMatcher(r.kind, manifest.excludes)))!.files });
  }
  manifest.sessions.forEach((s, i) => {
    for (const f of s.files) {
      const to = path.join(paths.sessionStage(TX, i), f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(from(s.sourceHome!), f.path), to);
    }
  });
  return landed;
}

type Tamper = (m: TransferManifestV1) => void;

/**
 * Mac to trift under one temp folder, where as on two real machines both keep the fleet under one home `dst`: the
 * Mac's tree is made there and the manifest read from it, then the tree is set aside at `src`, the Mac the fleet
 * leaves, and the transfer copies from it. `home` is this daemon's own fleet home. Four characters: one with a
 * second terminal, file context and a file: tab, a Claude session, a Codex session, and a shell standing at the
 * home itself. `before` sets this machine up before anything lands.
 */
async function scene(o: { tamper?: Tamper; before?: (s: { src: string; dst: string; base: string }) => void; land?: false; opencode?: true } = {}) {
  const base = fs.realpathSync(makeHome());
  const src = path.join(base, 'mac');
  const dst = path.join(base, 'home');
  const home = path.join(base, 'svall');
  for (const d of ['work/ada/sub', 'work/bo', 'work/demo', 'mc', `.claude/projects/-bo`, path.dirname(`.codex/${ROLLOUT}`)]) fs.mkdirSync(path.join(dst, d), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(dst, 'work/ada/notes.md'), 'ada\n');
  fs.writeFileSync(path.join(dst, 'work/ada/index.html'), '<p>ada</p>\n');
  fs.writeFileSync(path.join(dst, 'work/bo/index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dst, 'work/demo/notes.txt'), 'demo\n');
  fs.writeFileSync(path.join(dst, 'mc/README.md'), 'mission control\n');
  const transcript = path.join(dst, `.claude/projects/-bo/${SID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: path.join(dst, 'work/bo'), sessionId: SID, version: '2.1.280', message: { role: 'user', content: 'hi' } })}\n`);
  const rollout = path.join(dst, '.codex', ROLLOUT);
  const fixture = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/handover/codex/0.156.1', ROLLOUT), 'utf8');
  fs.writeFileSync(rollout, fixture.replaceAll('/home/source', dst));

  const paths = resolvePaths(home);
  // what this machine held of the fleet before: its own fleet.json and the replica state it last had
  fs.writeFileSync(paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, gatewayMachineId: trift, mobile: { logins: ['me@example.com', 'them@example.com'], origins: ['https://old.example'] } })));
  fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 4, ownerMachineId: mac }));
  loadConfig(paths);
  const store = Store.load(paths.state, () => {});
  store.update((d) => { d.scribeOff = true; });

  const fleet = FleetConfig.parse({ id: fleetId, gatewayMachineId: trift, home: { cwd: '~/mc' }, mobile: { logins: ['me@example.com'], origins: ['https://phone.example'] } });
  const state = emptyState();
  state.home = Home.parse(fleet.home);
  const tab = `${pathToFileURL(path.join(dst, 'work/ada/index.html')).href}?x=1#top`;
  for (const c of [
    rested(char('c_ada', path.join(dst, 'work/ada'), {
      second: { cwd: path.join(dst, 'work/ada/sub'), unread: false, revive: { command: '' } },
      context: [{ kind: 'file', ref: path.join(dst, 'work/ada/notes.md'), label: 'notes', source: 'manual' }],
      browser: { tabs: [{ id: 't_1', url: tab, title: 'ada' }], active: 't_1' },
    })),
    rested(char('c_bo', path.join(dst, 'work/bo'), {
      agent: { kind: 'claude', sessionId: SID, transcriptPath: transcript, status: 'idle', lastActivityAt: 0 }, revive: { command: `claude --resume ${SID}` },
    })),
    rested(char('c_cy', dst)),
    rested(char('c_dee', path.join(dst, 'work/demo'), {
      agent: { kind: 'codex', sessionId: CODEX_ID, transcriptPath: rollout, status: 'idle', lastActivityAt: 0 }, revive: { command: `codex resume -c tui.resume_cwd=session ${CODEX_ID}` },
    })),
    // dormant before the freeze, last closed by an earlier handover: this one carries it and leaves it as it was
    char('c_old', dst, { restedBy: 'tx-0', second: { cwd: dst, unread: false, revive: { command: '' } } }),
  ]) state.characters[c.id] = c;

  // with `opencode`, eve's OpenCode session: the Mac's OpenCode holds it, and the Mac's fleet logs it and wrote it out
  const oc = { mac: fakeEnv(path.join(base, 'oc-mac')), trift: fakeEnv(path.join(base, 'oc-trift')), session: ocSession('/Users/ada/work/eve', ['remember PELICAN-42']) };
  const ocLogs = path.join(base, 'mac-svall/transcripts/opencode');
  if (o.opencode) {
    fs.mkdirSync(path.join(dst, 'work/eve'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'work/eve/plan.md'), 'eve\n');
    fs.mkdirSync(ocLogs, { recursive: true });
    fs.writeFileSync(path.join(ocLogs, `${OC}.jsonl`), `${JSON.stringify({ kind: 'user', text: 'remember PELICAN-42' })}\n`);
    hold(oc.mac, oc.session);
    await opencodeAdapter.exportSession!(OC, path.join(ocLogs, `exports/${OC}.json`), cliRunner(oc.mac));
    state.characters.c_eve = rested(char('c_eve', path.join(dst, 'work/eve'), {
      agent: { kind: 'opencode', sessionId: OC, transcriptPath: path.join(ocLogs, `${OC}.jsonl`), status: 'idle', lastActivityAt: 0 }, revive: { command: `opencode -s ${OC}` },
    }));
  }

  const agentHomes = { claude: path.join(dst, '.claude'), codex: path.join(dst, '.codex'), ...(o.opencode && { opencode: path.join(home, 'transcripts/opencode') }) };
  const inventory = buildInventory(state, { fleet }, {
    source: { machineId: mac, home: dst, fleetHome: path.join(base, 'mac-svall') },
    destination: { machineId: trift, home: dst, fleetHome: home, agentHomes },
  });
  const built = await buildManifest(inventory, { transactionId: TX, generation: 4 });
  expect(built.blockers).toEqual([]);
  // the fleet leaves the Mac: this disk is trift's now, whose agents have their homes and nothing else yet
  fs.renameSync(dst, src);
  for (const d of Object.values(agentHomes)) fs.mkdirSync(d, { recursive: true });
  // this machine's Claude, whose config folder is not ~/.claude, trusts bo's folder in the .claude.json inside it
  fs.writeFileSync(path.join(agentHomes.claude, '.claude.json'), JSON.stringify({ projects: { [path.join(dst, 'work/bo')]: { hasTrustDialogAccepted: true } } }));
  o.before?.({ src, dst, base });
  const manifest = built.manifest;
  // a snapshot that still names live tmux ids, as a careless source could send
  manifest.snapshot.characters.c_ada.tmux = win(1);
  o.tamper?.(manifest);
  const landed = o.land === false ? [] : await transfer(paths, manifest, (p) => path.join(src, path.relative(dst, p)));
  const probes: AgentProbe[] = [
    { kind: 'claude', version: '2.1.280', home: agentHomes.claude, loggedIn: true, hooks: true },
    { kind: 'codex', version: '0.156.1', home: agentHomes.codex, loggedIn: true, hooks: true },
    ...(agentHomes.opencode ? [{ kind: 'opencode' as const, version: '2.0.22', home: agentHomes.opencode, loggedIn: true, hooks: true }] : []),
  ];
  return { base, src, dst, home, paths, store, manifest, digest: manifestDigest(manifest), landed, probes, tab, oc };
}
type Scene = Awaited<ReturnType<typeof scene>>;

type Prepare = ParsedParams<'handover.prepare'>;
const params = (s: Scene, over: Partial<Prepare> = {}): Prepare =>
  ({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest, landed: s.landed, ...over });

/** This destination's daemon, as main wires it, over the scene's home, in an account whose home is the fleet's unless `homedir` says otherwise. */
function daemon(
  s: { paths: Paths; store: Store; probes: AgentProbe[]; manifest: Pick<TransferManifestV1, 'home'> },
  o: { concurrency?: number; failWrite?: (j: HandoverJournal) => boolean; git?: GitRunner; homedir?: () => string; agents?: () => Promise<AgentProbe[]>; cli?: CliRun } = {},
) {
  const gateway = new Gateway();
  const clock = new Hands();
  const crew = new Crew(s.store);
  const config = loadConfig(s.paths);
  const start = (over: { concurrency?: number } = {}) => {
    const ownership = OwnershipState.load({ paths: s.paths, fleetId, machineId: trift, log: silentLogger });
    const journal = openJournal(s.paths);
    const write = journal.write.bind(journal);
    journal.write = (j) => { if (o.failWrite?.(j)) throw new Error('ENOSPC: no space left on device'); write(j); };
    const handover = new HandoverService({
      ownership, journal, agents: o.agents ?? (async () => s.probes), fleet: { ...crew.fleet, deactivate: async () => { crew.log.push('deactivate'); } },
      source: idleSides(s.paths, { store: s.store }).source,
      destination: {
        paths: s.paths, config, store: s.store, fleet: crew.fleet, tmux: crew.tmux, processes: crew.processes, authority: () => gateway, clock, ...(o.git && { git: o.git }),
        sessionStartMs: 60_000, concurrency: over.concurrency ?? o.concurrency ?? 2, homedir: o.homedir ?? (() => s.manifest.home), ...(o.cli && { cli: o.cli }), log: silentLogger,
      },
    });
    const events: Event[] = [];
    handover.onEvent((e) => events.push(e));
    return { ownership, handover, events };
  };
  return { gateway, clock, crew, config, start, ...start() };
}

const journalOf = (paths: Paths): DestinationJournal => DestinationJournal.parse(JSON.parse(fs.readFileSync(paths.journal, 'utf8')));

describe('destination prepare', () => {
  it('prepares the fleet beside the active state with every path as the source recorded it, and leaves state.json and tmux alone', async () => {
    const s = await scene();
    const d = daemon(s);
    const before = fs.readFileSync(s.paths.state);
    const r = await d.handover.prepare(params(s));

    const prepared = FleetState.parse(JSON.parse(fs.readFileSync(s.paths.preparedState(TX), 'utf8')));
    expect(r.preparedDigest).toBe(canonicalDigest(prepared));
    const { c_ada: ada, c_bo: bo, c_cy: cy, c_dee: dee } = prepared.characters;
    expect(ada.cwd).toBe(path.join(s.dst, 'work/ada'));
    expect(ada.second).toEqual({ cwd: path.join(s.dst, 'work/ada/sub'), unread: false, revive: { command: '' }, restedBy: TX });
    expect(ada.context[0].ref).toBe(path.join(s.dst, 'work/ada/notes.md'));
    expect(ada.browser!.tabs[0].url).toBe(`${pathToFileURL(path.join(s.dst, 'work/ada/index.html')).href}?x=1#top`);
    expect(ada.tmux).toBeUndefined();
    expect(ada.revive).toEqual({ command: '' });
    const placed = path.join(s.dst, '.claude/projects/-bo', `${SID}.jsonl`);
    expect(bo).toMatchObject({ cwd: path.join(s.dst, 'work/bo'), revive: { command: `claude --resume ${SID}` }, agent: { transcriptPath: placed } });
    expect(dee.agent!.transcriptPath).toBe(path.join(s.dst, '.codex', ROLLOUT));
    expect(cy.cwd).toBe(s.dst);
    expect(prepared.home.cwd).toBe('~/mc');
    expect(prepared.defaultCwd).toBe('~');

    // each session placed under this machine's agent home where the source kept it, and its stage cleared
    expect(fs.readFileSync(placed)).toEqual(fs.readFileSync(path.join(s.src, '.claude/projects/-bo', `${SID}.jsonl`)));
    expect(JSON.parse(fs.readFileSync(path.join(s.dst, '.codex', ROLLOUT), 'utf8').split('\n')[0]).payload.cwd).toBe(path.join(s.dst, 'work/demo'));
    expect(fs.existsSync(path.dirname(s.paths.sessionStage(TX, 0)))).toBe(false);

    const journal = journalOf(s.paths);
    expect(journal).toMatchObject({
      role: 'destination', transactionId: TX, generation: 5, phase: 'prepare', fromMachineId: mac, toMachineId: trift,
      manifestDigest: s.digest, preparedDigest: r.preparedDigest, fleet: { home: { cwd: '~/mc' } },
    });
    const seal = SealRecord.parse(JSON.parse(fs.readFileSync(s.paths.replicaSeal(TX), 'utf8')));
    expect(seal).toMatchObject({ transactionId: TX, generation: 5, manifestDigest: s.digest });
    expect(seal.roots.map((x) => x.id).sort()).toEqual(replicaRoots(s.manifest).map((x) => x.id).sort());
    for (const f of [s.paths.preparedState(TX), s.paths.journal, s.paths.replicaSeal(TX)]) expect(mode(f)).toBe('600');

    // nothing active moved: the old state, no window, no background work, and still a replica
    expect(fs.readFileSync(s.paths.state)).toEqual(before);
    expect(s.store.state.characters).toEqual({});
    expect([...d.crew.log, ...d.crew.lines]).toEqual([]);
    expect(d.ownership.writable()).toBe(false);
  });

  it("imports an OpenCode session into this machine's OpenCode, in the folder its terminal resumes in and over the copy an earlier handover left, before it prepares anything to revive", async () => {
    const s = await scene({ opencode: true });
    hold(s.oc.trift, ocSession(path.join(s.dst, 'work/eve'), []));
    const asked: string[] = [];
    const run = cliRunner(s.oc.trift);
    const d = daemon(s, { cli: (cmd, args, o) => { asked.push([cmd, ...args].join(' ')); return run(cmd, args, o); } });
    const { preparedDigest } = await d.handover.prepare(params(s));

    const eve = path.join(s.dst, 'work/eve');
    expect(held(s.oc.trift)).toEqual({ [OC]: { ...s.oc.session, info: { ...s.oc.session.info, location: { directory: eve } } } });
    const i = s.manifest.sessions.findIndex((x) => x.agent === 'opencode');
    expect(asked).toEqual([
      `opencode session delete --standalone ${OC}`,
      `opencode session import --standalone --directory ${eve} ${path.join(s.paths.sessionStage(TX, i), `exports/${OC}.json`)}`,
    ]);
    // Svall's log of the session is placed where this machine's plugin goes on writing it; the export is not
    const logs = path.join(s.home, 'transcripts/opencode');
    expect(fs.readdirSync(logs)).toEqual([`${OC}.jsonl`]);
    const prepared = FleetState.parse(JSON.parse(fs.readFileSync(s.paths.preparedState(TX), 'utf8')));
    expect(prepared.characters.c_eve).toMatchObject({ revive: { command: `opencode -s ${OC}` }, agent: { transcriptPath: path.join(logs, `${OC}.jsonl`) } });

    d.gateway.commit(preparedDigest);
    const r = await d.handover.activate({ transactionId: TX, generation: 5 });
    expect(r.characters.find((c) => c.id === 'c_eve')).toEqual({ id: 'c_eve', ok: true });
  });

  it('refuses to prepare while OpenCode has not imported the session, so nothing revives it with -s, and imports it once asked again', async () => {
    const s = await scene({ opencode: true });
    hold(s.oc.trift, ocSession('/elsewhere', []));
    const run = cliRunner(s.oc.trift);
    // a copy that will not go: OpenCode keeps it and answers the import with "Session already exists", exiting 0
    const keeping: CliRun = (cmd, args, o) => (args[1] === 'delete' ? Promise.resolve({ code: 1, stdout: '', stderr: 'Error: database is locked\n' }) : run(cmd, args, o));
    const r = await refusal(daemon(s, { cli: keeping }).handover.prepare(params(s)));
    expect(blockersOf(r)).toEqual([{ code: 'transcript_missing', message: expect.stringContaining('database is locked'), entity: { kind: 'character', id: 'c_eve' } }]);
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
    const quiet: CliRun = (cmd, args, o) => (args[1] === 'delete' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : run(cmd, args, o));
    expect(blockersOf(await refusal(daemon(s, { cli: quiet }).handover.prepare(params(s))))[0].message).toContain('Session already exists');
    expect(held(s.oc.trift)[OC].info.location.directory).toBe('/elsewhere');
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);

    await daemon(s, { cli: run }).handover.prepare(params(s));
    expect(held(s.oc.trift)[OC].messages).toEqual(s.oc.session.messages);
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(true);
  });

  it('answers a repeated prepare with the proof it gave, and writes nothing again', async () => {
    const s = await scene();
    const d = daemon(s);
    const first = await d.handover.prepare(params(s));
    const written = tree(s.home);
    expect(await d.handover.prepare(params(s))).toEqual(first);
    expect(await daemon(s).handover.prepare(params(s))).toEqual(first);
    expect(tree(s.home)).toEqual(written);
  });

  it('refuses a prepare meant for another machine, fleet, generation, transaction or manifest, and writes nothing', async () => {
    const s = await scene();
    const other = (m: Partial<TransferManifestV1>): Partial<Prepare> => {
      const manifest = { ...s.manifest, transactionId: TX, ...m };
      return { manifest, manifestDigest: manifestDigest(manifest) };
    };
    const written = { home: tree(s.home), dst: tree(s.dst) };
    const cases: [Partial<Prepare>, string, RegExp][] = [
      [other({ toMachineId: elsewhere }), 'blocked', /handed to .*, not this machine/],
      [other({ fromMachineId: trift }), 'blocked', /from this machine/],
      [other({ fleet: FleetConfig.parse({ id: FleetId.parse(crypto.randomUUID()), gatewayMachineId: trift }) }), 'blocked', /fleet/],
      [other({ fleet: FleetConfig.parse({ ...s.manifest.fleet, gatewayMachineId: elsewhere }) }), 'blocked', /gateway/],
      [{ generation: 4 }, 'generation_mismatch', /prepares generation 5, not 4/],
      [{ transactionId: 'tx-2' }, 'transaction_mismatch', /tx-2/],
      [{ manifestDigest: 'c'.repeat(64) }, 'transaction_mismatch', /hashes to/],
    ];
    for (const [over, code, message] of cases) {
      const r = await refusal(daemon(s).handover.prepare(params(s, over)));
      expect(r.code, JSON.stringify(over).slice(0, 80)).toBe(code);
      expect(`${r.message} ${blockersOf(r).map((b) => b.message).join(' ')}`).toMatch(message);
    }
    expect({ home: tree(s.home), dst: tree(s.dst) }).toEqual(written);
  });

  it('refuses a manifest path that climbs out of its root before it writes anything', async () => {
    const s = await scene();
    const manifest = structuredClone({ ...s.manifest, transactionId: TX });
    manifest.roots[0].files.push({ type: 'file', path: '../../escape.txt', mode: 0o644, size: 0, mtimeMs: 0, sha256: 'e'.repeat(64) });
    const written = tree(s.home);
    const r = await refusal(daemon(s).handover.prepare(params(s, { manifest, manifestDigest: manifestDigest(manifest) })));
    expect(r.code).toBe('blocked');
    expect(blockersOf(r)).toContainEqual(expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining('../../escape.txt') }));
    expect(tree(s.home)).toEqual(written);
  });

  it('blocks a carried root and a session a link on this machine leads away from where it belongs', async () => {
    // on this machine `work` and Claude's projects are links that lead elsewhere
    const s = await scene({
      before: ({ dst, base }) => {
        for (const d of ['outside/work', 'outside/projects']) fs.mkdirSync(path.join(base, d), { recursive: true });
        fs.symlinkSync(path.join(base, 'outside/work'), path.join(dst, 'work'));
        fs.symlinkSync(path.join(base, 'outside/projects'), path.join(dst, '.claude/projects'));
      },
    });
    const r = await refusal(daemon(s).handover.prepare(params(s)));
    expect(r.code).toBe('blocked');
    const said = (code: string) => blockersOf(r).filter((b) => b.code === code).map((b) => b.message).join('\n');
    expect(said('path_symlinked')).toContain(`${path.join(s.dst, 'work/ada')} leads to ${path.join(s.base, 'outside/work/ada')} on this machine`);
    expect(said('path_unsupported')).toContain(`${path.join(s.dst, '.claude/projects')}/`);
    expect(fs.readdirSync(path.join(s.base, 'outside/projects'))).toEqual([]);
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
  });

  it('blocks a root this handover did not claim, and one that no longer holds what the transfer verified', async () => {
    const s = await scene();
    const [ada, bo] = ['work/ada', 'work/bo'].map((p) => s.manifest.roots.find((r) => r.path === path.join(s.dst, p))!);
    fs.rmSync(resolvePaths(s.home).replicaRecord(fleetId, ada.path));
    fs.appendFileSync(path.join(s.dst, 'work/bo/index.ts'), '// edited here\n');
    const r = await refusal(daemon(s).handover.prepare(params(s)));
    expect(r.code).toBe('blocked');
    expect(blockersOf(r)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'destination_occupied', entity: { kind: 'root', id: ada.id }, message: expect.stringContaining('not claimed') }),
      expect.objectContaining({ code: 'destination_diverged', entity: { kind: 'root', id: bo.id }, message: expect.stringContaining('index.ts') }),
    ]));
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
  });

  it('refuses a transfer that verified nothing for a root', async () => {
    const s = await scene();
    const r = await refusal(daemon(s).handover.prepare(params(s, { landed: s.landed.slice(1) })));
    expect(r.code).toBe('not_ready');
    expect(r.message).toContain(s.landed[0].id);
  });

  it('places sessions only under the agent homes this machine reports', async () => {
    const s = await scene();
    s.probes[0] = { ...s.probes[0], home: path.join(s.dst, '.claude-other') };
    const r = await refusal(daemon(s).handover.prepare(params(s)));
    expect(blockersOf(r)).toContainEqual(expect.objectContaining({ code: 'agent_cli_missing', entity: { kind: 'character', id: 'c_bo' } }));
    // nothing beside the config that folder held
    expect(fs.readdirSync(path.join(s.dst, '.claude'))).toEqual(['.claude.json']);
  });

  // a graph whose Git directory lies at `elsewhere`, a link this machine can point into a carried root or leave out
  const strayGraph = (m: TransferManifestV1): void => {
    m.git = [{ id: 'g_stray', commonDir: path.join(m.home, 'elsewhere'), worktrees: [], unused: [], stash: [] }];
  };

  it('compares what landed again on a retry after it stopped short of the Git import, so an edit made in between is never sealed', async () => {
    const s = await scene({ tamper: strayGraph });
    const d = daemon(s);
    // the stray Git directory lies outside every carried root: prepare stops before the import
    expect(blockersOf(await refusal(d.handover.prepare(params(s))))).toContainEqual(expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining('elsewhere') }));
    fs.symlinkSync(path.join(s.dst, 'work/ada'), path.join(s.dst, 'elsewhere'));
    fs.appendFileSync(path.join(s.dst, 'work/bo/index.ts'), '// edited here between the attempts\n');
    const again = await refusal(d.handover.prepare(params(s)));
    expect(blockersOf(again)).toContainEqual(expect.objectContaining({ code: 'destination_diverged', message: expect.stringContaining('index.ts') }));
    expect(fs.existsSync(s.paths.replicaSeal(TX))).toBe(false);
  });

  it('blocks a session a character runs that the manifest does not carry, before it writes anything', async () => {
    const s = await scene({ tamper: (m) => { m.sessions = m.sessions.filter((x) => x.characterId !== 'c_bo'); } });
    const d = daemon(s);
    const r = await refusal(d.handover.prepare(params(s)));
    expect(r.code).toBe('blocked');
    expect(blockersOf(r)).toContainEqual(expect.objectContaining({ code: 'transcript_missing', message: expect.stringContaining('c_bo') }));
    expect(fs.existsSync(s.paths.replicaSeal(TX))).toBe(false);
    expect(fs.existsSync(s.paths.journal)).toBe(false);
  });

  it('records the roots for an abort to seal even when the Git import throws part way', async () => {
    const s = await scene({ tamper: strayGraph, before: ({ dst }) => { fs.symlinkSync(path.join(dst, 'work/ada'), path.join(dst, 'elsewhere')); } });
    const d = daemon(s, { git: async () => { throw new TypeError('git crashed'); } });
    await expect(d.handover.prepare(params(s))).rejects.toThrow('git crashed');
    expect(fs.existsSync(s.paths.replicaSeal(TX))).toBe(true);
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    expect(await d.handover.abort({ transactionId: TX, generation: 5 })).toEqual({});
    for (const r of replicaRoots(s.manifest)) {
      expect(JSON.parse(fs.readFileSync(s.paths.replicaRecord(fleetId, r.path), 'utf8')), r.path).toMatchObject({ state: 'sealed', generation: 4 });
    }
  });

  it('takes its own roots again after a prepare that stopped past the Git import, holding what that import wrote there', async () => {
    const s = await scene({ tamper: strayGraph, before: ({ dst }) => { fs.symlinkSync(path.join(dst, 'work/ada'), path.join(dst, 'elsewhere')); } });
    // the import writes the graph's config, and then git cannot read the graph
    const git: GitRunner = async () => {
      fs.writeFileSync(path.join(s.dst, 'elsewhere/config'), '[core]\n\tignorecase = false\n');
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    };
    const d = daemon(s, { git });
    expect(blockersOf(await refusal(d.handover.prepare(params(s)))).map((b) => b.code)).toContain('worktree_unresolved');

    // tried again, the transfer copies each root afresh, and claims it first
    const r = await d.handover.claim({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest });
    for (const root of replicaRoots(s.manifest)) {
      expect(r.roots.find((x) => x.id === root.id)!.check, root.path).toEqual({ ok: true, path: root.path, kind: 'resume' });
    }
    // and again, should that copy stop short
    expect((await d.handover.claim({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest })).roots.every((x) => x.check.ok)).toBe(true);
  });

  it('takes as its own only what a prepare that proved what landed recorded, never an edit made here since', async () => {
    const s = await scene({ tamper: strayGraph, before: ({ dst }) => { fs.symlinkSync(path.join(dst, 'work/ada'), path.join(dst, 'elsewhere')); } });
    const git: GitRunner = async () => {
      fs.writeFileSync(path.join(s.dst, 'elsewhere/config'), '[core]\n\tignorecase = false\n');
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    };
    const d = daemon(s, { git });
    expect(blockersOf(await refusal(d.handover.prepare(params(s)))).map((b) => b.code)).toContain('worktree_unresolved');
    fs.appendFileSync(path.join(s.dst, 'work/bo/index.ts'), '// edited here\n');
    fs.writeFileSync(path.join(s.dst, 'work/bo/mine.txt'), 'written here\n');
    // asked again with what landed, as a prepare whose answer was lost is, it does not prove that again
    expect(blockersOf(await refusal(d.handover.prepare(params(s)))).map((b) => b.code)).toContain('worktree_unresolved');

    const r = await d.handover.claim({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest });
    const bo = replicaRoots(s.manifest).find((x) => x.path === path.join(s.dst, 'work/bo'))!;
    expect(r.roots.find((x) => x.id === bo.id)!.check).toMatchObject({ ok: false, blocker: { code: 'destination_diverged', message: expect.stringContaining('mine.txt') } });
  });

  it('seals no edit made here while it was down after dying in the Git import, when the prepare is asked again', async () => {
    const s = await scene({ tamper: strayGraph, before: ({ dst }) => { fs.symlinkSync(path.join(dst, 'work/ada'), path.join(dst, 'elsewhere')); } });
    const git: GitRunner = async () => {
      fs.writeFileSync(path.join(s.dst, 'elsewhere/config'), '[core]\n\tignorecase = false\n');
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    };
    const d = daemon(s, { git });
    expect(blockersOf(await refusal(d.handover.prepare(params(s)))).map((b) => b.code)).toContain('worktree_unresolved');
    expect(journalOf(s.paths).landedDigest).toBeDefined();
    // the daemon died inside the import, before it recorded the roots: the seal record is still the claim's
    const claimed = SealRecord.parse(JSON.parse(fs.readFileSync(s.paths.replicaSeal(TX), 'utf8')));
    fs.writeFileSync(s.paths.replicaSeal(TX), JSON.stringify({ ...claimed, roots: claimed.roots.map(({ files: _f, ...r }) => r) }));
    fs.appendFileSync(path.join(s.dst, 'work/bo/index.ts'), '// edited here\n');
    fs.writeFileSync(path.join(s.dst, 'work/bo/mine.txt'), 'written here\n');
    const again = daemon(s, { git });
    expect(blockersOf(await refusal(again.handover.prepare(params(s)))).map((b) => b.code)).toContain('worktree_unresolved');

    // tried again, the transfer claims each root first: ada holds only what landed and what the import wrote there
    const bo = replicaRoots(s.manifest).find((x) => x.path === path.join(s.dst, 'work/bo'))!;
    const r = await again.handover.claim({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest });
    for (const root of replicaRoots(s.manifest).filter((x) => x.id !== bo.id)) expect(r.roots.find((x) => x.id === root.id)!.check, root.path).toMatchObject({ ok: true });
    const refused = { ok: false, blocker: { code: 'destination_diverged', message: expect.stringMatching(/mine\.txt.*index\.ts/) } };
    expect(r.roots.find((x) => x.id === bo.id)!.check).toMatchObject(refused);
    // let go, it leaves bo for the next handover to refuse
    again.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    expect(await again.handover.abort({ transactionId: TX, generation: 5 })).toEqual({});
    const incoming = s.manifest.roots.find((x) => x.id === bo.id)!.files;
    expect(await new ReplicaStore({ fleetId, paths: s.paths }).inspect(bo, { transactionId: 'tx-2', excludes: s.manifest.excludes, incoming })).toMatchObject(refused);
  });

  it('seals what landed and what the Git import wrote, and not a file written into a root while the import ran', async () => {
    const s = await scene({ tamper: strayGraph, before: ({ dst }) => { fs.symlinkSync(path.join(dst, 'work/ada'), path.join(dst, 'elsewhere')); } });
    const git: GitRunner = async () => {
      fs.writeFileSync(path.join(s.dst, 'elsewhere/config'), '[core]\n\tignorecase = false\n');
      fs.writeFileSync(path.join(s.dst, 'work/bo/mine.txt'), 'written meanwhile\n');
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    };
    const d = daemon(s, { git });
    expect(blockersOf(await refusal(d.handover.prepare(params(s)))).map((b) => b.code)).toContain('worktree_unresolved');

    const seal = SealRecord.parse(JSON.parse(fs.readFileSync(s.paths.replicaSeal(TX), 'utf8')));
    const sealed = (dir: string) => seal.roots.find((x) => x.path === path.join(s.dst, dir))!.files!.map((f) => f.path).sort();
    const landed = (dir: string) => s.landed.find((x) => x.id === replicaRoots(s.manifest).find((r) => r.path === path.join(s.dst, dir))!.id)!.files.map((f) => f.path);
    expect(sealed('work/bo')).toEqual(landed('work/bo').sort());
    expect(sealed('work/ada')).toEqual([...landed('work/ada'), 'config'].sort());
    const r = await d.handover.claim({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest });
    const bo = replicaRoots(s.manifest).find((x) => x.path === path.join(s.dst, 'work/bo'))!;
    expect(r.roots.find((x) => x.id === bo.id)!.check).toMatchObject({ ok: false, blocker: { code: 'destination_diverged', message: expect.stringContaining('mine.txt') } });
  });

  it('drops the session stage of a handover it never prepared once the gateway lets it go, and nothing else', async () => {
    const s = await scene();
    const d = daemon(s);
    const stage = path.dirname(s.paths.sessionStage(TX, 0));
    const other = path.dirname(s.paths.sessionStage('tx-0', 0));
    fs.mkdirSync(other, { recursive: true });
    const roots = replicaRoots(s.manifest);
    const before = roots.map((r) => [tree(r.path), fs.readFileSync(s.paths.replicaRecord(fleetId, r.path), 'utf8')]);
    expect(fs.existsSync(stage)).toBe(true);

    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('not_owner');
    expect(fs.existsSync(stage)).toBe(true);
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('not_owner');
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(roots.map((r) => [tree(r.path), fs.readFileSync(s.paths.replicaRecord(fleetId, r.path), 'utf8')])).toEqual(before);
  });

  it('keeps the session stage of a handover it never prepared while the gateway cannot say it let go, for another abort', async () => {
    const s = await scene();
    const d = daemon(s);
    const stage = path.dirname(s.paths.sessionStage(TX, 0));
    d.gateway.down = true;
    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('authority_unreachable');
    expect(fs.existsSync(stage)).toBe(true);
    d.gateway.down = false;
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('not_owner');
    expect(fs.existsSync(stage)).toBe(false);
  });

  it('keeps its journal and what it would seal when a root cannot be sealed as it lets go, so an abort again seals it', async () => {
    const s = await scene();
    const d = daemon(s);
    await d.handover.prepare(params(s));
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    const records = path.dirname(s.paths.replicaRecord(fleetId, s.dst));
    fs.chmodSync(records, 0o500);
    try {
      const r = await refusal(d.handover.abort({ transactionId: TX, generation: 5 }));
      expect(r.code).toBe('not_ready');
      expect(fs.existsSync(s.paths.replicaSeal(TX))).toBe(true);
      expect(d.handover.journalState()).toMatchObject({ kind: 'open' });
      expect(d.ownership.isFrozen()).toBe(true);
    } finally {
      fs.chmodSync(records, 0o700);
    }
    expect(await d.handover.abort({ transactionId: TX, generation: 5 })).toEqual({});
    for (const r of replicaRoots(s.manifest)) {
      expect(JSON.parse(fs.readFileSync(s.paths.replicaRecord(fleetId, r.path), 'utf8')), r.path).toMatchObject({ state: 'sealed', generation: 4 });
    }
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
  });

  it('lets go a handover whose prepare journaled it while an abort waited behind that prepare', async () => {
    const s = await scene();
    let answer!: () => void;
    const asked = new Promise<void>((r) => { answer = r; });
    // the prepare waits on this machine's agents before it journals anything
    const d = daemon(s, { agents: async () => { await asked; return s.probes; } });
    const preparing = d.handover.prepare(params(s));
    await settle();
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    const aborting = d.handover.abort({ transactionId: TX, generation: 5 });
    await settle();
    answer();
    await preparing;
    expect(await aborting).toEqual({});
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
    expect(d.ownership.isFrozen()).toBe(false);
  });

  it('discards what it prepared once the gateway no longer holds the handover, and not before', async () => {
    const s = await scene();
    const d = daemon(s);
    await d.handover.prepare(params(s));
    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('not_ready');
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(true);
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    expect(await d.handover.abort({ transactionId: TX, generation: 5 })).toEqual({});
    for (const f of [s.paths.preparedState(TX), s.paths.replicaSeal(TX), s.paths.journal]) expect(fs.existsSync(f)).toBe(false);
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
    expect(d.ownership.isFrozen()).toBe(false);
  });
});

const realGit = hasGit ? describe : describe.skip;

realGit(`destination prepare of a real repository graph${hasGit ? '' : ' (skipped: git is not on PATH)'}`, { timeout: 180_000 }, () => {
  /** The fixture handed from the Mac, whose tree is parked at `mac`, to this machine, which has none of it yet. */
  async function gitScene(l: Layout) {
    const home = makeHome();
    const paths = resolvePaths(home);
    fs.writeFileSync(paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, gatewayMachineId: trift })));
    fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 4, ownerMachineId: mac }));
    loadConfig(paths);
    const fleet = FleetConfig.parse({ id: fleetId, gatewayMachineId: trift });
    const state = gitCrew(l);
    const discovery = await discoverGit(state, { excludes: DEFAULT_EXCLUDES });
    expect(discovery.blockers).toEqual([]);
    const inventory = buildInventory(state, { fleet }, {
      source: { machineId: mac, home: l.home, fleetHome: path.join(l.base, 'mac-svall') }, destination: { machineId: trift, home: l.home, fleetHome: home },
    }, discovery);
    const built = await buildManifest(inventory, { transactionId: TX, generation: 4 });
    expect(built.blockers).toEqual([]);
    const macTree = park(l, 'mac');
    const landed = await transfer(paths, built.manifest, (p) => parkedAt(l, macTree, p));
    const store = Store.load(paths.state, () => {});
    return { home, paths, store, manifest: built.manifest, digest: built.digest, landed, probes: [] as AgentProbe[] };
  }

  it('imports every graph, and records for Complete each root as the import left it', async () => {
    const l = seedHere(made);
    const s = await gitScene(l);
    const d = daemon(s);
    const r = await d.handover.prepare({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest, landed: s.landed });
    const dd = l.source;
    expect(git(l.base, dd.main, 'worktree', 'list', '--porcelain')).toContain(`worktree ${dd.nested}`);
    expect(git(l.base, dd.main, 'worktree', 'list', '--porcelain')).not.toContain(dd.unused);
    const prepared = FleetState.parse(JSON.parse(fs.readFileSync(s.paths.preparedState(TX), 'utf8')));
    expect(prepared.characters.nested.cwd).toBe(dd.nested);

    // the seal holds the gitfile the source sent
    const seal = SealRecord.parse(JSON.parse(fs.readFileSync(s.paths.replicaSeal(TX), 'utf8')));
    const nested = s.manifest.roots.find((x) => x.path === dd.main)!;
    const gitfile = (files: { path: string; sha256?: string }[]) => files.find((f) => f.path === '.claude/worktrees/nested/.git')?.sha256;
    const sealed = seal.roots.find((x) => x.id === nested.id)!;
    expect(gitfile(sealed.files!)).toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(dd.nested, '.git'))).digest('hex'));
    expect(gitfile(sealed.files!)).toBe(gitfile(nested.files));

    // a prepare cut short after the import, retried, trusts the verification it already made
    const journal = journalOf(s.paths);
    const { preparedDigest: _p, fleet: _f, ...cut } = journal;
    fs.writeFileSync(s.paths.journal, JSON.stringify({ ...cut, phase: 'verify' }));
    fs.rmSync(s.paths.preparedState(TX));
    const again = daemon(s);
    expect(await again.handover.prepare({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest, landed: s.landed })).toEqual(r);
  });

  /**
   * The fleet went from the Mac to trift once, and the Mac sealed its roots as the copy it left behind. Now it comes
   * back: the manifest is trift's, whose tree is then parked at `from`, and this daemon is the Mac's, with its tree back.
   */
  async function comingBack(l: Layout, meanwhile?: () => void) {
    const there = await gitScene(l);
    await daemon(there).handover.prepare({ transactionId: TX, generation: 5, manifest: { ...there.manifest, transactionId: TX }, manifestDigest: there.digest, landed: there.landed });
    meanwhile?.();
    const home = makeHome();
    const paths = resolvePaths(home);
    fs.writeFileSync(paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, gatewayMachineId: trift })));
    fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 4, ownerMachineId: mac }));
    loadConfig(paths);
    const state = gitCrew(l);
    const discovery = await discoverGit(state, { excludes: DEFAULT_EXCLUDES });
    expect(discovery.blockers).toEqual([]);
    const inventory = buildInventory(state, { fleet: FleetConfig.parse({ id: fleetId, gatewayMachineId: trift }) }, {
      source: { machineId: mac, home: l.home, fleetHome: path.join(l.base, 'far-svall') },
      destination: { machineId: trift, home: l.home, fleetHome: home },
    }, discovery);
    const built = await buildManifest(inventory, { transactionId: TX, generation: 4 });
    expect(built.blockers).toEqual([]);
    const from = park(l, 'trift');
    unpark(l, 'mac');
    const sealed = new ReplicaStore({ fleetId, paths });
    for (const r of replicaRoots(there.manifest)) {
      sealed.seal(r, { transactionId: 'tx-0', generation: 4, manifestDigest: there.digest, files: there.manifest.roots.find((x) => x.id === r.id)!.files }, 'source');
    }
    return { home, paths, store: Store.load(paths.state, () => {}), manifest: built.manifest, digest: built.digest, probes: [] as AgentProbe[], from };
  }

  it('keeps a worktree no character uses registered on the machine the fleet comes back to, and git reads it as it was', async () => {
    const l = seedHere(made);
    const s = l.source;
    const before = { status: git(l.base, s.unused, 'status', '--porcelain=v2', '--branch'), head: git(l.base, s.unused, 'rev-parse', 'HEAD') };
    const b = await comingBack(l);
    const d = daemon(b);
    const main = replicaRoots(b.manifest).find((r) => r.path === s.main)!;
    const pre = await d.handover.inspect({ roots: replicaRoots(b.manifest), excludes: b.manifest.excludes, folders: [l.home], git: graphsHere(b.manifest) });
    expect(pre.unproven ?? []).toEqual([]);
    expect(pre.roots.find((x) => x.id === main.id)!.check).toMatchObject({ ok: true, kind: 'replica' });

    const claimed = await d.handover.claim({ transactionId: TX, generation: 5, manifest: { ...b.manifest, transactionId: TX }, manifestDigest: b.digest });
    expect(claimed.roots.find((x) => x.id === main.id)).toMatchObject({ check: { ok: true }, keep: ['.git/worktrees/unused'] });
    // what rsync does with --delete and that root's claim
    const landed: LandedRoot[] = [];
    for (const r of replicaRoots(b.manifest)) {
      const keep = claimed.roots.find((x) => x.id === r.id)!.keep ?? [];
      const aside = keep.map((k) => { const to = fs.mkdtempSync('/tmp/svall-kept-'); made.push(to); fs.renameSync(path.join(r.path, k), path.join(to, 'k')); return { k, to }; });
      fs.rmSync(r.path, { recursive: true, force: true });
      fs.cpSync(parkedAt(l, b.from, r.path), r.path, { recursive: true, verbatimSymlinks: true });
      for (const a of aside) { fs.rmSync(path.join(r.path, a.k), { recursive: true, force: true }); fs.renameSync(path.join(a.to, 'k'), path.join(r.path, a.k)); }
      const scanned = (await scanPath(r.path, rootMatcher(r.kind, b.manifest.excludes)))!.files;
      landed.push({ id: r.id, files: scanned.filter((f) => !keep.some((k) => f.path === k || f.path.startsWith(`${k}/`))) });
    }
    await d.handover.prepare({ transactionId: TX, generation: 5, manifest: { ...b.manifest, transactionId: TX }, manifestDigest: b.digest, landed });
    expect({ status: git(l.base, s.unused, 'status', '--porcelain=v2', '--branch'), head: git(l.base, s.unused, 'rev-parse', 'HEAD') }).toEqual(before);
    expect(git(l.base, s.main, 'worktree', 'list', '--porcelain')).toContain(`worktree ${s.unused}\n`);
  });

  it('names, at preflight and at claim, a kept commit it cannot prove comes back, for the source to judge, and claims the root all the same', async () => {
    const l = seedHere(made);
    const s = l.source;
    fs.writeFileSync(path.join(s.unused, 'only-here.txt'), 'only here\n');
    git(l.base, s.unused, 'add', 'only-here.txt');
    git(l.base, s.unused, 'commit', '-qm', 'only on unused-branch');
    const commit = git(l.base, s.unused, 'rev-parse', 'HEAD');
    // the branch is dropped where the fleet went, and nothing this machine knows of reaches the commit
    const b = await comingBack(l, () => { git(l.base, s.main, 'branch', '-D', 'unused-branch'); });
    const d = daemon(b);
    const main = replicaRoots(b.manifest).find((r) => r.path === s.main)!;
    const [graph] = graphsHere(b.manifest);
    const named = [{ graph: graph.id, path: s.unused, commit }];
    const pre = await d.handover.inspect({ roots: replicaRoots(b.manifest), excludes: b.manifest.excludes, folders: [l.home], git: graphsHere(b.manifest) });
    expect(pre.unproven).toEqual(named);
    expect(pre.roots.find((x) => x.id === main.id)!.check).toMatchObject({ ok: true });
    const claimed = await d.handover.claim({ transactionId: TX, generation: 5, manifest: { ...b.manifest, transactionId: TX }, manifestDigest: b.digest });
    expect(claimed.unproven).toEqual(named);
    expect(claimed.roots.find((x) => x.id === main.id)).toMatchObject({ check: { ok: true }, keep: ['.git/worktrees/unused'] });
  });

  it('refuses a claim whose manifest names a checkout head or a stash entry that is not an object name, before git reads it', async () => {
    const l = seedHere(made);
    const b = await comingBack(l);
    const asked: string[][] = [];
    const d = daemon(b, { git: (args, cwd) => { asked.push([...args]); return runGit(args, cwd); } });
    const file = path.join(l.base, 'written-by-git');
    const [g, ...rest] = b.manifest.git!;
    // no tip names the kept worktree's commit, so only the manifest's heads and stash could be asked about it
    const bare = { ...g, tips: [], worktrees: g.worktrees.map((w) => ({ ...w, head: null })) };
    for (const hostile of [{ ...bare, main: { ...g.main!, head: `--output=${file}` } }, { ...bare, stash: [`--output=${file}`] }]) {
      const manifest = { ...b.manifest, transactionId: TX, git: [hostile, ...rest] };
      await expect(d.handover.claim({ transactionId: TX, generation: 5, manifest, manifestDigest: canonicalDigest(manifest) })).rejects.toThrow();
      expect(fs.existsSync(file)).toBe(false);
      expect(asked.flat().filter((a) => a.startsWith('--output'))).toEqual([]);
    }
  });

  it('leaves what an aborted handover imported claimable by the next one', async () => {
    const l = seedHere(made);
    const s = await gitScene(l);
    const d = daemon(s);
    await d.handover.prepare({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest, landed: s.landed });
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };
    await d.handover.abort({ transactionId: TX, generation: 5 });
    const replicas = new ReplicaStore({ fleetId, paths: s.paths });
    for (const r of replicaRoots(s.manifest)) {
      const check = await replicas.inspect(r, { transactionId: 'tx-2', excludes: s.manifest.excludes });
      expect(check, r.path).toMatchObject({ ok: true, kind: 'replica' });
    }
  });

  it('blocks a graph that no longer reads as the source left it', async () => {
    const l = seedHere(made);
    const s = await gitScene(l);
    // a change made here after the transfer verified it, and verified again so only Git can tell
    git(l.base, l.source.main, 'stash', 'drop', '-q');
    const landed = await Promise.all(s.landed.map(async (x) => {
      const root = s.manifest.roots.find((r) => r.id === x.id)!;
      return { id: x.id, files: (await scanPath(root.path, rootMatcher(root.kind, s.manifest.excludes)))!.files };
    }));
    const r = await refusal(daemon(s).handover.prepare({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest, landed }));
    expect(blockersOf(r)).toContainEqual(expect.objectContaining({ code: 'git_mismatch', message: expect.stringContaining(`${path.join(l.source.main, '.git')}: the stash is not the one the source left`) }));
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
  });
});

describe('destination activate', () => {
  async function prepared(o: { concurrency?: number; failWrite?: (j: HandoverJournal) => boolean } = {}) {
    const s = await scene();
    const d = daemon(s, o);
    const { preparedDigest } = await d.handover.prepare(params(s));
    return { s, d, preparedDigest };
  }

  it('waits for the gateway to commit this handover at the next generation before it touches anything', async () => {
    const { s, d, preparedDigest } = await prepared();
    const before = fs.readFileSync(s.paths.state);
    const activate = () => refusal(d.handover.activate({ transactionId: TX, generation: 5 }));
    const committed = (over: Partial<OwnerRecord>): OwnerRecord => ({ ...d.gateway.record, ...over });

    expect((await activate()).code).toBe('not_ready');
    d.gateway.ready(preparedDigest);
    expect((await activate()).code).toBe('not_ready');
    d.gateway.commit(preparedDigest);
    const ok = d.gateway.record;
    for (const [record, code] of [
      [committed({ transaction: { ...ok.transaction!, preparedDigest: 'd'.repeat(64) } }), 'transaction_mismatch'],
      [committed({ ownerMachineId: elsewhere }), 'not_owner'],
      [committed({ generation: 6 }), 'generation_mismatch'],
      [committed({ transaction: { ...ok.transaction!, id: 'tx-2' } }), 'transaction_mismatch'],
    ] as const) {
      d.gateway.record = record;
      expect((await activate()).code, JSON.stringify(record)).toBe(code);
    }
    d.gateway.record = ok;
    d.gateway.down = true;
    expect((await activate()).code).toBe('authority_unreachable');

    expect(fs.readFileSync(s.paths.state)).toEqual(before);
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(true);
    expect(journalOf(s.paths).phase).toBe('prepare');
    expect([...d.crew.log, ...d.crew.lines]).toEqual([]);
    expect(d.ownership.writable()).toBe(false);
  });

  it('promotes the prepared state and fleet.json, then starts every terminal a few at a time', async () => {
    const { s, d, preparedDigest } = await prepared({ concurrency: 2 });
    const expected = FleetState.parse(JSON.parse(fs.readFileSync(s.paths.preparedState(TX), 'utf8')));
    const seen: string[] = [];
    s.store.subscribe(() => seen.push(d.crew.log.length ? 'late' : 'store'));
    d.gateway.commit(preparedDigest);

    const r = await d.handover.activate({ transactionId: TX, generation: 5 });
    expect(r.characters.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'c_ada', ok: true }, { id: 'c_bo', ok: true }, { id: 'c_cy', ok: true }, { id: 'c_dee', ok: true },
    ]);
    // the store took the prepared state whole before any terminal opened
    expect(seen[0]).toBe('store');
    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
    expect(s.store.state.characters.c_bo.cwd).toBe(expected.characters.c_bo.cwd);
    expect(Store.readSnapshot(s.paths.state).characters.c_ada.cwd).toBe(path.join(s.dst, 'work/ada'));
    expect(FleetConfig.parse(JSON.parse(fs.readFileSync(s.paths.fleetConfig, 'utf8'))).home.cwd).toBe('~/mc');
    expect(d.config.home.cwd).toBe('~/mc');
    // a node.json that names no port leaves the daemon on the one it took
    expect(d.config.port).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(s.paths.owner, 'utf8'))).toMatchObject({ generation: 5, ownerMachineId: trift });
    expect(d.ownership.writable()).toBe(true);

    expect(d.crew.log.slice(0, 2)).toEqual(['activate', 'reconcile']);
    expect(d.crew.log.slice(2).sort()).toEqual(['open c_ada', 'open c_ada-2', 'open c_bo', 'open c_cy', 'open c_dee']);
    expect(d.crew.peak).toBe(2);
    // plain shells say what happened to them; a resumed agent does not need to
    const panes = (id: string, term?: 2) => { const c = s.store.state.characters[id]; return (term ? c.second : c)!.tmux!.paneId; };
    const notices = d.crew.lines.map((l) => l.split(' ')[0]).sort();
    expect(notices).toEqual([panes('c_ada'), panes('c_ada', 2), panes('c_cy')].sort());
    expect(d.crew.lines[0]).toMatch(/restarted .* handover/);
    expect(journalOf(s.paths)).toMatchObject({ phase: 'activate' });
    expect(journalOf(s.paths).activation!.every((a) => a.ok)).toBe(true);
    expect(d.events).toContainEqual({ event: 'handover.entity', data: { transactionId: TX, kind: 'character', id: 'c_bo', phase: 'activate' } });
  });

  it('names a resume that never comes up as its character error, keeps the fleet, and clears it when the session starts after all', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.exiting.add('c_bo');
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    let done = false;
    void run.finally(() => { done = true; });
    for (let i = 0; i < 10 && !done; i++) await d.clock.advance(60_000);
    const r = await run;
    const byId = Object.fromEntries(r.characters.map((c) => [c.id, c]));
    expect(byId.c_bo).toMatchObject({ ok: false, error: expect.stringMatching(/claude did not come up within 60 s: its pane stayed at the shell prompt/) });
    // this machine's Claude trusts bo's folder, so no trust prompt is named
    expect(byId.c_bo.error).not.toMatch(/trust/i);
    expect(byId.c_ada.ok).toBe(true);
    expect(d.ownership.writable()).toBe(true);
    expect(JSON.parse(fs.readFileSync(s.paths.owner, 'utf8'))).toMatchObject({ generation: 5, ownerMachineId: trift });
    // it is dormant again with the session it carries, its window closed, for the user to revive, and says why on its record
    expect(d.crew.log).toContain('kill c_bo');
    expect(s.store.state.characters.c_bo).toMatchObject({ agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` }, resumeError: byId.c_bo.error });
    expect(s.store.state.characters.c_bo.tmux).toBeUndefined();
    expect(s.store.state.characters.c_ada.resumeError).toBeUndefined();

    // another session starting there is not the one that was carried
    d.crew.started('c_bo', undefined, '99999999-9999-4999-8999-999999999999');
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_bo')!.error).toBe(byId.c_bo.error);
    expect(s.store.state.characters.c_bo.resumeError).toBe(byId.c_bo.error);
    // the user revives bo, and the carried session starts
    d.crew.started('c_bo', undefined, SID);
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_bo')).toEqual({ characterId: 'c_bo', ok: true, sessionId: SID });
    expect(s.store.state.characters.c_bo.resumeError).toBeUndefined();
  });

  it('leaves a terminal whose wake fails dormant with the launch flags its carried resume had', async () => {
    const bo = `claude --dangerously-skip-permissions --effort 'high' --resume ${SID}`;
    const dee = `codex resume -c tui.resume_cwd=session -m 'gpt-6' ${CODEX_ID}`;
    const s = await scene({ tamper: (m) => { m.snapshot.characters.c_bo.revive = { command: bo }; m.snapshot.characters.c_dee.revive = { command: dee }; } });
    const d = daemon(s);
    d.gateway.commit((await d.handover.prepare(params(s))).preparedDigest);
    // bo's resume never comes up, and dee's window never opens
    d.crew.exiting.add('c_bo');
    d.crew.failing.add('c_dee');
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    let done = false;
    void run.finally(() => { done = true; });
    for (let i = 0; i < 10 && !done; i++) await d.clock.advance(60_000);
    const r = await run;
    expect(r.characters.filter((c) => !c.ok).map((c) => c.id).sort()).toEqual(['c_bo', 'c_dee']);
    expect(s.store.state.characters.c_bo).toMatchObject({ revive: { command: bo }, agent: { sessionId: SID } });
    expect(s.store.state.characters.c_dee).toMatchObject({ revive: { command: dee }, agent: { sessionId: CODEX_ID } });
  });

  it('lays a terminal whose wake fails mid-turn in another session dormant without marking it cut off by a crash', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.exiting.add('c_bo');
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    await waitFor(() => !!d.crew.window('c_bo'));
    s.store.update((st) => { Object.assign(st.characters.c_bo.agent!, { sessionId: '99999999-9999-4999-8999-999999999999', status: 'working' }); });
    let done = false;
    void run.finally(() => { done = true; });
    for (let i = 0; i < 10 && !done; i++) await d.clock.advance(60_000);
    expect((await run).characters.find((c) => c.id === 'c_bo')?.ok).toBe(false);
    expect(s.store.state.characters.c_bo.revive).toEqual({ command: 'claude --resume 99999999-9999-4999-8999-999999999999' });
  });

  /** Activates with the clock moving half a second at a time for twenty seconds, a minute at a time after that, and says how far it had moved when the activation answered. */
  async function activateBy(d: Awaited<ReturnType<typeof prepared>>['d']) {
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    let done = false;
    void run.finally(() => { done = true; });
    let at = 0;
    await settle();
    while (!done && at < 20_000) { await d.clock.advance(500); at += 500; }
    for (let i = 0; i < 5 && !done; i++) { await d.clock.advance(60_000); at += 60_000; }
    return { r: await run, at };
  }

  it("counts a resumed Codex up once its pane has run Codex through the settle, with no SessionStart, and keeps its window", async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_dee');
    // this machine's Codex trusts dee's folder, so no prompt waits there
    fs.writeFileSync(path.join(s.dst, '.codex/config.toml'), `[projects."${path.join(s.dst, 'work/demo')}"]\ntrust_level = "trusted"\n`);

    const { r, at } = await activateBy(d);

    // three seconds of Codex in its pane, and not the minute a SessionStart gets
    expect(at).toBeGreaterThanOrEqual(3000);
    expect(at).toBeLessThanOrEqual(5000);
    expect(r.characters.find((c) => c.id === 'c_dee')).toEqual({ id: 'c_dee', ok: true });
    expect(d.crew.log).not.toContain('kill c_dee');
    expect(d.crew.window('c_dee')?.command).toBe('codex');
    expect(s.store.state.characters.c_dee.tmux?.paneId).toBe(d.crew.window('c_dee')!.paneId);
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_dee')).toMatchObject({ ok: true, sessionId: CODEX_ID });
  });

  it('counts a resumed Codex up at its trust prompt where this machine does not trust its folder, keeps its window, and says the prompt waits there', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_dee');

    const { r, at } = await activateBy(d);

    expect(at).toBeLessThanOrEqual(5000);
    const dee = r.characters.find((c) => c.id === 'c_dee')!;
    expect(dee).toMatchObject({ ok: true, notice: expect.stringMatching(/"Trust this folder\?" prompt in dee's terminal/) });
    expect(dee.error).toBeUndefined();
    expect(r.characters.find((c) => c.id === 'c_bo')).toEqual({ id: 'c_bo', ok: true });
    expect(d.crew.log).not.toContain('kill c_dee');
    expect(s.store.state.characters.c_dee.tmux).toBeDefined();
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_dee')).toMatchObject({ ok: true, notice: dee.notice });
  });

  it('stops watching a Codex counted up at its trust prompt once its folder is trusted, since Codex starts its session only with its first turn', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_dee');

    const { r } = await activateBy(d);
    expect(r.characters.find((c) => c.id === 'c_dee')).toMatchObject({ ok: true, notice: expect.stringMatching(/"Trust this folder\?" prompt/) });
    await d.clock.advance(10_000);
    expect(d.crew.carried('c_dee')).toBe(true);

    // answered "Yes", which Codex writes into its config
    fs.writeFileSync(path.join(s.dst, '.codex/config.toml'), `[projects."${path.join(s.dst, 'work/demo')}"]\ntrust_level = "trusted"\n`);
    // at its next look, which comes later each time
    await d.clock.advance(4000);
    expect(d.crew.carried('c_dee')).toBe(false);
    let looks = 0;
    const list = d.crew.tmux.listWindows;
    d.crew.tmux.listWindows = (signal) => { looks++; return list(signal); };

    // quit before any prompt, it is the fleet's to judge as any terminal, and not told to trust its folder again
    d.crew.window('c_dee')!.command = 'bash';
    await d.clock.advance(10_000);
    expect(looks).toBe(0);
    expect(d.crew.log).not.toContain('kill c_dee');
    expect(s.store.state.characters.c_dee.resumeError).toBeUndefined();
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_dee')).toMatchObject({ ok: true });
  });

  it("counts a resumed Claude up at its trust prompt where this machine's Claude does not trust its folder, keeps its window without the SessionStart wait, and says which answer goes on", async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    fs.rmSync(path.join(s.dst, '.claude/.claude.json'));
    // Claude sends no SessionStart until its trust prompt is answered
    d.crew.silent.add('c_bo');

    const { r, at } = await activateBy(d);

    expect(at).toBeLessThanOrEqual(5000);
    const bo = r.characters.find((c) => c.id === 'c_bo')!;
    expect(bo).toMatchObject({ ok: true, notice: 'claude waits at its "Trust this folder?" prompt in bo\'s terminal; choose "Yes, I trust this folder" there' });
    expect(bo.error).toBeUndefined();
    expect(d.crew.log).not.toContain('kill c_bo');
    expect(s.store.state.characters.c_bo.tmux?.paneId).toBe(d.crew.window('c_bo')!.paneId);
    expect(s.store.state.characters.c_bo.resumeError).toBeUndefined();
    const row = journalOf(s.paths).activation!.find((a) => a.characterId === 'c_bo');
    expect(row).toMatchObject({ ok: true, sessionId: SID, notice: bo.notice });

    // answered, Claude starts the carried session, which leaves the terminal the fleet's as any other
    expect(d.crew.carried('c_bo')).toBe(true);
    d.crew.started('c_bo', undefined, SID);
    await settle();
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_bo')).toEqual(row);
    expect(d.crew.carried('c_bo')).toBe(false);
  });

  it('counts a resumed Claude in a folder this machine trusts up after ten silent seconds in its pane, with a notice that it may wait at a prompt, and watches it', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    // stopped at a prompt its folder's trust does not answer, as a project's MCP server or bypass mode asks, and silent until answered
    d.crew.silent.add('c_bo');

    const { r, at } = await activateBy(d);

    // ten seconds of Claude in its pane, and not the minute a SessionStart had
    expect(at).toBeGreaterThanOrEqual(10_000);
    expect(at).toBeLessThanOrEqual(11_000);
    const bo = r.characters.find((c) => c.id === 'c_bo')!;
    expect(bo).toEqual({ id: 'c_bo', ok: true, notice: "claude has not started its session in bo's terminal and may be waiting at a prompt there; answer it there" });
    expect(d.crew.log).not.toContain('kill c_bo');
    expect(s.store.state.characters.c_bo.tmux?.paneId).toBe(d.crew.window('c_bo')!.paneId);
    expect(d.crew.carried('c_bo')).toBe(true);
    d.crew.started('c_bo', undefined, SID);
    await settle();
    expect(d.crew.carried('c_bo')).toBe(false);
  });

  it('counts a resumed Claude in a folder this machine trusts up by a SessionStart that comes inside those ten seconds, with no notice', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_bo');
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    await settle();
    for (let i = 0; i < 12; i++) await d.clock.advance(500);
    d.crew.started('c_bo', undefined, SID);
    await d.clock.advance(500);
    const r = await run;
    expect(r.characters.find((c) => c.id === 'c_bo')).toEqual({ id: 'c_bo', ok: true });
  });

  it("keeps watching a Claude counted up at its trust prompt, and lays it dormant again with its carried resume and an error once it exits there", async () => {
    const bo = `claude --effort 'high' --resume ${SID}`;
    const s = await scene({ tamper: (m) => { m.snapshot.characters.c_bo.revive = { command: bo }; } });
    const d = daemon(s);
    d.gateway.commit((await d.handover.prepare(params(s))).preparedDigest);
    fs.rmSync(path.join(s.dst, '.claude/.claude.json'));
    d.crew.silent.add('c_bo');

    const { r } = await activateBy(d);
    expect(r.characters.find((c) => c.id === 'c_bo')).toMatchObject({ ok: true, notice: expect.stringMatching(/Yes, I trust this folder/) });
    // until its session starts, the fleet leaves the agent and resume command the terminal carries alone
    await d.clock.advance(10_000);
    expect(d.crew.carried('c_bo')).toBe(true);
    expect(d.crew.log).not.toContain('kill c_bo');

    // "No, exit", which the prompt preselects
    d.crew.window('c_bo')!.command = 'bash';
    await d.clock.advance(5000);

    expect(d.crew.log).toContain('kill c_bo');
    const c = s.store.state.characters.c_bo;
    expect(c.tmux).toBeUndefined();
    expect(c).toMatchObject({
      agent: { sessionId: SID }, revive: { command: bo },
      resumeError: expect.stringMatching(/^bo's terminal resumed claude session \S+, but claude exited back to its shell before that session started, .*; revive it and choose "Yes, I trust this folder"/),
    });
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_bo')).toMatchObject({ ok: false, error: c.resumeError });
    expect(d.crew.carried('c_bo')).toBe(false);
  });

  it('looks at a Claude waiting at its trust prompt less and less often, down to once a minute, and leaves it to the fleet once the handover completes', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_bo');
    const { r } = await activateBy(d);
    expect(r.characters.find((c) => c.id === 'c_bo')).toMatchObject({ ok: true, notice: expect.stringMatching(/may be waiting at a prompt/) });
    let looks = 0;
    const list = d.crew.tmux.listWindows;
    d.crew.tmux.listWindows = (signal) => { looks++; return list(signal); };

    for (let t = 0; t < 300; t++) await d.clock.advance(1000);
    // at 2, 6, 14, 30 and 62 seconds, then once a minute
    expect(looks).toBeLessThanOrEqual(9);
    expect(d.crew.carried('c_bo')).toBe(true);

    await d.handover.complete({ transactionId: TX, generation: 5 });
    for (let t = 0; t < 60; t++) await d.clock.advance(1000);
    looks = 0;
    for (let t = 0; t < 120; t++) await d.clock.advance(1000);
    expect(looks).toBe(0);
    expect(d.crew.carried('c_bo')).toBe(false);
  });

  it('stops watching a Claude at its trust prompt after an hour while the handover stays open', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_bo');
    await activateBy(d);
    for (let t = 0; t < 59; t++) await d.clock.advance(60_000);
    expect(d.crew.carried('c_bo')).toBe(true);
    for (let t = 0; t < 3; t++) await d.clock.advance(60_000);
    expect(d.crew.carried('c_bo')).toBe(false);
    expect(d.handover.journalState().kind).toBe('open');
  });

  it('keeps watching a Claude that answered its trust prompt, and names no trust prompt once it exits at a later one', async () => {
    const bo = `claude --dangerously-skip-permissions --resume ${SID}`;
    const s = await scene({ tamper: (m) => { m.snapshot.characters.c_bo.revive = { command: bo }; } });
    const d = daemon(s);
    d.gateway.commit((await d.handover.prepare(params(s))).preparedDigest);
    const config = path.join(s.dst, '.claude/.claude.json');
    const trust = fs.readFileSync(config);
    fs.rmSync(config);
    d.crew.silent.add('c_bo');

    const { r } = await activateBy(d);
    expect(r.characters.find((c) => c.id === 'c_bo')).toMatchObject({ ok: true, notice: expect.stringMatching(/Yes, I trust this folder/) });
    // "Yes, I trust this folder", which Claude writes into its config, then its Bypass Permissions warning, which holds its SessionStart too
    fs.writeFileSync(config, trust);
    await d.clock.advance(10_000);
    expect(d.crew.carried('c_bo')).toBe(true);

    // "No, exit", which that warning preselects
    d.crew.window('c_bo')!.command = 'bash';
    await d.clock.advance(5000);

    const c = s.store.state.characters.c_bo;
    expect(c).toMatchObject({
      agent: { sessionId: SID }, revive: { command: bo },
      resumeError: expect.stringMatching(/^bo's terminal resumed claude session \S+, but claude exited back to its shell before that session started, .*; revive it and answer the prompt it waits at$/),
    });
    expect(c.resumeError).not.toMatch(/trust/i);
  });

  it('counts a resumed Claude up by its SessionStart, with no notice, when it comes before the settle in a folder this machine does not trust', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    fs.rmSync(path.join(s.dst, '.claude/.claude.json'));

    const { r } = await activateBy(d);

    expect(r.characters.find((c) => c.id === 'c_bo')).toEqual({ id: 'c_bo', ok: true });
    expect(d.crew.log).not.toContain('kill c_bo');
  });

  it('names what a resumed Codex did when it exits back to its shell, and leaves it dormant with its session', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.silent.add('c_dee');
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    let done = false;
    void run.finally(() => { done = true; });
    await waitFor(() => d.crew.window('c_dee') !== undefined);
    await d.clock.advance(500);
    expect(d.crew.window('c_dee')?.command).toBe('codex');
    // Codex ends at once, as one that cannot find its session does
    d.crew.window('c_dee')!.command = 'bash';
    for (let i = 0; i < 4 && !done; i++) await d.clock.advance(500);
    expect(done).toBe(true);
    const r = await run;

    const dee = r.characters.find((c) => c.id === 'c_dee')!;
    expect(dee).toMatchObject({ ok: false, error: expect.stringMatching(/codex exited back to its shell/) });
    expect(dee.error).not.toMatch(/trust/i);
    expect(d.crew.log).toContain('kill c_dee');
    expect(s.store.state.characters.c_dee.tmux).toBeUndefined();
    expect(s.store.state.characters.c_dee).toMatchObject({ agent: { sessionId: CODEX_ID }, revive: { command: `codex resume -c tui.resume_cwd=session ${CODEX_ID}` } });
  });

  it('leaves a resume that ends back at its shell dormant with its session and a visible error', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.exiting.add('c_bo').add('c_dee');
    const run = d.handover.activate({ transactionId: TX, generation: 5 });
    let done = false;
    void run.finally(() => { done = true; });
    for (let i = 0; i < 10 && !done; i++) await d.clock.advance(60_000);
    const r = await run;

    // an agent that never came up says what its pane showed instead
    expect(r.characters.find((c) => c.id === 'c_bo')).toMatchObject({ ok: false, error: expect.stringMatching(/claude did not come up within 60 s: its pane stayed at the shell prompt/) });
    expect(r.characters.find((c) => c.id === 'c_dee')).toMatchObject({ ok: false, error: expect.stringMatching(/codex did not come up within 60 s: its pane stayed at the shell prompt/) });
    expect(d.crew.log).toEqual(expect.arrayContaining(['kill c_bo', 'kill c_dee']));
    for (const [id, command] of [['c_bo', `claude --resume ${SID}`], ['c_dee', `codex resume -c tui.resume_cwd=session ${CODEX_ID}`]]) {
      const c = s.store.state.characters[id];
      expect(c.tmux).toBeUndefined();
      expect(c).toMatchObject({ agent: { sessionId: id === 'c_bo' ? SID : CODEX_ID }, revive: { command } });
      // answered for, it is the fleet's again, and nothing of it is left for the poll to take
      expect(d.crew.carried(id)).toBe(false);
    }
  });

  it('starts only the terminals this handover rested, and leaves one dormant before the freeze as it was', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    const r = await d.handover.activate({ transactionId: TX, generation: 5 });
    expect(r.characters.map((c) => c.id).sort()).toEqual(['c_ada', 'c_bo', 'c_cy', 'c_dee']);
    await d.handover.activate({ transactionId: TX, generation: 5 });
    expect(d.crew.log.filter((l) => l.includes('c_old'))).toEqual([]);
    const old = s.store.state.characters.c_old;
    expect([old.tmux, old.second!.tmux]).toEqual([undefined, undefined]);
    expect(old.revive).toEqual({ command: '' });
  });

  it('admits phones by the lists of the fleet.json it activated', async () => {
    const { s, d, preparedDigest } = await prepared();
    const key = 'k'.repeat(48);
    const unused = {} as never;
    const api = await startApi({
      host: '127.0.0.1', port: 0, token: 'secret', store: s.store, fleet: unused, fleets: unused, handover: d.handover, terminals: unused, workspace: unused,
      usage: stubUsage, mobileControl: stubMobile, log: silentLogger, push: unused, vapidPublicKey: 'k', phones: new Phones(),
      claude: { dir: '', json: '' }, ownership: d.ownership,
      logins: () => d.config.mobile.logins, origins: () => d.config.mobile.origins, key: () => key,
    });
    // 400 is a login and origin the proxy check let through to a body it could not read; 401 a login, 403 an origin, refused
    const post = (login: string, origin?: string) => fetch(`http://127.0.0.1:${api.port}/${key}/rpc`, {
      method: 'POST', headers: { 'tailscale-user-login': login, ...(origin && { origin }) }, body: '{}',
    }).then((r) => r.status);
    try {
      // this machine's own fleet.json let in both logins and one other page
      expect(await post('them@example.com')).toBe(400);
      expect(await post('me@example.com', 'https://old.example')).toBe(400);
      d.gateway.commit(preparedDigest);
      await d.handover.activate({ transactionId: TX, generation: 5 });
      expect(await post('them@example.com')).toBe(401);
      expect(await post('me@example.com')).toBe(400);
      expect(await post('me@example.com', 'https://old.example')).toBe(403);
      expect(await post('me@example.com', 'https://phone.example')).toBe(400);
    } finally {
      await api.close();
    }
  });

  it('closes a phone socket open across activation whose login the fleet.json it activated no longer lists', async () => {
    const { s, d, preparedDigest } = await prepared();
    const key = 'k'.repeat(48);
    const unused = {} as never;
    const api = await startApi({
      host: '127.0.0.1', port: 0, token: 'secret', store: s.store, fleet: unused, fleets: unused, handover: d.handover,
      terminals: { closeAll: () => {} } as never, workspace: { unwatchAll: () => {} } as never,
      usage: stubUsage, mobileControl: stubMobile, log: silentLogger, push: unused, vapidPublicKey: 'k', phones: new Phones(),
      claude: { dir: '', json: '' }, ownership: d.ownership,
      logins: () => d.config.mobile.logins, origins: () => d.config.mobile.origins, key: () => key,
    });
    // a phone socket as the proxy opens it, with what it has been told and how it ended
    const phone = async (login: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'tailscale-user-login': login } });
      const seen = { messages: 0, closed: undefined as number | undefined };
      ws.on('message', () => { seen.messages++; });
      ws.on('close', (code) => { seen.closed = code; });
      await waitFor(() => seen.messages > 0);
      return { ws, seen };
    };
    try {
      // this machine's own fleet.json lets in both logins, so both open
      const them = await phone('them@example.com');
      const me = await phone('me@example.com');
      d.gateway.commit(preparedDigest);
      await d.handover.activate({ transactionId: TX, generation: 5 });
      await waitFor(() => them.seen.closed !== undefined, 2000);
      expect(them.seen.closed).toBe(4401);
      expect(me.ws.readyState).toBe(WebSocket.OPEN);
      me.ws.close();
    } finally {
      await api.close();
    }
  });

  it('answers only once every terminal it started has settled, even when recording one fails', async () => {
    const { d, preparedDigest } = await prepared({ failWrite: (j) => j.role === 'destination' && !!j.activation?.some((a) => a.characterId === 'c_ada' && !a.term) });
    d.gateway.commit(preparedDigest);
    const r = await refusal(d.handover.activate({ transactionId: TX, generation: 5 }));
    expect(r.message).toContain('ENOSPC');
    const seen = [...d.crew.log];
    expect(d.crew.opening).toBe(0);
    await settle();
    await settle();
    expect(d.crew.log).toEqual(seen);
    expect(seen.filter((l) => l.startsWith('open')).sort()).toEqual(['open c_ada', 'open c_ada-2', 'open c_bo', 'open c_cy', 'open c_dee']);
  });

  it('retries only the terminals that are still dormant, and keeps what the first attempt started', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    d.crew.failing.add('c_ada-2');
    const first = await d.handover.activate({ transactionId: TX, generation: 5 });
    expect(first.characters.find((c) => c.id === 'c_ada')).toMatchObject({ ok: false, error: expect.stringContaining('could not open') });
    const opened = d.crew.log.filter((l) => l.startsWith('open'));

    d.crew.failing.clear();
    d.crew.log.length = 0;
    const second = await d.handover.activate({ transactionId: TX, generation: 5 });
    expect(d.crew.log.filter((l) => l.startsWith('open'))).toEqual(['open c_ada-2']);
    expect(second.characters.every((c) => c.ok)).toBe(true);
    expect(opened).toHaveLength(5);
    expect(s.store.state.characters.c_ada.second!.tmux).toBeDefined();
  });

  it('starts again each terminal a daemon that died mid-activation opened and never started, and reports every character', async () => {
    const { s, d, preparedDigest } = await prepared({ concurrency: 2 });
    d.gateway.commit(preparedDigest);
    // every state from the promotion on keeps the session each resumed terminal carries
    const carrying = { c_bo: SID, c_dee: CODEX_ID };
    const lost: string[] = [];
    s.store.subscribe(() => {
      for (const [id, sessionId] of Object.entries(carrying)) {
        const c = s.store.state.characters[id];
        if (c && c.agent?.sessionId !== sessionId) lost.push(id);
      }
    });
    // the daemon dies with bo's and dee's windows open, each with its resume typed at the prompt and never entered
    d.crew.dies.set('c_bo', 'typed').set('c_dee', 'typed');
    void d.handover.activate({ transactionId: TX, generation: 5 });
    await waitFor(() => d.crew.log.filter((l) => l.startsWith('open')).length === 5);
    await settle();
    const atPrompt = [...d.crew.windows.values()].filter((w) => w.command === 'bash').map((w) => w.key).sort();
    expect(atPrompt).toEqual(['c_ada', 'c_ada-2', 'c_bo', 'c_cy', 'c_dee']);
    expect(journalOf(s.paths).activation!.map((a) => a.characterId).sort()).toEqual(['c_ada', 'c_ada', 'c_cy']);

    const restarted = d.start();
    const journal = restarted.handover.journalState();
    await enterStartupMode(startupMode({ ownership: restarted.ownership, journal, config: d.config }), { ownership: restarted.ownership, journal, log: silentLogger, standalone: false });
    // until the activation answers for a terminal it rested, the fleet leaves what that terminal carries alone
    expect(['c_ada', 'c_bo', 'c_cy', 'c_dee'].map((id) => d.crew.carried(id))).toEqual([false, true, false, true]);
    expect(d.crew.carried('c_ada', 2)).toBe(false);
    d.crew.dies.clear();
    d.crew.log.length = 0;
    const r = await restarted.handover.activate({ transactionId: TX, generation: 5 });

    expect(r.characters.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'c_ada', ok: true }, { id: 'c_bo', ok: true }, { id: 'c_cy', ok: true }, { id: 'c_dee', ok: true },
    ]);
    // each window that never ran its resume is replaced, and the resume runs in the new one; the rest are left as they are
    expect(d.crew.log.filter((l) => /^(kill|open)/.test(l)).sort()).toEqual(['kill c_bo', 'kill c_dee', 'open c_bo', 'open c_dee']);
    expect([...d.crew.windows.values()].filter((w) => w.command === 'bash').map((w) => w.key).sort()).toEqual(['c_ada', 'c_ada-2', 'c_cy']);
    for (const id of ['c_bo', 'c_dee']) expect(d.crew.windows.get(s.store.state.characters[id].tmux!.windowId)?.command).not.toBe('bash');
    expect(journalOf(s.paths).activation!.every((a) => a.ok)).toBe(true);
    expect(lost).toEqual([]);
    expect(['c_ada', 'c_bo', 'c_cy', 'c_dee'].some((id) => d.crew.carried(id))).toBe(false);
  });

  /** Activates until the daemon dies in the terminals `d.crew.dies` names, and starts another on the same home, held until activated. */
  async function diedMidActivation(d: Awaited<ReturnType<typeof prepared>>['d'], opened: number, over: { concurrency?: number } = {}) {
    void d.handover.activate({ transactionId: TX, generation: 5 });
    await waitFor(() => d.crew.log.filter((l) => l.startsWith('open')).length === opened);
    await settle();
    const restarted = d.start(over);
    const journal = restarted.handover.journalState();
    await enterStartupMode(startupMode({ ownership: restarted.ownership, journal, config: d.config }), { ownership: restarted.ownership, journal, log: silentLogger, standalone: false });
    d.crew.dies.clear();
    d.crew.log.length = 0;
    return restarted;
  }

  it('counts at once as up a window a dead daemon left running its agent, or whose SessionStart the restarted daemon heard', async () => {
    const { s, d, preparedDigest } = await prepared({ concurrency: 2 });
    d.gateway.commit(preparedDigest);
    // the daemon dies once bo's and dee's resumes are entered and their agents are starting
    d.crew.dies.set('c_bo', 'entered').set('c_dee', 'entered');
    const restarted = await diedMidActivation(d, 5);
    const [bo, dee] = [d.crew.window('c_bo')!, d.crew.window('c_dee')!];
    // dee's agent runs behind a launcher its process table does not read as Codex; its SessionStart reaches the daemon held until activation
    dee.command = 'node';
    d.crew.started('c_dee', undefined, CODEX_ID);

    const run = restarted.handover.activate({ transactionId: TX, generation: 5 });
    let done = false;
    void run.finally(() => { done = true; });
    await settle();
    expect(done).toBe(true);
    const r = await run;

    expect(r.characters.every((c) => c.ok)).toBe(true);
    expect(d.crew.log.filter((l) => /^(kill|open)/.test(l))).toEqual([]);
    expect([d.crew.window('c_bo'), d.crew.window('c_dee')]).toEqual([bo, dee]);
    expect(journalOf(s.paths).activation!.filter((a) => a.sessionId).map((a) => a.sessionId).sort()).toEqual([CODEX_ID, SID].sort());
  });

  it("gives a plain shell a dead daemon opened the notice it never typed, and one that shows it nothing more", async () => {
    const { d, preparedDigest } = await prepared({ concurrency: 2 });
    d.gateway.commit(preparedDigest);
    d.crew.dies.set('c_ada', 'typed').set('c_ada-2', 'typed');
    const restarted = await diedMidActivation(d, 2);
    d.crew.window('c_ada-2')!.screen.push("Svall restarted this shell after a handover; whatever ran here before did not move.");

    const r = await restarted.handover.activate({ transactionId: TX, generation: 5 });

    expect(r.characters.every((c) => c.ok)).toBe(true);
    expect(d.crew.log.filter((l) => /^(kill|open)/.test(l)).sort()).toEqual(['open c_bo', 'open c_cy', 'open c_dee']);
    const noticed = d.crew.lines.filter((l) => /restarted .* handover/.test(l)).map((l) => l.split(' ')[0]);
    expect(noticed).toContain(d.crew.window('c_ada')!.paneId);
    expect(noticed).not.toContain(d.crew.window('c_ada-2')!.paneId);
  });

  it('opens afresh a terminal whose window a dead daemon opened and that has gone or died since', async () => {
    const { s, d, preparedDigest } = await prepared({ concurrency: 2 });
    d.gateway.commit(preparedDigest);
    d.crew.dies.set('c_bo', 'typed').set('c_dee', 'typed');
    const restarted = await diedMidActivation(d, 5);
    d.crew.windows.delete(s.store.state.characters.c_bo.tmux!.windowId);
    d.crew.window('c_dee')!.dead = true;

    const r = await restarted.handover.activate({ transactionId: TX, generation: 5 });

    expect(r.characters.every((c) => c.ok)).toBe(true);
    expect(d.crew.log.filter((l) => /^(kill|open)/.test(l)).sort()).toEqual(['kill c_dee', 'open c_bo', 'open c_dee']);
    for (const id of ['c_bo', 'c_dee']) expect(d.crew.window(id)?.command).toBe(s.store.state.characters[id].agent!.kind);
  });

  it('judges each window a dead daemon left by its pane when that terminal\'s turn comes, never closing an agent started since', async () => {
    const { d, preparedDigest } = await prepared({ concurrency: 2 });
    d.gateway.commit(preparedDigest);
    d.crew.dies.set('c_bo', 'entered').set('c_dee', 'typed');
    const restarted = await diedMidActivation(d, 5, { concurrency: 1 });
    // bo's agent runs where its process table cannot say, so the activation waits on its SessionStart
    d.crew.window('c_bo')!.command = 'node';
    const run = restarted.handover.activate({ transactionId: TX, generation: 5 });
    await settle();
    // meanwhile someone presses Enter on dee's typed resume, and Codex starts
    d.crew.window('c_dee')!.command = 'codex';
    d.crew.started('c_bo', undefined, SID);
    const r = await run;

    expect(r.characters.every((c) => c.ok)).toBe(true);
    expect(d.crew.log.filter((l) => /^(kill|open)/.test(l))).toEqual([]);
  });

  it('finishes a promotion a crash cut short, whichever side of the rename it fell on', async () => {
    for (const renamed of [false, true]) {
      const { s, d, preparedDigest } = await prepared();
      d.gateway.commit(preparedDigest);
      fs.writeFileSync(s.paths.journal, JSON.stringify({ ...journalOf(s.paths), phase: 'commit' }));
      if (renamed) fs.renameSync(s.paths.preparedState(TX), s.paths.state);
      const again = d.start();
      const r = await again.handover.activate({ transactionId: TX, generation: 5 });
      expect(r.characters.every((c) => c.ok), `renamed: ${renamed}`).toBe(true);
      expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
      expect(s.store.state.characters.c_ada.cwd).toBe(path.join(s.dst, 'work/ada'));
      expect(Store.readSnapshot(s.paths.state).characters.c_ada.cwd).toBe(path.join(s.dst, 'work/ada'));
    }
  });

  it('promotes no state but the one it prepared: not one changed since, nor a state.json in place of one gone, and stays held', async () => {
    for (const how of ['changed', 'gone'] as const) {
      const { s, d, preparedDigest } = await prepared();
      d.gateway.commit(preparedDigest);
      const before = fs.readFileSync(s.paths.state);
      const file = s.paths.preparedState(TX);
      if (how === 'changed') fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), defaultCwd: '/elsewhere' }));
      else fs.rmSync(file);
      const r = await refusal(d.handover.activate({ transactionId: TX, generation: 5 }));
      expect(r.message, how).toMatch(how === 'changed' ? /is not the state handover tx-1 prepared/ : /prepared is gone/);
      expect(fs.readFileSync(s.paths.state), how).toEqual(before);
      expect(s.store.state.characters, how).toEqual({});
      expect(d.ownership.writable(), how).toBe(false);
      expect(d.crew.log, how).toEqual([]);
    }
  });

  it('runs the fleet it activated before a restart once it completes, and only while the gateway names it the owner', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    const committed = d.gateway.record;
    await d.handover.activate({ transactionId: TX, generation: 5 });
    const restarted = d.start();
    const journal = restarted.handover.journalState();
    await enterStartupMode(startupMode({ ownership: restarted.ownership, journal, config: d.config }), { ownership: restarted.ownership, journal, log: silentLogger, standalone: false });
    d.crew.log.length = 0;

    d.gateway.record = { fleetId, generation: 7, ownerMachineId: mac };
    expect((await refusal(restarted.handover.complete({ transactionId: TX, generation: 5 }))).code).toBe('not_owner');
    expect(restarted.ownership.writable()).toBe(false);
    expect(d.crew.log).toEqual([]);

    d.gateway.record = committed;
    expect(await restarted.handover.complete({ transactionId: TX, generation: 5 })).toEqual({});
    expect(restarted.ownership.writable()).toBe(true);
    expect(d.crew.log).toEqual(['activate', 'reconcile']);
  });

  it('lets a restarted destination out of its hold only by activating', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    const restarted = d.start();
    const journal = restarted.handover.journalState();
    await enterStartupMode(startupMode({ ownership: restarted.ownership, journal, config: d.config }), { ownership: restarted.ownership, journal, log: silentLogger, standalone: false });
    expect(restarted.ownership.writable()).toBe(false);
    await restarted.handover.activate({ transactionId: TX, generation: 5 });
    expect(restarted.ownership.writable()).toBe(true);
    expect(() => restarted.ownership.assertOwner('mutation')).not.toThrow();
  });

  it('refuses to abort once it has seen the commit', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    await d.handover.activate({ transactionId: TX, generation: 5 });
    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('handover_committed');
  });
});

const withTmux = hasTmux() ? describe : describe.skip;

withTmux('destination activate on real terminals', () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of stops.splice(0)) await f(); });

  // a prepared destination, committed, whose terminals open in a shell
  async function committed() {
    const s = await scene();
    const d = daemon(s);
    const { preparedDigest } = await d.handover.prepare(params(s));
    d.gateway.commit(preparedDigest);
    fs.writeFileSync(s.paths.tmuxConf, tmuxConfText(Config.parse({ shell: '/bin/sh' })));
    // programs named for the agents, which ps reads as them
    const bin = path.join(makeHome(), 'bin');
    fs.mkdirSync(bin);
    for (const kind of ['claude', 'codex']) fs.symlinkSync(fs.realpathSync('/bin/sleep'), path.join(bin, kind));
    return { s, d, bin };
  }

  /**
   * A daemon on this home as main wires it, with each agent's resume stood in for. One that dies either types a resume
   * and goes no further, or enters it and starts a program named for the agent, whose SessionStart dies with it; the
   * other runs a stand-in that reports its SessionStart a moment later.
   */
  function boot(c: { s: Scene; d: ReturnType<typeof daemon>; bin: string }, store: Store, o: { concurrency: number; dies?: 'typed' | 'entered'; startAfterMs?: number; codex?: 'silent' | 'exits'; claude?: 'prompt' | 'exits' }) {
    const { s, d, bin } = c;
    const ownership = OwnershipState.load({ paths: s.paths, fleetId, machineId: trift, log: silentLogger });
    const tmux = new Tmux(s.paths.tmuxSock, s.paths.tmuxConf);
    const fleet = new Fleet({
      store, tmux, paths: s.paths, config: loadConfig(s.paths), ownership, log: silentLogger, pollMs: 100,
      runScribe: () => Promise.reject(new Error('no scribe here')), refreshLinks: async () => {},
    });
    const send = tmux.sendLine.bind(tmux);
    tmux.sendLine = async (paneId, text, enter) => {
      const resume = /^(claude --resume|codex resume)(?: -c \S+)* (\S+)/.exec(text);
      if (!resume) return send(paneId, text, enter);
      const kind = resume[1] === 'codex resume' ? 'codex' : 'claude';
      if (o.dies === 'typed') await send(paneId, text, false);
      if (o.dies === 'entered') await send(paneId, `exec ${path.join(bin, kind)} 600`, true);
      if (o.dies) return new Promise(() => {});
      // Codex runs its SessionStart hook with the first turn, not as it resumes; one that exits is back at the shell a second later
      if (kind === 'codex' && o.codex) return send(paneId, o.codex === 'silent' ? `exec ${path.join(bin, kind)} 600` : `${path.join(bin, kind)} 1`, true);
      // Claude at its trust prompt holds its pane and runs no hook until the prompt is answered; one told "No, exit" is back at the shell
      if (kind === 'claude' && o.claude) return send(paneId, o.claude === 'prompt' ? `exec ${path.join(bin, kind)} 600` : `${path.join(bin, kind)} 6`, true);
      await send(paneId, 'exec sleep 600', true);
      const ch = Object.values(store.state.characters).find((x) => x.tmux?.paneId === paneId || x.second?.tmux?.paneId === paneId)!;
      const term = ch.second?.tmux?.paneId === paneId ? 2 as const : undefined;
      setTimeout(() => fleet.onSocketEvent({ hook: { charId: ch.id, backend: kind, name: 'SessionStart', sessionId: resume[2], ...(term && { term }) } }), o.startAfterMs ?? 0);
    };
    const handover = new HandoverService({
      ownership, journal: openJournal(s.paths), agents: async () => s.probes, fleet,
      source: idleSides(s.paths, { store }).source,
      destination: {
        paths: s.paths, config: loadConfig(s.paths), store, fleet, tmux, authority: () => d.gateway, sessionStartMs: 10_000, concurrency: o.concurrency, log: silentLogger,
      },
    });
    stops.push(async () => { fleet.stop(); await tmux.killServer(); });
    return { ownership, fleet, tmux, handover };
  }

  // the unit restarts the daemon alone: the tmux server and the windows the first one opened live on
  async function restart(c: Parameters<typeof boot>[0], o: Parameters<typeof boot>[2]) {
    const store = Store.load(c.s.paths.state, () => {});
    const second = boot(c, store, o);
    const journal = second.handover.journalState();
    await enterStartupMode(startupMode({ ownership: second.ownership, journal, config: loadConfig(c.s.paths) }), { ownership: second.ownership, journal, log: silentLogger, standalone: false });
    await second.fleet.start();
    return { ...second, store };
  }

  it('starts again the terminals a daemon that died mid-activation opened and never started, keeping their sessions throughout', async () => {
    const c = await committed();
    const { s } = c;
    const first = boot(c, s.store, { concurrency: 2, dies: 'typed' });
    void first.handover.activate({ transactionId: TX, generation: 5 });
    const typed = async (id: string) => {
      const pane = s.store.state.characters[id]?.tmux?.paneId;
      return !!pane && (await first.tmux.capture(pane, 5)).toString().includes('resume');
    };
    await waitFor(async () => (await typed('c_bo')) && (await typed('c_dee')), 10_000);
    first.fleet.stop();
    expect(journalOf(s.paths).activation!.map((a) => a.characterId).sort()).toEqual(['c_ada', 'c_ada', 'c_cy']);

    // the poll passes over dee's shell while bo's window is replaced ahead of it
    const second = await restart(c, { concurrency: 1, startAfterMs: 400 });
    const lost: string[] = [];
    second.store.subscribe(() => {
      for (const [id, sessionId] of Object.entries({ c_bo: SID, c_dee: CODEX_ID })) {
        if (second.store.state.characters[id]?.agent?.sessionId !== sessionId) lost.push(id);
      }
    });
    const before = new Map((await second.tmux.listWindows()).map((w) => [w.name, w.windowId]));

    const r = await second.handover.activate({ transactionId: TX, generation: 5 });

    expect(r.characters.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'c_ada', ok: true }, { id: 'c_bo', ok: true }, { id: 'c_cy', ok: true }, { id: 'c_dee', ok: true },
    ]);
    const after = new Map((await second.tmux.listWindows()).map((w) => [w.name, w]));
    for (const id of ['c_bo', 'c_dee']) {
      expect(after.get(id)?.windowId).not.toBe(before.get(id));
      expect(after.get(id)?.command).toBe('sleep');
    }
    expect(['c_ada', 'c_ada-2', 'c_cy'].map((name) => after.get(name)?.windowId)).toEqual(['c_ada', 'c_ada-2', 'c_cy'].map((name) => before.get(name)));
    expect(lost).toEqual([]);
  }, 30_000);

  it('counts as up at once a window a dead daemon left running its resumed agent, whose SessionStart went with that daemon', async () => {
    const c = await committed();
    const { s } = c;
    const first = boot(c, s.store, { concurrency: 2, dies: 'entered' });
    void first.handover.activate({ transactionId: TX, generation: 5 });
    const running = async (id: string, kind: string) => {
      const w = (await first.tmux.listWindows().catch(() => [])).find((x) => x.windowId === s.store.state.characters[id]?.tmux?.windowId);
      return !!w && (await ProcessTable.read()).pane(w.panePid)?.agent?.kind === kind;
    };
    await waitFor(async () => (await running('c_bo', 'claude')) && (await running('c_dee', 'codex')), 10_000);
    first.fleet.stop();

    const second = await restart(c, { concurrency: 1 });
    const before = new Map((await second.tmux.listWindows()).map((w) => [w.name, w.windowId]));
    const at = Date.now();
    const r = await second.handover.activate({ transactionId: TX, generation: 5 });

    // well inside the 10 s a resume has to report its SessionStart
    expect(Date.now() - at).toBeLessThan(5000);
    expect(r.characters.every((x) => x.ok)).toBe(true);
    const after = new Map((await second.tmux.listWindows()).map((w) => [w.name, w.windowId]));
    expect(['c_bo', 'c_dee'].map((name) => after.get(name))).toEqual(['c_bo', 'c_dee'].map((name) => before.get(name)));
    expect(journalOf(s.paths).activation!.filter((a) => a.sessionId).map((a) => a.sessionId).sort()).toEqual([CODEX_ID, SID].sort());
  }, 30_000);

  it('counts a resumed Codex that reports nothing up once ps has read it in its pane through the settle, and keeps its window', async () => {
    const c = await committed();
    const { s } = c;
    const first = boot(c, s.store, { concurrency: 2, codex: 'silent' });
    await first.fleet.start();
    const r = await first.handover.activate({ transactionId: TX, generation: 5 });

    expect(r.characters.find((x) => x.id === 'c_dee')).toMatchObject({ ok: true, notice: expect.stringMatching(/Trust this folder/) });
    const dee = s.store.state.characters.c_dee.tmux!;
    const w = (await first.tmux.listWindows()).find((x) => x.windowId === dee.windowId)!;
    expect((await ProcessTable.read()).pane(w.panePid)?.agent?.kind).toBe('codex');
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_dee')).toMatchObject({ ok: true, sessionId: CODEX_ID });
  }, 30_000);

  it("keeps a resumed Claude at its trust prompt up in its window, and takes the carried session's SessionStart there once the prompt is answered", async () => {
    const c = await committed();
    const { s } = c;
    fs.rmSync(path.join(s.dst, '.claude/.claude.json'));
    const first = boot(c, s.store, { concurrency: 2, claude: 'prompt' });
    await first.fleet.start();
    const r = await first.handover.activate({ transactionId: TX, generation: 5 });

    expect(r.characters.find((x) => x.id === 'c_bo')).toMatchObject({ ok: true, notice: expect.stringMatching(/Yes, I trust this folder/) });
    const bo = s.store.state.characters.c_bo;
    const w = (await first.tmux.listWindows()).find((x) => x.windowId === bo.tmux!.windowId)!;
    const claude = (await ProcessTable.read()).pane(w.panePid)?.agent;
    expect(claude?.kind).toBe('claude');

    // answered, Claude resumes the carried session in that window and reports it as any resume does
    const transcriptPath = bo.agent!.transcriptPath!;
    first.fleet.onSocketEvent({ hook: { charId: 'c_bo', backend: 'claude', name: 'SessionStart', sessionId: SID, transcriptPath, pid: claude!.pid } });
    expect(s.store.state.characters.c_bo).toMatchObject({ tmux: bo.tmux, agent: { kind: 'claude', sessionId: SID, transcriptPath, pid: claude!.pid } });
    expect(s.store.state.characters.c_bo.resumeError).toBeUndefined();
    expect(journalOf(s.paths).activation!.find((a) => a.characterId === 'c_bo')).toMatchObject({ ok: true, sessionId: SID });
  }, 30_000);

  it('leaves a Claude that exits at its trust prompt after Complete dormant again with its carried session and an error, which the fleet does not take from it first', async () => {
    const c = await committed();
    const { s } = c;
    fs.rmSync(path.join(s.dst, '.claude/.claude.json'));
    const first = boot(c, s.store, { concurrency: 2, claude: 'exits' });
    await first.fleet.start();
    const lost: string[] = [];
    s.store.subscribe(() => { if (s.store.state.characters.c_bo?.agent?.sessionId !== SID) lost.push('c_bo'); });
    const r = await first.handover.activate({ transactionId: TX, generation: 5 });
    expect(r.characters.find((x) => x.id === 'c_bo')).toMatchObject({ ok: true, notice: expect.stringMatching(/Yes, I trust this folder/) });
    await first.handover.complete({ transactionId: TX, generation: 5 });

    // claude, told "No, exit", is back at the shell six seconds on, and the fleet polls every 100 ms meanwhile
    await waitFor(() => !!s.store.state.characters.c_bo.resumeError, 15_000);
    expect(s.store.state.characters.c_bo.tmux).toBeUndefined();
    expect(s.store.state.characters.c_bo).toMatchObject({
      agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` }, resumeError: expect.stringMatching(/claude exited back to its shell/),
    });
    expect(lost).toEqual([]);
  }, 30_000);

  it("keeps why a resume failed on its character's record past Complete, until a revive brings that terminal up", async () => {
    const c = await committed();
    const { s } = c;
    const first = boot(c, s.store, { concurrency: 2, codex: 'exits' });
    await first.fleet.start();
    const r = await first.handover.activate({ transactionId: TX, generation: 5 });
    const error = r.characters.find((x) => x.id === 'c_dee')!.error!;
    expect(error).toMatch(/codex exited back to its shell/);
    await first.handover.complete({ transactionId: TX, generation: 5 });

    expect(first.handover.journalState()).toEqual({ kind: 'none' });
    expect(Store.readSnapshot(s.paths.state).characters.c_dee).toMatchObject({ resumeError: error, revive: { command: `codex resume -c tui.resume_cwd=session ${CODEX_ID}` } });
    expect(Object.values(Store.readSnapshot(s.paths.state).characters).filter((x) => x.resumeError).map((x) => x.id)).toEqual(['c_dee']);
    const back = await first.fleet.reviveCharacter('c_dee');
    expect(back.tmux).toBeDefined();
    expect(Store.readSnapshot(s.paths.state).characters.c_dee.resumeError).toBeUndefined();
  }, 30_000);
});

describe('destination under a forced record', () => {
  async function prepared() {
    const s = await scene();
    const d = daemon(s);
    const { preparedDigest } = await d.handover.prepare(params(s));
    return { s, d, preparedDigest };
  }

  it('discards what it prepared and never activates it, whichever machine the record names', async () => {
    for (const [owner, refusedWith] of [[trift, 'not_owner'], [elsewhere, 'generation_mismatch']] as const) {
      const { s, d, preparedDigest } = await prepared();
      const before = fs.readFileSync(s.paths.state);
      expect(await d.handover.adopt({ fleetId, generation: 7, ownerMachineId: owner })).toMatchObject({ adopted: true, superseded: TX, ownership: { generation: 7, ownerMachineId: owner } });
      for (const f of [s.paths.preparedState(TX), s.paths.replicaSeal(TX), s.paths.journal]) expect(fs.existsSync(f), `${owner} ${f}`).toBe(false);
      expect(d.ownership.writable()).toBe(owner === trift);
      expect(d.crew.log).toEqual(owner === trift ? ['activate', 'reconcile'] : []);

      // not even a gateway answering with this handover's commit brings the prepared state back
      d.gateway.commit(preparedDigest);
      expect((await refusal(d.handover.activate({ transactionId: TX, generation: 5 }))).code).toBe(refusedWith);
      expect(fs.readFileSync(s.paths.state)).toEqual(before);
      expect(d.crew.log.filter((l) => l.startsWith('open'))).toEqual([]);
    }
  });

  it('stops what an activation already under way started, once the record it waited behind names another machine', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    let answer!: () => void;
    d.gateway.gate = new Promise<void>((r) => { answer = r; });
    const activation = d.handover.activate({ transactionId: TX, generation: 5 });
    await settle();
    const adoption = d.handover.adopt({ fleetId, generation: 7, ownerMachineId: elsewhere });
    await settle();
    answer();
    await activation;
    expect(await adoption).toMatchObject({ adopted: true, superseded: TX, ownership: { generation: 7, ownerMachineId: elsewhere } });
    expect(d.crew.log.filter((l) => l.startsWith('open')).length).toBeGreaterThan(0);
    expect(d.crew.log.at(-1)).toBe('deactivate');
    expect(d.ownership.writable()).toBe(false);
  });

  it('lets its handover go for a record naming another machine even when a root cannot be sealed', async () => {
    const { s, d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    await d.handover.activate({ transactionId: TX, generation: 5 });
    const records = path.dirname(s.paths.replicaRecord(fleetId, s.dst));
    fs.chmodSync(records, 0o500);
    try {
      expect(await d.handover.adopt({ fleetId, generation: 7, ownerMachineId: mac })).toMatchObject({ adopted: true, superseded: TX, ownership: { generation: 7, ownerMachineId: mac } });
    } finally {
      fs.chmodSync(records, 0o700);
    }
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
    expect(d.ownership.writable()).toBe(false);
    expect(d.crew.log.at(-1)).toBe('deactivate');
  });

  it('keeps its handover for the commit it waits on, and a record at its own generation', async () => {
    const { d, preparedDigest } = await prepared();
    d.gateway.commit(preparedDigest);
    expect(await d.handover.adopt(d.gateway.record)).toMatchObject({ adopted: false });
    expect(await d.handover.adopt({ fleetId, generation: 5, ownerMachineId: elsewhere })).toMatchObject({ adopted: false });
    expect((await d.handover.activate({ transactionId: TX, generation: 5 })).characters.every((c) => c.ok)).toBe(true);
  });

  it('lets go at start a held destination whose handover a forced record superseded', async () => {
    const { s, d } = await prepared();
    const restarted = d.start();
    const journal = restarted.handover.journalState();
    await enterStartupMode(startupMode({ ownership: restarted.ownership, journal, config: d.config }), { ownership: restarted.ownership, journal, log: silentLogger, standalone: false });
    expect(restarted.ownership.writable()).toBe(false);
    d.gateway.record = { fleetId, generation: 7, ownerMachineId: mac };

    await adoptAtStart({ handover: restarted.handover, authority: d.gateway, fleetId, log: silentLogger });

    expect(fs.existsSync(s.paths.preparedState(TX))).toBe(false);
    expect(restarted.handover.journalState()).toEqual({ kind: 'none' });
    expect(restarted.ownership.record()).toMatchObject({ generation: 7, ownerMachineId: mac });
    expect(restarted.ownership.writable()).toBe(false);
  });
});

describe('destination claim', () => {
  const claimParams = (s: Scene, over: Partial<ParsedParams<'handover.claim'>> = {}): ParsedParams<'handover.claim'> =>
    ({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest, ...over });
  const record = (s: Scene, at: string) => JSON.parse(fs.readFileSync(s.paths.replicaRecord(fleetId, at), 'utf8'));

  it('takes every root the manifest carries for the handover the gateway holds for this machine, under the excludes it proved them with', async () => {
    const s = await scene({ land: false });
    const d = daemon(s);
    const r = await d.handover.claim(claimParams(s));
    const carried = replicaRoots(s.manifest);
    expect(r.roots.map((x) => x.id).sort()).toEqual(carried.map((x) => x.id).sort());
    for (const root of carried) {
      const claim = r.roots.find((x) => x.id === root.id)!;
      expect(claim).toEqual({ id: root.id, excludes: s.manifest.excludes, check: { ok: true, path: root.path, kind: 'absent' } });
      expect(fs.existsSync(root.path)).toBe(true);
      expect(record(s, root.path)).toMatchObject({ state: 'receiving', transactionId: TX });
    }
    // asked again, each root is this handover's own partial copy
    expect((await d.handover.claim(claimParams(s))).roots.every((x) => x.check.ok && x.check.kind === 'resume')).toBe(true);
    // nothing of the fleet moved: no journal, no hold
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
    expect(d.ownership.isFrozen()).toBe(false);
  });

  it('leaves each root it claimed receiving once the handover is let go before prepare: the next one takes what it brings there, and not an edit made here', async () => {
    const s = await scene({ land: false });
    const d = daemon(s);
    await d.handover.claim(claimParams(s));
    // the transfer copies each root, with a file the source wrote while it ran, as Finder writes .DS_Store
    fs.writeFileSync(path.join(s.src, 'work/ada/.DS_Store'), 'finder');
    for (const r of replicaRoots(s.manifest)) fs.cpSync(path.join(s.src, path.relative(s.dst, r.path)), r.path, { recursive: true, verbatimSymlinks: true });
    // and bo is edited here once it has landed
    fs.appendFileSync(path.join(s.dst, 'work/bo/index.ts'), '// edited here\n');
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac };

    expect((await refusal(d.handover.abort({ transactionId: TX, generation: 5 }))).code).toBe('not_owner');

    for (const r of replicaRoots(s.manifest)) expect(record(s, r.path), r.path).toMatchObject({ state: 'receiving', transactionId: TX });
    expect(fs.existsSync(s.paths.replicaSeal(TX))).toBe(false);

    // the next handover brings ada with that .DS_Store, and a note the source changed since
    fs.writeFileSync(path.join(s.src, 'work/ada/notes.md'), 'ada, later\n');
    const next = structuredClone({ ...s.manifest, transactionId: 'tx-2' });
    const ada = next.roots.find((r) => r.path === path.join(s.dst, 'work/ada'))!;
    ada.files = (await scanPath(path.join(s.src, 'work/ada'), rootMatcher(ada.kind, next.excludes)))!.files;
    // preflight reads what the next handover brings file by file, as its claim does
    const bo = replicaRoots(s.manifest).find((x) => x.path === path.join(s.dst, 'work/bo'))!;
    const brings = replicaRoots(next).map((x) => ({ ...x, files: next.roots.find((r) => r.id === x.id)!.files }));
    const pre = await d.handover.inspect({ roots: brings, excludes: next.excludes, folders: [] });
    expect(pre.roots.find((x) => x.id === ada.id)!.check).toEqual({ ok: true, path: ada.path, kind: 'replica' });
    expect(pre.roots.find((x) => x.id === bo.id)!.check).toMatchObject({ ok: false, blocker: { code: 'destination_diverged', message: expect.stringContaining('index.ts') } });
    d.gateway.record = { fleetId, generation: 4, ownerMachineId: mac, transaction: { id: 'tx-2', fromMachineId: mac, toMachineId: trift, phase: 'preparing', startedAt: 2 } };
    const r = await d.handover.claim({ transactionId: 'tx-2', generation: 5, manifest: next, manifestDigest: manifestDigest(next) });

    expect(r.roots.find((x) => x.id === ada.id)!.check).toEqual({ ok: true, path: ada.path, kind: 'replica' });
    expect(r.roots.find((x) => x.id === bo.id)!.check).toMatchObject({ ok: false, blocker: { code: 'destination_diverged', message: expect.stringContaining('index.ts') } });
    expect(fs.readFileSync(path.join(s.dst, 'work/bo/index.ts'), 'utf8')).toContain('edited here');
  });

  it('refuses a claim the gateway does not hold open for this machine, or one meant for another, and writes nothing', async () => {
    const s = await scene({ land: false });
    const before = tree(s.base);
    const cases: [string, (g: Gateway) => void, string][] = [
      ['no handover', (g) => { g.record = { fleetId, generation: 4, ownerMachineId: mac }; }, 'transaction_mismatch'],
      ['another handover', (g) => { g.record.transaction!.id = 'tx-2'; }, 'transaction_mismatch'],
      ['to another machine', (g) => { g.record.transaction!.toMachineId = elsewhere; }, 'transaction_mismatch'],
      ['past preparing', (g) => { g.ready('d'.repeat(64)); }, 'not_ready'],
      ['another generation', (g) => { g.record.generation = 6; }, 'generation_mismatch'],
      ['no answer', (g) => { g.down = true; }, 'authority_unreachable'],
    ];
    for (const [what, set, code] of cases) {
      const d = daemon(s);
      set(d.gateway);
      expect((await refusal(d.handover.claim(claimParams(s)))).code, what).toBe(code);
    }
    const other = { ...s.manifest, transactionId: TX, toMachineId: elsewhere };
    expect((await refusal(daemon(s).handover.claim(claimParams(s, { manifest: other, manifestDigest: manifestDigest(other) })))).code).toBe('blocked');
    expect((await refusal(daemon(s).handover.claim(claimParams(s, { generation: 4 })))).code).toBe('generation_mismatch');
    expect(tree(s.base)).toEqual(before);
  });

  it('refuses a claim whose roots a link on this machine leads elsewhere, before it reserves or creates anything', async () => {
    const s = await scene({
      land: false,
      before: ({ dst, base }) => { fs.mkdirSync(path.join(base, 'outside/work'), { recursive: true }); fs.symlinkSync(path.join(base, 'outside/work'), path.join(dst, 'work')); },
    });
    const before = tree(s.base);
    const r = await refusal(daemon(s).handover.claim(claimParams(s)));
    expect(r.code).toBe('blocked');
    expect(blockersOf(r)).toContainEqual(expect.objectContaining({ code: 'path_symlinked', message: expect.stringContaining(path.join(s.base, 'outside/work/ada')) }));
    expect(tree(s.base)).toEqual(before);
    expect(fs.readdirSync(path.join(s.base, 'outside/work'))).toEqual([]);
  });

  it('refuses a claim over a home other than its own, or when it cannot read its own, before it reserves or creates anything', async () => {
    const s = await scene({ land: false });
    const before = tree(s.base);
    const homes: [() => string, string][] = [
      [() => '/home/elsewhere', `this account's home is /home/elsewhere and the fleet's ${s.dst}; a fleet moves only between accounts with the same home path`],
      [() => { throw new Error('no HOME'); }, `this machine cannot read its own home, so it cannot tell that it is the fleet's ${s.dst}: no HOME`],
    ];
    for (const [homedir, message] of homes) {
      const r = await refusal(daemon(s, { homedir }).handover.claim(claimParams(s)));
      expect(r.code).toBe('blocked');
      expect(blockersOf(r)).toEqual([{ code: 'home_mismatch', message }]);
    }
    expect(tree(s.base)).toEqual(before);
  });

  it('refuses a claim of a root outside the home whose folder is not here, and takes it once that folder is', async () => {
    const tool = (m: { home: string }) => path.join(path.dirname(m.home), 'volumes/tool');
    const s = await scene({ land: false, tamper: (m) => { m.roots.push({ id: 'r_tool', kind: 'cwd', entry: 'dir', path: tool(m), files: [] }); } });
    const volumes = path.dirname(tool(s.manifest));
    const before = tree(s.base);
    const r = await refusal(daemon(s).handover.claim(claimParams(s)));
    expect(r.code).toBe('blocked');
    expect(blockersOf(r)).toEqual([{
      code: 'parent_missing', entity: { kind: 'root', id: 'r_tool' },
      message: `this machine has no ${volumes}, which ${tool(s.manifest)} lands in; a folder outside the home arrives at the same path here, so make ${volumes} first`,
    }]);
    expect(tree(s.base)).toEqual(before);

    fs.mkdirSync(volumes);
    const taken = (await daemon(s).handover.claim(claimParams(s))).roots.find((x) => x.id === 'r_tool')!;
    expect(taken.check).toEqual({ ok: true, path: tool(s.manifest), kind: 'absent' });
  });

  it('will not take a root again once it has prepared from it, since a second copy would undo its Git import', async () => {
    const s = await scene();
    const d = daemon(s);
    await d.handover.prepare(params(s));
    const written = tree(s.dst);
    const r = await refusal(d.handover.claim(claimParams(s)));
    expect(r.code).toBe('not_ready');
    expect(r.message).toMatch(/prepared/);
    expect(tree(s.dst)).toEqual(written);
  });

  it('reports a root that holds work it cannot vouch for, and archives it aside only when asked to', async () => {
    const s = await scene({ land: false });
    const ada = replicaRoots(s.manifest).find((x) => x.path === path.join(s.dst, 'work/ada'))!;
    fs.mkdirSync(ada.path, { recursive: true });
    fs.writeFileSync(path.join(ada.path, 'mine.txt'), 'written here\n');

    const refused = (await daemon(s).handover.claim(claimParams(s))).roots.find((x) => x.id === ada.id)!;
    expect(refused.check).toMatchObject({ ok: false, path: ada.path, blocker: { code: 'destination_occupied', entity: { kind: 'root', id: ada.id } } });
    expect(fs.readFileSync(path.join(ada.path, 'mine.txt'), 'utf8')).toBe('written here\n');

    const taken = (await daemon(s).handover.claim(claimParams(s, { archive: [ada.id] }))).roots.find((x) => x.id === ada.id)!;
    expect(taken.check).toEqual({ ok: true, path: ada.path, kind: 'absent' });
    expect(taken.archivedTo).toMatch(new RegExp(`^${ada.path}\\.archived-`));
    expect(fs.readFileSync(path.join(taken.archivedTo!, 'mine.txt'), 'utf8')).toBe('written here\n');
    expect(fs.readdirSync(ada.path)).toEqual([]);
  });
});

describe('destination inspect', () => {
  it('says whether each root could be taken and what each folder it is asked about is good for, and writes no record', async () => {
    const s = await scene({ land: false });
    const d = daemon(s);
    const carried = replicaRoots(s.manifest);
    const ada = carried.find((x) => x.path === path.join(s.dst, 'work/ada'))!;
    fs.mkdirSync(ada.path, { recursive: true });
    fs.writeFileSync(path.join(ada.path, 'mine.txt'), 'written here\n');
    const before = tree(s.home);
    const nowhere = path.join(s.base, 'nowhere');

    const r = await d.handover.inspect({ roots: carried, excludes: s.manifest.excludes, folders: [s.dst, nowhere] });
    expect(r.roots.find((x) => x.id === ada.id)!.check).toMatchObject({ ok: false, blocker: { code: 'destination_occupied' } });
    expect(r.roots.filter((x) => x.id !== ada.id).every((x) => x.check.ok && x.check.kind === 'absent')).toBe(true);
    expect(r.folders[s.dst]).toMatchObject({ exists: true, writable: true });
    expect(r.folders[s.dst].freeBytes).toBeGreaterThan(0);
    expect(r.folders[nowhere]).toEqual({ exists: false, writable: false, caseInsensitive: false, freeBytes: 0 });
    expect(tree(s.home)).toEqual(before);
    expect(fs.existsSync(path.join(s.dst, 'work/bo'))).toBe(false);
  });

  it('reads each carried folder it is asked about without writing in it, whatever the root holds', async () => {
    const s = await scene();
    const carried = replicaRoots(s.manifest);
    // one root holds work written here since it landed
    fs.writeFileSync(path.join(s.dst, 'work/ada/mine.txt'), 'written here\n');
    const snapshot = () => carried.map((r) => [r.path, ...[r.path, ...(fs.statSync(r.path).isDirectory() ? (fs.readdirSync(r.path, { recursive: true }) as string[]).sort().map((n) => path.join(r.path, n)) : [])]
      .map((p) => { const st = fs.lstatSync(p, { bigint: true }); return `${p}:${st.mtimeNs}:${st.isFile() ? fs.readFileSync(p, 'base64') : ''}`; })]);
    const before = snapshot();
    const r = await daemon(s).handover.inspect({ roots: carried, excludes: s.manifest.excludes, folders: [s.dst, ...carried.filter((x) => x.entry === 'dir').map((x) => x.path)] });
    expect(r.roots.map((x) => x.check.ok ? x.check.kind : x.check.blocker.code)).toContain('destination_diverged');
    for (const root of carried.filter((x) => x.entry === 'dir')) expect(r.folders[root.path]).toMatchObject({ exists: true, writable: true });
    expect(snapshot()).toEqual(before);
  });

  it("names each carried folder this machine's Codex would ask to trust, by the config in its own Codex home", async () => {
    const s = await scene({ land: false });
    const [bo, demo, wt, linked, fresh] = ['work/bo', 'work/demo', 'work/bo/.claude/worktrees/x', 'bo-link', 'work/new'].map((p) => path.join(s.dst, p));
    fs.mkdirSync(bo, { recursive: true });
    fs.symlinkSync(bo, linked);
    // Codex keys a folder by its real path, and trusts a checkout through the main one of its repository
    fs.writeFileSync(path.join(s.dst, '.codex/config.toml'), [
      'model = "gpt-5"', '', `[projects."${bo}"]`, 'trust_level = "trusted"', '', `[projects."${demo}"]`, 'trust_level = "untrusted"', '',
    ].join('\n'));
    const inspect = (resumes: ParsedParams<'handover.inspect'>['resumes']) =>
      daemon(s).handover.inspect({ roots: [], excludes: [], folders: [], resumes });

    const r = await inspect([
      { kind: 'codex', cwd: bo }, { kind: 'codex', cwd: linked }, { kind: 'codex', cwd: wt, repo: bo },
      { kind: 'codex', cwd: demo }, { kind: 'codex', cwd: fresh }, { kind: 'claude', cwd: bo },
    ]);
    expect(r.untrusted).toEqual([{ kind: 'codex', cwd: demo }, { kind: 'codex', cwd: fresh }]);
    // a Codex home with no config trusts nothing
    fs.rmSync(path.join(s.dst, '.codex/config.toml'));
    expect((await inspect([{ kind: 'codex', cwd: bo }])).untrusted).toEqual([{ kind: 'codex', cwd: bo }]);
    expect((await inspect(undefined)).untrusted).toBeUndefined();
  });

  it("names each carried folder this machine's Claude would ask to trust, by the config in its own Claude home, apart from Codex's in the same folder", async () => {
    const s = await scene({ land: false });
    const [app, sub, wt, plain] = ['work/app', 'work/app/sub', 'work/app/.claude/worktrees/x', 'work/plain/a'].map((p) => path.join(s.dst, p));
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(plain, { recursive: true });
    // Claude trusts a repository's main checkout for every folder in it, and outside a repository any folder above
    fs.writeFileSync(path.join(s.dst, '.claude/.claude.json'), JSON.stringify({
      projects: { [app]: { hasTrustDialogAccepted: true }, [path.join(s.dst, 'work/plain')]: { hasTrustDialogAccepted: true } },
    }));
    const inspect = (resumes: ParsedParams<'handover.inspect'>['resumes']) =>
      daemon(s).handover.inspect({ roots: [], excludes: [], folders: [], resumes });

    const r = await inspect([
      { kind: 'claude', cwd: sub, repo: app, root: app }, { kind: 'claude', cwd: wt, repo: app, root: wt }, { kind: 'claude', cwd: plain },
      { kind: 'codex', cwd: sub, repo: app, root: app },
      // a repository under the trusted folder is not trusted by it
      { kind: 'claude', cwd: path.join(plain, 'repo'), repo: path.join(plain, 'repo'), root: path.join(plain, 'repo') },
    ]);
    expect(r.untrusted).toEqual([{ kind: 'codex', cwd: sub }, { kind: 'claude', cwd: path.join(plain, 'repo') }]);
    fs.rmSync(path.join(s.dst, '.claude/.claude.json'));
    expect((await inspect([{ kind: 'claude', cwd: sub, repo: app, root: app }])).untrusted).toEqual([{ kind: 'claude', cwd: sub }]);
  });

  it("names each carried folder whose resume asks for bypass mode where this machine's Claude has not accepted it", async () => {
    const s = await scene({ land: false });
    const [app, sub, plain] = ['work/app', 'work/app/sub', 'work/plain'].map((p) => path.join(s.dst, p));
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(plain, { recursive: true });
    const inspect = (resumes: ParsedParams<'handover.inspect'>['resumes']) =>
      daemon(s).handover.inspect({ roots: [], excludes: [], folders: [], resumes });
    const resumes = [
      { kind: 'claude' as const, cwd: sub, repo: app, root: app, bypass: true }, { kind: 'claude' as const, cwd: plain, bypass: true },
      { kind: 'claude' as const, cwd: plain },
    ];

    expect((await inspect(resumes)).bypassWarned).toEqual([{ kind: 'claude', cwd: sub }, { kind: 'claude', cwd: plain }]);
    // the repository's own local settings accept it for every folder in it
    fs.mkdirSync(path.join(app, '.claude'));
    fs.writeFileSync(path.join(app, '.claude/settings.local.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    expect((await inspect(resumes)).bypassWarned).toEqual([{ kind: 'claude', cwd: plain }]);
    // accepted once on this machine, in its Claude's own settings, it is accepted everywhere
    fs.writeFileSync(path.join(s.dst, '.claude/settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    expect((await inspect(resumes)).bypassWarned).toEqual([]);
    expect((await inspect([{ kind: 'claude', cwd: plain }])).bypassWarned).toBeUndefined();
  });
});

describe('a destination root that already holds what the handover brings', () => {
  const claimParams = (s: Scene): ParsedParams<'handover.claim'> =>
    ({ transactionId: TX, generation: 5, manifest: { ...s.manifest, transactionId: TX }, manifestDigest: s.digest });
  // mission control's folder, as setup made it on this machine too
  const copyMc = ({ src, dst }: { src: string; dst: string }): void => { fs.cpSync(path.join(src, 'mc'), path.join(dst, 'mc'), { recursive: true }); };
  const mcOf = (s: Scene) => replicaRoots(s.manifest).find((x) => x.path === path.join(s.dst, 'mc'))!;
  const inspected = (s: Scene) => daemon(s).handover.inspect({
    roots: replicaRoots(s.manifest).map((r) => ({ ...r, files: s.manifest.roots.find((x) => x.id === r.id)!.files })),
    excludes: s.manifest.excludes, folders: [s.dst],
  });

  it('passes preflight and is claimed as a replica of that content', async () => {
    const s = await scene({ land: false, before: copyMc });
    const mc = mcOf(s);
    expect((await inspected(s)).roots.find((x) => x.id === mc.id)!.check).toEqual({ ok: true, path: mc.path, kind: 'replica' });
    const r = await daemon(s).handover.claim(claimParams(s));
    expect(r.roots.find((x) => x.id === mc.id)!.check).toEqual({ ok: true, path: mc.path, kind: 'replica' });
    expect(JSON.parse(fs.readFileSync(s.paths.replicaRecord(fleetId, mc.path), 'utf8'))).toMatchObject({ state: 'receiving', transactionId: TX });
  });

  it('is refused at claim, before anything is written into it, once it changed after preflight', async () => {
    const s = await scene({ land: false, before: copyMc });
    const mc = mcOf(s);
    expect((await inspected(s)).roots.find((x) => x.id === mc.id)!.check).toMatchObject({ ok: true, kind: 'replica' });
    fs.writeFileSync(path.join(mc.path, 'README.md'), 'edited here\n');
    const r = await daemon(s).handover.claim(claimParams(s));
    expect(r.roots.find((x) => x.id === mc.id)!.check).toMatchObject({ ok: false, blocker: { code: 'destination_occupied' } });
    expect(fs.existsSync(s.paths.replicaRecord(fleetId, mc.path))).toBe(false);
    expect(fs.readFileSync(path.join(mc.path, 'README.md'), 'utf8')).toBe('edited here\n');
  });
});

describe('destination inspect, of what could not land', () => {
  it('reports a root a link on this machine leads elsewhere, and the link targets that are not here', async () => {
    const s = await scene({
      land: false,
      before: ({ dst, base }) => {
        fs.mkdirSync(path.join(base, 'outside/work'), { recursive: true });
        fs.symlinkSync(path.join(base, 'outside/work'), path.join(dst, 'work'));
        fs.writeFileSync(path.join(dst, 'here.txt'), 'here');
      },
    });
    const carried = replicaRoots(s.manifest);
    const r = await daemon(s).handover.inspect({
      roots: carried, excludes: s.manifest.excludes, folders: [s.dst], links: [path.join(s.dst, 'here.txt'), path.join(s.dst, 'gone.txt')],
    });
    const ada = carried.find((x) => x.path === path.join(s.dst, 'work/ada'))!;
    expect(r.roots.find((x) => x.id === ada.id)!.check).toMatchObject({ ok: false, blocker: { code: 'path_symlinked', entity: { kind: 'root', id: ada.id } } });
    expect(r.missing).toEqual([path.join(s.dst, 'gone.txt')]);
    expect(fs.readdirSync(path.join(s.base, 'outside/work'))).toEqual([]);
  });

  it('names a root the disk here spells in another case, as a Mac finds it', () => {
    const base = fs.realpathSync(makeHome());
    fs.mkdirSync(path.join(base, 'Work'));
    const native = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: string) => native(p.replace(`${base}/work`, `${base}/Work`))) as typeof native);
    const [p, at] = [path.join(base, 'work/ada'), path.join(base, 'Work/ada')];
    expect(linkProblem(p, { kind: 'root', id: 'r_ada' })).toEqual({
      code: 'path_symlinked', entity: { kind: 'root', id: 'r_ada' },
      message: `${p} is spelled ${at} on disk here; a folder lands at the path it has on the source, the one Git and the agents record, so rename the folder here until the path reads ${p}, then try again`,
    });
  });
});

describe('destination complete', () => {
  it('seals every root it received at its generation as the import left it, and closes its journal, once it has activated', async () => {
    const s = await scene();
    const d = daemon(s);
    const { preparedDigest } = await d.handover.prepare(params(s));
    expect((await refusal(d.handover.complete({ transactionId: TX, generation: 5 }))).code).toBe('not_ready');
    d.gateway.commit(preparedDigest);
    expect((await refusal(d.handover.complete({ transactionId: TX, generation: 5 }))).code).toBe('not_ready');
    await d.handover.activate({ transactionId: TX, generation: 5 });
    const seal = SealRecord.parse(JSON.parse(fs.readFileSync(s.paths.replicaSeal(TX), 'utf8')));

    expect(await d.handover.complete({ transactionId: TX, generation: 5 })).toEqual({});
    for (const root of seal.roots) {
      expect(JSON.parse(fs.readFileSync(s.paths.replicaRecord(fleetId, root.path), 'utf8'))).toMatchObject({
        state: 'sealed', sealedBy: TX, generation: 5, manifestDigest: s.digest, baseline: root.files,
      });
    }
    for (const f of [s.paths.journal, s.paths.replicaSeal(TX), s.paths.preparedState(TX)]) expect(fs.existsSync(f)).toBe(false);
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
    expect(d.ownership.writable()).toBe(true);
    // again: nothing is left to complete
    expect(await d.handover.complete({ transactionId: TX, generation: 5 })).toEqual({});
    // the next handover here finds each root holding only what this one left
    const replicas = new ReplicaStore({ fleetId, paths: s.paths });
    for (const r of replicaRoots(s.manifest)) {
      expect(await replicas.inspect(r, { transactionId: 'tx-2', excludes: s.manifest.excludes }), r.path).toMatchObject({ ok: true, kind: 'replica' });
    }
  });
});

describe("a moved fleet's docs and agent profiles", () => {
  it('are found on the destination by the same keys and names as on the source, and sealed for the way back', async () => {
    const base = fs.realpathSync(makeHome());
    // the home path both machines share, the fleet home in it, and where the Mac's tree is set aside once the fleet has left it
    const dst = path.join(base, 'home');
    const home = path.join(dst, '.svall');
    const aside = path.join(base, 'mac');
    const repo = path.join(dst, 'work/app');
    for (const d of [repo, path.join(dst, 'mc'), home]) fs.mkdirSync(d, { recursive: true });
    const paths = resolvePaths(home);
    const island: Island = { id: 'i_work', name: 'work', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
    // a folder with no Git in it keys its repository docs as a main checkout would: by its absolute path
    const ada = char('c_ada', repo, { islandId: island.id, agentProfile: 'reviewer' });
    // the Mac's docs at every tier, each keyed as docs.ts keys it, and the profile ada names
    const tiers = { fleet: fleetDir(paths.docs), repo: docsDir(paths.docs, 'repo', repoSlug(repo)), island: docsDir(paths.docs, 'island', island.id), character: docsDir(paths.docs, 'character', ada.id) };
    for (const [tier, dir] of Object.entries(tiers)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${tier}.md`), `---\ndescription: the ${tier} doc\n---\n${tier} notes\n`);
    }
    fs.mkdirSync(paths.agentProfiles);
    fs.writeFileSync(path.join(paths.agentProfiles, 'reviewer.md'), '---\ndescription: reviews\n---\nReview every change.\n');
    const state = emptyState();
    state.islands[island.id] = island;
    state.characters[ada.id] = rested(ada);
    const fleet = FleetConfig.parse({ id: fleetId, gatewayMachineId: trift, home: { cwd: '~/mc' } });
    const inventory = buildInventory(state, { fleet }, { source: { machineId: mac, home: dst, fleetHome: home }, destination: { machineId: trift, home: dst, fleetHome: home } });
    const built = await buildManifest(inventory, { transactionId: TX, generation: 4 });
    expect(built.blockers).toEqual([]);

    // the fleet leaves the Mac, fleet home and all: this disk is trift's, whose fleet home holds only its own records
    fs.renameSync(dst, aside);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(paths.fleetConfig, JSON.stringify(FleetConfig.parse({ id: fleetId, gatewayMachineId: trift })));
    fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 4, ownerMachineId: mac }));
    const store = Store.load(paths.state, () => {});
    const landed = await transfer(paths, built.manifest, (p) => path.join(aside, path.relative(dst, p)));
    const s = { paths, store, probes: [], manifest: built.manifest };
    const d = daemon(s);
    const { preparedDigest } = await d.handover.prepare({ transactionId: TX, generation: 5, manifest: { ...built.manifest, transactionId: TX }, manifestDigest: manifestDigest(built.manifest), landed });
    d.gateway.commit(preparedDigest);
    await d.handover.activate({ transactionId: TX, generation: 5 });
    await d.handover.complete({ transactionId: TX, generation: 5 });

    const moved = store.state.characters[ada.id];
    expect(moved.agentProfile).toBe('reviewer');
    expect(readAgentProfile(paths.agentProfiles, 'reviewer')).toEqual({ name: 'reviewer', description: 'reviews', body: 'Review every change.' });
    expect(docFolders(paths.docs, store.state.islands[island.id], moved).map((f) => [f.tier, f.dir, f.docs.map((x) => x.description)])).toEqual([
      ['fleet', tiers.fleet, ['the fleet doc']], ['repo', tiers.repo, ['the repo doc']], ['island', tiers.island, ['the island doc']], ['character', tiers.character, ['the character doc']],
    ]);
    const replicas = new ReplicaStore({ fleetId, paths });
    for (const r of replicaRoots(built.manifest).filter((x) => x.kind === 'docs' || x.kind === 'profiles')) {
      expect(await replicas.inspect(r, { transactionId: 'tx-2', excludes: built.manifest.excludes }), r.path).toMatchObject({ ok: true, kind: 'replica' });
    }
    expect(replicaRoots(built.manifest).map((r) => r.kind).sort()).toEqual(['cwd', 'docs', 'home', 'profiles']);
  });
});

describe('destination complete, when a root cannot be sealed', () => {
  it('says so and keeps its journal and what it would seal, so a later Complete can seal it', async () => {
    const s = await scene();
    const d = daemon(s);
    const { preparedDigest } = await d.handover.prepare(params(s));
    d.gateway.commit(preparedDigest);
    await d.handover.activate({ transactionId: TX, generation: 5 });
    const [first] = replicaRoots(s.manifest);
    const record = s.paths.replicaRecord(fleetId, first.path);
    const held = fs.readFileSync(record);
    fs.rmSync(record);
    const r = await refusal(d.handover.complete({ transactionId: TX, generation: 5 }));
    expect(r.code).toBe('not_ready');
    expect(r.message).toContain(first.path);
    expect(fs.existsSync(s.paths.replicaSeal(TX))).toBe(true);
    expect(d.handover.journalState()).toMatchObject({ kind: 'open' });
    fs.writeFileSync(record, held);
    expect(await d.handover.complete({ transactionId: TX, generation: 5 })).toEqual({});
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
  });

  it('keeps its journal when the record of what to seal cannot be read', async () => {
    const s = await scene();
    const d = daemon(s);
    const { preparedDigest } = await d.handover.prepare(params(s));
    d.gateway.commit(preparedDigest);
    await d.handover.activate({ transactionId: TX, generation: 5 });
    const seal = fs.readFileSync(s.paths.replicaSeal(TX));
    fs.writeFileSync(s.paths.replicaSeal(TX), '{ not json');
    const r = await refusal(d.handover.complete({ transactionId: TX, generation: 5 }));
    expect(r.code).toBe('not_ready');
    expect(r.message).toContain(s.paths.replicaSeal(TX));
    expect(d.handover.journalState()).toMatchObject({ kind: 'open' });
    fs.writeFileSync(s.paths.replicaSeal(TX), seal);
    expect(await d.handover.complete({ transactionId: TX, generation: 5 })).toEqual({});
    expect(d.handover.journalState()).toEqual({ kind: 'none' });
  });
});

describe('Store promotion', () => {
  it('moves the prepared file into place and publishes it, without writing state.json a second time', async () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    const store = Store.load(paths.state, () => {});
    store.update((d) => { d.scribeOff = true; });
    const next = { ...emptyState(), defaultCwd: '/srv/work' };
    fs.mkdirSync(paths.handoverDir, { recursive: true });
    fs.writeFileSync(paths.preparedState(TX), JSON.stringify(next));
    const inode = fs.statSync(paths.preparedState(TX)).ino;
    const ops = store.promote(paths.preparedState(TX));
    expect(ops.length).toBeGreaterThan(0);
    expect(store.state.defaultCwd).toBe('/srv/work');
    // the very file prepared, renamed: a rewrite would have landed as a new file
    expect(fs.statSync(paths.state).ino).toBe(inode);
    expect(fs.existsSync(paths.preparedState(TX))).toBe(false);
  });
});
