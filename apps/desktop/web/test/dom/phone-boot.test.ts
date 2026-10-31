// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOGIN_REFUSED, PROTOCOL_VERSION, UNPAIRED, type MachineId } from '@svall/protocol';
import type { Api } from '../../src/api.js';
import type { PhoneContext } from '../../src/mobile/boot.js';
import { fleet } from '../fixtures.js';

class Socket {
  static all: Socket[] = [];
  onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onclose?: (ev: { code: number }) => void;
  sent: { id: number; method: string }[] = [];
  closed = false;
  constructor(public url: string, public protocols?: string[]) { Socket.all.push(this); }
  send(json: string): void { this.sent.push(JSON.parse(json) as { id: number; method: string }); }
  close(): void { this.closed = true; this.onclose?.({ code: 1000 }); }
  receive(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  hello(protocol = PROTOCOL_VERSION): void { this.receive({ id: 0, result: { ok: true, protocol } }); }
  answer(method: string, result: unknown): void { this.receive({ id: this.sent.filter((m) => m.method === method).at(-1)!.id, result }); }
}

const reload = vi.fn();
const apis: (() => Api)[] = [];
// each boot is a fresh page load, as the phone does after a reload
const start = async (): Promise<PhoneContext> => {
  vi.resetModules();
  const ctx = (await import('../../src/mobile/boot.js')).initPhone();
  apis.push(ctx.api);
  return ctx;
};
const boot = async () => { await start(); return Socket.all.at(-1)!; };
const settled = () => new Promise((r) => setTimeout(r));
const backInView = () => document.dispatchEvent(new Event('visibilitychange'));

beforeEach(() => {
  Socket.all = [];
  reload.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'fleet.ts.net', pathname: '/', hash: '', reload });
});
// a page from an earlier test would answer this one's events too
afterEach(() => {
  for (const api of apis.splice(0)) api().stop();
  document.documentElement.removeAttribute('data-kept');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a phone left on an older page loads the new one once, and again after a later upgrade', async () => {
  (await boot()).hello(PROTOCOL_VERSION + 1);
  await settled();
  expect(reload).toHaveBeenCalledTimes(1);

  // the page that came back still does not match: it stays put rather than reloading forever
  (await boot()).hello(PROTOCOL_VERSION + 1);
  await settled();
  expect(reload).toHaveBeenCalledTimes(1);

  (await boot()).hello();
  (await boot()).hello(PROTOCOL_VERSION + 1);
  await settled();
  expect(reload).toHaveBeenCalledTimes(2);
});

test('a page that no longer matches drops the copy the service worker kept before it reloads', async () => {
  const kept = new Set(['svall-v1', 'svall-v2']);
  vi.stubGlobal('caches', { keys: () => Promise.resolve([...kept]), delete: (k: string) => Promise.resolve(kept.delete(k)) });
  reload.mockImplementation(() => expect([...kept]).toEqual([]));
  (await boot()).hello(PROTOCOL_VERSION + 1);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  reload.mockReset();
});

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const HOME = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId;
const FALLBACKS = { home: HOME, fallbacks: [{ machine: VAULT, name: 'linus-vault', url: 'https://linus-vault.tail.ts.net:8443/', pass: 'p4ss' }] };
const isWorker = (s: Socket) => s.url.startsWith('wss://linus-vault');

test('each time the Mac answers, the page keeps the workers it names for a launch while it does not', async () => {
  const socket = await boot();
  socket.hello();
  socket.answer('mobile.fallbacks', FALLBACKS);
  await settled();
  expect(JSON.parse(localStorage.getItem('svall.fallbacks')!)).toEqual(FALLBACKS);
});

