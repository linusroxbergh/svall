import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdoptAnswer, HomeMoving } from '@svall/protocol';
import { armHomeFailpoints, HOME_FAILPOINTS, HomeCrash, type HomeFailpoint } from '../../src/failpoints.js';
import { abortAdopt, adoptDir, adoptStatus, confirmAdopt, homeGate, installAdopt, journalLines, joinAsWorker, readMarker, stageAdopt, writeMarker } from '../../src/fleet/home-move.js';
import { readRegistry } from '../../src/machine.js';
import { inStagedMove } from '../../src/paths.js';
import { startsAsWorker } from '../../src/worker/mode.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { FLEET, ID, MAC, marker, robot, stateOf, STUDIO, TOKEN, world } from './home-world.js';

let disarm: (() => void) | undefined;
afterEach(() => { disarm?.(); disarm = undefined; cleanHomes(); });

// a crash at the `n`th time `point` is reached
function crashAt(point: HomeFailpoint, n = 1): () => boolean {
  let hit = 0;
  let fired = false;
  disarm = armHomeFailpoints((name) => {
    if (name === point && ++hit === n) { fired = true; disarm?.(); throw new HomeCrash(point); }
  });
  return () => fired;
}

const staged = async (w: Awaited<ReturnType<typeof world>>) => {
  await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
  await w.mac.daemon.stop().catch(() => undefined);
  writeMarker(w.mac.paths, marker());
  await w.mac.daemon.start();
};

const homes = (w: Awaited<ReturnType<typeof world>>): string[] => [w.mac, w.studio].flatMap((s) => (s.daemon.role === 'home' ? [s === w.mac ? 'mac' : 'studio'] : []));

describe('staging', () => {
  it('refuses an archive that is not what its sha256 says, and changes nothing of the fleet home', async () => {
    const w = await world();
    const before = fs.readFileSync(w.studio.paths.workerFile, 'utf8');
    await expect(stageAdopt(w.studio.deps, ID, 'f'.repeat(64), w.archive.bytes)).rejects.toThrow(/sha256/);
    expect(fs.readFileSync(w.studio.paths.workerFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(adoptDir(w.studio.paths, ID), 'incoming'))).toBe(false);
  });

  it.each(['adopt.staging', 'adopt.staged'] as const)('%s: a crash leaves it pending, never a thaw, and a retry takes it', async (point) => {
    const w = await world();
    const fired = crashAt(point);
    await expect(stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    expect((await adoptStatus(w.studio.deps, ID)).status).toBe('pending');
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'pending', phase: 'staged' });
    expect(fs.existsSync(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'fleet.json'))).toBe(true);
  });

  describe('a kill inside the tar extraction', () => {
    const realPath = process.env.PATH;
    afterEach(() => { process.env.PATH = realPath; });

    // the first file out, then the tar killed as a whole machine going down would kill it
    const killedTar = async () => {
      const w = await world();
      const bin = makeHome();
      fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\ncase "$1" in\n  -x) /usr/bin/tar "$@" fleet.json; kill -9 $$ ;;\n  *) exec /usr/bin/tar "$@" ;;\nesac\n', { mode: 0o755 });
      process.env.PATH = `${bin}:${realPath}`;
      await expect(stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).rejects.toThrow();
      process.env.PATH = realPath;
      const dir = adoptDir(w.studio.paths, ID);
      expect(fs.readdirSync(path.join(dir, 'unpacked'))).toEqual(['fleet.json']);
      expect(fs.existsSync(path.join(dir, 'incoming'))).toBe(false);
      return { w, dir };
    };

    it('leaves the fleet home untouched and nothing that installs, and the retry starts over from the archive', async () => {
      const { w, dir } = await killedTar();
      expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).id).not.toBe(FLEET);
      expect(await installAdopt(w.studio.deps, ID, w.enrolment)).toMatchObject({ status: 'pending', phase: 'staging' });
      expect(w.studio.daemon.role).toBe('worker');
      expect(inStagedMove(path.join(dir, 'unpacked', 'fleet.json'))).toBe(true);
      expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'pending', phase: 'staged' });
      expect(fs.existsSync(path.join(dir, 'unpacked'))).toBe(false);
      expect((await installAdopt(w.studio.deps, ID, w.enrolment)).status).toBe('adopted');
    });

    it('called off, what was half unpacked goes with it, and a retry is refused', async () => {
      const { w, dir } = await killedTar();
      expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
      expect(fs.existsSync(dir)).toBe(false);
      expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'not-adopted' });
    });
  });

  it('holds what it staged under a name Files refuses', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    expect(fs.readFileSync(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'mobile-pass'), 'utf8')).toBe('the-pass');
    expect(inStagedMove(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'mobile-pass'))).toBe(true);
    expect(inStagedMove(w.studio.paths.state)).toBe(false);
  });
});

