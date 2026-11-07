import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetState, HomeFacts, HomeWorker, MachineId, MachineRecord } from '@svall/protocol';
import { homeCheck } from '../../src/fleet/home-freeze.js';
import { reachWorkers, settleOwed, startRejoins, writeOwed } from '../../src/fleet/home-workers.js';
import { createMarker, enter, owedWorkers, readMarker } from '../../src/fleet/home-move.js';
import { enrolLock, homeMoveLock } from '../../src/kernel-lock.js';
import { SshError } from '../../src/link/ssh.js';
import { resolvePaths } from '../../src/paths.js';
import { dropToken, issueToken, tokenFor } from '../../src/placement/workers.js';
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

// a master that answers each command by its own result: `svall version --json` by what it is handed, and the enrol as ssh would
const masterOf = (version: object | string, enroll: { code: number | null; signal?: string | null; stderr?: string } = { code: 0 }) => {
  const runs: { argv: string[]; input?: unknown }[] = [];
  return {
    runs,
    enrols: () => runs.filter((r) => r.argv.includes('enroll')),
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

  it('a route it holds with no ssh refuses, with no login, as nothing would reach it afterwards either', async () => {
    const open = vi.fn();
    const { ssh: _, ...noRoute } = record;
    expect((await reach(open, [{ id: W, record: noRoute }]))[W]).toMatchObject({ ok: false, kind: 'other', why: expect.stringContaining('no ssh route') });
    expect(open).not.toHaveBeenCalled();
  });

  it('asks by the record it holds, of the fleet under its profile there', async () => {
    const m = masterOf(serving());
    const r = await reachWorkers([{ ...worker, profile: 'work' }], { fleetId: FLEET, release: '1.2.3', held: [{ id: W, record: { ...record, svallBase: '/opt/svall' } }], open: () => Promise.resolve(m.master) as never });
    expect(r[W]).toMatchObject({ ok: true });
    expect(m.runs[0].argv).toEqual(["'/opt/svall/current/bin/svall'", '-p', "'work'", 'version', '--json']);
  });

  it('reads the answer past what a login shell says first', async () => {
    expect((await reach(() => Promise.resolve(masterOf(`welcome to box\n${JSON.stringify(serving(), null, 2)}`).master)))[W]).toEqual({ ok: true, ssh: 'ada@box' });
  });
});

