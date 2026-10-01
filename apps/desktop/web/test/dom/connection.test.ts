// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';

class Socket {
  static all: Socket[] = [];
  static dead = false;
  onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onclose?: () => void;
  constructor(public url: string) {
    Socket.all.push(this);
    // a daemon that went away: nothing listens on the port
    if (Socket.dead) setTimeout(() => this.onclose?.(), 0);
  }
  send(): void {}
  close(): void { this.onclose?.(); }
}

// the shell answers each ask with whatever the port file says now
let port = 0;
let asked = 0;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.all = [];
  Socket.dead = false;
  asked = 0;
  vi.stubGlobal('WebSocket', Socket);
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    if ((JSON.parse(json) as { type: string }).type !== 'connection') return;
    asked++;
    const reply = JSON.stringify({ type: 'connection', host: '127.0.0.1', port, token: 't' });
    setTimeout(() => window.__svall!.receive(reply), 0);
  } } } };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete window.webkit; });

test('a daemon that comes back on another port is found through the shell', async () => {
  port = 47001;
  const { initApp } = await import('../../src/boot.js');
  initApp();
  await vi.advanceTimersByTimeAsync(1);
  expect(Socket.all.map((s) => s.url)).toEqual(['ws://127.0.0.1:47001']);
  Socket.all[0].onmessage?.({ data: JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }) });

  // an `svall <name>` fleet restarts on a free port and writes the new one
  port = 47002;
  Socket.all[0].onclose?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.all.at(-1)?.url).toBe('ws://127.0.0.1:47002');
});

test('the daemon the shell starts with the window is found as soon as it writes its port', async () => {
  port = 0;
  const { initApp } = await import('../../src/boot.js');
  initApp();
  await vi.advanceTimersByTimeAsync(800);
  expect(Socket.all).toEqual([]);
  port = 47001;
  await vi.advanceTimersByTimeAsync(300);
  expect(Socket.all.map((s) => s.url)).toEqual(['ws://127.0.0.1:47001']);
});

test('while svalld stays down the shell is asked at a steady pace', async () => {
  port = 47001;
  Socket.dead = true;
  const { initApp } = await import('../../src/boot.js');
  initApp();
  await vi.advanceTimersByTimeAsync(1);
  // the daemon stopped and took its port file with it
  port = 0;
  const perMinute: number[] = [];
  for (let minute = 0; minute < 5; minute++) {
    const before = asked;
    await vi.advanceTimersByTimeAsync(60_000);
    perMinute.push(asked - before);
  }
  expect(perMinute[4]).toBeLessThanOrEqual(perMinute[0]);
  expect(perMinute[4]).toBeLessThanOrEqual(60);
});
