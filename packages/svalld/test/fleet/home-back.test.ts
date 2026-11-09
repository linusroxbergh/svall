import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState, WorkerFile, type Enrolment, type HomeManifest, type HomeMoveId, type HomeMoving, type MachineId } from '@svall/protocol';
import { readFleetConfig } from '../../src/config.js';
import { HomeCrash, type HomeFailpoint } from '../../src/failpoints.js';
import { deliverOwed, markedThere, startDeliveries } from '../../src/fleet/home-far.js';
import { homeCheck, homeFacts, HomeFreeze } from '../../src/fleet/home-freeze.js';
import { abortAdopt, addEnrol, adoptDir, adoptStatus, createMarker, driverKey, enter, installAdopt, journalLines, landed, markKey, moveInFlight, moveOutcome, oldHomeName, owe, packFleet, phoneOwed, readMarker, readOwed, settleMove, stageAdopt, TOLD_UNMARKED, writeEnrol } from '../../src/fleet/home-move.js';
import { silentLogger } from '../../src/log.js';
import { putRecord } from '../../src/machine.js';
import { readConsent, setConsent } from '../../src/placement/mirror-consent.js';
import { dropToken, issueToken } from '../../src/placement/workers.js';
import { isWorker, readWorkerFile } from '../../src/worker/mode.js';
import { cleanHomes } from '../helpers.js';
import { ADOPT_KEY, ADOPT_SHA, crashAt, crashesFired, disarmCrash, FLEET, ID, MAC, marker, movedOut, phoneAt, POINTS_OF, stateOf, STUDIO, world, type Side, putMarker } from './home-world.js';

afterEach(() => { disarmCrash(); vi.useRealTimers(); cleanHomes(); });
afterAll(() => { expect(POINTS_OF.back.filter((p) => !crashesFired().has(p))).toEqual([]); });

