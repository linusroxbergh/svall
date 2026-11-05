import fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, INTERRUPT_ACTIONS, PROTOCOL_VERSION, type AdoptAnswer, type HomeManifest, type HomeMoveId, type HomeMoving } from '@svall/protocol';
import { HomeCrash } from '@svall/svalld/failpoints';
import { deliverOwed, startDeliveries } from '@svall/svalld/fleet/home-far';
import { installAdopt, journalLines, packFleet, readMarker, readOwed, writeMarker } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { machineId } from '@svall/svalld/machine';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { crashAt, crashesFired, disarmCrash, MAC, movedOut, POINTS_OF, STUDIO, STUDIO_RECORD } from '../../svalld/test/fleet/home-world.js';
import type { Client } from '../src/client.js';
import { abortBack, bringCrewBack, enrolmentFor, moveHomeBack, moveHomeOut, resumeHome, type MoveDeps } from '../src/controller/home.js';
import type { StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import type { SshMaster } from '../src/controller/ssh.js';

const FLEET = '11111111-2222-3333-4444-555555555555';
const FAR_INFO = (id: string) => ({ fleetId: FLEET, machineId: id, release: '1.0.0', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 47800, token: 'api', fleetHome: '/home/ada/.svall' });

type Called = { method: string; params: { op?: string; marker?: HomeMoving } & Record<string, unknown> };

/** This fleet's daemon as the driver sees it. */
function daemon(o: { refuse?: Record<string, Error>; checkRefused?: boolean; state?: object; crewRefused?: object } = {}) {
  const called: Called[] = [];
  const client = {
    call: (method: string, params: Called['params']) => {
      called.push({ method, params });
      const refused = o.refuse?.[method];
      if (refused) return Promise.reject(refused);
      if (method === 'fleet.homeCheck') {
        return Promise.resolve(o.checkRefused
          ? { ok: false, refusal: { reason: 'studio is not reachable', action: 'try again when it is awake', details: [] } }
          : { ok: true, sheet: { here: 2, there: 1, mission: [], toName: 'studio', rewrites: [] } });
      }
      if (method === 'state.get') return Promise.resolve(o.state ?? { robots: {}, islands: {}, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1, snapshot: { version: 3, at: 1 } }, [MAC]: { name: 'mac', reachable: true, since: 1 } } });
      if (method === 'fleet.freeze') return Promise.resolve({ phone: { serving: false, logins: [] } });
      if (method === 'fleet.home') return Promise.resolve({ machine: machineId(), name: 'mac', mine: true, me: machineId(), fleetId: FLEET });
      if (method === 'robot.moveTo') return Promise.resolve({ moveId: 'mv_0123456789' });
      if (method === 'robot.moveCheck') return Promise.resolve(o.crewRefused && (params as { interruptAfterMs?: number }).interruptAfterMs === undefined ? { ok: false, refusal: o.crewRefused } : { ok: true, sheet: {} });
      return Promise.resolve({});
    },
    close: () => {},
  };
  return { client: client as unknown as Client, called };
}

let events: StepEvent[];
let home: string;

const failed = () => events.find((e) => e.status === 'fail');
const ran = () => events.filter((e) => e.status !== 'start').map((e) => `${e.step}:${e.status}`);

beforeEach(() => {
  events = [];
  home = makeHome();
  fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: FLEET }));
  fs.writeFileSync(resolvePaths(home).state, JSON.stringify({ schema: 1, robots: {}, islands: {}, machines: {} }));
});
afterEach(() => { disarmCrash(); cleanHomes(); });
afterAll(() => { expect(POINTS_OF.driver.filter((p) => !crashesFired().has(p))).toEqual([]); });

