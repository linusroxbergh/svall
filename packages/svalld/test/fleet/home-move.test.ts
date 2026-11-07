import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeManifest, HomeMoving } from '@svall/protocol';
import { InvalidConfig } from '../../src/config.js';
import { repoSlug } from '../../src/docs.js';
import { HOME_FAILPOINTS, HomeCrash, type HomeFailpoint } from '../../src/failpoints.js';
import { HomeFreeze } from '../../src/fleet/home-freeze.js';
import { HomeDocs, WorkerDocs } from '../../src/placement/docs-sync.js';
import { abortAdopt, adoptDir, adoptStatus, confirmAdopt, createMarker, homeGate, installAdopt, journalLines, joinAsWorker, packFleet, readMarker, stageAdopt } from '../../src/fleet/home-move.js';
import { putRecord, readRegistry } from '../../src/machine.js';
import { resolvePaths, inStagedMove } from '../../src/paths.js';
import { issueToken } from '../../src/placement/workers.js';
import { startsAsWorker } from '../../src/worker/mode.js';
import { silentLogger } from '../../src/log.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { ADOPT_KEY, ASKER, crashAt, crashesFired, disarmCrash, FLEET, ID, MAC, marker, phoneAt, POINTS_OF, robot, sha, stateOf, STUDIO, TOKEN, world, putMarker } from './home-world.js';

afterEach(() => { disarmCrash(); cleanHomes(); });
afterAll(() => { expect(POINTS_OF.move.filter((p) => !crashesFired().has(p))).toEqual([]); });

const staged = async (w: Awaited<ReturnType<typeof world>>) => {
  await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
  await w.mac.daemon.stop().catch(() => undefined);
  putMarker(w.mac.paths, marker());
  await w.mac.daemon.start();
};