describe('the check of a move with another worker', () => {
  const facts = (machineId: MachineId): HomeFacts => ({ machineId, role: 'home', release: '1.2.3', protocol: 1, stateSchema: 1, clock: 1, home: '/home/ada', svallBase: '/s', fleetHome: '/f', tailscale: {}, workers: [W] } as never);
  const state = { robots: {}, islands: {}, machines: { [W]: { name: 'box', reachable: true, since: 0 } } } as unknown as FleetState;
  const check = (o: { reach?: Record<string, unknown> | null; linked?: boolean; back?: string; farSsh?: string }) => homeCheck({
    state, from: facts(ME), to: facts(OTHER), toName: 'studio', linked: true, synced: true, rewrites: [], fromIsHome: true, reach: (o.reach === undefined ? {} : o.reach) as never, linkedTo: () => o.linked ?? true,
    ...(o.back && { back: o.back }), ...(o.farSsh && { farSsh: o.farSsh }),
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
    expect(r).toMatchObject({ ok: false, refusal: { reason: expect.stringContaining('studio cannot log in to box'), action: expect.stringContaining("ssh-copy-id 'ada@box'") } });
  });

  it('a home the machine could not be asked about says so once, with no word of removing a worker', () => {
    const r = check({ reach: null });
    expect(r).toMatchObject({ ok: false, refusal: { reason: 'studio could not be asked whether it reaches the other workers', action: 'try again in a moment' } });
    expect(JSON.stringify(r)).not.toContain('remove box');
  });

  it('a machine not linked is what refuses, and says nothing of a worker it was not asked about', () => {
    const r = homeCheck({ state, from: facts(ME), to: facts(OTHER), toName: 'studio', linked: false, synced: true, rewrites: [], fromIsHome: true, reach: null });
    expect(r).toMatchObject({ ok: false, refusal: { reason: 'studio is not reachable' } });
    expect(JSON.stringify(r)).not.toContain('box');
  });

  it.each([
    ['machine', 'ada@box reaches another machine than box'],
    ['fleet', 'box does not serve this fleet'],
    ['name', 'another machine goes by box there'],
    ['other', 'svall version exited 1'],
  ])('a worker answering wrongly as %s is refused in those words, linked or not', (kind, why) => {
    for (const linked of [true, false]) {
      expect(check({ reach: { [W]: { ok: false, kind, why, ssh: 'ada@box' } }, linked })).toMatchObject({ ok: false, refusal: { reason: `box: ${why}`, action: 'fix it, or remove it first' } });
    }
  });

  describe('the words of a login that fails', () => {
    const refused = { [W]: { ok: false, kind: 'auth', why: 'refused', ssh: 'ada@box' } };

    it('on the way out, name the far machine in words and its route in the line', () => {
      const r = check({ reach: refused, farSsh: 'ada@studio.tail' });
      if (r.ok) throw new Error('passed');
      expect(r.refusal.action).toContain("on studio, run test -f ~/.ssh/id_ed25519");
      expect(r.refusal.action).toContain("ssh ada@studio.tail cat .ssh/id_ed25519.pub | ssh ada@box 'cat >> .ssh/authorized_keys'");
    });

    it('on the way back, hand on this machine\'s own key over the home that reaches the worker, naming no machine as ssh would not', () => {
      const r = check({ reach: refused, back: 'studio', farSsh: 'ada@studio.tail' });
      if (r.ok) throw new Error('passed');
      expect(r.refusal.action).toContain('on this machine, run');
      expect(r.refusal.action).toContain(`cat ~/.ssh/id_ed25519.pub | ssh ada@studio.tail "ssh ada@box 'cat >> .ssh/authorized_keys'"`);
      expect(r.refusal.action).not.toContain('ssh this machine');
    });

    it('with no route known, name no line that could not run', () => {
      const r = check({ reach: refused });
      if (r.ok) throw new Error('passed');
      expect(r.refusal.action).not.toContain('ssh studio');
      expect(r.refusal.action).toContain("studio's ~/.ssh/id_ed25519.pub");
    });

    it('a worker this machine cannot reach names who can', () => {
      const r = check({ reach: { [W]: { ok: false, kind: 'unreachable', why: 'No route', ssh: 'ada@box' } }, linked: true, back: 'studio' });
      expect(r).toMatchObject({ ok: false, refusal: { reason: 'this machine cannot reach box, which studio reaches: No route' } });
    });
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
  const run = (p: ReturnType<typeof resolvePaths>, open: (d: string) => Promise<unknown>, more: { refresh?: () => void; frozen?: () => boolean; records?: () => { id: MachineId; record: MachineRecord }[]; log?: typeof silentLogger } = {}) => {
    const refresh = more.refresh ?? vi.fn();
    return startRejoins({ paths: p, me: ME, name: () => 'studio', platform: 'linux', fleetId: () => FLEET, log: more.log ?? silentLogger, open: open as never, records: more.records ?? (() => [{ id: W, record }]), refresh, frozen: more.frozen ?? (() => false), firstMs: 1, lastMs: 4 });
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
    const [{ argv, input }] = m.enrols();
    expect(input).toBe(tokenFor(p, W));
    expect(argv.join(' ')).not.toContain(tokenFor(p, W)!);
    expect(argv).toEqual(["'/home/ada/.local/share/svall/current/bin/svall'", 'worker', 'enroll', '--home-machine', `'${ME}'`, '--home-name', "'studio'", '--fleet-id', `'${FLEET}'`, '--home-platform', "'linux'"]);
  });

  it('asks who answers on the same master before the token goes, and a fleet under a profile there by that profile each time', async () => {
    const p = setup('adopted');
    const held = JSON.parse(fs.readFileSync(p.workersFile, 'utf8')) as Record<string, object>;
    fs.writeFileSync(p.workersFile, JSON.stringify({ ...held, [W]: { ...held[W], profile: 'work' } }));
    const m = masterOf(serving());
    const opened = vi.fn(() => Promise.resolve(m.master));
    const refresh = vi.fn();
    const s = run(p, opened, { refresh });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    s.stop();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(m.runs.map((r) => r.argv.slice(1, 5))).toEqual([['-p', "'work'", 'version', '--json'], ['-p', "'work'", 'worker', 'enroll']]);
    expect(m.runs[0].input).toBeUndefined();
  });

  it.each([
    ['another machine', () => serving({ machineId: OTHER }), 'ada@box reaches another machine than box'],
    ['a worker of another fleet', () => serving({ fleetId: crypto.randomUUID() }), 'box does not serve this fleet'],
    ['a fleet home', () => ({ machineId: W, release: '1.2.3', role: 'home', fleetId: crypto.randomUUID() }), 'box does not serve this fleet'],
  ])('%s gets no token, says why, and is not tried again until a person asks', async (_what, answer, why) => {
    const p = setup('adopted');
    const m = masterOf(answer());
    const open = vi.fn(() => Promise.resolve(m.master));
    const s = run(p, open);
    await vi.waitFor(() => expect(owedWorkers(p)[W]?.why).toBe(why));
    await settled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(m.enrols()).toEqual([]);
    expect(m.runs.every((r) => r.input === undefined)).toBe(true);
    s.again();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    s.stop();
    expect(Object.keys(owedWorkers(p))).toEqual([W]);
  });

  it.each([
    ['a marker stands', (p: ReturnType<typeof resolvePaths>) => { createMarker(p, { id: 'hm_abcdefghik' as never, fleetId: FLEET as never, from: ME, fromName: 'studio', fromHome: '/home/ada' as never, to: OTHER, toName: 'second', toHome: '/home/ada' as never, at: 1, keySha256: 'a'.repeat(64) }); expect(readMarker(p)).toBeDefined(); return () => false; }],
    ['the freeze holds', () => () => true],
  ])('a home enrols no one while %s', async (_what, leave) => {
    const p = setup('adopted');
    const frozen = leave(p);
    const open = vi.fn();
    const s = run(p, open, { frozen });
    await settled();
    s.stop();
    expect(open).not.toHaveBeenCalled();
    expect(Object.keys(owedWorkers(p))).toEqual([W]);
  });

  it('a freeze that ends lets the home go on', async () => {
    const p = setup('adopted');
    let frozen = true;
    const m = masterOf(serving());
    const refresh = vi.fn();
    const s = run(p, () => Promise.resolve(m.master), { frozen: () => frozen, refresh });
    await settled();
    expect(m.runs).toEqual([]);
    frozen = false;
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    s.stop();
  });

  it('a registry that reads empty ends no debt, with the token still held', async () => {
    const p = setup('adopted');
    const open = vi.fn();
    const s = run(p, open, { records: () => [] });
    await vi.waitFor(() => expect(owedWorkers(p)[W]?.why).toContain('no ssh route'));
    await settled();
    s.stop();
    expect(Object.keys(owedWorkers(p))).toEqual([W]);
    expect(open).not.toHaveBeenCalled();
    expect(tokenFor(p, W)).toBeDefined();
  });

  it('an enrol that exits non-zero is no enrolment: it stays owed, says why, and is tried again', async () => {
    const p = setup('adopted');
    const m = masterOf(serving(), { code: 1, stderr: 'svall: worker.json not written: no\n' });
    const refresh = vi.fn();
    const s = run(p, () => Promise.resolve(m.master), { refresh });
    await vi.waitFor(() => expect(m.enrols().length).toBeGreaterThan(1));
    s.stop();
    expect(refresh).not.toHaveBeenCalled();
    expect(owedWorkers(p)[W]?.why).toBe('svall worker enroll exited 1: worker.json not written: no');
  });

  it('a cause that comes back goes in the log once, and a new one goes in too', async () => {
    const p = setup('adopted');
    const error = vi.fn();
    let said = 'No route to host';
    const open = vi.fn(() => Promise.reject(new SshError('unreachable', said)));
    const s = run(p, open, { log: { ...silentLogger, error } });
    await vi.waitFor(() => expect(open.mock.calls.length).toBeGreaterThan(3));
    expect(error).toHaveBeenCalledTimes(1);
    said = 'Connection timed out';
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    s.stop();
  });

  it.each([
    ['auth', 'Permission denied (publickey)'],
    ['host_key', 'Host key verification failed'],
  ])('a login refused as %s says the fix on the row, at a login and at the enrol', async (kind, said) => {
    const p = setup('adopted');
    const s = run(p, () => Promise.reject(new SshError(kind as never, said)));
    await vi.waitFor(() => expect(owedWorkers(p)[W]?.why).toContain(said));
    s.stop();
    expect(owedWorkers(p)[W]?.why).toContain("on studio, run test -f ~/.ssh/id_ed25519 || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519; ssh-copy-id 'ada@box'");
    const q = setup('adopted');
    const m = masterOf(serving(), { code: 255, stderr: `${said}\n` });
    const again = run(q, () => Promise.resolve(m.master));
    await vi.waitFor(() => expect(owedWorkers(q)[W]?.why).toContain('ssh-copy-id'));
    await settled();
    again.stop();
    expect(m.enrols()).toHaveLength(1);
  });

  it('a worker forgotten while its login stays refused is owed nothing from the next round', async () => {
    const p = setup('adopted');
    const open = vi.fn(() => Promise.reject(new SshError('auth', 'refused')));
    const s = run(p, open);
    await vi.waitFor(() => expect(owedWorkers(p)[W]?.why).toBeDefined());
    dropToken(p, W);
    await vi.waitFor(() => expect(owedWorkers(p)).toEqual({}));
    s.stop();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a token taken back after the login, while the lock waits, is never sent', async () => {
    const p = setup('adopted');
    const hold = await enrolLock(p.home);
    const m = masterOf(serving());
    const s = run(p, () => Promise.resolve(m.master));
    await vi.waitFor(() => expect(m.runs.length).toBeGreaterThan(0));
    dropToken(p, W);
    hold?.();
    await vi.waitFor(() => expect(owedWorkers(p)).toEqual({}));
    s.stop();
    expect(m.enrols()).toEqual([]);
  });

  it('holds the lock only around the token, so a person\'s add does not wait on a login', async () => {
    const p = setup('adopted');
    let answer!: (m: unknown) => void;
    const open = vi.fn(() => new Promise((r) => { answer = r; }));
    const s = run(p, open);
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const held = await enrolLock(p.home);
    expect(held).toBeDefined();
    held?.();
    s.stop();
    answer(masterOf(serving()).master);
  });

  it('an enrolment under way takes the worker\'s lock and leaves a move\'s free, as the old home landing goes by that one', async () => {
    const p = setup('adopted');
    let done!: () => void;
    const enrolling = new Promise<void>((r) => { done = r; });
    const m = masterOf(serving());
    const run_ = m.master.run;
    m.master.run = async (argv: string[], o: { input?: unknown } = {}) => { if (argv.includes('enroll')) await enrolling; return run_(argv, o); };
    const refresh = vi.fn();
    const s = run(p, () => Promise.resolve(m.master), { refresh });
    await vi.waitFor(async () => {
      const held = await enrolLock(p.home);
      held?.();
      expect(held).toBeUndefined();
    });
    const move = await homeMoveLock(p.home);
    expect(move).toBeDefined();
    move?.();
    done();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    s.stop();
  });

  it('an entry ends only on a greeting with the fresh token, never on a worker whose file names this home', async () => {
    const p = setup('adopted');
    const m = masterOf({ ...serving(), worker: { homeMachineId: ME, homeName: 'studio', fleetId: FLEET } });
    const s = run(p, () => Promise.resolve(m.master));
    await vi.waitFor(() => expect(m.enrols().length).toBeGreaterThan(0));
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
    expect(m.enrols().at(-1)?.input).toBe(tokenFor(p, W));
  });

  it('rejoin.done: a kill as the entry ends leaves nothing owed', () => {
    const p = setup('adopted');
    const fired = crashAt('rejoin.done');
    expect(() => settleOwed(p, W)).toThrow();
    expect(fired()).toBe(true);
    disarmCrash();
    expect(owedWorkers(p)).toEqual({});
  });

  it('a machine whose token a person took back is owed nothing', async () => {
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
