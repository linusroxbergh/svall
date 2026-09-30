import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FleetConfig, FleetId, MachineId, MachineRecord } from '@svall/protocol';
import { AGENTS, AGENT_KINDS, versionOk } from '@svall/svalld/agents';
import { patchFleetConfig } from '@svall/svalld/config';
import { gatewayPaths, socketTooLong } from '@svall/svalld/gateway/authority';
import { homeCommands } from '@svall/svalld/handover/inventory';
import { unitPath } from '@svall/svalld/linux/setup';
import { isProfileName, PRIVATE, profileOf } from '@svall/svalld/profile';
import { resolvePaths } from '@svall/svalld/paths';
import { svallExe } from '@svall/svalld/release';
import { releaseRuntime } from '@svall/svalld/runtime';
import { tmuxTooOld } from '@svall/svalld/tmux/conf';
import { shq } from '@svall/svalld/text';
import type { Verify } from '../../../../scripts/release-manifest.mjs';
import { Client } from '../client.js';
import type { Check } from '../checks-view.js';
import { remoteOwner } from './authority.js';
import { identify, MachineMismatch, remoteConnectionInfo } from './connection.js';
import {
  bootstrapSetup, companionAsset, companionCache, currentRelease, downloadCompanion, inspectCompanion,
  remoteRollback, requireCompatible, uploadArchive, type CompanionArchive, type FetchLike,
} from './install.js';
import { redact } from './process.js';
import { MIN_RSYNC, rsyncVersion } from './rsync.js';
import { MachineRegistry, type MachineEntry } from './registry.js';
import { fileStore } from './recovery.js';
import { cachedOwner, readRoute } from './route.js';
import type { SshMaster } from './ssh.js';

const PROBE_TIMEOUT = 30_000;
// a fleet made or taken over there waits on systemd to stop and start its daemon
const PROVISION_TIMEOUT = 120_000;
const FREE_FLOOR_KB = 5 * 1024 * 1024;

export type StepStatus = 'start' | 'ok' | 'warn' | 'fail' | 'skip';
export type StepEvent = { step: string; status: StepStatus; detail?: string; action?: string };
export type HostOutcome = { result: 'ready' | 'actions'; actions: string[] };

export type HostDeps = {
  emit(event: StepEvent): void;
  registry: MachineRegistry;
  openMaster(destination: string): Promise<SshMaster>;
  /** one ssh the user can answer: a new host key, a passphrase, a password */
  interactiveSsh(destination: string): Promise<number>;
  fetch: FetchLike;
  controller: { release: string; protocol: number; releaseRoot: string };
  /** this Mac's own id: the owner a fleet's first authority record names */
  machineId(): MachineId;
  homedir: string;
  /** checks a release's signature against the signers this controller ships */
  verify: Verify;
};

export type AddOptions = { name: string; ssh: string; release?: string; allowUnsigned?: boolean };

/** A step that could not finish, with the one thing the user can do about it. */
class StepError extends Error {
  constructor(readonly detail: string, readonly action?: string) { super(detail); }
}

type Outcome<T> = { value: T; status?: StepStatus; detail?: string; action?: string };

/** The step events a host command emits, and the actions they leave the user with. */
class Runner {
  readonly actions: string[] = [];
  private failed = false;

  constructor(private readonly emit: (e: StepEvent) => void) {}

  // two steps can find the same thing to do, as lingering is both its own step and the service's
  private todo(action: string): void {
    if (!this.actions.includes(action)) this.actions.push(action);
  }

  async step<T>(step: string, fn: () => Promise<Outcome<T>>): Promise<T> {
    this.emit({ step, status: 'start' });
    let r: Outcome<T>;
    try {
      r = await fn();
    } catch (err) {
      const e = err instanceof StepError ? err : new StepError((err as Error).message);
      this.failed = true;
      this.todo(e.action ?? e.detail);
      this.emit({ step, status: 'fail', detail: e.detail, ...(e.action ? { action: e.action } : {}) });
      throw e;
    }
    if (r.action) this.todo(r.action);
    this.emit({
      step, status: r.status ?? 'ok',
      ...(r.detail ? { detail: r.detail } : {}), ...(r.action ? { action: r.action } : {}),
    });
    return r.value;
  }

  outcome(): HostOutcome {
    return { result: this.failed || this.actions.length ? 'actions' : 'ready', actions: this.actions };
  }
}

