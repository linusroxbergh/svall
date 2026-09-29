import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { FleetId, MachineId, PROTOCOL_VERSION } from '@svall/protocol';
import { shq } from '@svall/svalld/text';
import { addHost, doctorHost, enableHost, removeHost, rollbackHost, upgradeHost, type HostDeps, type StepEvent } from '../src/controller/host.js';
import { runProcess } from '../src/controller/process.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { SshMaster } from '../src/controller/ssh.js';
import { cleanHomes, makeHome, waitFor } from '../../svalld/test/helpers.js';
import { companionArchive, ephemeralSigner, linkedArchive, smuggledArchive } from './controller/archive.js';
import { installFakeSsh, type FakeSsh } from './controller/fake-ssh.js';

const REMOTE = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const MAC = MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const OTHER_MAC = MachineId.parse('9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
const OTHER_FLEET = FleetId.parse('0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70');
const TOKEN = 'remote-token-never-printed';
// the far account's home is the Mac's, as the registry's own record names it
const HOME = os.homedir();
// a home no runner of these tests has
const ELSEWHERE = `${HOME}-elsewhere`;
const BASE = `${HOME}/.local/share/svall`;
const SVALL = `${BASE}/current/bin/svall`;
// the PATH the companion's units run with, and so the one its daemon finds the agent CLIs on
const UNIT_PATH = `PATH=${BASE}/current/node/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

const OS_RELEASE = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\n';
const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 60000000 20000000 40000000 34% /\n';

/** What the companion's own `svall doctor --json` answers; a machine without linger reports none. */
const doctorJson = (linger?: { status: string; detail: string }): string => JSON.stringify({
  checks: [
    { name: 'systemd', status: 'ok', detail: 'svall-svalld@private.service: loaded, active (running), enabled' },
    { name: 'gateway', status: 'ok', detail: 'svall-gateway.service: loaded, active (running), enabled' },
    ...(linger ? [{ name: 'linger', ...linger }] : []),
    { name: 'tmux', status: 'ok', detail: 'tmux 3.4' },
  ],
});
const DOCTOR = doctorJson({ status: 'ok', detail: 'on for linus: the fleet keeps running after you log out' });

let work: string;
let ssh: FakeSsh;
let events: StepEvent[];

let signer: ReturnType<typeof ephemeralSigner>;

const archive = (o: { version?: string; protocol?: number; platform?: string; signed?: boolean } = {}): string =>
  companionArchive(work, { ...o, ...((o.signed ?? true) ? { signedBy: signer.key } : {}) });

/**
 * Archives holding release 1.2.3 whose SHA256SUMS, extracted by name, `signer` signed, and an intruder's release
 * that a full unpack writes over it: its SHA256SUMS spelled another way or named twice, or written through a link.
 * Each intruder's svall touches `ran(name)`.
 */
function smuggling(ran: (name: string) => string): { name: string; archive: string }[] {
  const intruder = ephemeralSigner(work);
  const genuine = companionArchive(work, { signedBy: signer.key });
  const theirs = (name: string): string =>
    companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran(name)}'\n` });
  const spellings: [string, (member: string) => string][] = [
    ['dot', (m) => `./${m}`], ['dot-segment', (m) => m.replace(/\/([^/]+)$/, '/./$1')], ['empty-segment', (m) => m.replace(/\/([^/]+)$/, '//$1')], ['twice', (m) => m],
  ];
  return [
    ...spellings.map(([name, spell]) => ({ name, archive: smuggledArchive(work, { genuine, intruder: theirs(name), spell }) })),
    { name: 'link', archive: linkedArchive(work, { genuine, intruder: theirs('link') }) },
  ];
}

function deps(o: Partial<HostDeps> = {}): HostDeps {
  return {
    emit: (e) => events.push(e),
    registry: MachineRegistry.load(path.join(work, 'config')),
    openMaster: (destination) => SshMaster.open({ destination, socketDir: ssh.socketDir }),
    interactiveSsh: () => Promise.resolve(0),
    fetch: () => Promise.reject(new Error('no download in this test')),
    controller: { release: '1.2.3', protocol: PROTOCOL_VERSION, releaseRoot: path.join(work, 'release') },
    machineId: () => MAC,
    homedir: work,
    verify: (dir, id) => signer.verify(dir, id),
    ...o,
  };
}

/** Everything a healthy Ubuntu companion answers, in the order `host add` asks for it. */
function healthy(o: { linger?: string; tools?: string[]; osRelease?: string; doctor?: string; agents?: boolean } = {}): void {
  ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
  ssh.reply(['cat', '/etc/os-release'], { stdout: o.osRelease ?? OS_RELEASE });
  ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
  ssh.reply(['svall-tools'], { stdout: (o.tools ?? ['tailscale', 'tmux', 'git', 'rsync', 'systemctl', 'loginctl']).map((t) => `${t} yes`).join('\n') + '\n' });
  ssh.reply(['tmux', '-V'], { stdout: 'tmux 3.4\n' });
  ssh.reply(['svall-rsync'], { stdout: 'rsync  version 3.2.7  protocol version 31\n' });
  ssh.reply(['svall-space'], { stdout: DF });
  ssh.reply(['svall-linger'], { stdout: o.linger ?? 'Linger=yes\n' });
  ssh.reply(['cat > "$1"'], {});
  ssh.reply(['mkdir'], {});
  ssh.reply(['svall-unpack'], {});
  ssh.reply(['rm'], {});
  ssh.reply(['setup'], { stdout: 'release 1.2.3 installed\n' });
  ssh.reply(['doctor', '--json'], { stdout: o.doctor ?? DOCTOR });
  ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
  ssh.reply(['gateway', 'owner', 'get'], { stdout: `${JSON.stringify({ error: { code: 'not_found', message: 'the gateway holds no record for that fleet' } })}\n`, code: 1 });
  ssh.reply(['svall-tmux'], {});
  if (o.agents === false) return;
  ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
  ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
  ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.155.1\n' });
  ssh.reply([UNIT_PATH, 'codex', 'login', 'status'], { stdout: 'Logged in using ChatGPT\n' });
}

