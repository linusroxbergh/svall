import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerFile, type AdoptAnswer, type HomeMoveId, type HomeMoving } from '@svall/protocol';
import { askAcross } from '../../src/fleet/home-far.js';
import { HomeFreeze } from '../../src/fleet/home-freeze.js';
import { abortAdopt, addEnrol, adoptDir, adoptStatus, endMove, homeGate, installAdopt, journalLines, packFleet, readMarker, settleMove, stageAdopt, writeEnrol } from '../../src/fleet/home-move.js';
import { daemonLock } from '../../src/kernel-lock.js';
import { resolvePaths } from '../../src/paths.js';
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
  const FACTS = { machineId: STUDIO, role: 'worker', fleetId: FLEET, release: 'r', protocol: 1, stateSchema: 1, clock: 1, home: '/home/ada', svallBase: '/opt', fleetHome: '/home/ada/.svall', tailscale: {} };
  const ANOTHER_FLEET = '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70';
  const ENROL = { worker: WorkerFile.parse({ homeMachineId: STUDIO, fleetId: FLEET, token: 'b'.repeat(48), homeName: 'studio' }) };
  const farAt = (facts: object | undefined, said: AdoptAnswer = { status: 'not-adopted' }) => {
    const lines: string[] = [];
    let opened = 0;
    const open = () => {
      opened++;
      return Promise.resolve({
        run: (argv: string[]) => {
          const line = argv.join(' ');
          lines.push(line);
          const out = line.includes("'facts'") ? facts : said;
          return Promise.resolve(out ? { code: 0, signal: null, stderr: '', stdout: JSON.stringify(out) } : { code: 1, signal: null, stderr: 'svall: no fleet here', stdout: '' });
        },
        close: () => Promise.resolve(),
      });
    };
    return { open: open as never, lines, opened: () => opened };
  };
  const freezeAt = (paths: ReturnType<typeof marked>, far: ReturnType<typeof farAt>) => new HomeFreeze({ paths, me: MAC, restart: () => {}, ask: (m: HomeMoving, op: AskOp) => askAcross(m, op, far.open) } as never, marker());

  it('reads the far fleet\'s word for itself on the connection it asks over, and says who asks', async () => {
    const far = farAt(FACTS);
    expect(await askAcross(marker(), 'abort', far.open)).toEqual({ status: 'not-adopted' });
    expect(far.opened()).toBe(1);
    expect(far.lines).toEqual([expect.stringMatching(/'fleet' 'facts'$/), expect.stringMatching(new RegExp(`'fleet' 'abort' '${ID}' '--asker' '${MAC}' '--fleet' '${FLEET}'$`))]);
  });

  it.each([
    ['another machine', { ...FACTS, machineId: MAC }],
    ['another fleet', { ...FACTS, fleetId: ANOTHER_FLEET }],
    ['a folder with no fleet id', { ...FACTS, fleetId: undefined }],
    ['a folder that holds no fleet', undefined],
  ])('%s answering reads as unreachable: no status is asked, and the marker stands', async (_who, facts) => {
    const paths = marked();
    const far = farAt(facts);
    const freeze = freezeAt(paths, far);
    await freeze.settle('status');
    await freeze.settle('abort');
    freeze.stop();
    expect(far.lines.filter((l) => !l.includes("'facts'"))).toEqual([]);
    expect(freeze.active).toBe(true);
    expect(freeze.status().moving?.phase).toBe('unreachable');
    expect(readMarker(paths)).toEqual(marker());
  });

  it.each([
    ['another machine', { ...ENROL.worker, homeMachineId: MAC }],
    ['another fleet', { ...ENROL.worker, fleetId: ANOTHER_FLEET }],
  ])('an adopted naming %s reads as unreachable, and goes on no marker', async (_who, worker) => {
    const paths = marked();
    const far = farAt(FACTS, { status: 'adopted', enrol: { worker } as never });
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
    const far = farAt(FACTS, { status: 'adopted', enrol: ENROL });
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

  // every line that touches a marker or a home move's journal, and every call that writes or ends a marker, each one named: a new
  // one fails here until it is read and named
  const TOUCHES = [/\bhomeMoving\b/, /home-moving/, /\bhomeMoves\b/, /journal\/home/, /'journal',\s*'home'/, /\bjournalOf\(/, /\benter\((?!\))/, /phase:\s*['"`](aborted|released|done)['"`]/,
    /\bcreateMarker\b/, /\baddEnrol\b/, /\bwriteMarker\b/, /\bendMove\b/, /\.mark\s*\(/];
  // a home move's phases that end nothing: what the machine taking the fleet writes, and the driver's two keys
  const NO_END = /\benter\((p|d\.paths), id, '(staging|staged|stopping|installing|installed|rolledback|adopted)'|\benter\(p, id, SERVED\b|^\s*enter\(p, driverOf\(id\), use, JSON\.stringify\(\{ key \}\)\);$/;
  const NAMED: [RegExp, RegExp][] = [
    [/svalld\/src\/paths\.ts$/, /^\s*(homeMoving|homeMoves): path\.join\(home, |^export const fleetKeys = /],
    [/svalld\/src\/bin\.ts$/, /^const stamp = /],
    [/svalld\/src\/fleet\/home-move\.ts$/, new RegExp([
      NO_END.source, /Pick<Paths, 'homeMoves'>|Pick<Paths, 'homeMoving'( \| 'homeMoves')?>/.source, /^const journalOf = |readFileSync\(journalOf\(p, id\)|appendDurable\(journalOf\(p, id\), \{ phase, /.source,
      /readFileSync\(p\.homeMoving, |invalid \$\{p\.homeMoving\}|^\s*writeDurable\(p\.homeMoving, m, |createDurable\(p\.homeMoving, m, /.source,
      // the marker's two writers, the outcome's write on the disk with the driver's key, and the ends that are no end of a marker
      /^export function (createMarker|addEnrol)\(p: Pick<Paths, 'homeMoving'>, |^\s*addEnrol\(p, id, enrol\);$|endMove\(p, (other|id), \{ by: 'refused'/.source,
      /endMove\(p, id, \{ by: 'told', key \}\)|^\s*endMove\(p, m\.id, \{ by: 'joined' \}\);$|^\s*endMove\(p, marker\.id, \{ by: 'recorded' \}\);$/.source, /fs\.existsSync\(p\.homeMoves\) \? fs\.readdirSync\(p\.homeMoves\)/.source,
      // the machine that took the fleet, once the old home linked with the move's token: it holds no marker of that id
      /^\s*if \(at === 'adopted'\) enter\(p, id, 'done'\);$/.source,
    ].join('|'))],
    [/svalld\/src\/fleet\/home-freeze\.ts$/, /^import \{ addEnrol, createMarker, endMove, |^\s*try \{ createMarker\(this\.d\.paths, marker\); \} catch \(e\) \{$|^\s*this\.marker = addEnrol\(this\.d\.paths, held\.id, enrol\);$|^\s*endMove\(this\.d\.paths, this\.marker\.id, end\);$/],
    [/svalld\/src\/api\/methods\.ts$/, /^\s*if \(p\.op === 'mark'\) held\.mark\(p\.marker\);$|'retro\.mark': \(p, ctx\) => retroOf\(ctx\)\.mark\(p\)/],
    // a machine's own reachability, no marker
    [/svalld\/src\/link\/home\.ts$/, /\bthis\.mark\(\{ name: this\.name, /],
    // the robot moves' own journal, of another folder
    [/svalld\/src\/placement\/move\.ts$/, /\bthis\.enter\(|^\s*private enter\(j: MoveJournal/],
    [/svalld\/src\/placement\/prepare\.ts$/, /^\s*this\.save\(\{ \.\.\.j, phase: '(done|aborted)'/],
    [/cli\/src\/controller\/home\.ts$/, /^const driverJournal = .*enter\(paths, `\$\{id\}\.driver`, /],
    // the containers' checks, which read alone
    [/scripts\/integration\/robot-placement\.mjs$/, /^function homeMoves\(|homeMoves\(ids, fx\)|'(ls -d|test -f|cat) ~\/\.svall\/home-moving\.json|for f in ~\/\.svall\/journal\/home\/hm_\*\.ndjson|`test -e ~\/\.svall\/journal\/home\//],
  ];
  const offenders = (files: { file: string; text: string }[]): string[] => files.flatMap(({ file, text }) => text.split('\n')
    .filter((line) => TOUCHES.some((t) => t.test(line)) && !/^\s*(\*|\/\/|\/\*)/.test(line) && !NAMED.some(([f, l]) => f.test(file) && l.test(line)))
    .map((line) => `${file}: ${line.trim()}`));

  it('no other code removes a marker or writes an id off', () => {
    const root = path.resolve(__dirname, '../../../..');
    const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (['node_modules', 'dist', 'test', 'build.noindex', '.build'].includes(e.name)) return [];
      const file = path.join(dir, e.name);
      return e.isDirectory() ? sources(file) : /\.(ts|tsx|mjs|swift)$/.test(e.name) ? [file] : [];
    });
    const files = ['packages/svalld/src', 'packages/cli/src', 'packages/protocol/src', 'apps/desktop/web/src', 'apps/desktop/mac/Sources', 'scripts'].flatMap((d) => sources(path.join(root, d))).map((file) => {
      let text = fs.readFileSync(file, 'utf8');
      if (file.endsWith('/svalld/src/fleet/home-move.ts')) {
        const from = text.indexOf('export function endMove(');
        expect(from).toBeGreaterThan(0);
        text = text.slice(0, from) + text.slice(text.indexOf('\n}\n', from));
      }
      return { file: path.relative(root, file), text };
    });
    expect(files.length).toBeGreaterThan(100);
    expect(offenders(files)).toEqual([]);
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
  ])('a line in %s that ends a move some other way fails it: %s', (file, line) => {
    expect(offenders([{ file, text: line }])).toHaveLength(1);
  });
});
