import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startApi } from '../src/api/server.js';
import { silentLogger } from '../src/log.js';
import { homeWord, machineWord } from '../src/machine.js';
import type { Mobile } from '../src/mobile.js';
import { resolvePaths } from '../src/paths.js';
import { Phones } from '../src/phones.js';
import { PushStore } from '../src/push/store.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome, stubFleets, stubLoad, stubMobile, stubSystemInfo, stubUsage } from './helpers.js';

const KEY = 'k'.repeat(48);
const ANSWER = { machine: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'studio', state: 'connected', port: 1, token: 'the-far-token' };
const lan = () => Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

/** Says `headers` and the token in a hello, then asks home.connection, and answers what came back. */
function ask(url: string, o: { token?: string; headers?: Record<string, string> } = {}): Promise<{ error?: { code: string }; result?: { token?: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: o.headers });
    const send = () => ws.send(JSON.stringify({ id: 1, method: 'home.connection', params: {} }));
    ws.on('open', () => { if (o.token) ws.send(JSON.stringify({ token: o.token })); });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; event?: string; error?: { code: string }; result?: { token?: string } };
      if (m.id === 0) send();
      if (m.id === 1) { ws.close(); resolve(m); }
    });
    ws.on('error', reject);
  });
}

describe('home.connection over a real socket', () => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closes.splice(0)) await c(); cleanHomes(); });

  async function api(host: string, freeze?: object, mobile: Mobile = stubMobile) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const store = Store.load(path.join(home, 'state.json'), () => {});
    const a = await startApi({
      host, port: 0, token: 'secret', pass: 'p4ss', store, fleet: {} as never, fleets: stubFleets, terminals: { closeAll() {}, viewerGone() {} } as never, workspace: { unwatchAll() {} } as never, usage: stubUsage, load: stubLoad, mobileControl: mobile, log: silentLogger,
      push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(), claude: { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') }, docs: paths.docs,
      systemInfo: stubSystemInfo, key: () => KEY, logins: () => ['me@example.com'], homeApi: { answer: () => Promise.resolve(ANSWER as never) }, ...(freeze && { freeze: freeze as never }),
    });
    closes.push(() => a.close());
    return a.port;
  }

  it('hands the far token to a socket from loopback that said the fleet\'s token', async () => {
    const port = await api('127.0.0.1');
    expect((await ask(`ws://127.0.0.1:${port}`, { token: 'secret' })).result?.token).toBe('the-far-token');
  });

  it('refuses a socket the phone proxy brought, which arrives from loopback too', async () => {
    const port = await api('127.0.0.1');
    const r = await ask(`ws://127.0.0.1:${port}/${KEY}/`, { headers: { 'tailscale-user-login': 'me@example.com', cookie: 'svall-pass=p4ss' } });
    expect(r.error?.code).toBe('forbidden');
    expect(JSON.stringify(r)).not.toContain('the-far-token');
  });

  it('a socket that closes ends the freeze its own call opened, as a driver that died can say nothing', async () => {
    const opened: object[] = [];
    const left: object[] = [];
    const freeze = { refusal: () => undefined, admit: () => undefined, open: (_id: string, viewer: object) => { opened.push(viewer); }, status: () => ({}), left: (viewer: object) => { left.push(viewer); } };
    const port = await api('127.0.0.1', freeze);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ token: 'secret' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { id?: number };
        if (m.id === 0) ws.send(JSON.stringify({ id: 1, method: 'fleet.homeMove', params: { op: 'open', id: 'hm_abcdefghij' } }));
        if (m.id === 1) resolve();
      });
      ws.on('error', reject);
    });
    expect(opened).toHaveLength(1);
    expect(left).toEqual([]);
    ws.close();
    await vi.waitFor(() => expect(left).toHaveLength(1));
    expect(left[0]).toBe(opened[0]);
  });

  it('words a socket\'s answers in the names its hello gave: the home as its window calls it, the window\'s machine as this Mac', async () => {
    const mac = '11111111-1111-4111-8111-111111111111';
    const port = await api('127.0.0.1', undefined, { ...stubMobile, get: async () => ({ ...await stubMobile.get(), error: `${homeWord()} · ${machineWord(mac, 'linuss-macbook-pro')}` }) });
    const said = (hello: object) => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('open', () => ws.send(JSON.stringify({ token: 'secret', ...hello })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { id?: number; result?: { error: string } };
        if (m.id === 0) ws.send(JSON.stringify({ id: 1, method: 'mobile.get', params: {} }));
        if (m.id === 1) { ws.close(); resolve(m.result!.error); }
      });
      ws.on('error', reject);
    });
    expect(await said({ home: 'studio', me: mac })).toBe('studio · this Mac');
    expect(await said({})).toBe(`${homeWord()} · linuss-macbook-pro`);
  });

  it('refuses a socket from another address, whatever node.json binds and with the right token', async () => {
    const address = lan();
    if (!address) return;
    const port = await api('0.0.0.0');
    const r = await ask(`ws://${address}:${port}`, { token: 'secret' });
    expect(r.error?.code).toBe('forbidden');
    expect(JSON.stringify(r)).not.toContain('the-far-token');
  });
});