/** A daemon on the far side of the forward, so the end-to-end probe has something to answer it: from `release`, while it `accepts`. */
async function daemon(o: { release?: () => string; accepts?: () => boolean } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; token?: string };
    ws.send(JSON.stringify(msg.token !== undefined
      ? { id: 0, result: { ok: msg.token === TOKEN && (o.accepts?.() ?? true) } }
      : { id: msg.id, result: { version: 1, fleet: 'private', release: o.release?.() ?? '1.2.3' } }));
  }));
  return { port: (wss.address() as { port: number }).port, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

// every step spawns the fake ssh, and a whole `host add` spawns some two dozen of them
vi.setConfig({ testTimeout: 60_000 });

const step = (id: string): StepEvent[] => events.filter((e) => e.step === id && e.status !== 'start');

beforeEach(() => {
  work = fs.mkdtempSync('/tmp/svall-host-');
  signer = ephemeralSigner(work);
  ssh = installFakeSsh();
  events = [];
});
afterEach(() => { ssh.clean(); cleanHomes(); fs.rmSync(work, { recursive: true, force: true }); });

describe('host add', () => {
  it('probes, installs, checks and registers the machine', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });

    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();

    expect(out.result).toBe('ready');
    const order = ssh.remoteCalls().map((w) => (w[0] === 'sh' ? w[2].slice(0, 20) : w[0] === 'env' ? `${w[2]} ${w[3]}` : path.basename(w[0]) + (w[1] ? ` ${w[1]}` : '')));
    expect(order.slice(0, 8)).toEqual([
      'uname -sm', 'cat /etc/os-release',
      'printf "%s\\n%s\\n" "$', 'for c in "$@"; do if',
      'tmux -V', 'rsync --version | he', 'df -Pk "$HOME"', 'loginctl show-user "',
    ]);
    expect(order.slice(8)).toEqual([
      'mkdir -p', 'cat > "$1"', 'mkdir -p', 'PATH=/usr/bin:/bin:/', 'svall setup', 'rm -rf',
      'svall doctor', 'svall version',
      'claude --version', 'claude auth', 'codex --version', 'codex login',
      'svall connection-info', 'svall gateway', 'sh -c',
    ]);
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'trift answers on its own private fleet, its gateway authority answers, and tmux opens and closes a window there' });
  });

  it('fails the probe on a gateway authority that does not answer, or a tmux that cannot open a window, and registers nothing', async () => {
    for (const [match, reply, said] of [
      [['gateway', 'owner', 'get'], { stdout: `${JSON.stringify({ error: { code: 'disconnected', message: 'the gateway authority did not answer on /x/authority.sock' } })}\n`, code: 1 }, 'the gateway authority did not answer'],
      [['svall-tmux'], { stderr: 'error connecting to /tmp/svall-probe (No such file or directory)\n', code: 1 }, 'tmux could not open a window'],
    ] as const) {
      ssh.clearReplies();
      ssh.reply([...match], reply);
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
      events = [];
      const registry = MachineRegistry.load(path.join(work, 'config'));
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      expect(out.result).toBe('actions');
      expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(said) });
      expect(registry.get('trift')).toBeUndefined();
    }
  });

  it('finds claude and codex on the PATH the companion\'s unit runs with, and holds each to its version floor and login', async () => {
    // over ssh the login shell finds neither CLI; their installers put them in ~/.local/bin
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
    ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":false}\n', code: 1 });
    ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.154.2\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', detail: '2.1.278 (Claude Code), not logged in', action: 'ssh trift.test, then claude auth login' });
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex-cli 0.154.2: Svall needs 0.155.0 or newer', action: 'ssh trift.test, then update Codex' });
    expect(out.actions).toEqual(['ssh trift.test, then claude auth login', 'ssh trift.test, then update Codex']);
    const agentCalls = ssh.remoteCalls().filter((w) => w.includes('claude') || w.includes('codex'));
    expect(agentCalls.length).toBe(3);
    expect(agentCalls.every((w) => w[0] === 'env' && w[1] === UNIT_PATH)).toBe(true);
  });

  it('names an agent CLI the unit\'s PATH does not hold as one to install', async () => {
    healthy({ agents: false });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', detail: 'claude is not installed on this machine', action: 'ssh trift.test, then install Claude Code' });
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex is not installed on this machine', action: 'ssh trift.test, then install Codex' });
  });

  it('writes the registry record under the machine id the companion reports', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();

    const entry = registry.get('trift');
    expect(entry?.id).toBe(REMOTE);
    expect(entry?.record).toEqual({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE, gateway: false,
    });
  });

  it('never lets the companion token out in an event', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('runs one interactive ssh before any batch command', async () => {
    const seen: string[] = [];
    healthy();
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({
      interactiveSsh: (destination) => { seen.push(destination); return Promise.resolve(0); },
    }));
    expect(seen).toEqual(['trift.test']);
  });

  it('stops at a far home other than this Mac\'s, naming the commands that make an account whose home is this one', async () => {
    ssh.reply(['svall-home'], { stdout: `${ELSEWHERE}\nlinus\n` });
    healthy();
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('home').at(-1)).toEqual({
      step: 'home', status: 'fail',
      detail: `${ELSEWHERE} is linus's home there and ${HOME} is this Mac's; a fleet moves only between accounts with the same home path`,
      action: `ssh trift.test, then make an account whose home is ${HOME}: sudo mkdir -p ${path.dirname(HOME)}, then sudo useradd -m -d ${HOME} <user> for a new account, or sudo usermod -d ${HOME} -m <user> for an existing one you are not logged in as; then add the machine again at that account`,
    });
    expect(ssh.remoteCalls().some((w) => w.includes('setup') || w.includes('cat > "$1"'))).toBe(false);
    expect(registry.get('trift')).toBeUndefined();
  });

  it('stops at a home too long for the gateway\'s socket on Linux, naming the listen EINVAL it would otherwise crash on', async () => {
    // 66 bytes: its gateway socket, 42 bytes further on, is one past the 107 Linux holds
    const long = `/tmp/${'h'.repeat(61)}`;
    vi.stubEnv('HOME', long);
    ssh.reply(['svall-home'], { stdout: `${long}\nlinus\n` });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps()).finally(() => vi.unstubAllEnvs());
    expect(out.result).toBe('actions');
    expect(step('home').at(-1)).toMatchObject({
      status: 'fail',
      detail: `the gateway's socket ${long}/.local/share/svall/gateway/authority.sock is 108 bytes, past the 107 a Unix socket path holds, so its listen fails with EINVAL`,
      action: 'use an account whose home path is at most 65 bytes, on this Mac and on trift.test alike',
    });
    expect(ssh.remoteCalls().some((w) => w.includes('setup') || w.includes('cat > "$1"'))).toBe(false);
  });

  it('takes a home just short enough for the gateway\'s socket', async () => {
    const long = `/tmp/${'h'.repeat(60)}`;
    vi.stubEnv('HOME', long);
    ssh.reply(['svall-home'], { stdout: `${long}\nlinus\n` });
    healthy();
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps()).finally(() => vi.unstubAllEnvs());
    expect(step('home').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('stops on a machine that is not Ubuntu', async () => {
    healthy({ osRelease: 'ID=debian\nVERSION_ID="12"\n' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('os').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('os').at(-1)?.detail).toContain('Ubuntu');
    expect(ssh.remoteCalls().some((w) => w.includes('setup'))).toBe(false);
  });

  it('names the apt command for the packages the machine is missing', async () => {
    healthy({ tools: ['tailscale', 'git', 'systemctl', 'loginctl'] });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('tools').at(-1)).toMatchObject({ status: 'fail', action: 'ssh trift.test, then sudo apt install tmux rsync' });
    expect(ssh.remoteCalls().some((w) => w.includes('sudo'))).toBe(false);
  });

  it('warns about an rsync too old to hand a fleet over with, naming what to install, without blocking the rest of setup', async () => {
    ssh.reply(['svall-rsync'], { stdout: 'rsync  version 3.1.3  protocol version 31\n' });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('rsync').at(-1)).toMatchObject({
      status: 'warn', detail: 'the rsync there is rsync 3.1.3; a handover needs 3.2.3 or newer', action: 'ssh trift.test, then install rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship',
    });
    expect(out).toMatchObject({ result: 'actions', actions: ['ssh trift.test, then install rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship'] });
    expect(step('registry').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('warns about a tmux too old for Shift+Enter without blocking', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('tmux').at(-1)).toMatchObject({ status: 'warn' });
    expect(step('tmux').at(-1)?.detail).toContain('Shift+Enter');
    expect(out.result).toBe('ready');
  });

  it('surfaces the enable-linger command, and the machine to run it on, when lingering is off', async () => {
    const off = { status: 'warn', detail: 'off for linus: the fleet stops when you log out; loginctl enable-linger linus' };
    healthy({ linger: 'Linger=no\n', doctor: doctorJson(off) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('linger').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then loginctl enable-linger linus' });
    expect(step('service').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then loginctl enable-linger linus' });
    // both steps name the one command, which the user is left to run once
    expect(out).toEqual({ result: 'actions', actions: ['ssh trift.test, then loginctl enable-linger linus'] });
  });

  it('takes the service from a companion doctor that exits 1 over a check the service does not need', async () => {
    healthy();
    const failing = JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: 'not installed' }] });
    ssh.clearReplies();
    ssh.reply(['doctor', '--json'], { stdout: failing, code: 1 });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('service').at(-1)).toMatchObject({ status: 'ok' });
    expect(step('registry').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('names each step once, so the checklist never opens a phase twice', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    const names = events.filter((e) => e.status !== 'start').map((e) => e.step);
    expect(names).toEqual([
      'name', 'ssh', 'master', 'os', 'home', 'tools', 'tmux', 'rsync', 'space', 'linger',
      'release', 'upload', 'install', 'service', 'identity', 'claude', 'codex', 'probe', 'registry',
    ]);
  });

  it('stops at the service when the machine\'s gateway unit is not running', async () => {
    const stopped = JSON.stringify({ checks: JSON.parse(DOCTOR).checks.map((c: { name: string }) => (c.name === 'gateway'
      ? { name: 'gateway', status: 'fail', detail: 'svall-gateway.service: loaded, inactive (dead), disabled' } : c)) });
    ssh.reply(['doctor', '--json'], { stdout: stopped, code: 1 });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('service').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('svall-gateway.service') });
    expect(out.result).toBe('actions');
  });

  it('refuses an unsigned archive unless the user asked for one', async () => {
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive({ signed: false }) }, deps());
    expect(step('release').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('release').at(-1)?.detail).toContain('--allow-unsigned');
    expect(out.result).toBe('actions');
  });

  it('refuses an archive this controller\'s signers do not vouch for before anything is uploaded', async () => {
    healthy();
    const intruder = ephemeralSigner(work);
    const release = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release }, deps());
    expect(step('release').at(-1)).toMatchObject({ status: 'fail' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
    expect(out.result).toBe('actions');
  });

  it('refuses an archive that speaks another protocol', async () => {
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive({ protocol: PROTOCOL_VERSION + 1 }) }, deps());
    expect(step('release').at(-1)?.detail).toContain('protocol');
    expect(out.result).toBe('actions');
  });

  it('installs the workspace companion an unsigned development build pins, with no flag from the app', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const companion = archive({ signed: false });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(companion)).digest('hex');
    fs.mkdirSync(path.join(work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(work, 'release', 'release.json'), JSON.stringify({
      version: '1.2.3', unsigned: true, companions: { 'linux-arm64': { url: pathToFileURL(companion).href, sha256 } },
    }));
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps());
    await d.close();
    expect(step('release').at(-1)).toMatchObject({ status: 'ok', detail: expect.stringContaining('(unsigned)') });
    expect(ssh.remoteCalls().find((w) => w.includes('setup'))).toContain('--allow-unsigned');
    expect(out.result).toBe('ready');
  });

  it('holds a signed build\'s pinned companion to a signature', async () => {
    healthy();
    const companion = archive({ signed: false });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(companion)).digest('hex');
    fs.mkdirSync(path.join(work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(work, 'release', 'release.json'), JSON.stringify({
      version: '1.2.3', companions: { 'linux-arm64': { url: pathToFileURL(companion).href, sha256 } },
    }));
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps());
    expect(step('release').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('--allow-unsigned') });
    expect(out.result).toBe('actions');
  });

  it('refuses to guess a companion when the release manifest names none', async () => {
    healthy();
    fs.mkdirSync(path.join(work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(work, 'release', 'release.json'), JSON.stringify({ version: '1.2.3' }));
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps());
    expect(step('release').at(-1)?.detail).toContain('--release');
    expect(out.result).toBe('actions');
  });

  it('reports a machine it cannot reach as unreachable', async () => {
    const out = await addHost({ name: 'trift', ssh: 'refused.test', release: archive() }, deps());
    expect(step('master').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('master').at(-1)?.detail).toContain('refused.test');
    expect(out.result).toBe('actions');
  });

  it('re-runs the probes for a machine already in the registry and keeps one record', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const run = async () => {
      events = [];
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      return out;
    };
    expect((await run()).result).toBe('ready');
    expect((await run()).result).toBe('ready');
    expect(registry.list().filter((m) => m.record.name === 'trift')).toHaveLength(1);
    expect(registry.get('trift')?.id).toBe(REMOTE);
  });

  it('refuses a second ssh destination for a name already in the registry', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'other.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE, gateway: false,
    }, REMOTE);
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(step('name').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('name').at(-1)?.detail).toContain('other.test');
    expect(out.result).toBe('actions');
    expect(ssh.calls()).toEqual([]);
  });
});