const BACK = 'hm_backbackba' as HomeMoveId;
const FAR = { id: BACK, ssh: 'ada@studio' as never, svallBase: '/home/ada/.local/share/svall' as never, fleetHome: '/home/ada/.svall' as never, from: STUDIO, fleetId: FLEET as never };
const BACK_MANIFEST: HomeManifest = { id: BACK, fleetId: FLEET as never, from: STUDIO, to: MAC, toName: 'mac', toHome: '/Users/ada' as never, record: { name: 'studio', ssh: 'ada@studio', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' } as never, phone: { serving: false, logins: [] }, adoptKeySha256: ADOPT_SHA };
const backMark = (keySha256: string): HomeMoving => ({ id: BACK, fleetId: FLEET as never, from: STUDIO, fromName: 'studio', fromHome: '/home/ada' as never, to: MAC, toName: 'mac', toHome: '/Users/ada' as never, at: 6, keySha256 });

/**
 * The fleet moved out to studio and back from it as far as studio's mark: studio's daemon frozen under a marker with no way to ask, the
 * outcome owed by the Mac, and the archive staged there.
 */
async function markedBack(before?: (w: Awaited<ReturnType<typeof movedOut>>) => void | Promise<void>, beforeOut?: Parameters<typeof movedOut>[0]) {
  const w = await movedOut(beforeOut);
  await before?.(w);

  // as studio holds it at its freeze, with what it took of its worker's robots
  await w.studio.daemon.stop();
  const packed = await packFleet(w.studio.paths, BACK_MANIFEST);
  await w.studio.daemon.start();
  await stageAdopt(w.mac.deps, BACK, packed.sha256, packed.bytes);
  owe(w.mac.paths, FAR);
  const mark = backMark(markKey(w.mac.paths, BACK));
  await w.studio.daemon.stop();
  putMarker(w.studio.paths, mark);
  await w.studio.daemon.start();
  expect(w.studio.daemon.role).toBe('frozen');
  const enrolment = (token: string, m: HomeManifest): Enrolment => ({ worker: WorkerFile.parse({ homeMachineId: MAC, fleetId: m.fleetId, token, homeName: 'mac' }) });
  return { ...w, enrolment };
}

const NOT_RUNNING = 'svalld is not running (no port): it runs while Svall is open on this fleet';
const ASKER_BACK = { machine: STUDIO, fleetId: FLEET };
const STUDIO_FACTS = { machineId: STUDIO, fleetId: FLEET, release: 'r', protocol: 1, stateSchema: 1, clock: 1, fleetHome: '/home/ada/.svall', tailscale: {} };
const STUDIO_VERSION = { release: 'r', signed: false, machineId: STUDIO, protocol: 1, stateSchema: 1, runtime: { node: 'v24', platform: 'linux', arch: 'x64' }, role: 'home', fleetId: FLEET };
// as `svall version --json` reads studio's own files: a worker names the fleet it serves
const versionOf = (s: Side) => ({ ...STUDIO_VERSION, ...(isWorker(s.paths) ? { role: 'worker', fleetId: undefined, worker: { homeMachineId: MAC, homeName: 'mac', fleetId: readWorkerFile(s.paths).fleetId } } : { fleetId: readFleetConfig(s.paths).id }) });

/** Studio's daemon as its freeze holds what stands there, with nothing behind its links or phone. */
const studioFreeze = (s: Side, frozen = readMarker(s.paths)): HomeFreeze => new HomeFreeze({
  paths: s.paths, me: STUDIO, log: silentLogger, store: { state: emptyState(), flush: () => Promise.resolve(true) },
  links: { barrier: () => Promise.resolve(true), hold: () => {}, call: () => Promise.resolve({}) as never },
  background: { pause: () => {}, resume: () => {} },
  phone: { get: () => Promise.resolve(phoneAt(false)), set: (on) => Promise.resolve(phoneAt(on)) },
  ask: () => Promise.reject(new Error('studio asks no one')), restart: () => {},
}, frozen);

/** The old home's side of what a delivery runs there, on the real settle and its daemon's told, over a master that fails as told. `freeze`: that daemon's, where a test holds it. */
function studioAt(studio: Side, o: { down?: () => boolean; answersAs?: object; freeze?: HomeFreeze } = {}) {
  let delivered = 0;
  const sent: { argv: string; input: string }[] = [];
  const open = () => {
    if (o.down?.()) return Promise.reject(new Error('ssh: connect to host studio'));
    return Promise.resolve({
      run: async (argv: string[], opts?: { input?: string }) => {
        const line = argv.join(' ');
        sent.push({ argv: line, input: opts?.input ?? '' });
        if (line.includes("'version'")) return { code: 0, signal: null, stdout: JSON.stringify(o.answersAs ?? versionOf(studio)), stderr: '' };
        delivered++;
        const { key, enrol } = JSON.parse(opts!.input!) as { key: string; enrol?: Enrolment };
        const told = !line.includes('not-adopted') ? { status: 'adopted' as const, enrol: enrol! } : { status: 'not-adopted' as const };
        const said = await settleMove(studio.paths, BACK, told, key, {
          join: async (enrol) => { if (!studio.daemon.role) throw new Error(NOT_RUNNING); addEnrol(studio.paths, BACK, enrol); await studio.daemon.stop(); },
          thaw: async (key) => {
            if (!studio.daemon.role) throw new Error(NOT_RUNNING);
            await (o.freeze ?? studioFreeze(studio)).told(BACK, key);
            if (!o.freeze) await studio.daemon.start();
          },
          start: () => studio.daemon.start(),
        });
        return { code: 0, signal: null, stdout: JSON.stringify(said), stderr: '' };
      },
      close: () => Promise.resolve(),
    });
  };
  return { open: open as never, delivered: () => delivered, sent };
}

const keyOf = (w: { mac: Side }): string => driverKey(w.mac.paths, BACK)!;
const TOKEN_BACK = 'c'.repeat(48);
const roles = (w: { mac: Side; studio: Side }): unknown[] => [w.mac.daemon.role, w.studio.daemon.role];
const homes = (w: { mac: Side; studio: Side }) => roles(w).filter((r) => r === 'home');

describe('the way back: the outcome is owed before the old home is marked', () => {
  it('says nothing while the move can go either way, and studio stays frozen', async () => {
    const w = await markedBack();
    expect(oldHomeName(w.mac.paths, BACK)).toBe('studio');
    expect(moveOutcome(w.mac.paths, BACK)).toBeUndefined();
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('waiting');
    expect(w.studio.daemon.role).toBe('frozen');
    expect(moveInFlight(w.mac.paths)).toBe(BACK);
  });

  it('adopted: studio hears from this machine, joins on its next start, and only one daemon ever took writes', async () => {
    const w = await markedBack();
    const a = await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(roles(w)).toEqual(['home', 'frozen']);
    const far = studioAt(w.studio);
    expect(await deliverOwed(w.mac.paths, far.open)).toBe('told');
    // the old home's own word first, then the driver's key on stdin alone
    expect(far.sent[0]).toEqual({ argv: expect.stringMatching(/ --json 'version'$/), input: '' });
    expect(far.sent.slice(1).map((c) => [c.argv.includes(keyOf(w)), JSON.parse(c.input).key === keyOf(w)])).toEqual([[false, true]]);
    expect(roles(w)).toEqual(['home', 'worker']);
    expect(fs.existsSync(w.mac.paths.homeDeliver)).toBe(false);
    expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
    expect(JSON.parse(fs.readFileSync(w.studio.paths.workerFile, 'utf8')).homeMachineId).toBe(MAC);
    expect(w.mac.daemon.held!.robots.here.machine).toBeUndefined();
    expect(w.mac.daemon.held!.robots.placed.machine).toBe(STUDIO);
    expect(w.studio.daemon.held!.robots.placed.machine).toBe(STUDIO);
    expect(w.studio.daemon.held!.robots.here.machine).toBeUndefined();
  });

  it.each([
    ['another machine', { ...STUDIO_VERSION, machineId: MAC }],
    ['another fleet', { ...STUDIO_VERSION, fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' }],
    ['no fleet', { ...STUDIO_VERSION, fleetId: undefined }],
  ])('%s answering at the old home\'s ssh reads as no answer: its key does not go, the outcome stays owed, and it stays frozen', async (_who, answersAs) => {
    const w = await markedBack();
    await abortAdopt(w.mac.deps, BACK, ASKER_BACK);
    const far = studioAt(w.studio, { answersAs });
    await expect(deliverOwed(w.mac.paths, far.open)).rejects.toThrow(/another machine or fleet/);
    expect(far.sent.map((c) => c.input)).toEqual(['']);
    expect(far.delivered()).toBe(0);
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
    expect(w.studio.daemon.role).toBe('frozen');
  });

  it('an old home that cannot be reached leaves the outcome owed, and a later try tells it', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    let down = true;
    const far = studioAt(w.studio, { down: () => down });
    await expect(deliverOwed(w.mac.paths, far.open)).rejects.toThrow(/connect to host/);
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
    expect(roles(w)).toEqual(['home', 'frozen']);
    down = false;
    expect(await deliverOwed(w.mac.paths, far.open)).toBe('told');
    expect(roles(w)).toEqual(['home', 'worker']);
  });

  it('a settle that exits 0 and answers nothing readable leaves the outcome owed', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    const run = (argv: string[]) => Promise.resolve({ code: 0, signal: null, stderr: '', stdout: argv.join(' ').includes("'version'") ? JSON.stringify(STUDIO_VERSION) : 'a login banner' });
    await expect(deliverOwed(w.mac.paths, (() => Promise.resolve({ run, close: () => Promise.resolve() })) as never)).rejects.toThrow();
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
  });

  it('a settle that fails there leaves the outcome owed, whatever it printed', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    const open = () => Promise.resolve({ run: () => Promise.resolve({ code: 1, signal: null, stdout: JSON.stringify({ status: 'done' }), stderr: 'svall: it did not take' }), close: () => Promise.resolve() });
    await expect(deliverOwed(w.mac.paths, open as never)).rejects.toThrow(/it did not take/);
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
  });

  it('a daemon that runs tells what it comes to owe after it started, and keeps trying a machine that does not answer', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    fs.rmSync(w.mac.paths.homeDeliver);
    let down = true;
    const far = studioAt(w.studio, { down: () => down });
    const log: string[] = [];
    vi.useFakeTimers();
    const stop = startDeliveries(w.mac.paths, { error: (l) => log.push(l), info: (l) => log.push(l) }, far.open);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(log).toEqual([]);
    owe(w.mac.paths, FAR);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(log.some((l) => /connect to host/.test(l))).toBe(true);
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
    expect(w.studio.daemon.role).toBe('frozen');
    down = false;
    await vi.advanceTimersByTimeAsync(11_000);
    stop();
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(far.delivered()).toBe(1);
    expect(w.studio.daemon.role).toBe('worker');
  });

  it('an answer of no marker that comes back after the mark landed and the outcome was owed again leaves that debt, and the old home hears', async () => {
    const w = await markedBack();
    expect(await abortAdopt(w.mac.deps, BACK)).toEqual({ status: 'not-adopted' });
    const mark = fs.readFileSync(w.studio.paths.homeMoving);
    fs.rmSync(w.studio.paths.homeMoving);
    const far = studioAt(w.studio);
    const open = async () => {
      const master = await (far.open as () => Promise<{ run: (argv: string[], o?: { input?: string }) => Promise<{ stdout: string }>; close: () => Promise<void> }>)();
      return {
        ...master,
        run: async (argv: string[], o?: { input?: string }) => {
          const r = await master.run(argv, o);
          if (argv.join(' ').includes("'settle'")) {
            expect(JSON.parse(r.stdout)).toEqual({ status: 'done' });
            fs.writeFileSync(w.studio.paths.homeMoving, mark);
            owe(w.mac.paths, FAR);
          }
          return r;
        },
      };
    };
    expect(await deliverOwed(w.mac.paths, open as never)).toBe('waiting');
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
    expect(readMarker(w.studio.paths)?.id).toBe(BACK);
    expect(await deliverOwed(w.mac.paths, far.open)).toBe('told');
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(readMarker(w.studio.paths)).toBeUndefined();
  });

  it('a crash after it was told tells it again, and that changes nothing', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    const far = studioAt(w.studio);
    const fired = crashAt('deliver.told');
    await expect(deliverOwed(w.mac.paths, far.open)).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    expect(w.studio.daemon.role).toBe('worker');
    const once = fs.readFileSync(w.studio.paths.state, 'utf8');
    expect(await deliverOwed(w.mac.paths, far.open)).toBe('told');
    expect(fs.readFileSync(w.studio.paths.state, 'utf8')).toBe(once);
    expect(far.delivered()).toBe(2);
  });

  it('a crash writing what is owed holds the mark back: nothing is frozen with nothing owed', async () => {
    const w = await markedBack();
    fs.rmSync(w.mac.paths.homeDeliver);
    crashAt('deliver.owed');
    expect(() => owe(w.mac.paths, FAR)).toThrow(HomeCrash);
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
  });
});