function outDeps(far: (line: string, input?: string) => { code: number; stdout: string; stderr?: string } | Promise<{ code: number; stdout: string; stderr?: string }>, o: Parameters<typeof daemon>[0] = {}) {
  const registry = MachineRegistry.load();
  const entryId = STUDIO;
  registry.put(entryId, STUDIO_RECORD as never);
  registry.save();
  const d = daemon(o);
  let started = 0;
  const master = {
    run: async (argv: string[], opts?: { input?: string }) => {
      const line = argv.join(' ');
      if (line.includes('connection-info')) return { code: 0, signal: null, stdout: JSON.stringify(FAR_INFO(entryId)), stderr: '' };
      const r = await far(line, opts?.input);
      return { signal: null, stderr: '', ...r };
    },
    close: () => Promise.resolve(),
  } as unknown as SshMaster;
  const deps: MoveDeps = {
    emit: (e) => events.push(e), openMaster: () => Promise.resolve(master), registry, target: { name: 'private', home, managed: false }, me: machineId(),
    daemon: { stop: () => Promise.resolve(), start: () => { started++; return Promise.resolve(); }, answersHome: () => Promise.resolve(true) },
    client: () => Promise.resolve(d.client),
    farClient: () => Promise.resolve(daemon().client),
  };
  return { deps, called: d.called, started: () => started };
}

const answer = (a: AdoptAnswer) => ({ code: 0, stdout: JSON.stringify(a) });
const ENROL = { worker: { homeMachineId: STUDIO, fleetId: FLEET, token: 'x'.repeat(48), homeName: 'studio' } };

