import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { FleetId, MachineId, OLDEST_STATE_SCHEMA_VERSION, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, emptyState, type SetupRow } from '@svall/protocol';
import { machineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { tokenFor } from '@svall/svalld/placement/workers';
import { shq } from '@svall/svalld/text';
import { addHost, consentHost, doctorHost, removeHost, rollbackHost, rowCheck, rowStep, upgradeHost, type HostDeps, type HostReport, type StepEvent } from '../src/controller/host.js';
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
// the fleet home there as a worker of this Mac's fleet, as its `svall version --json` names it
const SERVES = { homeMachineId: MAC, homeName: 'mac', fleetId: FLEET };
// the far account's home is the Mac's, as the registry's own record names it
const HOME = os.homedir();
// a home no runner of these tests has
const ELSEWHERE = `${HOME}-elsewhere`;
const BASE = `${HOME}/.local/share/svall`;
const SVALL = `${BASE}/current/bin/svall`;
// the PATH the companion's units run with, and so the one its daemon finds the agent CLIs on
const UNIT_PATH = `PATH=${BASE}/current/node/bin:${BASE}/current/bin:${HOME}/.local/bin:${HOME}/.opencode/bin:/usr/local/bin:/usr/bin:/bin`;
// what the tmux on that PATH answers: where it is, then its version
const OWN_TMUX = `${BASE}/current/bin/tmux\ntmux 3.7c\n`;

const OS_RELEASE = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\n';
const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 60000000 20000000 40000000 34% /\n';

/** What the companion's own `svall doctor --json` answers; a machine without linger reports none. */
const doctorJson = (linger?: { status: string; detail: string }): string => JSON.stringify({
  checks: [
    { name: 'systemd', status: 'ok', detail: 'svall-svalld@private.service: loaded, active (running), enabled' },
    ...(linger ? [{ name: 'linger', ...linger }] : []),
    { name: 'tmux', status: 'ok', detail: 'tmux 3.4' },
  ],
});
const DOCTOR = doctorJson({ status: 'ok', detail: 'on for linus: the fleet keeps running after you log out' });
// this Mac's agents as its own daemon names them, at the releases a healthy companion answers
const MAC_AGENTS = [{ kind: 'claude', version: '2.1.278' }, { kind: 'codex', version: '0.156.1' }, { kind: 'opencode', version: '2.0.22' }] as const;

let work: string;
let ssh: FakeSsh;
let events: StepEvent[];
// this Mac's fleet, which the machine becomes a worker of
let fleet: string;
let refreshed: number;

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
    interactiveSsh: () => Promise.resolve({ code: 0, stderr: '' }),
    fetch: () => Promise.reject(new Error('no download in this test')),
    controller: { release: '1.2.3', protocol: PROTOCOL_VERSION, releaseRoot: path.join(work, 'release'), signed: true },
    localAgents: () => Promise.resolve([...MAC_AGENTS]),
    machineId: () => MAC,
    homedir: work,
    verify: (dir, id) => signer.verify(dir, id),
    fleet: { home: fleet },
    refreshLinks: () => { refreshed++; return Promise.resolve(); },
    setupRows: () => Promise.resolve([]),
    consent: () => Promise.resolve([]),
    ...o,
  };
}

// setup rows as the home's machines.setup words them for trift
const unticked = (item: string): SetupRow => {
  const name = item.split(':').at(-1)!;
  const field = `env.${name.toUpperCase()}_API_KEY`;
  return {
    key: item, status: 'warn', action: `copy ${name}'s keys to trift`,
    detail: `mirrored without ${field} ${name.slice(0, 3)}…90; or set them in ~/.svall/mirror-overrides on trift`,
    tick: { item, fields: [field], on: false, preview: [`${field} ${name.slice(0, 3)}…90`] }, gap: { name, what: `keys not copied (${field})` },
  };
};
const ticked = (item: string): SetupRow => {
  const row = unticked(item);
  return { key: item, status: 'ok', detail: `keys copied to trift`, tick: { ...row.tick!, on: true } };
};
const varRow = (v: string): SetupRow => ({
  key: `var:${v}`, status: 'warn', action: `set ${v} on trift`, run: `svall worker env ${v}`, detail: `gamma reads ${v}, which trift's daemon does not have`,
  gap: { name: v, what: 'not set; gamma reads it' },
});
const THERE = { ssh: 'trift.test', svall: 'svall' };
const okRow = (key: string): SetupRow => ({ key, status: 'ok', detail: `${key.split(':').at(-1)} is set on trift` });

/** Everything a healthy Ubuntu companion answers, in the order `host add` asks for it. */
function healthy(o: { linger?: string; tools?: string[]; osRelease?: string; doctor?: string; agents?: boolean; tmux?: { stdout?: string; stderr?: string; code?: number }; home?: string } = {}): void {
  const home = o.home ?? HOME;
  ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
  ssh.reply(['cat', '/etc/os-release'], { stdout: o.osRelease ?? OS_RELEASE });
  ssh.reply(['svall-home'], { stdout: `${home}\nlinus\n` });
  ssh.reply(['svall-tools'], { stdout: (o.tools ?? ['tailscale', 'git', 'systemctl', 'loginctl']).map((t) => `${t} yes`).join('\n') + '\n' });
  ssh.reply(['svall-space'], { stdout: DF });
  ssh.reply(['svall-linger'], { stdout: o.linger ?? 'Linger=yes\n' });
  ssh.reply(['cat > "$1"'], {});
  ssh.reply(['mkdir'], {});
  ssh.reply(['svall-unpack'], {});
  ssh.reply(['rm'], {});
  ssh.reply(['setup'], { stdout: 'release 1.2.3 installed\n' });
  ssh.reply(['svall-tmux-version'], o.tmux ?? { stdout: OWN_TMUX });
  ssh.reply(['doctor', '--json'], { stdout: o.doctor ?? DOCTOR });
  ssh.reply(['svall-units'], { stdout: 'plain\n' });
  ssh.reply(['worker', 'enroll'], { stdout: `systemd unit -> ${home}/.config/systemd/user/svall-svalld@private.service\nsystemctl --user restart svall-svalld@private.service\n` });
  ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }, null, 2) });
  ssh.reply(['svall-tmux'], {});
  if (o.agents === false) return;
  const PATH = UNIT_PATH.replaceAll(HOME, home);
  ssh.reply([PATH, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
  ssh.reply([PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
  ssh.reply([PATH, 'codex', '--version'], { stdout: 'codex-cli 0.156.1\n' });
  ssh.reply([PATH, 'codex', 'login', 'status'], { stdout: 'Logged in using ChatGPT\n' });
  ssh.reply([PATH, 'opencode', '--version'], { stdout: '2.0.22\n' });
  ssh.reply([PATH, 'opencode', 'auth', 'list', '--standalone', '--format', 'json'], { stdout: '[{"id":"openai"}]\n' });
}

/** A daemon on the far side of the forward, so the end-to-end probe has something to answer it: from `release`, while it `accepts`. */
async function daemon(o: { release?: () => string; accepts?: () => boolean } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: number; token?: string };
    ws.send(JSON.stringify(msg.token !== undefined
      ? { id: 0, result: { ok: msg.token === TOKEN && (o.accepts?.() ?? true), protocol: PROTOCOL_VERSION } }
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
  fleet = makeHome();
  fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: FLEET }));
  refreshed = 0;
});
afterEach(() => { ssh.clean(); cleanHomes(); fs.rmSync(work, { recursive: true, force: true }); });