test('a Mac that does not answer hands the fleet to a worker it named, which hands it back once the Mac answers', async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  const { store, api, onTermEvent } = await start();
  const frames: string[] = [];
  onTermEvent((e) => frames.push(e.data.id));
  expect(Socket.all.filter(isWorker)).toEqual([]);

  // a Mac that is off never answers, and the socket to it is given up on
  await vi.advanceTimersByTimeAsync(4000);
  const worker = Socket.all.find(isWorker)!;
  expect([worker.url, worker.protocols]).toEqual(['wss://linus-vault.tail.ts.net:8443', ['svall', 'svall.pass.p4ss']]);
  worker.hello();
  const there = fleet();
  there.robots.c0.name = 'on the worker';
  worker.answer('state.get', there);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().via).toEqual({ machine: VAULT, home: HOME });
  expect(store.getState().status).toBe('online');
  expect(store.getState().fleet.robots.c0.name).toBe('on the worker');
  worker.receive({ event: 'term.output', data: { id: 'c0', data: 'eA==' } });
  expect(frames).toEqual(['c0']);

  // the Mac's own reconnect finds it back, and it wins
  const mac = Socket.all.filter((s) => !isWorker(s)).at(-1)!;
  mac.hello();
  expect(worker.closed).toBe(true);
  expect(store.getState().via).toBeUndefined();
  mac.answer('state.get', fleet());
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().fleet.robots.c0.name).toBe('c0');
  expect(api().heard).toBeGreaterThan(0);
  expect(mac.sent.map((m) => m.method)).toContain('mobile.fallbacks');
});

test('a page the service worker opened from its copy turns to a worker at once, and the Mac still wins once it answers', async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  document.documentElement.setAttribute('data-kept', '');
  // a Home Screen app opens on its pass, whose pairing a Mac that is off never answers
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  vi.stubGlobal('location', { protocol: 'https:', host: 'fleet.ts.net', pathname: '/', hash: '#p4ss', reload });
  const { store } = await start();
  const worker = Socket.all.find(isWorker)!;
  expect(worker).toBeDefined();
  expect(Socket.all.filter((s) => !isWorker(s))).toHaveLength(1);
  worker.hello();
  expect(store.getState().via).toEqual({ machine: VAULT, home: HOME });
  Socket.all.filter((s) => !isWorker(s)).at(-1)!.hello();
  expect(worker.closed).toBe(true);
  expect(store.getState().via).toBeUndefined();
});

test('a worker that refuses the phone is passed over, and its refusal never asks to pair again', async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  const { store } = await start();
  await vi.advanceTimersByTimeAsync(4000);
  for (const code of [UNPAIRED, LOGIN_REFUSED, 4401]) {
    const worker = Socket.all.filter(isWorker).at(-1)!;
    worker.onclose!({ code });
    expect(store.getState().status).not.toMatch(/unpaired|refused/);
    expect(store.getState().via).toBeUndefined();
    // the next try, before it too gives up on a greeting
    await vi.advanceTimersByTimeAsync(2500);
  }
});

test('a Mac that names no worker any more leaves none to fall back to', async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  const socket = await boot();
  socket.hello();
  socket.answer('mobile.fallbacks', { home: HOME, fallbacks: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(localStorage.getItem('svall.fallbacks')).not.toContain('p4ss');
  socket.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(Socket.all.filter(isWorker)).toEqual([]);
});

test("a fleet that arrives from a worker after the Mac is back is not the page's", async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  const { store } = await start();
  await vi.advanceTimersByTimeAsync(4000);
  const worker = Socket.all.find(isWorker)!;
  worker.hello();
  // a browser reports the close of a socket let go some time after
  worker.close = () => {};
  const mac = Socket.all.filter((s) => !isWorker(s)).at(-1)!;
  mac.hello();
  mac.answer('state.get', fleet());
  const late = fleet();
  late.robots.c0.name = 'stale';
  worker.answer('state.get', late);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().fleet.robots.c0.name).toBe('c0');
});

test('a worker on another protocol is passed over, and never reloads the page', async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  const { store } = await start();
  await vi.advanceTimersByTimeAsync(4000);
  Socket.all.find(isWorker)!.hello(PROTOCOL_VERSION + 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).not.toHaveBeenCalled();
  expect(store.getState().via).toBeUndefined();
  expect(store.getState().status).not.toBe('online');
});