describe('host doctor', () => {
  const registered = (home = HOME): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home, svallBase: BASE, gateway: false,
    }, REMOTE);
    return registry;
  };

  it('reads the companion\'s own doctor, version, linger and free space', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['systemd', 'linger', 'release', 'space']));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'ok', detail: expect.stringContaining('1.2.3') });
  });

  it('names the remote user, not the machine, when the companion reports no linger of its own', async () => {
    ssh.reply(['doctor', '--json'], { stdout: doctorJson() });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['svall-linger'], { stdout: 'Linger=no\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    const linger = report.checks.find((c) => c.name === 'linger');
    expect(linger).toMatchObject({ status: 'warn' });
    expect(linger?.detail).toContain('ssh trift.test, then loginctl enable-linger linus');
    expect(linger?.detail).not.toContain('trift:');
  });

  it('reads the report a companion doctor prints before it exits 1 for a failing check', async () => {
    const failing = JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: 'not installed in ~/.claude/settings.json: svall setup' }] });
    ssh.reply(['doctor', '--json'], { stdout: failing, code: 1 });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'hooks')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((c) => c.name === 'systemd')).toMatchObject({ status: 'ok' });
    expect(report.checks.find((c) => c.name === 'doctor')).toBeUndefined();
  });

  it('still reports a companion doctor that exits without a report', async () => {
    ssh.reply(['doctor', '--json'], { stderr: 'node: bad option\n', code: 9 });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'doctor')).toMatchObject({ status: 'fail', detail: expect.stringContaining('exited 9') });
  });

  it('checks the far account still has the home the registry records for it', async () => {
    const answer = (home: string): void => {
      ssh.clearReplies();
      ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
      ssh.reply(['svall-space'], { stdout: DF });
      ssh.reply(['svall-home'], { stdout: `${home}\nlinus\n` });
    };
    const home = async () => (await doctorHost('trift', deps({ registry: registered() }))).checks.find((c) => c.name === 'home');
    answer(HOME);
    expect(await home()).toEqual({ name: 'home', status: 'ok', detail: `${HOME} for linus` });
    answer(ELSEWHERE);
    expect(await home()).toEqual({
      name: 'home', status: 'fail',
      detail: `${ELSEWHERE} is linus's home on trift, and the registry records ${HOME}; svall host remove trift, then svall host add again at an account whose home is ${HOME}, and svall host enable trift --fleet <fleet> for each fleet it is the gateway of`,
    });
  });

  it('fails the home of a machine an earlier build registered at a home other than this Mac\'s', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${ELSEWHERE}\nlinus\n` });
    const report = await doctorHost('trift', deps({ registry: registered(ELSEWHERE) }));
    expect(report.checks.find((c) => c.name === 'home')).toEqual({
      name: 'home', status: 'fail',
      detail: `${ELSEWHERE} is linus's home on trift and ${HOME} is this Mac's; a fleet moves only between accounts with the same home path; `
        + `svall host remove trift, then svall host add again at an account whose home is ${HOME}, and svall host enable trift --fleet <fleet> for each fleet it is the gateway of`,
    });
  });

  it('reports a release the controller cannot hand over to as a failure', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '0.9.0', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'fail' });
  });
});

describe('a host command told to stop', () => {
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it.each(['SIGTERM', 'SIGQUIT'] as const)('ends the master it opened on %s rather than leaving it running', async (signal) => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE, gateway: false,
    }, REMOTE);
    registry.save();
    // the far doctor is still running when the app's Stop arrives
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR, delayMs: 15_000 });
    // plain node, as the release shim runs it: the tsx CLI turns a signal into an exit, which runs exit hooks
    const root = path.resolve(import.meta.dirname, '../../..');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'packages/cli/src/main.ts'), 'host', 'doctor', 'trift', '--json'], {
      cwd: root, env: { ...process.env, SVALL_CONFIG_DIR: config }, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => { child.on('close', resolve); });
    await waitFor(() => ssh.remoteCalls().some((w) => w.includes('doctor')), 30_000);
    const state = path.join(ssh.dir, 'state');
    const [marker] = fs.readdirSync(state).filter((f) => f.endsWith('.master'));
    const master = Number(fs.readFileSync(path.join(state, marker), 'utf8'));
    expect(alive(master)).toBe(true);

    child.kill(signal);
    await exited;
    await waitFor(() => !alive(master), 5000);
  });
});

describe('host upgrade', () => {
  const registered = (): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE, gateway: false,
    }, REMOTE);
    return registry;
  };

  /**
   * A companion on this machine: every far command runs here, `current` is a real link, and each release's svall is a
   * script that answers as that release. Its setup installs an archive and keeps it only while the new release's daemon
   * comes up (no `down-<release>` file beside the releases) and speaks the protocol this svall's client does.
   */
  async function farMachine(o: { releases: [string, number][]; accepts?: (release: string) => boolean; pins?: string }) {
    const home = path.join(work, 'far');
    const base = `${home}/.local/share/svall`;
    const now = () => path.basename(fs.readlinkSync(`${base}/current`));
    const d = await daemon({ release: now, accepts: () => o.accepts?.(now()) ?? true });
    const svall = (version: string, protocol: number) => `#!/bin/sh
base='${base}'
now() { basename "$(readlink "$base/current")"; }
case "$1" in
  connection-info) printf '%s\\n' '${JSON.stringify({ fleetId: FLEET, machineId: REMOTE, release: version, protocol, host: '127.0.0.1', port: d.port, token: TOKEN })}' ;;
  version) printf '%s\\n' '${JSON.stringify({ release: version, machineId: REMOTE, protocol }, null, 2)}' ;;
  doctor) printf '%s\\n' '${DOCTOR}' ;;
  setup)
    if [ "$2" = --rollback ]; then
      to=\${3:-$(ls -t "$base/releases" | grep -vx "$(now)" | head -1)}
      [ -n "$to" ] || { echo "no release under $base/releases to go back to" >&2; exit 1; }
      [ -d "$base/releases/$to" ] || { echo "no release at $base/releases/$to to go back to" >&2; exit 1; }
      ln -sfn "$base/releases/$to" "$base/current" && echo "current -> $base/releases/$to"
      exit
    fi
    was=$(now)
    new=$(tar -tzf "$3" | sed -n 's|^releases/\\([^/]*\\)/.*|\\1|p' | head -1)
    tar -xzf "$3" -C "$base" && ln -sfn "$base/releases/$new" "$base/current" && echo "release $new -> $base/releases/$new"
    if [ -e "$base/down-$new" ] || ! grep -q '"protocol": ${protocol},' "$base/releases/$new/release.json"; then
      ln -sfn "$base/releases/$was" "$base/current" && echo "the daemon did not answer: current -> $base/releases/$was"
    fi ;;
