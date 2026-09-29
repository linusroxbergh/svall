// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
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
// each boot is a fresh page load, as the phone does after a reload
const boot = async () => { vi.resetModules(); (await import('../../src/mobile/boot.js')).initPhone(); return Socket.all.at(-1)!; };

beforeEach(() => {
  Socket.all = [];
  reload.mockClear();
  sessionStorage.clear();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'fleet.ts.net', pathname: '/', reload });
});
afterEach(() => { vi.unstubAllGlobals(); });

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
