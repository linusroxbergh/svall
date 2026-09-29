import { describe, expect, it } from 'vitest';
import { ApiError, type Api } from '../src/api.js';
import type { Bridge, FromShell, ToShell } from '../src/bridge.js';
import { createAppStore } from '../src/store/index.js';
import { createTerminalManager, secondKey } from '../src/terminals.js';
import { fleet } from './fixtures.js';

const rect = { x: 0, y: 20, width: 800, height: 580 };

function fakes(opts: { offline?: boolean; refuse?: boolean } = {}) {
  const sent: ToShell[] = [];
  const handlers = new Set<(m: FromShell) => void>();
  const bridge: Bridge & { emit(m: FromShell): void } = {
    present: true,
    send: (m) => { sent.push(m); },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    emit: (m) => { for (const h of handlers) h(m); },
  };
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (opts.offline) return Promise.reject(new Error('svalld offline'));
      if (opts.refuse && method === 'term.attach') return Promise.reject(new ApiError('not_found', 'no such character'));
      if (method === 'term.attach') { const p = params as { id: string; term?: 2 }; return Promise.resolve({ socket: '/tmp/s', session: `v-${p.id}${p.term === 2 ? '-2' : ''}` }); }
      return Promise.resolve({});
    },
  } as unknown as Api;
  const store = createAppStore();
  store.getState().setFleet(fleet());
  return { sent, calls, bridge, api, store, opts, manager: createTerminalManager(api, bridge, store, { reshowDelayMs: 0 }) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('terminal manager', () => {
  it('attaches once, shows, focuses, then reuses the surface', async () => {
    const { sent, calls, store, manager } = fakes();
    store.getState().focus('c0');
    await manager.show('c0', rect);
    expect(calls.map((c) => c.method)).toContain('term.attach');
    expect(sent).toContainEqual({ type: 'term.show', id: 'c0', rect, attach: { socket: '/tmp/s', session: 'v-c0' } });
    expect(sent.at(-1)).toEqual({ type: 'term.focus', id: 'c0' });
    expect(store.getState().terminals.c0.rect).toEqual(rect);
    const attaches = calls.filter((c) => c.method === 'term.attach').length;
    await manager.show('c0', { ...rect, width: 500 });
    expect(calls.filter((c) => c.method === 'term.attach').length).toBe(attaches);
    expect(sent.at(-2)).toEqual({ type: 'term.show', id: 'c0', rect: { ...rect, width: 500 } });
    manager.move('c0', { ...rect, width: 400 });
    expect(store.getState().terminals.c0.rect.width).toBe(400);
    manager.hide('c0');
    expect(sent.at(-1)).toEqual({ type: 'term.hide', id: 'c0' });
  });

  it('a new opacity on an open surface restates it without hiding or re-attaching', async () => {
    const { sent, calls, store, manager } = fakes();
    store.getState().focus('c0');
    await manager.show('c0', rect, 1);
    const attaches = calls.filter((c) => c.method === 'term.attach').length;
    sent.length = 0;
    await manager.show('c0', rect, 0.92);
    expect(calls.filter((c) => c.method === 'term.attach').length).toBe(attaches);
    expect(sent.filter((m) => m.type === 'term.hide')).toEqual([]);
    expect(sent[0]).toEqual({ type: 'term.show', id: 'c0', rect, opacity: 0.92 });
  });

  it('restates an open surface without taking focus when asked not to', async () => {
    const { sent, store, manager } = fakes();
    store.getState().focus('c0');
    await manager.show('c0', rect, 1);
    sent.length = 0;
    await manager.show('c0', rect, 0.5, false);
    expect(sent).toEqual([{ type: 'term.show', id: 'c0', rect, opacity: 0.5 }]);
  });

  it('hides a surface whose character lost focus while attaching', async () => {
    const { sent, store, manager } = fakes();
    store.getState().focus('c0');
    const p = manager.show('c0', rect);
    store.getState().focus('c1');
    await p;
    expect(sent.at(-1)).toEqual({ type: 'term.hide', id: 'c0' });
  });

  it('marks the terminal seen when it comes into view and when unread arrives while looking', async () => {
    const { calls, store } = fakes();
    store.getState().focus('c0');
    await flush();
    expect(calls).toContainEqual({ method: 'char.seen', params: { id: 'c0' } });
    const n = calls.length;
    store.getState().applyPatch([{ op: 'replace', path: '/characters/c0/unread', value: true }]);
    await flush();
    expect(calls.slice(n)).toContainEqual({ method: 'char.seen', params: { id: 'c0' } });
    const n2 = calls.length;
    store.getState().applyPatch([{ op: 'replace', path: '/characters/c1/name', value: 'x' }]);
    await flush();
    expect(calls.slice(n2)).not.toContainEqual({ method: 'char.seen', params: { id: 'c0' } });
  });

  it('does not mark seen while the app is inactive, and catches up when it becomes active', async () => {
    const { calls, store } = fakes();
    store.getState().setActive(false);
    store.getState().focus('c0');
    await flush();
    expect(calls).not.toContainEqual({ method: 'char.seen', params: { id: 'c0' } });
    store.getState().setActive(true);
    await flush();
    expect(calls).toContainEqual({ method: 'char.seen', params: { id: 'c0' } });
  });

  it('re-attaches a live character whose tmux client died while in view', async () => {
    const { sent, calls, store, bridge, manager } = fakes();
    store.getState().focus('c0');
    await manager.show('c0', rect);
    bridge.emit({ type: 'term.exited', id: 'c0' });
    expect(store.getState().terminals.c0).toBeUndefined();
    await flush(); await flush();
    expect(calls.filter((c) => c.method === 'term.attach')).toHaveLength(2);
    expect(sent.at(-2)).toEqual({ type: 'term.show', id: 'c0', rect, attach: { socket: '/tmp/s', session: 'v-c0' } });
    expect(store.getState().terminals.c0.rect).toEqual(rect);
  });

  it('retries an attach that failed while offline once svalld is back', async () => {
    const f = fakes({ offline: true });
    const { sent, calls, store, manager } = f;
    store.getState().setStatus('offline');
    store.getState().focus('c0');
    await expect(manager.show('c0', rect)).rejects.toThrow(/offline/);
    expect(store.getState().terminals.c0).toBeUndefined();
    f.opts.offline = false;
    store.getState().setStatus('online');
    await flush();
    expect(calls.filter((c) => c.method === 'term.attach')).toHaveLength(2);
    expect(sent).toContainEqual({ type: 'term.show', id: 'c0', rect, attach: { socket: '/tmp/s', session: 'v-c0' } });
  });

  it('does not retry an attach for a character no longer in view', async () => {
    const f = fakes({ offline: true });
    const { calls, store, manager } = f;
    store.getState().focus('c0');
    await manager.show('c0', rect).catch(() => {});
    store.getState().focus('c1');
    f.opts.offline = false;
    store.getState().setStatus('online');
    await flush();
    expect(calls.filter((c) => c.method === 'term.attach')).toHaveLength(1);
  });

  it('records an attach svalld refused instead of retrying it, until asked again', async () => {
    const f = fakes({ refuse: true });
    const { calls, store, manager } = f;
    store.getState().focus('c0');
    await expect(manager.show('c0', rect)).rejects.toThrow(/no such character/);
    expect(store.getState().terminalErrors.c0).toBe('no such character');
    store.getState().setStatus('offline');
    store.getState().setStatus('online');
    await flush();
    expect(calls.filter((c) => c.method === 'term.attach')).toHaveLength(1);
    f.opts.refuse = false;
    store.getState().termRetry('c0');
    expect(store.getState().terminalErrors.c0).toBeUndefined();
    await manager.show('c0', rect);
    expect(store.getState().terminals.c0).toBeDefined();
  });

  it('keeps no error for a character whose window died under the attach', async () => {
    const f = fakes({ refuse: true });
    const { store, manager } = f;
    store.getState().focus('c0');
    // the window dies while term.attach is in flight, so the character is dormant by the time it fails
    const shown = manager.show('c0', rect);
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0/tmux' }]);
    await expect(shown).rejects.toThrow(/no such character/);
    expect(store.getState().terminalErrors.c0).toBeUndefined();
  });

  it('a surface that could not start shows why and is not reshown', async () => {
    const { calls, store, bridge, manager } = fakes();
    store.getState().focus('c0');
    await manager.show('c0', rect);
    bridge.emit({ type: 'term.failed', id: 'c0', reason: 'tmux quit as soon as it started' });
    expect(store.getState().terminals.c0).toBeUndefined();
    expect(store.getState().terminalErrors.c0).toBe('tmux quit as soon as it started');
    await flush(); await flush();
    expect(calls.filter((c) => c.method === 'term.attach')).toHaveLength(1);
  });

  it('drops terminals that exit, vanish or go dormant', async () => {
    const { sent, store, bridge, manager } = fakes();
    await manager.show('c0', rect);
    await manager.show('c1', rect);
    bridge.emit({ type: 'term.exited', id: 'c0' });
    expect(store.getState().terminals.c0).toBeUndefined();
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c1/tmux' }]);
    expect(sent).toContainEqual({ type: 'term.close', id: 'c1' });
    expect(store.getState().terminals.c1).toBeUndefined();
    await manager.show('c2', rect);
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c2' }]);
    expect(store.getState().terminals.c2).toBeUndefined();
    store.getState().termFailed('c0', 'x');
    store.getState().applyPatch([{ op: 'remove', path: '/characters/c0/tmux' }]);
    expect(store.getState().terminalErrors.c0).toBeUndefined();
  });

  it('treats the map card as in view: shows with opacity, marks seen, reshows after exit', async () => {
    const { sent, calls, store, manager, bridge } = fakes();
    store.getState().focus('c0');
    await manager.show('c0', rect, 0.92);
    expect(sent).toContainEqual({ type: 'term.show', id: 'c0', rect, opacity: 0.92, attach: { socket: '/tmp/s', session: 'v-c0' } });
    expect(sent.at(-1)).toEqual({ type: 'term.focus', id: 'c0' });
    expect(calls.some((x) => x.method === 'char.seen' && (x.params as { id: string }).id === 'c0')).toBe(true);
    bridge.emit({ type: 'term.exited', id: 'c0' });
    await flush();
    expect(sent.filter((m) => m.type === 'term.show' && m.id === 'c0')).toHaveLength(2);
    store.getState().closeCard();
    bridge.emit({ type: 'term.exited', id: 'c0' });
    await flush();
    expect(sent.filter((m) => m.type === 'term.show' && m.id === 'c0')).toHaveLength(2);
  });

  it('treats the board selection as in view', async () => {
    const { sent, calls, store, manager } = fakes();
    store.getState().setView('board');
    store.getState().select('c1');
    await manager.show('c1', rect);
    expect(sent.at(-1)).toEqual({ type: 'term.focus', id: 'c1' });
    await flush();
    expect(calls).toContainEqual({ method: 'char.seen', params: { id: 'c1' } });
    store.getState().selectIsland('i_e');
    const p = manager.show('c0', rect);
    await p;
    expect(sent.at(-1)).toEqual({ type: 'term.hide', id: 'c0' });
  });

  it('follows a click into a surface', () => {
    const { store, bridge } = fakes();
    bridge.emit({ type: 'term.focused', id: 'c1' });
    expect(store.getState().focusedId).toBe('c1');
  });

  it('shows a second terminal under its own key, attached by term, and closes it when the fleet drops it', async () => {
    const { sent, calls, store, manager } = fakes();
    const second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    const f = fleet();
    f.characters.c0 = { ...f.characters.c0, second };
    store.getState().setFleet(f);
    store.getState().focus('c0');
    await manager.show(secondKey('c0'), rect, undefined, false);
    expect(calls).toContainEqual({ method: 'term.attach', params: { id: 'c0', term: 2 } });
    expect(sent).toContainEqual({ type: 'term.show', id: 'c0-2', rect, attach: { socket: '/tmp/s', session: 'v-c0-2' } });
    expect(sent.some((m) => m.type === 'term.hide')).toBe(false);
    store.getState().setFleet(fleet());
    expect(sent).toContainEqual({ type: 'term.close', id: 'c0-2' });
    expect(store.getState().terminals['c0-2']).toBeUndefined();
  });

  it('a focused second terminal focuses its character', async () => {
    const { bridge, store } = fakes();
    bridge.emit({ type: 'term.focused', id: 'c1-2' });
    expect(store.getState().focusedId).toBe('c1');
  });
});
