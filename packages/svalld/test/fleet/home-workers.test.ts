import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetState, HomeFacts, HomeWorker, MachineId, MachineRecord } from '@svall/protocol';
import { homeCheck } from '../../src/fleet/home-freeze.js';
import { reachWorkers, settleOwed, startRejoins, writeOwed } from '../../src/fleet/home-workers.js';
import { enter, owedWorkers } from '../../src/fleet/home-move.js';
import { SshError } from '../../src/link/ssh.js';
import { resolvePaths } from '../../src/paths.js';
import { issueToken, tokenFor } from '../../src/placement/workers.js';
import { silentLogger } from '../../src/log.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { crashAt, crashesFired, disarmCrash, POINTS_OF } from './home-world.js';

afterEach(() => { disarmCrash(); cleanHomes(); });
afterAll(() => { expect(POINTS_OF.rejoin.filter((p) => !crashesFired().has(p))).toEqual([]); });

const ME = crypto.randomUUID() as MachineId;
const W = crypto.randomUUID() as MachineId;
const OTHER = crypto.randomUUID() as MachineId;
const FLEET = crypto.randomUUID();
const ID = 'hm_abcdefghij' as never;
const record: MachineRecord = { name: 'box', ssh: 'ada@box', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' };
const worker: HomeWorker = { id: W, record, profile: 'private' };

// a master that answers `svall version --json`, or fails as ssh does
const masterOf = (version: object | string, enroll: { code: number; stderr?: string } = { code: 0 }) => {
  const runs: { argv: string[]; input?: unknown }[] = [];
  return {
    runs,
    master: {
      run: (argv: string[], o: { input?: unknown } = {}) => {
        runs.push({ argv, input: o.input });
        if (argv.includes('enroll')) return Promise.resolve({ stdout: '', signal: null, stderr: '', ...enroll });
        return Promise.resolve({ code: 0, signal: null, stderr: '', stdout: typeof version === 'string' ? version : JSON.stringify(version) });
      },
      close: () => Promise.resolve(),
    },
  };
};
const serving = (o: Partial<{ machineId: string; release: string; fleetId: string }> = {}) => ({ machineId: W, release: '1.2.3', worker: { homeMachineId: OTHER, homeName: 'ada-mac', fleetId: FLEET, ...(o.fleetId && { fleetId: o.fleetId }) }, ...o });

describe('what the machine that would take the fleet finds of a worker', () => {
  const reach = (open: (destination: string) => Promise<unknown>, held: { id: MachineId; record: MachineRecord }[] = []) => reachWorkers([worker], { fleetId: FLEET, release: '1.2.3', held, open: open as never });

  it('one that answers as itself, of this fleet and on this release, passes', async () => {
    expect((await reach(() => Promise.resolve(masterOf(serving()).master)))[W]).toEqual({ ok: true, ssh: 'ada@box' });
  });

  it.each([
    ['auth', new SshError('auth', 'Permission denied (publickey)')],
    ['host_key', new SshError('host_key', 'Host key verification failed')],
    ['unreachable', new SshError('unreachable', 'No route to host')],
  ])('a login that fails as %s says so', async (kind, e) => {
    expect((await reach(() => Promise.reject(e)))[W]).toMatchObject({ ok: false, kind, why: e.message, ssh: 'ada@box' });
  });

  it('one on another release, one answering as another machine and one of another fleet are named', async () => {
    expect((await reach(() => Promise.resolve(masterOf(serving({ release: '1.2.2' })).master)))[W]).toMatchObject({ ok: false, kind: 'release' });
    expect((await reach(() => Promise.resolve(masterOf(serving({ machineId: OTHER })).master)))[W]).toMatchObject({ ok: false, kind: 'machine' });
    expect((await reach(() => Promise.resolve(masterOf(serving({ fleetId: crypto.randomUUID() })).master)))[W]).toMatchObject({ ok: false, kind: 'fleet' });
  });

  it('the route this machine already holds wins, and a name another machine holds here refuses before any login', async () => {
    const asked: string[] = [];
    const open = (d: string) => { asked.push(d); return Promise.resolve(masterOf(serving()).master); };
    expect((await reach(open, [{ id: W, record: { ...record, ssh: 'ada@box.tail' } }]))[W]).toEqual({ ok: true, ssh: 'ada@box.tail' });
    expect(asked).toEqual(['ada@box.tail']);
    asked.length = 0;
    expect((await reach(open, [{ id: OTHER, record: { ...record, ssh: 'ada@elsewhere' } }]))[W]).toMatchObject({ ok: false, kind: 'name' });
    expect(asked).toEqual([]);
  });
});

describe('the check of a move with another worker', () => {
  const facts = (machineId: MachineId): HomeFacts => ({ machineId, role: 'home', release: '1.2.3', protocol: 1, stateSchema: 1, clock: 1, home: '/home/ada', svallBase: '/s', fleetHome: '/f', tailscale: {} } as never);
  const state = { robots: {}, islands: {}, machines: { [W]: { name: 'box', reachable: true, since: 0 } } } as unknown as FleetState;
  const check = (o: { reach?: Record<string, unknown>; linked?: boolean }) => homeCheck({
    state, from: facts(ME), to: facts(OTHER), toName: 'studio', linked: true, synced: true, workers: [W], rewrites: [], fromIsHome: true, reach: (o.reach ?? {}) as never, linkedTo: () => o.linked ?? true,
  });

  it('a Linux worker the new home reaches passes, and goes with the fleet', () => {
    expect(check({ reach: { [W]: { ok: true, ssh: 'ada@box' } } })).toMatchObject({ ok: true });
  });

  it('a worker with no route for the new home, as a second Mac, stays refused', () => {
    const r = check({});
    expect(r).toMatchObject({ ok: false, refusal: { reason: 'box is a worker of this fleet too', action: expect.stringContaining('svall fleet join') } });
  });

  it('one that does not answer and is not linked passes, named on the sheet', () => {
    const r = check({ reach: { [W]: { ok: false, kind: 'unreachable', why: 'No route to host', ssh: 'ada@box' } }, linked: false });
    expect(r).toMatchObject({ ok: true, sheet: { waits: [{ id: W, name: 'box' }] } });
  });

  it('one linked to this home that the new home cannot reach is refused, as what stands between them is a route to fix', () => {
    const r = check({ reach: { [W]: { ok: false, kind: 'unreachable', why: 'No route to host', ssh: 'ada@box' } }, linked: true });
    expect(r).toMatchObject({ ok: false, refusal: { reason: expect.stringContaining('studio cannot reach box') } });
  });

  it.each(['auth', 'host_key'])('a refused login (%s) is refused whether or not it is linked, with the line that fixes it', (kind) => {
    const r = check({ reach: { [W]: { ok: false, kind, why: 'refused', ssh: 'ada@box' } }, linked: false });
    expect(r).toMatchObject({ ok: false, refusal: { reason: expect.stringContaining('studio cannot log in to box'), run: expect.stringContaining("ssh-copy-id 'ada@box'") } });
  });

  it('one on another release is refused, with the upgrade', () => {
    expect(check({ reach: { [W]: { ok: false, kind: 'release', why: 'it runs 1.2.2', ssh: 'ada@box' } } })).toMatchObject({ ok: false, refusal: { action: 'upgrade it under Machines' } });
  });
});

describe('the workers a new home owes an enrolment', () => {
  const setup = (phase: string) => {
    const p = resolvePaths(makeHome());
    enter(p, ID, phase);
    writeOwed(p, ID, [W]);
    issueToken(p, W);
    return p;
  };
  const run = (p: ReturnType<typeof resolvePaths>, open: (d: string) => Promise<unknown>, more: { refresh?: () => void } = {}) => {
    const refresh = more.refresh ?? vi.fn();
    return startRejoins({ paths: p, me: ME, name: () => 'studio', platform: 'linux', fleetId: () => FLEET, log: silentLogger, open: open as never, records: () => [{ id: W, record }], refresh, firstMs: 1, lastMs: 4 });
  };
  const settled = (ms = 40) => new Promise((r) => { setTimeout(r, ms); });

  it('touches no worker until the move has gone through', async () => {
    const p = setup('installed');
    const open = vi.fn();
    const stop = run(p, open);
    await settled();
    stop.stop();
    expect(open).not.toHaveBeenCalled();
    enter(p, ID, 'adopted');
    const m = masterOf(serving());
    const going = run(p, () => Promise.resolve(m.master));
    await vi.waitFor(() => expect(m.runs.length).toBeGreaterThan(0));
    going.stop();
  });

  it('enrols it with the token workers.json holds, on stdin alone, naming this home and its platform', async () => {
    const p = setup('adopted');
    const m = masterOf(serving());
    const refresh = vi.fn();
    const s = run(p, () => Promise.resolve(m.master), { refresh });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    s.stop();
    const { argv, input } = m.runs[0];
    expect(input).toBe(tokenFor(p, W));
    expect(argv.join(' ')).not.toContain(tokenFor(p, W)!);
    expect(argv).toEqual(expect.arrayContaining(['worker', 'enroll', '--home-platform', "'linux'", '--home-name', "'studio'"]));
  });

  it('an entry ends only on a greeting with the fresh token, never on a worker whose file names this home', async () => {
    const p = setup('adopted');
    const m = masterOf({ ...serving(), worker: { homeMachineId: ME, homeName: 'studio', fleetId: FLEET } });
    const s = run(p, () => Promise.resolve(m.master));
    await vi.waitFor(() => expect(m.runs.some((r) => r.argv.includes('enroll'))).toBe(true));
    s.stop();
    expect(Object.keys(owedWorkers(p))).toEqual([W]);
    settleOwed(p, W);
    expect(owedWorkers(p)).toEqual({});
  });

  it('a refused login stops the retries and shows why, until a new start or a person asks again', async () => {
    const p = setup('adopted');
    const open = vi.fn(() => Promise.reject(new SshError('auth', 'Permission denied (publickey)')));
    const s = run(p, open);
    await vi.waitFor(() => expect(owedWorkers(p)[W]?.why).toContain('Permission denied'));
    await settled();
    expect(open).toHaveBeenCalledTimes(1);
    s.again();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    s.stop();
    const next = run(p, open);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3));
    next.stop();
  });

  it('one that does not answer keeps being tried, and its row says why', async () => {
    const p = setup('adopted');
    const open = vi.fn(() => Promise.reject(new SshError('unreachable', 'No route to host')));
    const s = run(p, open);
    await vi.waitFor(() => expect(open.mock.calls.length).toBeGreaterThan(2));
    s.stop();
    expect(owedWorkers(p)[W]?.why).toContain('No route to host');
  });

  it('the file holds ids and the last failure, no token', async () => {
    const p = setup('adopted');
    const s = run(p, () => Promise.reject(new SshError('unreachable', 'No route to host')));
    await vi.waitFor(() => expect(owedWorkers(p)[W]?.why).toBeDefined());
    s.stop();
    const file = fs.readFileSync(p.workersOwed, 'utf8');
    expect(file).not.toContain(tokenFor(p, W)!);
    expect(JSON.parse(file).workers[W]).toEqual({ why: expect.any(String) });
  });

  it.each(['rejoin.enrolling', 'rejoin.enrolled'] as const)('%s: a kill leaves it owed, and the next start enrols it', async (point) => {
    const p = setup('adopted');
    const fired = crashAt(point);
    const m = masterOf(serving());
    const killed = run(p, () => Promise.resolve(m.master));
    await vi.waitFor(() => expect(fired()).toBe(true));
    killed.stop();
    disarmCrash();
    expect(Object.keys(owedWorkers(p))).toEqual([W]);
    const refresh = vi.fn();
    const next = run(p, () => Promise.resolve(m.master), { refresh });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    next.stop();
    expect(m.runs.filter((r) => r.argv.includes('enroll')).at(-1)?.input).toBe(tokenFor(p, W));
  });

  it('rejoin.done: a kill as the entry ends leaves nothing owed', () => {
    const p = setup('adopted');
    const fired = crashAt('rejoin.done');
    expect(() => settleOwed(p, W)).toThrow();
    expect(fired()).toBe(true);
    disarmCrash();
    expect(owedWorkers(p)).toEqual({});
  });

  it('a machine no longer listed or holding no token is owed nothing', async () => {
    const p = resolvePaths(makeHome());
    enter(p, ID, 'adopted');
    writeOwed(p, ID, [W]);
    const open = vi.fn();
    const s = run(p, open);
    await vi.waitFor(() => expect(owedWorkers(p)).toEqual({}));
    s.stop();
    expect(open).not.toHaveBeenCalled();
  });
});
