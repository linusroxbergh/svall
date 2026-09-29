import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { caseCollisions, probeFolders, type ProbeFs } from '../../src/handover/probe.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/svall-t-'); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// every entry under a folder and the folder itself, with its mtime and, for a file, its bytes
function snapshot(dir: string): string[] {
  const at = (p: string, name: string) => {
    const st = fs.lstatSync(p, { bigint: true });
    return `${name}:${st.mtimeNs}:${st.isFile() ? fs.readFileSync(p, 'base64') : ''}`;
  };
  return [at(dir, '.'), ...(fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((n) => at(path.join(dir, n), n))];
}

/** Whether the volume under `dir` folds case, as a file written there and asked for by its other case shows. */
function foldsHere(dir: string): boolean {
  fs.writeFileSync(path.join(dir, 'mark'), '');
  return fs.existsSync(path.join(dir, 'MARK'));
}

describe('the folders a destination writes into', () => {
  it('reads a real folder for room without writing anything there, and a missing one as absent', () => {
    const base = tmp();
    const here = path.join(base, 'home');
    fs.mkdirSync(here);
    fs.writeFileSync(path.join(here, 'notes.md'), 'mine\n');
    const before = snapshot(here);
    const probes = probeFolders([here, path.join(base, 'gone')]);
    expect(probes[here]).toMatchObject({ exists: true, writable: true });
    expect(probes[here].freeBytes).toBeGreaterThan(0);
    expect(snapshot(here)).toEqual(before);
    expect(probes[path.join(base, 'gone')]).toEqual({ exists: false, writable: false, caseInsensitive: false, freeBytes: 0 });
  });

  it.skipIf(process.getuid?.() === 0)('reads a folder it cannot write, and whether its volume folds case, all the same', () => {
    const base = tmp();
    const locked = path.join(base, 'Locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o555);
    const folds = foldsHere(base);
    expect(probeFolders([locked])[locked]).toMatchObject({ exists: true, writable: false, caseInsensitive: folds });
    expect(probeFolders([base])[base]).toMatchObject({ exists: true, writable: true, caseInsensitive: folds });
  });

  it('reads the case of a folder that is a volume of its own by a name inside it', () => {
    // /Volumes/work folds case, and the volume above it does not
    const inodes: Record<string, { dev: number; ino: number }> = { '/Volumes': { dev: 1, ino: 1 }, '/Volumes/work': { dev: 2, ino: 1 }, '/Volumes/work/notes': { dev: 2, ino: 5 } };
    const inside = '/Volumes/work/';
    const lstatSync = (p: string) => {
      const found = inodes[p.startsWith(inside) ? inside + p.slice(inside.length).toLowerCase() : p];
      if (!found) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return found;
    };
    const volumes: ProbeFs = {
      existsSync: (p) => p in inodes, accessSync: () => undefined, lstatSync, statSync: lstatSync,
      readdirSync: (p) => (p === '/Volumes/work' ? ['Notes'] : []), statfsSync: () => ({ bavail: 1, bsize: 4096 }),
    };
    expect(probeFolders(['/Volumes/work'], volumes)['/Volumes/work']).toEqual({ exists: true, writable: true, caseInsensitive: true, freeBytes: 4096 });
  });

  it('names the paths that differ only by case, grouped with the names each clashes with', () => {
    expect(caseCollisions(['notes/todo.md', 'b.txt', 'Notes/TODO.md', 'keep.md', 'B.txt'])).toEqual([['B.txt', 'b.txt'], ['Notes/TODO.md', 'notes/todo.md']]);
  });

  it('names the paths that differ only by Unicode normalization, which a Mac holds as one name', () => {
    const [composed, decomposed] = ['caf\u00e9.md', 'cafe\u0301.md'];
    expect(caseCollisions([composed, decomposed, 'CAF\u00c9.MD', 'keep.md'])).toEqual([['CAF\u00c9.MD', composed, decomposed].sort()]);
  });
});