describe('host add', () => {
  it('probes, installs, checks and registers the machine', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });

    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();

    expect(out.result).toBe('ready');
    // each step names the machine, never its id
    expect(JSON.stringify(events)).not.toContain(REMOTE);
    const order = ssh.remoteCalls().map((w) => (w[0] === 'sh' ? w[2].slice(0, 20) : w[0] === 'env' ? `${w[2]} ${w[3]}` : path.basename(w[0]) + (w[1] ? ` ${w[1]}` : '')));
    expect(order.slice(0, 6)).toEqual([
      'uname -sm', 'cat /etc/os-release',
      'printf "%s\\n%s\\n" "$', 'for c in "$@"; do if',
      'df -Pk "$HOME"', 'l=$(loginctl show-us',
    ]);
    expect(order.slice(6)).toEqual([
      'mkdir -p', 'cat > "$1"', 'mkdir -p', 'PATH=/usr/bin:/bin:/', 'svall setup', 'rm -rf',
      'sh -c', 'svall doctor', 'svall version', '[ -f "$1/$2" ] && ec', 'svall version', 'svall worker',
      'claude --version', 'claude auth', 'codex --version', 'codex login', 'opencode --version', 'opencode auth',
      'svall connection-info', 'svall version', 'sh -c',
    ]);
    expect(step('versions').at(-1)).toMatchObject({ status: 'ok', detail: 'claude 2.1.278, codex 0.156.1, opencode 2.0.22, as on this Mac' });
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'trift answers on its own private fleet, serves this fleet as a worker, and tmux opens and closes a window there' });
    expect(step('release').at(-1)?.detail).toMatch(/^1\.2\.3 for linux-arm64 from the archive you named \(signed\)$/);
  });

  it('host add enrols the machine as a worker: worker.json written there, the fleet unit restarted with --worker, no gateway unit', async () => {
    const input = path.join(work, 'enroll-stdin');
    ssh.reply(['worker', 'enroll'], { stdout: `systemd unit -> ${HOME}/.config/systemd/user/svall-svalld@private.service\nsystemctl --user restart svall-svalld@private.service\n`, input });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();

    expect(out).toEqual({ result: 'ready', actions: [] });
    const mac = registry.localMachine().name;
    expect(ssh.remoteCalls().find((w) => w.includes('enroll'))).toEqual([SVALL, 'worker', 'enroll', '--home-machine', MAC, '--home-name', mac, '--fleet-id', FLEET]);
    // worker.json there takes, on its stdin, the token this fleet's daemon opens the link with
    expect(fs.readFileSync(input, 'utf8')).toBe(tokenFor(resolvePaths(fleet), REMOTE));
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'ok', detail: `trift serves this fleet as a worker of ${mac}; systemctl --user restart svall-svalld@private.service` });
    expect(ssh.remoteCalls().some((w) => w.includes('gateway'))).toBe(false);
    // this fleet's daemon links it without waiting for its next start
    expect(refreshed).toBe(1);
  });

  it('enrols a named fleet under the profile it runs there', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ fleet: { home: fleet, profile: 'work' } }));
    await d.close();
    expect(ssh.remoteCalls().find((w) => w.includes('enroll'))?.slice(0, 4)).toEqual([SVALL, '-p', 'work', 'worker']);
    expect(ssh.remoteCalls().filter((w) => w.includes('version')).at(-1)).toEqual([SVALL, '-p', 'work', 'version', '--json']);
  });

  it('fails the probe on a fleet there that does not run as a worker, or a tmux that cannot open a window, and registers nothing', async () => {
    for (const [match, reply, said] of [
      [['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) }, 'trift does not serve this fleet as a worker'],
      [['svall-tmux'], { stderr: 'error connecting to /tmp/svall-probe (No such file or directory)\n', code: 1 }, 'tmux could not open a window'],
    ] as const) {
      ssh.clearReplies();
      ssh.reply([...match], reply);
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      events = [];
      const registry = MachineRegistry.load(path.join(work, 'config'));
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      expect(out.result).toBe('actions');
      expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(said) });
      expect(registry.get('trift')).toBeUndefined();
    }
  });

  it('enrols nothing over a fleet home there that serves another Mac as a worker, and registers nothing', async () => {
    const action = 'on bea-mbp, run svall host remove trift';
    ssh.clearReplies();
    const worker = { homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET };
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker }) });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    events = [];
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    expect(out).toEqual({ result: 'actions', stopped: 'enrol', actions: [action] });
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from that Mac first', action });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(tokenFor(resolvePaths(fleet), REMOTE)).toBeUndefined();
    expect(registry.get('trift')).toBeUndefined();
  });

  it('add stops and removes a gateway unit it finds there, and enrols the fleet\'s unit as the worker', async () => {
    ssh.reply(['svall-units'], { stdout: 'gateway\nplain\n' });
    ssh.reply(['svall-gateway-off'], {});
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    const calls = ssh.remoteCalls();
    expect(calls).toContainEqual(expect.arrayContaining(['systemctl --user disable --now "$(basename "$1")" && rm -f "$1" && systemctl --user daemon-reload']));
    expect(calls.findIndex((w) => w.includes('svall-gateway-off'))).toBeLessThan(calls.findIndex((w) => w.includes('enroll')));
    expect(step('enrol').at(-1)).toMatchObject({ status: 'ok', detail: expect.stringMatching(/; svall-gateway\.service is stopped and removed$/) });
    expect(events.map((e) => e.step)).not.toContain('fleet');
  });

  it('enrols a fleet home there that already serves this Mac as a worker again, with a new token', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toHaveLength(1);
    expect(tokenFor(resolvePaths(fleet), REMOTE)).toBeDefined();
  });

  it('fails the probe on a daemon that answers from another release than the one installed, and registers nothing', async () => {
    healthy();
    const d = await daemon({ release: () => '1.2.2' });
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: 'trift answers from release 1.2.2, not 1.2.3' });
    expect(step('registry')).toEqual([]);
    expect(registry.get('trift')).toBeUndefined();
  });

  /** A far setup of 1.2.3 whose new daemon did not answer: it goes back to 1.2.2, and still exits 0. */
  async function wentBack(registry: MachineRegistry) {
    ssh.reply(['setup'], {
      stdout: [
        'release 1.2.3 installed', 'systemctl --user restart svall-svalld@private.service',
        `the private fleet's daemon did not answer: current -> ${BASE}/releases/1.2.2`,
        'systemctl --user restart svall-svalld@private.service',
      ].join('\n') + '\n',
    });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.2', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    healthy();
    const d = await daemon({ release: () => '1.2.2' });
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.2', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    return out;
  }

  it('stops at identity over an install whose setup went back to the release it ran, naming that release, and registers nothing', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await wentBack(registry);
    const action = 'ssh trift.test and read the daemon log; trift runs release 1.2.2, the one its setup went back to; then add the machine again';
    expect(out).toEqual({ result: 'actions', actions: [action], stopped: 'identity' });
    expect(step('identity').at(-1)).toEqual({
      step: 'identity', status: 'fail',
      detail: 'trift runs release 1.2.2, not 1.2.3: its setup went back, as the daemon of 1.2.3 did not answer', action,
    });
    expect(step('registry')).toEqual([]);
    expect(registry.get('trift')).toBeUndefined();
  });

  it('finds claude, codex and opencode on the PATH the companion\'s unit runs with, and holds each to its version floor and login', async () => {
    // over ssh the login shell finds none of the CLIs; their installers put them in ~/.local/bin
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
    ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":false}\n', code: 1 });
    ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.154.2\n' });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.21\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', detail: '2.1.278 (Claude Code), not logged in', action: 'ssh trift.test, then claude auth login', run: 'claude auth login' });
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex-cli 0.154.2: Svall needs 0.156.0 or newer', action: 'ssh trift.test, then codex update', run: 'codex update' });
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: '2.0.21: Svall needs 2.0.22 or newer', action: 'ssh trift.test, then opencode upgrade', run: 'opencode upgrade' });
    // one below the floor is compared no further, as its own row names the update
    expect(step('versions').at(-1)).toMatchObject({ status: 'ok', detail: 'claude 2.1.278, as on this Mac' });
    expect(out.actions).toEqual(['ssh trift.test, then claude auth login', 'ssh trift.test, then codex update', 'ssh trift.test, then opencode upgrade']);
    const agentCalls = ssh.remoteCalls().filter((w) => w.includes('claude') || w.includes('codex') || w.includes('opencode'));
    expect(agentCalls.length).toBe(4);
    expect(agentCalls.every((w) => w[0] === 'env' && w[1] === UNIT_PATH)).toBe(true);
  });

  it('asks each agent with the agent homes the companion\'s units carry, as its doctor names them, where a login in the login shell lands', async () => {
    const homes = { CLAUDE_CONFIG_DIR: `${HOME}/agents/claude`, CODEX_HOME: `${HOME}/agents/codex home` };
    // a name that is no plain variable never reaches env
    healthy({ agents: false, doctor: JSON.stringify({ ...JSON.parse(DOCTOR), daemonEnv: { ...homes, '-S': '/x' } }) });
    const env = [UNIT_PATH, `CLAUDE_CONFIG_DIR=${homes.CLAUDE_CONFIG_DIR}`, `CODEX_HOME=${homes.CODEX_HOME}`];
    ssh.reply([...env, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
    ssh.reply([...env, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('claude').at(-1)).toMatchObject({ status: 'ok', detail: '2.1.278 (Claude Code), logged in' });
    const agentCalls = ssh.remoteCalls().filter((w) => w.includes('claude') || w.includes('codex') || w.includes('opencode'));
    expect(agentCalls.every((w) => w.slice(0, 4).join('\n') === ['env', ...env].join('\n') && !w.includes('-S=/x'))).toBe(true);
  });

  it('names an OpenCode whose auth list fails as not logged in', async () => {
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.22\n' });
    ssh.reply([UNIT_PATH, 'opencode', 'auth', 'list', '--standalone'], { stderr: 'Error: no credentials\n', code: 1 });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: '2.0.22, not logged in', action: 'ssh trift.test, then opencode auth login' });
  });

  it("names an OpenCode whose auth list names no model provider as not logged in, as doctor and a move's checks do", async () => {
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.22\n' });
    ssh.reply([UNIT_PATH, 'opencode', 'auth', 'list', '--standalone'], { stdout: '[]\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: '2.0.22, not logged in', action: 'ssh trift.test, then opencode auth login' });
  });

  it('names an agent CLI the unit\'s PATH does not hold as one to install', async () => {
    healthy({ agents: false });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    // setup writes Svall's hooks only for the agents it finds, so one installed later needs it again
    expect(step('claude').at(-1)).toMatchObject({
      status: 'warn', detail: 'claude is not installed on this machine', action: 'ssh trift.test, then install Claude Code, then svall setup',
      run: 'curl -fsSL https://claude.ai/install.sh | bash',
    });
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex is not installed on this machine', action: 'ssh trift.test, then install Codex, then svall setup', run: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' });
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: 'opencode is not installed on this machine', action: 'ssh trift.test, then install OpenCode, then svall setup', run: 'curl -fsSL https://opencode.ai/v2/install | bash' });
    expect(step('versions').at(-1)).toMatchObject({ status: 'skip', detail: 'no agent CLI to compare' });
  });

  it("names each agent whose release there is not this Mac's, which side is behind, and the vendor's update for it", async () => {
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.280 (Claude Code)\n' });
    ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
    ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.162.1-alpha.2\n' });
    ssh.reply([UNIT_PATH, 'codex', 'login', 'status'], { stdout: 'Logged in using ChatGPT\n' });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.26\n' });
    ssh.reply([UNIT_PATH, 'opencode', 'auth', 'list', '--standalone'], { stdout: '[{"id":"openai"}]\n' });
    const mac = [{ kind: 'claude', version: '2.1.310' }, { kind: 'codex', version: '0.162.1' }, { kind: 'opencode', version: '2.0.22' }] as const;
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ localAgents: () => Promise.resolve([...mac]) }));
    await d.close();
    // each machine alone is fine; only a move between them stops
    expect(step('claude').at(-1)).toMatchObject({ status: 'ok', detail: '2.1.280 (Claude Code), logged in' });
    const action = 'ssh trift.test, then claude update, then codex update; on this Mac, run opencode upgrade';
    expect(step('versions').at(-1)).toEqual({
      step: 'versions', status: 'warn',
      detail: 'claude 2.1.280 there, behind 2.1.310 on this Mac; codex 0.162.1-alpha.2 there, behind 0.162.1 on this Mac; opencode 2.0.26 there, ahead of 2.0.22 on this Mac: a move there and back needs the same release on both',
      action, run: 'claude update && codex update',
    });
    expect(out).toEqual({ result: 'actions', actions: [action] });
  });

  it("names no update for an agent behind only on this Mac's side, as the terminal it would be typed in is the machine's", async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ localAgents: () => Promise.resolve([{ kind: 'claude', version: '2.1.270' }]) }));
    await d.close();
    expect(step('versions').at(-1)).toEqual({
      step: 'versions', status: 'warn',
      detail: 'claude 2.1.278 there, ahead of 2.1.270 on this Mac: a move there and back needs the same release on both', action: 'on this Mac, run claude update',
    });
  });

  it("adds the machine without comparing when this Mac's own daemon cannot be asked", async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ localAgents: () => Promise.reject(new Error('svalld is not running (no port file)')) }));
    await d.close();
    expect(step('versions').at(-1)).toMatchObject({ status: 'skip', detail: 'not compared: svalld is not running (no port file)' });
    expect(out.result).toBe('ready');
  });

  it('notes an agent CLI no fleet on this Mac runs, and asks for it once a fleet does or its state cannot be read', async () => {
    const fleet = (name: string, state?: object) => {
      const home = path.join(work, name);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: crypto.randomUUID() }));
      if (state) fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ ...emptyState(), ...state }));
    };
    const add = async () => {
      events.length = 0;
      ssh.clearReplies();
      healthy({ agents: false });
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
      await d.close();
      return out;
    };
    fleet('.svall', { mainAgent: 'claude', scribeAgent: 'codex', scribeOff: true });
    const out = await add();
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then install Claude Code, then svall setup' });
    for (const kind of ['codex', 'opencode']) {
      expect(step(kind).at(-1)).toEqual({ step: kind, status: 'skip', detail: `${kind} is not installed on this machine, and no fleet on this Mac runs it` });
    }
    expect(out.actions).toEqual(['ssh trift.test, then install Claude Code, then svall setup']);
    fleet('.svall-work');
    await add();
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then install OpenCode, then svall setup' });
  });

  it('names what Svall\'s hooks there still need, from the companion\'s own doctor, without stopping setup', async () => {
    const untrusted = 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks';
    const disabled = `${HOME}/.claude/settings.json sets disableAllHooks, so no robot gets a status; remove it`;
    const plugin = `not installed in ${HOME}/.config/opencode/plugins/svall.js: svall setup`;
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: disabled }, { name: 'codex hooks', status: 'warn', detail: untrusted, run: 'codex' }, { name: 'opencode plugin', status: 'fail', detail: plugin, run: 'svall setup' }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    // a fix that is no one command to type leaves the step without one
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', detail: '2.1.278 (Claude Code), logged in; the hooks check there fails', action: `ssh trift.test, then ${disabled}` });
    expect(step('claude').at(-1)).not.toHaveProperty('run');
    expect(step('codex').at(-1)).toMatchObject({
      status: 'warn', detail: 'codex-cli 0.156.1, logged in; the codex hooks check there says not trusted yet',
      action: 'ssh trift.test, then start codex and choose "Trust all and continue", or trust them in /hooks', run: 'codex',
    });
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: `2.0.22, logged in; the opencode plugin check there says not installed in ${HOME}/.config/opencode/plugins/svall.js`, action: 'ssh trift.test, then svall setup', run: 'svall setup' });
    expect(out.result).toBe('actions');
    expect(registry.get('trift')?.id).toBe(REMOTE);
  });

  it('names the AppArmor profile Codex\'s sandbox needs there, from the companion\'s own doctor', async () => {
    const fix = 'sudo apt install bubblewrap apparmor-profiles, then sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    const blocked = `AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted), so a Codex robot asks before each one: ${fix}`;
    const run = 'sudo apt install bubblewrap apparmor-profiles && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'codex hooks', status: 'ok', detail: 'trusted' }, { name: 'codex sandbox', status: 'warn', detail: blocked, run }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    const codex = step('codex').at(-1)!;
    expect(codex).toMatchObject({
      status: 'warn', detail: `codex-cli 0.156.1, logged in; the codex sandbox check there says ${blocked.slice(0, blocked.lastIndexOf(': '))}`, action: `ssh trift.test, then ${fix}`, run,
    });
    // each fix once on the line: what is wrong in the detail, what to do in the action
    expect(`${codex.detail} -> ${codex.action}`.split(fix)).toHaveLength(2);
    expect(step('claude').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('names both fixes a fresh Ubuntu leaves Codex, and the first one\'s command to type', async () => {
    const untrusted = 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks';
    const fix = 'sudo apt install bubblewrap apparmor-profiles, then sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    const blocked = `AppArmor keeps bwrap from making the user namespace Codex runs commands in, so a Codex robot asks before each one: ${fix}`;
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'codex hooks', status: 'warn', detail: untrusted, run: 'codex' }, { name: 'codex sandbox', status: 'warn', detail: blocked, run: 'sudo apt install bubblewrap apparmor-profiles && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict' }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    // the doctor shown once that terminal ends lists the sandbox on its own, with its own command
    expect(step('codex').at(-1)).toMatchObject({
      status: 'warn', action: `ssh trift.test, then start codex and choose "Trust all and continue", or trust them in /hooks; and ${fix}`, run: 'codex',
    });
  });

  it('names every Codex check that warns there, untrusted hooks and a blocked sandbox alike', async () => {
    const untrusted = 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks';
    const blocked = 'AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: denied), so a Codex robot asks before each one: sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'codex hooks', status: 'warn', detail: untrusted }, { name: 'codex sandbox', status: 'warn', detail: blocked }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('codex').at(-1)).toMatchObject({
      status: 'warn',
      detail: 'codex-cli 0.156.1, logged in; the codex hooks check there says not trusted yet; the codex sandbox check there says AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: denied), so a Codex robot asks before each one',
      action: 'ssh trift.test, then start codex and choose "Trust all and continue", or trust them in /hooks; and sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict',
    });
  });

  it('writes the registry record under the machine id the companion reports', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();

    const entry = registry.get('trift');
    expect(entry?.id).toBe(REMOTE);
    expect(entry?.record).toEqual({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    });
  });

  it('never lets the companion token out in an event', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('runs one interactive ssh before any batch command', async () => {
    const seen: string[] = [];
    healthy();
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({
      interactiveSsh: (destination) => { seen.push(destination); return Promise.resolve({ code: 0, stderr: '' }); },
    }));
    expect(seen).toEqual(['trift.test']);
  });

  it('names what ssh said when the interactive login fails, and the Terminal run that settles it', async () => {
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({
      interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'Host key verification failed.' }),
    }));
    expect(out.result).toBe('actions');
    expect(step('ssh').at(-1)).toEqual({
      step: 'ssh', status: 'fail', detail: 'ssh trift.test exited 255: Host key verification failed.',
      action: 'run ssh trift.test once in Terminal and answer its host key and login there, then add the machine again',
    });
  });

  it('takes a far home other than this Mac\'s, and registers the machine at it', async () => {
    healthy({ home: ELSEWHERE });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    expect(step('home').at(-1)).toEqual({ step: 'home', status: 'ok', detail: `${ELSEWHERE} for linus` });
    expect(out.result).toBe('ready');
    expect(registry.get('trift')?.record).toMatchObject({ home: ELSEWHERE, svallBase: `${ELSEWHERE}/.local/share/svall` });
  });

  it('add refuses a machine whose home makes the fleet socket too long, naming the listen EINVAL it would otherwise crash on', async () => {
    // 90 bytes: the fleet's hook socket, 18 bytes further on, is one past the 107 Linux holds
    const long = `/home/${'h'.repeat(84)}`;
    healthy({ home: long });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('home').at(-1)?.detail).toMatch(/^the socket \/home\/.+\/\.svall\/hooks\.sock is /);
    expect(step('home').at(-1)).toMatchObject({
      status: 'fail',
      detail: `the socket ${long}/.svall/hooks.sock is 108 bytes, past the 107 a Unix socket path holds, so its listen fails with EINVAL`,
      action: 'use an account on trift.test whose home path is at most 89 bytes',
    });
    expect(ssh.remoteCalls().some((w) => w.includes('setup') || w.includes('cat > "$1"'))).toBe(false);
  });

  it('takes a home just short enough for the fleet socket', async () => {
    const long = `/home/${'h'.repeat(83)}`;
    healthy({ home: long });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('home').at(-1)).toMatchObject({ status: 'ok' });
  });

  it.each(['/home/linus/', '/home//linus', '/home/./linus'])('stops at a far home written another way, %s, which a path under it would not come back from', async (spelled) => {
    healthy({ home: spelled });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('home').at(-1)).toEqual({
      step: 'home', status: 'fail',
      detail: `${spelled} is linus's home there, which names /home/linus another way`,
      action: 'make /home/linus the account\'s home on trift.test, then add the machine again',
    });
    expect(registry.get('trift')).toBeUndefined();
  });

  it('stops on a machine that is not Ubuntu', async () => {
    healthy({ osRelease: 'ID=debian\nVERSION_ID="12"\n' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('os').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('os').at(-1)?.detail).toContain('Ubuntu');
    expect(ssh.remoteCalls().some((w) => w.includes('setup'))).toBe(false);
  });

  it('stops on an Ubuntu older than 22.04, whose glibc the companion\'s tmux does not run on', async () => {
    healthy({ osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\n' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'os' });
    expect(step('os').at(-1)).toMatchObject({ status: 'fail', detail: 'Ubuntu 20.04 is older than 22.04, the oldest release the companion runs on' });
  });

  it('takes Ubuntu 22.04, the release the companion\'s tmux is built on', async () => {
    healthy({ osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\n', tools: ['tailscale', 'systemctl', 'loginctl'] });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tools' });
    expect(step('os').at(-1)).toMatchObject({ status: 'ok', detail: 'Ubuntu 22.04 arm64 (LTS)' });
  });

  it('names the apt command for the packages the machine is missing', async () => {
    healthy({ tools: ['tailscale', 'systemctl', 'loginctl'] });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('tools').at(-1)).toMatchObject({ status: 'fail', action: 'ssh trift.test, then sudo apt install git', run: 'sudo apt install git' });
    expect(ssh.remoteCalls().some((w) => w.includes('sudo'))).toBe(false);
  });

  it('adds a machine that has no rsync', async () => {
    healthy({ tools: ['tailscale', 'git', 'systemctl', 'loginctl'] });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(events.map((s) => s.step)).not.toContain('rsync');
    expect(ssh.remoteCalls().flat()).not.toContainEqual(expect.stringMatching(/\brsync\b/));
    expect(out.result).toBe('ready');
  });

  it('checks the tmux the units start once the release is installed, which is the release\'s own', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('tmux').at(-1)).toMatchObject({ status: 'ok', detail: "tmux 3.7c, Svall's own" });
    expect(ssh.remoteCalls().find((c) => c.includes('svall-tmux-version'))?.slice(0, 2)).toEqual(['env', UNIT_PATH]);
    expect(out.result).toBe('ready');
  });

  it('warns about a machine\'s tmux too old for Shift+Enter without blocking, for a release that carries none', async () => {
    healthy({ tmux: { stdout: '/usr/bin/tmux\ntmux 3.4\n' } });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('tmux').at(-1)).toMatchObject({ status: 'warn', detail: 'tmux 3.4 from /usr/bin/tmux: Shift+Enter needs tmux 3.5 or newer; Ubuntu 24.04 ships 3.4' });
    expect(out.result).toBe('ready');
  });

  it('stops with the apt command where neither the release nor the machine has a tmux', async () => {
    healthy({ tmux: { code: 3 } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tmux', actions: ['ssh trift.test, then sudo apt install tmux'] });
    expect(step('tmux').at(-1)).toMatchObject({ status: 'fail', run: 'sudo apt install tmux' });
    expect(step('install').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('stops on a release\'s tmux that cannot run there, naming its exit', async () => {
    healthy({ tmux: { stdout: `${BASE}/current/bin/tmux\n`, stderr: 'tmux: error while loading shared libraries: libtinfo.so.6\n', code: 127 } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tmux' });
    expect(step('tmux').at(-1)).toMatchObject({ status: 'fail', detail: `${BASE}/current/bin/tmux -V exited 127: tmux: error while loading shared libraries: libtinfo.so.6` });
  });

  it('reports a link lost at the tmux step as such, not as a missing tmux', async () => {
    healthy({ tmux: { stderr: 'Connection to trift.test closed by remote host.\n', code: 255 } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tmux' });
    expect(step('tmux').at(-1)).toEqual({ step: 'tmux', status: 'fail', detail: 'tmux -V exited 255: Connection to trift.test closed by remote host.' });
  });

  it('turns lingering on where it is off, and leaves nothing to do when the system lets it', async () => {
    healthy({ linger: 'Linger=no\nLinger=yes\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(ssh.remoteCalls().find((c) => c.includes('svall-linger'))?.join(' ')).toContain('loginctl enable-linger "$USER"');
    expect(step('linger').at(-1)).toMatchObject({ status: 'ok', detail: 'turned on for linus: the fleet keeps running after you log out' });
    expect(step('service').at(-1)).toMatchObject({ status: 'ok' });
    expect(out).toEqual({ result: 'ready', actions: [] });
  });

  it('surfaces the sudo enable-linger command, and the machine to run it on, when the system refuses to turn lingering on', async () => {
    const off = { status: 'warn', detail: 'off for linus: the fleet stops when you log out; run sudo loginctl enable-linger linus' };
    healthy({ linger: 'Linger=no\nLinger=no\n', doctor: doctorJson(off) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('linger').at(-1)).toMatchObject({
      status: 'warn', detail: 'off for linus, and the system refused to turn it on: the fleet stops when you log out',
      action: 'ssh trift.test, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus',
    });
    expect(step('service').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus' });
    // both steps name the one command, which the user is left to run once
    expect(out).toEqual({ result: 'actions', actions: ['ssh trift.test, then sudo loginctl enable-linger linus'] });
  });

  it('takes the service from a companion doctor that exits 1 over a check the service does not need', async () => {
    healthy();
    const failing = JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: 'not installed' }] });
    ssh.clearReplies();
    ssh.reply(['doctor', '--json'], { stdout: failing, code: 1 });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('service').at(-1)).toMatchObject({ status: 'ok' });
    expect(step('registry').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('names each step once, so the checklist never opens a phase twice', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    const names = events.filter((e) => e.status !== 'start').map((e) => e.step);
    expect(names).toEqual([
      'name', 'ssh', 'master', 'os', 'home', 'tools', 'space', 'linger',
      'release', 'upload', 'install', 'tmux', 'service', 'identity', 'enrol', 'claude', 'codex', 'opencode', 'gh', 'versions', 'probe', 'registry',
    ]);
  });

  it('host add ends with the mirror rows after the registry step, each with its tick, and is ready with them as what will not work there yet', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const asked: [MachineId, number][] = [];
    const rows = [unticked('claude:mcp:linear'), unticked('codex:mcp:github'), varRow('GAMMA_TOKEN')];
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ setupRows: (m, wait) => { asked.push([m, wait]); return Promise.resolve(rows); } }));
    await d.close();
    // a machine just linked has 30 s to come up
    expect(asked).toEqual([[REMOTE, 30_000]]);
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step).slice(-4)).toEqual(['registry', 'mirror:claude:mcp:linear', 'mirror:codex:mcp:github', 'mirror:var:GAMMA_TOKEN']);
    expect(step('mirror:claude:mcp:linear').at(-1)).toMatchObject({ status: 'warn', action: "copy linear's keys to trift", tick: { item: 'claude:mcp:linear', on: false } });
    expect(step('mirror:var:GAMMA_TOKEN').at(-1)).toMatchObject({ status: 'warn', action: 'set GAMMA_TOKEN on trift', run: 'svall worker env GAMMA_TOKEN' });
    expect(out).toEqual({ result: 'ready', actions: [], setup: ['mirror:claude:mcp:linear', 'mirror:codex:mcp:github', 'mirror:var:GAMMA_TOKEN'].map((k) => step(k).at(-1)) });
  });

  it('host add keeps two servers whose rows read alike as two rows of what will not work there, and leaves out rows that only ask to check again', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const again = (key: string): SetupRow => ({ key, status: 'warn', action: 'check trift again', detail: 'pushed; not yet on trift' });
    const rows = [unticked('claude:mcp:github'), unticked('codex:mcp:github'), again('var:X'), again('var:Y')];
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ setupRows: () => Promise.resolve(rows) }));
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [], setup: [step('mirror:claude:mcp:github').at(-1), step('mirror:codex:mcp:github').at(-1)] });
  });

  it('host add with only gh to log in to there is ready, and offers gh\'s login in the terminal', async () => {
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'gh', status: 'warn', detail: 'not logged in: gh auth login', run: 'gh auth login' }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('gh').at(-1)).toEqual({ step: 'gh', status: 'warn', detail: 'not logged in: gh auth login', run: 'gh auth login' });
    expect(out).toEqual({ result: 'ready', actions: [] });
  });

  it('host add whose daemon is not running ends in one not-checked row and the outcome line', async () => {
    const { outcomeText } = await import('../src/commands/host.js');
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ setupRows: () => Promise.reject(new Error('svalld is not running')) }));
    await d.close();
    expect(step('mirror:unchecked').at(-1)).toEqual({
      step: 'mirror:unchecked', status: 'warn', detail: 'not checked: svalld is not running', action: 'svall host doctor trift once Svall is open', gap: { name: 'agent setup', what: 'not checked' },
    });
    expect(outcomeText(out, 'add', 'trift', { there: THERE }))
      .toBe('trift is ready. 1 part of your agent setup will not work there yet:\n  agent setup  not checked  → svall host doctor trift once Svall is open');
  });

  it("the gh step reads the companion doctor's gh check: logged in, or gh auth login with the terminal and no thing to do", async () => {
    const said = (gh: Record<string, string>): string => JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'gh', ...gh }] });
    const loggedOut = 'not logged in: gh auth login (pull request links stay unresolved)';
    for (const [gh, want] of [
      [{ status: 'ok', detail: 'logged in' }, { status: 'ok', detail: 'logged in' }],
      [{ status: 'warn', detail: loggedOut, run: 'gh auth login' }, { status: 'warn', detail: loggedOut, run: 'gh auth login' }],
    ] as const) {
      ssh.clearReplies();
      events = [];
      healthy({ doctor: said(gh) });
      // stops at the probe, with no daemon to answer it, past the agents
      await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
      expect(step('gh')).toEqual([{ step: 'gh', ...want }]);
    }
    ssh.clearReplies();
    events = [];
    healthy();
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('gh')).toEqual([{ step: 'gh', status: 'skip', detail: "the companion's doctor reported no gh check" }]);
  });

  it('stops at the service when the fleet\'s unit is not running', async () => {
    const stopped = JSON.stringify({ checks: JSON.parse(DOCTOR).checks.map((c: { name: string }) => (c.name === 'systemd'
      ? { name: 'systemd', status: 'fail', detail: 'svall-svalld@private.service: loaded, inactive (dead), disabled' } : c)) });
    ssh.reply(['doctor', '--json'], { stdout: stopped, code: 1 });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('service').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('svall-svalld@private.service') });
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
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
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
    expect(step('master').at(-1)?.action).toBe('ssh refused.test and see what it answers');
    expect(out.result).toBe('actions');
  });

  it('says ssh refused a login without a prompt, and names how to give it a key, when the control master is refused', async () => {
    const out = await addHost({ name: 'trift', ssh: 'denied.test', release: archive() }, deps());
    const action = 'install a key there with ssh-copy-id denied.test and keep its passphrase in the agent with ssh-add --apple-use-keychain, then add the machine again';
    expect(step('master').at(-1)).toEqual({
      step: 'master', status: 'fail',
      detail: 'ssh refused the login to denied.test: every step from here logs in without a password or passphrase prompt', action,
    });
    expect(out.actions).toEqual([action]);
  });

  it('re-runs the probes for a machine already in the registry and keeps one record', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const run = async () => {
      events = [];
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
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
      home: HOME, svallBase: BASE,
    }, REMOTE);
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(step('name').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('name').at(-1)?.detail).toContain('other.test');
    expect(out.result).toBe('actions');
    expect(ssh.calls()).toEqual([]);
  });

  describe('again for a name in the registry', () => {
    const listed = (registry: MachineRegistry, home = HOME): void => {
      registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home, svallBase: `${home}/.local/share/svall` }, REMOTE);
    };

    it('installs nothing on a machine that answers as another than the registry names, and keeps its record', async () => {
      const registry = MachineRegistry.load(path.join(work, 'config'));
      listed(registry);
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: OTHER_MAC, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      expect(out.result).toBe('actions');
      expect(step('master').at(-1)).toMatchObject({
        status: 'fail', detail: `trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`,
        action: 'point trift.test back at trift, or svall host remove trift --forget',
      });
      expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
      expect(registry.list().filter((m) => m.record.name === 'trift').map((m) => m.id)).toEqual([REMOTE]);
    });

    it('stops at identity on a machine with no svall to ask that installs as another, and keeps its record', async () => {
      const far = path.join(work, 'far');
      const base = `${far}/.local/share/svall`;
      // this Mac's home is the far one, so the paths host add builds from it land in the far machine's
      const config = path.join(work, 'config');
      const file = path.join(config, 'machines.json');
      const { localId } = MachineRegistry.load(config);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { machines: Record<string, { home: string }> };
      saved.machines[localId].home = far;
      fs.writeFileSync(file, JSON.stringify(saved));
      const registry = MachineRegistry.load(config);
      listed(registry, far);
      for (const [match, stdout] of [
        [['uname', '-sm'], 'Linux aarch64\n'], [['cat', '/etc/os-release'], OS_RELEASE], [['svall-home'], `${far}\nlinus\n`],
        [['svall-tools'], ['tailscale', 'git', 'systemctl', 'loginctl'].map((t) => `${t} yes\n`).join('')],
        [['svall-tmux-version'], OWN_TMUX], [['svall-space'], DF], [['svall-linger'], 'Linger=yes\n'],
      ] as [string[], string][]) ssh.reply(match, { stdout });
      for (const bin of ['claude', 'codex', 'opencode']) ssh.reply([bin], { code: 127 });
      ssh.execute({});
      const svall = `#!/bin/sh
case "$1" in
  version) printf '%s\\n' '${JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC })}' ;;
  doctor) printf '%s\\n' '${DOCTOR}' ;;
  setup) mkdir -p '${base}' && tar -xzf "$3" -C '${base}' && ln -sfn '${base}/releases/1.2.3' '${base}/current' ;;
esac
`;
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: companionArchive(work, { signedBy: signer.key, svall }) }, deps({ registry }));
      expect(out.result).toBe('actions');
      expect(step('master').at(-1)).toMatchObject({ status: 'ok' });
      expect(step('identity').at(-1)).toEqual({
        step: 'identity', status: 'fail', detail: `trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`,
        action: 'point trift.test back at trift, or svall host remove trift --forget and add it again',
      });
      expect(registry.list().filter((m) => m.record.name === 'trift').map((m) => m.id)).toEqual([REMOTE]);
    });

    it('stops at identity when its setup went back to the release the machine ran, naming that release, and keeps its record', async () => {
      const registry = MachineRegistry.load(path.join(work, 'config'));
      listed(registry);
      const out = await wentBack(registry);
      const action = 'ssh trift.test and read the daemon log; trift runs release 1.2.2, the one its setup went back to; then svall host upgrade trift, or add the machine again';
      expect(out).toEqual({ result: 'actions', actions: [action], stopped: 'identity' });
      expect(step('identity').at(-1)).toMatchObject({ status: 'fail', action });
      expect(step('registry')).toEqual([]);
      expect(registry.list().filter((m) => m.record.name === 'trift').map((m) => m.id)).toEqual([REMOTE]);
    });
  });
});

