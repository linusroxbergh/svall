import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { caseCollisions, probeFolders, type ProbeFs } from '../../src/handover/probe.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/archi-t-'); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// a folder that answers the way the flags say, wherever it is asked
function fakeFs(o: { writable?: boolean; caseInsensitive?: boolean; free?: number } = {}): ProbeFs {
  const files = new Set<string>();
  return {
    existsSync: () => true,
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

describe('the folders a destination writes into', () => {
  it('probes a real folder for room, leaving nothing behind, and a missing one as absent', () => {
    const base = tmp();
    const here = path.join(base, 'home');
    fs.mkdirSync(here);
    const probes = probeFolders([here, path.join(base, 'gone')]);
    expect(probes[here]).toMatchObject({ exists: true, writable: true });
    expect(probes[here].freeBytes).toBeGreaterThan(0);
    expect(fs.readdirSync(here)).toEqual([]);
    expect(probes[path.join(base, 'gone')]).toEqual({ exists: false, writable: false, caseInsensitive: false, freeBytes: 0 });
  });

  it('says which fold case and which cannot be written', () => {
    expect(probeFolders(['/h'], fakeFs({ caseInsensitive: true, free: 8192 }))['/h']).toEqual({ exists: true, writable: true, caseInsensitive: true, freeBytes: 8192 });
    expect(probeFolders(['/h'], fakeFs({ writable: false }))['/h']).toMatchObject({ exists: true, writable: false, caseInsensitive: false });
  });

  it('names the paths that differ only by case', () => {
    expect(caseCollisions(['Notes/TODO.md', 'notes/todo.md', 'keep.md'])).toEqual(['Notes/TODO.md', 'notes/todo.md']);
  });
});