describe('an abort and a delivery while the mark is on its way', () => {
  // studio frozen for the way back by its driver, not yet marked; the archive staged here, the outcome owed, and the move called off here
  const unmarked = async () => {
    const w = await movedOut();
    await w.studio.daemon.stop();
    const packed = await packFleet(w.studio.paths, BACK_MANIFEST);
    await w.studio.daemon.start();
    await stageAdopt(w.mac.deps, BACK, packed.sha256, packed.bytes);
    owe(w.mac.paths, FAR);
    const mark = backMark(markKey(w.mac.paths, BACK));
    const driver = {};
    const freeze = studioFreeze(w.studio, undefined);
    await freeze.freeze(BACK, MAC, driver);
    expect(await abortAdopt(w.mac.deps, BACK, ASKER_BACK)).toEqual({ status: 'not-adopted' });
    return { w, mark, driver, freeze };
  };
  const journalOf = (s: Side) => fs.readFileSync(path.join(s.paths.homeMoves, `${BACK}.ndjson`));

  it('studio\'s daemon told first refuses the mark that lands after, and a driver killed there leaves studio the home it was, owed nothing', async () => {
    const { w, mark, driver, freeze } = await unmarked();
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio, { freeze }).open)).toBe('told');
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(journalLines(w.studio.paths, BACK)).toEqual([expect.objectContaining({ phase: 'aborted', detail: TOLD_UNMARKED })]);
    const before = journalOf(w.studio);
    expect(() => freeze.mark(mark)).toThrow(/called off here before its mark/);
    expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
    expect(journalOf(w.studio)).toEqual(before);
    freeze.left(driver);
    await vi.waitFor(() => expect(freeze.active).toBe(false));
    expect(roles(w)).toEqual(['worker', 'home']);
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio, { freeze }).open)).toBe('nothing');
  });

  it('with studio\'s daemon down, the file holds the refusal, and the mark meets it', async () => {
    const { w, mark } = await unmarked();
    w.studio.daemon.kill();
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(journalLines(w.studio.paths, BACK)).toEqual([expect.objectContaining({ phase: 'aborted', detail: TOLD_UNMARKED })]);
    expect(() => createMarker(w.studio.paths, mark)).toThrow(/called off here before its mark/);
    expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
  });
});

