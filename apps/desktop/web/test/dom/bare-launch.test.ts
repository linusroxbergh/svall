// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';

class Socket {
  static all: Socket[] = [];
  sent: { id?: number; method?: string }[] = [];
  onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onclose?: (ev: { code: number }) => void;
  constructor(public url: string) { Socket.all.push(this); }
  send(json: string): void { this.sent.push(JSON.parse(json) as { id?: number; method?: string }); }
  close(): void { this.onclose?.({ code: 1000 }); }
  reply(msg: object): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  hello(): void { this.reply({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }); }
  asked(method: string): number { return this.sent.find((m) => m.method === method)!.id!; }
}

const FLEET = { home: '/u/.svall', name: 'private', current: true, running: true, windowOpen: true };

// the shell answers each ask for the connection with this port, 0 while svalld has none
let port = 0;
const fromShell = (msg: object) => window.__svall!.receive(JSON.stringify(msg));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  Socket.all = [];
  vi.stubGlobal('WebSocket', Socket);
  window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
    if ((JSON.parse(json) as { type: string }).type !== 'connection') return;
    setTimeout(() => fromShell({ type: 'connection', host: '127.0.0.1', port, token: 't' }), 0);
  } } } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.webkit; delete window.__svallBare; });

test('a bare launch offers the fleets once there are two, and asks again after a list that went unanswered', async () => {
  port = 47001;
  window.__svallBare = true;
  const { initApp } = await import('../../src/boot.js');
  const { store } = initApp();
  await vi.advanceTimersByTimeAsync(1);
  Socket.all[0].hello();
  Socket.all[0].asked('fleets.list');
  Socket.all[0].close();
  await vi.advanceTimersByTimeAsync(1);
  expect(store.getState().fleetPicker).toBeUndefined();

  await vi.advanceTimersByTimeAsync(1000);
  const next = Socket.all.at(-1)!;
  next.hello();
  next.reply({ id: next.asked('fleets.list'), result: { fleets: [FLEET, { ...FLEET, home: '/u/.svall-work', name: 'work', current: false }] } });
  await vi.advanceTimersByTimeAsync(1);
  expect(store.getState().fleetPicker).toBe('bare');

  // once offered, a reconnect does not offer again
  store.getState().setFleetPicker(undefined);
  next.close();
  await vi.advanceTimersByTimeAsync(1000);
  Socket.all.at(-1)!.hello();
  expect(Socket.all.at(-1)!.sent.some((m) => m.method === 'fleets.list')).toBe(false);
});

test('a bare launch refused the list, as off the Mac, never asks again, so the fleet coming home offers nothing', async () => {
  port = 47001;
  window.__svallBare = true;
  const { initApp } = await import('../../src/boot.js');
  const { store } = initApp();
  await vi.advanceTimersByTimeAsync(1);
  Socket.all[0].hello();
  Socket.all[0].reply({ id: Socket.all[0].asked('fleets.list'), error: { code: 'forbidden', message: 'fleets.list answers only on a Mac' } });
  await vi.advanceTimersByTimeAsync(1);
  Socket.all[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  Socket.all.at(-1)!.hello();
  expect(Socket.all.at(-1)!.sent.some((m) => m.method === 'fleets.list')).toBe(false);
  expect(store.getState().fleetPicker).toBeUndefined();
});

test('a bare launch with one fleet offers nothing, and a launch that named one never asks', async () => {
  port = 47001;
  window.__svallBare = true;
  const bare = await import('../../src/boot.js');
  const { store } = bare.initApp();
  await vi.advanceTimersByTimeAsync(1);
  Socket.all[0].hello();
  Socket.all[0].reply({ id: Socket.all[0].asked('fleets.list'), result: { fleets: [FLEET] } });
  await vi.advanceTimersByTimeAsync(1);
  expect(store.getState().fleetPicker).toBeUndefined();

  vi.resetModules();
  delete window.__svallBare;
  const named = await import('../../src/boot.js');
  named.initApp();
  await vi.advanceTimersByTimeAsync(1);
  Socket.all.at(-1)!.hello();
  expect(Socket.all.at(-1)!.sent.some((m) => m.method === 'fleets.list')).toBe(false);
});

test('Open Fleet… opens the picker before svalld ever answers, and a fleet the shell could not open closes it and says why', async () => {
  port = 0;
  const { initApp } = await import('../../src/boot.js');
  const { store } = initApp();
  await vi.advanceTimersByTimeAsync(1);
  store.getState().setMissionPrompt(true);
  fromShell({ type: 'fleets' });
  expect(store.getState()).toMatchObject({ fleetPicker: 'menu', missionPrompt: false });
  fromShell({ type: 'openFleet.failed', home: '/u/.svall-work', reason: 'The application could not be found.' });
  expect(store.getState().toast?.text).toBe('Could not open /u/.svall-work: The application could not be found.');
  expect(store.getState().fleetPicker).toBeUndefined();
});
