import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HomeMoveId } from '@svall/protocol';
import { abortAdopt, adoptStatus, endMove, homeGate, installAdopt, journalLines, readMarker, settleMove, stageAdopt, writeMarker } from '../../src/fleet/home-move.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { ID, marker, world } from './home-world.js';

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
  it.each([
    ['asked', told], ['told', marker()], ['joined', marker()], ['recorded', marker()],
    ['asked', { ...marker(), id: OTHER }], ['told', { ...told, id: OTHER }], ['joined', { ...marker(), id: OTHER, enrol: { worker: {} } } as never], ['recorded', { ...marker(), id: OTHER }],
  ] as const)('by %s on a marker it does not fit: throws, and the marker stands', (by, m) => {
    const paths = marked(m as never);
    const before = fs.readFileSync(paths.homeMoving);
    expect(() => endMove(paths, ID, { by })).toThrow();
    expect(fs.readFileSync(paths.homeMoving)).toEqual(before);
    expect(journalLines(paths, ID)).toEqual([]);
  });

  it('with no marker: nothing but a refusal goes through', () => {
    const paths = resolvePaths(makeHome());
    for (const by of ['asked', 'told', 'joined', 'recorded'] as const) expect(() => endMove(paths, ID, { by })).toThrow(/no marker/);
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
    expect(await settleMove(paths, OTHER, { status: 'not-adopted' }, d)).toEqual({ status: 'done' });
    expect(readMarker(paths)?.id).toBe(ID);
    expect(starts).toBe(0);
    expect(await settleMove(paths, ID, { status: 'not-adopted' }, d)).toEqual({ status: 'not-adopted' });
    expect(readMarker(paths)).toBeUndefined();
    expect(journalLines(paths, ID).at(-1)).toMatchObject({ phase: 'released', detail: 'told' });
    expect(starts).toBe(1);
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