/** Runs a flow to its end or to its first blocker, and reports what the user is left holding. */
async function flow(emit: (e: StepEvent) => void, fn: (run: Runner) => Promise<void>): Promise<HostOutcome> {
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
const TOOLS = ['tailscale', 'tmux', 'git', 'rsync', 'systemctl', 'loginctl'];
const APT: Record<string, string> = { tmux: 'tmux', git: 'git', rsync: 'rsync' };
const ARCHES: Record<string, string> = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' };

async function probe(master: SshMaster, argv: string[], what: string): Promise<string> {
  const r = await master.run(argv, { timeoutMs: PROBE_TIMEOUT });
  if (r.code !== 0) throw new StepError(`${what} exited ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
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
  const release = `Ubuntu ${versionId} ${arch}`;
  return isLts(versionId)
    ? { value: { arch }, detail: `${release} (LTS)` }
    : { value: { arch }, status: 'warn', detail: `${release} is not an LTS release; the companion is tested on the LTS releases` };
}

// nothing here is ever run: an action names the machine to run it on, and the user runs it
const onThere = (destination: string, how: string): string => `ssh ${destination}, then ${how}`;

function toolsProbe(out: string, destination: string): Outcome<void> {
  const found = new Map(out.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/) as [string, string]));
  const missing = TOOLS.filter((t) => found.get(t) !== 'yes');
  if (!missing.length) return { value: undefined, detail: TOOLS.join(', ') };
  const packages = missing.filter((t) => APT[t]).map((t) => APT[t]);
  if (missing.some((t) => t === 'systemctl' || t === 'loginctl')) {
    throw new StepError(`${missing.join(', ')} missing: this machine has no systemd user services, which the companion needs`);
  }
  if (packages.length) throw new StepError(`${missing.join(', ')} missing`, onThere(destination, `sudo apt install ${packages.join(' ')}`));
  throw new StepError(`${missing.join(', ')} missing`, onThere(destination, 'install Tailscale from https://tailscale.com/download/linux'));
}

function spaceProbe(df: string): Outcome<number> {
  const row = df.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const free = Number(row[3]);
  if (!Number.isFinite(free)) throw new StepError(`df did not report the free space on the remote home: ${df.trim().slice(0, 120)}`);
  const gib = (free / (1024 * 1024)).toFixed(1);
  return free < FREE_FLOOR_KB
    ? { value: free, status: 'warn', detail: `${gib} GiB free on the remote home; a release and its replicas want more room` }
    : { value: free, detail: `${gib} GiB free on the remote home` };
}

function lingerProbe(out: string, user: string, destination: string): Outcome<boolean> {
  const on = /^Linger=yes$/m.test(out.trim());
  return on
    ? { value: true, detail: `on for ${user}: the fleet keeps running after you log out` }
    : {
      value: false, status: 'warn', detail: `off for ${user}: the fleet stops when you log out`,
      action: onThere(destination, `loginctl enable-linger ${user}`),
    };
}

// the remote $HOME and $USER, in the one probe that reads them
async function homeProbe(master: SshMaster): Promise<{ home: string; user: string }> {
  const [home, user] = (await probe(master, sh('svall-home', 'printf "%s\\n%s\\n" "$HOME" "$USER"'), '$HOME')).split('\n');
  return { home, user: user?.trim() ?? '' };
}

// the companion's doctor prints its report and then exits 1 for any failing check, so a report is
// read whatever the exit code, and only a run that printed none is a failure
async function remoteJson<T>(master: SshMaster, svallBase: string, argv: string[], what: string): Promise<T> {
  const r = await master.run([shq(svallExe(svallBase)), ...argv], { timeoutMs: PROBE_TIMEOUT });
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new StepError(r.code === 0
      ? `${what} did not answer JSON: ${r.stdout.trim().slice(0, 200)}`
      : `${what} exited ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
  }
}

type RemoteDoctor = { checks: Check[] };
type RemoteVersion = { release: string; protocol: number; machineId: string };

function serviceOutcome(report: RemoteDoctor, destination: string): Outcome<RemoteDoctor> {
  const named = (name: string) => report.checks.find((c) => c.name === name);
  const units = ['systemd', 'gateway'].map((name) => {
    const unit = named(name);
    if (!unit) throw new StepError(`the companion's doctor reported no ${name} check`);
    if (unit.status === 'fail') throw new StepError(unit.detail);
    return unit.detail;
  });
  const linger = named('linger');
  const command = linger?.status === 'warn' ? /loginctl enable-linger \S+/.exec(linger.detail)?.[0] : undefined;
  const action = command ? onThere(destination, command) : undefined;
  return { value: report, detail: units.join('; '), ...(action ? { status: 'warn' as const, action } : {}) };
}

/**
 * The agent checks, on the PATH the companion's units run with, which a login over ssh does not see all of: every
 * one of them is something to go and do, never something that stops setup.
 */
async function agentChecks(master: SshMaster, o: { destination: string; home: string; svallBase: string }, run: Runner): Promise<void> {
  const PATH = unitPath({ runtime: releaseRuntime(path.posix.join(o.svallBase, 'current')), homedir: o.home, prefix: o.svallBase });
  for (const kind of AGENT_KINDS) {
    await run.step(kind, async () => {
      const a = AGENTS[kind];
      const call = (args: string[]) => master.run(['env', shq(`PATH=${PATH}`), a.bin, ...args], { timeoutMs: PROBE_TIMEOUT });
      const todo = (detail: string, how: string): Outcome<void> => ({ value: undefined, status: 'warn', detail, action: `ssh ${o.destination}, then ${how}` });
      const v = await call(['--version']);
      // env exits 127 for a program it finds nowhere on that PATH
      if (v.code === 127) return todo(`${kind} is not installed on this machine`, `install ${a.label}`);
      const version = v.stdout.trim().split('\n')[0];
      if (v.code !== 0) return todo(`${a.bin} --version exited ${v.code}: ${v.stderr.trim().slice(0, 200) || 'no output'}`, `run ${a.bin} --version there and see what it answers`);
      if (!versionOk(a, version)) return todo(`${version}: Svall needs ${a.minVersion!.join('.')} or newer`, `update ${a.label}`);
      const login = await call(a.loginArgs);
      if (login.code === 0 && a.loggedIn(login.stdout)) return { value: undefined, detail: `${version}, logged in` };
      return todo(`${version}, not logged in`, kind === 'codex' ? `${a.loginHint}, and trust the hooks once with /hooks` : a.loginHint);
    });
  }
}

/**
 * The end-to-end probe: the companion's own private fleet has to answer over a forwarded port, from `release` when one
 * is named, before this machine counts as reachable. `anyProtocol` takes a release on another protocol than this controller's.
 */
async function endToEnd(master: SshMaster, entry: MachineEntry, { release, anyProtocol }: { release?: string; anyProtocol?: boolean } = {}): Promise<Outcome<void>> {
  const info = await remoteConnectionInfo(master, entry, { profile: PRIVATE, anyProtocol });
  const forward = await master.forward(info.port);
  let client: Client | undefined;
  try {
    client = await Client.connectEndpoint({ url: `ws://127.0.0.1:${forward.localPort}`, token: info.token });
    const running = (await client.call('system.info', {})).release;
    if (release && running !== release) throw new Error(`${entry.record.name} answers from release ${running}, not ${release}`);
    return { value: undefined, detail: `${entry.record.name} answers on its own ${PRIVATE} fleet` };
  } catch (err) {
    throw new StepError(redact((err as Error).message, [info.token]));
  } finally {
    client?.close();
    await forward.cancel().catch(() => undefined);
  }
}

// a window on a server of its own, which the probe takes down again whatever happened
const TMUX_PROBE = 'sock="${TMPDIR:-/tmp}/svall-probe-$$"; tmux -S "$sock" new-session -d -s svall-probe sleep 30 && tmux -S "$sock" list-windows -t svall-probe >/dev/null; r=$?; tmux -S "$sock" kill-server 2>/dev/null; rm -f "$sock"; exit $r';

/** Add Machine's end-to-end probe: the daemon over its tunnel, the machine's own gateway authority, and a tmux window on the PATH its units run with. */
async function addProbe(master: SshMaster, entry: MachineEntry, home: string): Promise<Outcome<void>> {
  await endToEnd(master, entry);
  const answer = await remoteOwner({ master, exe: svallExe(entry.record.svallBase), op: 'get', fleetId: crypto.randomUUID() }).catch((e: Error) => ({ error: { code: 'disconnected', message: e.message } }));
  // any answer of the authority's own will do, as it knows no fleet this probe names
  if ('error' in answer && (answer.error.code === 'disconnected' || answer.error.code === 'timeout')) throw new StepError(answer.error.message);
  const PATH = unitPath({ runtime: releaseRuntime(path.posix.join(entry.record.svallBase, 'current')), homedir: home, prefix: entry.record.svallBase });
  const r = await master.run(['env', shq(`PATH=${PATH}`), ...sh('svall-tmux', TMUX_PROBE)], { timeoutMs: PROBE_TIMEOUT });
  if (r.code !== 0) throw new StepError(`tmux could not open a window there (exit ${r.code}): ${r.stderr.trim().slice(0, 200) || 'no output'}`);
  return { value: undefined, detail: `${entry.record.name} answers on its own ${PRIVATE} fleet, its gateway authority answers, and tmux opens and closes a window there` };
}

async function companionFor(o: AddOptions, d: HostDeps, arch: string): Promise<Outcome<CompanionArchive & { allowUnsigned: boolean }>> {
  let archive = o.release;
  let from = 'the archive you named';
  let allowUnsigned = Boolean(o.allowUnsigned);
  if (!archive) {
    const asset = companionAsset(d.controller.releaseRoot, `linux-${arch}`);
    if (!asset) throw new StepError(`this build publishes no companion for linux-${arch}; name one with --release <archive>`);
    archive = await downloadCompanion({ ...asset, dir: companionCache(d.homedir), fetch: d.fetch });
    from = asset.url;
    // an unsigned development build pins the companion it was built with by digest, and that pin is
    // as trustworthy as the build the user already chose to run
    allowUnsigned ||= asset.unsignedBuild;
  }
  const companion = await inspectCompanion(archive, { verify: d.verify });
  requireCompatible(companion, { ...d.controller, arch, allowUnsigned });
  return { value: { ...companion, allowUnsigned }, detail: `${companion.version} for ${companion.platform} from ${from}${companion.signed ? '' : ' (unsigned)'}` };
}

const remotePaths = (home: string, version: string) => ({
  archive: path.posix.join(home, '.cache', 'svall', `companion-${version}.tar.gz`),
  staging: path.posix.join(home, '.cache', 'svall', `staging-${version}`),
  svallBase: path.posix.join(home, '.local', 'share', 'svall'),
});

/** The one machine record this name may carry, and the ssh destination it is already reached at. */
function claimName(registry: MachineRegistry, o: AddOptions): Outcome<MachineEntry | undefined> {
  const name = MachineRecord.shape.name.safeParse(o.name);
  if (!name.success) throw new StepError(`${o.name} is not a machine name: ${name.error.issues[0].message}`);
  const destination = MachineRecord.shape.ssh.unwrap().safeParse(o.ssh);
  if (!destination.success) throw new StepError(`${o.ssh} is not an ssh destination: ${destination.error.issues[0].message}`);
  const held = registry.get(o.name);
  if (held && held.record.ssh !== o.ssh) {
    throw new StepError(`${o.name} is already the machine at ${held.record.ssh}; remove it first or add this one under another name`);
  }
  return { value: held, detail: held ? `${o.name} is already in the registry; its probes run again` : `${o.name} at ${o.ssh}` };
}

/** `svall host add`: the spec's Add Machine flow, from the first interactive ssh to the registry entry. */
export function addHost(o: AddOptions, d: HostDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const held = await run.step('name', () => Promise.resolve(claimName(d.registry, o)));

    await run.step('ssh', async () => {
      const code = await d.interactiveSsh(o.ssh);
      if (code !== 0) throw new StepError(`ssh ${o.ssh} exited ${code}`, `ssh ${o.ssh} and complete the host key and authentication`);
      return { value: undefined, detail: `${o.ssh} accepted an interactive login` };
    });

    const master = await run.step('master', async () => {
      try {
        return { value: await d.openMaster(o.ssh), detail: `one control master to ${o.ssh}` };
      } catch (err) {
        throw new StepError((err as Error).message, `ssh ${o.ssh} and see what it answers`);
      }
    });

    try {
      const { arch } = await run.step('os', () => osProbe(master));
      const { home, user } = await run.step('home', async () => {
        const remote = await homeProbe(master);
        if (!MachineRecord.shape.home.safeParse(remote.home).success) throw new StepError(`the remote $HOME is not an absolute path: ${JSON.stringify(remote.home)}`);
        // a fleet's paths travel as they are, so the far account has to live where this Mac's does
        const mine = d.registry.localMachine().home;
        if (remote.home !== mine) {
          throw new StepError(
            `${remote.home} is ${remote.user}'s home there and ${mine} is this Mac's; a fleet moves only between accounts with the same home path`,
            onThere(o.ssh, `make an account whose home is ${mine}: ${homeCommands(mine)}; then add the machine again at that account`),
          );
        }
        const tooLong = socketTooLong(gatewayPaths(remotePaths(remote.home, '').svallBase).socket, 'linux');
        if (tooLong) {
          throw new StepError(tooLong.message, `use an account whose home path is at most ${Buffer.byteLength(remote.home) - tooLong.over} bytes, on this Mac and on ${o.ssh} alike`);
        }
        return { value: remote, detail: `${remote.home} for ${remote.user}` };
      });

      await run.step('tools', async () => toolsProbe(await probe(master, sh('svall-tools', WHICH, ...TOOLS), 'command -v'), o.ssh));
      await run.step('tmux', async () => {
        const version = (await probe(master, ['tmux', '-V'], 'tmux -V')).trim();
        return tmuxTooOld(version)
          ? { value: undefined, status: 'warn' as const, detail: `${version}: Shift+Enter needs tmux 3.5 or newer; Ubuntu 24.04 ships 3.4` }
          : { value: undefined, detail: version };
      });
      await run.step('rsync', async () => {
        const line = (await probe(master, sh('svall-rsync', 'rsync --version | head -1'), 'rsync --version')).trim();
        const r = rsyncVersion(line);
        return 'reason' in r
          ? { value: undefined, status: 'warn' as const, detail: `the rsync there ${r.reason}`, action: onThere(o.ssh, `install rsync ${MIN_RSYNC.join('.')} or newer, as Ubuntu 22.04 and later ship`) }
          : { value: undefined, detail: line };
      });
      await run.step('space', async () => spaceProbe(await probe(master, sh('svall-space', 'df -Pk "$HOME"'), 'df -Pk $HOME')));
      await run.step('linger', async () => lingerProbe(await probe(master, sh('svall-linger', 'loginctl show-user "$USER" -p Linger'), 'loginctl show-user'), user, o.ssh));

      const companion = await run.step('release', () => companionFor(o, d, arch));
      const remote = remotePaths(home, companion.version);

      await run.step('upload', async () => {
        await uploadArchive(master, { archive: companion.archive, remote: remote.archive });
        return { value: undefined, detail: `${path.basename(companion.archive)} -> ${remote.archive}` };
      });
      await run.step('install', async () => {
        const out = await bootstrapSetup(master, {
          staging: remote.staging, archive: remote.archive, version: companion.version,
          allowUnsigned: !companion.signed && companion.allowUnsigned, installed: remote.svallBase,
        });
        return { value: undefined, detail: out.trim().split('\n').at(-1) ?? `release ${companion.version} installed` };
      });

      await run.step('service', async () => serviceOutcome(await remoteJson<RemoteDoctor>(master, remote.svallBase, ['doctor', '--json'], 'svall doctor --json'), o.ssh));
      const machine = await run.step('identity', async () => {
        const v = await remoteJson<RemoteVersion>(master, remote.svallBase, ['version', '--json'], 'svall version --json');
        const id = MachineId.safeParse(v.machineId);
        if (!id.success) throw new StepError('svall version --json did not report a machine id');
        if (v.protocol !== d.controller.protocol) throw new StepError(`the companion speaks protocol ${v.protocol}, not this controller's ${d.controller.protocol}`);
        return { value: id.data, detail: `${v.release}, machine ${id.data}` };
      });

      await agentChecks(master, { destination: o.ssh, home, svallBase: remote.svallBase }, run);

      const record: MachineRecord = {
        name: o.name, ssh: o.ssh, platform: 'linux', arch, home,
        svallBase: remote.svallBase, gateway: false,
      };
      await run.step('probe', () => addProbe(master, { id: machine, record }, home));
      await run.step('registry', () => {
        if (held) d.registry.remove(held.id);
        const entry = d.registry.add(record, machine);
        d.registry.save();
        return Promise.resolve({ value: entry, detail: `${o.name} is machine ${entry.id}` });
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  });
}

export type HostReport = { machine: string; checks: Check[] };

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
async function sameMachine(master: SshMaster, entry: Registered): Promise<void> {
  await identify(master, entry).catch((err: unknown) => {
    if (!(err instanceof MachineMismatch)) throw err;
    throw new StepError(err.message, `point ${entry.record.ssh} back at ${entry.record.name}, or svall host remove ${entry.record.name} --forget`);
  });
}

const machineOutcome = (registry: MachineRegistry, name: string): Outcome<Registered> => {
  const entry = need(registry, name);
  return { value: entry, detail: `${name} at ${entry.record.ssh}` };
};

const failed = (name: string, err: unknown): Check => ({ name, status: 'fail', detail: (err as Error).message });

/** `svall host doctor`: what the companion's own doctor says, plus what only the controller can check. */
export async function doctorHost(name: string, d: HostDeps): Promise<HostReport> {
  const entry = need(d.registry, name);
  const master = await d.openMaster(entry.record.ssh);
  const checks: Check[] = [];
  try {
    const base = entry.record.svallBase;
    try {
      const report = await remoteJson<RemoteDoctor>(master, base, ['doctor', '--json'], 'svall doctor --json');
      checks.push(...report.checks);
    } catch (err) { checks.push(failed('doctor', err)); }
    try {
      const v = await remoteJson<RemoteVersion>(master, base, ['version', '--json'], 'svall version --json');
      const same = d.controller.release === 'dev' || v.release === d.controller.release;
      checks.push({
        name: 'release', status: same && v.protocol === d.controller.protocol ? 'ok' : 'fail',
        detail: `${v.release}, protocol ${v.protocol}; this controller runs ${d.controller.release}, protocol ${d.controller.protocol}`,
      });
    } catch (err) { checks.push(failed('release', err)); }
    try {
      checks.push({ name: 'space', ...pick(spaceProbe(await probe(master, sh('svall-space', 'df -Pk "$HOME"'), 'df -Pk $HOME'))) });
    } catch (err) { checks.push(failed('space', err)); }
    let far: { home: string; user: string } | undefined;
    try {
      far = await homeProbe(master);
      const [n, mine] = [entry.record.name, d.registry.localMachine().home];
      const wrong = far.home !== entry.record.home ? `${far.home} is ${far.user}'s home on ${n}, and the registry records ${entry.record.home}`
        : far.home !== mine ? `${far.home} is ${far.user}'s home on ${n} and ${mine} is this Mac's; a fleet moves only between accounts with the same home path`
          : undefined;
      checks.push(wrong ? { name: 'home', status: 'fail', detail: `${wrong}; svall host remove ${n}, then svall host add again at an account whose home is ${mine}, and svall host enable ${n} --fleet <fleet> for each fleet it is the gateway of` }
        : { name: 'home', status: 'ok', detail: `${far.home} for ${far.user}` });
    } catch (err) { checks.push(failed('home', err)); }
    if (far && !checks.some((c) => c.name === 'linger')) {
      try {
        const out = await probe(master, sh('svall-linger', 'loginctl show-user "$USER" -p Linger'), 'loginctl show-user');
        checks.push({ name: 'linger', ...pick(lingerProbe(out, far.user, entry.record.ssh)) });
      } catch (err) { checks.push(failed('linger', err)); }
    }
  } finally {
    await master.close().catch(() => undefined);
  }
  return { machine: entry.record.name, checks };
}

const pick = (o: Outcome<unknown>): { status: Check['status']; detail: string } =>
  ({ status: (o.status ?? 'ok') as Check['status'], detail: [o.detail, o.action].filter(Boolean).join('; ') });

/**
 * `svall host upgrade`: a new release installed by its own setup, as the setup of the release it replaces may not speak
 * its protocol, then a probe that puts the old one back if it does not answer.
 */
export function upgradeHost(name: string, o: { release?: string; allowUnsigned?: boolean }, d: HostDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const entry = await run.step('machine', () => Promise.resolve(machineOutcome(d.registry, name)));
    const master = await run.step('master', async () => {
      const opened = await d.openMaster(entry.record.ssh);
      await sameMachine(opened, entry).catch(async (err: unknown) => { await opened.close().catch(() => undefined); throw err; });
      return { value: opened, detail: `one control master to ${entry.record.ssh}` };
    });
    try {
      const companion = await run.step('release', () => companionFor({ name, ssh: entry.record.ssh, ...o }, d, entry.record.arch));
      const remote = remotePaths(entry.record.home, companion.version);
      await run.step('upload', async () => {
        await uploadArchive(master, { archive: companion.archive, remote: remote.archive });
        return { value: undefined, detail: `${path.basename(companion.archive)} -> ${remote.archive}` };
      });
      const before = await run.step('install', async () => {
        const was = await currentRelease(master, entry.record.svallBase);
        const out = await bootstrapSetup(master, {
          staging: remote.staging, archive: remote.archive, version: companion.version,
          allowUnsigned: !companion.signed && companion.allowUnsigned, installed: entry.record.svallBase,
        });
        return { value: was, detail: out.trim().split('\n').at(-1) ?? `release ${companion.version} installed` };
      });

      const probed = await run.step('probe', async () => {
        try {
          serviceOutcome(await remoteJson<RemoteDoctor>(master, entry.record.svallBase, ['doctor', '--json'], 'svall doctor --json'), entry.record.ssh);
          await endToEnd(master, entry, { release: companion.version });
          return { value: true, detail: `${entry.record.name} answers on release ${companion.version}` };
        } catch (err) {
          return { value: false, status: 'warn' as const, detail: (err as Error).message };
        }
      });
      if (probed) return;
      await run.step('rollback', async () => {
        // a reinstall under the name it ran replaced that tree, so it goes back to whichever release is kept
        const replaced = before === companion.version;
        const out = await remoteRollback(master, { svallBase: entry.record.svallBase, from: companion.version, ...(!replaced && { to: before }) }).catch((err: Error) => err);
        const now = await currentRelease(master, entry.record.svallBase);
        const runs = !replaced ? `${name} runs release ${now}${now === before ? ', the one it ran before' : `, not ${before}, the one it ran before`}`
          : `${name} ran a release named ${before} before, which this install replaced; ${now === before ? 'no other release is kept there, so it runs the new one' : `it runs release ${now}, the newest one kept there`}`;
        const action = `ssh ${entry.record.ssh} and read the daemon log; ${runs}`;
        if (out instanceof Error) throw new StepError(out.message, action);
        return { value: undefined, status: 'warn' as const, detail: out.trim().split('\n').at(-1) ?? `current -> ${now}`, action };
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  });
}

/**
 * `svall host upgrade --rollback`: the far machine back on the release `to`, or on the one before, by its own `svall`,
 * which checks each fleet's daemon answers from it, then the probe an upgrade makes.
 */
export function rollbackHost(name: string, o: { to?: string }, d: HostDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const entry = await run.step('machine', () => Promise.resolve(machineOutcome(d.registry, name)));
    const master = await run.step('master', async () => {
      const opened = await d.openMaster(entry.record.ssh);
      await sameMachine(opened, entry).catch(async (err: unknown) => { await opened.close().catch(() => undefined); throw err; });
      return { value: opened, detail: `one control master to ${entry.record.ssh}` };
    });
    const base = entry.record.svallBase;
    const runs = async (): Promise<string> => `ssh ${entry.record.ssh} and read the daemon log; ${name} runs release ${await currentRelease(master, base)}`;
    try {
      const now = await run.step('rollback', async () => {
        const out = await remoteRollback(master, { svallBase: base, from: await currentRelease(master, base), ...(o.to !== undefined && { to: o.to }) })
          .catch(async (err: Error) => { throw new StepError(err.message, await runs()); });
        return { value: await currentRelease(master, base), detail: out.trim().split('\n').join('; ') };
      });
      await run.step('probe', async () => {
        try {
          serviceOutcome(await remoteJson<RemoteDoctor>(master, base, ['doctor', '--json'], 'svall doctor --json'), entry.record.ssh);
          // the release gone back to may speak an older protocol than this controller, and its system.info still names it
          await endToEnd(master, entry, { release: now, anyProtocol: true });
        } catch (err) {
          throw new StepError((err as Error).message, await runs());
        }
        return { value: undefined, detail: `${name} answers on release ${now}` };
      });
    } finally {
      await master.close().catch(() => undefined);
    }
  });
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
    .filter((f) => f === '.svall' || (f.startsWith('.svall-') && isProfileName(f.slice('.svall-'.length))))
    .map((f) => path.join(homedir, f))
    .filter((home) => fs.existsSync(resolvePaths(home).fleetConfig));
}

/**
 * The fleets that name this machine as their gateway: a fleet this Mac owns can drop it, and one
 * that another machine owns would be stranded, since only its gateway knows where it is. A fleet this
 * machine owns, through whichever gateway, runs there, and goes with it, as may one a handover holds open.
 */
function gatewayFleets(entry: MachineEntry, d: HostDeps): Outcome<string[]> {
  const me = d.machineId();
  const homes = fleetHomes(d.homedir);
  const named = homes.filter((home) => readFleet(resolvePaths(home).fleetConfig).gatewayMachineId === entry.id);
  const svall = (home: string, args: string): string => {
    const profile = profileOf(home, d.homedir);
    return `\`svall ${profile === PRIVATE ? '' : `-p ${profile} `}${args}\``;
  };
  // a gateway may hold a handover open while this Mac's daemon or controller keeps a journal of it, and whichever
  // gateway it is, the handover may have committed the fleet to this machine before any cache here said so
  const open = homes.filter((home) => fs.existsSync(resolvePaths(home).journal) || fileStore(path.join(home, 'controller')).read() !== undefined);
  if (open.length) {
    const settle = (home: string): string =>
      `${svall(home, 'handover --resume')} finishes the handover of ${home} and ${svall(home, 'handover --abort')} takes it back, as ${svall(home, 'handover status')} says is safe`;
    throw new StepError(`${entry.record.name} may be the gateway or the owner of ${open.join(', ')}, which a handover holds open`,
      `${open.map(settle).join('; ')}; then \`svall host remove ${entry.record.name}\``);
  }
  const owners = (home: string) => [cachedOwner(home)?.ownerMachineId, readRoute(home)?.ownerMachineId];
  const away = named.filter((home) => owners(home).some((id) => id !== undefined && id !== me));
  const there = homes.filter((home) => !named.includes(home) && owners(home).includes(entry.id));
  if (away.length || there.length) {
    const why = [
      ...(away.length ? [`${entry.record.name} is the gateway for ${away.join(', ')}, which another machine owns`] : []),
      ...(there.length ? [`${entry.record.name} owns ${there.join(', ')}, whose daemon runs there`] : []),
    ];
    const back = [...away, ...there];
    throw new StepError(why.join('; '),
      `bring ${back.length > 1 ? 'each fleet' : 'it'} back to this Mac with ${back.map((home) => svall(home, 'handover local')).join(' and ')}, then \`svall host remove ${entry.record.name}\``);
  }
  return {
    value: named,
    detail: named.length ? `${named.join(', ')} stop naming ${entry.record.name} as their gateway` : `no fleet here names ${entry.record.name} as its gateway`,
  };
}

/** `svall host remove`: the remote uninstall first, and the route only after it, or only on --forget. */
export function removeHost(name: string, o: { forget?: boolean }, d: HostDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const entry = await run.step('machine', () => Promise.resolve(machineOutcome(d.registry, name)));
    const fleets = await run.step('fleet', () => Promise.resolve(gatewayFleets(entry, d)));
    // never --purge from here: the fleets and their tmux servers are the far machine's to delete
    const uninstalled = await run.step('uninstall', async () => {
      const untouched = `${entry.record.ssh} still has Svall installed; run svall uninstall there to remove it`;
      if (o.forget) return { value: false, status: 'skip' as const, detail: `${name} is left untouched`, action: untouched };
      let master: SshMaster | undefined;
      try {
        master = await d.openMaster(entry.record.ssh);
        await sameMachine(master, entry);
        // the fleet step checked the fleets naming this gateway, so only their records are forced past; the far
        // machine still refuses for whatever else it holds, such as another Mac's fleet
        const ids = [...new Set(fleets.map((home) => readFleet(resolvePaths(home).fleetConfig).id))];
        const argv = [shq(svallExe(entry.record.svallBase)), 'uninstall', ...ids.flatMap((id) => ['--force-fleet', shq(id)])];
        const r = await master.run(argv, { timeoutMs: PROBE_TIMEOUT });
        if (r.code === REFUSED) {
          throw new StepError(`${name} refuses: ${r.stderr.trim().replace(/^svall: /, '').slice(0, 1000)}`,
            `on each other Mac whose fleet it names, bring that fleet home with svall handover local and run svall host remove ${name} --forget; then ${onThere(entry.record.ssh, 'svall uninstall --force')}, and svall host remove ${name} --forget here`);
        }
        if (r.code !== 0) throw new StepError(`svall uninstall exited ${r.code}: ${r.stderr.trim().slice(0, 200) || 'no output'}`);
        return { value: true, detail: r.stdout.trim().split('\n').at(-1) ?? 'svall uninstall' };
      } catch (err) {
        if (err instanceof StepError && err.action) throw err;
        throw new StepError(`${entry.record.ssh} could not be reached: ${(err as Error).message}`,
          `svall host remove ${name} --forget drops the route and leaves the machine untouched`);
      } finally {
        await master?.close().catch(() => undefined);
      }
    });
    await run.step('registry', () => {
      for (const home of fleets) patchFleetConfig(resolvePaths(home).fleetConfig, { gatewayMachineId: undefined });
      d.registry.remove(entry.id);
      d.registry.save();
      return Promise.resolve({ value: undefined, detail: uninstalled ? `${name} is no longer in the registry` : `${name} is forgotten; the machine was left untouched` });
    });
  });
}