esac
`;
    for (const [version, protocol] of o.releases) {
      fs.mkdirSync(`${base}/releases/${version}/bin`, { recursive: true });
      fs.writeFileSync(`${base}/releases/${version}/bin/svall`, svall(version, protocol), { mode: 0o755 });
      fs.mkdirSync(`${base}/releases/${version}/release`);
      fs.copyFileSync(o.pins ?? signer.signers, `${base}/releases/${version}/release/allowed_signers`);
    }
    fs.symlinkSync(`${base}/releases/${o.releases.at(-1)![0]}`, `${base}/current`);
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home, svallBase: base, gateway: false }, REMOTE);
    ssh.execute({ rsync: '/usr/bin/rsync' });
    return { base, now, registry, close: d.close, svall, archive: companionArchive(work, { signedBy: signer.key, svall: svall('1.2.3', PROTOCOL_VERSION) }) };
  }

  it('installs a release that speaks a newer protocol with its own setup, and keeps it', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION - 1]] });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.3');
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    const setup = ssh.remoteCalls().find((w) => w.includes('setup'))!;
    expect(setup[0]).toBe(`${work}/far/.cache/svall/staging-1.2.3/releases/1.2.3/bin/svall`);
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
  });

  it('checks the new release against the signers the installed release pins, with the far machine\'s own tools', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('install').at(-1)?.detail).toContain(`signed by a key ${far.base}/current/release/allowed_signers pins`);
    const verify = ssh.remoteCalls().findIndex((w) => w.includes('svall-unpack'));
    const setup = ssh.remoteCalls().findIndex((w) => w.includes('setup'));
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(setup);
  });

  it('refuses a release the installed release\'s signers do not vouch for, before anything it carries runs', async () => {
    // a controller that trusts another key, as one whose own signers were replaced would
    const intruder = ephemeralSigner(work);
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = path.join(work, 'staged-svall-ran');
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const out = await upgradeHost('trift', { release: archive }, deps({ registry: far.registry, verify: intruder.verify }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('install').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`not signed by a key ${far.base}/current/release/allowed_signers pins`) });
    expect(fs.existsSync(ran)).toBe(false);
    expect(ssh.remoteCalls().some((w) => w.includes('setup'))).toBe(false);
    expect(far.now()).toBe('1.2.2');
  });

  it('checks with the system\'s own tools, whatever a relative entry in the far PATH finds in the upload first', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = path.join(work, 'shim-ran');
    const shim = `#!/bin/sh\necho "$0" >> '${ran}'\nexit 0\n`;
    const archive = companionArchive(work, {
      signedBy: signer.key, svall: far.svall('1.2.3', PROTOCOL_VERSION),
      files: Object.fromEntries(['grep', 'ssh-keygen', 'sha256sum', 'tar'].map((t) => [`node_modules/.bin/${t}`, shim])),
    });
    ssh.execute({ rsync: '/usr/bin/rsync', path: `node_modules/.bin:${process.env.PATH}` });
    const out = await upgradeHost('trift', { release: archive }, deps({ registry: far.registry }));
    await far.close();
    expect(fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '').toBe('');
    expect(out.result).toBe('ready');
    expect(step('install').at(-1)?.detail).toContain(`signed by a key ${far.base}/current/release/allowed_signers pins`);
  });

  it('refuses a release when the installed release has lost its signers file, rather than taking it for one that pins none', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    fs.rmSync(`${far.base}/releases/1.2.2/release/allowed_signers`);
    const intruder = ephemeralSigner(work);
    const ran = path.join(work, 'staged-svall-ran');
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const out = await upgradeHost('trift', { release: archive }, deps({ registry: far.registry, verify: intruder.verify }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('install').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`${far.base}/current/release/allowed_signers is missing`) });
    expect(fs.existsSync(ran)).toBe(false);
    expect(far.now()).toBe('1.2.2');
  });

  it('holds a repeat host add over an installed release to the signers that release pins, as an upgrade is', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    // this Mac's home is the far one, so the paths host add builds from it land in the far machine's
    const config = path.join(work, 'config');
    const file = path.join(config, 'machines.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { machines: Record<string, { home: string }> };
    saved.machines[far.registry.localId].home = path.join(work, 'far');
    fs.writeFileSync(file, JSON.stringify(saved));
    for (const [match, stdout] of [
      [['uname', '-sm'], 'Linux aarch64\n'], [['cat', '/etc/os-release'], OS_RELEASE], [['svall-home'], `${work}/far\nlinus\n`],
      [['svall-tools'], ['tailscale', 'tmux', 'git', 'rsync', 'systemctl', 'loginctl'].map((t) => `${t} yes\n`).join('')],
      [['tmux', '-V'], 'tmux 3.4\n'], [['svall-rsync'], 'rsync  version 3.2.7  protocol version 31\n'], [['svall-space'], DF], [['svall-linger'], 'Linger=yes\n'],
    ] as [string[], string][]) ssh.reply(match, { stdout });
    const intruder = ephemeralSigner(work);
    const ran = path.join(work, 'staged-svall-ran');
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive }, deps({ registry: MachineRegistry.load(config), verify: intruder.verify }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('install').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`not signed by a key ${far.base}/current/release/allowed_signers pins`) });
    expect(fs.existsSync(ran)).toBe(false);
    expect(far.now()).toBe('1.2.2');
  });

  it('says when a machine has no release installed to pin a signer, so only this controller\'s signers vouched for the new one', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    const out = await bootstrapSetup(master, {
      staging: `${work}/fresh/.cache/svall/staging-1.2.3`, archive: far.archive, version: '1.2.3', allowUnsigned: false,
      installed: `${work}/fresh/.local/share/svall`,
    });
    await master.close();
    await far.close();
    expect(out).toContain('no release is installed there yet, so only this controller\'s signers vouched for it');
  });

  it('says when the installed release pins no signer, so only this controller\'s signers vouched for the new one', async () => {
    const unpinned = path.join(work, 'no-signers');
    fs.writeFileSync(unpinned, '# no release key is committed yet\n');
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: unpinned });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('ready');
    expect(step('install').at(-1)?.detail).toContain('the installed release pins no signer, so only this controller\'s signers vouched for it');
  });

  it('checks an unsigned release with --allow-unsigned by its digests alone, and refuses one whose files do not match them', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const archive = companionArchive(work, { svall: far.svall('1.2.3', PROTOCOL_VERSION) });
    const out = await upgradeHost('trift', { release: archive, allowUnsigned: true }, deps({ registry: far.registry }));
    expect(out.result).toBe('ready');
    expect(step('install').at(-1)?.detail).toContain('unsigned, checked by its digests alone');

    // the same archive with a file changed after its manifest was written
    const tree = fs.mkdtempSync(path.join(work, 'tampered-'));
    execFileSync('tar', ['-xzf', archive, '-C', tree]);
    fs.appendFileSync(path.join(tree, 'releases', '1.2.3', 'bin', 'svall'), '# changed\n');
    const tampered = path.join(work, 'tampered.tar.gz');
    execFileSync('tar', ['-czf', tampered, '-C', tree, 'releases']);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    await expect(bootstrapSetup(master, {
      staging: `${work}/far/.cache/svall/staging-x`, archive: tampered, version: '1.2.3', allowUnsigned: true, installed: far.base,
    })).rejects.toThrow(/SHA256SUMS/);
    await master.close();
    await far.close();
  });

  it('checks the signature over an upgrade\'s SHA256SUMS before it unpacks anything else the archive holds', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const archive = companionArchive(work, { signedBy: ephemeralSigner(work).key });
    const staging = `${work}/far/.cache/svall/staging-1.2.3`;
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    // what the staging folder holds when the check has refused, read just before it is removed
    let unpacked: string[] = [];
    const watched = {
      run: (argv: string[], o?: Parameters<SshMaster['run']>[1]) => {
        if (argv[0] === 'rm') unpacked = fs.readdirSync(staging, { recursive: true }).map(String).sort();
        return master.run(argv, o);
      },
    } as SshMaster;
    await expect(bootstrapSetup(watched, { staging, archive, version: '1.2.3', allowUnsigned: false, installed: far.base })).rejects.toThrow(/not signed by a key/);
    await master.close();
    await far.close();
    expect(unpacked).toEqual(['releases', 'releases/1.2.3', 'releases/1.2.3/SHA256SUMS', 'releases/1.2.3/SHA256SUMS.sig']);
  });

  it('refuses a release the pinned key signed that arrives under another release\'s name, before anything it carries runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = path.join(work, 'staged-svall-ran');
    const older = companionArchive(work, { version: '1.2.1', signedBy: signer.key, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const tree = fs.mkdtempSync(path.join(work, 'renamed-'));
    execFileSync('tar', ['-xzf', older, '-C', tree]);
    fs.renameSync(path.join(tree, 'releases', '1.2.1'), path.join(tree, 'releases', '1.2.3'));
    const renamed = path.join(work, 'renamed.tar.gz');
    execFileSync('tar', ['-czf', renamed, '-C', tree, 'releases']);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    await expect(bootstrapSetup(master, {
      staging: `${work}/far/.cache/svall/staging-1.2.3`, archive: renamed, version: '1.2.3', allowUnsigned: false, installed: far.base,
    })).rejects.toThrow(/release\.json does not name release 1\.2\.3/);
    await master.close();
    await far.close();
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('refuses an archive that gives the far check one SHA256SUMS to verify and another to check the files by, before anything it carries runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = (name: string): string => path.join(work, `ran-${name}`);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    for (const { name, archive } of smuggling(ran)) {
      const out = bootstrapSetup(master, {
        staging: `${work}/far/.cache/svall/staging-1.2.3`, archive, version: '1.2.3', allowUnsigned: false, installed: far.base,
      });
      // a link is the system tar's to refuse or to write through; the far check refuses what it wrote either way
      await expect(out, name).rejects.toThrow(name === 'link' ? /./ : /^the uploaded archive holds .*(is not a path in releases\/1\.2\.3|twice)$/);
      expect(fs.existsSync(ran(name)), name).toBe(false);
    }
    await master.close();
    await far.close();
    expect(far.now()).toBe('1.2.2');
  });

  it('puts a new release that does not answer back on the release the machine ran before, and says which it runs', async () => {
    // an older release is the newest by mtime, which is where a rollback that names nothing would go
    const far = await farMachine({ releases: [['1.2.1', PROTOCOL_VERSION], ['1.2.2', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    fs.utimesSync(`${far.base}/releases/1.2.1`, new Date(), new Date(Date.now() + 60_000));
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(far.now()).toBe('1.2.2');
    expect(ssh.remoteCalls()).toContainEqual([`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback', '1.2.2']);
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn', action: expect.stringMatching(/trift runs release 1\.2\.2, the one it ran before$/) });
  });

  it('after a reinstall under the name it ran, goes back to the newest release kept there, and never calls the new tree the one it ran before', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(far.now()).toBe('1.2.2');
    expect(ssh.remoteCalls()).toContainEqual([`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback']);
    const action = step('rollback').at(-1)?.action ?? '';
    expect(action).toMatch(/trift ran a release named 1\.2\.3 before, which this install replaced; it runs release 1\.2\.2, the newest one kept there$/);
  });

  it('after a reinstall under the only name it had, says no other release is kept to go back to', async () => {
    const far = await farMachine({ releases: [['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('rollback').at(-1)).toMatchObject({ status: 'fail', action: expect.stringMatching(/no other release is kept there, so it runs the new one$/) });
  });

  it('counts a new release whose own setup put the old one back as not answering, and says which the machine runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    fs.writeFileSync(`${far.base}/down-1.2.3`, '');
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'warn', detail: expect.stringContaining('1.2.2') });
    expect(far.now()).toBe('1.2.2');
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn', action: expect.stringMatching(/trift runs release 1\.2\.2, the one it ran before$/) });
  });

  const gatewayDown = JSON.stringify({ checks: JSON.parse(DOCTOR).checks.map((c: { name: string }) => (c.name === 'gateway'
    ? { name: 'gateway', status: 'fail', detail: 'svall-gateway.service: loaded, inactive (dead), disabled' } : c)) });

  it('puts a new release whose gateway unit is not running back on the release before, though its daemon answers', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    ssh.reply(['doctor', '--json'], { stdout: gatewayDown, code: 1 });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'warn', detail: expect.stringContaining('svall-gateway.service') });
    expect(far.now()).toBe('1.2.2');
  });

  it('fails a rollback whose gateway unit is not running after it, and says which release the machine runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    ssh.reply(['doctor', '--json'], { stdout: gatewayDown, code: 1 });
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('svall-gateway.service'), action: expect.stringContaining('trift runs release 1.2.2') });
  });

  it('puts the machine back on the release before when asked, with its own svall, and probes it as an upgrade does', async () => {
    const far = await farMachine({ releases: [['1.2.1', PROTOCOL_VERSION], ['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    fs.utimesSync(`${far.base}/releases/1.2.1`, new Date(0), new Date(0));
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    const named = await rollbackHost('trift', { to: '1.2.1' }, deps({ registry: far.registry }));
    await far.close();
    expect([out, named]).toEqual([{ result: 'ready', actions: [] }, { result: 'ready', actions: [] }]);
    expect(ssh.remoteCalls().filter((w) => w.includes('--rollback'))).toEqual([
      [`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback'],
      [`${far.base}/releases/1.2.2/bin/svall`, 'setup', '--rollback', '1.2.1'],
    ]);
    expect(far.now()).toBe('1.2.1');
    expect(step('probe').map((e) => e.detail)).toEqual(['trift answers on release 1.2.2', 'trift answers on release 1.2.1']);
  });

  it('rolls back from the command line, and refuses a rollback asked with a release to install', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    far.registry.save();
    const { hostCommands } = await import('../src/commands/host.js');
    const cli = () => hostCommands(() => true, () => path.join(work, 'config'));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await cli().parseAsync(['upgrade', 'trift', '--rollback'], { from: 'user' });
      await expect(cli().parseAsync(['upgrade', 'trift', '--rollback', '--release', far.archive], { from: 'user' })).rejects.toThrow(/--rollback/);
    } finally {
      out.mockRestore();
      await far.close();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(far.now()).toBe('1.2.2');
  });

  it('says which release the machine runs when a rollback fails or its daemon does not answer after it', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.2' });
    const silent = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    const none = await rollbackHost('trift', { to: '1.0.0' }, deps({ registry: far.registry }));
    await far.close();
    expect(silent.result).toBe('actions');
    expect(step('probe')[0]).toMatchObject({ status: 'fail', action: expect.stringContaining('trift runs release 1.2.2') });
    expect(none.result).toBe('actions');
    expect(step('rollback').at(-1)).toMatchObject({ status: 'fail', action: expect.stringContaining('trift runs release 1.2.2') });
  });

  it('keeps a new release whose companion doctor exits 1 over a check unrelated to the daemon', async () => {
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: doctorJson({ status: 'warn', detail: 'off' }).replace('"tmux 3.4"}', '"tmux 3.4"},{"name":"hooks","status":"fail","detail":"not installed"}'), code: 1 });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    await d.close();
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok' });
    expect(out.result).toBe('ready');
  });

  it('uploads and installs nothing on a machine that answers as another than the registry names', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.2', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(step('master').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`now reaches machine ${OTHER_MAC}`) });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
  });

  it('deletes the archive it uploaded and the release it unpacked once the release is installed', async () => {
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    await d.close();
    expect(ssh.remoteCalls()).toContainEqual(['rm', '-rf', `${HOME}/.cache/svall/staging-1.2.3`, `${HOME}/.cache/svall/companion-1.2.3.tar.gz`]);
  });
});

describe('host remove', () => {
  const registered = (destination: string): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: destination, platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE, gateway: false,
    }, REMOTE);
    return registry;
  };

  it('uninstalls on the machine before the route is dropped, forcing past no refusal, and never purges', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls()).toEqual([[SVALL, 'version', '--json'], [SVALL, 'uninstall']]);
    expect(registry.get('trift')).toBeUndefined();
  });

  it('uninstalls nothing on a machine that answers as another than the registry names, as an alias that now leads elsewhere', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`) });
    expect(ssh.remoteCalls().some((w) => w.includes('uninstall'))).toBe(false);
    expect(registry.get('trift')).toBeDefined();
  });

  it('keeps the route for a machine it cannot reach', async () => {
    const registry = registered('refused.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(registry.get('trift')).toBeDefined();
    expect(step('uninstall').at(-1)?.action).toContain('--forget');
  });

  it('forgets a machine it could reach without touching it', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const out = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(registry.get('trift')).toBeUndefined();
    expect(ssh.calls()).toEqual([]);
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'skip' });
    expect(out.actions.join(' ')).toContain('trift.test');
  });

  const fleetAt = (name: string, o: { gateway?: string; owner?: string } = {}): string => {
    const home = path.join(work, name);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, ...(o.gateway ? { gatewayMachineId: o.gateway } : {}) }));
    if (o.owner) fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: FLEET, generation: 2, ownerMachineId: o.owner }));
    return home;
  };
  const gatewayOf = (home: string): string | undefined =>
    (JSON.parse(fs.readFileSync(path.join(home, 'fleet.json'), 'utf8')) as { gatewayMachineId?: string }).gatewayMachineId;

  it('refuses to strand a fleet another machine owns through this gateway, and names its home', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const away = fleetAt('.svall-lab', { gateway: REMOTE, owner: OTHER_MAC });
    for (const forget of [false, true]) {
      const out = await removeHost('trift', { forget }, deps({ registry }));
      expect(out.result).toBe('actions');
      expect(step('fleet').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(away) });
      expect(registry.get('trift')).toBeDefined();
    }
    expect(ssh.calls()).toEqual([]);
    expect(gatewayOf(away)).toBe(REMOTE);
  });

  it('refuses to uninstall a machine that owns a fleet through another gateway, and names the handover that brings it back', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const there = fleetAt('.svall-lab', { gateway: OTHER_MAC, owner: REMOTE });
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('fleet').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(there) });
    expect(out.actions.join('\n')).toContain('`svall -p lab handover local`');
    expect(ssh.calls()).toEqual([]);
    expect(registry.get('trift')).toBeDefined();
    expect(gatewayOf(there)).toBe(OTHER_MAC);
  });

  it('names the handover that brings a stranded fleet back, profile and all, before the machine can go', async () => {
    const registry = registered('trift.test');
    fleetAt('.svall-lab', { gateway: REMOTE, owner: OTHER_MAC });
    fleetAt('.svall', { gateway: REMOTE, owner: OTHER_MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    const said = out.actions.join('\n');
    expect(said).toContain('`svall handover local`');
    expect(said).toContain('`svall -p lab handover local`');
    expect(said).toContain('then `svall host remove trift`');
    expect(said).not.toMatch(/disable handover/);
  });

  it('refuses while the gateway holds a handover of a fleet open, and names how to settle it', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    // this Mac froze for a handover to trift, which may by now have committed it there
    const frozen = fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    fs.mkdirSync(path.join(frozen, 'handover'));
    fs.writeFileSync(path.join(frozen, 'handover', 'journal.json'), JSON.stringify({
      role: 'source', transactionId: 'tx-1', generation: 2, fleetId: FLEET, fromMachineId: MAC, toMachineId: REMOTE, phase: 'freeze', updatedAt: 1,
    }));
    // begun from this Mac, before any daemon froze
    const begun = fleetAt('.svall-lab', { gateway: REMOTE, owner: MAC });
    fs.mkdirSync(path.join(begun, 'controller'));
    fs.writeFileSync(path.join(begun, 'controller', 'handover.json'), JSON.stringify({
      version: 1, fleetId: FLEET, transactionId: 'tx-2', generation: 2, source: { machineId: MAC, name: 'mac' }, destination: { machineId: REMOTE, name: 'trift', ssh: 'trift.test' },
      choices: {}, phase: 'begin', startedAt: 1, updatedAt: 1,
    }));
    for (const forget of [false, true]) {
      const out = await removeHost('trift', { forget }, deps({ registry }));
      expect(out.result).toBe('actions');
      const failed = step('fleet').at(-1);
      expect(failed).toMatchObject({ status: 'fail', detail: expect.stringContaining('holds open') });
      for (const home of [frozen, begun]) expect(failed?.detail).toContain(home);
      const said = out.actions.join('\n');
      for (const cmd of ['`svall handover --resume`', '`svall handover --abort`', '`svall -p lab handover --resume`', '`svall -p lab handover status`', 'then `svall host remove trift`']) {
        expect(said).toContain(cmd);
      }
      expect(registry.get('trift')).toBeDefined();
    }
    expect(ssh.calls()).toEqual([]);
    expect(gatewayOf(frozen)).toBe(REMOTE);
    expect(gatewayOf(begun)).toBe(REMOTE);
  });

  it('refuses while a handover through another gateway holds a fleet open, as it may by now have left the fleet on this machine', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    // committed on the other gateway to trift, and this Mac's controller stopped before it learnt so
    const through = fleetAt('.svall-lab', { gateway: OTHER_MAC, owner: MAC });
    fs.mkdirSync(path.join(through, 'controller'));
    fs.writeFileSync(path.join(through, 'controller', 'handover.json'), JSON.stringify({
      version: 1, fleetId: FLEET, transactionId: 'tx-3', generation: 2, source: { machineId: MAC, name: 'mac' }, destination: { machineId: REMOTE, name: 'trift', ssh: 'trift.test' },
      choices: {}, phase: 'commit', startedAt: 1, updatedAt: 1,
    }));
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('fleet').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(through) });
    expect(step('fleet').at(-1)?.detail).toContain('holds open');
    expect(out.actions.join('\n')).toContain('`svall -p lab handover --resume`');
    expect(ssh.calls()).toEqual([]);
    expect(registry.get('trift')).toBeDefined();
    expect(gatewayOf(through)).toBe(OTHER_MAC);
  });

  it('lets the gateway go once the handover that brought a fleet here has completed, though the record it left names that handover', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.svall', { gateway: REMOTE });
    fs.writeFileSync(path.join(mine, 'owner.json'), JSON.stringify({
      fleetId: FLEET, generation: 3, ownerMachineId: MAC, transaction: { id: 'tx-1', fromMachineId: REMOTE, toMachineId: MAC, phase: 'committed', startedAt: 1 },
    }));
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(gatewayOf(mine)).toBeUndefined();
  });

  it('forces the far uninstall past the gateway records of only the fleets it checked, those naming the machine as gateway', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    const other = fleetAt('.svall-other', { gateway: OTHER_MAC, owner: MAC });
    fs.writeFileSync(path.join(other, 'fleet.json'), JSON.stringify({ id: OTHER_FLEET, gatewayMachineId: OTHER_MAC }));
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls().at(-1)).toEqual([SVALL, 'uninstall', '--force-fleet', FLEET]);
  });

  it('reports the far refusal, with its reason, of what this Mac cannot see, and keeps the route and the fleet\'s gateway', async () => {
    const why = 'uninstalling here would strand fleets: this machine is the gateway of 1 fleet, whose records are in /home/linus/.local/share/svall/gateway/fleets. Finish or abort the handover';
    ssh.reply(['uninstall'], { stderr: `svall: ${why}\n`, code: 3 });
    const registry = registered('trift.test');
    const mine = fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    const failed = step('uninstall').at(-1);
    expect(failed).toMatchObject({ status: 'fail', detail: expect.stringContaining(why) });
    expect(failed?.detail).not.toContain('could not be reached');
    expect(failed?.action).toContain('svall handover local');
    expect(failed?.action).toContain('ssh trift.test, then svall uninstall --force');
    expect(failed?.action).toContain('svall host remove trift --forget');
    expect(registry.get('trift')).toBeDefined();
    expect(gatewayOf(mine)).toBe(REMOTE);
  });

  it('takes the gateway out of a fleet this Mac owns as the machine goes', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    const untouched = fleetAt('.svall-other', { gateway: OTHER_MAC, owner: OTHER_MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(gatewayOf(mine)).toBeUndefined();
    expect(gatewayOf(untouched)).toBe(OTHER_MAC);
    expect(registry.get('trift')).toBeUndefined();
  });

  it('drops the gateway from fleet.json as it lies, through a link, keeping its own keys and mode and writing no defaults', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    const real = path.join(work, 'dotfiles-fleet.json');
    fs.writeFileSync(real, JSON.stringify({ id: FLEET, gatewayMachineId: REMOTE, custom: 1 }), { mode: 0o640 });
    fs.rmSync(path.join(mine, 'fleet.json'));
    fs.symlinkSync(real, path.join(mine, 'fleet.json'));
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(fs.lstatSync(path.join(mine, 'fleet.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ id: FLEET, custom: 1 });
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });

  it('forgets an unreachable machine and says the remote was left alone', async () => {
    const registry = registered('refused.test');
    const out = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(registry.get('trift')).toBeUndefined();
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'skip' });
    expect(out.actions.join(' ')).toContain('refused.test');
  });
});