const INSTALL: HomeFailpoint[] = ['adopt.stopped', 'adopt.installing', 'adopt.file', 'adopt.dropped', 'adopt.registry', 'adopt.installed', 'adopt.started'];

describe('a kill on this machine at each boundary of the way back, with studio frozen', () => {
  const killed = async (point: HomeFailpoint) => {
    const w = await markedBack();
    const fired = crashAt(point);
    await expect(installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    w.mac.daemon.kill();
    return w;
  };

  it.each(INSTALL)('%s: studio stays frozen, the outcome stays owed, and a retry finishes the move', async (point) => {
    const w = await killed(point);
    expect(w.studio.daemon.role).toBe('frozen');
    expect(readOwed(w.mac.paths)?.id).toBe(BACK);
    await w.mac.daemon.start();
    expect(homes(w).length).toBeLessThanOrEqual(1);
    expect(await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'adopted' });
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(roles(w)).toEqual(['home', 'worker']);
    expect(w.mac.daemon.held!.robots.here.machine).toBeUndefined();
    expect(w.mac.daemon.held!.robots.placed.machine).toBe(STUDIO);
  });

  it.each(INSTALL)('%s: called off, this machine is the worker it was, and studio thaws as the home', async (point) => {
    const w = await killed(point);
    w.mac.daemon.noAnswer = true;
    expect(await abortAdopt(w.mac.deps, BACK)).toEqual({ status: 'not-adopted' });
    w.mac.daemon.noAnswer = false;
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('worker');
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(roles(w)).toEqual(['worker', 'home']);
    expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
    expect(stateOf(w.mac).robots.here.machine).toBe(MAC);
    expect(await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
  });

  it('adopt.committed: the move has gone through, so a delivery says so and an abort cannot take it back', async () => {
    const w = await killed('adopt.committed');
    await w.mac.daemon.start();
    expect((await abortAdopt(w.mac.deps, BACK)).status).toBe('adopted');
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(roles(w)).toEqual(['home', 'worker']);
  });

  it('a driver killed right after the mark: nothing has changed here, and an abort thaws studio', async () => {
    const w = await markedBack();
    expect(w.mac.daemon.role).toBe('worker');
    expect(await abortAdopt(w.mac.deps, BACK)).toEqual({ status: 'not-adopted' });
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(roles(w)).toEqual(['worker', 'home']);
  });

  it.each(['enrol.written', 'join.kept', 'join.state', 'join.docs', 'join.worker', 'join.done'] as HomeFailpoint[])('%s: a kill in studio\'s own join goes forward from what it kept', async (point) => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    const far = studioAt(w.studio);
    const fired = crashAt(point);
    await expect(deliverOwed(w.mac.paths, far.open)).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    w.studio.daemon.kill();
    await w.studio.daemon.start();
    expect(await deliverOwed(w.mac.paths, far.open)).toBe('told');
    expect(roles(w)).toEqual(['home', 'worker']);
    expect(w.studio.daemon.held!.robots.placed.machine).toBe(STUDIO);
  });

  it('with studio\'s daemon down: an outcome written for its next start, with no marker left to meet its join', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    w.studio.daemon.kill();
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(roles(w)).toEqual(['home', 'worker']);
    expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
  });

  it('an outcome written for the next start finds no marker a start has joined past, so it writes none', async () => {
    const w = await markedBack();
    const a = await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    w.studio.daemon.kill();
    fs.rmSync(w.studio.paths.homeMoving);
    await writeEnrol(w.studio.paths, BACK, a.enrol, keyOf(w));
    expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
  });

  describe('the marker goes only on the word of the machine holding the fleet', () => {
    const NOTHING = { join: () => Promise.reject(new Error('joined')), thaw: () => Promise.reject(new Error('thawed')), start: () => Promise.reject(new Error('started')) };

    it('a daemon that answers and refuses the outcome leaves the marker, and the debt stays', async () => {
      const w = await markedBack();
      const refused = Object.assign(new Error('this move can be called off only where the fleet is going'), { code: 'frozen' });
      await expect(settleMove(w.studio.paths, BACK, { status: 'not-adopted' }, keyOf(w), { ...NOTHING, thaw: () => Promise.reject(refused) })).rejects.toThrow(/only where the fleet is going/);
      expect(readMarker(w.studio.paths)?.id).toBe(BACK);
    });

    it('a daemon that hangs or goes away mid-call is no refused connection, and leaves the marker', async () => {
      const w = await markedBack();
      for (const said of ['svalld did not answer the handshake within 5000ms', 'svalld closed the connection (1006)']) {
        await expect(settleMove(w.studio.paths, BACK, { status: 'not-adopted' }, keyOf(w), { ...NOTHING, thaw: () => Promise.reject(new Error(said)) })).rejects.toThrow(said);
        expect(readMarker(w.studio.paths)?.id).toBe(BACK);
      }
    });

    it('a refused connection with no daemon there ends it on the file, and starts it', async () => {
      const w = await markedBack();
      w.studio.daemon.kill();
      let started = 0;
      expect(await settleMove(w.studio.paths, BACK, { status: 'not-adopted' }, keyOf(w), { ...NOTHING, thaw: () => Promise.reject(new Error('svalld not reachable on ws://127.0.0.1:1: connect ECONNREFUSED')), start: async () => { started++; } })).toEqual({ status: 'not-adopted' });
      expect(readMarker(w.studio.paths)).toBeUndefined();
      expect(started).toBe(1);
    });

    it('a marker that asks for itself is told by no one, whatever a hand runs', async () => {
      const w = await markedBack();
      await w.studio.daemon.stop();
      putMarker(w.studio.paths, { ...readMarker(w.studio.paths)!, ask: marker().ask });
      await expect(settleMove(w.studio.paths, BACK, { status: 'not-adopted' }, keyOf(w), { ...NOTHING, thaw: () => Promise.reject(new Error(NOT_RUNNING)) })).rejects.toThrow(/told by no one/);
      expect(readMarker(w.studio.paths)?.id).toBe(BACK);
    });

    it('an overlapping settle a start joined past says nothing was refused, and writes no marker back', async () => {
      const w = await markedBack();
      const a = await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
      if (a.status !== 'adopted') throw new Error(a.status);
      let joined = 0;
      const told = await settleMove(w.studio.paths, BACK, a, keyOf(w), {
        ...NOTHING,
        // the other delivery's start joined while this one's connection failed
        join: async () => { fs.rmSync(w.studio.paths.homeMoving); throw new Error(NOT_RUNNING); },
        start: async () => { joined++; },
      });
      expect(told).toEqual({ status: 'adopted' });
      expect(fs.existsSync(w.studio.paths.homeMoving)).toBe(false);
      expect(joined).toBe(1);
    });
  });

  it('an adopted of a move this home holds no marker of says it has heard, and changes nothing', async () => {
    const w = await markedBack();
    fs.rmSync(w.studio.paths.homeMoving);
    const told = await settleMove(w.studio.paths, BACK, { status: 'adopted', enrol: w.enrolment(TOKEN_BACK, BACK_MANIFEST) }, keyOf(w), { join: () => { throw new Error('joined'); }, thaw: () => { throw new Error('thawed'); }, start: () => { throw new Error('started'); } });
    expect(told).toEqual({ status: 'done' });
    expect(journalLines(w.studio.paths, BACK)).toEqual([]);
  });

  it('a thaw with studio\'s daemon down leaves it a home that takes writes', async () => {
    const w = await markedBack();
    await abortAdopt(w.mac.deps, BACK);
    w.studio.daemon.kill();
    expect(await deliverOwed(w.mac.paths, studioAt(w.studio).open)).toBe('told');
    expect(roles(w)).toEqual(['worker', 'home']);
    expect(journalLines(w.studio.paths, BACK).at(-1)?.phase).toBe('released');
  });
});