const lastOf = (w: Awaited<ReturnType<typeof world>>): string | undefined => journalLines(w.studio.paths, ID).at(-1)?.phase;

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
      expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'pending', phase: 'staging' });
      expect(w.studio.daemon.role).toBe('worker');
      expect(inStagedMove(path.join(dir, 'unpacked', 'fleet.json'))).toBe(true);
      expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'pending', phase: 'staged' });
      expect(fs.existsSync(path.join(dir, 'unpacked'))).toBe(false);
      expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    });

    it('called off, what was half unpacked goes with it, and a retry is refused', async () => {
      const { w, dir } = await killedTar();
      expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
      expect(fs.existsSync(dir)).toBe(false);
      expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'not-adopted' });
    });
  });

  it('refuses an archive of another move, or for another machine, and one holding what no fleet carries', async () => {
    const w = await world();
    await expect(stageAdopt(w.studio.deps, 'hm_otherother' as never, w.archive.sha256, w.archive.bytes)).rejects.toThrow(/of move hm_abcdefghij/);
    const mine = await world();
    await mine.mac.daemon.stop();
    const forOther = await packFleet(mine.mac.paths, { ...mine.manifest, to: MAC });
    await expect(stageAdopt(mine.studio.deps, ID, forOther.sha256, forOther.bytes)).rejects.toThrow(/for machine/);
    const third = await world();
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, 'token'), 'x');
    const file = path.join(dir, 'x.tar');
    execFileSync('tar', ['-c', '-f', file, '-C', dir, 'token']);
    const bytes = fs.readFileSync(file);
    await expect(stageAdopt(third.studio.deps, ID, crypto.createHash('sha256').update(bytes).digest('hex'), bytes)).rejects.toThrow(/holds token, which no fleet carries/);
  });

  it('refuses when this machine is a worker of another fleet', async () => {
    const w = await world();
    fs.writeFileSync(w.studio.paths.workerFile, JSON.stringify({ homeMachineId: MAC, fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f71', token: TOKEN, homeName: 'mac' }));
    await expect(stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).rejects.toThrow(/worker of another fleet/);
  });

  it('refuses a machine another fleet here reaches over ssh, before anything is marked, and leaves its record', async () => {
    const w = await world();
    const other = path.join(os.homedir(), '.svall-other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'fleet.json'), JSON.stringify({ id: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f71' }));
    issueToken(resolvePaths(other), MAC);
    const record = { name: 'mac', ssh: 'ada@mac', platform: 'darwin', arch: 'arm64', home: '/Users/ada', svallBase: '/opt/svall' } as never;
    putRecord(MAC, record, w.studio.registryDir);
    try {
      await expect(stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).rejects.toThrow(/reaches mac over ssh at ada@mac/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
    expect(readRegistry(w.studio.registryDir).find((m) => m.id === MAC)?.record.ssh).toBe('ada@mac');
  });

  it('leaves the mirror\'s record of what pushes wrote here behind, which a Copy must not read as its own, and a rollback puts it back', async () => {
    const w = await world();
    const record = JSON.stringify({ files: { 'claude/CLAUDE.md': 'a'.repeat(64) }, docs: {}, servers: {}, secrets: {}, listed: { 'claude/plugins/installed_plugins.json': ['acme'] }, applied: 3 });
    fs.mkdirSync(path.dirname(w.studio.paths.mirrorState), { recursive: true });
    fs.writeFileSync(w.studio.paths.mirrorState, record);
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    w.studio.daemon.noAnswer = true;
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(fs.readFileSync(w.studio.paths.mirrorState, 'utf8')).toBe(record);
    w.studio.daemon.noAnswer = false;
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    expect(fs.existsSync(w.studio.paths.mirrorState)).toBe(false);
  });

  it('takes a record no other fleet shares: it goes the new way, and a rollback puts it back', async () => {
    const w = await world();
    const record = { name: 'mac', ssh: 'ada@mac', platform: 'darwin', arch: 'arm64', home: '/Users/ada', svallBase: '/opt/svall' } as never;
    putRecord(MAC, record, w.studio.registryDir);
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    w.studio.daemon.noAnswer = true;
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(readRegistry(w.studio.registryDir).find((m) => m.id === MAC)?.record.ssh).toBe('ada@mac');
    w.studio.daemon.noAnswer = false;
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(readRegistry(w.studio.registryDir).find((m) => m.id === MAC)?.record).toMatchObject({ dial: 'worker' });
  });

  it('an archive that comes again finds the move past staging, and wipes nothing of what its install set aside', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    crashAt('adopt.file');
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    disarmCrash();
    w.studio.daemon.kill();
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'pending', phase: 'installing' });
    expect(fs.readdirSync(path.join(adoptDir(w.studio.paths, ID), 'original')).length).toBeGreaterThan(0);
    w.studio.daemon.noAnswer = true;
    expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  it.each(['adopt.dropped', 'adopt.installed'] as const)('%s: a move not over stops a later one, and stays as it was', async (point) => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    crashAt(point);
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    disarmCrash();
    w.studio.daemon.kill();
    const later = 'hm_laterlater' as never;
    const packed = await packFleet(w.mac.paths, { ...w.manifest, id: later });
    expect(await stageAdopt(w.studio.deps, later, packed.sha256, packed.bytes)).toMatchObject({ status: 'pending', phase: 'busy', detail: expect.stringContaining(ID) });
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).not.toBe('aborted');
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(true);
  });

  it('a rename that fails in the install restores what it had set aside, and the worker is what it was', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const real = fs.renameSync;
    let left = 3;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes(`${path.sep}ready${path.sep}`) && --left === 0) throw Object.assign(new Error('EIO: the disk said no'), { code: 'EIO' });
      real(from, to);
    });
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment).finally(() => spy.mockRestore());
    expect(a).toMatchObject({ status: 'pending', phase: 'rolledback', detail: expect.stringContaining('EIO') });
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
    expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).toBe('rolledback');
    expect(w.studio.daemon.role).toBe('worker');
  });

  it('a rename that fails as the files go in puts back each it had set aside, and the worker is what it was', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const before = fs.readFileSync(w.studio.paths.fleetConfig, 'utf8');
    const real = fs.renameSync;
    let failed = false;
    // fleet.json is in by then, and state.json aside
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!failed && String(to) === w.studio.paths.state && String(from).includes(`${path.sep}ready${path.sep}`)) { failed = true; throw Object.assign(new Error('EIO: the disk said no'), { code: 'EIO' }); }
      real(from, to);
    });
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment).finally(() => spy.mockRestore());
    expect(a).toMatchObject({ status: 'pending', phase: 'rolledback', detail: expect.stringContaining('EIO') });
    expect(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).toBe(before);
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
    expect(w.studio.daemon.role).toBe('worker');
  });

  it('an archive that comes again after a rollback leaves it rolled back, and the retry keeps the token the first try issued', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    w.studio.daemon.noAnswer = true;
    const first = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(first).toMatchObject({ status: 'pending', phase: 'rolledback' });
    const token = (JSON.parse(fs.readFileSync(path.join(adoptDir(w.studio.paths, ID), 'enrol.json'), 'utf8')) as { worker: { token: string } }).worker.token;
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toEqual({ status: 'pending', phase: 'rolledback' });
    w.studio.daemon.noAnswer = false;
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(a.status === 'adopted' && a.enrol.worker.token).toBe(token);
  });

  it('holds what it staged under a name Files refuses', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    expect(fs.readFileSync(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'mobile-pass'), 'utf8')).toBe('the-pass');
    expect(inStagedMove(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'mobile-pass'))).toBe(true);
    expect(inStagedMove(w.studio.paths.state)).toBe(false);
    // what answers to another spelling on a volume that folds case
    expect(inStagedMove(path.join(w.studio.paths.home, 'ADOPT-hm_abcdefghij', 'incoming', 'mobile-pass'))).toBe(true);
    expect(inStagedMove(path.join(w.studio.paths.home, 'WORKERS.json.home-hm_abcdefghij'))).toBe(true);
  });
});