describe('host doctor', () => {
  const registered = (home = HOME): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home, svallBase: BASE,
    }, REMOTE);
    return registry;
  };

  it('consentHost asks the daemon with the registry\'s id and the row\'s fields, the rows asked without waiting, and the command prints the rows with [x]', async () => {
    const asked: unknown[] = [];
    const waits: number[] = [];
    const rows = await consentHost('trift', { item: 'claude:mcp:linear', on: true }, deps({
      registry: registered(),
      setupRows: (_m, wait) => { waits.push(wait); return Promise.resolve([unticked('claude:mcp:linear')]); },
      consent: (...a) => { asked.push(a); return Promise.resolve([ticked('claude:mcp:linear')]); },
    }));
    expect([asked, waits]).toEqual([[[REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true]], [0]]);
    const { stepLine } = await import('../src/commands/host.js');
    expect(stepLine(rowStep(rows[0]))).toContain('[x]');
  });

  it('consentHost refuses an item no row names, a field its row does not list, and --field with off, which unticks every field; it takes listed fields as given', async () => {
    const consent = vi.fn(() => Promise.resolve([]));
    const d = deps({ registry: registered(), setupRows: () => Promise.resolve([unticked('claude:mcp:linear')]), consent });
    await expect(consentHost('trift', { item: 'codex:mcp:nope', on: true }, d)).rejects.toThrow('no setting codex:mcp:nope on trift; svall host doctor trift lists them');
    await expect(consentHost('trift', { item: 'claude:mcp:linear', on: true, fields: ['env.X'] }, d))
      .rejects.toThrow('claude:mcp:linear on trift has no field env.X; svall host doctor trift lists its fields');
    await expect(consentHost('trift', { item: 'claude:mcp:linear', on: false, fields: ['env.LINEAR_API_KEY'] }, d)).rejects.toThrow('off unticks every field of the item; leave out --field');
    expect(consent).not.toHaveBeenCalled();
    await consentHost('trift', { item: 'claude:mcp:linear', on: true, fields: ['env.LINEAR_API_KEY'] }, d);
    expect(consent).toHaveBeenCalledWith(REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    await consentHost('trift', { item: 'claude:mcp:linear', on: false }, d);
    expect(consent).toHaveBeenLastCalledWith(REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], false);
  });

  it('reads the companion\'s own doctor, version, linger and free space', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['systemd', 'linger', 'release', 'space']));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'ok', detail: expect.stringContaining('1.2.3') });
  });

  it('fails a machine whose fleet there does not run as a worker, so the check ends ready only once robots can move there', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    expect((await doctorHost('trift', deps({ registry: registered() }))).checks.find((c) => c.name === 'worker')).toEqual({
      name: 'worker', status: 'fail', detail: 'this fleet does not run there as a worker: svall host upgrade trift makes it one',
    });
    ssh.clearReplies();
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    const named = await doctorHost('trift', deps({ registry: registered(), fleet: { home: fleet, profile: 'work' } }));
    expect(named.checks.find((c) => c.name === 'worker')).toEqual({ name: 'worker', status: 'ok', detail: 'this fleet runs there as a worker' });
    expect(ssh.remoteCalls().filter((w) => w.includes('version')).at(-1)).toEqual([SVALL, '-p', 'work', 'version', '--json']);
  });

  it("fails a machine whose fleet home serves another Mac as a worker, with that row's action", async () => {
    for (const [far, detail] of [
      [{ worker: { homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET } }, 'trift already serves bea-mbp as a worker; remove it from that Mac first; on bea-mbp, run svall host remove trift'],
      [{ worker: { ...SERVES, fleetId: OTHER_FLEET } }, 'this fleet does not run there as a worker: svall host upgrade trift makes it one'],
    ] as const) {
      ssh.clearReplies();
      ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
      ssh.reply(['svall-space'], { stdout: DF });
      ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, ...far }) });
      expect((await doctorHost('trift', deps({ registry: registered() }))).checks.find((c) => c.name === 'worker')).toEqual({ name: 'worker', status: 'fail', detail });
    }
  });

  it("compares each agent's release, as the companion's units run it, with this Mac's, and names the update there", async () => {
    const homes = { CLAUDE_CONFIG_DIR: `${HOME}/agents/claude` };
    ssh.reply(['doctor', '--json'], { stdout: JSON.stringify({ ...JSON.parse(DOCTOR), daemonEnv: homes }) });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['svall-space'], { stdout: DF });
    const env = [UNIT_PATH, `CLAUDE_CONFIG_DIR=${homes.CLAUDE_CONFIG_DIR}`];
    // the machine's own claude check names no command for one below Svall's floor
    ssh.reply([...env, 'claude', '--version'], { stdout: '2.1.250 (Claude Code)\n' });
    ssh.reply([...env, 'codex', '--version'], { stdout: 'codex-cli 0.156.1\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'versions')).toEqual({
      name: 'versions', status: 'warn',
      detail: 'claude 2.1.250 there, behind 2.1.278 on this Mac: a move there and back needs the same release on both; ssh trift.test, then claude update',
      run: 'claude update',
    });
    // a check only reads
    expect(ssh.remoteCalls().filter((w) => w.includes('claude')).map((w) => w.slice(-1))).toEqual([['--version']]);
  });

  it('says whether the machine\'s release and this controller\'s are signed, taking a release that does not say as unsigned', async () => {
    const release = async (version: Record<string, unknown>, signed: boolean) => {
      ssh.clearReplies();
      ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, ...version }) });
      ssh.reply(['svall-space'], { stdout: DF });
      const report = await doctorHost('trift', deps({ registry: registered(), controller: { release: '1.2.3', protocol: PROTOCOL_VERSION, releaseRoot: work, signed } }));
      return report.checks.find((c) => c.name === 'release')?.detail;
    };
    expect(await release({ signed: true }, true)).toBe(`1.2.3 (signed), protocol ${PROTOCOL_VERSION}; this controller runs 1.2.3 (signed), protocol ${PROTOCOL_VERSION}`);
    expect(await release({}, false)).toBe(`1.2.3 (unsigned), protocol ${PROTOCOL_VERSION}; this controller runs 1.2.3 (unsigned), protocol ${PROTOCOL_VERSION}`);
  });

  it('host doctor lists the rows as checks with action, tick and forward; the verdict counts each warn row with an action', async () => {
    const { doctorVerdict } = await import('../src/commands/host.js');
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    const login: SetupRow = {
      key: 'oauth:codex:mcp:figma', status: 'skip', run: 'codex mcp login figma', forward: 1455, detail: 'log in once on trift with codex mcp login figma; Svall cannot see whether you did',
      gap: { name: 'figma', what: 'log in once; Svall cannot check' },
    };
    const asked: [MachineId, number][] = [];
    const report = await doctorHost('trift', deps({
      registry: registered(),
      setupRows: (m, wait) => { asked.push([m, wait]); return Promise.resolve([unticked('claude:mcp:linear'), unticked('codex:mcp:github'), okRow('var:X'), login]); },
    }));
    expect(asked).toEqual([[REMOTE, 0]]);
    expect(report.checks.filter((c) => c.name.startsWith('mirror:'))).toMatchObject([
      { name: 'mirror:claude:mcp:linear', status: 'warn', action: "copy linear's keys to trift", tick: { on: false } },
      { name: 'mirror:codex:mcp:github', status: 'warn', action: "copy github's keys to trift", tick: { on: false } }, { name: 'mirror:var:X', status: 'ok' },
      { name: 'mirror:oauth:codex:mcp:figma', status: 'skip', run: 'codex mcp login figma', forward: 1455 },
    ]);
    // after the checks the machine answers
    expect(report.checks.findIndex((c) => c.name.startsWith('mirror:'))).toBe(report.checks.length - 4);
    expect(doctorVerdict(report.checks, 'trift', THERE)).toBe([
      'trift is ready. 3 parts of your agent setup will not work there yet:',
      '  linear  keys not copied (env.LINEAR_API_KEY)  → svall host consent trift claude:mcp:linear on',
      '  github  keys not copied (env.GITHUB_API_KEY)  → svall host consent trift codex:mcp:github on',
      '  figma   log in once; Svall cannot check       → ssh -L 1455:localhost:1455 trift.test, then codex mcp login figma',
    ].join('\n'));
  });

  it('a not-checked row names the doctor of the fleet the rows were asked of', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    const report = await doctorHost('trift', deps({ registry: registered(), fleet: { home: fleet, profile: 'work' }, setupRows: () => Promise.reject(new Error('svalld is not running')) }));
    expect(report.checks.at(-1)).toEqual({
      name: 'mirror:unchecked', status: 'warn', detail: 'not checked: svalld is not running', action: 'svall -p work host doctor trift once Svall is open', gap: { name: 'agent setup', what: 'not checked' },
    });
  });

  it('keeps what a check found and the release the machine runs, by machine id, for host list', async () => {
    const config = path.join(work, 'config');
    ssh.reply(['doctor', '--json'], { stdout: doctorJson({ status: 'warn', detail: 'off for linus' }) });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: { ...SERVES, homeMachineId: machineId(config) } }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    registered().save();
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    const said: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { said.push(String(chunk)); return true; });
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['doctor', 'trift'], { from: 'user' });
    } finally {
      out.mockRestore();
    }
    // linger; the mirror's not-checked row, as this fleet's daemon is not running, is agent setup and no warning
    expect(lastChecks(config)).toEqual({ [REMOTE]: { at: expect.any(Number), failed: 0, warned: 1, release: '1.2.3' } });
    expect((JSON.parse(said.join('')) as HostReport).checks.at(-1)).toEqual({
      name: 'mirror:unchecked', status: 'warn', detail: expect.stringMatching(/^not checked: svalld is not running/), action: 'svall host doctor trift once Svall is open',
      gap: { name: 'agent setup', what: 'not checked' },
    });
    expect(Date.now() - lastChecks(config)[REMOTE]!.at).toBeLessThan(60_000);
  });

  it("drops a removed machine's check, and the file with the last one", async () => {
    const config = path.join(work, 'config');
    fs.mkdirSync(config, { recursive: true });
    const check = { at: 1, failed: 0, warned: 0 };
    fs.writeFileSync(path.join(config, 'checks.json'), JSON.stringify({ [REMOTE]: check, [OTHER_MAC]: check }));
    const { forgetCheck, lastChecks } = await import('../src/commands/host.js');
    forgetCheck(config, REMOTE);
    expect(lastChecks(config)).toEqual({ [OTHER_MAC]: check });
    forgetCheck(config, REMOTE);
    expect(lastChecks(config)).toEqual({ [OTHER_MAC]: check });
    forgetCheck(config, OTHER_MAC);
    expect(fs.existsSync(path.join(config, 'checks.json'))).toBe(false);
  });

  it("keeps a machine's check while host remove leaves it in the registry, and drops it with --forget", async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    const check = { at: 1, failed: 0, warned: 0 };
    fs.writeFileSync(path.join(config, 'checks.json'), JSON.stringify({ [REMOTE]: check, [OTHER_MAC]: check }));
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['remove', 'trift'], { from: 'user' }).catch(() => undefined);
      expect(lastChecks(config)).toEqual({ [REMOTE]: check, [OTHER_MAC]: check });
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['remove', 'trift', '--forget'], { from: 'user' });
      expect(lastChecks(config)).toEqual({ [OTHER_MAC]: check });
    } finally { out.mockRestore(); process.exitCode = 0; }
  });

  it('keeps a check that could not reach the machine as failed, so host list never shows an older ready', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    await expect(hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['doctor', 'trift'], { from: 'user' })).rejects.toThrow();
    expect(lastChecks(config)).toEqual({ [REMOTE]: { at: expect.any(Number), failed: 1, warned: 0 } });
  });

  it('names the remote user, not the machine, when the companion reports no linger of its own', async () => {
    ssh.reply(['doctor', '--json'], { stdout: doctorJson() });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['svall-linger'], { stdout: 'Linger=no\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    const linger = report.checks.find((c) => c.name === 'linger');
    expect(linger).toMatchObject({ status: 'warn', detail: 'off for linus: the fleet stops when you log out; ssh trift.test, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus' });
    // a check only reads
    expect(ssh.remoteCalls().some((c) => c.join(' ').includes('enable-linger'))).toBe(false);
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
      detail: `${ELSEWHERE} is linus's home on trift, and the registry records ${HOME}; svall host remove trift, then svall host add again`,
    });
  });

  it('passes the home of a machine registered at a home other than this Mac\'s', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${ELSEWHERE}\nlinus\n` });
    const report = await doctorHost('trift', deps({ registry: registered(ELSEWHERE) }));
    expect(report.checks.find((c) => c.name === 'home')).toEqual({ name: 'home', status: 'ok', detail: `${ELSEWHERE} for linus` });
  });

  it('reports a release other than the controller\'s as a failure', async () => {
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
      home: HOME, svallBase: BASE,
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
      home: HOME, svallBase: BASE,
    }, REMOTE);
    return registry;
  };

  /**
   * A companion on this machine: every far command runs here, `current` is a real link, and each release's svall is a
   * script that answers as that release, naming the state schema it reads unless that is null. Its setup installs an archive and keeps it only while the new release's daemon
   * comes up (no `down-<release>` file beside the releases) and speaks the protocol this svall's client does; else it goes
   * back to the release it replaced, or after a reinstall under that name to the newest other kept, as a real setup does.
   */
  async function farMachine(o: { releases: [string, number, (number | null)?][]; accepts?: (release: string) => boolean; pins?: string }) {
    const home = path.join(work, 'far');
    const base = `${home}/.local/share/svall`;
    const now = () => path.basename(fs.readlinkSync(`${base}/current`));
    const d = await daemon({ release: now, accepts: () => o.accepts?.(now()) ?? true });
    const svall = (version: string, protocol: number, schema: number | null = STATE_SCHEMA_VERSION) => `#!/bin/sh
base='${base}'
now() { basename "$(readlink "$base/current")"; }
[ "$1" = -p ] && shift 2
case "$1" in
  connection-info) printf '%s\\n' '${JSON.stringify({ fleetId: FLEET, machineId: REMOTE, release: version, protocol, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' })}' ;;
  version) x=; for k in worker; do [ -f '${home}/.svall/'$k ] && x="$x,\\"$k\\":$(cat '${home}/.svall/'$k)"; done
    printf '%s%s\\n}\\n' '${JSON.stringify({ release: version, machineId: REMOTE, protocol, ...(schema !== null && { stateSchema: schema }) }, null, 2).slice(0, -2)}' "$x" ;;
  doctor) printf '%s\\n' '${DOCTOR}' ;;
  worker) printf '%s\\n' "$@" > '${home}/.svall/worker-args' && cat > '${home}/.svall/worker-token' ;;
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
      back=$was; [ "$was" != "$new" ] || back=$(ls -t "$base/releases" | grep -vx "$new" | head -1)
      if [ -n "$back" ]; then ln -sfn "$base/releases/$back" "$base/current" && echo "the daemon did not answer: current -> $base/releases/$back"; fi
    fi ;;