describe('host enable', () => {
  const registered = (destination = 'trift.test'): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: destination, platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE, gateway: false,
    }, REMOTE);
    return registry;
  };

  const fleetHome = (): string => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));
    return home;
  };

  const written = (home: string): { gatewayMachineId?: string } =>
    JSON.parse(fs.readFileSync(path.join(home, 'fleet.json'), 'utf8')) as { gatewayMachineId?: string };

  /** What `svall gateway owner` on the far side answers: a record, or a refusal it exits non-zero on. */
  const answers = (record: Partial<{ generation: number; ownerMachineId: string }>): { stdout: string } =>
    ({ stdout: `${JSON.stringify({ result: { record: { fleetId: FLEET, generation: 0, ownerMachineId: MAC, ...record } } })}\n` });
  const refuses = (code: string, message: string): { stdout: string; code: number } =>
    ({ stdout: `${JSON.stringify({ error: { code, message } })}\n`, code: 1 });

  const ownerCalls = (): string[][] => ssh.remoteCalls().filter((w) => w.includes('owner'));

  /** What `svall fleet provision` on the far side answers once the machine holds its copy of the fleet. */
  const provisioned = (outcome = 'held'): { stdout: string } =>
    ({ stdout: `${JSON.stringify({ outcome, home: `${HOME}/.svall-work`, unit: 'svall-svalld@work.service' })}\n` });

  it('asks for and makes no ownership record on a machine that answers as another than the registry names', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
    ssh.reply(['owner', 'get'], answers({}));
    const home = fleetHome();
    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(step('authority').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`now reaches machine ${OTHER_MAC}`) });
    expect(ownerCalls()).toEqual([]);
    expect(written(home).gatewayMachineId).toBeUndefined();
  });

  it('reads which machine answers past whatever its login shell prints first, and makes no record on another', async () => {
    ssh.reply(['version', '--json'], { stdout: `Welcome to other\n${JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2)}\n` });
    ssh.reply(['owner', 'get'], answers({}));
    const home = fleetHome();
    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(step('authority').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`now reaches machine ${OTHER_MAC}`) });
    expect(ownerCalls()).toEqual([]);
    expect(written(home).gatewayMachineId).toBeUndefined();
  });

  it('makes the record and the copy of the fleet over the one master whose machine it checked', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned());
    const out = await enableHost('trift', { fleetHome: fleetHome() }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(ssh.calls().filter((c) => c.includes('-M'))).toHaveLength(1);
    expect(ssh.remoteCalls().map((w) => w.slice(1).filter((a) => ['version', 'owner', 'provision'].includes(a))[0])).toEqual(['version', 'owner', 'provision']);
  });

  it('gives the machine its copy of the fleet under the profile the controller reaches it by, before it names the gateway', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned('rekeyed'));
    const home = path.join(work, '.svall-work');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls().filter((w) => w.includes('provision'))).toEqual([
      [SVALL, '-p', 'work', 'fleet', 'provision', '--id', FLEET, '--gateway', REMOTE, '--json'],
    ]);
    expect(step('fleet').at(-1)?.detail).toContain(`${HOME}/.svall-work`);
    expect(written(home).gatewayMachineId).toBe(REMOTE);
  });

  it('names the far fleet home that holds another fleet in use, and leaves fleet.json and the registry alone', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    const said = `${HOME}/.svall holds fleet 47a74455-7dbc-46c0-8076-30d830cf4f72, and it holds 3 characters, so it is not this fleet's to replace`;
    ssh.reply(['fleet', 'provision'], { stderr: `svall: ${said}\n`, code: 3 });
    const home = fleetHome();

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(step('fleet').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(said), action: expect.stringContaining('aside') });
    expect(out.actions.join(' ')).toContain('trift.test');
    expect(written(home).gatewayMachineId).toBeUndefined();
    expect(MachineRegistry.load(path.join(work, 'config')).get('trift')).toBeUndefined();
  });

  it('never tells the user to move the far fleet home aside for a failure that is not a refusal', async () => {
    for (const [reply, said] of [
      [{ stderr: "error: unknown command 'provision'\n", code: 1 }, "unknown command 'provision'"],
      [{ stderr: 'svall: systemctl --user enable --now svall-svalld@private.service: failed\n', code: 1 }, 'systemctl'],
    ] as const) {
      ssh.clearReplies();
      events = [];
      ssh.reply(['owner', 'get'], answers({}));
      ssh.reply(['fleet', 'provision'], reply);
      const home = fleetHome();
      const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
      expect(step('fleet').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(said) });
      expect(step('fleet').at(-1)?.action).toBeUndefined();
      expect(out.actions.join(' ')).not.toContain('aside');
      expect(written(home).gatewayMachineId).toBeUndefined();
    }
  });

  it('creates the generation-zero record with this Mac as owner before it names the gateway', async () => {
    ssh.reply(['owner', 'get'], refuses('not_found', `the gateway holds no record for fleet ${FLEET}`));
    ssh.reply(['owner', 'create'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned());
    const home = fleetHome();

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(ownerCalls()).toEqual([
      [SVALL, 'gateway', 'owner', 'get', '--fleet', FLEET],
      [SVALL, 'gateway', 'owner', 'create', '--fleet', FLEET, '--params', JSON.stringify({ initialOwnerMachineId: MAC })],
    ]);
    expect(written(home).gatewayMachineId).toBe(REMOTE);
  });

  it('names the gateway in fleet.json as it lies, through a link, keeping its own keys and mode and writing no defaults', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned());
    const home = fleetHome();
    const real = path.join(work, 'dotfiles-fleet.json');
    fs.writeFileSync(real, JSON.stringify({ id: FLEET, custom: { kept: true } }), { mode: 0o640 });
    fs.rmSync(path.join(home, 'fleet.json'));
    fs.symlinkSync(real, path.join(home, 'fleet.json'));

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(fs.lstatSync(path.join(home, 'fleet.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ id: FLEET, custom: { kept: true }, gatewayMachineId: REMOTE });
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });

  it('marks the machine a gateway in the registry', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned());
    const home = fleetHome();

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(MachineRegistry.load(path.join(work, 'config')).get('trift')?.record.gateway).toBe(true);
  });

  it('takes a record that already names this Mac as owner and creates nothing', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned());
    const home = fleetHome();

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(ownerCalls()).toEqual([[SVALL, 'gateway', 'owner', 'get', '--fleet', FLEET]]);
    expect(written(home).gatewayMachineId).toBe(REMOTE);
  });

  it('refuses a fleet another machine holds, naming the owner and generation, and leaves fleet.json alone', async () => {
    ssh.reply(['owner', 'get'], answers({ generation: 3, ownerMachineId: OTHER_MAC }));
    const home = fleetHome();

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    const failure = step('authority').at(-1);
    expect(failure).toMatchObject({ status: 'fail' });
    expect(failure?.detail).toContain(OTHER_MAC);
    expect(failure?.detail).toContain('generation 3');
    expect(step('fleet')).toEqual([]);
    expect(written(home).gatewayMachineId).toBeUndefined();
  });

  it('names the repair when the authority cannot read the record, and leaves fleet.json alone', async () => {
    ssh.reply(['owner', 'get'], refuses('authority_corrupt', `the record for fleet ${FLEET} is unreadable`));
    const home = fleetHome();

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(step('authority').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('unreadable') });
    expect(out.actions.join(' ')).toContain('trift.test');
    expect(step('fleet')).toEqual([]);
    expect(written(home).gatewayMachineId).toBeUndefined();
  });

  it('refuses a fleet whose fleet.json names another gateway still in the registry, and asks nothing of either', async () => {
    const registry = registered();
    registry.add({ name: 'studio', ssh: 'studio.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE, gateway: true }, OTHER_MAC);
    const home = fleetHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: OTHER_MAC }));

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('names studio as its gateway') });
    expect(out.actions.join(' ')).toContain('fleet recover --force-owner local --gateway trift');
    expect(ssh.calls()).toEqual([]);
    expect(written(home).gatewayMachineId).toBe(OTHER_MAC);
  });

  it('takes over from a gateway the registry no longer holds, as one set up again under its name is', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned());
    const home = fleetHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: OTHER_MAC }));
    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(written(home).gatewayMachineId).toBe(REMOTE);
  });

  it('leaves fleet.json alone when the gateway cannot be reached at all', async () => {
    const home = fleetHome();
    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered('refused.test') }));
    expect(out.result).toBe('actions');
    expect(step('authority').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('fleet')).toEqual([]);
    expect(written(home).gatewayMachineId).toBeUndefined();
  });

  it('refuses a --fleet that is not a profile name before it writes anything', async () => {
    const { hostCommands } = await import('../src/commands/host.js');
    await expect(hostCommands(() => true, () => path.join(work, 'config'))
      .parseAsync(['enable', 'trift', '--fleet', '../../escape'], { from: 'user' }))
      .rejects.toThrow(/invalid profile name/);
  });

  it('refuses a machine that is not in the registry', async () => {
    const home = fleetHome();
    const out = await enableHost('nowhere', { fleetHome: home }, deps());
    expect(out.result).toBe('actions');
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail' });
  });
});

