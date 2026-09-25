import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import { dropBuffers, editBuffer, loadBuffer } from '../src/ide/buffers.js';
import { followQuit, QUIT_FLUSH_MS, unsavedFiles } from '../src/quit.js';
import { watchDoc } from '../src/resources/autosave.js';
import { createAppStore } from '../src/store/index.js';

const ROOT = 'r:/d/islands/quit';

function fakeBridge() {
  const sent: ToShell[] = [];
  const handlers = new Set<(m: FromShell) => void>();
  return {
    sent,
    send: (m: ToShell) => { sent.push(m); },
    onMessage: (h: (m: FromShell) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    emit: (m: FromShell) => { for (const h of handlers) h(m); },
  };
}

// a disk that takes every write, or holds each one until `release` while `hold` is set
function setup(o: { hold?: boolean } = {}) {
  const disk: Record<string, string> = {};
  const held: (() => void)[] = [];
  const api = {
    call: (m: string, p: { path: string; text: string }) => {
      if (m === 'resources.get') return Promise.resolve({ sources: [] });
      if (m !== 'fs.write') return Promise.reject(new Error(m));
      const write = () => { disk[p.path] = p.text; return { mtimeMs: 2 }; };
      return o.hold ? new Promise((resolve) => { held.push(() => resolve(write())); }) : Promise.resolve(write());
    },
  } as unknown as Pick<Api, 'call'>;
  const store = createAppStore();
  const bridge = fakeBridge();
  const stop = followQuit({ store, bridge });
  // a doc open on the shelf with an edit the autosave has not written yet, flagged as the editor flags it
  const edit = (path: string, text: string) => {
    loadBuffer(ROOT, path, '', 1, []);
    watchDoc({ api, store }, ROOT, path);
    editBuffer(ROOT, path, { changes: { from: 0, insert: text } });
    store.getState().markFile(ROOT, path, { dirty: true });
  };
  const answers = () => bridge.sent.filter((m) => m.type === 'quit.answer');
  return { store, bridge, disk, edit, answers, release: () => held.shift()?.(), stop };
}

beforeEach(() => { vi.useFakeTimers(); dropBuffers(ROOT); });
afterEach(() => { vi.useRealTimers(); });

describe('followQuit', () => {
  it('tells the shell the chord that quits, again when it is rebound, and none once it is unbound', () => {
    const { store, bridge, stop } = setup();
    expect(bridge.sent).toEqual([{ type: 'keys.quit', chord: 'cmd+q' }]);
    store.getState().setSettings({ bindings: { quit: 'cmd+shift+q' } });
    store.getState().setSettings({ bindings: { quit: null } });
    expect(bridge.sent.slice(1)).toEqual([{ type: 'keys.quit', chord: 'cmd+shift+q' }, { type: 'keys.quit' }]);
    stop();
  });

  it('writes the docs waiting to be saved before it answers, and names nothing then', async () => {
    const q = setup();
    q.edit('a.md', 'typed');
    q.bridge.emit({ type: 'quit.ask' });
    await vi.advanceTimersByTimeAsync(0);
    expect(q.disk['a.md']).toBe('typed');
    expect(q.answers()).toEqual([{ type: 'quit.answer', unsaved: [] }]);
    q.stop();
  });

  it('names a file edited in the Files pane, which is only saved by hand', async () => {
    const q = setup();
    q.store.getState().markFile('c1', '/repo/src/main.ts', { dirty: true });
    q.bridge.emit({ type: 'quit.ask' });
    await vi.advanceTimersByTimeAsync(0);
    expect(q.answers()).toEqual([{ type: 'quit.answer', unsaved: ['main.ts'] }]);
    q.stop();
  });

  it('answers once the wait runs out, naming a doc whose write has not come back', async () => {
    const q = setup({ hold: true });
    q.edit('b.md', 'slow');
    q.bridge.emit({ type: 'quit.ask' });
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_MS - 1);
    expect(q.answers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(q.answers()).toEqual([{ type: 'quit.answer', unsaved: ['b.md'] }]);
    q.release();
    await vi.advanceTimersByTimeAsync(0);
    q.stop();
  });
});

it('unsavedFiles names every dirty file across characters and shelf roots', () => {
  const store = createAppStore();
  store.getState().markFile('c1', '/repo/a.ts', { dirty: true });
  store.getState().markFile('c2', 'notes/b.md', { dirty: true });
  store.getState().markFile('c2', 'clean.md', { dirty: false });
  expect(unsavedFiles(store.getState().ide)).toEqual(['a.ts', 'b.md']);
});

it('unsavedFiles names two files that share a name by their paths', () => {
  const store = createAppStore();
  store.getState().markFile('c1', '/repo/src/main.ts', { dirty: true });
  store.getState().markFile('c2', '/repo-wt/src/main.ts', { dirty: true });
  store.getState().markFile('c2', '/repo-wt/README.md', { dirty: true });
  expect(unsavedFiles(store.getState().ide)).toEqual(['/repo/src/main.ts', '/repo-wt/src/main.ts', 'README.md']);
});
