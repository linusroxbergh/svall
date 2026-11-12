import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerFile, type AdoptAnswer, type HomeMoveId, type HomeMoving } from '@svall/protocol';
import { askAcross } from '../../src/fleet/home-far.js';
import { HomeFreeze } from '../../src/fleet/home-freeze.js';
import { abortAdopt, addEnrol, adoptDir, adoptStatus, createMarker, endMove, enter, homeGate, installAdopt, journalLines, packFleet, readMarker, settleMove, stageAdopt, TOLD_UNMARKED, writeEnrol } from '../../src/fleet/home-move.js';
import { daemonLock } from '../../src/kernel-lock.js';
import { resolvePaths } from '../../src/paths.js';
import { SshError } from '../../src/link/ssh.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { ADOPT_KEY, ASKER, FLEET, ID, KEY, MAC, marker, STUDIO, world, putMarker } from './home-world.js';

afterEach(cleanHomes);

const OTHER = 'hm_otherother' as HomeMoveId;
type AskOp = 'status' | 'abort';
const told = (() => { const { ask: _a, ...bare } = marker(); return bare; })();
const marked = (m = marker()) => {
  const paths = resolvePaths(makeHome());
  putMarker(paths, m);
  return paths;
};

describe('what a machine a move leaves says of that move', () => {
  const frozenMac = async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marker());
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('frozen');
    return w;
  };

  it.each([['status', adoptStatus], ['abort', abortAdopt]] as const)('svall fleet %s on it refuses, naming fleet home abort, writes nothing, and the new home having committed it joins', async (_op, command) => {
    const w = await frozenMac();
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    await expect(command(w.mac.deps, ID)).rejects.toThrow(/svall fleet home abort/);
    expect(journalLines(w.mac.paths, ID)).toEqual([]);
    expect(readMarker(w.mac.paths)?.id).toBe(ID);
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('frozen');
    putMarker(w.mac.paths, { ...marker(), enrol: a.enrol });
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('worker');
    expect(w.studio.daemon.role).toBe('home');
  });

  it('asked of another id it says nothing for good, as a home serves no one, and the marker stands', async () => {
    const paths = marked();
    const d = { paths, me: marker().from, daemon: { stop: () => Promise.resolve(), start: () => Promise.resolve(), answersHome: () => Promise.resolve(false) } };
    expect(await adoptStatus(d, OTHER, ASKER)).toMatchObject({ status: 'pending', phase: 'unknown' });
    expect(await abortAdopt(d, OTHER, ASKER)).toMatchObject({ status: 'pending', phase: 'unknown' });
    expect(readMarker(paths)?.id).toBe(ID);
    expect(homeGate(paths).frozen?.id).toBe(ID);
  });

  it('its own refusal of the id from before the mark ends nothing: a start stays frozen', () => {
    const paths = resolvePaths(makeHome());
    endMove(paths, ID, { by: 'refused' });
    putMarker(paths, marker());
    expect(homeGate(paths).frozen?.id).toBe(ID);
    expect(readMarker(paths)?.id).toBe(ID);
  });
});