// GNU tar writes a member spelled another way, or one under a link, over a file it extracted by name, where the Mac's
// bsdtar matches every spelling and refuses the link, so these run on a Linux image such as svall-it:machine
const gnuTar = process.env.SVALL_TEST_GNU_TAR;

describe.skipIf(!gnuTar)('the far check under GNU tar (set SVALL_TEST_GNU_TAR=<docker image> to run)', () => {
  const box = `svall-far-check-${crypto.randomBytes(3).toString('hex')}`;
  const base = '/root/.local/share/svall';
  const docker = (argv: string[], input?: string | Uint8Array) => runProcess('docker', argv, { timeoutMs: 60_000, input });
  // each far command runs in the container as its login shell would split the line ssh hands it
  const far = { run: (argv: string[], o: { input?: string | Uint8Array } = {}) => docker(['exec', '-i', box, 'sh', '-c', argv.join(' ')], o.input) } as SshMaster;

  beforeAll(async () => {
    const r = await docker(['run', '-d', '--rm', '--name', box, gnuTar!, 'sleep', '900']);
    expect(r.stderr).toBe('');
  });
  afterAll(async () => { await docker(['rm', '-f', box]); });

  it('checks the files against the SHA256SUMS the pinned key signed, whatever the archive writes over it', async () => {
    const pinned = `mkdir -p ${base}/releases/1.2.2/release && cat > ${base}/releases/1.2.2/release/allowed_signers && ln -sfn ${base}/releases/1.2.2 ${base}/current`;
    expect((await far.run(['sh', '-c', shq(pinned)], { input: fs.readFileSync(signer.signers) })).code).toBe(0);
    const { bootstrapSetup, uploadArchive } = await import('../src/controller/install.js');
    const install = async (archive: string): Promise<string> => {
      const remote = `/root/uploads/${path.basename(archive)}`;
      await uploadArchive(far, { archive, remote });
      return bootstrapSetup(far, { staging: '/root/staging-1.2.3', archive: remote, version: '1.2.3', allowUnsigned: false, installed: base });
    };
    const good = companionArchive(work, { signedBy: signer.key, svall: '#!/bin/sh\necho release 1.2.3 installed\n' });
    expect(await install(good)).toContain(`signed by a key ${base}/current/release/allowed_signers pins`);
    for (const { name, archive } of smuggling((n) => `/tmp/ran-${n}`)) {
      await expect(install(archive), name).rejects.toThrow(name === 'link' ? /not signed by a key/ : /^the uploaded archive holds .*(is not a path in releases\/1\.2\.3|twice)$/);
      expect((await far.run(['test', '-e', `/tmp/ran-${name}`])).code, name).toBe(1);
    }
  });
});