describe('fleet home set <machine>: its steps as NDJSON', () => {
  const happy = (line: string) => answer(line.includes('--stage') ? { status: 'pending', phase: 'staged' } : { status: 'adopted', enrol: ENROL as never });

  it('runs the steps in order, thawing nothing once marked', async () => {
    const { deps, called, started } = outDeps(happy);
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('ready');
    expect(ran()).toEqual(['check:ok', 'mission:skip', 'pause:ok', 'copy:ok', 'mark:ok', 'adopt:ok', 'join:ok', 'probe:ok']);
    expect(called.map((c) => (c.params.op ? `${c.method}:${c.params.op}` : c.method)).filter((m) => m !== 'state.get')).toEqual(['fleet.homeCheck', 'fleet.homeMove:open', 'fleet.freeze', 'fleet.homeMove:mark', 'fleet.homeMove:join']);
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(false);
    expect(started()).toBe(1);
  });

  it('a check that refuses freezes nothing, and says what to do', async () => {
    const { deps, called } = outDeps(happy, { checkRefused: true });
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'check', detail: 'studio is not reachable', action: 'try again when it is awake' });
    expect(called.some((c) => c.method === 'fleet.freeze')).toBe(false);
  });

  it('a failed stage thaws this home and calls it off there', async () => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return line.includes('--stage') ? { code: 1, stdout: '', stderr: 'svall: no room' } : answer({ status: 'not-adopted' }); });
    await moveHomeOut('studio', deps);
    expect(failed()).toMatchObject({ step: 'copy' });
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(true);
    expect(lines.some((l) => /'fleet' 'abort'/.test(l))).toBe(true);
  });

  it('an adopt that comes back pending after the mark leaves it frozen, and points at retry and abort', async () => {
    const { deps, called } = outDeps((line) => answer(line.includes('--stage') ? { status: 'pending', phase: 'staged' } : { status: 'pending', phase: 'rolledback', detail: 'its daemon did not answer' }));
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'adopt', detail: expect.stringContaining('its daemon did not answer'), action: 'svall fleet home abort, or svall fleet home retry' });
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(false);
  });

  it('no machine by that name refuses before anything, as a failure and not a move that went well', async () => {
    const { deps, called } = outDeps(happy);
    const out = await moveHomeOut('nowhere', deps);
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'check', detail: 'no machine nowhere with an ssh destination in the registry' });
    expect(called).toEqual([]);
  });

  it('a mark that fails thaws and calls it off there, as nothing has been marked', async () => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return happy(line); });
    const client = await deps.client();
    deps.client = () => Promise.resolve({ ...client, call: (m: never, p: never) => ((p as Called['params']).op === 'mark' ? Promise.reject(new Error('gone')) : client.call(m, p)), close: () => {} } as unknown as Client);
    await moveHomeOut('studio', deps);
    expect(failed()?.step).toBe('mark');
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(true);
    expect(lines.some((l) => /'fleet' 'abort'/.test(l))).toBe(true);
    expect(readMarker(resolvePaths(home))).toBeUndefined();
  });

  it('a daemon that does not take the outcome has it written where its next start finds it', async () => {
    const { deps } = outDeps(happy);
    const client = await deps.client();
    deps.client = () => Promise.resolve({ ...client, call: (m: never, p: never) => {
      const params = p as Called['params'];
      if (params.op === 'mark') writeMarker(resolvePaths(home), params.marker!);
      if (params.op === 'join') return Promise.reject(new Error('it went away'));
      return client.call(m, p);
    }, close: () => {} } as unknown as Client);
    expect((await moveHomeOut('studio', deps)).result).toBe('ready');
    expect(readMarker(resolvePaths(home))?.enrol).toBeDefined();
  });

  it('a machine named by its id goes by its name, in its steps and on the far side', async () => {
    const lines: string[] = [];
    const { deps } = outDeps((line) => { lines.push(line); return happy(line); });
    const seen: HomeMoving[] = [];
    const client = await deps.client();
    deps.client = () => Promise.resolve({ ...client, call: (m: never, p: never) => { const o = p as Called['params']; if (o.op === 'mark') seen.push(o.marker!); return client.call(m, p); }, close: () => {} } as unknown as Client);
    expect((await moveHomeOut(STUDIO, deps)).result).toBe('ready');
    expect(seen[0].toName).toBe('studio');
  });

  it('a far fleet going by another fleet\'s worker.json is refused by the machine itself, with this home thawed', async () => {
    const { deps, called } = outDeps((line) => (line.includes('--stage') ? { code: 1, stdout: '', stderr: 'svall: this machine is a worker of another fleet' } : answer({ status: 'not-adopted' })));
    await moveHomeOut('studio', deps);
    expect(failed()).toMatchObject({ step: 'copy', detail: expect.stringContaining('another fleet') });
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(true);
  });

  describe('mission control\'s robots', () => {
    const crewState = (machine?: string) => ({ robots: { crew: { id: 'crew', name: 'crew', islandId: 'home', ...(machine && { machine, sentAhead: 'hm_abcdefghij' }) }, here: { id: 'here', name: 'here', islandId: 'i_a' } }, islands: { home: { id: 'home', kind: 'home' }, i_a: { id: 'i_a' } }, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1, snapshot: { version: 3, at: 1 } } } });

    it('a machine this one cannot log in to stops the move before any of them moves', async () => {
      const { deps, called } = outDeps(happy, { state: crewState() });
      deps.openMaster = () => Promise.reject(new Error('Permission denied (publickey)'));
      await moveHomeOut('studio', deps);
      expect(failed()).toMatchObject({ step: 'check', detail: expect.stringContaining('Permission denied') });
      expect(called.some((c) => c.method === 'robot.moveTo')).toBe(false);
      expect(called.some((c) => c.method === 'fleet.freeze')).toBe(false);
    });

    const WORKING = { reason: 'crew is working', action: INTERRUPT_ACTIONS.agent, details: [] };

    it('one at work is named in the check, with the flag that decides it, and nothing has moved or frozen', async () => {
      const { deps, called } = outDeps(happy, { state: crewState(), crewRefused: WORKING });
      const out = await moveHomeOut('studio', deps);
      expect(failed()).toMatchObject({ step: 'check', detail: 'crew is working' });
      expect(out.actions.join()).toContain('svall fleet home set studio --interrupt-after 0');
      expect(called.some((c) => c.method === 'robot.moveTo' || c.method === 'fleet.freeze' || c.params.op === 'open')).toBe(false);
    });

    it('any other refusal of theirs stops it there too, by the robot\'s name and in its own words', async () => {
      const { deps, called } = outDeps(happy, { state: crewState(), crewRefused: { reason: 'claude is not logged in on studio', action: 'log in there', details: [] } });
      const out = await moveHomeOut('studio', deps);
      expect(failed()).toMatchObject({ step: 'check', detail: 'crew: claude is not logged in on studio' });
      expect(out.actions).toContain('log in there');
      expect(called.some((c) => c.method === 'robot.moveTo')).toBe(false);
    });

    it('its interrupt runs only on that choice', async () => {
      const without = outDeps(happy, { state: crewState() });
      await moveHomeOut('studio', without.deps);
      expect(without.called.find((c) => c.method === 'robot.moveTo')?.params).not.toHaveProperty('interruptAfterMs');
      const chose = outDeps(happy, { state: crewState(), crewRefused: WORKING });
      await moveHomeOut('studio', chose.deps, { interruptAfterMs: 0 });
      expect(chose.called.find((c) => c.method === 'robot.moveCheck')?.params.interruptAfterMs).toBe(0);
      expect(chose.called.find((c) => c.method === 'robot.moveTo')?.params.interruptAfterMs).toBe(0);
    });

    it('bringing them back interrupts only on the choice too', async () => {
      const without = outDeps(happy, { state: crewState(STUDIO) });
      await bringCrewBack(without.deps);
      expect(without.called.find((c) => c.method === 'robot.moveTo')?.params).not.toHaveProperty('interruptAfterMs');
      const chose = outDeps(happy, { state: crewState(STUDIO) });
      await bringCrewBack(chose.deps, { interruptAfterMs: 0 });
      expect(chose.called.find((c) => c.method === 'robot.moveTo')?.params.interruptAfterMs).toBe(0);
    });

    it('a placed robot dragged onto mission control is no crew a move left behind: nothing offers it back', async () => {
      const state = crewState();
      Object.assign(state.robots.crew, { machine: STUDIO });
      const { deps, called } = outDeps(happy, { state });
      await bringCrewBack(deps);
      expect(ran()).toContain('crew:skip');
      expect(called.some((c) => c.method === 'robot.moveTo')).toBe(false);
    });

    it('the daemon opens the move before the first of them moves under its id', async () => {
      const { deps, called } = outDeps(happy, { state: crewState() });
      await moveHomeOut('studio', deps);
      const [open, move] = [called.findIndex((c) => c.params.op === 'open'), called.findIndex((c) => c.method === 'robot.moveTo')];
      expect(open).toBeGreaterThanOrEqual(0);
      expect(move).toBeGreaterThan(open);
      expect(called[move].params.homeMove).toBe(called[open].params.id);
    });

    it('a move stopped after they went says they stayed, and how to bring them back', async () => {
      const state = crewState();
      const { deps } = outDeps((line) => (line.includes('--stage') ? { code: 1, stdout: '', stderr: 'svall: no room' } : answer({ status: 'not-adopted' })), { state });
      const client = await deps.client();
      deps.client = () => Promise.resolve({ ...client, call: (m: never, p: never) => { if ((m as string) === 'robot.moveTo') Object.assign(state.robots.crew, { machine: STUDIO, sentAhead: 'hm_abcdefghij' }); return client.call(m, p); }, close: () => {} } as unknown as Client);
      const out = await moveHomeOut('studio', deps);
      expect(out.actions).toContain('svall fleet home crew-back');
      expect(events.find((e) => e.step === 'crew' && e.status === 'warn')?.detail).toContain('crew');
    });

    it('crew-back moves each back to the home under an id it opened, and names any that cannot return', async () => {
      const state = crewState(STUDIO);
      const { deps, called } = outDeps(happy, { state });
      expect((await bringCrewBack(deps)).result).toBe('ready');
      const open = called.find((c) => c.params.op === 'open');
      const moves = called.filter((c) => c.method === 'robot.moveTo');
      expect(moves.map((c) => [c.params.id, c.params.machine, c.params.homeMove])).toEqual([['crew', machineId(), open!.params.id]]);
      events = [];
      const stuck = outDeps(happy, { state, refuse: { 'robot.moveTo': new Error('its worktree is dirty') } });
      const out = await bringCrewBack(stuck.deps);
      expect(out.result).toBe('actions');
      expect(failed()).toMatchObject({ step: 'crew', detail: expect.stringContaining('crew: its worktree is dirty') });
    });

    it('crew-back with all of them home says so and moves nothing', async () => {
      const { deps, called } = outDeps(happy, { state: crewState() });
      expect((await bringCrewBack(deps)).result).toBe('ready');
      expect(ran()).toContain('crew:skip');
      expect(called.some((c) => c.method === 'robot.moveTo')).toBe(false);
    });
  });

  it('a driver killed right after the mark leaves the marker, and the far machine holding its archive', async () => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return happy(line); });
    // the driver's mark is its daemon's to write, which this daemon is not
    const client = await deps.client();
    deps.client = () => Promise.resolve({ ...client, call: (m: never, p: never) => {
      const params = p as Called['params'];
      if (params.op === 'mark') writeMarker(resolvePaths(home), params.marker!);
      return client.call(m, p);
    }, close: () => {} } as unknown as Client);
    crashAt('move.marked');
    await expect(moveHomeOut('studio', deps)).rejects.toThrow(HomeCrash);
    expect(readMarker(resolvePaths(home))).toBeDefined();
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(false);
    expect(lines.some((l) => /'fleet' 'abort'/.test(l))).toBe(false);
    expect(lines.some((l) => /--home-ssh/.test(l))).toBe(false);
  });
});

