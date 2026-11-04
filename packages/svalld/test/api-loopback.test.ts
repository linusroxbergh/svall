import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { emptyState } from '@svall/protocol';
import { startApi } from '../src/api/server.js';
import { silentLogger } from '../src/log.js';
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

  async function api(host: string) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const store = new Store(path.join(home, 'state.json'), emptyState(), silentLogger);
    const a = await startApi({
      host, port: 0, token: 'secret', pass: 'p4ss', store, fleet: {} as never, fleets: stubFleets, terminals: { closeAll() {}, viewerGone() {} } as never, workspace: { unwatchAll() {} } as never, usage: stubUsage, load: stubLoad, mobileControl: stubMobile, log: silentLogger,
      push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(), claude: { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') }, docs: paths.docs,
      systemInfo: stubSystemInfo, key: () => KEY, logins: () => ['me@example.com'], homeApi: { answer: () => Promise.resolve(ANSWER as never) },
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

  it('refuses a socket from another address, whatever node.json binds and with the right token', async () => {
    const address = lan();
    if (!address) return;
    const port = await api('0.0.0.0');
    const r = await ask(`ws://${address}:${port}`, { token: 'secret' });
    expect(r.error?.code).toBe('forbidden');
    expect(JSON.stringify(r)).not.toContain('the-far-token');
  });
});
