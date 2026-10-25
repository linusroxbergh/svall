import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/handover/hash.js';
import { silentLogger } from '../../src/log.js';
import { docsTar, WorkerDocs } from '../../src/placement/docs-sync.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { W, until, world } from './world.js';

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  cleanHomes();
});

const put = (file: string, data: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('docs between the home and a worker', () => {
  it('a note written under the worker\'s docs reaches the home\'s docs folder once and is not echoed back', async () => {
    const w = world({ docs: true });
    stops.push(() => w.stop());
    const homeDocs = w.home.docs!;
    put(path.join(w.home.paths.docs, 'fleet/plan.md'), 'the plan\n');
    const pushes = vi.spyOn(homeDocs, 'push');
    const applied = vi.spyOn(homeDocs, 'apply');
    await w.link();
    const farDocs = path.join(w.worker.paths.cache, 'docs');
    await until(() => expect(read(path.join(farDocs, 'fleet/plan.md'))).toBe('the plan\n'));
    // macOS also reports a write made just before a watch starts
    await nap(600);
    const sent = pushes.mock.calls.length;

    put(path.join(farDocs, 'robots/c_1/notes.md'), 'found the bug\n');
    const note = path.join(w.home.paths.docs, 'robots/c_1/notes.md');
    await until(() => expect(read(note)).toBe('found the bug\n'));
    // both watchers have seen the other side's write by now
    await nap(600);
    expect(applied.mock.calls.map(([kind, data]) => [kind, (data as { path: string }).path])).toEqual([['docs.write', 'robots/c_1/notes.md']]);
    expect(pushes).toHaveBeenCalledTimes(sent);

    // a replay after a lost ack writes nothing
    const before = fs.statSync(note);
    homeDocs.apply('docs.write', applied.mock.calls[0][1], W);
    expect(fs.statSync(note)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });

    // a change of the home's own goes out
    put(path.join(w.home.paths.docs, 'fleet/plan.md'), 'the new plan\n');
    await until(() => expect(read(path.join(farDocs, 'fleet/plan.md'))).toBe('the new plan\n'));
    expect(pushes.mock.calls.length).toBeGreaterThan(sent);
    expect(applied).toHaveBeenCalledTimes(2);
  });

  it('a tar the home packed before it took the worker\'s note leaves the note, and one packed after takes the home\'s copy', async () => {
    const base = makeHome();
    const dir = path.join(base, 'cache/docs');
    const home = path.join(base, 'home-docs');
    const journaled: { kind: string; data: unknown }[] = [];
    let tar: Buffer = Buffer.alloc(0);
    const docs = new WorkerDocs({
      dir, file: path.join(base, 'cache/docs-synced.json'), stage: path.join(base, 'cache'), log: silentLogger, quietMs: 50,
      connection: {
        journal: (kind, data) => journaled.push({ kind, data }),
        receiveBlob: async (_id, into) => { fs.writeFileSync(into, tar); return { sha256: sha256Hex(tar) }; },
      },
    });
    docs.start();
    stops.push(() => docs.stop());
    // the home's docs as packed when it had taken the worker's events up to `seq`
    const send = async (seq: number) => {
      tar = await docsTar(home);
      await docs.handlers['docs.blob']({ id: `docs_${seq}`, sha256: sha256Hex(tar), seq });
    };

    put(path.join(home, 'fleet/plan.md'), 'v1\n');
    await send(0);
    await until(() => expect(read(path.join(dir, 'fleet/plan.md'))).toBe('v1\n'));
    put(path.join(dir, 'robots/c_1/notes.md'), 'mine\n');
    await until(() => expect(journaled.map((j) => j.kind)).toEqual(['docs.write']));

    put(path.join(home, 'fleet/plan.md'), 'v2\n');
    await send(0);
    await until(() => expect(read(path.join(dir, 'fleet/plan.md'))).toBe('v2\n'));
    expect(read(path.join(dir, 'robots/c_1/notes.md'))).toBe('mine\n');

    put(path.join(home, 'robots/c_1/notes.md'), 'mine, edited at home\n');
    fs.rmSync(path.join(home, 'fleet/plan.md'));
    await send(1);
    await until(() => expect(read(path.join(dir, 'robots/c_1/notes.md'))).toBe('mine, edited at home\n'));
    expect(fs.existsSync(path.join(dir, 'fleet/plan.md'))).toBe(false);
    await nap(300);
    expect(journaled).toHaveLength(1);
  });
});