esac
`;
    for (const [version, protocol, schema] of o.releases) {
      fs.mkdirSync(`${base}/releases/${version}/bin`, { recursive: true });
      fs.writeFileSync(`${base}/releases/${version}/bin/svall`, svall(version, protocol, schema), { mode: 0o755 });
      fs.mkdirSync(`${base}/releases/${version}/release`);
      fs.copyFileSync(o.pins ?? signer.signers, `${base}/releases/${version}/release/allowed_signers`);
    }
    fs.symlinkSync(`${base}/releases/${o.releases.at(-1)![0]}`, `${base}/current`);
    // the fleet's unit there, which runs it as this fleet's worker, as its worker.json says
    const units = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(units, { recursive: true });
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${base}/current/bin/svalld" "--worker"\n`);
    serves(SERVES);
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home, svallBase: base }, REMOTE);
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    ssh.execute({});
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

  it('ends with the machine\'s agent setup rows, its link given 30 s, and is ready with them as what will not work there yet', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION - 1]] });
    const asked: [MachineId, number][] = [];
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, setupRows: (m, wait) => { asked.push([m, wait]); return Promise.resolve([unticked('claude:mcp:linear')]); } }));
    await far.close();
    expect(asked).toEqual([[REMOTE, 30_000]]);
    expect(events.filter((e) => e.status !== 'start').at(-1)?.step).toBe('mirror:claude:mcp:linear');
    expect(out).toEqual({ result: 'ready', actions: [], setup: [step('mirror:claude:mcp:linear').at(-1)] });
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
    ssh.execute({ path: `node_modules/.bin:${process.env.PATH}` });
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
      [['svall-tools'], ['tailscale', 'git', 'systemctl', 'loginctl'].map((t) => `${t} yes\n`).join('')],
      [['svall-tmux-version'], OWN_TMUX], [['svall-space'], DF], [['svall-linger'], 'Linger=yes\n'],
    ] as [string[], string][]) ssh.reply(match, { stdout });
    for (const bin of ['claude', 'codex', 'opencode']) ssh.reply([bin], { code: 127 });
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

  it('after a reinstall under the name it ran that its own setup took back, stays on the release that setup went back to', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    fs.writeFileSync(`${far.base}/down-1.2.3`, '');
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(far.now()).toBe('1.2.2');
    expect(ssh.remoteCalls()).toContainEqual([`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback', '1.2.2']);
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn', action: expect.stringMatching(/it runs release 1\.2\.2, the newest one kept there$/) });
  });

  it('after a reinstall under the only name it had, says no other release is kept to go back to', async () => {
    const far = await farMachine({ releases: [['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('rollback').at(-1)).toMatchObject({ status: 'fail', action: expect.stringMatching(/no other release is kept there, so it runs the new one; svall host upgrade trift --rollback <release> puts back a release kept there$/) });
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

  const unitDown = JSON.stringify({ checks: JSON.parse(DOCTOR).checks.map((c: { name: string }) => (c.name === 'systemd'
    ? { name: 'systemd', status: 'fail', detail: 'svall-svalld@private.service: loaded, inactive (dead), disabled' } : c)) });

  it('puts a new release whose fleet unit is not running back on the release before, though its daemon answers', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    ssh.reply(['doctor', '--json'], { stdout: unitDown, code: 1 });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'warn', detail: expect.stringContaining('svall-svalld@private.service') });
    expect(far.now()).toBe('1.2.2');
  });

  it('fails a rollback whose fleet unit is not running after it, and says which release the machine runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    ssh.reply(['doctor', '--json'], { stdout: unitDown, code: 1 });
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('svall-svalld@private.service'), action: expect.stringContaining('trift runs release 1.2.2') });
  });

  /** The far machine's systemctl, which writes each call it is given to `log`, first on the far PATH; it fails while `broken` is there. */
  const farSystemctl = (broken = path.join(work, 'systemctl-broken')): string => {
    const bin = path.join(work, 'far-bin');
    const log = path.join(work, 'systemctl.log');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\n[ -e '${broken}' ] && { echo 'Failed to connect to bus' >&2; exit 1; }\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    ssh.execute({ path: `${bin}:${process.env.PATH}` });
    return log;
  };

  it('upgrade stops and removes a gateway unit it finds there and makes the provisioned unit the worker, with no other step', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const home = path.join(work, 'far');
    const units = path.join(home, '.config', 'systemd', 'user');
    fs.writeFileSync(path.join(units, 'svall-gateway.service'), '[Service]\n');
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${far.base}/current/bin/svalld"\n`);
    fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: REMOTE }));

    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();

    expect(out).toEqual({ result: 'ready', actions: [] });
    const mac = far.registry.localMachine().name;
    expect(fs.readFileSync(path.join(home, '.svall', 'worker-args'), 'utf8').split('\n')).toEqual(['worker', 'enroll', '--home-machine', MAC, '--home-name', mac, '--fleet-id', FLEET, '']);
    expect(fs.readFileSync(path.join(home, '.svall', 'worker-token'), 'utf8')).toBe(tokenFor(resolvePaths(fleet), REMOTE));
    expect(fs.readFileSync(systemctl, 'utf8')).toBe('--user disable --now svall-gateway.service\n--user daemon-reload\n');
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(false);
    expect(step('enrol').at(-1)).toMatchObject({ status: 'ok', detail: expect.stringContaining('; svall-gateway.service is stopped and removed') });
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step)).toEqual(['machine', 'master', 'os', 'release', 'upload', 'install', 'probe', 'enrol']);
    expect(refreshed).toBe(1);
  });

  /** What the far fleet home serves, as its `svall version --json` names it: the home it is a worker of, or none. */
  const serves = (worker?: object): void => {
    fs.mkdirSync(path.join(work, 'far', '.svall'), { recursive: true });
    const at = path.join(work, 'far', '.svall', 'worker');
    if (worker) fs.writeFileSync(at, JSON.stringify(worker));
    else fs.rmSync(at, { force: true });
  };

  /** The machine as an earlier release left it: its gateway unit, a fleet unit without --worker, fleet.json naming it, and no worker.json there. */
  const oldGateway = (): { units: string } => {
    serves();
    const units = path.join(work, 'far', '.config', 'systemd', 'user');
    fs.writeFileSync(path.join(units, 'svall-gateway.service'), '[Service]\n');
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${work}/far/.local/share/svall/current/bin/svalld"\n`);
    fs.mkdirSync(path.join(work, 'far', '.svall'), { recursive: true });
    fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: REMOTE }));
    return { units };
  };

  /** The signers the release an upgrade installed pins, as a real release carries them, for the upgrade after it. */
  const pinSigners = (base: string): void => {
    fs.mkdirSync(`${base}/current/release`, { recursive: true });
    fs.copyFileSync(signer.signers, `${base}/current/release/allowed_signers`);
  };

  it('enrols nothing while the gateway unit there will not stop, and a run again makes the machine the worker', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const broken = path.join(work, 'systemctl-broken');
    fs.writeFileSync(broken, '');
    farSystemctl(broken);
    const { units } = oldGateway();

    const first = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    expect(first).toMatchObject({ result: 'actions', stopped: 'enrol' });
    expect(step('enrol').at(-1)).toMatchObject({ status: 'fail', detail: 'systemctl --user disable --now svall-gateway.service exited 1: Failed to connect to bus' });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(true);

    fs.rmSync(broken);
    events = [];
    pinSigners(far.base);
    const again = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(again).toEqual({ result: 'ready', actions: [] });
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(false);
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toHaveLength(1);
  });

  it('upgrade of a machine already the worker stops and removes a gateway unit it finds there, enrolling nothing', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const { units } = oldGateway();
    serves(SERVES);
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${far.base}/current/bin/svalld" "--worker"\n`);
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls()).toContainEqual(expect.arrayContaining(['systemctl --user disable --now "$(basename "$1")" && rm -f "$1" && systemctl --user daemon-reload']));
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.readFileSync(systemctl, 'utf8')).toBe('--user disable --now svall-gateway.service\n--user daemon-reload\n');
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'ok', detail: 'trift serves this fleet as a worker; svall-gateway.service is stopped and removed' });
    expect(events.map((e) => e.step)).not.toContain('fleet');
  });

  it('leaves a machine that serves this fleet as a worker as it is, past the release it installs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'skip', detail: 'trift serves this fleet as a worker' });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.existsSync(systemctl)).toBe(false);
  });

  it('enrols nothing over a fleet home there that serves another Mac as a worker, and changes nothing there', async () => {
    const action = 'on bea-mbp, run svall host remove trift';
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const { units } = oldGateway();
    serves({ homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET });
    events = [];
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'actions', stopped: 'enrol', actions: [action] });
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from that Mac first', action });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(fleet, 'fleet.json'), 'utf8'))).toEqual({ id: FLEET, gatewayMachineId: REMOTE });
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(true);
    expect(fs.existsSync(systemctl)).toBe(false);
  });

  it('enrols a worker unit there whose worker.json names another fleet of this Mac', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    serves({ ...SERVES, fleetId: OTHER_FLEET });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toHaveLength(1);
  });

  it('names the add that enrols a machine running no unit of this fleet', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    fs.rmSync(path.join(work, 'far', '.config', 'systemd', 'user', 'svall-svalld@private.service'));
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    const action = "svall host add trift --ssh trift.test again makes it this fleet's worker";
    expect(out).toEqual({ result: 'actions', actions: [action] });
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'warn', detail: 'no unit of this fleet runs on trift', action });
  });

  it('upgrade runs where owner.json and route.json name another machine', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const owner = (home: string, fleetId: string) => {
      fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId, generation: 2, ownerMachineId: REMOTE }));
      fs.mkdirSync(path.join(home, 'controller'), { recursive: true });
      fs.writeFileSync(path.join(home, 'controller', 'route.json'), JSON.stringify({ ownerMachineId: REMOTE, generation: 2, at: '2026-10-01T00:00:00.000Z' }));
    };
    owner(fleet, FLEET);
    const lab = path.join(work, '.svall-lab');
    fs.mkdirSync(lab);
    fs.writeFileSync(path.join(lab, 'fleet.json'), JSON.stringify({ id: OTHER_FLEET }));
    owner(lab, OTHER_FLEET);
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('machine').at(-1)?.status).toBe('ok');
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.3');
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

  it('probes a rollback onto a release that speaks the protocol before this controller\'s', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.2');
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'trift answers on release 1.2.2' });
  });

  /** A fleet on the far machine, kept in `dir` under its home, whose state.json is at `version`. */
  const fleetState = (dir: string, version: number): string => {
    const file = path.join(work, 'far', dir, 'state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...emptyState(), version }, null, 2)}\n`);
    return file;
  };

  it('refuses a rollback onto a release that reads an older state schema than a fleet there keeps, before anything changes', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, STATE_SCHEMA_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    fleetState('.svall', STATE_SCHEMA_VERSION - 1);
    const newer = fleetState('.svall-work', STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    const named = await rollbackHost('trift', { to: '1.2.2' }, deps({ registry: far.registry }));
    await far.close();
    expect([out.result, named.result]).toEqual(['actions', 'actions']);
    expect(step('rollback')).toEqual([1, 2].map(() => ({
      step: 'rollback', status: 'fail',
      detail: `${newer} is at state schema ${STATE_SCHEMA_VERSION}, and release 1.2.2 reads ${STATE_SCHEMA_VERSION - 1}: its svalld would refuse to start after going back; trift stays on release 1.2.3`,
    })));
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
    expect(far.now()).toBe('1.2.3');
  });

  it('refuses a rollback onto a release carrying no tmux while a fleet\'s server runs a tmux the machine\'s own cannot reach', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    const served = path.join(work, 'served');
    fs.writeFileSync(`${far.base}/releases/1.2.3/bin/tmux`, `#!/bin/sh\ncat '${served}'\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(work, 'far', '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(work, 'far', '.local', 'bin', 'tmux'), '#!/bin/sh\necho "tmux 3.4"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(work, 'far', '.svall'), { recursive: true });
    const sock = path.join(work, 'far', '.svall', 'tmux.sock');
    const server = net.createServer().listen(sock);
    await once(server, 'listening');
    fs.writeFileSync(served, 'tmux 3.7c\n');
    const refused = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    fs.writeFileSync(served, 'tmux 3.4\n');
    const back = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    server.close();
    await far.close();
    expect(refused.result).toBe('actions');
    expect(step('rollback')[0]).toEqual({
      step: 'rollback', status: 'fail',
      detail: `${sock} is served by tmux 3.7c, and release 1.2.2 carries no tmux and would run the machine's (tmux 3.4), which cannot reach it; trift stays on release 1.2.3`,
    });
    expect(back.result).toBe('ready');
    expect(far.now()).toBe('1.2.2');
  });

  it('refuses a rollback onto a release that reads an older state schema than a fleet in a home named for a command svall keeps', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, STATE_SCHEMA_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    fleetState('.svall', STATE_SCHEMA_VERSION - 1);
    const newer = fleetState('.svall-host', STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('rollback').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`${newer} is at state schema ${STATE_SCHEMA_VERSION}`) });
    expect(far.now()).toBe('1.2.3');
  });

  it('goes back onto a release that reads every fleet\'s state there, whatever a folder no profile names holds', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, STATE_SCHEMA_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    fleetState('.svall', STATE_SCHEMA_VERSION - 1);
    fleetState('.svall-work.old', STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.2');
  });

  it('refuses a rollback onto a release that does not say which state schema it reads only while a fleet there is newer than any release read', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, null], ['1.2.3', PROTOCOL_VERSION]] });
    const state = fleetState('.svall', OLDEST_STATE_SCHEMA_VERSION + 1);
    const refused = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    expect(refused.result).toBe('actions');
    expect(step('rollback').at(-1)).toMatchObject({
      status: 'fail',
      detail: `release 1.2.2 does not say which state schema it reads, and ${state} is at state schema ${OLDEST_STATE_SCHEMA_VERSION + 1}, newer than the oldest a release has read (${OLDEST_STATE_SCHEMA_VERSION}): its svalld could refuse to start after going back; trift stays on release 1.2.3`,
    });
    expect(far.now()).toBe('1.2.3');
    fleetState('.svall', OLDEST_STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.2');
  });

  it('rolls back from the command line, and refuses a rollback asked with a release to install', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    far.registry.save();
    const { hostCommands } = await import('../src/commands/host.js');
    const cli = () => hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => path.join(work, 'config'));
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
    expect(step('rollback').at(-1)?.action).toContain('svall host upgrade trift --rollback <release>');
  });

  it('names the ssh to try in Terminal when an upgrade or a rollback cannot connect', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    for (const run of [() => upgradeHost('trift', {}, deps({ registry })), () => rollbackHost('trift', {}, deps({ registry }))]) {
      events.length = 0;
      ssh.clearReplies();
      expect((await run()).result).toBe('actions');
      expect(step('master').at(-1)).toMatchObject({ status: 'fail', action: 'ssh refused.test once in Terminal and see what it answers, then run this again' });
    }
  });

  it('keeps a new release whose companion doctor exits 1 over a check unrelated to the daemon', async () => {
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: doctorJson({ status: 'warn', detail: 'off' }).replace('"tmux 3.4"}', '"tmux 3.4"},{"name":"hooks","status":"fail","detail":"not installed"}'), code: 1 });
    ssh.reply(['svall-units'], { stdout: 'worker\n' });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }, null, 2) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
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

  it('uploads and installs nothing on an Ubuntu older than the release runs on', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.2', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\n' });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    expect(out).toMatchObject({ result: 'actions', stopped: 'os' });
    expect(step('os').at(-1)).toMatchObject({ status: 'fail', detail: 'Ubuntu 20.04 is older than 22.04, the oldest release the companion runs on' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
  });

  it('deletes the archive it uploaded and the release it unpacked once the release is installed', async () => {
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    await d.close();
    expect(ssh.remoteCalls()).toContainEqual(['rm', '-rf', `${HOME}/.cache/svall/staging-1.2.3`, `${HOME}/.cache/svall/companion-1.2.3.tar.gz`]);
  });
});

