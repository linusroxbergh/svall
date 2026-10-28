import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { FleetId, MachineId, PROTOCOL_VERSION, type SetupRow } from '@svall/protocol';
import type { HostDeps, StepEvent } from '../../src/controller/host.js';
import { MachineRegistry } from '../../src/controller/registry.js';
import { SshMaster } from '../../src/controller/ssh.js';
import { cleanHomes, makeHome } from '../../../svalld/test/helpers.js';
import { companionArchive, ephemeralSigner, linkedArchive, smuggledArchive } from './archive.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

export const REMOTE = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
export const MAC = MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
export const OTHER_MAC = MachineId.parse('9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
export const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
export const OTHER_FLEET = FleetId.parse('0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70');
export const TOKEN = 'remote-token-never-printed';
// the fleet home there as a worker of this Mac's fleet, as its `svall version --json` names it
export const SERVES = { homeMachineId: MAC, homeName: 'mac', fleetId: FLEET };
// the far account's home is the Mac's, as the registry's own record names it
export const HOME = os.homedir();
// a home no runner of these tests has
export const ELSEWHERE = `${HOME}-elsewhere`;
export const BASE = `${HOME}/.local/share/svall`;
export const SVALL = `${BASE}/current/bin/svall`;
// the PATH the companion's units run with, and so the one its daemon finds the agent CLIs on
export const UNIT_PATH = `PATH=${BASE}/current/node/bin:${BASE}/current/bin:${HOME}/.local/bin:${HOME}/.opencode/bin:/usr/local/bin:/usr/bin:/bin`;
// what the tmux on that PATH answers: where it is, then its version
export const OWN_TMUX = `${BASE}/current/bin/tmux\ntmux 3.7c\n`;

export const OS_RELEASE = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\n';
export const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 60000000 20000000 40000000 34% /\n';

/** What the companion's own `svall doctor --json` answers; a machine without linger reports none. */
export const doctorJson = (linger?: { status: string; detail: string }): string => JSON.stringify({
  checks: [
    { name: 'systemd', status: 'ok', detail: 'svall-svalld@private.service: loaded, active (running), enabled' },
    ...(linger ? [{ name: 'linger', ...linger }] : []),
    { name: 'tmux', status: 'ok', detail: 'tmux 3.4' },
  ],
});
export const DOCTOR = doctorJson({ status: 'ok', detail: 'on for linus: the fleet keeps running after you log out' });
// this Mac's agents as its own daemon names them, at the releases a healthy companion answers
const MAC_AGENTS = [{ kind: 'claude', version: '2.1.278' }, { kind: 'codex', version: '0.156.1' }, { kind: 'opencode', version: '2.0.22' }] as const;

export let work: string;
export let ssh: FakeSsh;
export let events: StepEvent[];
// this Mac's fleet, which the machine becomes a worker of
export let fleet: string;
export let refreshed: number;

export let signer: ReturnType<typeof ephemeralSigner>;

export const archive = (o: { version?: string; protocol?: number; platform?: string; signed?: boolean } = {}): string =>
  companionArchive(work, { ...o, ...((o.signed ?? true) ? { signedBy: signer.key } : {}) });

/**
 * Archives whose SHA256SUMS, extracted by name, `signer` signed, but whose full unpack writes an intruder's release over
 * it (spelled another way, named twice, or through a link); each intruder's svall touches `ran(name)`.
 */
export function smuggling(ran: (name: string) => string): { name: string; archive: string }[] {
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

export function deps(o: Partial<HostDeps> = {}): HostDeps {
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
export const unticked = (item: string): SetupRow => {
  const name = item.split(':').at(-1)!;
  const field = `env.${name.toUpperCase()}_API_KEY`;
  return {
    key: item, status: 'warn', action: `copy ${name}'s keys to trift`,
    detail: `copied without its keys (${field} ${name.slice(0, 3)}…90); tick to copy them, or set them on trift in ~/.svall/mirror-overrides`,
    tick: { item, fields: [field], on: false, preview: [`${field} ${name.slice(0, 3)}…90`] }, gap: { name, what: `keys not copied (${field})` },
  };
};
export const ticked = (item: string): SetupRow => {
  const row = unticked(item);
  return { key: item, status: 'ok', detail: `keys copied to trift`, tick: { ...row.tick!, on: true } };
};
export const varRow = (v: string): SetupRow => ({
  key: `var:${v}`, status: 'warn', action: `set ${v} on trift`, run: `svall worker env ${v}`, detail: `gamma reads ${v}, which is not set on trift`,
  gap: { name: v, what: 'not set; gamma reads it' },
});
export const THERE = { ssh: 'trift.test', svall: 'svall' };
export const okRow = (key: string): SetupRow => ({ key, status: 'ok', detail: `${key.split(':').at(-1)} is set on trift` });

/** Everything a healthy Ubuntu companion answers, in the order `host add` asks for it. */
export function healthy(o: { linger?: string; tools?: string[]; osRelease?: string; doctor?: string; agents?: boolean; tmux?: { stdout?: string; stderr?: string; code?: number }; home?: string } = {}): void {
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
export async function daemon(o: { release?: () => string; accepts?: () => boolean } = {}): Promise<{ port: number; close: () => Promise<void> }> {
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

export const step = (id: string): StepEvent[] => events.filter((e) => e.step === id && e.status !== 'start');

export function useHostWorld(): void {
  // every step spawns the fake ssh, and a whole `host add` spawns some two dozen of them
  vi.setConfig({ testTimeout: 60_000 });
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
}
