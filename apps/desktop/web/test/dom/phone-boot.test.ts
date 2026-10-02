// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import type { Api } from '../../src/api.js';
import { fleet } from '../fixtures.js';

class Socket {
  static all: Socket[] = [];
  onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onclose?: () => void;
  sent: { id: number; method: string }[] = [];
  constructor(public url: string) { Socket.all.push(this); }
  send(json: string): void { this.sent.push(JSON.parse(json) as { id: number; method: string }); }
  close(): void { this.onclose?.(); }
  receive(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  hello(protocol = PROTOCOL_VERSION): void { this.receive({ id: 0, result: { ok: true, protocol } }); }
}

const reload = vi.fn();
const apis: Api[] = [];
// each boot is a fresh page load, as the phone does after a reload
const boot = async () => { vi.resetModules(); apis.push((await import('../../src/mobile/boot.js')).initPhone().api()); return Socket.all.at(-1)!; };

beforeEach(() => {
  Socket.all = [];
  reload.mockClear();
  sessionStorage.clear();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'fleet.ts.net', pathname: '/', reload });
});
// a page from an earlier test would answer this one's events too
afterEach(() => { for (const api of apis.splice(0)) api.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('a phone left on an older page loads the new one once, and again after a later upgrade', async () => {
  (await boot()).hello(PROTOCOL_VERSION + 1);
  expect(reload).toHaveBeenCalledTimes(1);

  // the page that came back still does not match: it stays put rather than reloading forever
  (await boot()).hello(PROTOCOL_VERSION + 1);
  expect(reload).toHaveBeenCalledTimes(1);

  (await boot()).hello();
  (await boot()).hello(PROTOCOL_VERSION + 1);
  expect(reload).toHaveBeenCalledTimes(2);
});

test('a patch that does not apply fetches the whole fleet again', async () => {
  const socket = await boot();
  socket.hello();
  const first = socket.sent.find((m) => m.method === 'state.get')!;
  socket.receive({ id: first.id, result: fleet() });
  await Promise.resolve();
  socket.receive({ event: 'state.patch', data: { ops: [{ op: 'replace', path: '/characters/nobody/name', value: 'x' }] } });
  expect(socket.sent.filter((m) => m.method === 'state.get')).toHaveLength(2);
});

const backInView = () => document.dispatchEvent(new Event('visibilitychange'));

test('a socket that does not answer once the page is back in view is dropped for a fresh one', async () => {
  vi.useFakeTimers();
  const socket = await boot();
  socket.hello();
  // a socket lost to a network change never reports its own close
  socket.close = () => {};
  backInView();
  expect(socket.sent.at(-1)?.method).toBe('push.key');
  await vi.advanceTimersByTimeAsync(4999);
  expect(Socket.all).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.all).toHaveLength(2);
});

test('a socket that answers once the page is back in view is kept', async () => {
  vi.useFakeTimers();
  const socket = await boot();
  socket.hello();
  backInView();
  socket.receive({ id: socket.sent.at(-1)!.id, result: { publicKey: 'k' } });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(Socket.all).toHaveLength(1);
});

test('the page takes its height from the part of the screen the keyboard leaves', async () => {
  const vv = Object.assign(new EventTarget(), { height: 800, scale: 1 });
  vi.stubGlobal('visualViewport', vv);
  await boot();
  const vvh = () => document.documentElement.style.getPropertyValue('--vvh');
  expect(vvh()).toBe('800px');
  vv.height = 480;
  vv.dispatchEvent(new Event('resize'));
  expect(vvh()).toBe('480px');
  // pinched in, the visible part is smaller but the page is not
  Object.assign(vv, { height: 400, scale: 2 });
  vv.dispatchEvent(new Event('resize'));
  expect(vvh()).toBe('800px');
});