describe('a not adopted is final', () => {
  it('a status on an id never heard of records the abort first, and the adopt that comes late is refused', async () => {
    const w = await world();
    expect(await adoptStatus(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).toBe('aborted');
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'not-adopted' });
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(w.studio.daemon.role).toBe('worker');
  });

  it('a crash right after the abort is recorded still refuses, the answer never having gone out', async () => {
    const w = await world();
    crashAt('abort.recorded');
    await expect(adoptStatus(w.studio.deps, ID, ASKER)).rejects.toThrow(HomeCrash);
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
  });

  it('a crash at the record through an abort still refuses, and a status takes the keys away, as no second abort comes', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    crashAt('abort.recorded');
    await expect(abortAdopt(w.studio.deps, ID)).rejects.toThrow(HomeCrash);
    expect(fs.existsSync(path.join(adoptDir(w.studio.paths, ID), 'in.tar'))).toBe(true);
    expect(await adoptStatus(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(false);
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'not-adopted' });
  });

  it('a staged adopt answers pending, which never lets the old home thaw, until it is aborted', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    expect(await adoptStatus(w.studio.deps, ID)).toMatchObject({ status: 'pending', phase: 'staged' });
    expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(false);
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  it('abort and status while another step holds the move answer pending, and an abort after the commit says adopted', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const running = installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
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
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
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
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    const { robots } = w.studio.daemon.held!;
    expect(robots.placed.unread).toBe(true);
    expect(robots.born.machine).toBeUndefined();
  });

  it('takes the old home\'s record into its registry, its token into workers.json, and its logins as what they were', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
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
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(w.studio.daemon.role).toBe('worker');
    expect(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).toBe(before);
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
    expect(readRegistry(w.studio.registryDir).find((m) => m.id === MAC)).toBeUndefined();
    // and a retry runs from what stayed staged, with the same token
    w.studio.daemon.noAnswer = false;
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(w.studio.daemon.held!.robots.placed.machine).toBeUndefined();
    expect(w.studio.daemon.held!.robots.here.machine).toBe(MAC);
  });

  it('refuses a change made while the link was down that no copy carries, restarting as the worker it was', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    fs.appendFileSync(w.studio.paths.outbox, `${JSON.stringify({ seq: 5, kind: 'mutation', data: { method: 'robot.update' } })}\n`);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(a).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(a.status === 'pending' && a.detail).toMatch(/robot\.update/);
    expect(w.studio.daemon.role).toBe('worker');
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  it('a start that rejects rolls back and starts nothing as a home, and a retry finishes once it starts', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.studio.daemon.stop();
    w.studio.daemon.startFails = 'the unit would not start';
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(a).toMatchObject({ status: 'pending', phase: 'rolledback', detail: 'the unit would not start' });
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
    expect(w.studio.daemon.role).toBeUndefined();
    delete w.studio.daemon.startFails;
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
  });

  it('a daemon that will not let go of its lock leaves the worker as it was, its daemon asked to start again', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    // stopped by no one: the fake's lock stays held through a stop that does nothing
    const held = w.studio.daemon.stop.bind(w.studio.daemon);
    w.studio.daemon.stop = () => Promise.resolve();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    const later = setInterval(() => vi.setSystemTime(Date.now() + 30_000), 20);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    clearInterval(later);
    vi.useRealTimers();
    w.studio.daemon.stop = held;
    expect(a).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(a.status === 'pending' && a.detail).toMatch(/did not stop/);
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  it('carries no key of the old machine, nor its token, its .env, its cache or its outbox', async () => {
    const w = await world();
    const dir = makeHome();
    const file = path.join(dir, 'a.tar');
    fs.writeFileSync(file, w.archive.bytes);
    const names = execFileSync('tar', ['-t', '-f', file], { encoding: 'utf8' }).split('\n').filter(Boolean).map((n) => n.replace(/^\.\//, ''));
    for (const never of ['token', '.env', 'node.json', 'cache/mirror-state.json', 'journal/outbox.ndjson', 'journal/acked', 'workers.json']) expect(names).not.toContain(never);
    for (const goes of ['fleet.json', 'state.json', 'push.json', 'mobile-pass', 'docs/fleet/note.md']) expect(names).toContain(goes);
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(fs.existsSync(w.studio.paths.env)).toBe(false);
  });

  it('holds a name ustar cannot carry back, naming it, and removes its copies of the keys', async () => {
    const w = await world();
    await w.mac.daemon.stop();
    const long = `${'x'.repeat(120)}.md`;
    fs.writeFileSync(path.join(w.mac.paths.docs, long), 'long');
    await expect(packFleet(w.mac.paths, w.manifest)).rejects.toThrow(new RegExp(`docs/${long}`));
    expect(fs.existsSync(adoptDir(w.mac.paths, ID))).toBe(false);
  });

  it('follows a linked fleet.json or docs at the top, and no link inside them', async () => {
    const w = await world();
    await w.mac.daemon.stop();
    const dotfiles = makeHome();
    fs.writeFileSync(path.join(dotfiles, 'id_rsa'), 'PRIVATE KEY BYTES');
    fs.symlinkSync(dotfiles, path.join(w.mac.paths.docs, 'linked'));
    fs.symlinkSync(path.join(dotfiles, 'id_rsa'), path.join(w.mac.paths.docs, 'fleet', 'key.md'));
    fs.renameSync(w.mac.paths.fleetConfig, path.join(dotfiles, 'fleet.json'));
    fs.symlinkSync(path.join(dotfiles, 'fleet.json'), w.mac.paths.fleetConfig);
    const { bytes, sha256 } = await packFleet(w.mac.paths, w.manifest);
    expect(bytes.includes(Buffer.from('PRIVATE KEY BYTES'))).toBe(false);
    await stageAdopt(w.studio.deps, ID, sha256, bytes);
    expect(JSON.parse(fs.readFileSync(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'fleet.json'), 'utf8')).id).toBe(FLEET);
    expect(fs.readFileSync(path.join(adoptDir(w.studio.paths, ID), 'incoming', 'docs', 'fleet', 'note.md'), 'utf8')).toBe('a note');
  });

  it('confirms only what has gone through: a staged move keeps its folder', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    expect(await confirmAdopt(w.studio.deps, ID)).toMatchObject({ status: 'pending', phase: 'staged' });
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(true);
  });

  describe('the docs it takes', () => {
    const shaOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    const fleetDocs = (w: Awaited<ReturnType<typeof world>>) => Object.fromEntries(fs.readdirSync(path.join(w.studio.paths.docs, 'fleet')).map((n) => [n, fs.readFileSync(path.join(w.studio.paths.docs, 'fleet', n), 'utf8')]));
    const workerDoc = (w: Awaited<ReturnType<typeof world>>, rel: string, text: string) => {
      const f = path.join(w.studio.paths.cache, 'docs', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    };
    const synced = (w: Awaited<ReturnType<typeof world>>, o: Record<string, string>) => {
      fs.mkdirSync(path.dirname(w.studio.paths.docsSynced), { recursive: true });
      fs.writeFileSync(w.studio.paths.docsSynced, JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shaOf(v)]))));
    };
    const adopt = async (w: Awaited<ReturnType<typeof world>>) => {
      await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
      expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    };

    it('a doc only the worker changed goes in over the archive\'s', async () => {
      const w = await world();
      workerDoc(w, 'fleet/note.md', 'worker edit');
      synced(w, { 'fleet/note.md': 'a note' });
      await adopt(w);
      expect(fleetDocs(w)).toEqual({ 'note.md': 'worker edit' });
    });

    it('a doc changed on both keeps the home\'s, with the worker\'s beside it as a conflict copy', async () => {
      const w = await world();
      workerDoc(w, 'fleet/note.md', 'worker edit');
      synced(w, { 'fleet/note.md': 'older' });
      await adopt(w);
      const docs = fleetDocs(w);
      expect(docs['note.md']).toBe('a note');
      expect(Object.entries(docs).find(([n]) => n.endsWith('.conflict.md'))?.[1]).toBe('worker edit');
    });

    it('a doc the worker removed stays removed, and one the home changed since stays', async () => {
      const w = await world();
      synced(w, { 'fleet/note.md': 'a note', 'fleet/gone.md': 'gone' });
      await adopt(w);
      expect(fleetDocs(w)['note.md']).toBeUndefined();
      const again = await world();
      synced(again, { 'fleet/note.md': 'older' });
      await adopt(again);
      expect(fleetDocs(again)['note.md']).toBe('a note');
    });

    it('a repo\'s notes follow every robot to the name its path has on the new home, what the worker carried among them', async () => {
      const w = await world();
      await w.mac.daemon.stop();
      const s = stateOf(w.mac);
      s.robots.placed.cwd = '/home/ada/proj';
      s.robots.here.cwd = '/Users/ada/hproj';
      fs.writeFileSync(w.mac.paths.state, JSON.stringify(s));
      w.studio.daemon.held!.robots.placed.cwd = '/home/ada/proj';
      for (const root of ['/Users/ada/proj', '/Users/ada/hproj']) {
        fs.mkdirSync(path.join(w.mac.paths.docs, 'repos', repoSlug(root)), { recursive: true });
        fs.writeFileSync(path.join(w.mac.paths.docs, 'repos', repoSlug(root), 'n.md'), root);
      }
      const manifest: HomeManifest = w.manifest;
      const packed = await packFleet(w.mac.paths, manifest);
      await w.mac.daemon.start();
      workerDoc(w, `repos/${repoSlug('/Users/ada/proj')}/mine.md`, 'written on the worker');
      await stageAdopt(w.studio.deps, ID, packed.sha256, packed.bytes);
      expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
      const repos = path.join(w.studio.paths.docs, 'repos');
      expect(fs.readFileSync(path.join(repos, repoSlug('/home/ada/proj'), 'n.md'), 'utf8')).toBe('/Users/ada/proj');
      expect(fs.readFileSync(path.join(repos, repoSlug('/home/ada/proj'), 'mine.md'), 'utf8')).toBe('written on the worker');
      expect(fs.readFileSync(path.join(repos, repoSlug('/home/ada/hproj'), 'n.md'), 'utf8')).toBe('/Users/ada/hproj');
      expect(fs.existsSync(path.join(repos, repoSlug('/Users/ada/proj')))).toBe(false);
    });
  });

  it('clears what it staged only once both sides have landed', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
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
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    expect(fired()).toBe(true);
    w.studio.daemon.kill();
    return w;
  };

  // each crash that falls while the worker's files are not all back, walked to the first count it never reaches
  const walk = async (one: (n: number) => Promise<boolean>): Promise<number> => {
    let n = 1;
    for (; n < 40 && await one(n); n++) cleanHomes();
    return n - 1;
  };

  it.each(CUT_BEFORE_COMMIT)('%s: a start settles it with the old home frozen, and a retry finishes the move', async (point) => {
    const w = await crashed(point);
    await w.studio.daemon.start();
    expect(homes(w).filter((h) => h === 'mac')).toEqual([]);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    expect(a.status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
    expect(w.studio.daemon.held!.robots.here.machine).toBe(MAC);
    expect(w.studio.daemon.held!.robots.placed.machine).toBeUndefined();
    expect(homes(w)).toEqual(['studio']);
  });

  it.each(CUT_BEFORE_COMMIT)('%s: called off, every original is back and the delayed adopt is refused', async (point) => {
    const w = await crashed(point);
    const worker = 'worker.json';
    w.studio.daemon.noAnswer = true;
    const a = await abortAdopt(w.studio.deps, ID);
    expect(a).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(path.join(w.studio.paths.home, worker))).toBe(true);
    expect(JSON.parse(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).id).not.toBe(FLEET);
    expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
    expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(w.studio.daemon.role === 'home').toBe(false);
  });

  it.each(CUT_BEFORE_COMMIT)('%s: a status settles it itself: no home that answers, no adopted, and the worker\'s daemon up on its own files', async (point) => {
    const w = await crashed(point);
    w.studio.daemon.noAnswer = true;
    const a = await adoptStatus(w.studio.deps, ID);
    expect(a.status).toBe('pending');
    expect(lastOf(w)).toBe('rolledback');
    expect(w.studio.daemon.role).toBe('worker');
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
    expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
  });

  it.each(['adopt.installed', 'adopt.started'] as const)('%s: an abort with the daemon down starts it before it decides, and a home that answers is not rolled back', async (point) => {
    const w = await crashed(point);
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(false);
  });

  it('a start that rejects after its restart is asked all the same: a home that answers goes forward', async () => {
    const w = await crashed('adopt.started');
    await w.studio.daemon.start();
    w.studio.daemon.held!.robots.here.note = 'written after the start';
    w.studio.daemon.startFails = 'enableUnit failed';
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    expect(w.studio.daemon.held!.robots.here.note).toBe('written after the start');
  });

  it('restore.restarting: a crash after the files are back and before the start leaves a status or an abort to start the worker, and a thaw only then', async () => {
    const forAbort = await world();
    await staged(forAbort);
    forAbort.studio.daemon.noAnswer = true;
    crashAt('restore.restarting');
    await expect(installAdopt(forAbort.studio.deps, ID, ADOPT_KEY, forAbort.enrolment)).rejects.toThrow(HomeCrash);
    disarmCrash();
    forAbort.studio.daemon.kill();
    expect(journalLines(forAbort.studio.paths, ID).at(-1)?.phase).toBe('stopping');
    expect(await abortAdopt(forAbort.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(forAbort.studio.daemon.role).toBe('worker');
    cleanHomes();
    const forStatus = await world();
    await staged(forStatus);
    forStatus.studio.daemon.noAnswer = true;
    crashAt('restore.restarting');
    await expect(installAdopt(forStatus.studio.deps, ID, ADOPT_KEY, forStatus.enrolment)).rejects.toThrow(HomeCrash);
    disarmCrash();
    forStatus.studio.daemon.kill();
    expect(await adoptStatus(forStatus.studio.deps, ID)).toMatchObject({ status: 'pending', phase: 'rolledback' });
    expect(forStatus.studio.daemon.role).toBe('worker');
  });

  it('adopt.stopped: an abort starts the worker\'s daemon again', async () => {
    const w = await crashed('adopt.stopped');
    expect(w.studio.daemon.role).toBeUndefined();
    expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(w.studio.daemon.role).toBe('worker');
  });

  it.each(['adopt.installed', 'adopt.started'] as const)('%s: an abort with a home answering goes forward, as a rollback would lose what it took since', async (point) => {
    const w = await crashed(point);
    await w.studio.daemon.start();
    expect(w.studio.daemon.role).toBe('home');
    w.studio.daemon.held!.robots.here.note = 'written after the start';
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('adopted');
    expect(w.studio.daemon.role).toBe('home');
    expect(w.studio.daemon.held!.robots.here.note).toBe('written after the start');
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(false);
  });

  it('adopt.committed through a status: the commit it found goes forward from its own journal', async () => {
    const w = await world();
    await staged(w);
    crashAt('adopt.started');
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    w.studio.daemon.kill();
    crashAt('adopt.committed');
    await expect(adoptStatus(w.studio.deps, ID)).rejects.toThrow(HomeCrash);
    expect(w.studio.daemon.role).toBe('home');
    expect((await adoptStatus(w.studio.deps, ID)).status).toBe('adopted');
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('adopted');
  });

  it('a retry with no start over a half install restores first, so what it keeps aside stays the worker\'s', async () => {
    const w = await crashed('adopt.file', 5);
    crashAt('adopt.file', 2);
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    w.studio.daemon.kill();
    expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(JSON.parse(fs.readFileSync(w.studio.paths.fleetConfig, 'utf8')).id).not.toBe(FLEET);
    expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
  });

  describe('a crash inside the rollback of a home that never answered', () => {
    // a worker going by the fleet's id, as a join's or a way back's does, whose restored fleet.json alone could read as the home's
    const rolling = async (point: HomeFailpoint, n: number) => {
      const w = await world({ sameId: true });
      await w.studio.daemon.stop();
      await w.studio.daemon.start();
      await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
      const before = sha(w.studio.paths.state);
      w.studio.daemon.noAnswer = true;
      const fell = crashAt(point, n);
      await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment).catch((e: unknown) => { if (!(e instanceof HomeCrash)) throw e; });
      disarmCrash();
      w.studio.daemon.kill();
      w.studio.daemon.noAnswer = false;
      return { w, fell: fell(), before };
    };

    it('at every file: a status never commits on what is left, and the worker comes back whole', async () => {
      const files = await walk(async (n) => {
        const { w, fell } = await rolling('restore.file', n);
        if (!fell) return false;
        const a = await adoptStatus(w.studio.deps, ID);
        expect(a).toMatchObject({ status: 'pending', phase: 'rolledback' });
        expect(w.studio.daemon.role).toBe('worker');
        expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
        expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
        expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
        return true;
      });
      expect(files).toBe(15);
    }, 120_000);

    it('at every file: a start alone restores it', async () => {
      const files = await walk(async (n) => {
        const { w, fell } = await rolling('restore.file', n);
        if (!fell) return false;
        await w.studio.daemon.start();
        expect(w.studio.daemon.role).toBe('worker');
        expect(lastOf(w)).toBe('rolledback');
        expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
        return true;
      });
      expect(files).toBe(15);
    }, 120_000);
  });

  it('adopt.committed: recovery goes forward, the answer the same as it was', async () => {
    const w = await crashed('adopt.committed');
    await w.studio.daemon.start();
    expect(w.studio.daemon.role).toBe('home');
    expect((await adoptStatus(w.studio.deps, ID)).status).toBe('adopted');
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('adopted');
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
    const files = await walk(async (n) => {
      const w = await crashed('adopt.dropped');
      const fired = crashAt('restore.file', n);
      const start = await w.studio.daemon.start().then(() => 'started', (e: unknown) => { if (!(e instanceof HomeCrash)) throw e; return 'crashed'; });
      disarmCrash();
      if (!fired()) { expect(start).toBe('started'); return false; }
      w.studio.daemon.kill();
      await w.studio.daemon.start();
      expect(w.studio.daemon.role).toBe('worker');
      expect(stateOf(w.studio).robots.placed.machine).toBe(STUDIO);
      expect(stateOf(w.studio).machines?.[MAC]?.snapshot?.version).toBe(7);
      expect(fs.readFileSync(w.studio.paths.epoch, 'utf8')).toBe('e1\n');
      expect(fs.readFileSync(w.studio.paths.phone, 'utf8')).toContain('serving');
      return true;
    });
    expect(files).toBe(15);
  }, 120_000);

  it('a crash between two files replaced, up to the last, comes back with the worker\'s own', async () => {
    const files = await walk(async (n) => {
      const w = await world();
      await staged(w);
      const fell = crashAt('adopt.file', n);
      const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment).catch((e: unknown) => { if (!(e instanceof HomeCrash)) throw e; return undefined; });
      disarmCrash();
      if (!fell()) { expect(a?.status).toBe('adopted'); return false; }
      w.studio.daemon.kill();
      await w.studio.daemon.start();
      expect(w.studio.daemon.role).toBe('worker');
      expect(fs.readFileSync(w.studio.paths.phone, 'utf8')).toContain('serving');
      return true;
    });
    expect(files).toBe(12);
  }, 120_000);
});

