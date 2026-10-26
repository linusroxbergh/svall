import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type FleetState } from '@svall/protocol';
import { repoSlug } from '../../src/docs.js';
import { sha256Hex } from '../../src/handover/hash.js';
import { silentLogger } from '../../src/log.js';
import { resolvePaths } from '../../src/paths.js';
import { concerns, docsTar, HomeDocs, noteConflict, WorkerDocs } from '../../src/placement/docs-sync.js';
import { Store } from '../../src/store.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { W, placed, robot, until, world } from './world.js';

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

const NOTE = 'robots/c_1/notes.md';
const conflicts = (dir: string): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.conflict.md'));

// a home and its worker w1 that both last held `text` as c_1's note, the link not up yet
function apart(text: string) {
  const w = world({ docs: true, home: { robots: { c_1: placed({ id: 'c_1' }) } }, worker: { robots: { c_1: placed({ id: 'c_1' }) } } });
  stops.push(() => w.stop());
  const dir = path.join(w.home.paths.docs, 'robots/c_1');
  const farDir = path.join(w.worker.paths.cache, 'docs/robots/c_1');
  put(path.join(dir, 'notes.md'), text);
  put(path.join(farDir, 'notes.md'), text);
  put(w.worker.paths.docsSynced, JSON.stringify({ [NOTE]: sha256Hex(Buffer.from(text)) }));
  return { w, dir, farDir };
}

type DocsEvent = { kind: 'docs.write' | 'docs.delete'; data: unknown };

// the worker's docs, last given `text` as c_1's note by the home, journaling into `events` with no home to send them to
async function journaling(text: string) {
  const base = makeHome();
  const home = path.join(base, 'home-docs');
  const dir = path.join(base, 'cache/docs');
  const file = path.join(base, 'cache/docs-synced.json');
  put(path.join(home, NOTE), text);
  put(path.join(dir, NOTE), text);
  put(file, JSON.stringify({ [NOTE]: sha256Hex(Buffer.from(text)) }));
  const events: DocsEvent[] = [];
  const docs = new WorkerDocs({
    dir, file, stage: path.join(base, 'cache'), log: silentLogger, quietMs: 50,
    connection: { journal: (kind, data) => events.push({ kind: kind as DocsEvent['kind'], data }), receiveBlob: () => Promise.reject(new Error('no tar here')) },
  });
  docs.start();
  stops.push(() => docs.stop());
  // macOS may miss a write made as a watch starts
  await nap(500);
  // does `act` and waits for the change it journals
  const next = async (act: () => void) => {
    const n = events.length;
    act();
    await until(() => expect(events).toHaveLength(n + 1));
  };
  return { home, note: path.join(dir, NOTE), events, next };
}

// the home's fleet with c_1 on w1, to hold the note lines conflicts leave
function homeStore(): Store {
  const store = Store.load(resolvePaths(makeHome()).state, () => {});
  store.update((d) => { Object.assign(d, { ...emptyState(), machines: { [W]: { name: 'w1', reachable: true, since: 1 } }, robots: { c_1: placed({ id: 'c_1' }) } }); });
  return store;
}

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

  it('a note the home has no space to write stays unacked and on the worker, and lands once the home can write it', async () => {
    const w = world({ docs: true });
    stops.push(() => w.stop());
    await w.link();
    const note = path.join(w.home.paths.docs, 'robots/c_1/notes.md');
    const temp = (file: fs.PathLike): boolean => String(file).startsWith(`${note}.durable-`);
    let full = true;
    const open = fs.openSync.bind(fs) as (...a: unknown[]) => number;
    const opens = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (full && temp(file)) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${String(file)}'`), { code: 'ENOSPC' });
      return open(file, ...rest);
    }) as typeof fs.openSync);
    stops.push(() => opens.mockRestore());

    const farNote = path.join(w.worker.paths.cache, 'docs/robots/c_1/notes.md');
    put(farNote, 'found the bug\n');
    await until(() => expect(opens.mock.calls.some(([file]) => temp(file))).toBe(true));
    // the link closed on the failed write: the event is in the outbox past the home's ack, and the note is on the worker
    const entry = read(w.worker.paths.outbox).trim().split('\n').map((l) => JSON.parse(l) as { seq: number; kind: string; data: { path: string } })
      .find((e) => e.kind === 'docs.write' && e.data.path === 'robots/c_1/notes.md');
    const acked = fs.existsSync(w.worker.paths.acked) ? Number(read(w.worker.paths.acked)) : 0;
    expect(entry?.seq).toBeGreaterThan(acked);
    expect(fs.existsSync(note)).toBe(false);
    expect(read(farNote)).toBe('found the bug\n');

    full = false;
    await until(() => expect(read(note)).toBe('found the bug\n'));
    // and the docs the home sends once synced again hold it
    await nap(300);
    expect(read(farNote)).toBe('found the bug\n');
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

