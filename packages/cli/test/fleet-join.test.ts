import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyState, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type FleetState } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { machineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { issueToken } from '@svall/svalld/placement/workers';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { joinHome, type JoinDeps } from '../src/controller/home.js';
import type { StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import type { SshMaster } from '../src/controller/ssh.js';

const HOME_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const FLEET = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'a'.repeat(48);
const VERSION = { release: '1.0.0', machineId: HOME_ID, protocol: PROTOCOL_VERSION, stateSchema: STATE_SCHEMA_VERSION, role: 'home', fleetId: FLEET };
const ENROLLED = { homeMachineId: HOME_ID, homeName: 'studio', fleetId: FLEET, socket: '/home/ada/.svall/w/abc.sock', token: TOKEN, homeSvallBase: '/home/ada/.local/share/svall', homePlatform: 'linux', homeArch: 'x64', homePath: '/home/ada' };
const INFO = { fleetId: FLEET, machineId: HOME_ID, release: '1.0.0', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 47800, token: 'api', fleetHome: '/home/ada/.svall' };

type Far = { version?: unknown; enrolled?: unknown; enrolCode?: number; enrolStderr?: string; versionCode?: number };

function master(far: Far): { master: SshMaster; asked: string[]; closed: () => boolean } {
  const asked: string[] = [];
  let closed = false;
  const m = {
    run: (argv: string[]) => {
      const line = argv.join(' ');
      asked.push(line);
      const ok = (out: unknown) => Promise.resolve({ code: 0, signal: null, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' });
      if (line.includes('enroll-worker')) return far.enrolCode ? Promise.resolve({ code: far.enrolCode, signal: null, stdout: '', stderr: far.enrolStderr ?? '' }) : ok(far.enrolled ?? ENROLLED);
      if (line.includes('svall-home')) return ok('/home/ada\nada\n');
      if (line.includes('version')) return far.versionCode ? Promise.resolve({ code: far.versionCode, signal: null, stdout: '', stderr: 'not found' }) : ok(far.version ?? VERSION);
      if (line.includes('connection-info')) return ok(INFO);
      throw new Error(`unexpected ${line}`);
    },
    close: () => { closed = true; return Promise.resolve(); },
  };
  return { master: m as unknown as SshMaster, asked, closed: () => closed };
}

let home: string;
let events: StepEvent[];
let enrolled: unknown[];

function deps(far: Far, o: Partial<JoinDeps> = {}): JoinDeps & { far: ReturnType<typeof master> } {
  const made = master(far);
  return {
    far: made, emit: (e) => events.push(e), openMaster: () => Promise.resolve(made.master), interactiveSsh: () => Promise.resolve({ code: 0, stderr: '' }),
    registry: MachineRegistry.load(), target: { name: 'private', home, managed: false }, me: machineId(), svallBase: '/opt/svall', tailnet: () => Promise.resolve(),
    enrol: (e, token) => { enrolled.push({ ...e, token }); return Promise.resolve(); },
    state: () => Promise.resolve({ ...emptyState(), machines: { [HOME_ID]: { name: 'studio', reachable: true, since: 1, snapshot: { version: 7, at: 1 } } } } as FleetState),
    ...o,
  };
}

const failure = () => events.find((e) => e.status === 'fail');

beforeEach(() => {
  process.env.SVALL_CONFIG_DIR = makeHome();
  home = path.join(makeHome(), 'fleet');
  events = [];
  enrolled = [];
});
afterEach(cleanHomes);

describe('svall fleet join', () => {
  it('takes a fleet never opened: the home issues the token, the fleet goes by its id, and it ends on the first snapshot', async () => {
    const d = deps({});
    const out = await joinHome({ ssh: 'ada@studio' }, d);
    expect(out.result).toBe('ready');
    expect(events.filter((e) => e.status === 'ok').map((e) => e.step)).toEqual(['fleet', 'tailscale', 'ssh', 'master', 'home', 'enrol', 'worker', 'snapshot']);
    expect(enrolled).toEqual([expect.objectContaining({ homeMachine: HOME_ID, homeName: 'studio', fleetId: FLEET, homeSsh: 'ada@studio', homeSocket: ENROLLED.socket, homePath: '/home/ada', token: TOKEN, takesFleetId: true, homeProfile: 'private' })]);
    expect(d.far.closed()).toBe(true);
    enrolled = [];
    await joinHome({ ssh: 'ada@studio', homeProfile: 'team' }, deps({}));
    expect(enrolled).toEqual([expect.objectContaining({ homeProfile: 'team' })]);
    // the token is no step's to print
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('an enrolment that refuses leaves this fleet under its own id, and no folder it did not have', async () => {
    const refused = deps({}, { enrol: () => Promise.reject(new Error('worker.json not written: no private fleet yet; run svall setup first')) });
    const out = await joinHome({ ssh: 'ada@studio' }, refused);
    expect(out.result).toBe('actions');
    expect(failure()).toMatchObject({ step: 'worker', detail: expect.stringContaining('run svall setup first') });
    expect(fs.existsSync(home)).toBe(false);
    fs.mkdirSync(home, { recursive: true });
    const own = '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70';
    fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: own }));
    await joinHome({ ssh: 'ada@studio' }, deps({}, { enrol: () => Promise.reject(new Error('worker.json not written: a name clash')) }));
    expect(readFleetConfig(resolvePaths(home)).id).toBe(own);
  });

  it('refuses a fleet that holds a robot before anything is written or asked', async () => {
    fs.mkdirSync(home, { recursive: true });
    const held = emptyState();
    held.robots.c_1 = { id: 'c_1', islandId: 'i_a', cell: { x: 0, y: 0 }, name: 'shell', portrait: 'fox', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false } as unknown as FleetState['robots'][string];
    fs.writeFileSync(resolvePaths(home).state, JSON.stringify(held));
    const d = deps({});
    const out = await joinHome({ ssh: 'ada@studio' }, d);
    expect(out.stopped).toBe('fleet');
    expect(failure()?.detail).toMatch(/holds 1 robot/);
    expect(failure()?.action).toBe('svall -p <new fleet> fleet join ada@studio');
    expect(d.far.asked).toEqual([]);
    expect(fs.existsSync(resolvePaths(home).fleetConfig)).toBe(false);
  });

  it('refuses a fleet with a worker of its own', async () => {
    fs.mkdirSync(home, { recursive: true });
    const other = '77777777-7777-8888-9999-aaaaaaaaaaaa';
    issueToken(resolvePaths(home), other as never);
    const registry = MachineRegistry.load();
    registry.put(other as never, { name: 'other', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/opt/svall' });
    registry.save();
    const out = await joinHome({ ssh: 'ada@studio' }, deps({}));
    expect(out.stopped).toBe('fleet');
    expect(failure()?.detail).toMatch(/1 worker/);
  });

  it('asks for Tailscale on this machine first', async () => {
    const d = deps({}, { tailnet: () => Promise.reject(new Error('tailscale not found')) });
    const out = await joinHome({ ssh: 'ada@studio' }, d);
    expect(out.stopped).toBe('tailscale');
    expect(d.far.asked).toEqual([]);
  });

  it.each([
    ['a machine with no Svall', { versionCode: 127 }, /has no Svall/],
    ['another protocol', { version: { ...VERSION, protocol: PROTOCOL_VERSION + 1 } }, /on protocol/],
    ['a worker of another home', { version: { ...VERSION, role: 'worker', worker: { homeName: 'other' } } }, /worker of other/],
  ] as const)('refuses %s', async (_what, far, said) => {
    const out = await joinHome({ ssh: 'ada@studio' }, deps(far));
    expect(out.stopped).toBe('home');
    expect(failure()?.detail).toMatch(said);
    expect(enrolled).toEqual([]);
    expect(fs.existsSync(resolvePaths(home).fleetConfig)).toBe(false);
  });

  it('refuses a far machine that is this one', async () => {
    const out = await joinHome({ ssh: 'ada@studio' }, deps({ version: { ...VERSION, machineId: machineId() } }));
    expect(failure()?.detail).toMatch(/is this machine/);
    expect(out.stopped).toBe('home');
  });

  it('names the way on when the home already knows a machine of this name', async () => {
    const out = await joinHome({ ssh: 'ada@studio' }, deps({ enrolCode: 1, enrolStderr: 'svall: a machine named mac is already in the registry' }));
    expect(out.stopped).toBe('enrol');
    expect(failure()?.action).toBe('svall fleet join ada@studio --name <another name>');
    expect(enrolled).toEqual([]);
  });

  it('refuses a token for a fleet other than the one that answered', async () => {
    const out = await joinHome({ ssh: 'ada@studio' }, deps({ enrolled: { ...ENROLLED, fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' } }));
    expect(out.stopped).toBe('enrol');
    expect(enrolled).toEqual([]);
  });

  it('fails on a home that sends no snapshot, a worker\'s stamp from a move not counting as one', async () => {
    const noSnapshot = deps({}, { state: () => Promise.resolve({ ...emptyState(), machines: { [HOME_ID]: { name: 'studio', reachable: false, since: 1, snapshot: { version: 0, at: 1 } } } } as FleetState) });
    const clock = Date.now;
    let now = clock();
    Date.now = () => (now += 30_000);
    try {
      const out = await joinHome({ ssh: 'ada@studio' }, noSnapshot);
      expect(out.stopped).toBe('snapshot');
    } finally { Date.now = clock; }
    expect(noSnapshot.far.closed()).toBe(true);
  });

  it('runs again for a fleet that serves this home, and refuses one that serves another', async () => {
    fs.mkdirSync(home, { recursive: true });
    const worker = { homeMachineId: HOME_ID, fleetId: FLEET, token: TOKEN, homeName: 'studio' };
    fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify(worker));
    expect((await joinHome({ ssh: 'ada@studio' }, deps({}))).result).toBe('ready');
    fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify({ ...worker, fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70', homeName: 'other' }));
    events = [];
    const out = await joinHome({ ssh: 'ada@studio' }, deps({}));
    expect(out.stopped).toBe('home');
    expect(failure()?.detail).toMatch(/serves other as a worker/);
  });
});
