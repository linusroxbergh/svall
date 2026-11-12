import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABEL, agentsInUse, FleetConfig, MachineId, MachineRecord, migrateState, ON_THIS_MAC, WorkerFile, type AgentKind, type FleetState, type LimitsOffer, type SetupRow } from '@svall/protocol';
import { AGENT_KINDS, AGENTS, compareVersions, versionOf, versionOk } from '@svall/svalld/agents';
import { readFleetConfig } from '@svall/svalld/config';
import { GATEWAY_UNIT, svalldUnitName, unitDirOf, unitPath } from '@svall/svalld/linux/setup';
import { homeWord } from '@svall/svalld/machine';
import { LinkProblem, TailscaleDown } from '@svall/svalld/mobile';
import { isFleetName, isProfileName, PRIVATE, profileHome, profileOf } from '@svall/svalld/profile';
import { readMarker } from '@svall/svalld/fleet/home-move';
import { enrolLock, hostLock } from '@svall/svalld/kernel-lock';
import { fleetHomeOfSocket, resolvePaths, socketTooLong } from '@svall/svalld/paths';
import { clearConsent } from '@svall/svalld/placement/mirror-consent';
import { dropToken, enrollArgv, issueToken, keyLine, noLoginFix, workerProfile } from '@svall/svalld/placement/workers';
import { svallExe } from '@svall/svalld/release';
import { releaseRuntime } from '@svall/svalld/runtime';
import { tmuxTooOld } from '@svall/svalld/tmux/conf';
import { shq } from '@svall/svalld/text';
import { isWorker, readWorkerFile } from '@svall/svalld/worker/mode';
import type { Verify } from '../../../../scripts/release-manifest.mjs';
import type { Check } from '../checks-view.js';
import { connectForwarded, identify, MachineMismatch } from './connection.js';
import {
  bootstrapSetup, companionAsset, companionCache, currentRelease, downloadCompanion, inspectCompanion, noCompanion, ownCompanion,
  remoteRollback, requireCompatible, rollbackRefusal, uploadArchive, type CompanionArchive, type FetchLike,
} from './install.js';
import { limitsStep, type LimitsChoice } from './limits.js';
import { redact } from './process.js';
import { MachineRegistry, reservedName, type MachineEntry } from './registry.js';
import { classifySsh, inFull, SshError, type SshMaster } from './ssh.js';

const PROBE_TIMEOUT = 30_000;
// the enrolment there waits on systemd to restart the fleet's daemon and on that daemon to answer
const ENROL_TIMEOUT = 120_000;
// how long a check waits for a re-enrol it set off to land, and how often it asks
const JOIN_MS = 30_000;
const JOIN_POLL_MS = 500;
const FREE_FLOOR_KB = 5 * 1024 * 1024;

export type StepStatus = 'start' | 'ok' | 'warn' | 'fail' | 'skip';
// run: a next command toward `action`'s fix, for the user to run on the machine; more steps may remain; forward: the
// port its terminal forwards from this Mac; tick: the consent a mirror row toggles; gap: what will not work there yet;
// here: that this Mac has the variable a row is about
// say: what a window shows in place of `action`, where a button stands for the command; raw: what a tool said, word for word;
// offer: the machine's size and the limits a window asks the fleet to keep to, while none is set
export type StepEvent = {
  step: string; status: StepStatus; detail?: string; action?: string; run?: string; say?: string; forward?: number; tick?: SetupRow['tick']; gap?: SetupRow['gap']; here?: SetupRow['here'];
  raw?: string; offer?: LimitsOffer;
};
// actions: the things to fix there; stopped: the step a run failed at, past which nothing ran; setup: the mirror rows of
// what will not work there yet, which never stop a robot moving there
export type HostOutcome = { result: 'ready' | 'actions'; actions: string[]; stopped?: string; setup?: StepEvent[] };

export type HostDeps = {
  emit(event: StepEvent): void;
  /** told the release an add, upgrade or rollback leaves the machine running, once it knows it */
  runs?(release: string): void;
  registry: MachineRegistry;
  openMaster(destination: string): Promise<SshMaster>;
  /** one ssh the user can answer: a new host key, a passphrase, a password; stderr: the last of what ssh said; batch: there is no one to answer, as on a home with no terminal */
  interactiveSsh(destination: string): Promise<{ code: number; stderr: string; batch?: true }>;
  fetch: FetchLike;
  controller: { release: string; protocol: number; releaseRoot: string; signed: boolean };
  /** this Mac's agent CLIs, as its own fleet's daemon finds them; rejects when it cannot be asked */
  localAgents(): Promise<{ kind: AgentKind; version?: string }[]>;
  /** this Mac's own id, which a worker it enrols names as its home machine */
  machineId(): MachineId;
  /** this machine's Tailscale state; rejects with why a server home cannot work from here */
  tailnet(): Promise<unknown>;
  homedir: string;
  /** checks a release's signature against the signers this controller ships */
  verify: Verify;
  /** the fleet a machine is made a worker of: its home on this Mac, and the profile it runs under there, none for the private fleet */
  fleet: { home: string; profile?: string };
  /** has this fleet's daemon link the machines enrolled since it started; one that is not running links them at its start */
  refreshLinks(): Promise<void>;
  /** the machine's setup rows, as this fleet's daemon reads its mirror there, its link given up to `waitMs` to come up; rejects when the daemon cannot be asked */
  setupRows(machine: MachineId, waitMs: number): Promise<SetupRow[]>;
  /** ticks or unticks `fields` of `item` for the machine in this fleet's mirror, and answers its setup rows */
  consent(machine: MachineId, item: string, fields: string[], on: boolean): Promise<SetupRow[]>;
  /** why the re-enrol this fleet's daemon owes the machine has not landed yet, '' before it says, and when its last try ended; undefined once it owes none */
  joining(machine: MachineId): Promise<{ why: string; tried?: number } | undefined>;
};

export type AddOptions = { name: string; ssh: string; release?: string; allowUnsigned?: boolean; asHome?: boolean } & LimitsChoice;

/** A step that could not finish, with the one thing the user can do about it. */
export class StepError extends Error {
  constructor(readonly detail: string, readonly action?: string, readonly run?: string, readonly say?: string, readonly raw?: string) { super(detail); }
}

/** A far daemon that answers, from another release than the one asked for. */
class OtherRelease extends StepError {
  constructor(readonly running: string, asked: string) { super(`answers from ${running}, not ${asked}`); }
}

type Outcome<T> = {
  value: T; status?: StepStatus; detail?: string; action?: string; run?: string; say?: string; forward?: number; tick?: SetupRow['tick']; gap?: SetupRow['gap']; here?: SetupRow['here']; raw?: string;
  offer?: LimitsOffer;
};

// an SshError that only says a command there exited goes behind the step's own words; one in Svall's words stays the step's
const sshStepError = (err: SshError): StepError =>
  / exited \d+$/.test(err.message) ? new StepError('did not finish', undefined, undefined, undefined, inFull(err)) : new StepError(err.message, undefined, undefined, undefined, err.raw);

/** The step events a host command emits, the actions they leave the user with, and the mirror rows of what will not work there. */
export class Runner {
  readonly actions: string[] = [];
  private readonly setup: StepEvent[] = [];
  private failed?: string;

  constructor(private readonly emit: (e: StepEvent) => void) {}

  // two steps can find the same thing to do
  private todo(action: string): void {
    if (!this.actions.includes(action)) this.actions.push(action);
  }

  async step<T>(step: string, fn: () => Promise<Outcome<T>>): Promise<T> {
    this.emit({ step, status: 'start' });
    let r: Outcome<T>;
    try {
      r = await fn();
    } catch (err) {
      const e = err instanceof StepError ? err : err instanceof SshError ? sshStepError(err) : new StepError((err as Error).message);
      this.failed = step;
      this.todo(e.action ?? e.detail);
      this.emit({ step, status: 'fail', detail: e.detail, ...(e.action ? { action: e.action } : {}), ...(e.run ? { run: e.run } : {}), ...(e.say ? { say: e.say } : {}), ...(e.raw ? { raw: e.raw } : {}) });
      throw e;
    }
    const event: StepEvent = {
      step, status: r.status ?? 'ok',
      ...(r.detail ? { detail: r.detail } : {}), ...(r.action ? { action: r.action } : {}), ...(r.run ? { run: r.run } : {}), ...(r.say ? { say: r.say } : {}),
      ...(r.forward !== undefined ? { forward: r.forward } : {}), ...(r.tick ? { tick: r.tick } : {}), ...(r.gap ? { gap: r.gap } : {}), ...(r.here ? { here: r.here } : {}),
      ...(r.raw ? { raw: r.raw } : {}), ...(r.offer ? { offer: r.offer } : {}),
    };
    if (step.startsWith('mirror:')) {
      if (r.gap) this.setup.push(event);
    } else if (r.action) this.todo(r.action);
    this.emit(event);
    return r.value;
  }

  outcome(): HostOutcome {
    return {
      result: this.failed || this.actions.length ? 'actions' : 'ready', actions: this.actions, ...(this.failed && { stopped: this.failed }),
      ...(this.setup.length > 0 && { setup: this.setup }),
    };
  }
}

/** This machine's Tailscale, which a fleet on a server needs on both machines. */
export async function tailnetHere(d: Pick<HostDeps, 'tailnet'>, platform: NodeJS.Platform = process.platform): Promise<Outcome<void>> {
  await d.tailnet().catch((e: Error) => {
    const [here, mac] = [homeWord(), platform === 'darwin'];
    const raw = e instanceof LinkProblem ? e.said.raw : e.message;
    const state = e instanceof TailscaleDown ? e.state : 'missing';
    if (state === 'stopped') {
      throw new StepError(`Tailscale is not running on ${here}`, mac ? 'Open the Tailscale app' : 'Start it: sudo systemctl start tailscaled', mac ? undefined : 'sudo systemctl start tailscaled', undefined, raw);
    }
    if (state === 'signedOut') {
      throw new StepError(`Tailscale on ${here} is signed out`, mac ? 'Sign in from the Tailscale app' : 'Sign in: sudo tailscale up', mac ? undefined : 'sudo tailscale up', undefined, raw);
    }
    throw new StepError(`${here} has no Tailscale`, 'Install it from https://tailscale.com/download and sign in', undefined, undefined, raw);
  });
  return { value: undefined, detail: 'connected' };
}

/** Why the ssh master to `name` did not open: a login it refused, ssh itself, a machine it did not reach, or one that did not answer in time; ssh's own words behind. */
export function unreached(err: unknown, name: string, ssh: string, here: string, login = `run ssh ${ssh} once in a terminal and answer what it asks`): StepError {
  const { message, raw } = err as Error & { raw?: string };
  const said = raw ?? message;
  if (err instanceof SshError && (err.kind === 'auth' || err.kind === 'host_key')) return new StepError(`${here} cannot log in to ${name}`, login, undefined, undefined, said);
  if (err instanceof SshError && err.kind === 'other') return new StepError(`ssh to ${name} did not open`, `run ssh ${ssh} in a terminal to see why`, undefined, undefined, said);
  const fix = 'check that it is on and on Tailscale';
  if (/\bwithin \d|did not open a control master/.test(message)) return new StepError(`${name} did not answer in 20 s`, fix, undefined, undefined, said);
  return new StepError(`${name} is not reachable from ${here}`, fix, undefined, undefined, said);
}


