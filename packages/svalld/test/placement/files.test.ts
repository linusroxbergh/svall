import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineId, emptyState, farRootId, type Event, type ResourceSource } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import { docsDir, repoSlug } from '../../src/docs.js';
import { relocate } from '../../src/handover/relocate.js';
import type { HomeLinks } from '../../src/link/home.js';
import { silentLogger } from '../../src/log.js';
import { resolvePaths } from '../../src/paths.js';
import { FarViewers } from '../../src/placement/far-viewers.js';
import { Router } from '../../src/placement/router.js';
import { mergeSources } from '../../src/resources/merge.js';
import { Store } from '../../src/store.js';
import type { Viewer } from '../../src/terminals.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { H, W, placed, until, world } from './world.js';

const worlds: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

// a clone on the worker whose main commits a.txt, and the worktree c_1 stands in, which has changed it
function clone(): { dir: string; main: string; tree: string } {
  const dir = fs.realpathSync(makeHome());
  const main = path.join(dir, 'kanban');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'first');
  const tree = path.join(main, '.worktrees', 'feat');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', tree);
  fs.writeFileSync(path.join(tree, 'a.txt'), 'changed\n');
  return { dir, main, tree };
}

// the home and w1 linked, both holding c_1 in the worktree; `sockets` are the link's streams, newest last
async function linked() {
  const { dir, main, tree } = clone();
  const c_1 = placed({ id: 'c_1', cwd: tree, repo: { root: tree, mainRoot: main, branch: 'feat', isWorktree: true } });
  const sockets: net.Socket[] = [];
  const w = world({
    home: { robots: { c_1 } }, worker: { robots: { c_1 } },
    connect: async () => {
      const s = net.connect(w.worker.paths.linkSock);
      await once(s, 'connect');
      sockets.push(s);
      return { stream: s, via: { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' } };
    },
  });
  worlds.push(w);
  await w.link();
  await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
  return { w, dir, main, tree, sockets };
}

describe('files of a robot on a worker', () => {
  it('repo.status and repo.file for a placed robot answer from the worker\'s worktree; fs.list and fs.read too, by robot id from its worktree and by its worker root from main', async () => {
    const { w, main, tree } = await linked();
    expect(await dispatch({ id: 1, method: 'repo.status', params: { id: 'c_1' } }, w.home.ctx)).toMatchObject({ result: { branch: 'feat', files: [{ path: 'a.txt', status: 'M' }] } });
    expect(await dispatch({ id: 2, method: 'repo.file', params: { id: 'c_1', path: 'a.txt' } }, w.home.ctx)).toEqual({ id: 2, result: { before: 'one\n', after: 'changed\n' } });
    expect(await dispatch({ id: 2, method: 'fs.read', params: { id: 'c_1', path: 'a.txt' } }, w.home.ctx)).toMatchObject({ result: { text: 'changed\n', root: tree } });
    expect(await dispatch({ id: 3, method: 'fs.read', params: { id: farRootId(W, main), path: 'a.txt' } }, w.home.ctx)).toMatchObject({ result: { text: 'one\n', root: main } });
    // the path alone names a folder on this Mac, where no robot works in it
    expect(await dispatch({ id: 3, method: 'fs.read', params: { id: `r:${main}`, path: 'a.txt' } }, w.home.ctx)).toMatchObject({ error: { code: 'not_found' } });
    expect(await dispatch({ id: 4, method: 'fs.list', params: { id: 'c_1', path: '' } }, w.home.ctx)).toEqual({ id: 4, result: { entries: [{ name: 'a.txt', kind: 'file' }] } });
  });

  it('a 1.5 MB file reads whole over the link', async () => {
    const { w, tree } = await linked();
    fs.writeFileSync(path.join(tree, 'big.txt'), 'x'.repeat(1_572_864));
    const r = await dispatch({ id: 1, method: 'fs.read', params: { id: 'c_1', path: 'big.txt' } }, w.home.ctx) as { result: { text: string } };
    expect(r.result.text.length).toBe(1_572_864);
  });

  it('fs.write on a placed robot\'s root is refused as read-only naming the machine', async () => {
    const { w, main, tree } = await linked();
    const write = (id: string) => dispatch({ id: 1, method: 'fs.write', params: { id, path: 'a.txt', text: 'mine\n', mtimeMs: 0 } }, w.home.ctx);
    expect(await write('c_1')).toEqual({ id: 1, error: { code: 'read_only', message: 'a.txt is on w1; edit it in the robot\'s terminal' } });
    expect(await write(farRootId(W, main))).toEqual({ id: 1, error: { code: 'read_only', message: 'a.txt is on w1; edit it in the robot\'s terminal' } });
    expect(fs.readFileSync(path.join(tree, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(fs.readFileSync(path.join(main, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('repo.watch on a placed robot is forwarded once per viewer, a change there reaches that viewer as repo.changed, and the watch is forwarded again after a relink', async () => {
    const { w, tree, sockets } = await linked();
    let calls = 0;
    const far = w.worker.handlers['far.repo.watch'];
    w.worker.handlers['far.repo.watch'] = (p) => { calls++; return far(p); };
    const got: Event[] = [];
    const viewer: Viewer = { kind: 'app', send: (ev) => got.push(ev), backlog: () => 0 };
    const ctx = { ...w.home.ctx, viewer };
    expect(await dispatch({ id: 1, method: 'repo.watch', params: { id: 'c_1' } }, ctx)).toEqual({ id: 1, result: {} });
    expect(await dispatch({ id: 2, method: 'repo.watch', params: { id: 'c_1' } }, ctx)).toEqual({ id: 2, result: {} });
    expect(calls).toBe(1);
    fs.writeFileSync(path.join(tree, 'b.txt'), 'new\n');
    await until(() => expect(got).toContainEqual({ event: 'repo.changed', data: { id: 'c_1' } }));

    sockets.at(-1)!.destroy();
    await until(() => expect(calls).toBe(2));
    got.length = 0;
    fs.writeFileSync(path.join(tree, 'c.txt'), 'newer\n');
    await until(() => expect(got).toContainEqual({ event: 'repo.changed', data: { id: 'c_1' } }));
  });

  it('resources.get at home lists the worker\'s repo source with the home\'s docs folder, and none of its global or docs sources', async () => {
    const { w, dir, main } = await linked();
    // the worker's user folder, which its clones are named from on this Mac
    w.home.store.update((d) => { d.machines![W] = { ...d.machines![W], home: dir }; });
    const homeKey = relocate(main, { from: dir, to: '/Users/ada' });
    const folder = docsDir(w.home.paths.docs, 'repo', repoSlug(homeKey));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'notes.md'), '# notes\n');
    fs.writeFileSync(path.join(main, 'CLAUDE.md'), '# kanban\n');
    fs.writeFileSync(path.join(main, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db' } } }));
    // a slug folder in the worker's copy of the docs, which only that copy names
    const farOrphan = docsDir(w.worker.paths.docs, 'repo', 'gone-0123abcd');
    fs.mkdirSync(farOrphan, { recursive: true });
    fs.writeFileSync(path.join(farOrphan, 'old.md'), '# old\n');

    const { sources } = (await dispatch({ id: 1, method: 'resources.get', params: {} }, w.home.ctx) as { result: { sources: ResourceSource[] } }).result;
    const repos = sources.filter((s) => s.tier === 'repo');
    expect(repos).toEqual([expect.objectContaining({ rootId: farRootId(W, main), root: main, docs: `r:${folder}`, robotIds: ['c_1'] })]);
    expect(repos[0].groups.flatMap((g) => g.items.map((i) => i.open?.rootId))).toEqual([`r:${folder}`, farRootId(W, main)]);
    expect(repos[0].groups.map((g) => [g.kind, g.items.map((i) => i.name)])).toEqual([['docs', ['notes']], ['instructions', ['CLAUDE.md']]]);
    expect(sources.filter((s) => s !== repos[0] && (s.root === folder || s.docs === `r:${folder}`))).toEqual([]);
    expect(sources.filter((s) => s.root.startsWith(w.worker.paths.home))).toEqual([]);
  });

  it('docs.create makes the first doc of a placed robot\'s clone in this Mac\'s folder for it', async () => {
    const { w, dir, main } = await linked();
    w.home.store.update((d) => { d.machines![W] = { ...d.machines![W], home: dir }; });
    const folder = docsDir(w.home.paths.docs, 'repo', repoSlug(relocate(main, { from: dir, to: '/Users/ada' })));
    const { sources } = (await dispatch({ id: 1, method: 'resources.get', params: {} }, w.home.ctx) as { result: { sources: ResourceSource[] } }).result;
    const docs = sources.find((s) => s.tier === 'repo')!.docs!;
    expect(docs).toBe(`r:${folder}`);
    expect(await dispatch({ id: 2, method: 'docs.create', params: { id: docs, path: 'first.md', text: '# first\n' } }, w.home.ctx)).toMatchObject({ result: { mtimeMs: expect.any(Number) } });
    expect(fs.readFileSync(path.join(folder, 'first.md'), 'utf8')).toBe('# first\n');
  });
});

describe('clones at one path on two workers', () => {
  it('keep apart: each merged source and row names its worker, and a call by one goes to that worker with the path alone', async () => {
    const W2 = MachineId.parse('0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
    const root = '/home/ada/src/kanban';
    const repo = { root, mainRoot: root, branch: 'main', isWorktree: false };
    const store = Store.load(resolvePaths(makeHome()).state, () => {});
    store.update((d) => { Object.assign(d, { ...emptyState(), robots: { c_1: placed({ id: 'c_1', cwd: root, repo }), c_2: placed({ id: 'c_2', cwd: root, repo, machine: W2 }) } }); });
    const asked: unknown[] = [];
    const links = { call: async (machine: MachineId, method: string, params: unknown) => { asked.push([machine, method, params]); return { text: machine, mtimeMs: 1, root }; } };
    const router = new Router({ store, me: H, log: silentLogger, links: links as unknown as Pick<HomeLinks, 'call'> });
    expect(router.rootPlacedAt(farRootId(W, root))).toBe(W);
    expect(router.rootPlacedAt(farRootId(W2, root))).toBe(W2);
    expect(router.rootPlacedAt(`r:${root}`)).toBeUndefined();
    expect(await router.forwardRoot(farRootId(W2, root), 'fs.read', { id: farRootId(W2, root), path: 'a.txt' })).toEqual({ text: W2, mtimeMs: 1, root });
    expect(asked).toEqual([[W2, 'fs.read', { id: `r:${root}`, path: 'a.txt' }]]);

    const far = (id: string): ResourceSource => ({
      rootId: `r:${root}`, root, name: 'kanban', tier: 'repo', islandIds: ['i_1'], robotIds: [id],
      groups: [{ kind: 'instructions', items: [{ id: `instructions\u0000${root}/CLAUDE.md\u0000CLAUDE.md`, name: 'CLAUDE.md', reveal: `${root}/CLAUDE.md`, target: 'file', open: { rootId: `r:${root}`, path: 'CLAUDE.md' } }] }],
    });
    const merged = mergeSources([], [{ machine: W, sources: [far('c_1')] }, { machine: W2, sources: [far('c_2')] }], { docs: '/tmp/docs', machines: {}, homedir: '/Users/ada' });
    expect(merged.map((s) => s.rootId)).toEqual([farRootId(W, root), farRootId(W2, root)]);
    expect(merged.map((s) => s.groups[0].items[0].open?.rootId)).toEqual([farRootId(W, root), farRootId(W2, root)]);
    expect(new Set(merged.map((s) => s.groups[0].items[0].id)).size).toBe(2);
  });
});

describe('a home viewer on the worker', () => {
  it('holds a file change while the link is behind, one per robot, and sends it once the link has caught up', () => {
    vi.useFakeTimers();
    try {
      let backlog = 2 * 1024 * 1024;
      const sent: unknown[] = [];
      const v = new FarViewers({ connection: { notify: (kind, data) => { sent.push([kind, data]); }, backlog: () => backlog } }).get('k1', 'app');
      for (const id of ['c_1', 'c_1', 'c_2']) v.send({ event: 'repo.changed', data: { id } });
      vi.advanceTimersByTime(1000);
      expect(sent).toEqual([]);
      backlog = 0;
      vi.advanceTimersByTime(100);
      const changed = (id: string) => ['viewer', { key: 'k1', ev: { event: 'repo.changed', data: { id } } }];
      expect(sent).toEqual([changed('c_1'), changed('c_2')]);
    } finally {
      vi.useRealTimers();
    }
  });
});