describe('the localhost sshd integration', () => {
  const live = process.env.SVALL_TEST_SSH;
  it.skipIf(!live)('runs a host probe over a real master (set SVALL_TEST_SSH=<destination> to run)', async () => {
    // the fake ssh is first on PATH for every other test in this file; a real master needs the real one
    const fake = process.env.PATH ?? '';
    process.env.PATH = fake.split(':').filter((p) => !p.startsWith(ssh.dir)).join(':');
    try {
      const master = await SshMaster.open({ destination: live as string });
      try {
        const script = 'printf "%s\\n" "$0" "$1" "$HOME" "$USER"';
        const r = await master.run(['sh', '-c', shq(script), shq('svall-home'), shq("a b'c")]);
        expect(r.code).toBe(0);
        // the far side's login shell split the line back into exactly the words the probe named
        const [marker, word, home, user] = r.stdout.split('\n');
        expect([marker, word]).toEqual(['svall-home', "a b'c"]);
        expect(home.startsWith('/')).toBe(true);
        expect(user).not.toBe('');
      } finally {
        await master.close();
      }
    } finally {
      process.env.PATH = fake;
    }
  });
});

describe('ndjson output', () => {
  it('writes one event per line and a final result', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const { hostCommands } = await import('../src/commands/host.js');
    try {
      await hostCommands(() => true, () => path.join(work, 'config'))
        .parseAsync(['add', 'trift', '--ssh', 'refused.test'], { from: 'user' });
    } finally { vi.restoreAllMocks(); process.exitCode = 0; }
    const lines = out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ step: 'name', status: 'start' });
    expect(lines.at(-1)).toMatchObject({ result: 'actions' });
    expect(Array.isArray((lines.at(-1) as { actions: unknown }).actions)).toBe(true);
  });
});
