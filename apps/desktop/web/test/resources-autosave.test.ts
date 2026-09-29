import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Api } from '../src/api.js';
import { dropBuffers, editBuffer, loadBuffer, replaceText } from '../src/ide/buffers.js';
import { overwriteFile, saveFile } from '../src/ide/files.js';
import { flushDoc, flushDocs, watchDoc } from '../src/resources/autosave.js';
import { createAppStore } from '../src/store/index.js';
import { theme } from '../src/theme.js';

const ROOT = 'r:/d/islands/i1';

// a docs folder on a disk that checks the mtime a write was read at, the way svalld does
function fake(disk: Record<string, { text: string; mtimeMs: number }>) {
  const calls: string[] = [];
  const api = {
    call: (m: string, p: { path: string; text: string; mtimeMs: number }) => {
      calls.push(m);
      if (m === 'resources.get') return Promise.resolve({ sources: [] });
      if (m !== 'fs.write') return Promise.reject(new Error(m));
      const cur = disk[p.path];
      if (cur && cur.mtimeMs !== p.mtimeMs) return Promise.resolve({ conflict: true, mtimeMs: cur.mtimeMs });
      disk[p.path] = { text: p.text, mtimeMs: (cur?.mtimeMs ?? 0) + 1 };
      return Promise.resolve({ mtimeMs: disk[p.path].mtimeMs });
    },
  } as unknown as Pick<Api, 'call'>;
  const store = createAppStore();
  return { d: { api, store }, disk, store, writes: () => calls.filter((m) => m === 'fs.write').length, reads: () => calls.filter((m) => m === 'resources.get').length };
}

// like `fake`, but fs.write only resolves when `resolveNext` is called, so a write can be held mid-flight
function fakeDeferred(disk: Record<string, { text: string; mtimeMs: number }>) {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const api = {
    call: (m: string, p: { path: string; text: string; mtimeMs: number }) => {
      calls.push(m);
      if (m === 'resources.get') return Promise.resolve({ sources: [] });
      if (m !== 'fs.write') return Promise.reject(new Error(m));
      return new Promise((resolve) => {
        pending.push(() => {
          const cur = disk[p.path];
          if (cur && cur.mtimeMs !== p.mtimeMs) { resolve({ conflict: true, mtimeMs: cur.mtimeMs }); return; }
          disk[p.path] = { text: p.text, mtimeMs: (cur?.mtimeMs ?? 0) + 1 };
          resolve({ mtimeMs: disk[p.path].mtimeMs });
        });
      });
    },
  } as unknown as Pick<Api, 'call'>;
  const store = createAppStore();
  return { d: { api, store }, disk, store, resolveNext: () => pending.shift()?.(), pendingCount: () => pending.length, writes: () => calls.filter((m) => m === 'fs.write').length };
}

const open = (d: ReturnType<typeof fake>['d'], path: string, text: string, mtimeMs = 1) => {
  loadBuffer(ROOT, path, text, mtimeMs, []);
  watchDoc(d, ROOT, path);
};
const type = (path: string, at: number, insert: string) => editBuffer(ROOT, path, { changes: { from: at, insert } });

beforeEach(() => { vi.useFakeTimers(); dropBuffers(ROOT); });
afterEach(async () => { await flushDocs(); vi.useRealTimers(); });

it('writes a doc once the typing has paused for docSaveMs', async () => {
  const f = fake({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  type('a.md', 3, ' two');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs - 1);
  type('a.md', 7, ' three');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs - 1);
  expect(f.writes()).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.disk['a.md'].text).toBe('one two three');
  expect(f.writes()).toBe(1);
});

