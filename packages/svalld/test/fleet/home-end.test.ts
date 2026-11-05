import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HomeMoveId } from '@svall/protocol';
import { HomeFreeze } from '../../src/fleet/home-freeze.js';
import { abortAdopt, adoptStatus, endMove, homeGate, installAdopt, journalLines, readMarker, settleMove, stageAdopt, writeEnrol, writeMarker } from '../../src/fleet/home-move.js';
import { daemonLock } from '../../src/kernel-lock.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { ID, KEY, marker, world } from './home-world.js';

afterEach(cleanHomes);

const OTHER = 'hm_otherother' as HomeMoveId;
const told = (() => { const { ask: _a, ...bare } = marker(); return bare; })();
const marked = (m = marker()) => {
  const paths = resolvePaths(makeHome());
  writeMarker(paths, m);
  return paths;
};

describe('what a machine a move leaves says of that move', () => {
  const frozenMac = async () => {
    const w = await world();
    await stageAdopt(w.studio.deps, ID, w.archive.sha256, w.archive.bytes);
    await w.mac.daemon.stop();
    writeMarker(w.mac.paths, marker());
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('frozen');
    return w;
  };

  it.each([['status', adoptStatus], ['abort', abortAdopt]] as const)('svall fleet %s on it refuses, naming fleet home abort, writes nothing, and the new home having committed it joins', async (_op, command) => {
    const w = await frozenMac();
    const a = await installAdopt(w.studio.deps, ID, w.enrolment);
    if (a.status !== 'adopted') throw new Error(a.status);
    await expect(command(w.mac.deps, ID)).rejects.toThrow(/svall fleet home abort/);
    expect(journalLines(w.mac.paths, ID)).toEqual([]);
    expect(readMarker(w.mac.paths)?.id).toBe(ID);
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('frozen');
    writeMarker(w.mac.paths, { ...marker(), enrol: a.enrol });
    await w.mac.daemon.start();
    expect(w.mac.daemon.role).toBe('worker');
    expect(w.studio.daemon.role).toBe('home');
  });

  it('asked of another id it answers as ever, and the marker stands', async () => {
    const paths = marked();
    const d = { paths, me: marker().from, daemon: { stop: () => Promise.resolve(), start: () => Promise.resolve(), answersHome: () => Promise.resolve(false) } };
    expect((await adoptStatus(d, OTHER)).status).toBe('not-adopted');
    expect((await abortAdopt(d, OTHER)).status).toBe('not-adopted');
    expect(readMarker(paths)?.id).toBe(ID);
    expect(homeGate(paths).frozen?.id).toBe(ID);
  });

  it('its own refusal of the id from before the mark ends nothing: a start stays frozen', async () => {
    const paths = resolvePaths(makeHome());
    const d = { paths, me: marker().from, daemon: { stop: () => Promise.resolve(), start: () => Promise.resolve(), answersHome: () => Promise.resolve(false) } };
    expect((await adoptStatus(d, ID)).status).toBe('not-adopted');
    writeMarker(paths, marker());
    expect(homeGate(paths).frozen?.id).toBe(ID);
    expect(readMarker(paths)?.id).toBe(ID);
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
    writeMarker(paths, marker());
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
    const enrol = { worker: { homeMachineId: marker().from, homeName: 'mac', fleetId: '11111111-2222-3333-4444-555555555555', token: 'b'.repeat(48) } } as never;
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
      writeMarker(paths, { ...marker(), id: OTHER });
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

  it('no other code removes a marker or writes an id off', () => {
    const root = path.resolve(__dirname, '../../..');
    const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') return [];
      const file = path.join(dir, e.name);
      return e.isDirectory() ? sources(file) : /\.(ts|tsx|mjs)$/.test(e.name) ? [file] : [];
    });
    const FORBIDDEN = [
      /(rmSync|unlinkSync|rm|unlink|renameSync|rename)\([^)]*(homeMoving|home-moving)/,
      /(enter|appendDurable|writeDurable)\([^;]*['"](aborted|released)['"]/,
      /phase:\s*['"](aborted|released)['"]/,
      /home-moving\.json/,
      /\.homeMoving\b/,
    ];
    // what may hold them: the function itself, the path's one definition and its readers, and the placement moves' own unrelated journal
    const ALLOWED = (file: string, line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line)
      || (file.endsWith('/paths.ts') && /homeMoving: path\.join|fleetKeys/.test(line))
      || (file.endsWith('/bin.ts') && /const stamp/.test(line))
      || (file.endsWith('/fleet/home-move.ts') && /readFileSync\(p\.homeMoving|invalid \$\{p\.homeMoving|writeDurable\(p\.homeMoving/.test(line))
      || /\/placement\/(move|prepare)\.ts$/.test(file);
    const home = path.join(root, 'svalld/src/fleet/home-move.ts');
    const offenders = ['svalld', 'cli', 'protocol'].flatMap((pkg) => sources(path.join(root, pkg, 'src'))).flatMap((file) => {
      let text = fs.readFileSync(file, 'utf8');
      if (file === home) {
        const from = text.indexOf('export function endMove(');
        expect(from).toBeGreaterThan(0);
        const to = text.indexOf('\n}\n', from);
        text = text.slice(0, from) + text.slice(to);
      }
      return text.split('\n').filter((line) => FORBIDDEN.some((f) => f.test(line)) && !ALLOWED(file, line)).map((line) => `${path.relative(root, file)}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
