import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type FleetState } from '@svall/protocol';
import { readFleetConfig } from '@svall/svalld/config';
import { machineId } from '@svall/svalld/machine';
import { resolvePaths } from '@svall/svalld/paths';
import { issueToken } from '@svall/svalld/placement/workers';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import type { Client } from '../src/client.js';
import { joinHome, seedHome, type JoinDeps, type SeedAsk } from '../src/controller/home.js';
import type { StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import type { SshMaster } from '../src/controller/ssh.js';

const HOME_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const FLEET = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'a'.repeat(48);
const VERSION = { release: '1.0.0', machineId: HOME_ID, protocol: PROTOCOL_VERSION, stateSchema: STATE_SCHEMA_VERSION, role: 'home', fleetId: FLEET };
const ENROLLED = { homeMachineId: HOME_ID, homeName: 'studio', fleetId: FLEET, socket: '/home/ada/.svall/w/abc.sock', token: TOKEN, homeSvallBase: '/home/ada/.local/share/svall', homePlatform: 'linux', homeArch: 'x64', homePath: '/home/ada' };
const INFO = { fleetId: FLEET, machineId: HOME_ID, release: '1.0.0', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 47800, token: 'api', fleetHome: '/home/ada/.svall' };

type Far = { version?: unknown; enrolled?: unknown; enrolCode?: number; enrolStderr?: string; versionCode?: number; tailscale?: { host?: string; error?: string } };

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
      if (line.includes('fleet facts')) return ok({ machineId: HOME_ID, role: 'home', fleetId: FLEET, tailscale: far.tailscale ?? { host: 'studio.tail1234.ts.net' } });
      throw new Error(`unexpected ${line}`);
    },
    close: () => { closed = true; return Promise.resolve(); },
  };
  return { master: m as unknown as SshMaster, asked, closed: () => closed };
}

let home: string;
let events: StepEvent[];
let enrolled: unknown[];

const holding = (holds: boolean) => ({ call: () => Promise.resolve({ holds }) }) as unknown as Pick<Client, 'call'>;