it('writes nothing for a buffer that matches the disk, such as one read again', async () => {
  const f = fake({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  replaceText(ROOT, 'a.md', 'from disk', 2);
  await vi.advanceTimersByTimeAsync(theme.docSaveMs * 2);
  expect(f.writes()).toBe(0);
});

it('flushDoc writes waiting edits at once, and nothing when none wait', async () => {
  const f = fake({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  await flushDoc(ROOT, 'a.md');
  expect(f.writes()).toBe(0);
  type('a.md', 3, '!');
  await flushDoc(ROOT, 'a.md');
  expect(f.disk['a.md'].text).toBe('one!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs * 2);
  expect(f.writes()).toBe(1);
});

it('flushDocs writes every doc that waits', async () => {
  const f = fake({ 'a.md': { text: 'a', mtimeMs: 1 }, 'b.md': { text: 'b', mtimeMs: 1 } });
  open(f.d, 'a.md', 'a');
  open(f.d, 'b.md', 'b');
  type('a.md', 1, '1');
  type('b.md', 1, '2');
  await flushDocs();
  expect([f.disk['a.md'].text, f.disk['b.md'].text]).toEqual(['a1', 'b2']);
});

it('leaves a doc changed on disk alone, flags the conflict, and writes nothing more while it stands', async () => {
  const f = fake({ 'a.md': { text: 'agent wrote this', mtimeMs: 5 } });
  open(f.d, 'a.md', 'one', 1);
  type('a.md', 3, '!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.disk['a.md'].text).toBe('agent wrote this');
  expect(f.store.getState().ide[ROOT]?.conflict).toContain('a.md');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs * 3);
  type('a.md', 4, '?');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.writes()).toBe(1);
  expect(f.disk['a.md'].text).toBe('agent wrote this');
});

it('flushDoc and flushDocs write a dirty doc with no save waiting, such as one whose save failed', async () => {
  const f = fake({ 'a.md': { text: 'a', mtimeMs: 1 }, 'b.md': { text: 'b', mtimeMs: 1 } });
  const call = f.d.api.call as (m: string, p: unknown) => Promise<unknown>;
  let failing = 2;
  f.d.api.call = ((m: string, p: unknown) => (m === 'fs.write' && failing-- > 0 ? Promise.reject(new Error('disk full')) : call(m, p))) as typeof f.d.api.call;
  open(f.d, 'a.md', 'a');
  open(f.d, 'b.md', 'b');
  type('a.md', 1, '1');
  type('b.md', 1, '2');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.store.getState().toast?.text).toContain('disk full');
  await flushDoc(ROOT, 'a.md');
  expect(f.disk['a.md'].text).toBe('a1');
  await flushDocs();
  expect(f.disk['b.md'].text).toBe('b2');
});

it('flushDoc and flushDocs write nothing more for a doc whose conflict stands', async () => {
  const f = fake({ 'a.md': { text: 'agent wrote this', mtimeMs: 5 } });
  open(f.d, 'a.md', 'one', 1);
  type('a.md', 3, '!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.store.getState().ide[ROOT]?.conflict).toContain('a.md');
  await flushDoc(ROOT, 'a.md');
  await flushDocs();
  expect(f.writes()).toBe(1);
  expect(f.disk['a.md'].text).toBe('agent wrote this');
});

it('reads the listing again when the description changed, and not for a body edit', async () => {
  const f = fake({ 'a.md': { text: '---\ndescription: old\n---\nbody', mtimeMs: 1 } });
  open(f.d, 'a.md', '---\ndescription: old\n---\nbody');
  type('a.md', 29, '!');
  await flushDoc(ROOT, 'a.md');
  expect(f.reads()).toBe(0);
  editBuffer(ROOT, 'a.md', { changes: { from: 17, to: 20, insert: 'new' } });
  await flushDoc(ROOT, 'a.md');
  expect(f.reads()).toBe(1);
});

it('flushDoc waits out a save already in flight, and an edit made during it is written next, chained, with no conflict', async () => {
  const f = fakeDeferred({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  type('a.md', 3, '!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.pendingCount()).toBe(1);

  // an edit lands, and flushDoc is called, while the first write is still outstanding
  type('a.md', 4, '?');
  let flushed = false;
  const flush = flushDoc(ROOT, 'a.md').then(() => { flushed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(flushed).toBe(false);
  expect(f.pendingCount()).toBe(1); // the second write does not start until the first is done

  f.resolveNext();
  await vi.advanceTimersByTimeAsync(0);
  expect(flushed).toBe(false);
  expect(f.disk['a.md'].text).toBe('one!');
  expect(f.pendingCount()).toBe(1); // the chained write is now outstanding, carrying the mtime the first one left

  f.resolveNext();
  await flush;

  expect(flushed).toBe(true);
  expect(f.disk['a.md'].text).toBe('one!?');
  expect(f.writes()).toBe(2);
  expect(f.store.getState().ide[ROOT]?.conflict).not.toContain('a.md');
});

it('an edit made during a write that takes the text back to what the disk had is written next', async () => {
  const f = fakeDeferred({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  type('a.md', 3, '!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.pendingCount()).toBe(1);
  editBuffer(ROOT, 'a.md', { changes: { from: 3, to: 4 } });
  f.resolveNext();
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  f.resolveNext();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.disk['a.md'].text).toBe('one');
  expect(f.writes()).toBe(2);
});

it('a failed write flags the doc and is not tried again until the next edit', async () => {
  const f = fake({ 'a.md': { text: 'a', mtimeMs: 1 } });
  const call = f.d.api.call as (m: string, p: unknown) => Promise<unknown>;
  let failing = 1;
  f.d.api.call = ((m: string, p: unknown) => (m === 'fs.write' && failing-- > 0 ? Promise.reject(new Error('disk full')) : call(m, p))) as typeof f.d.api.call;
  open(f.d, 'a.md', 'a');
  type('a.md', 1, '1');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs * 20);
  expect(f.store.getState().ide[ROOT]?.failed).toEqual(['a.md']);
  expect(f.disk['a.md'].text).toBe('a');
  type('a.md', 2, '2');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.disk['a.md'].text).toBe('a12');
  expect(f.store.getState().ide[ROOT]?.failed).toEqual([]);
});

it('flushDoc waits for a save already in flight when nothing new was typed since', async () => {
  const f = fakeDeferred({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  type('a.md', 3, '!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.pendingCount()).toBe(1);

  let flushed = false;
  const flush = flushDoc(ROOT, 'a.md').then(() => { flushed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(flushed).toBe(false);

  f.resolveNext();
  await flush;
  expect(flushed).toBe(true);
  expect(f.disk['a.md'].text).toBe('one!');
});

it('flushDocs waits for a save already in flight when nothing new was typed since', async () => {
  const f = fakeDeferred({ 'a.md': { text: 'one', mtimeMs: 1 } });
  open(f.d, 'a.md', 'one');
  type('a.md', 3, '!');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.pendingCount()).toBe(1);

  let flushed = false;
  const flush = flushDocs().then(() => { flushed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(flushed).toBe(false);

  f.resolveNext();
  await flush;
  expect(flushed).toBe(true);
  expect(f.disk['a.md'].text).toBe('one!');
});

it('reads the listing again after a description saved directly, such as by Cmd-S', async () => {
  const f = fake({ 'a.md': { text: '---\ndescription: old\n---\nbody', mtimeMs: 1 } });
  open(f.d, 'a.md', '---\ndescription: old\n---\nbody');
  editBuffer(ROOT, 'a.md', { changes: { from: 17, to: 20, insert: 'new' } });
  await saveFile(f.d, ROOT, 'a.md');
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.reads()).toBe(1);
});

it('reads the listing again after a description saved by Overwrite, once a conflict already stood', async () => {
  const f = fake({ 'a.md': { text: '---\ndescription: old\n---\nbody', mtimeMs: 5 } });
  open(f.d, 'a.md', '---\ndescription: old\n---\nbody', 1);
  editBuffer(ROOT, 'a.md', { changes: { from: 17, to: 20, insert: 'new' } });
  await vi.advanceTimersByTimeAsync(theme.docSaveMs);
  expect(f.store.getState().ide[ROOT]?.conflict).toContain('a.md');
  expect(f.reads()).toBe(0);

  await overwriteFile(f.d, ROOT, 'a.md');
  expect(f.reads()).toBe(1);
});