function readFleet(file: string): FleetConfig {
  try {
    return FleetConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new StepError(`${file} is not a fleet config: ${(err as Error).message}`);
  }
}

/**
 * The record that says this fleet is this Mac's: the gateway's own, asked for over ssh and created
 * where there is none. A record another machine holds is not this Mac's to take.
 */
async function seedAuthority(master: SshMaster, entry: Registered, fleetId: FleetId, name: string, d: HostDeps): Promise<Outcome<void>> {
  const owner = d.machineId();
  const exe = svallExe(entry.record.svallBase);
  let frame = await remoteOwner({ master, exe, op: 'get', fleetId });
  if ('error' in frame && frame.error.code === 'not_found') {
    frame = await remoteOwner({ master, exe, op: 'create', fleetId, params: { initialOwnerMachineId: owner } });
  }
  if ('error' in frame) {
    const repair = frame.error.code === 'authority_corrupt'
      ? onThere(entry.record.ssh, `put a readable record back where the gateway looks for it, then run svall host enable ${name} again`)
      : undefined;
    throw new StepError(frame.error.message, repair);
  }
  const record = frame.record;
  if (record.fleetId !== fleetId || record.ownerMachineId !== owner) {
    throw new StepError(`${name} holds fleet ${record.fleetId} for ${record.ownerMachineId} at generation ${record.generation}, not for this machine`);
  }
  return { value: undefined, detail: `${name} holds fleet ${fleetId} for ${owner} at generation ${record.generation}` };
}