describe('the join', () => {
  const JOIN = HOME_FAILPOINTS.filter((p) => p.startsWith('join.'));
  const adopted = async () => {
    const w = await world();
    await staged(w);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    return { w, marked: { ...marker(), enrol: a.enrol } as HomeMoving };
  };
  const joined = (w: Awaited<ReturnType<typeof world>>) => {
    for (const gone of [w.mac.paths.mirrorState, w.mac.paths.outbox, w.mac.paths.acked, w.mac.paths.workersFile, w.mac.paths.homeServed]) expect(fs.existsSync(gone)).toBe(false);
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
    putMarker(w.mac.paths, marked);
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
    putMarker(w.mac.paths, marked);
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
    expect(() => createMarker(w.mac.paths, marker())).toThrow(HomeCrash);
    expect(readMarker(w.mac.paths)?.id).toBe(ID);
    expect(homeGate(w.mac.paths, w.mac.registryDir).frozen?.id).toBe(ID);
  });

  it('a marker that cannot be read stops the start as a config does, which waits for it to be fixed: no guess that it may run as a home', async () => {
    const w = await world();
    await w.mac.daemon.stop();
    fs.writeFileSync(w.mac.paths.homeMoving, '{ half');
    await expect(w.mac.daemon.start()).rejects.toThrow(InvalidConfig);
    w.mac.daemon.kill();
  });

  it('a marker written back past its join changes nothing: the journal says it is over', async () => {
    const { w, marked } = await adopted();
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marked);
    await w.mac.daemon.start();
    await w.mac.daemon.stop();
    const live = stateOf(w.mac);
    live.robots.here.note = 'written after the join';
    fs.writeFileSync(w.mac.paths.state, JSON.stringify(live));
    fs.mkdirSync(path.dirname(w.mac.paths.outbox), { recursive: true });
    fs.writeFileSync(w.mac.paths.outbox, 'an outbox of today\n');
    putMarker(w.mac.paths, marked);
    await w.mac.daemon.start();
    expect(stateOf(w.mac).robots.here.note).toBe('written after the join');
    expect(fs.readFileSync(w.mac.paths.outbox, 'utf8')).toBe('an outbox of today\n');
    expect(fs.existsSync(w.mac.paths.homeMoving)).toBe(false);
  });

  it('a note written between the cut and the join goes in the worker\'s copy, for it to send, and one the cut took does not', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    fs.writeFileSync(path.join(w.mac.paths.docs, 'fleet', 'late.md'), 'written while frozen');
    fs.writeFileSync(path.join(w.mac.paths.docs, 'repos', 'x', 'note.md'), 'changed while frozen');
    const dotfiles = makeHome();
    fs.writeFileSync(path.join(dotfiles, 'id_rsa'), 'PRIVATE KEY BYTES');
    fs.symlinkSync(dotfiles, path.join(w.mac.paths.docs, 'linked'));
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, { ...marker(), enrol: a.enrol });
    await w.mac.daemon.start();
    const copy = path.join(w.mac.paths.cache, 'docs');
    expect(fs.readFileSync(path.join(copy, 'fleet', 'late.md'), 'utf8')).toBe('written while frozen');
    expect(fs.readFileSync(path.join(copy, 'repos', 'x', 'note.md'), 'utf8')).toBe('changed while frozen');
    expect(fs.existsSync(path.join(copy, 'linked'))).toBe(false);
    expect(fs.existsSync(path.join(copy, 'fleet', 'note.md'))).toBe(false);
    expect(fs.readdirSync(w.mac.paths.home).filter((n) => n.startsWith('docs-cut-'))).toEqual([]);
  });

  it('what the old home did since the cut reaches the new home through the real worker docs, a change over the cut, a new note and a removal, and survives the first tar', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const atCut = sha(path.join(w.mac.paths.docs, 'repos', 'x', 'note.md'));
    const noteAtCut = sha(path.join(w.mac.paths.docs, 'fleet', 'note.md'));
    fs.writeFileSync(path.join(w.mac.paths.docs, 'fleet', 'late.md'), 'written while frozen');
    fs.writeFileSync(path.join(w.mac.paths.docs, 'repos', 'x', 'note.md'), 'changed while frozen');
    fs.rmSync(path.join(w.mac.paths.docs, 'fleet', 'note.md'));
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, { ...marker(), enrol: a.enrol });
    await w.mac.daemon.start();
    const journaled: Record<string, { base?: string; kind: string }> = {};
    let seq = 0;
    const dir = path.join(w.mac.paths.cache, 'docs');
    const docs = new WorkerDocs({
      dir, file: w.mac.paths.docsSynced, stage: path.join(w.mac.paths.cache, 'stage'), log: silentLogger,
      connection: { journal: (kind: string, d: { path: string; base?: string }) => { journaled[d.path] = { kind, ...(d.base && { base: d.base }) }; return ++seq; }, receiveBlob: () => Promise.reject(new Error('no blob')) } as never,
    });
    docs.start();
    docs.stop();
    expect(journaled).toEqual({
      'fleet/late.md': { kind: 'docs.write' },
      'repos/x/note.md': { kind: 'docs.write', base: atCut },
      'fleet/note.md': { kind: 'docs.delete', base: noteAtCut },
    });
    const empty = fs.mkdtempSync(path.join(w.mac.paths.home, 'tar-'));
    (docs as unknown as { settle(from: string, seq: number): void }).settle(empty, 0);
    expect(fs.readFileSync(path.join(dir, 'fleet', 'late.md'), 'utf8')).toBe('written while frozen');
  });

  it.each([[false], [true]])('a repo note the old home changed, made or removed since the cut lands where the new home has its folder, after the first tar too (the new name taken at the cut: %s)', async (clash) => {
    const w = await world();
    await w.mac.daemon.stop();
    const s = stateOf(w.mac);
    s.robots.here.cwd = '/Users/ada/hproj';
    fs.writeFileSync(w.mac.paths.state, JSON.stringify(s));
    const [was, now] = [repoSlug('/Users/ada/hproj'), repoSlug('/home/ada/hproj')];
    const doc = (rel: string, text: string) => { const f = path.join(w.mac.paths.docs, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    doc(`repos/${was}/n.md`, 'at the cut');
    doc(`repos/${was}/gone.md`, 'removed since the cut');
    // a folder by the new name already, which the new home keeps, and so keeps the old one under its own name
    if (clash) doc(`repos/${now}/other.md`, 'there at the cut');
    const packed = await packFleet(w.mac.paths, w.manifest);
    await w.mac.daemon.start();
    doc(`repos/${was}/n.md`, 'since the cut');
    fs.rmSync(path.join(w.mac.paths.docs, 'repos', was, 'gone.md'));
    doc(`repos/${was}/new.md`, 'new since the cut');
    await stageAdopt(w.studio.deps, ID, packed.sha256, packed.bytes);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, { ...marker(), enrol: a.enrol });
    await w.mac.daemon.start();
    const copy = path.join(w.mac.paths.cache, 'docs');
    const events: { kind: 'docs.write' | 'docs.delete'; data: { path: string } }[] = [];
    const docs = new WorkerDocs({ dir: copy, file: w.mac.paths.docsSynced, stage: path.join(w.mac.paths.cache, 'stage'), log: silentLogger,
      connection: { journal: (kind: 'docs.write' | 'docs.delete', data: { path: string }) => { events.push({ kind, data }); return events.length; }, receiveBlob: () => Promise.reject(new Error('none')) } as never });
    docs.start();
    docs.stop();
    const home = new HomeDocs(w.studio.paths.docs, silentLogger, () => 'mac', () => true);
    for (const e of events) home.apply(e.kind, e.data, MAC);
    (docs as unknown as { settle(from: string, seq: number): void }).settle(w.studio.paths.docs, events.length);
    const repos = path.join(w.studio.paths.docs, 'repos');
    const lands = clash ? was : now;
    expect(fs.existsSync(path.join(repos, was))).toBe(clash);
    expect(fs.readdirSync(path.join(repos, lands)).sort()).toEqual(['n.md', 'new.md']);
    expect(fs.readFileSync(path.join(repos, lands, 'n.md'), 'utf8')).toBe('since the cut');
    expect(fs.readFileSync(path.join(copy, 'repos', lands, 'new.md'), 'utf8')).toBe('new since the cut');
  });

  it('a kept workers.json is where Files refuses it', async () => {
    const { w, marked } = await adopted();
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marked);
    await w.mac.daemon.start();
    const kept = `${w.mac.paths.workersFile}.home-${ID}`;
    expect(fs.readFileSync(kept, 'utf8')).toContain('token');
    expect(inStagedMove(kept)).toBe(true);
  });

  it('run again on what it wrote, it derives the same state', async () => {
    const { w, marked } = await adopted();
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marked);
    joinAsWorker(w.mac.paths, marked as HomeMoving & { enrol: NonNullable<HomeMoving['enrol']> }, w.mac.registryDir);
    const once = fs.readFileSync(w.mac.paths.state, 'utf8');
    putMarker(w.mac.paths, marked);
    joinAsWorker(w.mac.paths, marked as HomeMoving & { enrol: NonNullable<HomeMoving['enrol']> }, w.mac.registryDir);
    expect(fs.readFileSync(w.mac.paths.state, 'utf8')).toBe(once);
  });
});