describe('host list', () => {
  it('names each machine with its ssh and its last check, this Mac without an ssh', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'ada@trift', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    const { machineRows } = await import('../src/commands/host.js');
    const check = { at: 1, failed: 0, warned: 2, release: '1.2.3' };
    const rows = machineRows(registry, { [REMOTE]: check });
    expect(rows).toEqual([
      { name: registry.localMachine().name, id: registry.localId, platform: `${process.platform === 'linux' ? 'linux' : 'darwin'}-${process.arch}` },
      { name: 'trift', id: REMOTE, ssh: 'ada@trift', platform: 'linux-arm64', check },
    ]);
  });
});

describe('host remove', () => {
  const registered = (destination: string): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: destination, platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    }, REMOTE);
    return registry;
  };

  it('uninstalls nothing while a robot of a fleet here is on the machine or moving to it, and names them; --forget still drops the route', async () => {
    const ada = {
      id: 'c_ada', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'ada', portrait: 'fox', note: '', instructions: '', cwd: '/home/ada/app', context: [], shell: { lastOutputAt: 0 }, unread: false,
      machine: REMOTE, placement: { generation: 1 },
    };
    const bo = { ...ada, id: 'c_bo', name: 'bo', cell: { x: 1, y: 0 }, machine: undefined, placement: undefined, moving: { id: 'mv_0123456789', to: REMOTE, phase: 'bundle' } };
    const cy = { ...ada, id: 'c_cy', name: 'cy', cell: { x: 2, y: 0 }, machine: undefined, placement: undefined };
    const state = (robots: object) => fs.writeFileSync(path.join(fleet, 'state.json'), JSON.stringify({ ...emptyState(), robots }));
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');

    state({ c_ada: ada, c_bo: bo, c_cy: cy });
    const many = await removeHost('trift', {}, deps({ registry }));
    expect(many).toEqual({ result: 'actions', stopped: 'machine', actions: ['svall robot move <id> --machine local for each'] });
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: '2 robots are on trift: ada, bo; move them back first' });
    state({ c_ada: ada, c_cy: cy });
    events = [];
    expect(await removeHost('trift', {}, deps({ registry, fleet: { home: fleet, profile: 'work' } }))).toMatchObject({ actions: ['svall -p work robot move c_ada --machine local'] });
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: '1 robot is on trift: ada; move it back first' });
    expect(ssh.remoteCalls()).toEqual([]);
    expect(registry.get('trift')).toBeDefined();

    expect((await removeHost('trift', { forget: true }, deps({ registry }))).result).toBe('ready');
    expect(registry.get('trift')).toBeUndefined();
  });

  it("clears the machine's consent in every fleet home here, on remove and on --forget", async () => {
    const second = path.join(work, '.svall-other');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(resolvePaths(second).fleetConfig, JSON.stringify({ id: FLEET }));
    const files = [resolvePaths(fleet).mirrorConsent, resolvePaths(second).mirrorConsent];
    for (const forget of [false, true]) {
      for (const f of files) fs.writeFileSync(f, JSON.stringify({ [REMOTE]: ['claude:mcp:linear#env.K'], [OTHER_MAC]: ['codex:mcp:g#env.K'] }));
      ssh.reply(['uninstall'], { stdout: 'removed\n' });
      await removeHost('trift', { forget }, deps({ registry: registered('trift.test') }));
      for (const f of files) expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ [OTHER_MAC]: ['codex:mcp:g#env.K'] });
    }
  });

  it('names the machine on the line the far uninstall ends with, whose rm -rf is for that machine', async () => {
    ssh.reply(['uninstall'], { stdout: `removed ${BASE}/current\nkept ${HOME}/.svall; rm -rf '${HOME}/.svall' deletes them\n` });
    await removeHost('trift', {}, deps({ registry: registered('trift.test') }));
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'ok', detail: `on trift.test: kept ${HOME}/.svall; rm -rf '${HOME}/.svall' deletes them` });
  });

  it('shows what the far uninstall did with the keys the mirror copied there, and ends with what is left to do where it could not take one back or one changed there since', async () => {
    const claudeJson = `${HOME}/.claude.json`;
    const mcp = `${HOME}/.claude/plugins/cache/mp/acme/1.0.0/.mcp.json`;
    ssh.reply(['uninstall'], { stdout: [
      `took 1 key the mirror copied out of ${HOME}/.claude/settings.json`,
      `could not take the mirror's keys back from ${claudeJson}: ${claudeJson} cannot be parsed`,
      `left ${mcp}, which holds keys the mirror copied and changed there since`,
      `removed ${BASE}/current`,
    ].join('\n') });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(events.filter((e) => e.status !== 'start').at(-1)).toMatchObject({
      step: 'keys', status: 'warn', action: 'ssh trift.test, then take the keys the mirror copied out of the files named here, or delete those files',
    });
    expect(step('keys').at(-1)!.detail!.split('; ')).toEqual([
      `took 1 key the mirror copied out of ${HOME}/.claude/settings.json`, `could not take the mirror's keys back from ${claudeJson}: ${claudeJson} cannot be parsed`,
      `left ${mcp}, which holds keys the mirror copied and changed there since`,
    ]);
    expect(out).toMatchObject({ result: 'actions', actions: ['ssh trift.test, then take the keys the mirror copied out of the files named here, or delete those files'] });
    expect(registry.get('trift')).toBeUndefined();
  });

  it('shows the keys the far uninstall took back as done', async () => {
    ssh.reply(['uninstall'], { stdout: `took 1 key the mirror copied out of ${HOME}/.claude.json\nremoved ${BASE}/current\n` });
    expect(await removeHost('trift', {}, deps({ registry: registered('trift.test') }))).toEqual({ result: 'ready', actions: [] });
    expect(step('keys').at(-1)).toMatchObject({ status: 'ok', detail: `took 1 key the mirror copied out of ${HOME}/.claude.json` });
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
    // a forget that went through leaves nothing to do, so it ends ready and exits 0
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'skip', detail: expect.stringContaining('trift.test') });
  });

  it('reports a far uninstall that failed for itself with its exit and what it said, not as a machine out of reach', async () => {
    ssh.reply(['uninstall'], { stderr: 'svall: tmux refused to stop the fleet\n', code: 1 });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    const failed = step('uninstall').at(-1);
    expect(failed).toMatchObject({ status: 'fail', detail: 'svall uninstall exited 1 on trift.test: svall: tmux refused to stop the fleet' });
    expect(failed?.action).toContain('ssh trift.test, then svall uninstall');
    expect(registry.get('trift')).toBeDefined();
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

  it('remove runs svall uninstall there with no flag before it drops the registry entry, and leaves this Mac\'s fleet.json as it is', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls().find((a) => a.includes('uninstall'))).toEqual([SVALL, 'uninstall']);
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step)).toEqual(['machine', 'uninstall', 'registry']);
    expect(registry.get('trift')).toBeUndefined();
    expect(gatewayOf(mine)).toBe(REMOTE);
  });

  it('forgets an unreachable machine and says the remote was left alone', async () => {
    const registry = registered('refused.test');
    const out = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(registry.get('trift')).toBeUndefined();
    expect(out.result).toBe('ready');
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'skip', detail: expect.stringContaining('refused.test') });
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