describe('whether the old home still holds this move', () => {
  const FAR_OWED = { id: BACK, ssh: 'ada@studio', svallBase: '/home/ada/.local/share/svall', fleetHome: '/home/ada/.svall', from: STUDIO, fleetId: FLEET } as never;
  const facts = (moving?: string) => ({ run: () => Promise.resolve({ code: 0, signal: null, stderr: '', stdout: JSON.stringify({ machineId: STUDIO, fleetId: FLEET, release: 'r', protocol: 1, stateSchema: 1, clock: 1, fleetHome: '/f', tailscale: {}, ...(moving && { moving }) }) }) }) as never;

  it('only its own mark says so: another move\'s is none', async () => {
    expect(await markedThere(facts(BACK), FAR_OWED)).toBe(true);
    expect(await markedThere(facts('hm_otherother'), FAR_OWED)).toBe(false);
    expect(await markedThere(facts(), FAR_OWED)).toBe(false);
  });

  it.each([
    ['another machine', { machineId: MAC }],
    ['another fleet', { fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' }],
  ])('%s holding this move\'s id is no answer at all, and so no word that it is not marked', async (_who, other) => {
    const run = () => Promise.resolve({ code: 0, signal: null, stderr: '', stdout: JSON.stringify({ ...STUDIO_FACTS, moving: BACK, ...other }) });
    await expect(markedThere({ run } as never, FAR_OWED)).rejects.toThrow(/another machine or fleet/);
  });
});

describe('the phone link a move owes', () => {
  // a move out whose old home served it, on the machine that took it, a home that runs this tick
  const serving = async () => {
    const w = await world();
    const m = { ...w.manifest, phone: { serving: true, logins: ['ada@tailnet'] } };
    await w.mac.daemon.stop();
    const packed = await packFleet(w.mac.paths, m);
    await w.mac.daemon.start();
    await stageAdopt(w.studio.deps, ID, packed.sha256, packed.bytes);
    return w;
  };
  const tick = async (paths: Side['paths'], serve: () => Promise<{ error?: string }>, log: string[] = []) => {
    vi.useFakeTimers();
    const stop = startDeliveries(paths, { error: (l) => log.push(l), info: (l) => log.push(l) }, undefined, serve);
    await vi.advanceTimersByTimeAsync(5_100);
    stop();
    vi.useRealTimers();
    return log;
  };

  it.each(['adopt.installed', 'adopt.started', 'adopt.committed'] as HomeFailpoint[])('%s: a commit reached by a status still owes it, and the home turns it on once', async (point) => {
    const w = await serving();
    crashAt(point);
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    w.studio.daemon.kill();
    await w.studio.daemon.start();
    expect((await adoptStatus(w.studio.deps, ID)).status).toBe('adopted');
    expect(phoneOwed(w.studio.paths)).toEqual([ID]);
    let on = 0;
    await tick(w.studio.paths, async () => { on++; return {}; });
    await tick(w.studio.paths, async () => { on++; return {}; });
    expect(on).toBe(1);
    expect(phoneOwed(w.studio.paths)).toEqual([]);
    expect(moveOutcome(w.studio.paths, ID)?.status).toBe('adopted');
  });

  it('a `tailscale serve` that hangs keeps no old home waiting: the outcome goes out, and the link is tried once', async () => {
    const w = await markedBack();
    expect((await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    enter(w.mac.paths, BACK, 'adopted', 'serve');
    let tries = 0;
    vi.useFakeTimers();
    const stop = startDeliveries(w.mac.paths, { error: () => {}, info: () => {} }, studioAt(w.studio).open, () => { tries++; return new Promise(() => {}); });
    await vi.advanceTimersByTimeAsync(30_000);
    stop();
    vi.useRealTimers();
    expect(readOwed(w.mac.paths)).toBeUndefined();
    expect(tries).toBe(1);
  });

  it('a home that did not serve owes nothing', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.mac.daemon.stop();
    const quiet = await packFleet(w.mac.paths, { ...w.manifest, id: BACK, phone: { serving: false, logins: [] } });
    const again = await world();
    await stageAdopt(again.studio.deps, BACK, quiet.sha256, quiet.bytes);
    expect((await installAdopt(again.studio.deps, BACK, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    expect(phoneOwed(again.studio.paths)).toEqual([]);
  });

  it('a link refused here is said and journaled, and the move stands', async () => {
    const w = await serving();
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    const log = await tick(w.studio.paths, () => Promise.resolve({ error: 'Access denied: serve config denied' }));
    expect(log.some((l) => /Access denied/.test(l))).toBe(true);
    expect(journalLines(w.studio.paths, ID).at(-1)).toMatchObject({ phase: 'served', detail: 'Access denied: serve config denied' });
    expect(moveOutcome(w.studio.paths, ID)?.status).toBe('adopted');
    expect(phoneOwed(w.studio.paths)).toEqual([]);
  });

  it('a daemon with nothing to serve with, a worker\'s, leaves it owed', async () => {
    const w = await serving();
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    vi.useFakeTimers();
    const stop = startDeliveries(w.studio.paths, { error: () => {}, info: () => {} });
    await vi.advanceTimersByTimeAsync(5_100);
    stop();
    vi.useRealTimers();
    expect(phoneOwed(w.studio.paths)).toEqual([ID]);
  });
});

describe('a worker a person removed before the move', () => {
  const SECOND = '99999999-7777-8888-9999-aaaaaaaaaaaa' as MachineId;
  // each machine reads its own registry, which lists the second while it is a worker
  const facts = async (s: Side, me: MachineId, role: 'home' | 'worker') => {
    vi.stubEnv('SVALL_CONFIG_DIR', s.registryDir);
    try { return { ...await homeFacts(s.paths, { me, role, fleetId: FLEET, tailscale: {} as never }), tailscale: { host: 'h' } }; } finally { vi.unstubAllEnvs(); }
  };
  const listed = (s: Side) => putRecord(SECOND, { name: 'second', platform: 'darwin', arch: 'arm64', home: '/Users/bo', svallBase: '/opt/svall', dial: 'worker' } as never, s.registryDir);
  const refusal = { ok: false, refusal: { reason: 'second is a worker of this fleet too' } };

  it('stops neither way once its token has gone, though the fleet still holds its name; a token still held refuses', async () => {
    const w = await markedBack(async (m) => {
      const back = async () => homeCheck({ state: m.mac.daemon.held!, from: await facts(m.studio, STUDIO, 'home'), to: await facts(m.mac, MAC, 'worker'), toName: 'mac', back: 'studio', linked: true, synced: true, fromIsHome: true });
      expect(m.mac.daemon.held!.machines?.[SECOND]?.name).toBe('second');
      expect(await back()).toMatchObject({ ok: true });
      listed(m.studio);
      issueToken(m.studio.paths, SECOND);
      expect(await back()).toMatchObject(refusal);
      dropToken(m.studio.paths, SECOND);
    }, async (m) => {
      const out = async () => homeCheck({ state: m.mac.daemon.held!, from: await facts(m.mac, MAC, 'home'), to: await facts(m.studio, STUDIO, 'worker'), toName: 'studio', linked: true, synced: true, fromIsHome: true });
      m.mac.daemon.held!.machines = { ...m.mac.daemon.held!.machines, [SECOND]: { name: 'second', reachable: false, since: 1 } };
      listed(m.mac);
      issueToken(m.mac.paths, SECOND);
      expect(await out()).toMatchObject(refusal);
      dropToken(m.mac.paths, SECOND);
      expect(await out()).toMatchObject({ ok: true });
    });
    expect(await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'adopted' });
  });
});

describe('whose ticks stand on the machine the fleet comes to', () => {
  const ITEM = 'claude:mcp:linear';
  const OTHER = '99999999-7777-8888-9999-aaaaaaaaaaaa' as MachineId;
  const ticks = (file: string, machine: MachineId) => [...readConsent(file, machine)];

  it('going out: the home\'s for the machine that takes the fleet go, that machine\'s for it stand, and another worker\'s are carried', async () => {
    const w = await world();
    setConsent(w.mac.paths.mirrorConsent, STUDIO, ITEM, ['env.K'], true);
    setConsent(w.mac.paths.mirrorConsent, OTHER, ITEM, ['env.O'], true);
    setConsent(w.studio.paths.mirrorConsent, MAC, ITEM, ['env.MINE'], true);
    await w.mac.daemon.stop();
    const packed = await packFleet(w.mac.paths, w.manifest);
    await stageAdopt(w.studio.deps, ID, packed.sha256, packed.bytes);
    putMarker(w.mac.paths, marker());
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'adopted' });
    expect(ticks(w.studio.paths.mirrorConsent, STUDIO)).toEqual([]);
    expect(ticks(w.studio.paths.mirrorConsent, MAC)).toEqual([`${ITEM}#env.MINE`]);
    expect(ticks(w.studio.paths.mirrorConsent, OTHER)).toEqual([`${ITEM}#env.O`]);
  });

  it('coming back: an untick this machine made as a worker stands, and no tick of the old home\'s comes back with the fleet', async () => {
    const w = await markedBack((m) => {
      // the Mac's file as the way out left it, which its window's untick then changes; what studio holds as it left, a tick of the Mac's among it
      setConsent(m.mac.paths.mirrorConsent, STUDIO, ITEM, ['env.K', 'env.L'], true);
      setConsent(m.mac.paths.mirrorConsent, STUDIO, ITEM, ['env.K'], false, true);
      setConsent(m.studio.paths.mirrorConsent, STUDIO, ITEM, ['env.K'], true);
      setConsent(m.studio.paths.mirrorConsent, MAC, ITEM, ['env.S'], true);
    });
    expect(await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'adopted' });
    expect(ticks(w.mac.paths.mirrorConsent, MAC)).toEqual([]);
    expect(ticks(w.mac.paths.mirrorConsent, STUDIO)).toEqual([`${ITEM}#env.L`]);
  });

  it('a tick left under the old home\'s own id goes, where the machine taking the fleet held none for it', async () => {
    const w = await world();
    setConsent(w.mac.paths.mirrorConsent, MAC, ITEM, ['env.STALE'], true);
    await w.mac.daemon.stop();
    const packed = await packFleet(w.mac.paths, w.manifest);
    await stageAdopt(w.studio.deps, ID, packed.sha256, packed.bytes);
    putMarker(w.mac.paths, marker());
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(ticks(w.studio.paths.mirrorConsent, MAC)).toEqual([]);
  });

  it('a fleet with no ticks stays with no file of them', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marker());
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(fs.existsSync(w.studio.paths.mirrorConsent)).toBe(false);
  });
});