describe('a not adopted is final', () => {
  it('a status on an id never heard of records the abort first, and the adopt that comes late is refused', async () => {
    const w = await world();
    expect(await adoptStatus(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).toBe('aborted');
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'not-adopted' });
    expect(await installAdopt(w.studio.deps, ID, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(w.studio.daemon.role).toBe('worker');
  });

  it('a crash right after the abort is recorded still refuses, the answer never having gone out', async () => {
    const w = await world();
    crashAt('abort.recorded');
    await expect(adoptStatus(w.studio.deps, ID)).rejects.toThrow(HomeCrash);
    expect(await installAdopt(w.studio.deps, ID, w.enrolment)).toMatchObject({ status: 'not-adopted' });
  });

  it('a staged adopt answers pending, which never lets the old home thaw, until it is aborted', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    expect(await adoptStatus(w.studio.deps, ID)).toMatchObject({ status: 'pending', phase: 'staged' });
    expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(false);
    expect(await installAdopt(w.studio.deps, ID, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  it('abort and status while another step holds the move answer pending, and an abort after the commit says adopted', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const running = installAdopt(w.studio.deps, ID, w.enrolment);
    expect(await adoptStatus(w.studio.deps, ID)).toMatchObject({ status: 'pending', phase: 'running' });
    expect(await abortAdopt(w.studio.deps, ID)).toMatchObject({ status: 'pending', phase: 'running' });
    expect((await running).status).toBe('adopted');
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
  });
});

describe('adopting', () => {
  it('stops the daemon before the files change, so its last flush lands in what is kept and not over what comes', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    w.studio.daemon.held!.robots.placed.note = 'written by the worker at its last flush';
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
    expect(w.studio.daemon.held!.robots.here.machine).toBe(MAC);
    expect(w.studio.daemon.held!.robots.placed.machine).toBeUndefined();
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(false);
    expect(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).toContain(FLEET);
  });

  it('holds the worker\'s own running fields over the archive\'s, and the robot it started since the cut', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    w.studio.daemon.held!.robots.born = robot('born', STUDIO, 0);
    expect((await installAdopt(w.studio.deps, ID, w.enrolment)).status).toBe('adopted');
    const { robots } = w.studio.daemon.held!;
    expect(robots.placed.unread).toBe(true);
    expect(robots.born.machine).toBeUndefined();
  });

  it('takes the old home\'s record into its registry, its token into workers.json, and its logins as what they were', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    expect(readRegistry(w.studio.registryDir).find((m) => m.id === MAC)?.record).toMatchObject({ name: 'mac', dial: 'worker' });
    const workers = JSON.parse(fs.readFileSync(w.studio.paths.workersFile, 'utf8')) as Record<string, { token: string }>;
    expect(workers[MAC].token).toBe(a.enrol.worker.token);
    expect(Object.keys(workers)).toEqual([MAC]);
    expect((JSON.parse(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')) as { mobile: { logins: string[] } }).mobile.logins).toEqual(['ada@tailnet']);
  });

  it('a daemon that will not answer as home undoes the whole set, and starts as the worker it was', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const before = fs.readFileSync(w.studio.paths.fleetConfig, 'utf8');
    w.studio.daemon.noAnswer = true;
    expect(await installAdopt(w.studio.deps, ID, w.enrolment)).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(w.studio.daemon.role).toBe('worker');
    expect(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).toBe(before);
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
    expect(readRegistry(w.studio.registryDir).find((m) => m.id === MAC)).toBeUndefined();
    // and a retry runs from what stayed staged, with the same token
    w.studio.daemon.noAnswer = false;
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(w.studio.daemon.held!.robots.placed.machine).toBeUndefined();
    expect(w.studio.daemon.held!.robots.here.machine).toBe(MAC);
  });

  it('refuses a change made while the link was down that no copy carries, restarting as the worker it was', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    fs.appendFileSync(w.studio.paths.outbox, `${JSON.stringify({ seq: 5, kind: 'mutation', data: { method: 'robot.update' } })}\n`);
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    expect(a).toMatchObject({ status: 'pending', phase: 'staged' });
    expect(a.status === 'pending' && a.detail).toMatch(/robot\.update/);
    expect(w.studio.daemon.role).toBe('worker');
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  it('clears what it staged only once both sides have landed', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await installAdopt(w.studio.deps, ID, w.enrolment);
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(true);
    expect((await confirmAdopt(w.studio.deps, ID)).status).toBe('done');
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(false);
    expect(await adoptStatus(w.studio.deps, ID)).toEqual({ status: 'done' });
  });
});

const ON_ADOPT = HOME_FAILPOINTS.filter((p) => p.startsWith('adopt.') && p !== 'adopt.staging' && p !== 'adopt.staged');
const CUT_BEFORE_COMMIT = ON_ADOPT.filter((p) => p !== 'adopt.committed');

describe('a crash at each boundary of the adopt', () => {
  // the state after a crash, with the daemon the supervisor would start again or the status the old home asks
  const crashed = async (point: HomeFailpoint, n = 1) => {
    const w = await world();
    await staged(w);
    const fired = crashAt(point, n);
    await expect(installAdopt(w.studio.deps, ID, w.enrolment)).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    w.studio.daemon.kill();
    return w;
  };

  it.each(CUT_BEFORE_COMMIT)('%s: a start settles it with the old home frozen, and a retry finishes the move', async (point) => {
    const w = await crashed(point);
    await w.studio.daemon.start();
    expect(homes(w).filter((h) => h === 'mac')).toEqual([]);
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
    expect(w.studio.daemon.held!.robots.here.machine).toBe(MAC);
    expect(w.studio.daemon.held!.robots.placed.machine).toBeUndefined();
    expect(homes(w)).toEqual(['studio']);
  });

  it.each(CUT_BEFORE_COMMIT)('%s: called off, every original is back and the delayed adopt is refused', async (point) => {
    const w = await crashed(point);
    const worker = 'worker.json';
    const a = await abortAdopt(w.studio.deps, ID);
    expect(a).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(path.join(w.studio.paths.home, worker))).toBe(true);
    expect(JSON.parse(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).id).not.toBe(FLEET);
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
    expect(await installAdopt(w.studio.deps, ID, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(w.studio.daemon.role === 'home').toBe(false);
  });

  it.each(CUT_BEFORE_COMMIT)('%s: a status settles it itself and never says adopted without a home that answers', async (point) => {
    const w = await crashed(point);
    w.studio.daemon.noAnswer = true;
    const a = await adoptStatus(w.studio.deps, ID);
    expect(['pending']).toContain(a.status);
    expect(w.studio.daemon.role === 'home' && !w.studio.daemon.noAnswer).toBe(false);
    expect(fs.existsSync(w.studio.paths.workerFile) || journalLines(w.studio.paths, ID).at(-1)?.phase === 'installed').toBe(true);
  });

  it('adopt.committed: recovery goes forward, the answer the same as it was', async () => {
    const w = await crashed('adopt.committed');
    await w.studio.daemon.start();
    expect(w.studio.daemon.role).toBe('home');
    expect((await adoptStatus(w.studio.deps, ID)).status).toBe('adopted');
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('adopted');
  });

  it('a crash between two files replaced, for every file, comes back whole', async () => {
    for (let n = 1; n <= 12; n++) {
      const w = await crashed('adopt.file', n);
      await w.studio.daemon.start();
      expect(w.studio.daemon.role).toBe('worker');
      expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
      expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).id).not.toBe(FLEET);
      cleanHomes();
    }
  });

  it('a crash right after the restore ended, before it is journaled, restores nothing twice', async () => {
    const w = await crashed('adopt.dropped');
    const fired = crashAt('restore.done');
    await expect(w.studio.daemon.start()).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    w.studio.daemon.kill();
    await w.studio.daemon.start();
    expect(w.studio.daemon.role).toBe('worker');
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).toBe('rolledback');
  });

  it('a crash in the restore itself, at each file, restores on the next start', async () => {
    for (let n = 1; n <= 6; n++) {
      const w = await crashed('adopt.dropped');
      const fired = crashAt('restore.file', n);
      await expect(w.studio.daemon.start()).rejects.toThrow(HomeCrash);
      expect(fired()).toBe(true);
      w.studio.daemon.kill();
      await w.studio.daemon.start();
      expect(w.studio.daemon.role).toBe('worker');
      expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
      expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
      expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
      cleanHomes();
    }
  });
});

