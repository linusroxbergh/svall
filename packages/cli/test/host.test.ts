import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { FleetId, MachineId, PROTOCOL_VERSION } from '@archipelago/protocol';
import { addHost, doctorHost, enableHost, removeHost, upgradeHost, type HostDeps, type StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { shellQuote, SshMaster } from '../src/controller/ssh.js';
import { cleanHomes, makeHome, waitFor } from '../../archid/test/helpers.js';
import { companionArchive, ephemeralSigner } from './controller/archive.js';
import { installFakeSsh, type FakeSsh } from './controller/fake-ssh.js';

const REMOTE = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const MAC = MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const OTHER_MAC = MachineId.parse('9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
const TOKEN = 'remote-token-never-printed';
const HOME = '/home/linus';
const BASE = `${HOME}/.local/share/archipelago`;
const ARCHI = `${BASE}/current/bin/archi`;
// the PATH the companion's units run with, and so the one its daemon finds the agent CLIs on
const UNIT_PATH = `PATH=${BASE}/current/node/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

const OS_RELEASE = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\n';
const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 60000000 20000000 40000000 34% /\n';

/** What the companion's own `archi doctor --json` answers; a machine without linger reports none. */
const doctorJson = (linger?: { status: string; detail: string }): string => JSON.stringify({
  checks: [
    { name: 'systemd', status: 'ok', detail: 'archipelago-archid@private.service: loaded, active (running), enabled' },
    { name: 'gateway', status: 'ok', detail: 'archipelago-gateway.service: loaded, active (running), enabled' },
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
  ssh.reply(['archi-home'], { stdout: `${HOME}\nlinus\n` });
  ssh.reply(['archi-tools'], { stdout: (o.tools ?? ['tailscale', 'tmux', 'git', 'rsync', 'systemctl', 'loginctl']).map((t) => `${t} yes`).join('\n') + '\n' });
  ssh.reply(['tmux', '-V'], { stdout: 'tmux 3.4\n' });
  ssh.reply(['archi-rsync'], { stdout: 'rsync  version 3.2.7  protocol version 31\n' });
  ssh.reply(['archi-space'], { stdout: DF });
  ssh.reply(['archi-linger'], { stdout: o.linger ?? 'Linger=yes\n' });
  ssh.reply(['cat > "$1"'], {});
  ssh.reply(['mkdir'], {});
  ssh.reply(['tar'], {});
  ssh.reply(['rm'], {});
  ssh.reply(['setup'], { stdout: 'release 1.2.3 installed\n' });
  ssh.reply(['doctor', '--json'], { stdout: o.doctor ?? DOCTOR });
  ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
  if (o.agents === false) return;
  ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
  ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
  ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.155.1\n' });
  ssh.reply([UNIT_PATH, 'codex', 'login', 'status'], { stdout: 'Logged in using ChatGPT\n' });
}

/** A daemon on the far side of the forward, so the end-to-end probe has something to answer it. */
async function daemon(): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; token?: string };
    ws.send(JSON.stringify(msg.token !== undefined
      ? { id: 0, result: { ok: msg.token === TOKEN } }
      : { id: msg.id, result: { version: 1, fleet: 'private' } }));
  }));
  return { port: (wss.address() as { port: number }).port, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

// every step spawns the fake ssh, and a whole `host add` spawns some two dozen of them
vi.setConfig({ testTimeout: 60_000 });

const step = (id: string): StepEvent[] => events.filter((e) => e.step === id && e.status !== 'start');

beforeEach(() => {
  work = fs.mkdtempSync('/tmp/archi-host-');
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
      'mkdir -p', 'cat > "$1"', 'mkdir -p', 'tar -xzf', 'archi setup', 'rm -rf',
      'archi doctor', 'archi version',
      'claude --version', 'claude auth', 'codex --version', 'codex login',
      'archi connection-info',
    ]);
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
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex-cli 0.154.2: Archipelago needs 0.155 or newer', action: 'ssh trift.test, then update Codex' });
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
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
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
    expect(out).toMatchObject({ result: 'actions' });
    expect(out.actions).toContain('ssh trift.test, then loginctl enable-linger linus');
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
      ? { name: 'gateway', status: 'fail', detail: 'archipelago-gateway.service: loaded, inactive (dead), disabled' } : c)) });
    ssh.reply(['doctor', '--json'], { stdout: stopped, code: 1 });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('service').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('archipelago-gateway.service') });
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
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
    }, REMOTE);
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(step('name').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('name').at(-1)?.detail).toContain('other.test');
    expect(out.result).toBe('actions');
    expect(ssh.calls()).toEqual([]);
  });
});

describe('host doctor', () => {
  const registered = (): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
    }, REMOTE);
    return registry;
  };

  it('reads the companion\'s own doctor, version, linger and free space', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['archi-space'], { stdout: DF });
    ssh.reply(['archi-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['systemd', 'linger', 'release', 'space']));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'ok', detail: expect.stringContaining('1.2.3') });
  });

  it('names the remote user, not the machine, when the companion reports no linger of its own', async () => {
    ssh.reply(['doctor', '--json'], { stdout: doctorJson() });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['archi-space'], { stdout: DF });
    ssh.reply(['archi-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['archi-linger'], { stdout: 'Linger=no\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    const linger = report.checks.find((c) => c.name === 'linger');
    expect(linger).toMatchObject({ status: 'warn' });
    expect(linger?.detail).toContain('ssh trift.test, then loginctl enable-linger linus');
    expect(linger?.detail).not.toContain('trift:');
  });

  it('reads the report a companion doctor prints before it exits 1 for a failing check', async () => {
    const failing = JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: 'not installed in ~/.claude/settings.json: archi setup' }] });
    ssh.reply(['doctor', '--json'], { stdout: failing, code: 1 });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['archi-space'], { stdout: DF });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'hooks')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((c) => c.name === 'systemd')).toMatchObject({ status: 'ok' });
    expect(report.checks.find((c) => c.name === 'doctor')).toBeUndefined();
  });

  it('still reports a companion doctor that exits without a report', async () => {
    ssh.reply(['doctor', '--json'], { stderr: 'node: bad option\n', code: 9 });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['archi-space'], { stdout: DF });
    ssh.reply(['archi-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['archi-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'doctor')).toMatchObject({ status: 'fail', detail: expect.stringContaining('exited 9') });
  });

  it('reports a release the controller cannot hand over to as a failure', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '0.9.0', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['archi-space'], { stdout: DF });
    ssh.reply(['archi-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'fail' });
  });
});

describe('a host command told to stop', () => {
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('ends the master it opened rather than leaving it running', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
    }, REMOTE);
    registry.save();
    // the far doctor is still running when the app's Stop arrives
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR, delayMs: 15_000 });
    // plain node, as the release shim runs it: the tsx CLI turns a signal into an exit, which runs exit hooks
    const root = path.resolve(import.meta.dirname, '../../..');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'packages/cli/src/main.ts'), 'host', 'doctor', 'trift', '--json'], {
      cwd: root, env: { ...process.env, ARCHI_CONFIG_DIR: config }, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => { child.on('close', resolve); });
    await waitFor(() => ssh.remoteCalls().some((w) => w.includes('doctor')), 30_000);
    const state = path.join(ssh.dir, 'state');
    const [marker] = fs.readdirSync(state).filter((f) => f.endsWith('.master'));
    const master = Number(fs.readFileSync(path.join(state, marker), 'utf8'));
    expect(alive(master)).toBe(true);

    child.kill('SIGTERM');
    await exited;
    await waitFor(() => !alive(master), 5000);
  });
});

describe('host upgrade', () => {
  const registered = (): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
    }, REMOTE);
    return registry;
  };

  it('installs with the release already on the machine and probes it', async () => {
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    await d.close();
    expect(out.result).toBe('ready');
    const setup = ssh.remoteCalls().find((w) => w.includes('setup')) as string[];
    expect(setup[0]).toBe(ARCHI);
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
  });

  it('keeps a new release whose companion doctor exits 1 over a check unrelated to the daemon', async () => {
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
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

  it('deletes the archive it uploaded once the release is installed', async () => {
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN });
    await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    await d.close();
    expect(ssh.remoteCalls()).toContainEqual(['rm', '-f', `${HOME}/.cache/archipelago/companion-1.2.3.tar.gz`]);
  });

  it('puts the machine back on its old release when the new one does not answer', async () => {
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['--rollback'], { stdout: 'current -> releases/1.2.2\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(true);
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn' });
  });
});

describe('host remove', () => {
  const registered = (destination: string): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: destination, platform: 'linux', arch: 'arm64',
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
    }, REMOTE);
    return registry;
  };

  it('uninstalls on the machine before the route is dropped, and never purges', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls()).toEqual([[ARCHI, 'uninstall']]);
    expect(registry.get('trift')).toBeUndefined();
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
    const away = fleetAt('.archipelago-lab', { gateway: REMOTE, owner: OTHER_MAC });
    for (const forget of [false, true]) {
      const out = await removeHost('trift', { forget }, deps({ registry }));
      expect(out.result).toBe('actions');
      expect(step('fleet').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(away) });
      expect(registry.get('trift')).toBeDefined();
    }
    expect(ssh.calls()).toEqual([]);
    expect(gatewayOf(away)).toBe(REMOTE);
  });

  it('names the handover that brings a stranded fleet back, profile and all, before the machine can go', async () => {
    const registry = registered('trift.test');
    fleetAt('.archipelago-lab', { gateway: REMOTE, owner: OTHER_MAC });
    fleetAt('.archipelago', { gateway: REMOTE, owner: OTHER_MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    const said = out.actions.join('\n');
    expect(said).toContain('`archi handover local`');
    expect(said).toContain('`archi -p lab handover local`');
    expect(said).toContain('then `archi host remove trift`');
    expect(said).not.toMatch(/disable handover/);
  });

  it('refuses while the gateway holds a handover of a fleet open, and names how to settle it', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    // this Mac froze for a handover to trift, which may by now have committed it there
    const frozen = fleetAt('.archipelago', { gateway: REMOTE, owner: MAC });
    fs.mkdirSync(path.join(frozen, 'handover'));
    fs.writeFileSync(path.join(frozen, 'handover', 'journal.json'), JSON.stringify({
      role: 'source', transactionId: 'tx-1', generation: 2, fleetId: FLEET, fromMachineId: MAC, toMachineId: REMOTE, phase: 'freeze', updatedAt: 1,
    }));
    // begun from this Mac, before any daemon froze
    const begun = fleetAt('.archipelago-lab', { gateway: REMOTE, owner: MAC });
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
      for (const cmd of ['`archi handover --resume`', '`archi handover --abort`', '`archi -p lab handover --resume`', '`archi -p lab handover status`', 'then `archi host remove trift`']) {
        expect(said).toContain(cmd);
      }
      expect(registry.get('trift')).toBeDefined();
    }
    expect(ssh.calls()).toEqual([]);
    expect(gatewayOf(frozen)).toBe(REMOTE);
    expect(gatewayOf(begun)).toBe(REMOTE);
  });

  it('lets the gateway go once the handover that brought a fleet here has completed, though the record it left names that handover', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.archipelago', { gateway: REMOTE });
    fs.writeFileSync(path.join(mine, 'owner.json'), JSON.stringify({
      fleetId: FLEET, generation: 3, ownerMachineId: MAC, transaction: { id: 'tx-1', fromMachineId: REMOTE, toMachineId: MAC, phase: 'committed', startedAt: 1 },
    }));
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(gatewayOf(mine)).toBeUndefined();
  });

  it('takes the gateway out of a fleet this Mac owns as the machine goes', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.archipelago', { gateway: REMOTE, owner: MAC });
    const untouched = fleetAt('.archipelago-other', { gateway: OTHER_MAC, owner: OTHER_MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(gatewayOf(mine)).toBeUndefined();
    expect(gatewayOf(untouched)).toBe(OTHER_MAC);
    expect(registry.get('trift')).toBeUndefined();
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
      home: HOME, archiBase: BASE, pathRoots: { home: HOME }, gateway: false,
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

  /** What `archi gateway owner` on the far side answers: a record, or a refusal it exits non-zero on. */
  const answers = (record: Partial<{ generation: number; ownerMachineId: string }>): { stdout: string } =>
    ({ stdout: `${JSON.stringify({ result: { record: { fleetId: FLEET, generation: 0, ownerMachineId: MAC, ...record } } })}\n` });
  const refuses = (code: string, message: string): { stdout: string; code: number } =>
    ({ stdout: `${JSON.stringify({ error: { code, message } })}\n`, code: 1 });

  const ownerCalls = (): string[][] => ssh.remoteCalls().filter((w) => w.includes('owner'));

  /** What `archi fleet provision` on the far side answers once the machine holds its copy of the fleet. */
  const provisioned = (outcome = 'held'): { stdout: string } =>
    ({ stdout: `${JSON.stringify({ outcome, home: `${HOME}/.archipelago-work`, unit: 'archipelago-archid@work.service' })}\n` });

  it('gives the machine its copy of the fleet under the profile the controller reaches it by, before it names the gateway', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    ssh.reply(['fleet', 'provision'], provisioned('rekeyed'));
    const home = path.join(work, '.archipelago-work');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET }));

    const out = await enableHost('trift', { fleetHome: home }, deps({ registry: registered() }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls().filter((w) => w.includes('provision'))).toEqual([
      [ARCHI, '-p', 'work', 'fleet', 'provision', '--id', FLEET, '--gateway', REMOTE, '--json'],
    ]);
    expect(step('fleet').at(-1)?.detail).toContain(`${HOME}/.archipelago-work`);
    expect(written(home).gatewayMachineId).toBe(REMOTE);
  });

  it('names the far fleet home that holds another fleet in use, and leaves fleet.json and the registry alone', async () => {
    ssh.reply(['owner', 'get'], answers({}));
    const said = `${HOME}/.archipelago holds fleet 47a74455-7dbc-46c0-8076-30d830cf4f72, and it holds 3 characters, so it is not this fleet's to replace`;
    ssh.reply(['fleet', 'provision'], { stderr: `archi: ${said}\n`, code: 3 });
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
      [{ stderr: 'archi: systemctl --user enable --now archipelago-archid@private.service: failed\n', code: 1 }, 'systemctl'],
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
      [ARCHI, 'gateway', 'owner', 'get', '--fleet', FLEET],
      [ARCHI, 'gateway', 'owner', 'create', '--fleet', FLEET, '--params', JSON.stringify({ initialOwnerMachineId: MAC })],
    ]);
    expect(written(home).gatewayMachineId).toBe(REMOTE);
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
    expect(ownerCalls()).toEqual([[ARCHI, 'gateway', 'owner', 'get', '--fleet', FLEET]]);
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

describe('the localhost sshd integration', () => {
  const live = process.env.ARCHI_TEST_SSH;
  it.skipIf(!live)('runs a host probe over a real master (set ARCHI_TEST_SSH=<destination> to run)', async () => {
    // the fake ssh is first on PATH for every other test in this file; a real master needs the real one
    const fake = process.env.PATH ?? '';
    process.env.PATH = fake.split(':').filter((p) => !p.startsWith(ssh.dir)).join(':');
    try {
      const master = await SshMaster.open({ destination: live as string });
      try {
        const script = 'printf "%s\\n" "$0" "$1" "$HOME" "$USER"';
        const r = await master.run(['sh', '-c', shellQuote(script), shellQuote('archi-home'), shellQuote("a b'c")]);
        expect(r.code).toBe(0);
        // the far side's login shell split the line back into exactly the words the probe named
        const [marker, word, home, user] = r.stdout.split('\n');
        expect([marker, word]).toEqual(['archi-home', "a b'c"]);
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