function deps(far: Far, o: Partial<JoinDeps> = {}): JoinDeps & { far: ReturnType<typeof master> } {
  const made = master(far);
  return {
    far: made, emit: (e) => events.push(e), openMaster: () => Promise.resolve(made.master), interactiveSsh: () => Promise.resolve({ code: 0, stderr: '' }),
    registry: MachineRegistry.load(), target: { name: 'private', home, managed: false }, me: machineId(), svallBase: '/opt/svall', tailnet: () => Promise.resolve(),
    enrol: (e, token) => { enrolled.push({ ...e, token }); return Promise.resolve(); },
    state: () => Promise.resolve({ ...emptyState(), machines: { [HOME_ID]: { name: 'studio', reachable: true, since: 1, snapshot: { version: 7, at: Date.now() } } } } as FleetState),
    seedClients: () => Promise.resolve({ here: holding(false), far: holding(true), close: () => Promise.resolve() }),
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
    expect(events.filter((e) => e.status === 'ok').map((e) => e.step)).toEqual(['fleet', 'tailscale', 'ssh', 'master', 'home', 'enrol', 'worker', 'snapshot', 'seed']);
    expect(enrolled).toEqual([expect.objectContaining({ homeMachine: HOME_ID, homeName: 'studio', fleetId: FLEET, homeSsh: 'ada@studio', homeSocket: ENROLLED.socket, homePath: '/home/ada', token: TOKEN, takesFleetId: true, homeProfile: 'private' })]);
    expect(d.far.closed()).toBe(true);
    enrolled = [];
    await joinHome({ ssh: 'ada@studio', homeProfile: 'team' }, deps({}));
    expect(enrolled).toEqual([expect.objectContaining({ homeProfile: 'team' })]);
    // the token is no step's to print
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('names the home as this machine\'s registry does, whatever the home calls itself, and its own name where the registry has none', async () => {
    const registry = MachineRegistry.load();
    registry.put(HOME_ID as never, { name: 'studio', ssh: 'ada@studio', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/opt/svall' });
    registry.save();
    await joinHome({ ssh: 'ada@studio' }, deps({ enrolled: { ...ENROLLED, homeName: 'linus-vault' } }));
    expect(enrolled).toEqual([expect.objectContaining({ homeName: 'studio' })]);
    expect(events.filter((e) => e.status === 'ok').map((e) => e.detail).join('\n')).not.toContain('linus-vault');
    registry.remove(HOME_ID);
    registry.save();
    [enrolled, events] = [[], []];
    await joinHome({ ssh: 'ada@studio' }, deps({ enrolled: { ...ENROLLED, homeName: 'linus-vault' } }));
    expect(enrolled).toEqual([expect.objectContaining({ homeName: 'linus-vault' })]);
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

  it.each([
    ['fleet note', 'docs/fleet/mine.md', /holds 1 fleet note/],
    ['repo note', 'docs/repos/svall-1234abcd/mine.md', /holds 1 repo note/],
  ])('refuses a fleet that holds a %s before anything is written or asked', async (_what, rel, said) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'what I wrote');
    const d = deps({});
    const out = await joinHome({ ssh: 'ada@studio' }, d);
    expect(out.stopped).toBe('fleet');
    expect(failure()?.detail).toMatch(said);
    expect(d.far.asked).toEqual([]);
  });

  it('says what a fleet it takes loses all the same', async () => {
    const out = await joinHome({ ssh: 'ada@studio' }, deps({}));
    expect(out.result).toBe('ready');
    expect(events.find((e) => e.step === 'fleet' && e.status === 'ok')?.detail).toMatch(/island names and board columns go with the home's first snapshot/);
  });

  it('refuses a destination no worker.json can hold before the home issues a token', async () => {
    const d = deps({});
    const out = await joinHome({ ssh: 'ssh://ada@studio' }, d);
    expect(out.stopped).toBe('fleet');
    expect(failure()?.detail).toMatch(/ssh:\/\/ada@studio is not an ssh destination/);
    expect(d.far.asked).toEqual([]);
  });

  it('asks the home to keep a token it holds, as the worker may hold it yet', async () => {
    const d = deps({});
    expect((await joinHome({ ssh: 'ada@studio' }, d)).result).toBe('ready');
    expect(d.far.asked.find((l) => l.includes('enroll-worker'))).toContain('--keep-token');
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

  it('on a machine that may be no Mac, says this machine, and sends a person to Machines by what it is', async () => {
    await joinHome({ ssh: 'ada@studio' }, deps({ versionCode: 127 }));
    expect(failure()?.action).toBe("install Svall there and run svall setup, or add it under Machines in Svall's window");
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

  it('refuses a home off the tailnet before it issues a token, naming what the server says', async () => {
    const d = deps({ tailscale: { error: 'tailscale is not connected (NeedsLogin); sign in and try again' } });
    const out = await joinHome({ ssh: 'ada@studio' }, d);
    expect(out.stopped).toBe('home');
    expect(failure()).toMatchObject({ detail: expect.stringContaining('ada@studio says: tailscale is not connected (NeedsLogin)'), action: expect.stringMatching(/^ssh ada@studio, then install Tailscale/) });
    expect(d.far.asked.some((l) => l.includes('enroll-worker'))).toBe(false);
    expect(enrolled).toEqual([]);
  });

  it('clears the mark a first run\'s server path left once the join lands, and keeps it while it has not', async () => {
    fs.mkdirSync(home, { recursive: true });
    const marker = resolvePaths(home).joining;
    fs.writeFileSync(marker, '');
    const clock = Date.now;
    let now = clock();
    Date.now = () => (now += 30_000);
    try {
      const silent = deps({}, { state: () => Promise.resolve(emptyState()) });
      expect((await joinHome({ ssh: 'ada@studio' }, silent)).stopped).toBe('snapshot');
    } finally { Date.now = clock; }
    expect(fs.existsSync(marker)).toBe(true);
    expect((await joinHome({ ssh: 'ada@studio' }, deps({}))).result).toBe('ready');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a join run again waits for a snapshot of its own, not the one the last left', async () => {
    const before = Date.now() - 60_000;
    const stale = deps({}, { state: () => Promise.resolve({ ...emptyState(), machines: { [HOME_ID]: { name: 'studio', reachable: true, since: 1, snapshot: { version: 7, at: before } } } } as FleetState) });
    const clock = Date.now;
    let now = clock();
    Date.now = () => (now += 30_000);
    try {
      expect((await joinHome({ ssh: 'ada@studio' }, stale)).stopped).toBe('snapshot');
    } finally { Date.now = clock; }
  });

  it('forgets a record of what a Copy wrote here as a home, and keeps a worker\'s across a join run again', async () => {
    const { mirrorState } = resolvePaths(home);
    fs.mkdirSync(path.dirname(mirrorState), { recursive: true });
    fs.writeFileSync(mirrorState, '{"files":{}}');
    const far: Far = {};
    expect((await joinHome({ ssh: 'ada@studio' }, deps(far))).result).toBe('ready');
    expect(fs.existsSync(mirrorState)).toBe(false);

    fs.writeFileSync(mirrorState, '{"files":{}}');
    fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify({ homeMachineId: HOME_ID, homeName: 'studio', fleetId: FLEET, token: TOKEN }));
    expect((await joinHome({ ssh: 'ada@studio' }, deps(far))).result).toBe('ready');
    expect(fs.existsSync(mirrorState)).toBe(true);
  });

  describe('the seed', () => {
    const ROWS = { rows: [
      { key: 'claude:mcp:a', status: 'warn', detail: 'a key', action: 'copy the key', tick: { item: 'claude:mcp:a', fields: ['env.A'], on: false, preview: ['env.A ****'], ticked: [] }, gap: { name: 'a', what: 'keys not copied' } },
      { key: 'claude:mcp:b', status: 'ok', detail: 'a key', tick: { item: 'claude:mcp:b', fields: ['env.B'], on: true, preview: ['env.B ****'], ticked: ['env.B'] }, gap: { name: 'b', what: 'ticked' } },
      { key: 'claude:mcp:c', status: 'warn', detail: 'a key', action: 'check studio again', tick: { item: 'claude:mcp:c', fields: ['env.C'], on: false, preview: ['env.C ****'], ticked: [] }, gap: { name: 'c', what: 'keys not copied' } },
    ] };
    type Asked = [string, unknown];
    const client = (asked: Asked[], answers: Record<string, unknown>) => ({ call: (m: string, p: unknown) => { asked.push([m, p]); return Object.hasOwn(answers, m) ? Promise.resolve(answers[m]) : Promise.reject(new Error(`${m} not answered`)); } }) as unknown as Pick<Client, 'call'>;
    const yes: SeedAsk = { go: () => Promise.resolve(true), key: (said) => Promise.resolve(said !== "Send c's C to studio") };
    const run = (o: { far: boolean; here: boolean; ask?: SeedAsk; copied?: unknown }) => {
      const [farCalls, hereCalls]: [Asked[], Asked[]] = [[], []];
      const out = seedHome({
        here: client(hereCalls, { 'machines.holdsSetup': { holds: o.here }, 'home.setup': ROWS, 'home.setupConsent': ROWS }),
        far: client(farCalls, { 'machines.holdsSetup': { holds: o.far }, 'machines.copySetupFrom': o.copied ?? { sent: 4 } }),
        me: 'm' as never, name: 'studio', ...(o.ask && { ask: o.ask }),
      });
      return { out, farCalls, hereCalls };
    };
    const copied = (calls: Asked[]) => calls.filter(([m]) => m === 'machines.copySetupFrom');

    it('leaves a home that holds a setup as it is, and asks no one', async () => {
      const go = vi.fn(() => Promise.resolve(true));
      const { out, farCalls } = run({ far: true, here: true, ask: { ...yes, go } });
      expect((await out).detail).toContain('holds an agent setup of its own');
      expect(copied(farCalls)).toEqual([]);
      expect(go).not.toHaveBeenCalled();
    });

    it('has nothing to send from a machine with no setup', async () => {
      const { out, farCalls } = run({ far: false, here: false, ask: yes });
      expect((await out).status).toBeUndefined();
      expect(copied(farCalls)).toEqual([]);
    });

    it('with no person to ask copies nothing and says a window offers it, which stops no first run', async () => {
      const { out, farCalls } = run({ far: false, here: true });
      expect(await out).toMatchObject({ status: 'warn', detail: expect.stringContaining('studio has no agent setup yet') as string });
      expect(copied(farCalls)).toEqual([]);
    });

    it('sends the one Copy, as a seed, after the key rows a person ticked; none else goes', async () => {
      const { out, farCalls, hereCalls } = run({ far: false, here: true, ask: yes });
      expect((await out).detail).toContain('4 files');
      expect(hereCalls.filter(([m]) => m === 'home.setupConsent')).toEqual([['home.setupConsent', { item: 'claude:mcp:a', fields: ['env.A'], on: true }]]);
      expect(copied(farCalls)).toEqual([['machines.copySetupFrom', { machine: 'm', seed: true }]]);
    });

    it('asks each row a tick stands on too, and a no takes that tick back before the Copy, a part of a row\'s included', async () => {
      const rows = { rows: [
        { key: 'claude:mcp:whole', status: 'ok', detail: 'whole', tick: { item: 'claude:mcp:whole', fields: ['env.W'], on: true, preview: ['env.W ****'], ticked: ['env.W'] }, gap: { name: 'whole', what: 'ticked' } },
        { key: 'claude:mcp:part', status: 'warn', detail: 'part', tick: { item: 'claude:mcp:part', fields: ['env.A', 'env.B'], on: false, preview: ['env.A ****', 'env.B ****'], ticked: ['env.A'] }, gap: { name: 'part', what: 'keys not copied' } },
        { key: 'claude:mcp:kept', status: 'ok', detail: 'kept', tick: { item: 'claude:mcp:kept', fields: ['env.K'], on: true, preview: ['env.K ****'], ticked: ['env.K'] }, gap: { name: 'kept', what: 'ticked' } },
        { key: 'claude:mcp:none', status: 'warn', detail: 'none', tick: { item: 'claude:mcp:none', fields: ['env.N'], on: false, preview: ['env.N ****'], ticked: [] }, gap: { name: 'none', what: 'keys not copied' } },
        { key: 'claude:mcp:odd', status: 'warn', action: 'check studio again', detail: 'odd', tick: { item: 'claude:mcp:odd', fields: ['url', 'headers'], on: false, preview: ['url', 'headers'] }, gap: { name: 'odd', what: 'not copied' } },
      ] };
      const order: Asked[] = [];
      const asked: string[] = [];
      await seedHome({
        here: client(order, { 'machines.holdsSetup': { holds: true }, 'home.setup': rows, 'home.setupConsent': rows }),
        far: client(order, { 'machines.holdsSetup': { holds: false }, 'machines.copySetupFrom': { sent: 1 } }),
        me: 'm' as never, name: 'studio', ask: { go: () => Promise.resolve(true), key: (said) => { asked.push(said); return Promise.resolve(said.startsWith("Send kept's")); } },
      });
      // a question says what goes where, never a row's action
      expect(asked).toEqual(["Send whole's W to studio", "Send part's A, B to studio", "Send kept's K to studio", "Send none's N to studio", 'Send odd to studio as it is, keys included']);
      expect(order.filter(([m]) => m === 'home.setupConsent' || m === 'machines.copySetupFrom')).toEqual([
        ['home.setupConsent', { item: 'claude:mcp:whole', fields: ['env.W'], on: false }],
        ['home.setupConsent', { item: 'claude:mcp:part', fields: ['env.A', 'env.B'], on: false }],
        ['machines.copySetupFrom', { machine: 'm', seed: true }],
      ]);
    });

    it('copies nothing on a person\'s no', async () => {
      const { out, farCalls } = run({ far: false, here: true, ask: { ...yes, go: () => Promise.resolve(false) } });
      expect((await out).detail).toContain('stays without an agent setup');
      expect(copied(farCalls)).toEqual([]);
    });

    it('a seed that fails leaves the join standing, and says where to copy it from', async () => {
      const failing = (): Promise<never> => Promise.reject(new Error('the forward closed'));
      const out = await joinHome({ ssh: 'ada@studio' }, deps({}, { seedClients: failing }));
      expect(out.result).toBe('ready');
      expect(events.find((e) => e.step === 'seed' && e.status === 'warn')).toMatchObject({ detail: expect.stringMatching(/the forward closed.*Agent setup/) as string });
    });

    it('comes after the first snapshot', async () => {
      await joinHome({ ssh: 'ada@studio' }, deps({}));
      const order = events.filter((e) => e.status !== 'start').map((e) => e.step);
      expect(order.indexOf('seed')).toBeGreaterThan(order.indexOf('snapshot'));
    });
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