describe('what stays behind', () => {
  it('the old home linking with its new token clears what its move staged, and a link of another machine does not', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    await landed(w.mac.deps, MAC);
    expect(fs.existsSync(adoptDir(w.mac.paths, BACK))).toBe(true);
    await landed(w.mac.deps, STUDIO);
    expect(fs.existsSync(adoptDir(w.mac.paths, BACK))).toBe(false);
    expect(await adoptStatus(w.mac.deps, BACK)).toEqual({ status: 'done' });
  });

  it('a link before the delivery was cleared leaves nothing to tell', async () => {
    const w = await markedBack();
    await installAdopt(w.mac.deps, BACK, ADOPT_KEY, w.enrolment);
    await landed(w.mac.deps, STUDIO);
    expect(await deliverOwed(w.mac.paths, () => { throw new Error('dialed'); })).toBe('told');
    expect(readOwed(w.mac.paths)).toBeUndefined();
  });

  it('a later move gives up the archive of one its driver left, and refuses it for good; one installing stops it', async () => {
    const w = await world();
    const old = 'hm_oldoldoldo' as HomeMoveId;
    const packed = await (async () => { await w.mac.daemon.stop(); const p = await packFleet(w.mac.paths, { ...w.manifest, id: old }); await w.mac.daemon.start(); return p; })();
    await stageAdopt(w.studio.deps, old, packed.sha256, packed.bytes);
    expect(fs.existsSync(adoptDir(w.studio.paths, old))).toBe(true);
    expect((await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes))).toMatchObject({ status: 'pending', phase: 'staged' });
    expect(fs.existsSync(adoptDir(w.studio.paths, old))).toBe(false);
    expect(await installAdopt(w.studio.deps, old, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });

    crashAt('adopt.dropped');
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    w.studio.daemon.kill();
    const late = 'hm_laterlater' as HomeMoveId;
    expect(await stageAdopt(w.studio.deps, late, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'pending', phase: 'busy' });
  });
});

it('the archive folder of the way back keeps its name under what Files refuses', async () => {
  const w = await markedBack();
  expect(path.basename(adoptDir(w.mac.paths, BACK))).toBe(`adopt-${BACK}`);
});
