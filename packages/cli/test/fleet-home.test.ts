import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, INTERRUPT_ACTIONS, PROTOCOL_VERSION, type AdoptAnswer, type HomeManifest, type HomeMoveId, type HomeMoving } from '@svall/protocol';
import { HomeCrash } from '@svall/svalld/failpoints';
import { deliverOwed, startDeliveries } from '@svall/svalld/fleet/home-far';
import { abortAdopt, driverAdoptKey, driverKey, installAdopt, journalLines, markKey, mintAdoptKey, packFleet, readMarker, readOwed } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { machineId } from '@svall/svalld/machine';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { ADOPT_KEY, crashAt, crashesFired, disarmCrash, MAC, movedOut, POINTS_OF, STUDIO, STUDIO_RECORD, putMarker } from '../../svalld/test/fleet/home-world.js';
import type { Client } from '../src/client.js';
import { homeMoveLock } from '../../svalld/src/kernel-lock.js';
import { finishFlow } from '../src/commands/fleet.js';
import { abortBack, abortHome, bringCrewBack, enrolmentFor, moveHomeBack, moveHomeOut, resumeHome, type MoveDeps } from '../src/controller/home.js';
import type { StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import type { SshMaster } from '../src/controller/ssh.js';

const FLEET = '11111111-2222-3333-4444-555555555555';
const FAR_INFO = (id: string) => ({ fleetId: FLEET, machineId: id, release: '1.0.0', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 47800, token: 'api', fleetHome: '/home/ada/.svall' });

type Called = { method: string; params: { op?: string; marker?: HomeMoving } & Record<string, unknown> };

/** This fleet's daemon as the driver sees it. */
function daemon(o: { refuse?: Record<string, Error>; checkRefused?: boolean; rewrites?: object[]; state?: object; crewRefused?: object; abort?: object; phone?: object } = {}) {
  const called: Called[] = [];
  const client = {
    call: (method: string, params: Called['params']) => {
      called.push({ method, params });
      const refused = o.refuse?.[method];
      if (refused) return Promise.reject(refused);
      if (method === 'fleet.homeCheck') {
        return Promise.resolve(o.checkRefused
          ? { ok: false, refusal: { reason: 'studio is not reachable', action: 'try again when it is awake', details: [] } }
          : { ok: true, sheet: { here: 2, there: 1, mission: [], toName: 'studio', rewrites: o.rewrites ?? [] } });
      }
      if (method === 'state.get') return Promise.resolve(o.state ?? { robots: {}, islands: {}, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1, snapshot: { version: 3, at: 1 } }, [MAC]: { name: 'mac', reachable: true, since: 1 } } });
      if (method === 'fleet.freeze') return Promise.resolve({ phone: o.phone ?? { serving: false, logins: [] } });
      if (method === 'fleet.home') return Promise.resolve({ machine: machineId(), name: 'mac', mine: true, me: machineId(), fleetId: FLEET });
      if (method === 'robot.moveTo') return Promise.resolve({ moveId: 'mv_0123456789' });
      if (method === 'fleet.homeMove' && params.op === 'abort' && o.abort) return Promise.resolve(o.abort);
      if (method === 'fleet.homeMove' && params.op === 'status' && o.abort) return Promise.resolve({ moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true } });
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

  it('says of a rewritten path that the machine taking the fleet does not have it, and goes on', async () => {
    const { deps } = outDeps(happy, { rewrites: [{ key: 'defaultCwd', to: '~/code', lacks: true }, { key: 'home.cwd', to: '~/crew' }, { key: 'onboarding.firstProject', to: '~/first', kept: true, lacks: true }] });
    expect((await moveHomeOut('studio', deps)).result).toBe('ready');
    expect(events.find((e) => e.step === 'check' && e.status === 'ok')?.detail)
      .toBe('2 robots stay here, 1 on studio; defaultCwd becomes ~/code, which studio does not have yet; onboarding.firstProject is ~/first, which studio does not have yet');
  });

  it('a check that refuses freezes nothing, and says what to do', async () => {
    const { deps, called } = outDeps(happy, { checkRefused: true });
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'check', detail: 'studio is not reachable', action: 'try again when it is awake' });
    expect(called.some((c) => c.method === 'fleet.freeze')).toBe(false);
  });

  it('a failed stage thaws this home and calls it off there, saying which home asks, and no install key goes', async () => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return line.includes('--stage') ? { code: 1, stdout: '', stderr: 'svall: no room' } : answer({ status: 'not-adopted' }); });
    await moveHomeOut('studio', deps);
    expect(failed()).toMatchObject({ step: 'copy' });
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(true);
    expect(lines.some((l) => l.includes(`'fleet' 'abort'`) && l.includes(`'--asker' '${machineId()}' '--fleet' '${FLEET}'`))).toBe(true);
    expect(lines.some((l) => l.includes('--home-ssh'))).toBe(false);
  });

  it('a connection-info that fails sends no abort, which with no folder named would reach the far machine\'s private fleet', async () => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return answer({ status: 'not-adopted' }); });
    const run = await deps.openMaster('ada@studio');
    const inner = run.run.bind(run);
    run.run = ((argv: string[], o?: never) => (argv.join(' ').includes('connection-info') ? Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'svalld is not running' }) : inner(argv, o))) as never;
    await moveHomeOut('studio', deps);
    expect(failed()).toMatchObject({ step: 'check' });
    expect(lines.filter((l) => l.includes("'abort'"))).toEqual([]);
    expect(called.some((c) => c.method === 'fleet.thaw')).toBe(true);
  });

  it('the install key is minted before the copy, its hash in the manifest, and goes on stdin alone, only past the mark', async () => {
    const sent: { line: string; input?: string; marked: boolean }[] = [];
    const out = outDeps((line, input) => { sent.push({ line, input, marked: out.called.some((c) => c.params.op === 'mark') }); return happy(line); });
    expect((await moveHomeOut('studio', out.deps)).result).toBe('ready');
    const { id } = out.called.find((c) => c.params.op === 'mark')!.params.marker!;
    const key = driverAdoptKey(resolvePaths(home), id)!;
    const phases = journalLines(resolvePaths(home), `${id}.driver`).map((l) => l.phase);
    expect(phases.indexOf('adopt-key')).toBeGreaterThan(-1);
    expect(phases.indexOf('adopt-key')).toBeLessThan(phases.indexOf('copy'));
    expect(key).not.toBe(driverKey(resolvePaths(home), id));
    const dir = fs.mkdtempSync(path.join(home, 'tar-'));
    fs.writeFileSync(path.join(dir, 'in.tar'), Buffer.from(sent.find((s) => s.line.includes('--stage'))!.input!, 'base64'));
    execFileSync('tar', ['-x', '-f', 'in.tar', 'home-move.json'], { cwd: dir });
    expect((JSON.parse(fs.readFileSync(path.join(dir, 'home-move.json'), 'utf8')) as HomeManifest).adoptKeySha256).toBe(crypto.createHash('sha256').update(key).digest('hex'));
    const install = sent.find((s) => s.line.includes('--home-ssh'))!;
    expect(install).toMatchObject({ input: key, marked: true });
    expect(sent.filter((s) => s.line.includes(key) || (s !== install && s.input?.includes(key)))).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(key);
    expect(JSON.stringify(out.called)).not.toContain(key);
  });

  it('an adopt that comes back pending after the mark leaves it frozen, and points at retry and abort', async () => {
    const { deps, called } = outDeps((line) => answer(line.includes('--stage') ? { status: 'pending', phase: 'staged' } : { status: 'pending', phase: 'rolledback', detail: 'its daemon did not answer' }));
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'adopt', detail: expect.stringContaining('its daemon did not answer'), action: 'svall fleet home abort, or svall fleet home retry', say: 'Close to finish the move or call it off' });
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
      if (params.op === 'mark') putMarker(resolvePaths(home), params.marker!);
      if (params.op === 'join') return Promise.reject(new Error('it went away'));
      return client.call(m, p);
    }, close: () => {} } as unknown as Client);
    expect((await moveHomeOut('studio', deps)).result).toBe('ready');
    expect(readMarker(resolvePaths(home))?.enrol).toBeDefined();
  });

  it('the mark holds the hash of a key only the driver\'s journal holds, and the join carries that key', async () => {
    const { deps, called } = outDeps(happy);
    expect((await moveHomeOut('studio', deps)).result).toBe('ready');
    const op = (o: string) => called.find((c) => (c.params as Called['params']).op === o)?.params as Called['params'];
    const { id, keySha256 } = op('mark').marker!;
    const key = driverKey(resolvePaths(home), id)!;
    expect(crypto.createHash('sha256').update(key).digest('hex')).toBe(keySha256);
    expect(op('join').key).toBe(key);
    expect(JSON.stringify(op('mark'))).not.toContain(key);
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

    it('crew-back that one at work holds back says so in the words a window offers as the choice', async () => {
      const refused = new ApiError('refused', 'crew is working; interrupt it now', { refusal: WORKING });
      const { deps } = outDeps(happy, { state: crewState(STUDIO), refuse: { 'robot.moveTo': refused } });
      expect((await bringCrewBack(deps)).result).toBe('actions');
      expect(failed()).toMatchObject({ step: 'crew', detail: expect.stringContaining('crew is working'), action: expect.stringContaining('svall fleet home crew-back --interrupt-after 0'), say: INTERRUPT_ACTIONS.agent });
      events = [];
      const dirty = outDeps(happy, { state: crewState(STUDIO), refuse: { 'robot.moveTo': new Error('its worktree is dirty') } });
      await bringCrewBack(dirty.deps);
      expect(failed()?.say).toBe('Try again once what they name is fixed');
    });

    it('a robot of theirs already where the move goes is not moved again, as on a retry', async () => {
      const { deps, called } = outDeps(happy, { state: { ...crewState(), robots: { crew: { id: 'crew', name: 'crew', islandId: 'home', machine: STUDIO } } } });
      await moveHomeOut('studio', deps);
      expect(called.some((c) => c.method === 'robot.moveTo')).toBe(false);
    });

    it('crew-back with all of them home says so and moves nothing', async () => {
      const { deps, called } = outDeps(happy, { state: crewState() });
      expect((await bringCrewBack(deps)).result).toBe('ready');
      expect(ran()).toContain('crew:skip');
      expect(called.some((c) => c.method === 'robot.moveTo')).toBe(false);
    });
  });

  it('the archive says what the freeze found of the phone, and that this machine dials its new home', async () => {
    let staged: string | undefined;
    const { deps } = outDeps((line, input) => { if (line.includes('--stage')) staged = input; return happy(line); }, { phone: { serving: true, logins: ['ada@tailnet'] } });
    await moveHomeOut('studio', deps);
    // the sheet waits on the new home's phone link by this step, which a freeze that found it off leaves out
    expect(ran()).toEqual(['check:ok', 'mission:skip', 'pause:ok', 'phone:ok', 'copy:ok', 'mark:ok', 'adopt:ok', 'join:ok', 'probe:ok']);
    const dir = fs.mkdtempSync(path.join(home, 'tar-'));
    fs.writeFileSync(path.join(dir, 'in.tar'), Buffer.from(staged!, 'base64'));
    execFileSync('tar', ['-x', '-f', 'in.tar', 'home-move.json'], { cwd: dir });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'home-move.json'), 'utf8')) as HomeManifest;
    expect(manifest.phone).toEqual({ serving: true, logins: ['ada@tailnet'] });
    expect(manifest.record.dial).toBe('worker');
    expect(manifest.record.ssh).toBeUndefined();
  });

  it('a connection that goes during the far adopt asks the far side how it stands, and goes on from its word', async () => {
    let adopts = 0;
    let asked = '';
    const { deps } = outDeps((line) => {
      if (line.includes('--stage')) return answer({ status: 'pending', phase: 'staged' });
      if (line.includes("'adopt'")) return ++adopts === 1 ? { code: 255, stdout: '' } : happy(line);
      if (line.includes("'status'")) { asked = line; return answer({ status: 'adopted', enrol: ENROL as never }); }
      return happy(line);
    });
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('ready');
    expect(adopts).toBe(1);
    expect(asked).toContain(`'--asker' '${machineId()}' '--fleet' '${FLEET}'`);
  }, 20_000);

  it('asks again while the far side says its adopt still runs, and goes on from the word that ends it', async () => {
    let statuses = 0;
    const { deps } = outDeps((line) => {
      if (line.includes('--stage')) return answer({ status: 'pending', phase: 'staged' });
      if (line.includes("'adopt'")) return { code: 255, stdout: '' };
      if (line.includes("'status'")) return answer(++statuses === 1 ? { status: 'pending', phase: 'running', detail: 'another step of this move runs there' } : { status: 'adopted', enrol: ENROL as never });
      return happy(line);
    });
    const out = await moveHomeOut('studio', deps);
    expect(out.result).toBe('ready');
    expect(statuses).toBe(2);
  }, 20_000);

  it('the mark says how this home asks the machine it went to: its ssh, its install, and the folder its fleet answered from', async () => {
    const { deps, called } = outDeps(happy);
    expect((await moveHomeOut('studio', deps)).result).toBe('ready');
    const mark = called.find((c) => c.params.op === 'mark')?.params.marker;
    expect(mark?.ask).toEqual({ ssh: STUDIO_RECORD.ssh, svallBase: STUDIO_RECORD.svallBase, fleetHome: FAR_INFO(STUDIO).fleetHome });
  });

  describe('a fleet named apart from its name on the far machine', () => {
    // `work` here, and `studio2` on studio as workers.json holds it
    const apart = () => {
      const lines: string[] = [];
      let staged: string | undefined;
      const out = outDeps((line, input) => { if (line.includes('--stage')) staged = input; return happy(line); });
      out.deps.target = { name: 'work', home, managed: true };
      fs.writeFileSync(resolvePaths(home).workersFile, JSON.stringify({ [STUDIO]: { token: 't'.repeat(48), addedAt: 1, profile: 'studio2' } }));
      const open = out.deps.openMaster;
      out.deps.openMaster = async (destination) => {
        const m = await open(destination);
        return { ...m, run: (argv: string[], o?: never) => { lines.push(argv.join(' ')); return m.run(argv, o); } } as unknown as SshMaster;
      };
      return { ...out, lines, staged: () => staged };
    };

    it('reaches the fleet there by the profile workers.json holds for it', async () => {
      const { deps, lines } = apart();
      expect((await moveHomeOut('studio', deps)).result).toBe('ready');
      expect(lines.filter((l) => l.includes('connection-info'))).toEqual([expect.stringMatching(/ -p 'studio2'$/)]);
    });

    it('the archive names the profile the fleet has here, which the new home reaches this machine by', async () => {
      const { deps, staged } = apart();
      await moveHomeOut('studio', deps);
      const dir = fs.mkdtempSync(path.join(home, 'tar-'));
      fs.writeFileSync(path.join(dir, 'in.tar'), Buffer.from(staged()!, 'base64'));
      execFileSync('tar', ['-x', '-f', 'in.tar', 'home-move.json'], { cwd: dir });
      expect((JSON.parse(fs.readFileSync(path.join(dir, 'home-move.json'), 'utf8')) as HomeManifest).fromProfile).toBe('work');
    });
  });

  it.each([
    ['move.paused', 'pause:ok', false],
    ['move.copied', 'copy:ok', true],
  ] as const)('a driver killed at %s leaves no mark, calls nothing off and thaws nothing itself, which its daemon does when it goes', async (point, last, staged) => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return happy(line); });
    crashAt(point);
    await expect(moveHomeOut('studio', deps)).rejects.toThrow(HomeCrash);
    expect(ran().at(-1)).toBe(last);
    expect(called.some((c) => c.method === 'fleet.thaw' || c.params.op === 'mark')).toBe(false);
    expect(lines.some((l) => l.includes('--stage'))).toBe(staged);
    expect(lines.some((l) => /'fleet' 'abort'|--home-ssh/.test(l))).toBe(false);
  });

  it('a driver killed past the join leaves this machine to go on as a worker, with no probe', async () => {
    const { deps, called, started } = outDeps(happy);
    crashAt('move.joined');
    await expect(moveHomeOut('studio', deps)).rejects.toThrow(HomeCrash);
    expect(ran().at(-1)).toBe('join:ok');
    expect(called.some((c) => c.params.op === 'join')).toBe(true);
    expect(started()).toBe(1);
  });

  it('a driver killed right after the mark leaves the marker, and the far machine holding its archive', async () => {
    const lines: string[] = [];
    const { deps, called } = outDeps((line) => { lines.push(line); return happy(line); });
    // the driver's mark is its daemon's to write, which this daemon is not
    const client = await deps.client();
    deps.client = () => Promise.resolve({ ...client, call: (m: never, p: never) => {
      const params = p as Called['params'];
      if (params.op === 'mark') putMarker(resolvePaths(home), params.marker!);
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

  it('names the fleet as this machine runs it, for a worker named apart', () => {
    expect(enrolmentFor(paths('/home/ada/.svall'), STUDIO, { home: STUDIO_RECORD as never, profile: 'private' })('t'.repeat(48), m).worker.homeProfile).toBe('private');
    expect(enrolmentFor(paths('/home/ada/.svall'), STUDIO, { home: STUDIO_RECORD as never })('t'.repeat(48), m).worker.homeProfile).toBeUndefined();
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
    id: 'hm_abcdefghij' as HomeMoveId, fleetId: FLEET as never, from: machineId(), fromName: 'mac', fromHome: '/Users/ada' as never, to: STUDIO, toName: 'studio', toHome: '/home/ada' as never, at: 5, keySha256: markKey(resolvePaths(home), 'hm_abcdefghij'),
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
    const inputs: (string | undefined)[] = [];
    const { deps, started } = outDeps((line, input) => { lines.push(line); inputs.push(input); return answer({ status: 'adopted', enrol: ENROL as never }); });
    putMarker(resolvePaths(home), marker());
    mintAdoptKey(resolvePaths(home), 'hm_abcdefghij');
    const out = await resumeHome(deps);
    expect(out.result).toBe('ready');
    expect(ran()).toEqual(['adopt:ok', 'join:ok', 'probe:ok']);
    expect(lines.filter((l) => /'fleet' 'adopt' 'hm_abcdefghij' '--home-ssh' 'ada@studio'/.test(l))).toHaveLength(1);
    // the key its driver's journal holds, on stdin
    expect(inputs).toEqual([driverAdoptKey(resolvePaths(home), 'hm_abcdefghij')]);
    expect(inputs[0]).toBeTruthy();
    expect(started()).toBe(1);
  });

  it('a connection that goes during the far adopt asks the far side how it stands, saying which home asks', async () => {
    let asked = '';
    const { deps } = outDeps((line) => {
      if (line.includes("'adopt'")) return { code: 255, stdout: '' };
      if (line.includes("'status'")) asked = line;
      return answer({ status: 'adopted', enrol: ENROL as never });
    });
    putMarker(resolvePaths(home), marker());
    mintAdoptKey(resolvePaths(home), 'hm_abcdefghij');
    expect((await resumeHome(deps)).result).toBe('ready');
    expect(asked).toContain(`'fleet' 'status' 'hm_abcdefghij' '--asker' '${machineId()}' '--fleet' '${FLEET}'`);
  }, 20_000);

  it('a journal that holds no key sends the far machine nothing to install with, and leaves the abort', async () => {
    const lines: string[] = [];
    const { deps, started } = outDeps((line) => { lines.push(line); return answer({ status: 'adopted', enrol: ENROL as never }); });
    putMarker(resolvePaths(home), marker());
    const out = await resumeHome(deps);
    expect(failed()).toMatchObject({ step: 'adopt', detail: expect.stringContaining('holds no key') });
    expect(out.actions).toEqual(['svall fleet home abort']);
    expect(lines.filter((l) => l.includes('--home-ssh'))).toEqual([]);
    expect(started()).toBe(0);
    expect(readMarker(resolvePaths(home))?.id).toBe('hm_abcdefghij');
  });

  it('a home with no route waits to be told', async () => {
    const { deps } = outDeps(() => answer({ status: 'done' }));
    putMarker(resolvePaths(home), marker(false));
    const out = await resumeHome(deps);
    expect(out.actions).toEqual(['svall fleet home retry on studio']);
  });

  it('a far machine that does not answer leaves this home frozen, saying so', async () => {
    const { deps } = outDeps(() => answer({ status: 'done' }));
    deps.openMaster = () => Promise.reject(new Error('ssh: connect to host studio'));
    putMarker(resolvePaths(home), marker());
    const out = await resumeHome(deps);
    expect(out.actions).toEqual(['svall fleet home retry once it answers; until then this home stays frozen']);
    expect(failed()).toMatchObject({ detail: 'this machine cannot log in to studio: ssh: connect to host studio', say: 'Finish the move once it answers; until then this home takes no changes' });
    expect(readMarker(resolvePaths(home))?.id).toBe('hm_abcdefghij');
  });
});

describe('fleet home set local', () => {
  // this machine a worker of studio by a real move out, its registry naming it, and studio answering over a master
  async function workerHere(marked: () => boolean = () => true, farHolds: Parameters<typeof daemon>[0] = {}, localHolds: Parameters<typeof daemon>[0] = {}) {
    const w = await movedOut();
    const registry = MachineRegistry.load();
    registry.put(STUDIO, STUDIO_RECORD as never);
    registry.save();
    const far = daemon(farHolds);
    const order: string[] = [];
    const farClient = {
      call: (m: never, p: Called['params']) => { order.push(`${String(m)}${p.op ? `:${p.op}` : ''}${p.op === 'mark' && readOwed(w.mac.paths) ? ' owed' : ''}`); return far.client.call(m, p as never); },
      close: () => {},
    } as unknown as Client;
    const settled: string[] = [];
    const master = {
      run: async (argv: string[], o?: { input?: string }) => {
        const line = argv.join(' ');
        const ok = (out: unknown) => ({ code: 0, signal: null, stderr: '', stdout: JSON.stringify(out) });
        if (line.includes("'export'")) {
          const manifest = JSON.parse(o!.input!) as HomeManifest;
          const { sha256, bytes } = await packFleet(w.studio.paths, { ...manifest, to: MAC });
          return ok({ sha256, archive: bytes.toString('base64') });
        }
        if (line.includes("'settle'")) { settled.push(line.includes('not-adopted') ? 'not-adopted' : 'adopted'); return ok({ status: 'done' }); }
        if (line.includes("'version'")) return ok({ machineId: STUDIO, role: 'home', fleetId: FLEET, release: '1', protocol: PROTOCOL_VERSION, stateSchema: 1 });
        if (line.includes("'facts'")) return ok({ machineId: STUDIO, fleetId: FLEET, release: '1', protocol: PROTOCOL_VERSION, stateSchema: 1, clock: 1, fleetHome: '/home/ada/.svall', tailscale: {}, ...(marked() && { moving: readOwed(w.mac.paths)?.id }) });
        throw new Error(`unexpected ${line}`);
      },
      close: () => Promise.resolve(),
    } as unknown as SshMaster;
    const local = daemon({ state: { robots: {}, islands: {}, machines: { [STUDIO]: { name: 'studio', reachable: true, since: 1 } } }, ...localHolds });
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

  it('says of a rewritten path that this machine does not have it, and goes on', async () => {
    const { w, deps, master } = await workerHere(undefined, {}, { rewrites: [{ key: 'defaultCwd', to: '~/code', lacks: true }] });
    const stop = telling(w, master);
    await moveHomeBack(deps);
    stop();
    expect(events.find((e) => e.step === 'check' && e.status === 'ok')?.detail).toBe('2 robots stay on studio, 1 here; defaultCwd becomes ~/code, which this machine does not have yet');
  }, 30_000);

  it('a check that refuses freezes nothing there and owes nothing, as no mark was ever sent', async () => {
    const { w, deps, far } = await workerHere(undefined, {}, { checkRefused: true });
    expect((await moveHomeBack(deps)).result).toBe('actions');
    expect(failed()?.step).toBe('check');
    expect(far.called).toEqual([]);
    expect(readOwed(w.mac.paths)).toBeUndefined();
  });

  it('an export an ssh answer cut short stops at the copy, in words', async () => {
    const { deps, master } = await workerHere();
    const run = master.run.bind(master);
    master.run = ((argv: string[], o?: never) => (argv.join(' ').includes("'export'") ? Promise.resolve({ code: 0, signal: null, stderr: '', stdout: '{"sha256":"ab","archive":"Zm9v' }) : run(argv, o))) as never;
    expect((await moveHomeBack(deps)).result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'copy', detail: expect.stringContaining('did not answer a whole archive') });
  }, 30_000);

  it('a named fleet\'s probe that never sees studio link names its doctor by -p', async () => {
    const { w, deps, master } = await workerHere(() => true, {}, { state: { robots: {}, islands: {}, machines: { [STUDIO]: { name: 'studio', reachable: false, since: 1 } } } as never });
    const stop = telling(w, master);
    const clock = Date.now;
    let now = clock();
    try {
      const out = moveHomeBack({ ...deps, target: { ...deps.target, name: 'work', managed: true } });
      await vi.waitFor(() => expect(events.some((e) => e.step === 'probe')).toBe(true), { timeout: 20_000 });
      Date.now = () => (now += 30_000);
      await out;
    } finally { Date.now = clock; stop(); }
    expect(events.find((e) => e.step === 'probe' && e.status === 'warn')).toMatchObject({ action: 'svall -p work host doctor studio' });
  }, 30_000);

  it('names the phone step when studio\'s freeze found its phone link served', async () => {
    const { w, deps, master } = await workerHere(() => true, { phone: { serving: true, logins: [] } });
    const stop = telling(w, master);
    await moveHomeBack(deps);
    stop();
    expect(ran()).toEqual(['check:ok', 'mission:skip', 'pause:ok', 'phone:ok', 'copy:ok', 'mark:ok', 'adopt:ok', 'join:ok', 'probe:ok']);
  }, 30_000);

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

  it('the manifest it sends the old home holds only the install key\'s hash, and this machine installs from its driver\'s journal', async () => {
    const { w, deps, master } = await workerHere();
    const run = master.run.bind(master);
    const lines: string[] = [];
    let manifest!: HomeManifest;
    master.run = ((argv: string[], o?: { input?: string }) => {
      lines.push(argv.join(' '));
      if (argv.join(' ').includes("'export'")) manifest = JSON.parse(o!.input!) as HomeManifest;
      return run(argv, o as never);
    }) as never;
    const stop = telling(w, master);
    expect((await moveHomeBack(deps)).result).toBe('ready');
    stop();
    // who the phone lets in stays off an argv every account there can read
    expect(lines.find((l) => l.includes("'export'"))).toMatch(/'export' 'hm_[0-9a-z]{10}'$/);
    const id = manifest.id;
    const key = driverAdoptKey(w.mac.paths, id)!;
    expect(manifest.adoptKeySha256).toBe(crypto.createHash('sha256').update(key).digest('hex'));
    expect(lines.filter((l) => l.includes(key))).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(key);
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

  it('an abort and a delivery while the mark is on its way: the outcome is owed again once it lands, and the old home hears', async () => {
    const { w, deps, far, settled, master } = await workerHere();
    const open = () => Promise.resolve(master);
    let lost: string | undefined;
    deps.farClient = () => Promise.resolve({
      call: async (m: never, p: Called['params']) => {
        if (p.op === 'mark') {
          const { id } = p.marker!;
          expect((await abortAdopt({ paths: w.mac.paths, me: MAC, daemon: w.mac.daemon }, id, { machine: STUDIO, fleetId: FLEET })).status).toBe('not-adopted');
          expect(await deliverOwed(w.mac.paths, open)).toBe('told');
          lost = id;
          expect(readOwed(w.mac.paths)).toBeUndefined();
        }
        return far.client.call(m, p as never);
      },
      close: () => {},
    } as unknown as Client);
    await moveHomeBack(deps);
    expect(failed()?.step).toBe('adopt');
    expect(readOwed(w.mac.paths)?.id).toBe(lost);
    expect(await deliverOwed(w.mac.paths, open)).toBe('told');
    expect(settled).toEqual(['not-adopted', 'not-adopted']);
    expect(w.mac.daemon.role).toBe('worker');
  }, 30_000);

  it('an abort and a delivery while the mark is on its way, the mark landing with its answer lost: the outcome is owed again, and the old home hears', async () => {
    const { w, deps, far, settled, master } = await workerHere();
    const open = () => Promise.resolve(master);
    let lost: string | undefined;
    deps.farClient = () => Promise.resolve({
      call: async (m: never, p: Called['params']) => {
        if (p.op !== 'mark') return far.client.call(m, p as never);
        const { id } = p.marker!;
        expect((await abortAdopt({ paths: w.mac.paths, me: MAC, daemon: w.mac.daemon }, id, { machine: STUDIO, fleetId: FLEET })).status).toBe('not-adopted');
        expect(await deliverOwed(w.mac.paths, open)).toBe('told');
        lost = id;
        await far.client.call(m, p as never);
        throw new Error('svalld closed the connection (1006)');
      },
      close: () => {},
    } as unknown as Client);
    await moveHomeBack(deps);
    expect(failed()?.step).toBe('mark');
    expect(readOwed(w.mac.paths)?.id).toBe(lost);
    expect(await deliverOwed(w.mac.paths, open)).toBe('told');
    expect(settled).toEqual(['not-adopted', 'not-adopted']);
    expect(w.mac.daemon.role).toBe('worker');
  }, 30_000);

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
    // nor does a person's word here, whose old home thawed with its driver gone
    await expect(installAdopt({ paths: w.mac.paths, me: MAC, daemon: w.mac.daemon }, id, undefined, () => { throw new Error('built'); })).rejects.toThrow(/only the driver/);
    expect(w.mac.daemon.role).toBe('worker');
    const stop = telling(w, master);
    const out = await resumeHome(deps);
    stop();
    expect(out.result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'check', detail: 'studio is not frozen for this move and goes on as the home' });
    expect(w.mac.daemon.role).toBe('worker');
    expect(fs.existsSync(w.mac.paths.workerFile)).toBe(true);
    expect(journalLines(w.mac.paths, id).at(-1)?.phase).toBe('aborted');
    expect(readOwed(w.mac.paths)).toBeUndefined();
    // never marked, so there is no marker there to end
    expect(settled).toEqual([]);
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
    expect(settled).toEqual([]);
  }, 30_000);

  it('a driver killed before its archive came: abort refuses the move for good, as the old home holds no mark to tell', async () => {
    const { w, deps, settled, master } = await workerHere();
    crashAt('deliver.owed');
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    const id = readOwed(w.mac.paths)!.id;
    const stop = telling(w, master);
    expect(await abortBack(deps)).toEqual({ status: 'not-adopted', told: true });
    stop();
    expect(journalLines(w.mac.paths, id).map((l) => l.phase)).toEqual(['aborted']);
    expect(settled).toEqual([]);
  }, 30_000);

  it('an export that fails refuses the move here for good, and what comes late is refused', async () => {
    const { w, deps, master } = await workerHere();
    const run = master.run.bind(master);
    master.run = ((argv: string[], o?: never) => (argv.join(' ').includes("'export'") ? Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'svall: no room' }) : run(argv, o))) as never;
    await moveHomeBack(deps);
    expect(failed()?.step).toBe('copy');
    expect(journalLines(w.mac.paths, readOwed(w.mac.paths)!.id).map((l) => l.phase)).toEqual(['aborted']);
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

  it('a retry finding another machine or fleet at the old home\'s ssh calls nothing off, and this machine takes nothing', async () => {
    const { w, deps, master } = await workerHere();
    crashAt('move.marked');
    await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
    const id = readOwed(w.mac.paths)!.id;
    const run = master.run.bind(master);
    master.run = ((argv: string[], o?: never) => {
      if (!argv.join(' ').includes("'facts'")) return run(argv, o);
      return Promise.resolve({ code: 0, signal: null, stderr: '', stdout: JSON.stringify({ machineId: MAC, fleetId: FLEET, release: '1', protocol: PROTOCOL_VERSION, stateSchema: 1, clock: 1, fleetHome: '/x/.svall', tailscale: {} }) });
    }) as never;
    events = [];
    expect((await resumeHome(deps)).result).toBe('actions');
    expect(failed()).toMatchObject({ step: 'check', detail: expect.stringContaining('another machine or fleet') });
    expect(journalLines(w.mac.paths, id).at(-1)?.phase).toBe('staged');
    expect(readOwed(w.mac.paths)?.id).toBe(id);
    expect(w.mac.daemon.role).toBe('worker');
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
    expect(await installAdopt({ paths: w.mac.paths, me: MAC, daemon: w.mac.daemon }, id, ADOPT_KEY, () => { throw new Error('built'); })).toMatchObject({ status: 'not-adopted' });
    expect(w.mac.daemon.role).toBe('worker');
  }, 30_000);

  it('the archive names the profile the fleet has on the old home, which it is reached by once a worker', async () => {
    const { w, deps, master } = await workerHere();
    fs.writeFileSync(w.mac.paths.workerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(w.mac.paths.workerFile, 'utf8')), homeProfile: 'private' }));
    const run = master.run.bind(master);
    let manifest: HomeManifest | undefined;
    master.run = ((argv: string[], o?: { input?: string }) => { if (argv.join(' ').includes("'export'")) manifest = JSON.parse(o!.input!) as HomeManifest; return run(argv, o as never); }) as never;
    const stop = telling(w, master);
    await moveHomeBack(deps);
    stop();
    expect(manifest?.fromProfile).toBe('private');
    expect(JSON.parse(fs.readFileSync(w.mac.paths.workersFile, 'utf8'))[STUDIO].profile).toBe('private');
  }, 30_000);

  it('the old home is told the profile the fleet has here, which it reaches its new home by', async () => {
    const { w, deps, master } = await workerHere();
    deps.target = { ...deps.target, name: 'work', managed: true };
    const run = master.run.bind(master);
    let told: { enrol?: { worker: { homeProfile?: string } } } | undefined;
    master.run = ((argv: string[], o?: { input?: string }) => { if (argv.join(' ').includes("'settle'")) told = JSON.parse(o!.input!); return run(argv, o as never); }) as never;
    const stop = telling(w, master);
    expect((await moveHomeBack(deps)).result).toBe('ready');
    stop();
    expect(told?.enrol?.worker.homeProfile).toBe('work');
  }, 30_000);

  it('the old home\'s marker has no route to ask: this machine tells it', async () => {
    const { w, deps, far, master } = await workerHere();
    const stop = telling(w, master);
    await moveHomeBack(deps);
    stop();
    const mark = far.called.find((c) => c.params.op === 'mark');
    expect(mark?.params.marker).toBeDefined();
    expect((mark?.params.marker as HomeMoving).ask).toBeUndefined();
  }, 30_000);

  it('a stop before the mark with mission control sent ahead says so, with the way back for it', async () => {
    const away = { robots: { crew: { id: 'crew', name: 'crew', islandId: 'home', machine: MAC, sentAhead: 'hm_abcdefghij' } }, islands: { home: { id: 'home', kind: 'home' } }, machines: {} };
    const { deps } = await workerHere(() => true, { state: away, refuse: { 'fleet.freeze': new ApiError('busy', 'a worker is still catching up') } });
    const out = await moveHomeBack(deps);
    expect(failed()?.step).toBe('pause');
    expect(out.actions).toContain('svall fleet home crew-back');
  }, 30_000);

  it('crew-back from a worker asks the home, and moves them to the machine the home says it is', async () => {
    const away = { robots: { crew: { id: 'crew', name: 'crew', islandId: 'home', machine: MAC, sentAhead: 'hm_abcdefghij' } }, islands: { home: { id: 'home', kind: 'home' } }, machines: {} };
    const { deps, far } = await workerHere(() => true, { state: away });
    const out = await bringCrewBack(deps);
    expect(out.result).toBe('ready');
    const moved = far.called.find((c) => c.method === 'robot.moveTo');
    expect(moved?.params).toMatchObject({ id: 'crew', machine: machineId() });
  }, 30_000);

  it('an abort or a retry with this daemon down starts it, as the outcome goes out from it', async () => {
    for (const run of [(d: MoveDeps) => abortBack(d), (d: MoveDeps) => resumeHome(d)]) {
      const { w, deps, master } = await workerHere();
      crashAt('move.marked');
      await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
      disarmCrash();
      await abortAdopt({ paths: w.mac.paths, me: MAC, daemon: w.mac.daemon }, readOwed(w.mac.paths)!.id);
      w.mac.daemon.kill();
      const up = deps.client;
      deps.client = () => (w.mac.daemon.role ? up() : Promise.reject(new Error('svalld is not running')));
      const stop = telling(w, master);
      await run(deps);
      stop();
      expect(w.mac.daemon.role).toBe('worker');
      cleanHomes();
    }
  }, 60_000);

  it('abort with nothing owed here leaves it to the daemon', async () => {
    const { deps } = await workerHere();
    expect(await abortBack(deps)).toBeUndefined();
  });

  it('a mission robot that does not move says to run the way back again, a command that runs', async () => {
    const crew = { robots: { crew: { id: 'crew', name: 'crew', islandId: 'home' } }, islands: { home: { id: 'home', kind: 'home' } }, machines: {} };
    const { deps } = await workerHere(() => true, { state: crew, refuse: { 'robot.moveTo': new Error('its worktree is dirty') } });
    await moveHomeBack(deps);
    expect(failed()).toMatchObject({ step: 'mission', action: 'fix it, and svall fleet home set local again; svall fleet home crew-back brings back the crew that moved' });
    expect(failed()?.say).toBeDefined();
  });

  describe('fleet home abort', () => {
    it('a move this machine owes: one step says it is off, and the old home told', async () => {
      const { w, deps, master } = await workerHere();
      crashAt('move.marked');
      await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
      events = [];
      const stop = telling(w, master);
      const out = await abortHome(deps);
      stop();
      expect(out.result).toBe('ready');
      expect(events.filter((e) => e.status !== 'start')).toEqual([{ step: 'abort', status: 'ok', detail: 'the move is off, and studio takes writes again' }]);
    }, 30_000);

    it('another step of the move under way here: says so at once, as it stands', async () => {
      const { w, deps } = await workerHere();
      crashAt('move.marked');
      await expect(moveHomeBack(deps)).rejects.toThrow(HomeCrash);
      events = [];
      const unlock = (await homeMoveLock(w.mac.paths.home))!;
      const at = Date.now();
      const out = await abortHome(deps);
      unlock();
      expect(Date.now() - at).toBeLessThan(10_000);
      expect(out.result).toBe('actions');
      expect(failed()).toMatchObject({ step: 'abort', detail: 'the move is still under way here: another step of this move runs there' });
      expect(readOwed(w.mac.paths)).toBeDefined();
    }, 30_000);

    it('no move standing here says so and calls nothing off, a driver running included', async () => {
      const { deps, called } = outDeps(() => answer({ status: 'done' }));
      expect((await abortHome(deps)).result).toBe('actions');
      expect(failed()).toMatchObject({ step: 'abort', detail: 'no move of the fleet waits on this machine', action: 'one still running stops with the command or sheet that runs it' });
      expect(called.filter((c) => c.method === 'fleet.homeMove').map((c) => c.params.op)).toEqual(['status']);
    });

    it('nothing owed: the daemon calls it off, or names the machine that holds it', async () => {
      const none = () => answer({ status: 'done' });
      const off = outDeps(none, { abort: {} });
      expect((await abortHome(off.deps)).result).toBe('ready');
      expect(events.at(-1)).toMatchObject({ step: 'abort', status: 'ok', detail: 'the move is off, and this home takes writes again' });
      events = [];
      const told = outDeps(none, { abort: { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: false } } });
      await abortHome(told.deps);
      expect(failed()).toMatchObject({ step: 'abort', detail: 'studio holds this move, and tells this machine how it ended', action: 'svall fleet home abort on studio', say: 'Call it off on studio' });
      events = [];
      const held = outDeps(none, { abort: { moving: { id: 'hm_abcdefghij', to: STUDIO, name: 'studio', asks: true, answer: 'staged', phase: 'staged' } } });
      await abortHome(held.deps);
      expect(failed()).toMatchObject({ step: 'abort', detail: 'studio has not let go of it: staged' });
    });
  });
});

describe('how a home move ends in a terminal', () => {
  it('one that went through with something left to do exits 0, saying both; one that stopped exits 1', () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    const was = process.exitCode;
    process.exitCode = undefined;
    try {
      finishFlow({ result: 'actions', actions: ['svall host doctor studio'] }, false, 'The fleet runs on this machine.');
      expect(process.exitCode).toBeUndefined();
      expect(out.join('')).toBe('The fleet runs on this machine.\nsvall host doctor studio\n');
      finishFlow({ result: 'actions', actions: ['svall fleet home retry'], stopped: 'adopt' }, false, 'The fleet runs on this machine.');
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = was;
    }
  });
});