/** The exit code of a refusal only the user can settle: `svall fleet provision` finding a fleet home in use, or `svall uninstall` a fleet it would strand. */
export const REFUSED = 3;

type FarCopy = { outcome: 'created' | 'held' | 'rekeyed'; home: string; unit: string };

/**
 * The gateway machine's own copy of the fleet, under the profile a handover reaches it by: the companion makes
 * one where there is none, and takes over one only `host add` has made, which it refuses for one in use.
 */
async function provisionCopy(master: SshMaster, entry: Registered, fleetId: FleetId, profile: string): Promise<string> {
  const name = entry.record.name;
  const r = await master.run([
    shq(svallExe(entry.record.svallBase)), '-p', shq(profile),
    'fleet', 'provision', '--id', shq(fleetId), '--gateway', shq(entry.id), '--json',
  ], { timeoutMs: PROVISION_TIMEOUT });
  if (r.code !== 0) {
    const said = r.stderr.trim().replace(/^svall: /, '').slice(0, 400) || `svall fleet provision exited ${r.code ?? `on ${r.signal}`}`;
    // only a refusal is a fleet home in the way; anything else is the run failing, which running enable again goes on from
    if (r.code === REFUSED) {
      throw new StepError(`${name} cannot take a copy of this fleet: ${said}`,
        `ssh ${entry.record.ssh} and move that fleet home aside, then run svall host enable ${name} --fleet ${profile} again`);
    }
    throw new StepError(`${name} did not finish making its copy of this fleet: ${said}`);
  }
  let copy: FarCopy;
  try { copy = JSON.parse(r.stdout) as FarCopy; } catch { throw new StepError(`svall fleet provision did not answer JSON: ${r.stdout.trim().slice(0, 200)}`); }
  return copy.outcome === 'held' ? `${name} already holds this fleet in ${copy.home}`
    : copy.outcome === 'created' ? `${name} holds this fleet in ${copy.home}, made for it, under ${copy.unit}`
      : `${name}'s unused fleet in ${copy.home} is now this fleet, under ${copy.unit}`;
}