describe('what the machine taking the fleet tells the old home', () => {
  const m = { from: MAC, fleetId: FLEET, toName: 'studio', record: { name: 'mac', platform: 'darwin' } } as unknown as HomeManifest;
  const paths = (home_: string) => resolvePaths(home_);

  it('dials in: the socket here and its record, by the name the fleet knew it by', () => {
    const e = enrolmentFor(paths('/home/ada/.svall'), STUDIO, { ssh: 'ada@studio', home: { ...STUDIO_RECORD, name: 'linus-vault3' } as never })('t'.repeat(48), m);
    expect(e.worker).toMatchObject({ homeMachineId: STUDIO, fleetId: FLEET, homeName: 'studio', homeSsh: 'ada@studio', token: 't'.repeat(48) });
    expect(e.worker.homeSocket).toMatch(/^\/home\/ada\/\.svall\/w\/[0-9a-f]+\.sock$/);
    expect(e.home).toMatchObject({ name: 'studio', ssh: 'ada@studio' });
  });

  it('dialed: nothing of a socket', () => {
    const e = enrolmentFor(paths('/Users/ada/.svall'), MAC, { home: STUDIO_RECORD as never })('t'.repeat(48), { ...m, from: STUDIO, record: { ...m.record, platform: 'linux' } } as never);
    expect(e.worker.homeSocket).toBeUndefined();
    expect(e.home).toBeUndefined();
  });

  it('a socket a Mac cannot bind is refused before anything is installed', () => {
    const long = `/home/${'a'.repeat(90)}/.svall`;
    expect(() => enrolmentFor(paths(long), STUDIO, { ssh: 'ada@studio', home: STUDIO_RECORD as never })('t'.repeat(48), m)).toThrow(/mac cannot dial into/);
  });
});