test('a phone with no worker kept goes on waiting for the Mac alone', async () => {
  vi.useFakeTimers();
  await start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(Socket.all.filter(isWorker)).toEqual([]);
  expect(Socket.all.length).toBeGreaterThan(1);
});

test('a worker in use that hears nothing once the page is back in view is dropped for a fresh socket', async () => {
  vi.useFakeTimers();
  localStorage.setItem('svall.fallbacks', JSON.stringify(FALLBACKS));
  await start();
  await vi.advanceTimersByTimeAsync(4000);
  const worker = Socket.all.find(isWorker)!;
  worker.hello();
  worker.close = () => {};
  backInView();
  // the probe asks the worker nothing of the Mac's push
  expect(worker.sent.at(-1)?.method).toBe('mobile.fallbacks');
  await vi.advanceTimersByTimeAsync(6000);
  expect(Socket.all.filter(isWorker)).toHaveLength(2);
});

test('a pairing the Mac never answers holds the socket back no longer than 2.5 s', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  vi.stubGlobal('location', { protocol: 'https:', host: 'fleet.ts.net', pathname: '/', hash: '#p4ss', reload });
  await start();
  await vi.advanceTimersByTimeAsync(2499);
  expect(Socket.all).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(Socket.all).toHaveLength(1);
});

// the link from the QR code carries the pass in its fragment: the page pairs by it before anything else
test('a page opened with a pass posts it, then asks for the manifest with its cookie, then opens the socket', async () => {
  let paired = () => {};
  const posts: [string, RequestInit][] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => { posts.push([url, init]); return new Promise<Response>((r) => { paired = () => r(new Response(null, { status: 204 })); }); });
  vi.stubGlobal('location', { protocol: 'https:', host: 'fleet.ts.net', pathname: '/', hash: '#p4ss', reload });
  document.head.replaceChildren();
  await start();
  expect(posts).toEqual([['/pair', { method: 'POST', body: 'p4ss' }]]);
  expect(document.head.querySelector('link[rel=manifest]')).toBeNull();
  expect(Socket.all).toHaveLength(0);
  paired();
  await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
  const link = document.head.querySelector('link[rel=manifest]')!;
  expect([link.getAttribute('href'), link.getAttribute('crossorigin')]).toEqual(['/manifest.webmanifest', 'use-credentials']);
});

test('a patch that does not apply fetches the whole fleet again', async () => {
  const socket = await boot();
  socket.hello();
  const first = socket.sent.find((m) => m.method === 'state.get')!;
  socket.receive({ id: first.id, result: fleet() });
  await Promise.resolve();
  socket.receive({ event: 'state.patch', data: { ops: [{ op: 'replace', path: '/robots/nobody/name', value: 'x' }] } });
  expect(socket.sent.filter((m) => m.method === 'state.get')).toHaveLength(2);
});

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

test('a socket still bringing terminal output is kept while its answer queues behind it', async () => {
  vi.useFakeTimers();
  const socket = await boot();
  socket.hello();
  backInView();
  await vi.advanceTimersByTimeAsync(3000);
  socket.receive({ event: 'term.output', data: { id: 'c0', data: 'eA==' } });
  await vi.advanceTimersByTimeAsync(7000);
  expect(Socket.all).toHaveLength(1);
});

test('a page hidden again before the socket answers leaves the socket alone', async () => {
  vi.useFakeTimers();
  const socket = await boot();
  socket.hello();
  backInView();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(10_000);
  hidden.mockRestore();
  expect(Socket.all).toHaveLength(1);
});

test('a socket that closed on its own is left to the reconnect already on its way', async () => {
  vi.useFakeTimers();
  const socket = await boot();
  socket.hello();
  socket.close();
  apis.at(-1)!().restart();
  await vi.advanceTimersByTimeAsync(5000);
  expect(Socket.all).toHaveLength(2);
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
