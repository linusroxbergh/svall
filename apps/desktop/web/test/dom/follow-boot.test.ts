// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { fleet } from '../fixtures.js';

const ME = '11111111-1111-4111-8111-111111111111';
const HOME = '22222222-2222-4222-8222-222222222222';
const LOCAL = 47001;
const FAR = 50000;

class Socket {
  static all: Socket[] = [];
  onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onclose?: (ev: { code: number }) => void;
  sent: { method: string; params: { id?: string } }[] = [];
  constructor(public url: string) {
    Socket.all.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(json: string): void {
    const m = JSON.parse(json) as { id: number; method: string; token?: string; params: { id?: string } };
    if ('token' in m) { queueMicrotask(() => this.answer({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } })); return; }
    this.sent.push(m);
    const result = m.method === 'fleet.home' ? { machine: HOME, name: 'studio', mine: false, me: ME }
      : m.method === 'home.connection' ? { machine: HOME, name: 'studio', state: 'connected', ssh: 'ada@studio', controlSocket: '/tmp/m', port: FAR, token: 'far' }
        : m.method === 'state.get' ? fleet()
          : m.method === 'resources.get' ? { sources: [] }
            : {};
    queueMicrotask(() => this.answer({ id: m.id, result }));
  }
  answer(body: unknown): void { this.onmessage?.({ data: JSON.stringify(body) }); }
  close(): void { this.onclose?.({ code: 1000 }); }
  said(method: string) { return this.sent.filter((m) => m.method === method); }
}
const on = (port: number) => Socket.all.filter((s) => s.url === `ws://127.0.0.1:${port}`).at(-1)!;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.all = [];
  vi.stubGlobal('WebSocket', Socket);
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    if ((JSON.parse(json) as { type: string }).type !== 'connection') return;
    const reply = JSON.stringify({ type: 'connection', host: '127.0.0.1', port: LOCAL, token: 't' });
    setTimeout(() => window.__svall!.receive(reply), 0);
  } } } };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete window.webkit; });

test('a window that reaches its far home reads the listing from it, whose root ids are its own', async () => {
  const { initApp } = await import('../../src/boot.js');
  const { store } = initApp();
  await vi.advanceTimersByTimeAsync(50);
  expect(store.getState().via?.online).toBe(true);
  expect(on(FAR).said('resources.get')).not.toEqual([]);
  expect(on(FAR).said('state.get')).not.toEqual([]);
});

test('a reconnect of this machine\'s socket while the page follows its home sends this machine\'s watches again', async () => {
  const { initApp, app } = await import('../../src/boot.js');
  const { store } = initApp();
  await vi.advanceTimersByTimeAsync(50);
  const f = store.getState().fleet;
  store.getState().setFleet({ ...f, robots: { ...f.robots, c0: { ...f.robots.c0, machine: ME as never } } });
  app.repoWatch().watch('c0');
  const first = on(LOCAL);
  expect(first.said('repo.watch')).toHaveLength(1);
  first.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(on(LOCAL)).not.toBe(first);
  expect(on(LOCAL).said('repo.watch').map((m) => m.params)).toEqual([{ id: 'c0' }]);
  expect(store.getState().via?.online).toBe(true);
});