describe('fleet home retry', () => {
  const marker = (ask = true): HomeMoving => ({
    id: 'hm_abcdefghij' as HomeMoveId, from: machineId(), fromName: 'mac', fromHome: '/Users/ada' as never, to: STUDIO, toName: 'studio', toHome: '/home/ada' as never, at: 5,
    ...(ask && { ask: { ssh: 'ada@studio' as never, svallBase: '/opt' as never, fleetHome: '/home/ada/.svall' as never } }),
  });

  it('with nothing under way says so', async () => {
    const { deps } = outDeps(() => answer({ status: 'done' }));
    const out = await resumeHome(deps);
    expect(out.result).toBe('actions');
    expect(out.actions).toEqual(['no move of the fleet waits on this machine']);
  });

  it('a marked home runs the far adopt again from what stays staged, joins and proves it', async () => {
    const lines: string[] = [];
    const { deps, started } = outDeps((line) => { lines.push(line); return answer({ status: 'adopted', enrol: ENROL as never }); });
    writeMarker(resolvePaths(home), marker());
    const out = await resumeHome(deps);
    expect(out.result).toBe('ready');
    expect(ran()).toEqual(['adopt:ok', 'join:ok', 'probe:ok']);
    expect(lines.filter((l) => /'fleet' 'adopt' 'hm_abcdefghij' '--home-ssh' 'ada@studio'/.test(l))).toHaveLength(1);
    expect(started()).toBe(1);
  });

  it('a home with no route waits to be told', async () => {
    const { deps } = outDeps(() => answer({ status: 'done' }));
    writeMarker(resolvePaths(home), marker(false));
    const out = await resumeHome(deps);
    expect(out.actions).toEqual(['svall fleet home retry on studio']);
  });

  it('a far machine that does not answer leaves this home frozen, saying so', async () => {
    const { deps } = outDeps(() => answer({ status: 'done' }));
    deps.openMaster = () => Promise.reject(new Error('ssh: connect to host studio'));
    writeMarker(resolvePaths(home), marker());
    const out = await resumeHome(deps);
    expect(out.actions).toEqual(['svall fleet home retry once it answers; until then this home stays frozen']);
    expect(readMarker(resolvePaths(home))?.id).toBe('hm_abcdefghij');
  });
});