/** Runs a flow to its end or to its first blocker, and reports what the user is left holding. */
export async function flow(emit: (e: StepEvent) => void, fn: (run: Runner) => Promise<void>): Promise<HostOutcome> {
  const run = new Runner(emit);
  try {
    await fn(run);
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
  }
  return run.outcome();
}

// one line for the far side's login shell: the script is literal, and only `sh -c` names reach it
const sh = (name: string, script: string, ...args: string[]): string[] =>
  ['sh', '-c', shq(script), shq(name), ...args.map(shq)];

const WHICH = 'for c in "$@"; do if command -v "$c" >/dev/null 2>&1; then echo "$c yes"; else echo "$c no"; fi; done';
const TOOLS = ['tailscale', 'git', 'systemctl', 'loginctl'];
const APT: Record<string, string> = { git: 'git' };
const ARCHES: Record<string, string> = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' };
// an architecture as a person names it
const ARCH_WORD: Record<string, string> = { arm64: 'arm64', x64: 'x86-64' };

async function probe(master: SshMaster, argv: string[], what: string, failed = 'could not be checked'): Promise<string> {
  const r = await master.run(argv, { timeoutMs: PROBE_TIMEOUT });
  if (r.code !== 0) throw new StepError(failed, undefined, undefined, undefined, `${what} exited ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
  return r.stdout;
}

const field = (osRelease: string, key: string): string =>
  (new RegExp(`^${key}=(.*)$`, 'm').exec(osRelease)?.[1] ?? '').replace(/^"|"$/g, '');

// Canonical LTS releases come out in April of an even year
const isLts = (versionId: string): boolean => /^\d\d\.04$/.test(versionId) && Number(versionId.slice(0, 2)) % 2 === 0;

async function osProbe(master: SshMaster): Promise<Outcome<{ arch: string }>> {
  const [kernel, machine] = (await probe(master, ['uname', '-sm'], 'uname -sm')).trim().split(/\s+/);
  if (kernel !== 'Linux') throw new StepError(`${kernel} is not Linux; a companion runs on Ubuntu`);
  const arch = ARCHES[machine];
  if (!arch) throw new StepError(`${machine} is not an architecture Svall publishes a companion for`);
  const osRelease = await probe(master, ['cat', '/etc/os-release'], 'cat /etc/os-release');
  const id = field(osRelease, 'ID');
  const versionId = field(osRelease, 'VERSION_ID');
  if (id !== 'ubuntu') throw new StepError(`${field(osRelease, 'NAME') || id || 'this machine'} is not Ubuntu; the companion supports the Ubuntu LTS releases`);
  // the companion's tmux is built against 22.04's glibc
  if (!(Number(versionId.split('.')[0]) >= 22)) throw new StepError(`Ubuntu ${versionId} is older than 22.04, the oldest release the companion runs on`);
  return isLts(versionId)
    ? { value: { arch }, detail: `Ubuntu ${versionId} LTS, ${ARCH_WORD[arch]}` }
    : { value: { arch }, status: 'warn', detail: `Ubuntu ${versionId}, ${ARCH_WORD[arch]}: not an LTS release` };
}

// nothing here is ever run: an action names the machine to run it on, and the user runs it
const onThere = (destination: string, how: string): string => `ssh ${destination}, then ${how}`;
const there = (destination: string, command: string): { action: string; run: string } => ({ action: onThere(destination, command), run: command });

function toolsProbe(out: string, destination: string): Outcome<void> {
  const found = new Map(out.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/) as [string, string]));
  const missing = TOOLS.filter((t) => found.get(t) !== 'yes');
  if (!missing.length) return { value: undefined, detail: 'all there' };
  const packages = missing.filter((t) => APT[t]).map((t) => APT[t]);
  if (missing.some((t) => t === 'systemctl' || t === 'loginctl')) {
    throw new StepError(`${missing.join(', ')} missing: this machine has no systemd user services, which the companion needs`);
  }
  if (packages.length) {
    const apt = there(destination, `sudo apt install ${packages.join(' ')}`);
    throw new StepError(`${missing.join(', ')} missing`, apt.action, apt.run, `Install ${packages.join(' and ')} on ${destination}`);
  }
  throw new StepError(`${missing.join(', ')} missing`, onThere(destination, 'install Tailscale from https://tailscale.com/download/linux'));
}

function spaceProbe(df: string): Outcome<number> {
  const row = df.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const free = Number(row[3]);
  if (!Number.isFinite(free)) throw new StepError('could not be read', undefined, undefined, undefined, df.trim().slice(0, 120));
  const gb = (free * 1024) / 1e9;
  const said = `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB free`;
  return free < FREE_FLOOR_KB ? { value: free, status: 'warn', detail: `${said}: low` } : { value: free, detail: said };
}

const LINGER = 'loginctl show-user "$USER" -p Linger';
// lingering read, and where it is off turned on and read again: polkit lets an account do that without sudo on a stock systemd
const SELF_LINGER = `l=$(${LINGER}) || exit; echo "$l"; [ "$l" = Linger=yes ] && exit; loginctl enable-linger "$USER" >/dev/null 2>&1; ${LINGER}; exit 0`;

function lingerProbe(out: string, user: string, destination: string): Outcome<boolean> {
  return out.trim().split('\n').at(-1) === 'Linger=yes'
    ? { value: true, detail: 'on' }
    : { value: false, status: 'warn', detail: 'off: the fleet stops when you log out', ...there(destination, `sudo loginctl enable-linger ${user}`) };
}

export async function homeProbe(master: SshMaster): Promise<{ home: string; user: string }> {
  const [home, user] = (await probe(master, sh('svall-home', 'printf "%s\\n%s\\n" "$HOME" "$USER"'), '$HOME')).split('\n');
  return { home, user: user?.trim() ?? '' };
}

// the companion's doctor prints its report and then exits 1 for any failing check, so a report is
// read whatever the exit code, and only a run that printed none is a failure
export async function remoteJson<T>(master: SshMaster, svallBase: string, argv: string[], what: string, env: string[] = []): Promise<T> {
  const r = await master.run([...env, shq(svallExe(svallBase)), ...argv], { timeoutMs: PROBE_TIMEOUT });
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new StepError('Svall there did not answer', undefined, undefined, undefined, r.code === 0
      ? `${what} did not answer JSON: ${r.stdout.trim().slice(0, 200)}`
      : `${what} exited ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
  }
}

// daemonEnv and daemonPath: the agent homes and PATH setup hands the daemon there from its login shell; an older doctor says none
type RemoteDoctor = { checks: Check[]; daemonEnv?: Record<string, string>; daemonPath?: string };
type RemoteVersion = {
  release: string; protocol: number; machineId: string; signed?: boolean; role?: 'home' | 'worker'; fleetId?: string;
  worker?: { homeMachineId: string; homeName: string; fleetId: string };
};

// a machine's own doctor speaks to a person at its shell; read from here, that shell is there
const farRow = (c: Check): Check => (c.name === 'path' && c.status === 'warn' ? { ...c, detail: 'svall is not on PATH in a shell there' } : c);

function serviceOutcome(report: RemoteDoctor, destination: string): Outcome<RemoteDoctor> {
  const named = (name: string) => report.checks.find((c) => c.name === name);
  const unit = named('systemd');
  if (!unit) throw new StepError('Svall there reported no service check');
  if (unit.status === 'fail') throw new StepError(unit.detail, unit.action, unit.run, undefined, unit.raw);
  const linger = named('linger');
  const command = linger?.status === 'warn' ? linger.run ?? /(?:sudo )?loginctl enable-linger \S+/.exec(linger.detail)?.[0] : undefined;
  return { value: report, detail: unit.detail, ...(unit.raw && { raw: unit.raw }), ...(command ? { status: 'warn' as const, ...there(destination, command) } : {}) };
}

/** The PATH the companion's units run with, less the agents' folders setup adds there, which its doctor reports as daemonPath. */
const unitPathOf = (home: string, svallBase: string): string =>
  unitPath({ runtime: releaseRuntime(path.posix.join(svallBase, 'current')), homedir: home, prefix: svallBase });