describe('the join', () => {
  const JOIN = HOME_FAILPOINTS.filter((p) => p.startsWith('join.'));
  const adopted = async () => {
    const w = await world();
    await staged(w);
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    return { w, marked: { ...marker(), enrol: a.enrol } as HomeMoving };
  };
  const joined = (w: Awaited<ReturnType<typeof world>>) => {
    expect(w.mac.daemon.role).toBe('worker');
    const s = w.mac.daemon.held!;
    expect(s.robots.here.machine).toBe(MAC);
    expect(s.robots.placed.machine).toBeUndefined();
    expect(fs.existsSync(w.mac.paths.homeMoving)).toBe(false);
    expect(fs.existsSync(w.mac.paths.docs)).toBe(false);
    expect(fs.readFileSync(`${w.mac.paths.docs}.home-${ID}/fleet/note.md`, 'utf8')).toBe('a note');
    expect(fs.existsSync(`${w.mac.paths.state}.home-${ID}`)).toBe(true);
    expect(s.machines?.[STUDIO]?.snapshot?.version).toBe(0);
  };

  it('a start on the outcome relabels from the state it held as it stopped, and comes up a worker past the guard, with the old workers.json present', async () => {
    const { w, marked } = await adopted();
    w.mac.daemon.held!.robots.here.note = 'the last thing it flushed';
    await w.mac.daemon.stop();
    writeMarker(w.mac.paths, marked);
    expect(fs.existsSync(w.mac.paths.workersFile)).toBe(true);
    await w.mac.daemon.start();
    joined(w);
    expect(w.mac.daemon.held!.robots.here.note).toBe('the last thing it flushed');
    expect(homes(w)).toEqual(['studio']);
    expect(readRegistry(w.mac.registryDir).find((m) => m.id === STUDIO)?.record.ssh).toBe('ada@studio');
  });

  it('the guard stays for an ordinary enrol: the same files without the relabel are refused', async () => {
    const { w } = await adopted();
    await w.mac.daemon.stop();
    fs.writeFileSync(w.mac.paths.workerFile, JSON.stringify({ homeMachineId: STUDIO, fleetId: FLEET, token: TOKEN, homeName: 'studio' }));
    expect(() => startsAsWorker(w.mac.paths, () => MAC)).toThrow(/holds .* as a fleet's home/);
  });

  it.each(JOIN)('%s: a crash goes forward from what it kept, the relabel never run on its own output', async (point) => {
    const { w, marked } = await adopted();
    await w.mac.daemon.stop();
    writeMarker(w.mac.paths, marked);
    const fired = crashAt(point);
    await expect(w.mac.daemon.start()).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    w.mac.daemon.kill();
    expect(homes(w)).toEqual(['studio']);
    await w.mac.daemon.start();
    joined(w);
    expect(homes(w)).toEqual(['studio']);
  });

  it('a marked home whose state never met a stamp starts frozen as a home, not a worker, on its files as they were', async () => {
    const w = await world();
    await staged(w);
    expect(w.mac.daemon.role).toBe('frozen');
    expect(w.mac.daemon.held!.robots.here.machine).toBeUndefined();
    expect(homes(w)).toEqual([]);
  });

  it('a crash writing the marker leaves it there or nothing, and neither reads as a home taking writes past the adopt', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.mac.daemon.stop();
    crashAt('mark.written');
    expect(() => writeMarker(w.mac.paths, marker())).toThrow(HomeCrash);
    expect(readMarker(w.mac.paths)?.id).toBe(ID);
    expect(homeGate(w.mac.paths, w.mac.registryDir).frozen?.id).toBe(ID);
  });

  it('a marker that cannot be read stops the start: no guess that it may run as a home', async () => {
    const w = await world();
    await w.mac.daemon.stop();
    fs.writeFileSync(w.mac.paths.homeMoving, '{ half');
    await expect(w.mac.daemon.start()).rejects.toThrow();
    w.mac.daemon.kill();
  });

  it('run again on what it wrote, it derives the same state', async () => {
    const { w, marked } = await adopted();
    await w.mac.daemon.stop();
    joinAsWorker(w.mac.paths, marked as HomeMoving & { enrol: NonNullable<HomeMoving['enrol']> }, w.mac.registryDir);
    const once = fs.readFileSync(w.mac.paths.state, 'utf8');
    joinAsWorker(w.mac.paths, marked as HomeMoving & { enrol: NonNullable<HomeMoving['enrol']> }, w.mac.registryDir);
    expect(fs.readFileSync(w.mac.paths.state, 'utf8')).toBe(once);
  });
});