describe('fleet home set local', () => {
  // this machine a worker of studio by a real move out, its registry naming it, and studio answering over a master
  async function workerHere(marked: () => boolean = () => true) {
    const w = await movedOut();
    const registry = MachineRegistry.load();
    registry.put(STUDIO, STUDIO_RECORD as never);
    registry.save();
    const far = daemon();
    const order: string[] = [];
    const farClient = {
      call: (m: never, p: Called['params']) => { order.push(`${String(m)}${p.op ? `:${p.op}` : ''}${p.op === 'mark' && readOwed(w.mac.paths) ? ' owed' : ''}`); return far.client.call(m, p as never); },
      close: () => {},
    } as unknown as Client;
    const settled: string[] = [];
    const master = {
      run: async (argv: string[]) => {
        const line = argv.join(' ');
        const ok = (out: unknown) => ({ code: 0, signal: null, stderr: '', stdout: JSON.stringify(out) });
        if (line.includes("'export'")) {
          const manifest = JSON.parse(argv.at(-1)!.replace(/^'|'$/g, '')) as HomeManifest;
          const { sha256, bytes } = await packFleet(w.studio.paths, { ...manifest, to: MAC });
          return ok({ sha256, archive: bytes.toString('base64') });
        }
        if (line.includes("'settle'")) { settled.push(line.includes('not-adopted') ? 'not-adopted' : 'adopted'); return ok({ status: 'done' }); }
        if (line.includes("'facts'")) return ok({ machineId: STUDIO, role: 'home', release: '1', protocol: PROTOCOL_VERSION, stateSchema: 1, clock: 1, home: '/home/ada', svallBase: '/opt', fleetHome: '/home/ada/.svall', tailscale: {}, ...(marked() && { moving: readOwed(w.mac.paths)?.id }) });
        throw new Error(`unexpected ${line}`);
      },
      close: () => Promise.resolve(),
    } as unknown as SshMaster;
    const local = daemon({ state: { robots: {}, islands: {}, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1 } } } });
    const deps: MoveDeps = {
      emit: (e) => events.push(e), openMaster: () => Promise.resolve(master), registry, target: { name: 'private', home: w.mac.paths.home, managed: false }, me: MAC,
      daemon: w.mac.daemon, client: () => Promise.resolve(local.client), farClient: () => Promise.resolve(farClient),
    };
    return { w, deps, order, far, settled, master };
  }

  // the daemon's own telling, as it runs beside the driver
  const telling = (w: Awaited<ReturnType<typeof movedOut>>, master: SshMaster) => startDeliveries(w.mac.paths, { error: () => {}, info: () => {} }, () => Promise.resolve(master));

  it('on a home already, refuses, and says so as a failure', async () => {
    const { w, deps } = await workerHere();
    fs.rmSync(w.mac.paths.workerFile);
    const out = await moveHomeBack(deps);
    expect(out.result).toBe('actions');
    expect(out.actions).toEqual(["this machine is the fleet's home already"]);
  });

  it('runs its steps in order, the outcome owed before the old home is marked, and tells it', async () => {
    const { w, deps, order, settled, master } = await workerHere();
    const stop = telling(w, master);
    const out = await moveHomeBack(deps);
    stop();
    expect(ran()).toEqual(['check:ok', 'mission:skip', 'pause:ok', 'copy:ok', 'mark:ok', 'adopt:ok', 'join:ok', 'probe:ok']);
    expect(out.result).toBe('ready');
    expect(order).toContain('fleet.homeMove:mark owed');
    expect(settled).toEqual(['adopted']);
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(w.mac.daemon.role).toBe('home');
  }, 30_000);

  it('a mark that fails calls the move off here, thaws, and the old home is told if it heard', async () => {
    const { w, deps, far, order, settled, master } = await workerHere();
    deps.farClient = () => Promise.resolve({
      call: (m: never, p: Called['params']) => {
        order.push(String(m));
        return p.op === 'mark' ? Promise.reject(new ApiError('not_frozen', 'not frozen')) : far.client.call(m, p as never);
      },
      close: () => {},
    } as unknown as Client);
    await moveHomeBack(deps);
    expect(failed()?.step).toBe('mark');
    expect(far.called.some((c) => c.method === 'fleet.thaw')).toBe(true);
    const owed = readOwed(w.mac.paths)!;
    expect(journalLines(w.mac.paths, owed.id).at(-1)?.phase).toBe('aborted');
    expect(await deliverOwed(w.mac.paths, () => Promise.resolve(master))).toBe('told');
    expect(settled).toEqual(['not-adopted']);
  });

  it('a daemon that will not answer leaves the old home frozen and the outcome owed; a retry finishes it', async () => {
    const { w, deps, far, settled, master } = await workerHere();
    w.mac.daemon.noAnswer = true;
    const out = await moveHomeBack(deps);
    expect(out.actions).toEqual(['svall fleet home abort, or svall fleet home retry']);
    expect(far.called.some((c) => c.method === 'fleet.thaw')).toBe(false);
    expect(readOwed(w.mac.paths)).toBeDefined();
    expect(w.mac.daemon.role).toBe('worker');
    w.mac.daemon.noAnswer = false;
    events = [];
    const stop = telling(w, master);
    expect((await resumeHome(deps)).result).toBe('ready');
    stop();
    expect(ran()).toEqual(['check:ok', 'adopt:ok', 'join:ok', 'probe:ok']);
    expect(settled).toEqual(['adopted']);
    expect(w.mac.daemon.role).toBe('home');
  }, 30_000);

  it('a retry past a driver that died before the mark does not take the fleet from a home that thawed: two homes, otherwise', async () => {
    let frozen = true;
    const { w, deps, settled, master } = await workerHere(() => frozen);
    // killed as the copy ends, with the archive here and the mark not gone
    const emit = deps.emit;
    deps.emit = (e) => { emit(e); if (e.step === 'copy' && e.status === 'ok') throw new HomeCrash('killed'); };
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    deps.emit = emit;
    const id = readOwed(w.mac.paths)!.id;
    frozen = false;
    events = [];
    const stop = telling(w, master);
    const out = await resumeHome(deps);
    stop();
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'check', detail: 'the old home is not frozen for this move and goes on as the home' });
    expect(w.mac.daemon.role).toBe('worker');
    expect(fs.existsSync(w.mac.paths.workerFile)).toBe(true);
    expect(journalLines(w.mac.paths, id).at(-1)?.phase).toBe('aborted');
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(settled).toEqual(['not-adopted']);
  }, 30_000);

  it('a driver killed before its archive came: a retry calls the move off', async () => {
    const { w, deps, settled, master } = await workerHere();
    crashAt('deliver.owed');
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    events = [];
    const stop = telling(w, master);
    const out = await resumeHome(deps);
    stop();
    expect(out.actions).toEqual(['svall fleet home set local to start again']);
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(w.mac.daemon.role).toBe('worker');
    expect(settled).toEqual(['not-adopted']);
  }, 30_000);

  it('a retry with the old home out of reach changes nothing here', async () => {
    const { w, deps } = await workerHere();
    crashAt('move.marked');
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    const id = readOwed(w.mac.paths)!.id;
    const opened = deps.openMaster;
    deps.openMaster = () => Promise.reject(new Error('ssh: connect to host studio'));
    const out = await resumeHome(deps);
    deps.openMaster = opened;
    expect(out.actions).toEqual(['svall fleet home retry once it answers']);
    expect(w.mac.daemon.role).toBe('worker');
    expect(journalLines(w.mac.paths, id).at(-1)?.phase).toBe('staged');
  }, 30_000);

  it('a driver killed after the mark: abort refuses the move for good, and the old home hears', async () => {
    const { w, deps, far, settled, master } = await workerHere();
    crashAt('move.marked');
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    expect(far.called.some((c) => c.method === 'fleet.thaw')).toBe(false);
    const id = readOwed(w.mac.paths)!.id;
    const stop = telling(w, master);
    expect(await abortBack(deps)).toEqual({ status: 'not-adopted', told: true });
    stop();
    expect(settled).toEqual(['not-adopted']);
    expect(await installAdopt({ paths: w.mac.paths, me: MAC, daemon: w.mac.daemon }, id, () => { throw new Error('built'); })).toMatchObject({ status: 'not-adopted' });
    expect(w.mac.daemon.role).toBe('worker');
  }, 30_000);

  it('abort with nothing owed here leaves it to the daemon', async () => {
    const { deps } = await workerHere();
    expect(await abortBack(deps)).toBeUndefined();
  });
});