/** The tmux the units start: the companion's own, or the machine's for a release that carries none. */
async function tmuxCheck(master: SshMaster, o: { destination: string; home: string; svallBase: string }): Promise<Outcome<void>> {
  // exit 3 is no tmux on that PATH, apart from ssh's own failures and a tmux that cannot run there
  const r = await master.run(['env', shq(`PATH=${unitPathOf(o.home, o.svallBase)}`), ...sh('svall-tmux-version', 'command -v tmux || exit 3; tmux -V')], { timeoutMs: PROBE_TIMEOUT });
  const [where, version] = r.stdout.trim().split('\n');
  if (r.code === 3) {
    const apt = there(o.destination, 'sudo apt install tmux');
    throw new StepError('not installed', apt.action, apt.run, undefined, 'this release carries no tmux, and the machine has none');
  }
  if (r.code !== 0) throw new StepError('does not run', undefined, undefined, undefined, `${where || 'tmux'} -V exited ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
  const raw = `${version}, ${where.startsWith(`${o.svallBase}/`) ? "Svall's own" : `from ${where}`}`;
  const v = version.replace(/^tmux /, '');
  return tmuxTooOld(version) ? { value: undefined, status: 'warn', detail: `${v}: Shift+Enter needs 3.5`, raw } : { value: undefined, detail: v, raw };
}

// the companion doctor's checks of each agent's Svall hooks and of Codex's sandbox, whose details end with what to do there
const AGENT_CHECKS: Record<AgentKind, string[]> = { claude: ['hooks'], codex: ['codex hooks', 'codex sandbox'], opencode: ['opencode plugin'] };

/** The fleet at `home` as its state.json holds it; none while that cannot be read. */
export function fleetOf(home: string): FleetState | undefined {
  try { return migrateState(JSON.parse(fs.readFileSync(resolvePaths(home).state, 'utf8'))).state; } catch { return undefined; }
}

// a check's detail says what is wrong, then what to do there after its last ': ', unless it carries its action apart
const fixOf = (c: Pick<Check, 'detail' | 'action'>): { wrong?: string; fix: string } => {
  if (c.action) return { wrong: c.detail, fix: c.action };
  const at = c.detail.lastIndexOf(': ');
  return at < 0 ? { fix: c.detail } : { wrong: c.detail.slice(0, at), fix: c.detail.slice(at + 2) };
};

type AgentCall = (bin: string, args: string[]) => ReturnType<SshMaster['run']>;
// the --version line of each agent CLI there
type FarVersions = Partial<Record<AgentKind, string>>;

/** Runs an agent CLI there on the PATH and with the agent homes the companion's units run it with, which a login over ssh does not see all of. */
function agentCall(master: SshMaster, o: { home: string; svallBase: string; report?: RemoteDoctor }): AgentCall {
  const PATH = typeof o.report?.daemonPath === 'string' ? o.report.daemonPath : unitPathOf(o.home, o.svallBase);
  const homes = Object.entries(o.report?.daemonEnv ?? {}).filter(([k]) => /^[A-Z][A-Z0-9_]*$/.test(k)).map(([k, v]) => shq(`${k}=${v}`));
  return (bin, args) => master.run(['env', shq(`PATH=${PATH}`), ...homes, bin, ...args], { timeoutMs: PROBE_TIMEOUT });
}

/**
 * Checks each agent CLI as the companion's units run it, with the companion doctor's checks of it: each finding is
 * something to do, never something that stops setup. Hands back each version Svall's floor takes.
 */
async function agentChecks(master: SshMaster, o: { destination: string; home: string; svallBase: string; report: RemoteDoctor; fleet: string }, run: Runner): Promise<FarVersions> {
  const call = agentCall(master, o);
  const versions: FarVersions = {};
  const fleet = fleetOf(o.fleet);
  const used = fleet && agentsInUse(fleet);
  const todo = (detail: string, how: string, command?: string): Outcome<void> =>
    ({ value: undefined, status: 'warn', detail, action: onThere(o.destination, how), ...(command && { run: command }) });
  for (const kind of Object.keys(AGENT_CHECKS) as AgentKind[]) {
    await run.step(kind, async () => {
      const a = AGENTS[kind];
      const v = await call(a.bin, ['--version']);
      // env exits 127 for a program it finds nowhere on that PATH; setup writes Svall's hooks only for the agents it finds
      if (v.code === 127) {
        if (used && !used.has(kind)) return { value: undefined, status: 'skip', detail: 'not installed' };
        return todo('not installed', `install ${a.label}, then svall setup`, a.installCommand);
      }
      const version = v.stdout.trim().split('\n')[0];
      if (v.code !== 0) {
        return { ...todo('does not run', `run ${a.bin} --version there and see what it answers`), raw: `${a.bin} --version exited ${v.code}: ${v.stderr.trim().slice(0, 200) || 'no output'}` };
      }
      const shown = versionOf(version) ?? version;
      if (!versionOk(a, version)) return todo(`${shown}: needs ${a.minVersion!.join('.')} or newer`, a.updateCommand, a.updateCommand);
      versions[kind] = version;
      const login = await call(a.bin, a.loginArgs);
      if (login.code === 0 && a.loggedIn(login.stdout)) {
        const checks = o.report.checks.filter((c) => AGENT_CHECKS[kind].includes(c.name) && (c.status === 'warn' || c.status === 'fail'));
        if (!checks.length) return { value: undefined, detail: `${shown}, logged in` };
        const said = checks.map((c) => { const { wrong } = fixOf(c); return `the ${c.name} check there ${wrong ? `says ${wrong}` : c.status === 'fail' ? 'fails' : 'warns'}`; });
        return todo(`${shown}, logged in; ${said.join('; ')}`, checks.map((c) => fixOf(c).fix).join('; and '), checks.find((c) => c.run)?.run);
      }
      return todo(`${shown}, not logged in`, kind === 'codex' ? `${a.loginHint}, and trust the hooks once with /hooks` : a.loginHint, a.loginHint);
    });
  }
  // the companion's doctor runs gh with the daemon's PATH and config home; gh is advice, never a thing left before a move
  await run.step('gh', () => {
    const gh = o.report.checks.find((c) => c.name === 'gh');
    if (!gh) return Promise.resolve({ value: undefined, status: 'skip' as const, detail: "the companion's doctor reported no gh check" });
    return Promise.resolve(gh.status === 'ok' ? { value: undefined, detail: 'logged in' } : { value: undefined, status: 'warn' as const, detail: gh.detail, ...(gh.run && { run: gh.run }) });
  });
  return versions;
}

async function farVersions(call: AgentCall): Promise<FarVersions> {
  const versions: FarVersions = {};
  for (const kind of AGENT_KINDS) {
    const v = await call(AGENTS[kind].bin, ['--version']);
    if (v.code === 0) versions[kind] = v.stdout.trim().split('\n')[0];
  }
  return versions;
}

/**
 * Each agent CLI on both machines at the same release: a move goes only to a machine whose release of the robot's agent
 * is at least the source's, so there and back needs the same. The side behind is named with its update.
 */
function versionsOutcome(far: FarVersions, mine: { kind: AgentKind; version?: string }[] | Error, destination: string): Outcome<void> {
  if (mine instanceof Error) return { value: undefined, status: 'skip', detail: 'not compared', raw: mine.message };
  const both = AGENT_KINDS.flatMap((kind) => {
    const [there, here] = [versionOf(far[kind] ?? ''), mine.find((m) => m.kind === kind)?.version];
    return there && here ? [{ kind, there, here, order: compareVersions(there, here) ?? 0 }] : [];
  });
  if (!both.length) return { value: undefined, status: 'skip', detail: 'no agent CLI to compare' };
  const apart = both.filter((b) => b.order !== 0);
  if (!apart.length) return { value: undefined, detail: `${both.map((b) => `${AGENT_LABEL[b.kind]} ${b.there}`).join(', ')}, same as ${homeWord()}` };
  const updates = (order: number) => apart.filter((b) => b.order === order).map((b) => AGENTS[b.kind].updateCommand);
  const [there, here] = [updates(-1), updates(1)];
  return {
    value: undefined, status: 'warn',
    detail: apart.map((b) => `${AGENT_LABEL[b.kind]} ${b.there} there, ${b.here} on ${homeWord()}`).join('; '),
    action: [...(there.length ? [onThere(destination, there.join(', then '))] : []), ...(here.length ? [`${homeWord() === 'this Mac' ? ON_THIS_MAC : `on ${homeWord()}, run `}${here.join(', then ')}`] : [])].join('; '),
    ...(there.length > 0 && { run: there.join(' && ') }),
  };
}

/**
 * The end-to-end probe: the companion's own private fleet has to answer over a forwarded port, from `release` when one
 * is named, before this machine counts as reachable. `anyProtocol` takes a release on another protocol than this controller's.
 */
async function endToEnd(master: SshMaster, entry: MachineEntry, { release, anyProtocol, fleetHome }: { release?: string; anyProtocol?: boolean; fleetHome?: string } = {}): Promise<Outcome<void>> {
  const { client, info, forward } = await connectForwarded(master, entry, { ...(fleetHome ? { fleetHome } : { profile: PRIVATE }), anyProtocol });
  try {
    const running = (await client.call('system.info', {})).release;
    if (release && running !== release) throw new OtherRelease(running, release);
    return { value: undefined, detail: 'answers', raw: `${entry.record.name} answers on ${fleetHome ?? `its own ${PRIVATE} fleet`}` };
  } catch (err) {
    if (err instanceof OtherRelease) throw err;
    throw new StepError('does not answer', undefined, undefined, undefined, redact((err as Error).message, [info.token]));
  } finally {
    client.close();
    await forward.cancel().catch(() => undefined);
  }
}

// a window on a server of its own, which the probe takes down again whatever happened
const TMUX_PROBE = 'sock="${TMPDIR:-/tmp}/svall-probe-$$"; tmux -S "$sock" new-session -d -s svall-probe sleep 30 && tmux -S "$sock" list-windows -t svall-probe >/dev/null; r=$?; tmux -S "$sock" kill-server 2>/dev/null; rm -f "$sock"; exit $r';

/** Add Machine's end-to-end probe: the daemon over its tunnel from `release`, this fleet there as a worker, and a tmux window on the PATH its units run with. */
async function addProbe(master: SshMaster, entry: MachineEntry, o: { home: string; release: string; asHome?: boolean }, d: HostDeps): Promise<Outcome<void>> {
  await endToEnd(master, entry, { release: o.release });
  if (!o.asHome && !servesUs(await farHome(master, entry.record.svallBase, d, entry.id), d)) {
    throw new StepError('answers, but not as a worker of this fleet', 'Add the machine again, which enrols it anew', undefined, undefined, `${entry.record.name}'s fleet home there holds no worker.json naming it`);
  }
  const r = await master.run(['env', shq(`PATH=${unitPathOf(o.home, entry.record.svallBase)}`), ...sh('svall-tmux', TMUX_PROBE)], { timeoutMs: PROBE_TIMEOUT });
  if (r.code !== 0) throw new StepError('tmux could not open a window there', undefined, undefined, undefined, `exit ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
  return { value: undefined, detail: 'answers', raw: `${entry.record.name} answers on its own ${PRIVATE} fleet, ${o.asHome ? 'as its home' : 'serves this fleet as a worker'}, and tmux opens and closes a window there` };
}

/** This fleet's profile on `machine`, as its link dials it: the one its worker there was enrolled or moved under, else its own; none for the private one. */
const profileOn = (machine: string | undefined, d: HostDeps): string | undefined => {
  const held = machine === undefined ? undefined : workerProfile(resolvePaths(d.fleet.home), machine);
  return held === undefined ? d.fleet.profile : held === PRIVATE ? undefined : held;
};

const farFlags = (profile: string | undefined): string[] => (profile ? ['-p', shq(profile)] : []);

/** This fleet's worker.json, while it names `machine` as the fleet's home; one that cannot be read leaves that unknown, so nothing is done on a guess. */
function servedHome(machine: string, d: HostDeps): WorkerFile | undefined {
  const paths = resolvePaths(d.fleet.home);
  if (!isWorker(paths)) return undefined;
  let served: WorkerFile;
  try { served = readWorkerFile(paths); } catch (e) { throw new StepError(`${paths.workerFile} cannot be read`, `fix ${paths.workerFile}`, undefined, undefined, (e as Error).message); }
  return served.homeMachineId === machine ? served : undefined;
}

/**
 * The fleet home on this account whose worker.json names `machine` as its home, read as it lies, or failing that one that cannot
 * be read, which may name it. Svall and Svall Dev share the registry, so the fleets of both count.
 */
export function dialingFleet(machine: string, homedir: string): { home: string; unreadable?: true } | undefined {
  let names: string[];
  try { names = fs.readdirSync(homedir); } catch { return undefined; }
  let unreadable: string | undefined;
  for (const home of names.filter((f) => f === '.svall' || f.startsWith('.svall-')).map((f) => path.join(homedir, f))) {
    let text: string;
    try { text = fs.readFileSync(resolvePaths(home).workerFile, 'utf8'); } catch { continue; }
    try {
      if ((JSON.parse(text) as { homeMachineId?: unknown }).homeMachineId === machine) return { home };
    } catch { unreadable ??= home; }
  }
  return unreadable === undefined ? undefined : { home: unreadable, unreadable: true };
}

// the folder of the fleet there, for the home this fleet dials: its profile there need not be the one it has here
const dialedHome = (machine: string | undefined, d: HostDeps): string | undefined => {
  const socket = machine === undefined ? undefined : servedHome(machine, d)?.homeSocket;
  return socket && fleetHomeOfSocket(socket);
};

/** How a command names this fleet there: by that folder, else by this fleet's profile. */
function farFleet(machine: string | undefined, d: HostDeps): { env: string[]; flags: string[] } {
  const home = dialedHome(machine, d);
  return home ? { env: ['env', shq(`SVALL_HOME=${home}`)], flags: [] } : { env: [], flags: farFlags(profileOn(machine, d)) };
}

/** What this fleet's fleet home there serves, as its own `svall version --json` reads it; `machine` undefined for one not listed yet. */
function farHome(master: SshMaster, svallBase: string, d: HostDeps, machine?: string): Promise<RemoteVersion> {
  const { env, flags } = farFleet(machine, d);
  return remoteJson<RemoteVersion>(master, svallBase, [...flags, 'version', '--json'], 'svall version --json', env);
}

/** Why this machine takes and removes no worker of this fleet: it is a worker of it, or it is leaving it for another machine. */
function notTheHome(d: HostDeps): StepError | undefined {
  const paths = resolvePaths(d.fleet.home);
  let home: string | undefined;
  let leaving: string | undefined;
  try {
    if (isWorker(paths)) home = readWorkerFile(paths).homeName;
    else leaving = readMarker(paths)?.toName;
  } catch (e) { return new StepError(`${homeWord()} cannot tell whether it holds this fleet`, isWorker(paths) ? `fix ${paths.workerFile}` : `fix the marker a move left in ${paths.home}`, undefined, undefined, (e as Error).message); }
  if (leaving) return new StepError(`this home is leaving for ${leaving}, and takes or removes no worker until the move ends`, `finish the move with ${svallAt(d.fleet.home, d, 'fleet home retry')}, or call it off with ${svallAt(d.fleet.home, d, 'fleet home abort')}`);
  return home === undefined ? undefined : new StepError(`this fleet's home is ${home}, and only it takes or removes a worker`, `run it on ${home}`);
}

// a worker's own fleet.json may go by an id of its own
function fleetHere(d: HostDeps): string {
  const paths = resolvePaths(d.fleet.home);
  if (isWorker(paths)) { try { return readWorkerFile(paths).fleetId; } catch { /* the config says */ } }
  return readFleet(paths.fleetConfig).id;
}

// what a run takes or removes a worker by, past the machine this fleet serves as its home
const mayActOn = (machine: string | undefined, d: HostDeps): void => {
  if (machine !== undefined && servedHome(machine, d)) return;
  const refused = notTheHome(d);
  if (refused) throw refused;
};

const servesUs = (v: RemoteVersion, d: HostDeps): boolean =>
  v.worker?.homeMachineId === d.machineId() && v.worker.fleetId === readFleet(resolvePaths(d.fleet.home).fleetConfig).id;

/** Whether the fleet home there is the home this machine's fleet serves as a worker. */
function homeOfUs(v: RemoteVersion, d: HostDeps): boolean {
  return v.role === 'home' && servedHome(v.machineId, d)?.fleetId === v.fleetId;
}

/** Why the fleet home there is not this fleet's to enrol: it serves another Mac as a worker. */
function notOurs(v: RemoteVersion, name: string, d: HostDeps): StepError | undefined {
  if (!v.worker) return undefined;
  // a worker of this fleet names the home it had until the fleet moved, and the fleet's home takes it from there
  const ours = v.worker.fleetId === fleetHere(d);
  const elsewhere = ours && !servedHome(v.machineId, d) ? notTheHome(d) : undefined;
  if (elsewhere) return elsewhere;
  if (ours || v.worker.homeMachineId === d.machineId()) return undefined;
  const home = v.worker.homeName || v.worker.homeMachineId;
  return new StepError(`${name} already serves ${home} as a worker; remove it from ${home} first`, `on ${home}, run svall host remove ${name}`);
}

// a development build's release ends in git describe's count of commits past its tag, which semver ranks below the tag
const newerRelease = (a: string, b: string): boolean => compareVersions(a.replace(/-.*/, ''), b.replace(/-.*/, '')) === 1;

/** Why the machine `ssh` reaches is not one to add as `name`: this Mac lists it under another name. */
function listedAs(d: Pick<HostDeps, 'registry' | 'fleet'>, id: string, o: { name: string; ssh: string }): StepError | undefined {
  const listed = d.registry.get(id);
  if (!listed || listed.record.name === o.name) return undefined;
  return new StepError(`${o.ssh} reaches ${listed.record.name}, a machine already in ${homeWord()}'s list`,
    `${hostCmd(d)} upgrade ${listed.record.name} sets it up again, or ${hostCmd(d)} remove ${listed.record.name} --forget and add it as ${o.name}`);
}

/**
 * Refuses, before anything is uploaded, a machine this Mac lists under another name, a fleet home there that serves
 * another Mac, or serves at all when `asHome`, and a release there newer than `version`, which installing would take
 * back; a machine whose svall does not answer has nothing to refuse yet.
 */
async function mayInstall(master: SshMaster, o: { name: string; ssh: string; svallBase: string; version: string; machine?: string; adding?: true; asHome?: boolean }, d: HostDeps): Promise<void> {
  // a home there is its private fleet
  const asked = o.asHome ? remoteJson<RemoteVersion>(master, o.svallBase, ['version', '--json'], 'svall version --json') : farHome(master, o.svallBase, d, o.machine);
  const far = await asked.catch((err: unknown) => { if (err instanceof StepError) return undefined; throw err; });
  if (!far) return;
  const refused = listedAs(d, far.machineId, o) ?? notOurs(far, o.name, d);
  if (refused) throw refused;
  if (o.asHome && far.role === 'worker') {
    const home = far.worker?.homeName ?? 'another home';
    // a worker of another Mac is refused above, so this one serves a fleet here, which a move makes its home once it is listed
    const p = d.fleet.profile ? ` -p ${d.fleet.profile}` : '';
    const listed = d.registry.get(far.machineId) ? '' : `svall${p} host add ${o.name} --ssh ${o.ssh} lists it again, then `;
    throw new StepError(`${o.name} serves ${home} as a worker, so it cannot be a home`, servesUs(far, d) ? `${listed}svall${p} fleet home set ${o.name} makes it this fleet's home` : `remove ${o.name} from the fleet it serves on ${home} first`);
  }
  if (o.adding && !o.asHome && servedHome(far.machineId, d)) throw new StepError(`${o.name} is this fleet's home, so it cannot be added as its worker`, `${hostCmd(d)} upgrade ${o.name} takes it to ${homeWord()}'s release`);
  if (newerRelease(far.release, o.version)) {
    throw new StepError(`${o.name} runs release ${far.release}, newer than ${o.version}, the one ${homeWord()} would install`, `update svall on ${homeWord()}`);
  }
}

/** Refuses a fleet home there that serves another Mac, then stops and removes the gateway unit there; `off` is what the enrol detail adds. */
async function claimUnits(master: SshMaster, o: { name: string; machine: MachineId; home: string; svallBase: string; far?: RemoteVersion }, d: HostDeps): Promise<{ far: RemoteVersion; units: string[]; off: string }> {
  const unitDir = unitDirOf(o.home);
  const units = (await probe(master, sh('svall-units', UNITS, unitDir, GATEWAY_UNIT, svalldUnitName(profileOn(o.machine, d) ?? PRIVATE)), 'the units there')).split('\n');
  const far = o.far ?? await farHome(master, o.svallBase, d, o.machine);
  const refused = notOurs(far, o.name, d);
  if (refused) throw refused;
  if (!units.includes('gateway')) return { far, units, off: '' };
  await probe(master, sh('svall-gateway-off', GATEWAY_OFF, path.posix.join(unitDir, GATEWAY_UNIT)), `systemctl --user disable --now ${GATEWAY_UNIT}`, 'the old gateway service there did not stop');
  return { far, units, off: `; ${GATEWAY_UNIT} is stopped and removed` };
}

/** The machine made a worker of this fleet: a new token here, the far `svall worker enroll` with it, which restarts the fleet there with --worker. */
async function enrol(master: SshMaster, o: { name: string; machine: MachineId; svallBase: string; off: string }, d: HostDeps): Promise<Outcome<void>> {
  const elsewhere = notTheHome(d);
  if (elsewhere) throw elsewhere;
  const paths = resolvePaths(d.fleet.home);
  const fleetId = readFleet(paths.fleetConfig).id;
  const { name: home, platform: homePlatform } = d.registry.localMachine();
  // the daemon may be enrolling it too, for a move, and one token must end up on both sides
  const unlock = await enrolLock(paths.home);
  if (!unlock) throw new StepError('this home is enrolling a worker, or moving the fleet', 'try again in a moment');
  let r: Awaited<ReturnType<SshMaster['run']>>;
  try {
    const token = issueToken(paths, o.machine);
    r = await master.run(enrollArgv({ svallBase: o.svallBase, profile: profileOn(o.machine, d), home: d.machineId(), homeName: home, fleetId, homePlatform }), { input: token, timeoutMs: ENROL_TIMEOUT });
  } finally { unlock(); }
  if (r.code !== 0) throw new StepError('did not join this fleet', undefined, undefined, undefined, `svall worker enroll exited ${r.code ?? `on ${r.signal}`}: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 400) || 'no output'}`);
  const last = r.stdout.trim().split('\n').at(-1);
  return { value: undefined, detail: 'joined this fleet', raw: `${o.name} serves this fleet as a worker of ${homeWord()}${last ? `; ${last}` : ''}${o.off}` };
}

const signedWord = (signed?: boolean): string => (signed ? 'signed' : 'unsigned');

async function companionFor(o: AddOptions, d: HostDeps, arch: string): Promise<Outcome<CompanionArchive & { allowUnsigned: boolean }>> {
  let archive = o.release;
  let from = 'the archive you named';
  let allowUnsigned = Boolean(o.allowUnsigned);
  if (!archive) {
    const platform = `linux-${arch}`;
    const asset = companionAsset(d.controller.releaseRoot, platform);
    const own = asset ? undefined : ownCompanion(d.controller.releaseRoot, platform, companionCache(d.homedir));
    if (!asset && !own) throw new StepError(noCompanion(platform));
    archive = asset ? await downloadCompanion({ ...asset, dir: companionCache(d.homedir), fetch: d.fetch }) : own!.archive;
    from = asset ? asset.url : `${homeWord()}'s own release`;
    // an unsigned development build pins the companion it was built with by digest, and that pin is
    // as trustworthy as the build the user already chose to run
    allowUnsigned ||= (asset ?? own!).unsignedBuild;
  }
  const companion = await inspectCompanion(archive, { verify: d.verify });
  requireCompatible(companion, { ...d.controller, arch, allowUnsigned });
  return { value: { ...companion, allowUnsigned }, detail: companion.version, raw: `${companion.version} for ${companion.platform} from ${from} (${signedWord(companion.signed)})` };
}

// each run's own upload and staging there, which no other run's cleanup can take
export const remotePaths = (home: string, version: string, run: string = crypto.randomUUID()) => ({
  archive: path.posix.join(home, '.cache', 'svall', `companion-${version}-${run}.tar.gz`),
  staging: path.posix.join(home, '.cache', 'svall', `staging-${version}-${run}`),
  svallBase: path.posix.join(home, '.local', 'share', 'svall'),
});

// what runs that stopped short left there over a day ago, by the names remotePaths gives; a later one may be another home's run under way
const RUN_ID = '????????-????-????-????-????????????';
const LEFTOVERS = `[ -d "$1" ] || exit 0; find "$1" -mindepth 1 -maxdepth 1 -mmin +1440 \\( -name 'companion-*-${RUN_ID}.tar.gz' -o -name 'staging-*-${RUN_ID}' \\) -exec rm -rf {} +`;

/** Uploads the companion for this run, past what earlier runs left there; a sweep that fails leaves them, and the upload goes on. */
async function upload(master: SshMaster, archive: string, remote: { archive: string }): Promise<Outcome<void>> {
  await master.run(sh('svall-sweep', LEFTOVERS, path.posix.dirname(remote.archive)), { timeoutMs: PROBE_TIMEOUT }).catch(() => undefined);
  await uploadArchive(master, { archive, remote: remote.archive });
  return { value: undefined, detail: 'done', raw: `${path.basename(archive)} -> ${remote.archive}` };
}

/** The one machine record this name may carry, and the ssh destination it is already reached at. */
function claimName(registry: MachineRegistry, o: AddOptions): Outcome<Registered | undefined> {
  const name = MachineRecord.shape.name.safeParse(o.name);
  if (!name.success) throw new StepError(`${o.name} is not a machine name: ${name.error.issues[0].message}`);
  const reserved = reservedName(o.name);
  if (reserved) throw new StepError(reserved);
  const destination = MachineRecord.shape.ssh.unwrap().safeParse(o.ssh);
  if (!destination.success) throw new StepError(`${o.ssh} is not an ssh destination`, undefined, undefined, undefined, destination.error.issues[0].message);
  const held = registry.get(o.name);
  if (held?.record.dial === 'worker') throw new StepError(`${o.name} is a worker that dials in; remove it first or add this one under another name`);
  if (held && !held.record.ssh) throw new StepError(`${o.name} is ${homeWord()}'s name; add the machine under another name`);
  if (held && held.record.ssh !== o.ssh) {
    throw new StepError(`${o.name} is already the machine at ${held.record.ssh}; remove it first or add this one under another name`);
  }
  return { value: held as Registered | undefined, detail: held ? `${o.name} is already in the registry; its probes run again` : `${o.name} at ${o.ssh}` };
}

/** What a home with no one at its ssh says of a machine it cannot log in to; the fix is that home's own key, as no key leaves the Mac. */
function noLogin(ssh: string, said: string): StepError {
  const here = homeWord();
  const raw = said || undefined;
  if (!['auth', 'host_key'].includes(classifySsh(said))) return new StepError(`${here} cannot reach ${ssh}`, `check Tailscale on both machines, then ssh ${ssh} from ${here}`, undefined, undefined, raw);
  return new StepError(`${here} cannot log in to ${ssh}`, noLoginFix(here, ssh), keyLine(ssh), undefined, raw);
}

// one add, upgrade, rollback or remove of a machine at a time, held to the run's end; the kernel lets it go with the process however it ends
function machineLock(): { take(d: Pick<HostDeps, 'registry'>, name: string): Promise<void>; free(): void } {
  let unlock: (() => void) | undefined;
  return {
    async take(d, name) {
      unlock = await hostLock(d.registry.dir, name);
      if (!unlock) throw new StepError(`${name} is being added or upgraded by another run`, 'try again once it ends');
    },
    free: () => unlock?.(),
  };
}

/** `svall host add`: the spec's Add Machine flow, from the first interactive ssh to the registry entry. */
export function addHost(o: AddOptions, d: HostDeps): Promise<HostOutcome> {
  const lock = machineLock();
  return flow(d.emit, async (run) => {
    const held = await run.step('name', async () => {
      if (!o.asHome) {
        mayActOn(d.registry.get(o.name)?.id, d);
        // a move's pause holds this lock, and refuses the add before anything is reached
        (await heldEnrol(resolvePaths(d.fleet.home)))();
      }
      const claimed = claimName(d.registry, o);
      await lock.take(d, o.name);
      return claimed;
    });
    if (o.asHome) await run.step('tailscale', () => tailnetHere(d));

    let batch = false;
    await run.step('ssh', async () => {
      const said = await d.interactiveSsh(o.ssh);
      const { code, stderr } = said;
      batch = said.batch === true;
      if (code !== 0) {
        if (batch) throw noLogin(o.ssh, stderr);
        throw new StepError(['auth', 'host_key'].includes(classifySsh(stderr)) ? `${homeWord()} cannot log in to ${o.ssh}` : `${o.ssh} is not reachable from ${homeWord()}`,
          `run ssh ${o.ssh} once in Terminal and answer its host key and login there, then add the machine again`, undefined, undefined, `ssh ${o.ssh} exited ${code}${stderr ? `: ${stderr}` : ''}`);
      }
      return { value: undefined, detail: 'logs in' };
    });

    const master = await run.step('master', async () => {
      let opened: SshMaster;
      try {
        opened = await d.openMaster(o.ssh);
      } catch (err) {
        if (batch && err instanceof SshError) throw noLogin(o.ssh, err.raw ?? err.message);
        // the login above asked its questions; every step from here logs in without a prompt
        const keychain = process.platform === 'darwin'
          ? ', keep its passphrase in the keychain with ssh-add --apple-use-keychain and add UseKeychain yes and AddKeysToAgent yes to ~/.ssh/config so ssh still finds it after a restart' : '';
        throw unreached(err, o.name, o.ssh, homeWord(), `install a key there with ssh-copy-id ${o.ssh}${keychain}, then add the machine again`);
      }
      if (held) await sameMachine(opened, held, d).catch(async (err: unknown) => { await opened.close().catch(() => undefined); throw err; });
      return { value: opened, detail: 'connected' };
    });

    try {
      const { arch } = await run.step('os', () => osProbe(master));
      const { home, user } = await run.step('home', async () => {
        const remote = await homeProbe(master);
        if (!MachineRecord.shape.home.safeParse(remote.home).success) throw new StepError(`the remote $HOME is not an absolute path: ${JSON.stringify(remote.home)}`);
        // a move swaps the home on whole path components, which a home spelled another way never matches on the way back
        const plain = path.posix.normalize(remote.home).replace(/(.)\/$/, '$1');
        if (remote.home !== plain) {
          throw new StepError(`${remote.home} is ${remote.user}'s home there, which names ${plain} another way`, `make ${plain} the account's home on ${o.ssh}, then add the machine again`);
        }
        const tooLong = socketTooLong(path.posix.join(profileHome(o.asHome ? PRIVATE : profileOn(held?.id, d) ?? PRIVATE, remote.home), 'hooks.sock'), 'linux');
        if (tooLong) {
          throw new StepError(tooLong.message, `use an account on ${o.ssh} whose home path is at most ${Buffer.byteLength(remote.home) - tooLong.over} bytes`);
        }
        return { value: remote, detail: remote.home };
      });

      await run.step('tools', async () => toolsProbe(await probe(master, sh('svall-tools', WHICH, ...TOOLS), 'command -v'), o.ssh));
      await run.step('space', async () => spaceProbe(await probe(master, sh('svall-space', 'df -Pk "$HOME"'), 'df -Pk $HOME')));
      await run.step('linger', async () => lingerProbe(await probe(master, sh('svall-linger', SELF_LINGER), 'loginctl show-user'), user, o.ssh));

      const companion = await run.step('release', async () => {
        const c = await companionFor(o, d, arch);
        await mayInstall(master, { name: o.name, ssh: o.ssh, svallBase: remotePaths(home, c.value.version).svallBase, version: c.value.version, adding: true, asHome: o.asHome, ...(held && { machine: held.id }) }, d);
        return c;
      });
      const remote = remotePaths(home, companion.version);

      await run.step('upload', () => upload(master, companion.archive, remote));
      await run.step('install', async () => {
        const out = await bootstrapSetup(master, {
          staging: remote.staging, archive: remote.archive, version: companion.version,
          allowUnsigned: !companion.signed && companion.allowUnsigned, installed: remote.svallBase,
        });
        return { value: undefined, detail: `${companion.version} installed`, raw: out.trim().split('\n').at(-1) };
      });
      await run.step('tmux', () => tmuxCheck(master, { destination: o.ssh, home, svallBase: remote.svallBase }));

      const report = await run.step('service', async () => serviceOutcome(await remoteJson<RemoteDoctor>(master, remote.svallBase, ['doctor', '--json'], 'svall doctor --json'), o.ssh));
      const machine = await run.step('identity', async () => {
        const v = await remoteJson<RemoteVersion>(master, remote.svallBase, ['version', '--json'], 'svall version --json');
        const id = MachineId.safeParse(v.machineId);
        if (!id.success) throw new StepError('svall version --json did not report a machine id');
        // a machine with no svall to ask at the master step answers only once it is installed
        if (held && id.data !== held.id) {
          throw new StepError(`${o.ssh} now reaches another machine than ${o.name}`,
            `point ${o.ssh} back at ${o.name}, or ${hostCmd(d)} remove ${o.name} --forget and add it again`, undefined, undefined, `machine ${id.data}, not ${held.id}`);
        }
        const listed = listedAs(d, id.data, o);
        if (listed) throw listed;
        d.runs?.(v.release);
        if (v.release !== companion.version) {
          throw new StepError(`${o.name} runs release ${v.release}, not ${companion.version}: its setup went back, as the daemon of ${companion.version} did not answer`,
            `ssh ${o.ssh} and read the daemon log; ${o.name} runs release ${v.release}, the one its setup went back to; then ${held ? `${hostCmd(d)} upgrade ${o.name}, or ` : ''}add the machine again`);
        }
        if (v.protocol !== d.controller.protocol) throw new StepError(`the release installed on ${o.name} cannot talk to ${homeWord()}'s`);
        return { value: id.data, detail: v.release };
      });
      if (!o.asHome) {
        await run.step('enrol', async () => {
          const { off } = await claimUnits(master, { name: o.name, machine, home, svallBase: remote.svallBase }, d);
          return enrol(master, { name: o.name, machine, svallBase: remote.svallBase, off }, d);
        });
      }

      await run.step('limits', () => limitsStep(master, {
        svallBase: remote.svallBase, ...(o.asHome ? { env: [], flags: [] } : farFleet(machine, d)), name: o.name,
        later: o.asHome ? `ssh ${o.ssh}, then svall fleet limits set` : `${hostCmd(d)} limits ${o.name}`,
      }, o));

      const versions = await agentChecks(master, { destination: o.ssh, home, svallBase: remote.svallBase, report, fleet: d.fleet.home }, run);
      await run.step('versions', async () => versionsOutcome(versions, await d.localAgents().catch((err: Error) => err), o.ssh));

      const record: MachineRecord = { name: o.name, ssh: o.ssh, platform: 'linux', arch, home, svallBase: remote.svallBase };
      await run.step('probe', () => addProbe(master, { id: machine, record }, { home, release: companion.version, ...(o.asHome && { asHome: true }) }, d));
      await run.step('registry', () => {
        if (held) d.registry.remove(held.id);
        const entry = d.registry.add(record, machine);
        d.registry.save();
        return Promise.resolve({ value: entry, detail: 'listed' });
      });
      // a home's agent setup is its own, and this fleet joins it next
      if (!o.asHome) await setupSteps(run, machine, o.name, d);
    } finally {
      await master.close().catch(() => undefined);
    }
  }).finally(lock.free);
}

/** This fleet's daemon linked to the machine, and its agent setup there as steps, a machine just linked given up to 30 s to come up and answer. */
async function setupSteps(run: Runner, machine: MachineId, name: string, d: HostDeps): Promise<void> {
  await d.refreshLinks();
  const rows = await d.setupRows(machine, 30_000).catch((e: Error) => [notChecked(e, name, d)]);
  for (const r of rows) {
    const { step, ...out } = rowStep(r);
    await run.step(step, () => Promise.resolve({ value: undefined, ...out }));
  }
}

/** `release`: the one the machine answered it runs. */
export type HostReport = { machine: string; checks: Check[]; release?: string };

function need(registry: MachineRegistry, name: string): Registered {
  const entry = registry.get(name);
  if (!entry) throw new StepError(`no machine ${name} in the registry${registry.setAside()}`);
  if (!entry.record.ssh) throw new StepError(`the machine ${name} has no ssh destination in the registry`);
  return entry as Registered;
}

type Registered = MachineEntry & { record: MachineRecord & { ssh: string } };

/**
 * Refuses a far machine that answers as another than the registry names, as an ssh alias that now leads elsewhere
 * would. One whose `svall` fails is left to the step that needs it, so a broken install can still be repaired.
 */
async function sameMachine(master: SshMaster, entry: Registered, d: Pick<HostDeps, 'fleet'>): Promise<void> {
  await identify(master, entry).catch((err: unknown) => {
    if (!(err instanceof MachineMismatch)) throw err;
    throw new StepError(`${entry.record.ssh} now reaches another machine than ${entry.record.name}`, `point ${entry.record.ssh} back at ${entry.record.name}, or ${hostCmd(d)} remove ${entry.record.name} --forget`, undefined, undefined, err.message);
  });
}

const machineOutcome = (registry: MachineRegistry, name: string): Outcome<Registered> => {
  const entry = need(registry, name);
  return { value: entry, detail: `${entry.record.name} at ${entry.record.ssh}` };
};

// a worker that dials in is removed here alone, so it needs no ssh destination
const removable = (name: string, d: HostDeps): Outcome<MachineEntry> => {
  const entry = d.registry.get(name);
  // without its record a fleet cannot upgrade or check the home it serves, and the far uninstall would stop that home and its robots
  if (entry && servedHome(entry.id, d)) throw new StepError(`${name} is this fleet's home, so it stays listed here`, `bring the fleet back here first: svall${d.fleet.profile ? ` -p ${d.fleet.profile}` : ''} fleet home set local`);
  const dialing = entry && dialingFleet(entry.id, d.homedir);
  if (dialing?.unreadable) throw new StepError(`cannot read ${resolvePaths(dialing.home).workerFile}, which may name ${name}`, 'fix it');
  if (dialing && dialing.home !== d.fleet.home) throw new StepError(`${name} is the home of the fleet in ${dialing.home}, so it stays listed here and keeps running`, `bring the fleet in ${dialing.home} back here first: SVALL_HOME=${dialing.home} svall fleet home set local`);
  return entry?.record.dial === 'worker' ? { value: entry, detail: `${name} dials in` } : machineOutcome(d.registry, name);
};

// a step's own words for what stopped a check, or that it could not be made, with what was said behind
const failed = (name: string, err: unknown): Check => (err instanceof StepError
  ? { name, status: 'fail', detail: err.detail, ...(err.action && { action: err.action }), ...(err.run && { run: err.run }), ...(err.raw && { raw: err.raw }) }
  : { name, status: 'fail', detail: 'could not be checked', raw: (err as Error).message });

/** Whether a machine on `release` runs this Mac's, as a development build takes any release for its own. */
export const sameRelease = (release: string, controller: Pick<HostDeps['controller'], 'release'>): boolean => controller.release === 'dev' || release === controller.release;

/** Why the re-enrol owed the machine has not landed, once a try that ended after `since` says, or JOIN_MS passes; undefined once none is owed. */
async function joinSettled(machine: MachineId, d: Pick<HostDeps, 'joining'>, since: number): Promise<string | undefined> {
  const until = since + JOIN_MS;
  for (;;) {
    const owed = await d.joining(machine);
    if (!owed || (owed.tried ?? 0) >= since || Date.now() >= until) return owed?.why;
    await new Promise((r) => setTimeout(r, JOIN_POLL_MS));
  }
}

/** `svall host doctor`: the companion's own doctor plus what only the controller can check, each emitted as a step once found. */
export async function doctorHost(name: string, d: HostDeps): Promise<HostReport> {
  const entry = need(d.registry, name);
  const since = Date.now();
  // a link that is down is retried now, so the rows read last find it up if the machine answers
  await d.refreshLinks();
  const start = (step: string) => d.emit({ step, status: 'start' });
  const checks: Check[] = [];
  const found = (...cs: Check[]) => { checks.push(...cs); for (const { name: step, ...c } of cs) d.emit({ step, ...c }); };
  start('master');
  let master: SshMaster;
  try {
    master = await d.openMaster(entry.record.ssh);
  } catch (err) {
    // a report all the same, so a run relayed for a Mac ends on this row rather than on its exit
    const e = noLogin(entry.record.ssh, (err as SshError).raw ?? (err as Error).message);
    found({ name: 'master', status: 'fail', detail: e.detail, ...(e.action && { action: e.action }), ...(e.run && { run: e.run }), ...(e.raw && { raw: e.raw }) });
    return { machine: entry.record.name, checks };
  }
  d.emit({ step: 'master', status: 'ok', detail: 'connected' });
  let release: string | undefined;
  // the fleet's home takes none of this fleet's agent setup
  let home = false;
  try {
    const base = entry.record.svallBase;
    let report: RemoteDoctor | undefined;
    start('doctor');
    // the refresh sets off a re-enrol owed to the machine, which restarts its fleet there: the rows read what it leaves
    const joining = await joinSettled(entry.id, d, since);
    try {
      const { env, flags } = farFleet(entry.id, d);
      report = await remoteJson<RemoteDoctor>(master, base, [...flags, 'doctor', '--json'], 'svall doctor --json', env);
      d.emit({ step: 'doctor', status: 'ok', detail: 'answered' });
      found(...report.checks.map(farRow));
    } catch (err) { found(failed('doctor', err)); }
    start('release');
    try {
      const v = await farHome(master, base, d, entry.id);
      release = v.release;
      const same = sameRelease(v.release, d.controller);
      const talks = v.protocol === d.controller.protocol;
      // an upgrade there would go back to this Mac's older release
      const newer = !same && newerRelease(v.release, d.controller.release);
      found({
        name: 'release', status: same && talks ? 'ok' : 'fail',
        detail: same && talks ? `${v.release}, same as ${homeWord()}`
          : same ? `${v.release} there, a build that cannot talk to ${homeWord()}'s` : `${v.release} there, ${d.controller.release} on ${homeWord()}`,
        ...(!(same && talks) && { action: newer ? `update svall on ${homeWord()}` : `${hostCmd(d)} upgrade ${entry.record.name}` }),
      });
      const refused = notOurs(v, entry.record.name, d);
      home = homeOfUs(v, d);
      found(home ? { name: 'worker', status: 'ok', detail: 'home of this fleet' }
        : refused ? { name: 'worker', status: 'fail', detail: refused.detail, action: refused.action }
          : servesUs(v, d) ? { name: 'worker', status: 'ok', detail: 'worker of this fleet' }
            : joining !== undefined ? { name: 'worker', status: 'warn', detail: 'has not joined yet', ...(joining && { raw: joining }) }
              : { name: 'worker', status: 'fail', detail: "does not run this fleet's robots yet", action: `${hostCmd(d)} upgrade ${entry.record.name} sets it up` });
    } catch (err) { found(failed('release', err)); }
    start('versions');
    try {
      const far = await farVersions(agentCall(master, { home: entry.record.home, svallBase: base, report }));
      found({ name: 'versions', ...pick(versionsOutcome(far, await d.localAgents().catch((err: Error) => err), entry.record.ssh)) });
    } catch (err) { found(failed('versions', err)); }
    start('space');
    try {
      found({ name: 'space', ...pick(spaceProbe(await probe(master, sh('svall-space', 'df -Pk "$HOME"'), 'df -Pk $HOME'))) });
    } catch (err) { found(failed('space', err)); }
    let far: { home: string; user: string } | undefined;
    start('home');
    try {
      far = await homeProbe(master);
      const n = entry.record.name;
      found(far.home !== entry.record.home ? { name: 'home', status: 'fail', detail: `${far.home} there, ${entry.record.home} in the list of machines`, action: `${hostCmd(d)} remove ${n}, then ${hostCmd(d)} add again` }
        : { name: 'home', status: 'ok', detail: far.home });
    } catch (err) { found(failed('home', err)); }
    if (far && !checks.some((c) => c.name === 'linger')) {
      start('linger');
      try {
        const out = await probe(master, sh('svall-linger', LINGER), 'loginctl show-user');
        found({ name: 'linger', ...pick(lingerProbe(out, far.user, entry.record.ssh)) });
      } catch (err) { found(failed('linger', err)); }
    }
  } finally {
    await master.close().catch(() => undefined);
  }
  if (!home) {
    const rows = await d.setupRows(entry.id, 0).catch((e: Error) => [notChecked(e, entry.record.name, d)]);
    found(...rows.map(rowCheck));
  }
  return { machine: entry.record.name, checks, ...(release && { release }) };
}

/** A setup row as a host command's step, and as a check that keeps its action apart. */
export const rowStep = ({ key, ...row }: SetupRow): StepEvent => ({ step: `mirror:${key}`, ...row });
export const rowCheck = ({ key, ...row }: SetupRow): Check => ({ name: `mirror:${key}`, ...row });

/** The one row a command makes of a daemon it could not ask for the rows; its action asks that fleet's daemon again. */
const notChecked = (e: Error, name: string, d: HostDeps): SetupRow => ({
  key: 'unchecked', status: 'warn', detail: 'not checked', raw: e.message, action: `${svallAt(d.fleet.home, d, `host doctor ${name}`)} once Svall is open`,
  gap: { name: 'agent setup', what: 'not checked' },
});

const pick = (o: Outcome<unknown>): Omit<Check, 'name'> =>
  ({ status: (o.status ?? 'ok') as Check['status'], detail: o.detail ?? '', ...(o.action && { action: o.action }), ...(o.run && { run: o.run }), ...(o.raw && { raw: o.raw }) });

const rollbackTo = (name: string, d: Pick<HostDeps, 'fleet'>): string => `${hostCmd(d)} upgrade ${name} --rollback <release> puts back a release kept there`;
// what a rollback that went wrong leaves a person: the check that says why, and the long way behind it
const seeWhy = (name: string, d: Pick<HostDeps, 'fleet'>): string => `see why: ${hostCmd(d)} doctor ${name}`;
// what an upgrade or rollback did that its probe fails, and why it says so, as one line a person reads
const thrown = (err: unknown): string => (err instanceof StepError ? err.raw ?? err.detail : inFull(err));
// a probe that found the daemon on another release says which; any other failure, that it does not answer, with why behind
const unanswered = (err: unknown): { detail: string; raw?: string } => (err instanceof OtherRelease ? { detail: err.detail } : { detail: 'does not answer', raw: thrown(err) });

/** The one master an upgrade or a rollback rides on, to the machine the registry names. */
async function checkedMaster(d: HostDeps, entry: Registered): Promise<Outcome<SshMaster>> {
  const opened = await d.openMaster(entry.record.ssh).catch((err: unknown) => { throw unreached(err, entry.record.name, entry.record.ssh, homeWord()); });
  await sameMachine(opened, entry, d).catch(async (err: unknown) => { await opened.close().catch(() => undefined); throw err; });
  return { value: opened, detail: 'connected' };
}

// $1 units folder, $2 gateway unit, $3 fleet unit: which units are there, and whether the fleet's runs as a worker
const UNITS = '[ -f "$1/$2" ] && echo gateway; if [ -f "$1/$3" ]; then if grep -q -- --worker "$1/$3"; then echo worker; else echo plain; fi; fi; exit 0';
// $1 the gateway's unit file
const GATEWAY_OFF = 'systemctl --user disable --now "$(basename "$1")" && rm -f "$1" && systemctl --user daemon-reload';

/**
 * `svall host upgrade`: the new release installed by its own setup, as the old one's may not speak its protocol, then a
 * probe that puts the old one back if it does not answer; a machine not yet this fleet's worker then becomes one.
 */
export function upgradeHost(asked: string, o: { release?: string; allowUnsigned?: boolean }, d: HostDeps): Promise<HostOutcome> {
  const lock = machineLock();
  return flow(d.emit, async (run) => {
    const entry = await run.step('machine', async () => {
      const out = machineOutcome(d.registry, asked);
      mayActOn(out.value.id, d);
      await lock.take(d, out.value.record.name);
      return out;
    });
    const name = entry.record.name;
    const fleetHome = dialedHome(entry.id, d);
    const master = await run.step('master', () => checkedMaster(d, entry));
    try {
      // a machine added on an older Ubuntu than this release runs on stays on its release
      await run.step('os', () => osProbe(master));
      const companion = await run.step('release', async () => {
        const c = await companionFor({ name, ssh: entry.record.ssh, ...o }, d, entry.record.arch);
        await mayInstall(master, { name, ssh: entry.record.ssh, svallBase: entry.record.svallBase, version: c.value.version, machine: entry.id }, d);
        return c;
      });
      const remote = remotePaths(entry.record.home, companion.version);
      await run.step('upload', () => upload(master, companion.archive, remote));
      const before = await run.step('install', async () => {
        const was = await currentRelease(master, entry.record.svallBase);
        const out = await bootstrapSetup(master, {
          staging: remote.staging, archive: remote.archive, version: companion.version,
          allowUnsigned: !companion.signed && companion.allowUnsigned, installed: entry.record.svallBase,
        });
        return { value: was, detail: `${companion.version} installed`, raw: out.trim().split('\n').at(-1) };
      });

      // the release a daemon that did not take the new one still answers from
      let answering: string | undefined;
      const probed = await run.step('probe', async () => {
        try {
          const { env } = farFleet(entry.id, d);
          serviceOutcome(await remoteJson<RemoteDoctor>(master, entry.record.svallBase, ['doctor', '--json'], 'svall doctor --json', env), entry.record.ssh);
          await endToEnd(master, entry, { release: companion.version, ...(fleetHome && { fleetHome }) });
          return { value: true, detail: 'answers' };
        } catch (err) {
          if (err instanceof OtherRelease) answering = err.running;
          return { value: false, status: 'warn' as const, ...unanswered(err), action: seeWhy(name, d) };
        }
      });
      if (probed) {
        d.runs?.(companion.version);
        if (await becomeWorker(master, entry, run, d)) await setupSteps(run, entry.id, name, d);
        return;
      }
      await run.step('rollback', async () => {
        // a reinstall under the name it ran replaced that tree, so it goes back to whichever release is kept
        const replaced = before === companion.version;
        // a far setup whose daemon did not answer has gone back already, and that release is restarted and probed again
        const back = await currentRelease(master, entry.record.svallBase);
        const to = back !== companion.version ? back : replaced ? undefined : before;
        const out = await remoteRollback(master, { svallBase: entry.record.svallBase, from: companion.version, ...(to !== undefined && { to }) }).catch((err: Error) => err);
        const now = await currentRelease(master, entry.record.svallBase);
        d.runs?.(now);
        // only the release before, put back, is a rollback that did what it was for
        const putBack = !replaced && now === before;
        // a daemon that answered from another release than the one set is asked again, after the rollback, which one it answers from
        let silent: string | undefined;
        const after = answering && await endToEnd(master, entry, { release: now, anyProtocol: true, ...(fleetHome && { fleetHome }) })
          .then(() => now, (err: unknown) => {
            if (err instanceof OtherRelease) return err.running;
            silent = thrown(err);
            return undefined;
          });
        // one release set and another answering is said once, as both
        const runs = silent !== undefined ? `on ${now}, which does not answer`
          : after && after !== now ? `set to ${now}, still answering from ${after}`
          : putBack ? `back on ${now}` : !replaced ? `on ${now}; ${before} could not be put back`
          : now === before ? `stays on ${now}: no earlier release is kept there` : `on ${now}, the newest release kept there`;
        const long = `ssh ${entry.record.ssh} and read the service's log; ${rollbackTo(name, d)}`;
        if (out instanceof Error) throw new StepError(runs, seeWhy(name, d), undefined, undefined, [inFull(out), silent, long].filter(Boolean).join('\n'));
        return {
          value: undefined, status: putBack && silent === undefined && !(after && after !== now) ? 'ok' as const : 'warn' as const,
          detail: runs, action: seeWhy(name, d), raw: [silent, out.trim(), long].filter(Boolean).join('\n'),
        };
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  }).finally(lock.free);
}

/**
 * The far machine as this fleet's worker: the gateway unit an older release left there stopped and removed, and the
 * machine enrolled where it is not one. The fleet's home stays the home, its daemon restarted by the install; false for it.
 */
async function becomeWorker(master: SshMaster, entry: Registered, run: Runner, d: HostDeps): Promise<boolean> {
  const name = entry.record.name;
  return run.step('enrol', async () => {
    const far = await farHome(master, entry.record.svallBase, d, entry.id);
    if (servedHome(entry.id, d)) {
      if (homeOfUs(far, d)) return { value: false, status: 'skip' as const, detail: `${name} is this fleet's home, and its daemon runs the new release as the home` };
      throw new StepError(`${name} is this fleet's home, and its fleet home there answers as another, so it is not enrolled`);
    }
    const { units, off } = await claimUnits(master, { name, machine: entry.id, home: entry.record.home, svallBase: entry.record.svallBase, far }, d);
    if (units.includes('worker') && servesUs(far, d)) return { value: true, status: off ? 'ok' as const : 'skip' as const, detail: `${name} serves this fleet as a worker${off}` };
    return { ...await enrol(master, { name, machine: entry.id, svallBase: entry.record.svallBase, off }, d), value: true };
  });
}

/**
 * `svall host upgrade --rollback`: the far machine back on the release `to`, or on the one before, by its own `svall`,
 * which checks each fleet's daemon answers from it, then the probe an upgrade makes.
 */
export function rollbackHost(name: string, o: { to?: string }, d: HostDeps): Promise<HostOutcome> {
  const lock = machineLock();
  return flow(d.emit, async (run) => {
    const entry = await run.step('machine', async () => {
      const out = machineOutcome(d.registry, name);
      servedHome(out.value.id, d);
      await lock.take(d, out.value.record.name);
      return out;
    });
    const fleetHome = dialedHome(entry.id, d);
    const master = await run.step('master', () => checkedMaster(d, entry));
    const base = entry.record.svallBase;
    const long = (now: string): string => `ssh ${entry.record.ssh} and read the service's log; ${name} runs release ${now}; ${rollbackTo(name, d)}`;
    try {
      const now = await run.step('rollback', async () => {
        const from = await currentRelease(master, base);
        const refused = await rollbackRefusal(master, { svallBase: base, home: entry.record.home, from, ...(o.to !== undefined && { to: o.to }) });
        if (refused) throw new StepError(`${refused.reason}; stays on ${from}`, undefined, undefined, undefined, refused.raw);
        const out = await remoteRollback(master, { svallBase: base, from, ...(o.to !== undefined && { to: o.to }) })
          .catch(async (err: Error) => {
            const now = await currentRelease(master, base);
            d.runs?.(now);
            throw new StepError(`still on ${now}`, seeWhy(name, d), undefined, undefined, `${inFull(err)}\n${long(now)}`);
          });
        const now = await currentRelease(master, base);
        return { value: now, detail: `back on ${now}`, raw: out.trim() };
      });
      d.runs?.(now);
      await run.step('probe', async () => {
        try {
          serviceOutcome(await remoteJson<RemoteDoctor>(master, base, ['doctor', '--json'], 'svall doctor --json', farFleet(entry.id, d).env), entry.record.ssh);
          // the release gone back to may speak an older protocol than this controller, and its system.info still names it
          await endToEnd(master, entry, { release: now, anyProtocol: true, ...(fleetHome && { fleetHome }) });
        } catch (err) {
          const said = unanswered(err);
          throw new StepError(said.detail, seeWhy(name, d), undefined, undefined, [said.raw, long(now)].filter(Boolean).join('\n'));
        }
        return { value: undefined, detail: 'answers' };
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  }).finally(lock.free);
}

/** The fleet homes on this Mac, the private one and every named profile's. */
function fleetHomes(homedir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(homedir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f === '.svall' || (f.startsWith('.svall-') && isFleetName(f.slice('.svall-'.length))))
    .map((f) => path.join(homedir, f))
    .filter((home) => fs.existsSync(resolvePaths(home).fleetConfig));
}

/** `svall <args>` for the fleet at `home`: by its -p, or by its folder for a home named for a command svall keeps. */
function svallFor(home: string, homedir: string, args: string): string {
  const profile = profileOf(home, homedir);
  if (profile !== PRIVATE && !isProfileName(profile)) return `SVALL_HOME=${shq(home)} svall ${args}`;
  return `svall ${profile === PRIVATE ? '' : `-p ${profile} `}${args}`;
}

// a host command for this run's fleet, by the -p it was run with
const hostCmd = (d: Pick<HostDeps, 'fleet'>): string => `svall ${d.fleet.profile ? `-p ${d.fleet.profile} ` : ''}host`;

// this run's fleet by the -p it was run with, any other by its home
const svallAt = (home: string, d: HostDeps, args: string): string =>
  (home === d.fleet.home ? `svall ${d.fleet.profile ? `-p ${d.fleet.profile} ` : ''}${args}` : svallFor(home, d.homedir, args));

/** Refuses while a robot of a fleet here runs on the machine or is moving to it, which an uninstall there would strand. */
function placedOn(entry: MachineEntry, d: HostDeps): void {
  const homes = [d.fleet.home, ...fleetHomes(d.homedir).filter((home) => home !== d.fleet.home)];
  const found = homes.flatMap((home) => {
    const file = resolvePaths(home).state;
    if (!fs.existsSync(file)) return [];
    let state: FleetState;
    try { state = migrateState(JSON.parse(fs.readFileSync(file, 'utf8'))).state; } catch (err) {
      throw new StepError(`${file} cannot be read (${(err as Error).message}); start this fleet's daemon first, which reads it or sets it aside`);
    }
    return Object.values(state.robots).filter((r) => r.machine === entry.id || r.moving?.to === entry.id).map((r) => ({ home, robot: r }));
  });
  if (!found.length) return;
  const n = found.length;
  const action = [...new Set(found.map((f) => f.home))].map((home) => {
    const there = found.filter((f) => f.home === home);
    return there.length === 1 ? svallAt(home, d, `robot move ${there[0].robot.id} --machine local`) : `${svallAt(home, d, 'robot move <id> --machine local')} for each`;
  }).join('; ');
  throw new StepError(`${n} ${n === 1 ? 'robot is' : 'robots are'} on ${entry.record.name}: ${found.map((f) => f.robot.name).join(', ')}; move ${n === 1 ? 'it' : 'them'} back first`, action);
}

/**
 * `svall host consent`: ticks one setting of the machine's mirror, `fields` of it or every one its setup row names, or
 * unticks every field of it.
 */
export async function consentHost(name: string, o: { item: string; on: boolean; fields?: string[] }, d: HostDeps): Promise<SetupRow[]> {
  const entry = need(d.registry, name);
  if (o.fields && !o.on) throw new StepError('off takes every key of the item; drop --field');
  const listed = (await d.setupRows(entry.id, 0)).find((r) => r.tick?.item === o.item)?.tick?.fields;
  if (!listed) throw new StepError(`${name} has no agent setup item ${o.item}; ${hostCmd(d)} doctor ${name} --all lists them`);
  const unknown = (o.fields ?? []).filter((f) => !listed.includes(f));
  if (unknown.length) throw new StepError(`${o.item} has no key ${unknown.join(', ')}; ${hostCmd(d)} doctor ${name} --all lists its keys`);
  return d.consent(entry.id, o.item, o.fields ?? listed, o.on);
}

// a line of the far uninstall that says what it did with the keys the mirror or the phone link copied there, and one that leaves some there
const TAKE_BACK = /(the mirror|Svall) copied|the mirror's keys|copies? of the agent setup left|mirror blobs? left|the phone keys/;
const KEYS_LEFT = /^(could not|left) /;

// $1 the far home: each fleet home's worker.json there on a line of its own, after the home's folder and a tab
const WORKERS = `cd "$1" || exit 1
for f in .svall/worker.json .svall-*/worker.json; do
  [ -e "$f" ] || continue
  printf '%s\\t' "\${f%/worker.json}"; tr '\\n' ' ' < "$f" || exit 1; echo
done
exit 0`;

const ServedBy = WorkerFile.pick({ homeMachineId: true, homeName: true, fleetId: true });

/** Refuses the far uninstall, which stops every fleet there, while a fleet home there serves another Mac or one cannot be read. */
async function sharedWith(master: SshMaster, entry: Registered, d: HostDeps): Promise<void> {
  const { name, ssh, home } = entry.record;
  const forget = `forget it here with ${hostCmd(d)} remove ${name} --forget, or uninstall there once nothing else uses it: ${onThere(ssh, 'svall uninstall')}`;
  const unread = (why: string) => new StepError(`cannot tell whether ${name} runs another fleet; uninstalling stops every fleet there`, forget, undefined, undefined, why);
  const out = await probe(master, sh('svall-workers', WORKERS, home), 'the worker.json files there').catch((err: unknown) => { throw unread(thrown(err)); });
  const others = new Set<string>();
  const here = fleetHere(d);
  const elsewhere = notTheHome(d);
  for (const line of out.split('\n').filter(Boolean)) {
    const at = line.indexOf('\t');
    let worker: Pick<WorkerFile, 'homeMachineId' | 'homeName' | 'fleetId'>;
    // the file holds that fleet's token, so what fails to parse is never quoted
    try { worker = ServedBy.parse(JSON.parse(line.slice(at + 1))); } catch { throw unread(`${path.posix.join(home, line.slice(0, at), 'worker.json')} cannot be read`); }
    if (worker.fleetId === here && elsewhere) throw elsewhere;
    if (worker.homeMachineId !== d.machineId() && worker.fleetId !== here) others.add(worker.homeName || worker.homeMachineId);
  }
  if (others.size) {
    throw new StepError(`${name} also runs robots for ${[...others].join(' and ')}; uninstalling stops them too`, forget);
  }
}

// a move's re-enrol sends the token under this lock, so one taken back here cannot arrive there afterwards
async function heldEnrol(paths: ReturnType<typeof resolvePaths>): Promise<() => void> {
  const unlock = fs.existsSync(paths.home) ? await enrolLock(paths.home) : () => undefined;
  if (!unlock) throw new StepError('this home is enrolling a worker, or moving the fleet', 'try again in a moment');
  return unlock;
}

const dropHeld = (paths: ReturnType<typeof resolvePaths>, machine: MachineId): void => {
  try { dropToken(paths, machine); } catch { /* a fleet whose workers.json cannot be read links nothing by it */ }
};

/**
 * `svall host remove`: the remote uninstall first, and the route only after it, or only on --forget; then what the
 * uninstall did with the keys the mirror copied there.
 */
export function removeHost(name: string, o: { forget?: boolean }, d: HostDeps): Promise<HostOutcome> {
  // held from before anything there changes until its token is gone
  let unlock: (() => void) | undefined;
  const lock = machineLock();
  return flow(d.emit, async (run) => {
    const entry = await run.step('machine', async () => {
      const out = removable(name, d);
      if (!o.forget) placedOn(out.value, d);
      await lock.take(d, out.value.record.name);
      unlock = await heldEnrol(resolvePaths(d.fleet.home));
      return out;
    });
    const { ssh } = entry.record;
    // never --purge from here: the fleets and their tmux servers are the far machine's to delete
    const uninstalled = await run.step('uninstall', async () => {
      if (!ssh) return { value: undefined, status: 'skip' as const, detail: `not reached from here; run svall uninstall on ${name} to remove Svall` };
      if (o.forget) return { value: undefined, status: 'skip' as const, detail: `left as it is; Svall stays on ${name}` };
      let master: SshMaster | undefined;
      try {
        master = await d.openMaster(ssh);
        const reached = entry as Registered;
        await sameMachine(master, reached, d);
        await sharedWith(master, reached, d);
        const r = await master.run([shq(svallExe(entry.record.svallBase)), 'uninstall'], { timeoutMs: PROBE_TIMEOUT });
        if (r.code !== 0) {
          throw new StepError('stopped with an error', `${onThere(ssh, 'svall uninstall')} and see what stops it; ${hostCmd(d)} remove ${name} --forget drops the route and leaves the machine as it is`,
            undefined, undefined, `svall uninstall exited ${r.code} on ${ssh}: ${r.stderr.trim().slice(0, 400) || 'no output'}`);
        }
        // its last line can name a command for that machine, such as the rm -rf of the fleets it kept
        const lines = r.stdout.trim().split('\n');
        return { value: lines.filter((l) => TAKE_BACK.test(l)), detail: 'Svall removed', ...(lines.at(-1) && { raw: lines.at(-1) }) };
      } catch (err) {
        if (err instanceof StepError) throw err;
        throw new StepError(`${name} is not reachable`, `${hostCmd(d)} remove ${name} --forget drops it from the list and leaves it as it is`, undefined, undefined, inFull(err));
      } finally {
        await master?.close().catch(() => undefined);
      }
    });
    await run.step('registry', async () => {
      const homes = [...new Set([d.fleet.home, ...fleetHomes(d.homedir)])];
      // nothing there ends the link of a worker that dials in, so its token goes in every fleet, and with it the link; one this
      // fleet dials keeps no profile for a later add, and a sibling that dials it too keeps its own, which that add would not renew
      const dropped = homes.filter((home) => !ssh || home === d.fleet.home);
      // every sibling's lock before any token goes, so a refusal leaves every token as it was
      const siblings: (() => void)[] = [];
      try {
        for (const home of dropped) if (home !== d.fleet.home) siblings.push(await heldEnrol(resolvePaths(home)));
        for (const home of homes) clearConsent(resolvePaths(home).mirrorConsent, entry.id);
        for (const home of dropped) dropHeld(resolvePaths(home), entry.id);
      } finally { for (const let_go of siblings) let_go(); }
      d.registry.remove(entry.id);
      d.registry.save();
      if (!ssh) await d.refreshLinks();
      return ({ value: undefined, detail: uninstalled ? 'no longer listed' : 'forgotten; left as it is' });
    });
    if (!uninstalled?.length) return;
    const left = uninstalled.filter((l) => KEYS_LEFT.test(l)).length;
    const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
    await run.step('keys', () => Promise.resolve({
      value: undefined, raw: uninstalled.join('\n'),
      ...(left ? { status: 'warn' as const, detail: `copied keys left in ${files(left)}`, action: onThere(ssh!, 'remove them by hand') } : { detail: `copied keys removed from ${files(uninstalled.length)}` }),
    }));
  }).finally(() => { unlock?.(); lock.free(); });
}

function readFleet(file: string): FleetConfig {
  try {
    return readFleetConfig({ fleetConfig: file });
  } catch (err) {
    throw new StepError(`${file} is not a fleet config: ${(err as Error).message}`);
  }
}