describe('a not-adopted takes proof: this folder holds the fleet and still serves the home that asks', () => {
  const NO_PROOF = { status: 'pending', phase: 'unknown' };
  const BOTH = [['status', adoptStatus], ['abort', abortAdopt]] as const;
  const tree = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
  const adoptedThere = async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marker());
    await w.mac.daemon.start();
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
    return w;
  };
  // the marked home's own daemon, asking there as it does
  const thawsOn = async (w: Awaited<ReturnType<typeof world>>, there: typeof w.studio.deps) => {
    const freeze = new HomeFreeze({ paths: w.mac.paths, me: MAC, ask: (m: HomeMoving, op: AskOp) => (op === 'status' ? adoptStatus(there, m.id, ASKER) : abortAdopt(there, m.id, ASKER)) } as never, marker());
    await freeze.settle('status');
    await freeze.settle('abort');
    freeze.stop();
    return { active: freeze.active, marker: readMarker(w.mac.paths)?.id };
  };

  it.each(BOTH)('%s of an id never heard of, from the home it serves: refused for good, and what comes late is refused', async (_op, ask) => {
    const w = await world();
    expect(await ask(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
    expect(journalLines(w.studio.paths, ID).map((l) => l.phase)).toEqual(['aborted']);
    expect(await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes)).toMatchObject({ status: 'not-adopted' });
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toMatchObject({ status: 'not-adopted' });
    expect(await ask(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
  });

  it.each(BOTH)('%s on a machine now home, its journal and staged folder lost: pending, nothing written, and the old home stays frozen', async (_op, ask) => {
    const w = await adoptedThere();
    fs.rmSync(w.studio.paths.homeMoves, { recursive: true });
    fs.rmSync(adoptDir(w.studio.paths, ID), { recursive: true });
    const before = tree(w.studio.paths.home);
    expect(await ask(w.studio.deps, ID, ASKER)).toMatchObject(NO_PROOF);
    expect(tree(w.studio.paths.home)).toEqual(before);
    expect(w.studio.daemon.role).toBe('home');
    expect(await thawsOn(w, w.studio.deps)).toEqual({ active: true, marker: ID });
  });

  it.each(BOTH)('%s beside adopt-<id> with its journal lost: pending, and what was staged stays, on a worker too', async (_op, ask) => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    fs.rmSync(w.studio.paths.homeMoves, { recursive: true });
    const before = tree(w.studio.paths.home);
    expect(await ask(w.studio.deps, ID, ASKER)).toMatchObject(NO_PROOF);
    expect(tree(w.studio.paths.home)).toEqual(before);
  });

  it.each(BOTH)('%s of a folder renamed away after the commit: pending, with no folder made', async (_op, ask) => {
    const w = await adoptedThere();
    const asked = w.studio.paths.home;
    fs.renameSync(asked, `${asked}-renamed`);
    expect(await ask(w.studio.deps, ID, ASKER)).toMatchObject(NO_PROOF);
    expect(fs.existsSync(asked)).toBe(false);
    expect(await thawsOn(w, w.studio.deps)).toEqual({ active: true, marker: ID });
    expect(fs.existsSync(asked)).toBe(false);
  });

  it.each([
    ['of another fleet', { fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' }],
    ['of another home', { homeMachineId: 'aaaaaaaa-1111-4222-8333-444444444444' }],
  ])('a folder that is a worker %s: pending, and nothing written', async (_of, other) => {
    const w = await world();
    fs.writeFileSync(w.studio.paths.workerFile, JSON.stringify({ homeMachineId: MAC, fleetId: FLEET, token: 'b'.repeat(48), homeName: 'mac', ...other }));
    const before = tree(w.studio.paths.home);
    for (const [, ask] of BOTH) expect(await ask(w.studio.deps, ID, ASKER)).toMatchObject(NO_PROOF);
    expect(tree(w.studio.paths.home)).toEqual(before);
  });

  it.each(BOTH)('%s with no home named: pending, and nothing written', async (_op, ask) => {
    const w = await world();
    const before = tree(w.studio.paths.home);
    expect(await ask(w.studio.deps, ID)).toMatchObject(NO_PROOF);
    expect(tree(w.studio.paths.home)).toEqual(before);
  });

  it.each(BOTH)('%s of an id refused here earlier, on a machine that serves that home no longer: pending, until it does again', async (_op, ask) => {
    const w = await world();
    expect(await abortAdopt(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
    const worker = fs.readFileSync(w.studio.paths.workerFile);
    fs.rmSync(w.studio.paths.workerFile);
    expect(await ask(w.studio.deps, ID, ASKER)).toMatchObject(NO_PROOF);
    fs.writeFileSync(w.studio.paths.workerFile, worker);
    expect(await ask(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
  });

  it('a staged id is called off for the home it came from, for a person with no home named, and for no other home', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    expect(await abortAdopt(w.studio.deps, ID, { ...ASKER, machine: STUDIO })).toMatchObject(NO_PROOF);
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).toBe('staged');
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(true);
    expect(await abortAdopt(w.studio.deps, ID)).toEqual({ status: 'not-adopted' });
    expect(fs.existsSync(adoptDir(w.studio.paths, ID))).toBe(false);
    expect(await abortAdopt(w.studio.deps, ID, ASKER)).toEqual({ status: 'not-adopted' });
  });
});

describe('a marked home believes only the machine it marked for', () => {
  // as `svall version --json` answers there
  const VERSION = { release: 'r', signed: false, machineId: STUDIO, protocol: 1, stateSchema: 1, runtime: { node: 'v24', platform: 'linux', arch: 'x64' } };
  const HOME = { ...VERSION, role: 'home', fleetId: FLEET };
  const WORKER = { ...VERSION, role: 'worker', worker: { homeMachineId: MAC, homeName: 'mac', fleetId: FLEET } };
  const ANOTHER_FLEET = '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70';
  const ENROL = { worker: WorkerFile.parse({ homeMachineId: STUDIO, fleetId: FLEET, token: 'b'.repeat(48), homeName: 'studio' }) };
  // `fleet facts` there waits on a tailscaled that does not answer
  const farAt = (version: object | undefined, said: AdoptAnswer = { status: 'not-adopted' }) => {
    const lines: string[] = [];
    let opened = 0;
    const open = () => {
      opened++;
      return Promise.resolve({
        run: (argv: string[]) => {
          const line = argv.join(' ');
          lines.push(line);
          if (line.includes("'facts'")) return Promise.resolve({ code: null, signal: 'SIGTERM', stderr: 'tailscale status timed out', stdout: '' });
          const out = line.includes("'version'") ? version : said;
          return Promise.resolve(out ? { code: 0, signal: null, stderr: '', stdout: JSON.stringify(out) } : { code: 1, signal: null, stderr: 'svall: no fleet here', stdout: '' });
        },
        close: () => Promise.resolve(),
      });
    };
    return { open: open as never, lines, opened: () => opened };
  };
  const freezeAt = (paths: ReturnType<typeof marked>, far: ReturnType<typeof farAt>) => new HomeFreeze({ paths, me: MAC, restart: () => {}, ask: (m: HomeMoving, op: AskOp) => askAcross(m, op, far.open) } as never, marker());

  it.each([['its home', HOME], ['still a worker of the home that asks', WORKER]])('reads the far fleet\'s word for itself on the connection it asks over, as %s, from its files alone, and says who asks', async (_as, version) => {
    const far = farAt(version);
    expect(await askAcross(marker(), 'abort', far.open)).toEqual({ status: 'not-adopted' });
    expect(far.opened()).toBe(1);
    expect(far.lines).toEqual([expect.stringMatching(/ --json 'version'$/), expect.stringMatching(new RegExp(`'fleet' 'abort' '${ID}' '--asker' '${MAC}' '--fleet' '${FLEET}'$`))]);
  });

  it('a far command ssh lost says so, what ssh said behind; one that failed says it did not finish, its exit behind, with no empty tail', async () => {
    const answering = (code: number, stderr: string) => (() => Promise.resolve({
      run: (argv: string[]) => Promise.resolve(argv.join(' ').includes("'version'") ? { code: 0, signal: null, stderr: '', stdout: JSON.stringify(HOME) } : { code, signal: null, stderr, stdout: '' }),
      close: () => Promise.resolve(),
    })) as never;
    const lost = 'ssh lost the connection before svall fleet abort answered';
    await expect(askAcross(marker(), 'abort', answering(255, ''))).rejects.toEqual(expect.objectContaining({ message: lost, raw: undefined }));
    await expect(askAcross(marker(), 'abort', answering(255, 'Connection to studio closed.'))).rejects.toMatchObject({ message: lost, raw: 'Connection to studio closed.' });
    await expect(askAcross(marker(), 'abort', answering(3, ''))).rejects.toMatchObject({ message: 'svall fleet abort did not finish', raw: 'svall fleet abort exited 3' });
    await expect(askAcross(marker(), 'abort', answering(3, 'svall: no marker\n'))).rejects.toMatchObject({ raw: 'svall fleet abort exited 3: svall: no marker' });
  });

  it.each([
    ['another machine', { ...HOME, machineId: MAC }],
    ['another fleet', { ...HOME, fleetId: ANOTHER_FLEET }],
    ['a folder with no fleet id', { ...VERSION, role: 'home' }],
    ['a worker of another fleet', { ...WORKER, worker: { ...WORKER.worker, fleetId: ANOTHER_FLEET } }],
    ['a worker that cannot say whom it serves', { ...VERSION, role: 'worker' }],
    ['a folder that holds no fleet', undefined],
  ])('%s answering reads as unreachable: no status is asked, and the marker stands', async (_who, version) => {
    const paths = marked();
    const far = farAt(version);
    const freeze = freezeAt(paths, far);
    await freeze.settle('status');
    await freeze.settle('abort');
    freeze.stop();
    expect(far.lines.filter((l) => !l.includes("'version'"))).toEqual([]);
    expect(freeze.active).toBe(true);
    expect(freeze.status().moving?.phase).toBe('unreachable');
    expect(readMarker(paths)).toEqual(marker());
  });

  it.each([
    ['another machine', { ...ENROL.worker, homeMachineId: MAC }],
    ['another fleet', { ...ENROL.worker, fleetId: ANOTHER_FLEET }],
  ])('an adopted naming %s reads as unreachable, and goes on no marker', async (_who, worker) => {
    const paths = marked();
    const far = farAt(HOME, { status: 'adopted', enrol: { worker } as never });
    const restart = vi.fn();
    const freeze = new HomeFreeze({ paths, me: MAC, restart, ask: (m: HomeMoving, op: AskOp) => askAcross(m, op, far.open) } as never, marker());
    await freeze.settle('status');
    freeze.stop();
    expect(freeze.status().moving?.phase).toBe('unreachable');
    expect(readMarker(paths)).toEqual(marker());
    expect(restart).not.toHaveBeenCalled();
  });

  it.each([
    ['another machine', { ...ENROL.worker, homeMachineId: MAC }],
    ['another fleet', { ...ENROL.worker, fleetId: ANOTHER_FLEET }],
  ])('an enrol naming %s is refused however it comes, the driver\'s key or no, and the marker stands', async (_who, worker) => {
    const paths = marked();
    const enrol = { worker } as never;
    expect(() => addEnrol(paths, ID, enrol)).toThrow(/another machine or fleet/);
    await expect(writeEnrol(paths, ID, enrol, KEY)).rejects.toThrow(/another machine or fleet/);
    const restart = vi.fn();
    const freeze = new HomeFreeze({ paths, me: MAC, restart } as never, marker());
    expect(() => freeze.join(ID, enrol, KEY)).toThrow(/another machine or fleet/);
    expect(restart).not.toHaveBeenCalled();
    expect(readMarker(paths)).toEqual(marker());
  });

  it('the machine and fleet it marked for go on as ever', async () => {
    const paths = marked();
    const far = farAt(HOME, { status: 'adopted', enrol: ENROL });
    const restart = vi.fn();
    const freeze = new HomeFreeze({ paths, me: MAC, restart, ask: (m: HomeMoving, op: AskOp) => askAcross(m, op, far.open) } as never, marker());
    await freeze.settle('status');
    freeze.stop();
    expect(restart).toHaveBeenCalledOnce();
    expect(readMarker(paths)?.enrol).toEqual(ENROL);
  });
});

describe('a staged machine installs only with the key of the move\'s driver', () => {
  const noKeyIn = (message: string, ...keys: (string | undefined)[]) => { for (const k of keys) if (k) expect(message).not.toContain(k); };

  it.each([
    ['no key', undefined], ['an empty one', ''], ['one typed by hand', 'typed by hand'], ['one cut short', ADOPT_KEY.slice(0, 20)], ['the settle key', KEY],
  ])('%s, its driver dead before its mark and the old home thawed: refused, and the fleet has one home', async (_what, key) => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const stop = vi.spyOn(w.studio.daemon, 'stop');
    const said = await installAdopt(w.studio.deps, ID, key, w.enrolment).then(() => 'installed', (e: Error) => e.message);
    expect(said).toMatch(/only the driver of .* installs it/);
    noKeyIn(said, key);
    expect(stop).not.toHaveBeenCalled();
    expect(journalLines(w.studio.paths, ID).at(-1)?.phase).toBe('staged');
    expect(fs.existsSync(w.studio.paths.workerFile)).toBe(true);
    expect(readMarker(w.mac.paths)).toBeUndefined();
    expect([w.mac.daemon.role, w.studio.daemon.role]).toEqual(['home', 'worker']);
    expect((await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).status).toBe('adopted');
  });

  it('past the commit, no key reads the enrolment that holds the token', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const a = await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    await expect(installAdopt(w.studio.deps, ID, 'typed by hand', w.enrolment)).rejects.toThrow(/only the driver/);
    expect(await installAdopt(w.studio.deps, ID, ADOPT_KEY, w.enrolment)).toEqual(a);
  });

  it('an install cut short recovers only with the key too', async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    const was = fs.readFileSync(path.join(w.studio.paths.homeMoves, `${ID}.ndjson`), 'utf8');
    fs.appendFileSync(path.join(w.studio.paths.homeMoves, `${ID}.ndjson`), `${JSON.stringify({ phase: 'installing', at: 1 })}\n`);
    await expect(installAdopt(w.studio.deps, ID, undefined, w.enrolment)).rejects.toThrow(/only the driver/);
    expect(fs.readFileSync(path.join(w.studio.paths.homeMoves, `${ID}.ndjson`), 'utf8')).toBe(`${was}${JSON.stringify({ phase: 'installing', at: 1 })}\n`);
  });

  it('an archive whose manifest holds no hash is refused at the stage', async () => {
    const w = await world();
    await w.mac.daemon.stop();
    const { adoptKeySha256: _h, ...bare } = w.manifest;
    const packed = await packFleet(w.mac.paths, bare as never);
    await expect(stageAdopt(w.studio.deps, ID, packed.sha256, packed.bytes)).rejects.toThrow(/adoptKeySha256/);
  });

  it.each([
    ['stage', (w: Awaited<ReturnType<typeof world>>) => stageAdopt(w.mac.deps, ID, w.archive.sha256, w.archive.bytes)],
    ['install', (w: Awaited<ReturnType<typeof world>>) => installAdopt(w.mac.deps, ID, ADOPT_KEY, w.enrolment)],
  ])('a %s on the machine the move leaves refuses, naming fleet home abort, and writes nothing', async (_what, run) => {
    const w = await world();
    await w.mac.daemon.stop();
    putMarker(w.mac.paths, marker());
    await expect(run(w)).rejects.toThrow(/svall fleet home abort/);
    expect(journalLines(w.mac.paths, ID)).toEqual([]);
    expect(readMarker(w.mac.paths)).toEqual(marker());
  });
});

describe('the one way a move ends', () => {
  const byHand = { by: 'told', key: 'typed by hand' } as const;
  it.each([
    [{ by: 'asked' }, told], [{ by: 'told', key: KEY }, marker()], [byHand, told], [{ by: 'joined' }, marker()], [{ by: 'recorded' }, marker()],
    [{ by: 'asked' }, { ...marker(), id: OTHER }], [{ by: 'told', key: KEY }, { ...told, id: OTHER }], [{ by: 'joined' }, { ...marker(), id: OTHER, enrol: { worker: {} } } as never], [{ by: 'recorded' }, { ...marker(), id: OTHER }],
  ] as const)('by %o on a marker it does not fit: throws, and the marker stands', (end, m) => {
    const paths = marked(m as never);
    const before = fs.readFileSync(paths.homeMoving);
    expect(() => endMove(paths, ID, end)).toThrow();
    expect(fs.readFileSync(paths.homeMoving)).toEqual(before);
    expect(journalLines(paths, ID)).toEqual([]);
  });

  it('recorded takes only a release or a done on the journal: this machine\'s own refusal from before the mark says nothing of where the fleet is', () => {
    const paths = marked();
    enter(paths, ID, 'aborted');
    expect(() => endMove(paths, ID, { by: 'recorded' })).toThrow(/not ended by recorded/);
    expect(readMarker(paths)?.id).toBe(ID);
  });

  it.each([['done', false], ['released', true]])('a start past a recorded %s: what a freeze would turn back on standing is %s', (phase, stands) => {
    const paths = marked();
    enter(paths, ID, phase);
    fs.writeFileSync(paths.homeServed, JSON.stringify({ id: ID }));
    expect(homeGate(paths)).toEqual({});
    expect(readMarker(paths)).toBeUndefined();
    expect(fs.existsSync(paths.homeServed)).toBe(stands);
  });

  it.each([
    ['adopted', { status: 'adopted', enrol: { worker: WorkerFile.parse({ homeMachineId: STUDIO, fleetId: FLEET, token: 'b'.repeat(48), homeName: 'studio' }) } }, 'join'],
    ['not-adopted', { status: 'not-adopted' }, 'thaw'],
  ] as const)('a settle of %s whose connection closed past a daemon that heard: heard, whatever closed it', async (status, said, how) => {
    const paths = marked(told);
    const heard = () => { fs.rmSync(paths.homeMoving); return Promise.reject(new Error('the connection closed')); };
    const start = vi.fn(() => Promise.resolve());
    expect(await settleMove(paths, ID, said as never, KEY, { join: () => Promise.resolve(), thaw: () => Promise.resolve(), start, [how]: heard })).toEqual({ status });
  });

  it('with no marker: nothing but a refusal goes through', () => {
    const paths = resolvePaths(makeHome());
    for (const end of [{ by: 'asked' }, { by: 'told', key: KEY }, { by: 'joined' }, { by: 'recorded' }] as const) expect(() => endMove(paths, ID, end)).toThrow(/no marker/);
    endMove(paths, ID, { by: 'refused' });
    expect(journalLines(paths, ID).map((l) => l.phase)).toEqual(['aborted']);
  });

  it('a refusal of the id whose marker stands here throws and writes nothing', () => {
    const paths = marked();
    expect(() => endMove(paths, ID, { by: 'refused' })).toThrow(/only the machine holding the fleet/);
    expect(journalLines(paths, ID)).toEqual([]);
    expect(readMarker(paths)?.id).toBe(ID);
  });

  it('told a move is off before its mark: the mark is refused with the home\'s bytes as they were, and the record frees no marker another hand put there', async () => {
    const paths = resolvePaths(makeHome());
    const none = () => Promise.reject(new Error('svalld is not running'));
    const d = { join: none, thaw: none, start: none };
    expect(await settleMove(paths, ID, { status: 'not-adopted' }, KEY, d)).toEqual({ status: 'done' });
    expect(journalLines(paths, ID)).toEqual([expect.objectContaining({ phase: 'aborted', detail: TOLD_UNMARKED })]);
    // a daemon gone past its port file says so in its own words, and counts as none
    const gone = resolvePaths(makeHome());
    const crashed = () => Promise.reject(new SshError('daemon_down', "Svall's background service is not running; start it: svall setup", `process 4711 in ${gone.home}/version is gone`));
    expect(await settleMove(gone, ID, { status: 'not-adopted' }, KEY, { join: crashed, thaw: crashed, start: crashed })).toEqual({ status: 'done' });
    const bytes = () => (fs.readdirSync(paths.home, { recursive: true }) as string[]).sort().map((f) => [f, fs.statSync(path.join(paths.home, f)).isFile() ? fs.readFileSync(path.join(paths.home, f), 'utf8') : '']);
    const before = bytes();
    expect(() => createMarker(paths, told)).toThrow(/called off here before its mark/);
    expect(bytes()).toEqual(before);
    putMarker(paths, told);
    const held = fs.readFileSync(paths.homeMoving);
    expect(homeGate(paths).frozen?.id).toBe(ID);
    expect(() => endMove(paths, ID, { by: 'recorded' })).toThrow(/not ended by recorded/);
    await expect(settleMove(paths, ID, { status: 'not-adopted' }, 'typed by hand', d)).rejects.toThrow(/only studio ends this move/);
    expect(fs.readFileSync(paths.homeMoving)).toEqual(held);
  });

  it('a crash between the record and the marker: the next start ends what the record says, and only that', () => {
    const paths = marked();
    endMove(paths, ID, { by: 'asked' });
    putMarker(paths, marker());
    expect(homeGate(paths)).toEqual({});
    expect(readMarker(paths)).toBeUndefined();
  });

  it('on the disk a settle with no daemon ends only its own move, past a daemon that heard', async () => {
    const paths = marked(told);
    const none = () => Promise.reject(new Error('svalld is not running'));
    let starts = 0;
    const d = { join: none, thaw: none, start: () => { starts++; return Promise.resolve(); } };
    expect(await settleMove(paths, OTHER, { status: 'not-adopted' }, KEY, d)).toEqual({ status: 'done' });
    expect(readMarker(paths)?.id).toBe(ID);
    expect(starts).toBe(0);
    expect(await settleMove(paths, ID, { status: 'not-adopted' }, KEY, d)).toEqual({ status: 'not-adopted' });
    expect(readMarker(paths)).toBeUndefined();
    expect(journalLines(paths, ID).at(-1)).toMatchObject({ phase: 'released', detail: 'told' });
    expect(starts).toBe(1);
  });

  describe('a settle without the key of the move\'s driver, as one typed by hand', () => {
    const enrol = { worker: { homeMachineId: marker().to, homeName: 'studio', fleetId: '11111111-2222-3333-4444-555555555555', token: 'b'.repeat(48) } } as never;
    it.each([
      ['not-adopted', 'up', { status: 'not-adopted' }], ['not-adopted', 'down', { status: 'not-adopted' }],
      ['adopted', 'up', { status: 'adopted', enrol }], ['adopted', 'down', { status: 'adopted', enrol }],
    ] as const)('%s, its daemon %s: refuses, naming fleet home abort, and asks no daemon and writes nothing', async (_o, daemon, said) => {
      const paths = marked(told);
      const asked: string[] = [];
      const call = (what: string) => () => { asked.push(what); return daemon === 'up' ? Promise.resolve() : Promise.reject(new Error('svalld is not running')); };
      const d = { join: call('join'), thaw: call('thaw'), start: () => { asked.push('start'); return Promise.resolve(); } };
      for (const key of [undefined, 'typed by hand']) await expect(settleMove(paths, ID, said, key, d)).rejects.toThrow(/only studio ends this move.*svall fleet home abort there/);
      expect(asked).toEqual([]);
      expect(readMarker(paths)).toEqual(told);
      expect(journalLines(paths, ID)).toEqual([]);
    });

    it('on the disk, an enrolment without it is refused and the marker stands as it was', async () => {
      const paths = marked(told);
      await expect(writeEnrol(paths, ID, enrol, 'typed by hand')).rejects.toThrow(/key of its driver/);
      expect(readMarker(paths)).toEqual(told);
      await writeEnrol(paths, ID, enrol, KEY);
      expect(readMarker(paths)?.enrol).toEqual(enrol);
    });
  });

  describe('on the disk, a daemon holding its lock', () => {
    const enrol = { worker: { homeMachineId: marker().to, homeName: 'studio', fleetId: '11111111-2222-3333-4444-555555555555', token: 'b'.repeat(48) } } as never;

    it('a marker already gone is one that daemon heard: nothing waits for the lock', async () => {
      const paths = resolvePaths(makeHome());
      const unlock = await daemonLock(paths.home);
      await writeEnrol(paths, ID, enrol, KEY);
      unlock?.();
      expect(readMarker(paths)).toBeUndefined();
    });

    it('a marker that changed while it waited for the lock is left as it is', async () => {
      const paths = marked();
      const unlock = await daemonLock(paths.home);
      const writing = writeEnrol(paths, ID, enrol, KEY);
      putMarker(paths, { ...marker(), id: OTHER });
      unlock?.();
      await writing;
      expect(readMarker(paths)).toEqual({ ...marker(), id: OTHER });
    });
  });

  it('a release under a marker with no one saying so throws, and the marker stands', async () => {
    const paths = marked();
    const freeze = new HomeFreeze({ paths, me: marker().from } as never, marker());
    await expect((freeze as unknown as { release(): Promise<void> }).release()).rejects.toThrow(/only where the fleet is going/);
    expect(readMarker(paths)?.id).toBe(ID);
    expect(freeze.active).toBe(true);
  });

  // every line that names a marker or a home move's journal, and every call that writes or ends a marker, each one named, and those that
  // write or end one counted: a new one fails here until it is read and named, however it is spelt
  const TOUCHES = [/\bhomeMoving\b/, /home-moving/, /moving\.json/, /['"`]Mov(e|ing)['"`]/, /\bhomeMoves\b/, /journal\/home/, /'journal',\s*'home'/, /path\.join\([^)]*'journal'(?!, '(outbox\.ndjson|acked|epoch|applied\.ndjson|moves)')/, /\bjournalOf\(/,
    /\benter\s*\((?!\))/, /\benter\s+as\b/, /\bconst \w+ = enter\b/, /\{[^}]*\benter\b[^}]*\}\s*from/, /phase:\s*['"`](aborted|released|done)['"`]/,
    /\bcreateMarker\b/, /\baddEnrol\b/, /\bwriteMarker\b/, /\bendMove\b/, /\.mark\s*\(/];
  const FREEZE = /svalld\/src\/fleet\/home-freeze\.ts$/;
  const MOVE = /svalld\/src\/fleet\/home-move\.ts$/;
  const PATHS = /svalld\/src\/paths\.ts$/;
  const NOT_WRITING = /^(?!.*\b(rmSync|unlinkSync|renameSync|writeFileSync|writeDurable|createDurable|appendDurable|appendFileSync)\b)/.source;
  // a third number, where a line writes or ends something: how many such lines there are
  const NAMED: [RegExp, RegExp, number?][] = [
    [PATHS, /^\s*homeMoving: path\.join\(home, /, 1], [PATHS, /^\s*homeMoves: path\.join\(home, /, 1],
    [PATHS, /^export const fleetKeys = /, 1], [PATHS, /^\s*return \[\.\.\.fleetKeys\(p\), path\.join\(p\.home, 'journal'\), /, 1],
    [/svalld\/src\/bin\.ts$/, /^const stamp = /, 1], [/svalld\/src\/bin\.ts$/, /^const journals = /, 1],
    // what reads alone
    [MOVE, new RegExp(`${NOT_WRITING}.*Pick<Paths, 'homeMoves'>|${NOT_WRITING}.*Pick<Paths, 'homeMoving'( \\| 'homeMoves')?>`)],
    [MOVE, /readFileSync\(journalOf\(p, id\)|^\s*throw new InvalidConfig\(`\$\{journalOf\(p, id\)\} cannot be read: |readFileSync\(p\.homeMoving, |invalid \$\{p\.homeMoving\}/],
    [MOVE, /^const journalOf = /, 1], [MOVE, /^export function endMove\(p: Paths, /, 1],
    // a journal's one writer, and the phases that end nothing: what the machine taking the fleet writes, and the driver's two keys
    [MOVE, /appendDurable\(journalOf\(p, id\), \{ phase, /, 1],
    [MOVE, /\benter\((p|d\.paths), id, '(staging|staged|stopping|installing|installed|rolledback|adopted)'/, 12],
    [MOVE, /\benter\(p, id, SERVED\b/, 1], [MOVE, /^\s*enter\(p, driverOf\(id\), use, JSON\.stringify\(\{ key \}\)\);$/, 1],
    [MOVE, /^\s*for \(const folder of \[p\.home, path\.join\(p\.home, 'journal'\), |^\s*fs\.mkdirSync\(path\.join\(p\.home, 'journal'\), \{ recursive: true \}\);$/, 2],
    // the marker's two writers, and the outcome's write on the disk with the driver's key
    [MOVE, /^export function (createMarker|addEnrol)\(p: Pick<Paths, 'homeMoving'( \| 'homeMoves')?>, /, 2], [MOVE, /createDurable\(p\.homeMoving, m, /, 1], [MOVE, /^\s*writeDurable\(p\.homeMoving, m, /, 1], [MOVE, /^\s*addEnrol\(p, id, enrol\);$/, 1],
    // endMove's own body
    [MOVE, /^\s*enter\(p, id, 'aborted', end\.detail\);$|^\s*if \(end\.by === 'asked' \|\| end\.by === 'told'\) enter\(p, id, 'released', end\.by\);$|^\s*if \(end\.by === 'joined'\) enter\(p, id, 'done'\);$/, 3],
    [MOVE, /^\s*fs\.rmSync\(p\.homeMoving, \{ force: true \}\);$/, 1],
    // its callers: the ends that are no end of a marker, and those that end one
    [MOVE, /endMove\(p, other, \{ by: 'refused', detail: 'a later move came' \}\);$|^\s*endMove\(p, id, \{ by: 'refused'(?!, detail: TOLD_UNMARKED)/, 3],
    // the old home's record of a move told off before its mark, on the file and in its daemon, and the mark that record refuses
    [MOVE, /^\s*endMove\(p, id, \{ by: 'refused', detail: TOLD_UNMARKED \}\);$/, 1],
    [FREEZE, /^\s*if \(this\.marker\?\.id !== id\) return endMove\(this\.d\.paths, id, \{ by: 'refused', detail: TOLD_UNMARKED \}\);$/, 1],
    [MOVE, /^\s*if \(lastPhase\(p, m\.id\) === 'aborted'\) throw new Error\(/, 1],
    [MOVE, /endMove\(p, id, \{ by: 'told', key \}\)/, 1], [MOVE, /^\s*endMove\(p, m\.id, \{ by: 'joined' \}\);$/, 1], [MOVE, /^\s*endMove\(p, marker\.id, \{ by: 'recorded' \}\);$/, 1],
    // the machine that took the fleet, once the old home linked with the move's token: it holds no marker of that id
    [MOVE, /^\s*if \(at === 'adopted'\) enter\(p, id, 'done'\);$/, 1],
    [FREEZE, /^import \{ addEnrol, carriedKb, createMarker, endMove, /, 1],
    [FREEZE, /^\s*try \{ createMarker\(this\.d\.paths, marker\); \} catch \(e\) \{$/, 1], [FREEZE, /^\s*this\.marker = addEnrol\(this\.d\.paths, held\.id, enrol\);$/, 1], [FREEZE, /^\s*endMove\(this\.d\.paths, this\.marker\.id, end\);$/, 1],
    // the freeze's own: one with no answer behind it throws under a marker, and each with an answer has its one caller
    [FREEZE, /this\.release\(\);$/, 3], [FREEZE, /^\s*private async release\(end\?: /, 1], [FREEZE, /^\s*await this\.release\(\{ by: 'told', key \}\);$/, 1], [FREEZE, /^\s*if \(a\.status === 'not-adopted'\) return this\.release\(\{ by: 'asked' \}\);$/, 1],
    [FREEZE, /^\s*private enrolled\(held: HomeMoving, enrol: Enrolment\): void \{$/, 1], [FREEZE, /^\s*this\.enrolled\(this\.marker, enrol\);$/, 1], [FREEZE, /^\s*if \(a\.status === 'adopted'\) return this\.enrolled\(held, a\.enrol\);$/, 1],
    [/svalld\/src\/api\/methods\.ts$/, /^\s*if \(p\.op === 'mark'\) held\.mark\(p\.marker\);$/, 1], [/svalld\/src\/api\/methods\.ts$/, /'retro\.mark': \(p, ctx\) => retroOf\(ctx\)\.mark\(p\)/],
    // a machine's own reachability, no marker
    [/svalld\/src\/link\/home\.ts$/, /\bthis\.mark\(\{ name: this\.name, /],
    // the robot moves' own journal, of another folder
    [/svalld\/src\/placement\/move\.ts$/, /\bthis\.enter\(|^\s*private enter\(j: MoveJournal/],
    [/svalld\/src\/placement\/prepare\.ts$/, /^\s*this\.save\(\{ \.\.\.j, phase: '(done|aborted)'/],
    [/cli\/src\/controller\/home\.ts$/, /^import \{ .*\benter\b.* \} from '@svall\/svalld\/fleet\/home-move';$/, 1], [/cli\/src\/controller\/home\.ts$/, /^const driverJournal = .*enter\(paths, `\$\{id\}\.driver`, /, 1],
    // the containers' checks, which read alone
    [/scripts\/integration\/robot-placement\.mjs$/, /^function homeMoves\(|homeMoves\(ids, fx\)|'(ls -d|test -f|cat) ~\/\.svall\/home-moving\.json|for f in ~\/\.svall\/journal\/home\/hm_\*\.ndjson|`test -e ~\/\.svall\/journal\/home\//],
  ];
  // a comment says what it says only with no code behind it
  const isComment = (line: string): boolean => /^\s*(\*|\/\/)/.test(line) || /^\s*\/\*(?!.*\*\/\s*\S)/.test(line);
  const touches = (file: string, line: string): boolean => TOUCHES.some((t) => t.test(line)) || (FREEZE.test(file) && /\b(release|enrolled)\s*\(/.test(line));
  const offenders = (files: { file: string; text: string }[]): string[] => files.flatMap(({ file, text }) => text.split('\n')
    .filter((line) => touches(file, line) && !isComment(line) && !NAMED.some(([f, l]) => f.test(file) && l.test(line)))
    .map((line) => `${file}: ${line.trim()}`));
  const miscounted = (files: { file: string; text: string }[]): string[] => NAMED.flatMap(([f, l, times]) => {
    if (times === undefined) return [];
    const lines = files.filter(({ file }) => f.test(file)).flatMap(({ text }) => text.split('\n')).filter((line) => !isComment(line) && l.test(line));
    return lines.length === times ? [] : [`${l.source}: ${lines.length} lines, named ${times}`];
  });

  const root = path.resolve(__dirname, '../../../..');
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', 'dist', 'test', 'build.noindex', '.build'].includes(e.name)) return [];
    const file = path.join(dir, e.name);
    return e.isDirectory() ? sources(file) : /\.(ts|tsx|mjs|js|cjs|swift|sh|py)$/.test(e.name) ? [file] : [];
  });
  const tree = () => ['packages/svalld/src', 'packages/cli/src', 'packages/protocol/src', 'apps/desktop/web/src', 'apps/desktop/mac/Sources', 'scripts'].flatMap((d) => sources(path.join(root, d)))
    .map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, 'utf8') }));

  it('no other code removes a marker or writes an id off', () => {
    const files = tree();
    expect(files.length).toBeGreaterThan(100);
    expect(offenders(files)).toEqual([]);
    expect(miscounted(files)).toEqual([]);
  });

  it.each([
    ['packages/svalld/src/fleet/home-freeze.ts', '      endMove(this.d.paths, this.marker.id, end);'],
    ['packages/svalld/src/fleet/home-freeze.ts', '    this.marker = addEnrol(this.d.paths, held.id, enrol);'],
    ['packages/svalld/src/fleet/home-move.ts', '  writeDurable(p.homeMoving, m, { mode: 0o600 });'],
    ['packages/svalld/src/fleet/home-move.ts', '  createDurable(p.homeMoving, m, { mode: 0o600 });'],
    ['packages/svalld/src/fleet/home-move.ts', "  enter(p, id, 'staged');"],
    ['packages/svalld/src/fleet/home-move.ts', '  fs.rmSync(p.homeMoving, { force: true });'],
    ['packages/svalld/src/fleet/home-freeze.ts', "    if (a.status === 'not-adopted') return this.release({ by: 'asked' });"],
    ['packages/svalld/src/fleet/home-freeze.ts', "    if (a.status === 'adopted') return this.enrolled(held, a.enrol);"],
    ['packages/svalld/src/fleet/home-freeze.ts', "    if (this.marker?.id !== id) return endMove(this.d.paths, id, { by: 'refused', detail: TOLD_UNMARKED });"],
    ['packages/svalld/src/fleet/home-move.ts', "  if (lastPhase(p, m.id) === 'aborted') throw new Error(`move ${m.id} was called off here before its mark`);"],
  ])('a second line in %s spelt as a named one fails it: %s', (file, line) => {
    const files = tree();
    expect(miscounted(files)).toEqual([]);
    expect(miscounted(files.map((f) => (f.file === file ? { ...f, text: `${f.text}\n${line}` } : f)))).toHaveLength(1);
  });

  it.each([
    ['packages/svalld/src/fleet/home-move.ts', "  enter(p, id, 'done');"],
    ['packages/svalld/src/fleet/home-move.ts', '  enter(p, id, DONE);'],
    ['packages/svalld/src/fleet/home-move.ts', '  enter(p, id, `released`);'],
    ['packages/svalld/src/fleet/home-move.ts', "  enter(p, driverOf(id), 'done', JSON.stringify({ key }));"],
    ['packages/svalld/src/fleet/home-move.ts', '  enter(p, driverOf(id), use, JSON.stringify({ key })); enter(p, id, DONE);'],
    ['packages/svalld/src/fleet/home-move.ts', '  enter('],
    ['packages/svalld/src/fleet/home-freeze.ts', '  const { homeMoving: marker } = this.d.paths;'],
    ['packages/svalld/src/fleet/home-freeze.ts', "  fs.rmSync(this.d.paths['homeMoving']);"],
    ['packages/svalld/src/placement/move.ts', "  fs.unlinkSync(path.join(home, 'home-moving.json'));"],
    ['packages/svalld/src/placement/prepare.ts', "  appendDurable(path.join(p.home, 'journal', 'home', `${id}.ndjson`), { phase: 'released' });"],
    ['apps/desktop/web/src/HomeBanner.tsx', "  call('fs.delete', { path: '~/.svall/home-moving.json' });"],
    ['scripts/integration/robot-placement.mjs', "  sh(old, 'rm ~/.svall/home-moving.json');"],
    ['packages/cli/src/commands/fleet.ts', "  writeDurable(file, { phase: 'done' });"],
    ['packages/svalld/src/fleet/home-freeze.ts', '    this.marker = addEnrol(this.d.paths, id, enrol), this.d.restart();'],
    ['packages/svalld/src/fleet/home-freeze.ts', "    endMove(this.d.paths, id, { by: 'asked' });"],
    ['packages/svalld/src/api/methods.ts', '    if (p.op === \'remark\') held.mark({ ...p.marker, keySha256: p.mine });'],
    ['packages/cli/src/controller/home.ts', '  createMarker(paths, { ...held, ask });'],
    ['packages/svalld/src/fleet/home-move.ts', '  writeMarker(p, { ...held, keySha256 });'],
    ['packages/svalld/src/fleet/home-freeze.ts', "import { endMove as settled } from './home-move.js';"],
    ['packages/svalld/src/fleet/home-freeze.ts', "    endMove (this.d.paths, id, { by: 'asked' });"],
    ['packages/svalld/src/fleet/home-freeze.ts', "    await this.release({ by: 'asked' });"],
    ['packages/svalld/src/fleet/home-freeze.ts', '    if (this.marker) this.enrolled(this.marker, enrol);'],
    ['packages/svalld/src/fleet/home-move.ts', "  enter (p, id, 'released');"],
    ['packages/svalld/src/fleet/home-move.ts', '  const note = enter;'],
    ['packages/svalld/src/fleet/home-freeze.ts', "import { enter as note } from './home-move.js';"],
    ['packages/svalld/src/fleet/home-far.ts', "export { enter as note } from './home-move.js';"],
    ['packages/svalld/src/placement/move.ts', "  const marker = ['home', 'moving.json'].join('-');"],
    ['packages/svalld/src/placement/move.ts', "  fs.rmSync(path.join(home, 'home-' + 'moving.json'));"],
    ['packages/svalld/src/placement/move.ts', "  fs.readdirSync(home).filter((n) => n.endsWith('-moving.json'));"],
    ['packages/svalld/src/placement/move.ts', "  fs.rmSync(p['home' + 'Moving']);"],
    ['packages/svalld/src/fleet/home-far.ts', "  (moves as never)['end' + 'Move'](p, id, { by: 'asked' });"],
    ['packages/svalld/src/placement/move.ts', "  fs.appendFileSync(path.join(home, 'journal', SUB, `${id}.ndjson`), line);"],
    ['packages/svalld/src/placement/move.ts', '  /* gone */ fs.rmSync(p.homeMoving, { force: true });'],
    ['scripts/integration/tailscale.sh', 'rm -f ~/.svall/home-moving.json'],
    ['packages/svalld/src/fleet/home-move.ts', '    if (marker?.id === id) fs.rmSync(p.homeMoving, { force: true });'],
  ])('a line in %s that ends a move some other way fails it: %s', (file, line) => {
    expect(offenders([{ file, text: line }])).toHaveLength(1);
  });
});
