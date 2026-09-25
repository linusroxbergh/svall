import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mapPortablePath, PathRootError, probeRoots, resolvePortablePath, type ProbeFs } from '../../src/controller/paths.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/archi-t-'); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// a probe target that answers the way the flags say, wherever it is asked
function fakeFs(o: { exists?: boolean; writable?: boolean; caseInsensitive?: boolean; free?: number } = {}): ProbeFs {
  const files = new Set<string>();
  return {
    existsSync: () => o.exists ?? true,
    writeFileSync: (p) => { if (!(o.writable ?? true)) throw new Error('EACCES'); files.add(p); },
    statSync: (p) => {
      const hit = files.has(p) || ((o.caseInsensitive ?? false) && [...files].some((f) => f.toLowerCase() === p.toLowerCase()));
      if (!hit) throw new Error('ENOENT');
      return {};
    },
    rmSync: (p) => { files.delete(p); },
    statfsSync: () => ({ bavail: (o.free ?? 4096) / 4096, bsize: 4096 }),
  };
}

describe('portable paths', () => {
  it('takes the longest matching root', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'home/work/repo/src'), { recursive: true });
    const roots = { home: path.join(base, 'home'), work: path.join(base, 'home/work') };
    expect(resolvePortablePath(path.join(base, 'home/work/repo/src'), roots)).toEqual({ root: 'work', relative: 'repo/src' });
    expect(resolvePortablePath(path.join(base, 'home'), roots)).toEqual({ root: 'home', relative: '' });
  });

  it('matches on a component boundary, so /home/a never holds /home/ab', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'a'));
    fs.mkdirSync(path.join(base, 'ab/x'), { recursive: true });
    expect(resolvePortablePath(path.join(base, 'ab/x'), { a: path.join(base, 'a'), ab: path.join(base, 'ab') })).toEqual({ root: 'ab', relative: 'x' });
    expect(() => resolvePortablePath(path.join(base, 'ab/x'), { a: path.join(base, 'a') })).toThrow(PathRootError);
    expect(resolvePortablePath('/etc/hosts', { fs: '/' })).toEqual({ root: 'fs', relative: 'etc/hosts' });
  });

  it('keeps spaces and unicode intact on both sides of the map', () => {
    const base = tmp();
    const relative = 'Ärende möte/fil (1).txt';
    fs.mkdirSync(path.join(base, 'home/Ärende möte'), { recursive: true });
    fs.writeFileSync(path.join(base, 'home', relative), '');
    expect(resolvePortablePath(path.join(base, 'home', relative), { home: path.join(base, 'home') })).toEqual({ root: 'home', relative });
    expect(mapPortablePath({ root: 'home', relative }, { home: '/home/linus' })).toBe(`/home/linus/${relative}`);
  });

  it('refuses a symlink that leaves the root and allows one that stays', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'root/inside'), { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside/secret'), '');
    fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'root/out'));
    fs.symlinkSync(path.join(base, 'root/inside'), path.join(base, 'root/in'));
    const roots = { home: path.join(base, 'root') };
    expect(() => resolvePortablePath(path.join(base, 'root/out/secret'), roots)).toThrow(/leaves the path root home/);
    expect(resolvePortablePath(path.join(base, 'root/in/notes.md'), roots)).toEqual({ root: 'home', relative: 'in/notes.md' });
  });

  it('refuses unsafe bytes, relative input, an unknown root and a root that is not there', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'home'));
    const roots = { home: path.join(base, 'home') };
    expect(() => resolvePortablePath(path.join(base, 'home/a\0b'), roots)).toThrow(PathRootError);
    expect(() => resolvePortablePath(path.join(base, 'home/a\nb'), roots)).toThrow(PathRootError);
    expect(() => resolvePortablePath('home/x', roots)).toThrow(/absolute/);
    expect(() => resolvePortablePath('/elsewhere/x', roots)).toThrow(/no path root holds/);
    expect(() => resolvePortablePath(path.join(base, 'gone/x'), { home: path.join(base, 'gone') })).toThrow(/does not exist/);
  });

  it('resolves under the destination roots and blocks on a missing one', () => {
    expect(mapPortablePath({ root: 'work', relative: 'repo/src' }, { home: '/home/linus', work: '/srv/work' })).toBe('/srv/work/repo/src');
    expect(mapPortablePath({ root: 'home', relative: '' }, { home: '/home/linus' })).toBe('/home/linus');
    expect(() => mapPortablePath({ root: 'work', relative: 'repo' }, { home: '/home/linus' })).toThrow(/no path root named work/);
    expect(() => mapPortablePath({ root: 'home', relative: '../etc/passwd' }, { home: '/home/linus' })).toThrow(PathRootError);
    expect(() => mapPortablePath({ root: 'home', relative: '/etc/passwd' }, { home: '/home/linus' })).toThrow(PathRootError);
    expect(() => mapPortablePath({ root: 'home', relative: 'a\0b' }, { home: '/home/linus' })).toThrow(PathRootError);
  });

  it('probes a real root for space and a missing one as absent', () => {
    const base = tmp();
    fs.mkdirSync(path.join(base, 'home'));
    const probes = probeRoots({ home: path.join(base, 'home'), work: path.join(base, 'gone') });
    expect(probes.home.exists).toBe(true);
    expect(probes.home.writable).toBe(true);
    expect(probes.home.freeBytes).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(base, 'home'))).toEqual([]);
    expect(probes.work).toEqual({ exists: false, writable: false, caseInsensitive: false, freeBytes: 0, collisions: [] });
  });

  it('names what a case-folding destination would collide, and only there', () => {
    const paths = [{ root: 'home', relative: 'Notes/TODO.md' }, { root: 'home', relative: 'notes/todo.md' }, { root: 'home', relative: 'keep.md' }, { root: 'work', relative: 'A.md' }];
    const roots = { home: '/h', work: '/w' };
    const folding = probeRoots(roots, paths, fakeFs({ caseInsensitive: true, free: 8192 }));
    expect(folding.home).toEqual({ exists: true, writable: true, caseInsensitive: true, freeBytes: 8192, collisions: ['Notes/TODO.md', 'notes/todo.md'] });
    expect(folding.work.collisions).toEqual([]);
    expect(probeRoots(roots, paths, fakeFs({ caseInsensitive: false })).home.collisions).toEqual([]);
  });

  it('reports a root it cannot write to', () => {
    const probe = probeRoots({ home: '/h' }, [], fakeFs({ writable: false }));
    expect(probe.home.writable).toBe(false);
    expect(probe.home.exists).toBe(true);
  });
});
