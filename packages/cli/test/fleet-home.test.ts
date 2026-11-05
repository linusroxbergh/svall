import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, PROTOCOL_VERSION, type AdoptAnswer, type HomeManifest, type HomeMoveId, type HomeMoving } from '@svall/protocol';
import { armHomeFailpoints, HomeCrash } from '@svall/svalld/failpoints';
import { deliverOwed, startDeliveries } from '@svall/svalld/fleet/home-far';
import { installAdopt, journalLines, packFleet, readMarker, readOwed, writeMarker } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { machineId } from '@svall/svalld/machine';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { MAC, movedOut, STUDIO, STUDIO_RECORD } from '../../svalld/test/fleet/home-world.js';
import type { Client } from '../src/client.js';
import { abortBack, moveHomeBack, moveHomeOut, resumeHome, type MoveDeps } from '../src/controller/home.js';
import type { StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import type { SshMaster } from '../src/controller/ssh.js';

const FLEET = '11111111-2222-3333-4444-555555555555';
const FAR_INFO = (id: string) => ({ fleetId: FLEET, machineId: id, release: '1.0.0', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 47800, token: 'api', fleetHome: '/home/ada/.svall' });

type Called = { method: string; params: { op?: string; marker?: HomeMoving } & Record<string, unknown> };

/** This fleet's daemon as the driver sees it. */
function daemon(o: { refuse?: Record<string, Error>; checkRefused?: boolean; state?: object } = {}) {
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
afterEach(cleanHomes);

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
    expect(called.map((c) => (c.params.op ? `${c.method}:${c.params.op}` : c.method)).filter((m) => m !== 'state.get')).toEqual(['fleet.homeCheck', 'fleet.freeze', 'fleet.homeMove:mark', 'fleet.homeMove:join']);
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
    const { deps, called } = outDeps((line) => { lines.push(line); return happy(line); }, { refuse: { 'fleet.homeMove': new Error('gone') } });
    await moveHomeOut('studio', deps);
    expect(failed()?.step).toBe('mark');
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(true);
    expect(lines.some((l) => /'fleet' 'abort'/.test(l))).toBe(true);
    expect(readMarker(resolvePaths(home))).toBeUndefined();
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
    const disarm = armHomeFailpoints((name) => { if (name === 'move.marked') throw new HomeCrash(name); });
    await expect(moveHomeOut('studio', deps)).rejects.toThrow(HomeCrash);
    disarm();
    expect(readMarker(resolvePaths(home))).toBeDefined();
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(false);
    expect(lines.some((l) => /'fleet' 'abort'/.test(l))).toBe(false);
    expect(lines.some((l) => /--home-ssh/.test(l))).toBe(false);
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
  async function workerHere() {
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
    expect(ran()).toEqual(['adopt:ok', 'join:ok', 'probe:ok']);
    expect(settled).toEqual(['adopted']);
    expect(w.mac.daemon.role).toBe('home');
  }, 30_000);

  it('a driver killed after the mark: abort refuses the move for good, and the old home hears', async () => {
    const { w, deps, far, settled, master } = await workerHere();
    const disarm = armHomeFailpoints((name) => { if (name === 'move.marked') throw new HomeCrash(name); });
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    disarm();
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