/** `svall host enable`: which machine is to be this fleet's gateway, the record that says so, and its copy of the fleet. */
export function enableHost(name: string, o: { fleetHome: string }, d: HostDeps): Promise<HostOutcome> {
  return flow(d.emit, async (run) => {
    const file = resolvePaths(o.fleetHome).fleetConfig;
    const entry = await run.step('machine', () => {
      const out = machineOutcome(d.registry, name);
      // a gateway the registry still holds may still hold this fleet, which a record made here would strand
      const named = readFleet(file).gatewayMachineId;
      const held = named && named !== out.value.id ? d.registry.get(named) : undefined;
      if (held) {
        const profile = profileOf(o.fleetHome, d.homedir);
        const svall = `svall ${profile === PRIVATE ? '' : `-p ${profile} `}`;
        throw new StepError(`${file} names ${held.record.name} as its gateway, which may still hold this fleet`,
          `if ${held.record.name} is gone for good, \`${svall}fleet recover --force-owner local --gateway ${name}\` makes ${name} the gateway, then run this again`);
      }
      return Promise.resolve(out);
    });
    // both steps ride the one master whose machine was checked, which no later command can leave for another
    let master: SshMaster | undefined;
    try {
      // fleet.json names the gateway only once the gateway itself holds the record for this fleet, and a copy of it
      await run.step('authority', async () => {
        master = await d.openMaster(entry.record.ssh);
        await sameMachine(master, entry);
        return seedAuthority(master, entry, readFleet(file).id, name, d);
      });
      await run.step('fleet', async () => {
        const copy = await provisionCopy(master!, entry, readFleet(file).id, profileOf(o.fleetHome, d.homedir));
        patchFleetConfig(file, { gatewayMachineId: entry.id });
        d.registry.markGateway(entry.id);
        d.registry.save();
        return { value: undefined, detail: `${copy}; ${file} names ${name} as the gateway` };
      });
    } finally {
      await master?.close().catch(() => undefined);
    }
  });
}