describe('a doc changed on both machines', () => {
  it('a note changed on both sides lands at home as the home\'s text plus <name>.w1.<id>.conflict.md, named in the robot\'s note, and both files reach the worker', async () => {
    const { w, dir, farDir } = apart('v1\n');
    const journal = vi.spyOn(w.worker.connection, 'journal');
    put(path.join(farDir, 'notes.md'), 'theirs\n');
    put(path.join(dir, 'notes.md'), 'ours\n');
    await w.link();
    const { id } = journal.mock.calls.find(([kind]) => kind === 'docs.write')![1] as { id: string };
    expect(id).toMatch(/^mu_[0-9a-z]{10}$/);
    await until(() => expect(fs.readdirSync(dir).sort()).toEqual(['notes.md', `notes.w1.${id}.conflict.md`]));
    expect(read(path.join(dir, 'notes.md'))).toBe('ours\n');
    expect(read(path.join(dir, `notes.w1.${id}.conflict.md`))).toBe('theirs\n');
    expect(w.home.store.state.robots.c_1).toMatchObject({
      note: `robots/c_1/notes.md changed on both w1 and this Mac; w1's version is kept as notes.w1.${id}.conflict.md`, noteSource: 'manual',
    });
    await until(() => expect(read(path.join(farDir, 'notes.md'))).toBe('ours\n'));
    await until(() => expect(read(path.join(farDir, `notes.w1.${id}.conflict.md`))).toBe('theirs\n'));
  });

  it('after a conflict the worker\'s next edit builds on the home\'s text and applies without another conflict file', async () => {
    const { w, dir, farDir } = apart('v1\n');
    put(path.join(farDir, 'notes.md'), 'theirs\n');
    put(path.join(dir, 'notes.md'), 'ours\n');
    await w.link();
    await until(() => expect(read(path.join(farDir, 'notes.md'))).toBe('ours\n'));
    put(path.join(farDir, 'notes.md'), 'ours, and mine\n');
    await until(() => expect(read(path.join(dir, 'notes.md'))).toBe('ours, and mine\n'));
    expect(conflicts(dir)).toHaveLength(1);
  });

  it('a delete whose base differs keeps the home\'s file and says so in the note', async () => {
    const { w, dir, farDir } = apart('v1\n');
    fs.rmSync(path.join(farDir, 'notes.md'));
    put(path.join(dir, 'notes.md'), 'v2, changed here\n');
    await w.link();
    expect(fs.readdirSync(dir)).toEqual(['notes.md']);
    expect(read(path.join(dir, 'notes.md'))).toBe('v2, changed here\n');
    expect(w.home.store.state.robots.c_1.note).toBe('w1 deleted robots/c_1/notes.md, which changed here since; it stays');
    // and the worker has it back
    await until(() => expect(read(path.join(farDir, 'notes.md'))).toBe('v2, changed here\n'));
  });

  it('a delete refused while linked brings this Mac\'s copy back to the worker at once', async () => {
    const { w, dir, farDir } = apart('v1\n');
    // a change here sends no docs, so only the refusal can
    vi.spyOn(w.home.docs!, 'watch').mockReturnValue(() => {});
    await w.link();
    await until(() => { if (!w.worker.connection.connected()) throw new Error('not live yet'); });
    put(path.join(dir, 'notes.md'), 'v2, changed here\n');
    fs.rmSync(path.join(farDir, 'notes.md'));
    await until(() => expect(w.home.store.state.robots.c_1.note).toBe('w1 deleted robots/c_1/notes.md, which changed here since; it stays'));
    await until(() => expect(read(path.join(farDir, 'notes.md'))).toBe('v2, changed here\n'));
  });

  it('a write whose base is the home\'s current content applies, and a replay of it is nothing', async () => {
    const { w, dir, farDir } = apart('v1\n');
    const applied = vi.spyOn(w.home.docs!, 'apply');
    put(path.join(farDir, 'notes.md'), 'v2\n');
    await w.link();
    expect(read(path.join(dir, 'notes.md'))).toBe('v2\n');
    expect(fs.readdirSync(dir)).toEqual(['notes.md']);
    const [kind, data] = applied.mock.calls[0];
    expect(kind).toBe('docs.write');
    expect(w.home.docs!.apply(kind, data, W)).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual(['notes.md']);
    expect(w.home.store.state.robots.c_1.note).toBe('');
  });

  it('a docs.write without an id, as an older release journaled it, is still taken', async () => {
    const errors: string[] = [];
    const w = world({
      docs: true, home: { robots: { c_1: placed({ id: 'c_1' }) } }, worker: { robots: { c_1: placed({ id: 'c_1' }) } }, homeLog: { info() {}, error: (m) => { errors.push(m); } },
    });
    stops.push(() => w.stop());
    const data = Buffer.from('from an older release\n');
    w.worker.connection.journal('docs.write', { path: NOTE, data: data.toString('base64'), sha256: sha256Hex(data) });
    await w.link();
    expect(read(path.join(w.home.paths.docs, NOTE))).toBe('from an older release\n');
    expect(errors).toEqual([]);
  });

  it('an older release\'s change, with no id or base, to a doc this Mac has is kept as a copy or refused, and said in the log and the note', () => {
    const home = path.join(makeHome(), 'docs');
    put(path.join(home, NOTE), 'here\n');
    put(path.join(home, 'robots/c_1/plan.md'), 'plan\n');
    const infos: string[] = [];
    const docs = new HomeDocs(home, { info: (m) => { infos.push(m); }, error: () => {} }, () => 'w1');
    const store = homeStore();
    const old = (text: string) => ({ data: Buffer.from(text).toString('base64'), sha256: sha256Hex(Buffer.from(text)) });
    const written = docs.apply('docs.write', { path: NOTE, ...old('old\n') }, W)!;
    expect(written).toEqual({ file: NOTE, kept: expect.stringMatching(/^robots\/c_1\/notes\.w1\.mu_[0-9a-z]{10}\.conflict\.md$/) });
    const deleted = docs.apply('docs.delete', { path: 'robots/c_1/plan.md' }, W)!;
    expect(deleted).toEqual({ file: 'robots/c_1/plan.md' });
    for (const c of [written, deleted]) noteConflict(store, W, c, '/Users/ada');
    expect(read(path.join(home, NOTE))).toBe('here\n');
    expect(read(path.join(home, written.kept!))).toBe('old\n');
    expect(read(path.join(home, 'robots/c_1/plan.md'))).toBe('plan\n');
    expect(store.state.robots.c_1.note).toBe([
      `robots/c_1/notes.md changed on both w1 and this Mac; w1's version is kept as ${path.basename(written.kept!)}`,
      'w1 deleted robots/c_1/plan.md, which changed here since; it stays',
    ].join('\n'));
    expect(infos.filter((l) => l.endsWith('carries no id, as an older release journaled it'))).toHaveLength(2);
  });

  it('changes made one after another on the worker apply at home in turn, across restarts of the home, a delete and a new file at that path included', async () => {
    const { home, note, events, next } = await journaling('v1\n');
    await next(() => put(note, 'v2\n'));
    await next(() => put(note, 'v3\n'));
    await next(() => fs.rmSync(note));
    await next(() => put(note, 'v4\n'));
    // a home started afresh for each, as after a restart, so it holds no record of what it took
    for (const e of events) expect(new HomeDocs(home, silentLogger, () => 'w1').apply(e.kind, e.data, W)).toBeUndefined();
    expect(fs.readdirSync(path.join(home, 'robots/c_1'))).toEqual(['notes.md']);
    expect(read(path.join(home, NOTE))).toBe('v4\n');
  });

  it('changes made there to a note this Mac changed too keep one conflict file beside it, holding the last, named for the machine', async () => {
    const { home, note, events, next } = await journaling('v1\n');
    put(path.join(home, NOTE), 'ours\n');
    await next(() => put(note, 'theirs\n'));
    await next(() => put(note, 'theirs, again\n'));
    const docs = new HomeDocs(home, silentLogger, () => "ada's box");
    const { id } = events[0].data as { id: string };
    const kept = { file: NOTE, kept: `robots/c_1/notes.ada-s-box.${id}.conflict.md` };
    expect(events.map((e) => docs.apply(e.kind, e.data, W))).toEqual([kept, kept]);
    // and once more, as after a lost ack
    expect(docs.apply(events[1].kind, events[1].data, W)).toEqual(kept);
    expect(fs.readdirSync(path.join(home, 'robots/c_1')).sort()).toEqual([`notes.ada-s-box.${id}.conflict.md`, 'notes.md']);
    expect(read(path.join(home, NOTE))).toBe('ours\n');
    expect(read(path.join(home, kept.kept))).toBe('theirs, again\n');
  });

  it('a conflict copy edited here is left as it is, and the next change there starts another, named in the note too', async () => {
    const { home, note, events, next } = await journaling('v1\n');
    put(path.join(home, NOTE), 'ours\n');
    const docs = new HomeDocs(home, silentLogger, () => 'w1');
    const store = homeStore();
    await next(() => put(note, 'theirs\n'));
    const first = docs.apply(events[0].kind, events[0].data, W)!;
    noteConflict(store, W, first, '/Users/ada');
    put(path.join(home, first.kept!), 'theirs, merged by hand\n');
    await next(() => put(note, 'theirs, again\n'));
    const second = docs.apply(events[1].kind, events[1].data, W)!;
    noteConflict(store, W, second, '/Users/ada');
    expect(second.kept).toBe(`robots/c_1/notes.w1.${(events[1].data as { id: string }).id}.conflict.md`);
    expect(read(path.join(home, first.kept!))).toBe('theirs, merged by hand\n');
    expect(read(path.join(home, second.kept!))).toBe('theirs, again\n');
    expect(store.state.robots.c_1.note.split('\n')).toEqual([first, second].map((c) => `robots/c_1/notes.md changed on both w1 and this Mac; w1's version is kept as ${path.basename(c.kept!)}`));
  });

  it('a change made on the worker\'s last one is kept beside a note this Mac deleted or set back to the base text since', async () => {
    const { home, note, events, next } = await journaling('v1\n');
    const plan = path.join(path.dirname(note), 'plan.md');
    const docs = new HomeDocs(home, silentLogger, () => 'w1');
    const store = homeStore();
    const take = (e: DocsEvent) => {
      const c = docs.apply(e.kind, e.data, W);
      if (c) noteConflict(store, W, c, '/Users/ada');
      return c;
    };
    // made there, taken here, deleted here, then changed there
    await next(() => put(plan, 'one\n'));
    expect(take(events[0])).toBeUndefined();
    fs.rmSync(path.join(home, 'robots/c_1/plan.md'));
    await next(() => put(plan, 'two\n'));
    const planId = (events[1].data as { id: string }).id;
    expect(take(events[1])).toEqual({ file: 'robots/c_1/plan.md', kept: `robots/c_1/plan.w1.${planId}.conflict.md` });
    // changed there, taken here, set back here, then changed there again
    await next(() => put(note, 'v2\n'));
    expect(take(events[2])).toBeUndefined();
    put(path.join(home, NOTE), 'v1\n');
    await next(() => put(note, 'v3\n'));
    const noteId = (events[3].data as { id: string }).id;
    expect(take(events[3])).toEqual({ file: NOTE, kept: `robots/c_1/notes.w1.${noteId}.conflict.md` });
    expect(fs.readdirSync(path.join(home, 'robots/c_1')).sort()).toEqual(['notes.md', `notes.w1.${noteId}.conflict.md`, `plan.w1.${planId}.conflict.md`]);
    expect(read(path.join(home, NOTE))).toBe('v1\n');
    expect(store.state.robots.c_1.note).toBe([
      `robots/c_1/plan.md changed on both w1 and this Mac; w1's version is kept as plan.w1.${planId}.conflict.md`,
      `robots/c_1/notes.md changed on both w1 and this Mac; w1's version is kept as notes.w1.${noteId}.conflict.md`,
    ].join('\n'));
  });

  it('a conflict concerns the robot whose folder it is in, the worker\'s robots on an island or in a repository by this Mac\'s root, or all of them for the fleet\'s', () => {
    const root = '/home/ada/code/app';
    const state: FleetState = {
      ...emptyState(), machines: { [W]: { name: 'w1', reachable: true, since: 1, home: '/home/ada' } },
      robots: {
        c_1: placed({ id: 'c_1', repo: { root, mainRoot: root, branch: 'main', isWorktree: false } }),
        c_2: placed({ id: 'c_2', islandId: 'i_2' }),
        c_h: robot({ id: 'c_h' }),
      },
    };
    expect(concerns('robots/c_h/notes.md', state, W, '/Users/ada')).toEqual(['c_h']);
    expect(concerns('islands/i_1/plan.md', state, W, '/Users/ada')).toEqual(['c_1']);
    expect(concerns(`repos/${repoSlug('/Users/ada/code/app')}/style.md`, state, W, '/Users/ada')).toEqual(['c_1']);
    expect(concerns(`repos/${repoSlug(root)}/style.md`, state, W, '/Users/ada')).toEqual([]);
    expect(concerns('fleet/tone.md', state, W, '/Users/ada')).toEqual(['c_1', 'c_2']);
  });
});

describe('repo docs of a placed robot', () => {
  it('its brief names the repo folder by this Mac\'s main root, on the worker and on the home', async () => {
    const mainRoot = path.join(os.homedir(), 'code/app');
    const c_1 = placed({ id: 'c_1', cwd: mainRoot, repo: { root: mainRoot, mainRoot, branch: 'main', isWorktree: false } });
    const w = world({ docs: true, home: { robots: { c_1 } }, worker: { robots: { c_1 } } });
    stops.push(() => w.stop());
    await w.link();
    const slug = repoSlug('/Users/ada/code/app');
    await until(() => expect(w.worker.fleet.brief('c_1')).toContain(`- repo: ${path.join(w.worker.paths.docs, 'repos', slug)}\n`));
    expect(w.home.fleet.brief('c_1')).toContain(`- repo: ${path.join(w.home.paths.docs, 'repos', slug)}\n`);
  });
});
