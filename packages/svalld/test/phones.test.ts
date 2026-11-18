import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startApi } from '../src/api/server.js';
import { silentLogger } from '../src/log.js';
import { Phones } from '../src/phones.js';
import { PushStore } from '../src/push/store.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome, stubFleets, stubLoad, stubMobile, stubSystemInfo, stubUsage, waitFor } from './helpers.js';

afterEach(cleanHomes);

describe('Phones', () => {
  it('holds a socket until it leaves', () => {
    const phones = new Phones();
    expect(phones.list()).toEqual([]);
    const socket = phones.add('me@example.com');
    expect(phones.list()).toEqual([{ login: 'me@example.com', since: expect.any(Number) }]);
    socket.leave();
    expect(phones.list()).toEqual([]);
  });

  it('names a login once, from the moment its first socket arrived', () => {
    vi.useFakeTimers();
    try {
      const phones = new Phones();
      vi.setSystemTime(new Date('2026-09-19T14:02:00Z'));
      const first = phones.add('me@example.com');
      vi.setSystemTime(new Date('2026-09-19T14:30:00Z'));
      const second = phones.add('me@example.com');
      expect(phones.list()).toEqual([{ login: 'me@example.com', since: Date.parse('2026-09-19T14:02:00Z') }]);
      // the tab that arrived first is gone, and the login is still here on the one that stayed
      first.leave();
      expect(phones.list()).toEqual([{ login: 'me@example.com', since: Date.parse('2026-09-19T14:30:00Z') }]);
      second.leave();
      expect(phones.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the logins in the order they arrived', () => {
    const phones = new Phones();
    phones.add('second@example.com');
    phones.add('first@example.com');
    expect(phones.list().map((p) => p.login)).toEqual(['second@example.com', 'first@example.com']);
  });

  it('tells a watcher on every arrival and departure, until it stops watching', () => {
    const phones = new Phones();
    const seen: number[] = [];
    const stop = phones.onChange((list) => seen.push(list.length));
    phones.add('me@example.com').leave();
    stop();
    phones.add('me@example.com');
    expect(seen).toEqual([1, 0]);
  });

  it('knows a robot as viewed while a socket of that login names it, until it names another or leaves', () => {
    const phones = new Phones();
    const ipad = phones.add('me@example.com');
    const iphone = phones.add('me@example.com');
    ipad.view('c1');
    iphone.view('c2');
    expect([phones.viewing('me@example.com', 'c1'), phones.viewing('me@example.com', 'c2'), phones.viewing('other@example.com', 'c1')]).toEqual([true, true, false]);
    ipad.view(undefined);
    iphone.leave();
    expect([phones.viewing('me@example.com', 'c1'), phones.viewing('me@example.com', 'c2')]).toEqual([false, false]);
  });
});

it('takes the robot a phone socket names as viewed, and lets it go with the socket', async () => {
  const home = makeHome();
  const phones = new Phones();
  const key = 'k'.repeat(48);
  const api = await startApi({
    host: '127.0.0.1', port: 0, token: 'secret', pass: 'p4ss', store: Store.load(path.join(home, 'state.json'), () => {}), fleet: {} as never, fleets: stubFleets,
    terminals: { closeAll() {} } as never, workspace: { unwatchAll() {} } as never, usage: stubUsage, load: stubLoad, mobileControl: stubMobile, log: silentLogger,
    push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones, claude: { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') }, systemInfo: stubSystemInfo,
    key: () => key, logins: () => ['me@example.com'],
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'tailscale-user-login': 'me@example.com', cookie: 'svall-pass=p4ss' } });
    const answers: unknown[] = [];
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)) as { id?: number }; if (m.id === 1) answers.push(m); });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ id: 1, method: 'mobile.viewing', params: { robot: 'c1' } }));
    await waitFor(() => answers.length === 1);
    expect(answers).toEqual([{ id: 1, result: {} }]);
    expect(phones.viewing('me@example.com', 'c1')).toBe(true);
    ws.close();
    await waitFor(() => !phones.viewing('me@example.com', 'c1'));
  } finally {
    await api.close();
  }
});