describe('the last line a run prints', () => {
  it('names what each command did as the Machines panel does', async () => {
    const { doneLine } = await import('../src/commands/host.js');
    expect(doneLine('add', 'trift')).toBe('trift is added');
    expect(doneLine('upgrade', 'trift')).toBe('trift is upgraded');
    expect(doneLine('rollback', 'trift')).toBe('trift is rolled back');
    expect(doneLine('remove', 'trift')).toBe('trift is removed');
    expect(doneLine('remove', 'trift', { forget: true })).toBe('trift is forgotten');
  });

  it('the outcome line reads ready when nothing is left to do, counts the things to fix otherwise, then lists what of the agent setup will not work there yet', async () => {
    const { doctorVerdict, outcomeText } = await import('../src/commands/host.js');
    const ready = 'trift is ready. Robots you move there keep working while this Mac sleeps.';
    const linger = 'ssh trift, then loginctl enable-linger linus';
    const login = 'ssh trift, then claude auth login';
    const linear = { ...rowStep(unticked('claude:mcp:linear')) };
    const listed = '  linear  keys not copied (env.LINEAR_API_KEY)  → svall -p work host consent trift claude:mcp:linear on';
    const work = { there: { ssh: 'trift.test', svall: 'svall -p work' } };
    expect(outcomeText({ result: 'ready', actions: [] }, 'add', 'trift')).toBe(ready);
    expect(outcomeText({ result: 'ready', actions: [] }, 'upgrade', 'trift')).toBe(ready);
    expect(outcomeText({ result: 'ready', actions: [], setup: [linear] }, 'upgrade', 'trift', work))
      .toBe(`trift is ready. 1 part of your agent setup will not work there yet:\n${listed}`);
    expect(outcomeText({ result: 'actions', actions: [linger] }, 'add', 'trift')).toBe(`trift has 1 thing to fix:\n  ${linger}`);
    expect(outcomeText({ result: 'actions', actions: [linger, login] }, 'upgrade', 'trift')).toBe(`trift has 2 things to fix:\n  ${linger}\n  ${login}`);
    expect(outcomeText({ result: 'actions', actions: [linger], setup: [linear] }, 'add', 'trift', work))
      .toBe(`trift has 1 thing to fix:\n  ${linger}\n1 part of your agent setup will not work on trift yet:\n${listed}`);
    expect(outcomeText({ result: 'actions', actions: [linger], stopped: 'install' }, 'add', 'trift'))
      .toBe(`stopped at install; trift has 1 thing to fix:\n  ${linger}`);
    expect(outcomeText({ result: 'actions', actions: [linger] }, 'rollback', 'trift')).toBe(`still to do:\n  ${linger}`);
    expect(outcomeText({ result: 'ready', actions: [] }, 'remove', 'trift', { forget: true })).toBe('trift is forgotten');

    const ok = { name: 'release', status: 'ok' as const, detail: '1.2.3' };
    const warn = { name: 'tmux', status: 'warn' as const, detail: '3.4' };
    const fail = (name: string) => ({ name, status: 'fail' as const, detail: 'inactive' });
    expect(doctorVerdict([ok, warn, warn], 'trift', THERE)).toBe(ready);
    expect(doctorVerdict([ok, warn, fail('systemd')], 'trift', THERE)).toBe('trift has 1 thing to fix: systemd');
    expect(doctorVerdict([fail('systemd'), fail('release')], 'trift', THERE)).toBe('trift has 2 things to fix: systemd, release');
    // a mirror row by its own line, though two servers' rows read alike; rows that only ask to check again are not listed
    const again = (key: string) => rowCheck({ key, status: 'warn', action: 'check trift again', detail: 'not checked: trift is not reachable' });
    expect(doctorVerdict([rowCheck(unticked('claude:mcp:github')), rowCheck(unticked('codex:mcp:github')), again('var:X'), again('var:Y'), fail('systemd')], 'trift', THERE)).toBe([
      'trift has 1 thing to fix: systemd',
      '2 parts of your agent setup will not work on trift yet:',
      '  github  keys not copied (env.GITHUB_API_KEY)  → svall host consent trift claude:mcp:github on',
      '  github  keys not copied (env.GITHUB_API_KEY)  → svall host consent trift codex:mcp:github on',
    ].join('\n'));
  });

  it('lists each row of what will not work there by name, what it lacks and the one thing to do from this Mac\'s terminal', async () => {
    const { setupList } = await import('../src/commands/host.js');
    const row = (key: string, o: Partial<SetupRow> & Pick<SetupRow, 'gap'>): SetupRow => ({ key, status: 'warn', detail: 'd', ...o });
    expect(setupList([
      unticked('claude:mcp:linear'),
      row('oauth:claude:mcp:notion', { action: 'log in once on trift', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118, gap: { name: 'notion', what: 'not logged in' } }),
      varRow('GAMMA_TOKEN'),
      row('runtime:/Users/ada/bin/db-mcp', { action: 'install db-mcp on trift', gap: { name: 'db-mcp', what: 'not installed; db needs it' } }),
      row('claude:mcp:odd', { action: 'check trift again', gap: { name: 'odd', what: 'ticked; not on trift yet' } }),
      row('claude:mcp:jira', { action: 'check trift again', tick: { item: 'claude:mcp:jira', fields: ['env.K'], on: false, preview: [] }, gap: { name: 'jira', what: 'unticked; still on trift' } }),
      row('maconly:claude:chrome', { status: 'skip', gap: { name: 'chrome', what: 'runs only on a Mac' } }),
      okRow('var:X'),
    ], 'trift', { ssh: 'ada@trift', svall: 'svall -p work' })).toEqual([
      '  linear       keys not copied (env.LINEAR_API_KEY)  → svall -p work host consent trift claude:mcp:linear on',
      '  notion       not logged in                         → ssh -L 3118:localhost:3118 ada@trift, then MCP_OAUTH_CALLBACK_PORT=3118 claude, /mcp',
      '  GAMMA_TOKEN  not set; gamma reads it               → ssh ada@trift, then svall worker env GAMMA_TOKEN',
      '  db-mcp       not installed; db needs it            → install db-mcp on trift',
      '  odd          ticked; not on trift yet              → svall -p work host doctor trift',
      '  jira         unticked; still on trift              → svall -p work host doctor trift',
      '  chrome       runs only on a Mac',
    ]);
  });

  it('asks to set up what will not work there: yes asks for each key, copies the ones said yes to, and prints the commands to run there; no leaves it', async () => {
    const { setUpNow } = await import('../src/commands/host.js');
    const rows = [unticked('claude:mcp:linear'), unticked('codex:mcp:github'), varRow('GAMMA_TOKEN')].map(rowStep);
    const talk = (answers: string[]) => {
      const asked: string[] = [];
      const said: string[] = [];
      const consent: [MachineId, string, string[], boolean][] = [];
      return {
        asked, said, consent,
        io: {
          ask: (q: string) => { asked.push(q); return Promise.resolve(answers.shift() ?? ''); },
          write: (t: string) => { said.push(t); },
          consent: (m: MachineId, item: string, fields: string[], on: boolean) => { consent.push([m, item, fields, on]); return Promise.resolve([ticked(item)]); },
        },
      };
    };
    const yes = talk(['', 'y', '']);
    await setUpNow(rows, { name: 'trift', machine: REMOTE, there: THERE }, yes.io);
    expect(yes.asked).toEqual([
      'Set them up now? [Y/n] ',
      "Copy linear's keys to trift? env.LINEAR_API_KEY lin…90 [y/N] ",
      "Copy github's keys to trift? env.GITHUB_API_KEY git…90 [y/N] ",
    ]);
    expect(yes.consent).toEqual([[REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true]]);
    expect(yes.said.join('')).toBe([
      '  ✓ linear: keys copied to trift',
      'Run these on trift:',
      '  ssh trift.test, then svall worker env GAMMA_TOKEN',
      'svall host doctor trift checks again once they are done.',
      '',
    ].join('\n'));

    const no = talk(['n']);
    await setUpNow(rows, { name: 'trift', machine: REMOTE, there: THERE }, no.io);
    expect(no.asked).toEqual(['Set them up now? [Y/n] ']);
    expect(no.consent).toEqual([]);
    expect(no.said).toEqual([]);
  });

  it('asks nothing when no row can be set up from here, never to tick a copy still there, and names each command to run there once', async () => {
    const { setUpNow } = await import('../src/commands/host.js');
    const asked: string[] = [];
    const said: string[] = [];
    const io = { ask: (q: string) => { asked.push(q); return Promise.resolve(''); }, write: (t: string) => { said.push(t); }, consent: () => Promise.resolve([]) };
    const macOnly: SetupRow = { key: 'maconly:claude:chrome', status: 'skip', detail: 'd', gap: { name: 'chrome', what: 'runs only on a Mac' } };
    const unchecked: SetupRow = { key: 'unchecked', status: 'warn', detail: 'd', action: 'svall host doctor trift once Svall is open', gap: { name: 'agent setup', what: 'not checked' } };
    const still: SetupRow = { ...unticked('claude:mcp:jira'), action: 'check trift again', gap: { name: 'jira', what: 'unticked; still on trift' } };
    await setUpNow([macOnly, unchecked, still].map(rowStep), { name: 'trift', machine: REMOTE, there: THERE }, io);
    expect([asked, said]).toEqual([[], []]);

    const login = (name: string): SetupRow => ({
      key: `oauth:claude:mcp:${name}`, status: 'warn', action: 'log in once on trift', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118, detail: 'd', gap: { name, what: 'not logged in' },
    });
    await setUpNow([login('notion'), login('linear'), still].map(rowStep), { name: 'trift', machine: REMOTE, there: THERE }, io);
    expect(asked).toEqual(['Set them up now? [Y/n] ']);
    expect(said.join('')).toBe('Run these on trift:\n  ssh -L 3118:localhost:3118 trift.test, then MCP_OAUTH_CALLBACK_PORT=3118 claude, /mcp\nsvall host doctor trift checks again once they are done.\n');
  });

  it('a run\'s lines leave the agent setup rows to the list at its end', async () => {
    const { reporter } = await import('../src/commands/host.js');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      const r = reporter(false, () => 'last');
      r.emit({ step: 'registry', status: 'ok', detail: "trift is in this Mac's list of machines" });
      r.emit(rowStep(unticked('claude:mcp:linear')));
      r.finish({ result: 'ready', actions: [] });
    } finally { vi.restoreAllMocks(); }
    expect(out).toEqual(["✓ registry  trift is in this Mac's list of machines\n", 'last\n']);
  });

  it('lists a detail of several lines under its step', async () => {
    const { stepLine } = await import('../src/commands/host.js');
    expect(stepLine({ step: 'install', status: 'fail', detail: 'svall setup exited 1: one line\nanother line' }))
      .toBe('✗ install  svall setup exited 1: one line\n    another line');
  });

  it('stepLine prints [ ] before an unticked row and [x] before a ticked one', async () => {
    const { stepLine } = await import('../src/commands/host.js');
    const { checkLines } = await import('../src/commands/doctor.js');
    const row = unticked('claude:mcp:linear');
    expect(stepLine(rowStep(row))).toMatch(/^! mirror:claude:mcp:linear  \[ \] mirrored without .* -> copy linear's keys to trift$/);
    expect(stepLine(rowStep({ ...row, status: 'ok', detail: 'keys copied to trift', action: undefined, tick: { ...row.tick!, on: true } })))
      .toBe('✓ mirror:claude:mcp:linear  [x] keys copied to trift');
    expect(stepLine(rowStep(varRow('X')))).toMatch(/^! mirror:var:X  gamma reads X/);
    expect(checkLines([rowCheck(row), { name: 'release', status: 'ok', detail: '1.2.3' }])).toEqual([
      `! mirror:claude:mcp:linear  [ ] ${row.detail} -> copy linear's keys to trift`, `✓ ${'release'.padEnd(row.key.length + 'mirror:'.length)}  1.2.3`,
    ]);
  });

  it('records the step a run stopped at', async () => {
    const out = await removeHost('trift', {}, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'machine' });
  });
});

describe('ndjson output', () => {
  it('writes one event per line and a final result', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const { hostCommands } = await import('../src/commands/host.js');
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => path.join(work, 'config'))
        .parseAsync(['add', 'trift', '--ssh', 'refused.test'], { from: 'user' });
    } finally { vi.restoreAllMocks(); process.exitCode = 0; }
    const lines = out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ step: 'name', status: 'start' });
    expect(lines.at(-1)).toMatchObject({ result: 'actions' });
    expect(Array.isArray((lines.at(-1) as { actions: unknown }).actions)).toBe(true);
  });
});