describe('two homes are impossible', () => {
  it('through every crash on either side, at most one daemon ever takes writes', async () => {
    const answers: AdoptAnswer['status'][] = [];
    for (const point of CUT_BEFORE_COMMIT) {
      const w = await world();
      await staged(w);
      crashAt(point);
      await installAdopt(w.studio.deps, ID, w.enrolment).catch(() => undefined);
      expect(homes(w).filter((h) => h === 'mac')).toEqual([]);
      w.studio.daemon.kill();
      await w.studio.daemon.start();
      await w.mac.daemon.start();
      expect(w.mac.daemon.role).toBe('frozen');
      expect(homes(w).length).toBeLessThanOrEqual(1);
      const a = await adoptStatus(w.studio.deps, ID);
      answers.push(a.status);
      expect(a.status === 'not-adopted').toBe(false);
      cleanHomes();
    }
    expect(answers.length).toBe(CUT_BEFORE_COMMIT.length);
  });
});

it('every failpoint of a move is reached by a case in this suite, or named where it is', () => {
  const here = new Set<string>([...ON_ADOPT, 'adopt.staging', 'adopt.staged', 'abort.recorded', 'restore.file', 'restore.done', 'mark.written', ...HOME_FAILPOINTS.filter((p) => p.startsWith('join.'))]);
  // home-back.test.ts has the first three, and the cli's fleet-home.test.ts the driver's
  expect(HOME_FAILPOINTS.filter((p) => !here.has(p))).toEqual(['enrol.written', 'deliver.owed', 'deliver.told', 'move.marked']);
});