describe('two homes are impossible', () => {
  // a real freeze on the old home, asking the machine that takes the fleet as its driver is gone: each answer it acts on, it acts on as the daemon does
  const asking = (w: Awaited<ReturnType<typeof world>>) => {
    let restarted = false;
    const freeze = new HomeFreeze({
      paths: w.mac.paths, store: { state: w.mac.daemon.held!, flush: () => Promise.resolve(true) }, me: MAC, log: silentLogger,
      links: { barrier: () => Promise.resolve(true), hold: () => {} }, background: { pause: () => {}, resume: () => {} },
      phone: { get: () => Promise.resolve(phoneAt(false)), set: () => Promise.resolve(phoneAt(false)) },
      ask: () => adoptStatus(w.studio.deps, ID, ASKER), restart: () => { restarted = true; },
    }, readMarker(w.mac.paths));
    return { freeze, restarted: () => restarted };
  };
  // the old home takes writes only with its freeze ended, and the new one only as a home
  const writers = (w: Awaited<ReturnType<typeof world>>, freeze: HomeFreeze): number => Number(!freeze.active && !w.mac.daemon.role?.startsWith('worker')) + Number(w.studio.daemon.role === 'home');

  it.each(ON_ADOPT)('%s: through the crash and the old home asking, at most one daemon takes writes, and the move ends', async (point) => {
    const w = await world();
    await staged(w);
    crashAt(point);
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    w.studio.daemon.kill();
    const { freeze, restarted } = asking(w);
    expect(writers(w, freeze)).toBe(0);
    await w.studio.daemon.start();
    for (let i = 0; i < 2 && !restarted(); i++) {
      await freeze.settle('status');
      expect(writers(w, freeze)).toBeLessThanOrEqual(1);
    }
    freeze.stop();
    // what a crash leaves is called off, or goes through, by the retry its driver offers
    if (!restarted()) {
      const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
      expect(a.status).toBe('adopted');
      await freeze.settle('status');
      expect(restarted()).toBe(true);
    }
    expect(readMarker(w.mac.paths)?.enrol).toBeDefined();
    await w.mac.daemon.stop();
    await w.mac.daemon.start();
    expect(homes(w)).toEqual(['studio']);
    expect(w.mac.daemon.role).toBe('worker');
  });

  it.each(CUT_BEFORE_COMMIT)('%s: a person\'s abort thaws the old home only with the new one given up for good', async (point) => {
    const w = await world();
    await staged(w);
    crashAt(point);
    await expect(installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).rejects.toThrow(HomeCrash);
    w.studio.daemon.kill();
    const { freeze } = asking(w);
    w.studio.daemon.noAnswer = true;
    expect((await abortAdopt(w.studio.deps, ID)).status).toBe('not-adopted');
    await freeze.settle('status');
    freeze.stop();
    expect(freeze.active).toBe(false);
    expect(readMarker(w.mac.paths)).toBeUndefined();
    expect(w.studio.daemon.role).not.toBe('home');
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(writers(w, freeze)).toBe(1);
  });
});

it('every home failpoint belongs to one suite', () => {
  expect(new Set([...POINTS_OF.move, ...POINTS_OF.back, ...POINTS_OF.driver]).size).toBe(HOME_FAILPOINTS.length);
});
