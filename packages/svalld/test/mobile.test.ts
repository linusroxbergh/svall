import fs from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Event, type PhoneSession } from '@svall/protocol';
import { cookieOf, identityOf, originAllowed, startApi, stripKey } from '../src/api/server.js';
import { brand, resolveFile, serveBundle } from '../src/api/static.js';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import type { Mobile } from '../src/mobile.js';
import { silentLogger, type Logger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { PushStore } from '../src/push/store.js';
import { Phones } from '../src/phones.js';
import { Store } from '../src/store.js';
import { TerminalHub } from '../src/terminals.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { Workspace } from '../src/workspace/workspace.js';
import { cleanHomes, hasTmux, makeHome, stubFleets, stubLoad, stubMobile, stubSystemInfo, stubUsage, waitFor, waitForPolls } from './helpers.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe('origins', () => {
  it('admits the app, the page svalld served, and a configured origin', () => {
    expect(originAllowed(req({}))).toBe(true);
    expect(originAllowed(req({ origin: 'svall://app' }))).toBe(true);
    expect(originAllowed(req({ origin: 'https://mac.tail.ts.net', host: 'mac.tail.ts.net' }), [], true)).toBe(true);
    expect(originAllowed(req({ origin: 'https://evil.example', host: 'mac.tail.ts.net' }), [], true)).toBe(false);
    expect(originAllowed(req({ origin: 'https://evil.example', host: 'mac.tail.ts.net' }), ['https://evil.example'])).toBe(true);
  });

  // a page whose own name was made to resolve to 127.0.0.1 sends its name as both origin and host
  it('admits the Vite dev server from a checkout, and never from the app', async () => {
    const as = async (v: string) => { vi.resetModules(); vi.stubEnv('SVALL_VARIANT', v); return (await import('../src/api/server.js')).originAllowed; };
    const vite = req({ origin: 'http://localhost:5173', host: '127.0.0.1:47800' });
    try {
      expect((await as('release'))(vite)).toBe(false);
      expect((await as('dev'))(vite)).toBe(true);
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });

  it('admits a page on its own host only on loopback, or on the name the proxy answered on', () => {
    for (const host of ['127.0.0.1:47800', 'localhost:47800', '[::1]:47800'])
      expect(originAllowed(req({ origin: `http://${host}`, host }))).toBe(true);
    expect(originAllowed(req({ origin: 'http://rebind.example:47800', host: 'rebind.example:47800' }))).toBe(false);
    expect(originAllowed(req({ origin: 'https://mac.tail.ts.net', host: 'mac.tail.ts.net' }))).toBe(false);
  });
});

describe('identity', () => {
  it('takes the proxy header, and only a login the fleet names', () => {
    expect(identityOf(req({}), ['me@example.com'])).toBeUndefined();
    expect(identityOf(req({ 'tailscale-user-login': 'me@example.com' }), ['me@example.com'])).toBe('me@example.com');
    expect(identityOf(req({ 'tailscale-user-login': 'them@example.com' }), ['me@example.com'])).toBeUndefined();
  });

  it('takes no one while the fleet names no login', () => {
    expect(identityOf(req({ 'tailscale-user-login': 'me@example.com' }))).toBeUndefined();
    expect(identityOf(req({ 'tailscale-user-login': 'me@example.com' }), [])).toBeUndefined();
  });
});

describe('phone pass', () => {
  it('reads one cookie among the others, as sent', () => {
    expect(cookieOf(req({ cookie: 'a=1; svall-pass=abc=; b' }), 'svall-pass')).toBe('abc=');
    expect(cookieOf(req({ cookie: 'svall-pass=abc' }), 'svall-pass')).toBe('abc');
    expect(cookieOf(req({ cookie: 'svall-passx=abc; a=1' }), 'svall-pass')).toBeUndefined();
    expect(cookieOf(req({}), 'svall-pass')).toBeUndefined();
  });
});

describe('phone key', () => {
  const key = 'a'.repeat(48);
  it('strips the key the proxy prepends, and nothing else', () => {
    expect(stripKey(`/${key}/`, key)).toBe('/');
    expect(stripKey(`/${key}`, key)).toBe('/');
    expect(stripKey(`/${key}/assets/app.js?v=1`, key)).toBe('/assets/app.js?v=1');
    expect(stripKey('/', key)).toBeUndefined();
    expect(stripKey(`/${'b'.repeat(48)}/`, key)).toBeUndefined();
    expect(stripKey(`/${key}x/`, key)).toBeUndefined();
    expect(stripKey(`/x/${key}/`, key)).toBeUndefined();
  });
});

describe('bundle paths', () => {
  const dir = makeHome();
  fs.writeFileSync(path.join(dir, 'index.html'), 'page');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'code');
  afterEach(() => cleanHomes());

  it('serves a file, falls back to the page, and never escapes the bundle', () => {
    expect(resolveFile(dir, '/assets/app.js')).toBe(path.join(dir, 'assets', 'app.js'));
    expect(resolveFile(dir, '/')).toBe(path.join(dir, 'index.html'));
    expect(resolveFile(dir, '/robot/abc')).toBe(path.join(dir, 'index.html'));
    expect(resolveFile(dir, '/../../etc/passwd')).toBe(path.join(dir, 'index.html'));
    expect(resolveFile('/nowhere', '/')).toBeUndefined();
  });

  it('says the page is not built only when it is not', async () => {
    const built = makeHome(), empty = makeHome();
    fs.writeFileSync(path.join(built, 'index.html'), 'page');
    const server = http.createServer((req, res) => serveBundle(req, res, req.url === '/empty/' ? empty : built));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const undecodable = await fetch(`${at}/%E0%A4%A`);
      expect(undecodable.status).toBe(404);
      expect(await undecodable.text()).toBe('Not found');
      expect(await (await fetch(`${at}/empty/`)).text()).toMatch(/not built/);
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('answers 400 to a request target that is no URL', async () => {
    const server = http.createServer((req, res) => serveBundle(req, res, dir));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const socket = net.connect((server.address() as { port: number }).port, '127.0.0.1');
      socket.end('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      let said = '';
      for await (const chunk of socket) said += String(chunk);
      expect(said).toMatch(/^HTTP\/1\.1 400 /);
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('names the fleet in the page title and the manifest, and leaves everything else alone', () => {
    expect(brand('/d/index.html', '<title>Svall</title><p>Svall</p>', 'work')).toBe('<title>Svall work</title><p>Svall</p>');
    expect(brand('/d/index.html', '<title>Svall</title>', undefined, '/#p')).toBe('<title>Svall</title>');
    const manifest = JSON.parse(brand('/d/manifest.webmanifest', '{"name":"Svall","short_name":"Svall","id":"/"}', 'work'));
    expect(manifest).toEqual({ name: 'Svall work', short_name: 'svall work', id: '/' });
    expect(JSON.parse(brand('/d/manifest.webmanifest', '{"name":"Svall","id":"/","start_url":"/"}', undefined, '/#p'))).toEqual({ name: 'Svall', id: '/', start_url: '/#p' });
  });
});

const runIf = hasTmux() ? describe : describe.skip;

runIf('phone sockets', () => {
  const key = 'c0ffee'.repeat(8);
  const pass = 'pa55'.repeat(12);
  const PAIRED = { cookie: `svall-pass=${pass}` };
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot(fleetName?: () => string | undefined, mobileControl: Mobile = stubMobile, log: Logger = silentLogger) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const dist = path.join(home, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Svall</title>phone');
    fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"Svall","short_name":"Svall"}');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'code');
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 200 });
    const started = fleet.start();
    cleanup.push(async () => { await started.catch(() => {}); await fleet.stop(); await tmux.killServer(); });
    await started;
    const terminals = new TerminalHub(fleet, tmux, store, silentLogger);
    const workspace = new Workspace((id) => { const c = store.state.robots[id]; if (!c) throw new Error(id); return c.repo?.root ?? c.cwd; }, silentLogger);
    const current = { key, logins: ['me@example.com'], origins: [] as string[] };
    const api = await startApi({
      host: '127.0.0.1', port: 0, token: 'secret', store, fleet, fleets: stubFleets, terminals, workspace, usage: stubUsage, load: stubLoad, mobileControl, log,
      origins: () => current.origins, logins: () => current.logins, dist, key: () => current.key, pass, fleetName,
      push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(), systemInfo: stubSystemInfo,
      claude: { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') },
    });
    cleanup.unshift(async () => { await api.close(); });
    return { ...api, dist, fleet, store, current };
  }

  const hello = (ws: WebSocket) => new Promise<{ protocol?: number }>((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()).result));
    ws.once('close', (code) => reject(new Error(`closed ${code}`)));
  });

  it('serves a named fleet under its own name, and the private fleet as built', async () => {
    const work = await boot(() => 'work');
    expect(await (await fetch(`http://127.0.0.1:${work.port}/${key}/`)).text()).toContain('<title>Svall work</title>');
    const manifest = await (await fetch(`http://127.0.0.1:${work.port}/${key}/manifest.webmanifest`)).json() as { name: string };
    expect(manifest.name).toBe('Svall work');
    const plain = await boot();
    expect(await (await fetch(`http://127.0.0.1:${plain.port}/${key}/`)).text()).toContain('<title>Svall</title>');
  });

  it('brands the page with the fleet\'s name as it stands, so a rename shows on the next load', async () => {
    let name = 'work';
    const fleet = await boot(() => name);
    name = 'office';
    expect(await (await fetch(`http://127.0.0.1:${fleet.port}/${key}/`)).text()).toContain('<title>Svall office</title>');
  });

  it('serves a manifest as built when it cannot be branded', async () => {
    const work = await boot(() => 'work');
    fs.writeFileSync(path.join(work.dist, 'manifest.webmanifest'), 'not json');
    const res = await fetch(`http://127.0.0.1:${work.port}/${key}/manifest.webmanifest`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('not json');
  });

  it('serves the phone page on the port, with and without the key in front', async () => {
    const api = await boot();
    for (const path of ['/anything', `/${key}/anything`, `/${key}`]) {
      const res = await fetch(`http://127.0.0.1:${api.port}${path}`);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self';");
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(await res.text()).toContain('phone');
    }
    const asset = await fetch(`http://127.0.0.1:${api.port}/${key}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('code');
  });

  it('admits a trusted login behind the key with no token, and refuses a stranger there at once, with its own code, naming it once', async () => {
    const errors: string[] = [];
    const api = await boot(undefined, stubMobile, { info() {}, error: (m) => errors.push(m) });
    const open = (login: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': login, ...PAIRED } });
      cleanup.push(async () => ws.close());
      return ws;
    };
    expect((await hello(open('me@example.com'))).protocol).toBe(PROTOCOL_VERSION);
    const started = Date.now();
    await expect(hello(open('them@example.com'))).rejects.toThrow(/closed 4403/);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(hello(open('them@example.com'))).rejects.toThrow(/closed 4403/);
    expect(errors).toEqual(['api: refused a phone socket from tailnet login them@example.com']);
  });

  // the key is in the serve command's arguments, which other users on the Mac read: a login header behind it proves nothing alone
  it('tells a phone behind the key without the pass to pair, with its own code, and takes one with the pass', async () => {
    const api = await boot();
    const open = (cookie?: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...(cookie ? { cookie } : {}) } });
      cleanup.push(async () => ws.close());
      return ws;
    };
    await expect(hello(open())).rejects.toThrow(/closed 4402/);
    await expect(hello(open('svall-pass=not-the-pass'))).rejects.toThrow(/closed 4402/);
    await expect(hello(open(`svall-pass=${pass.slice(1)}`))).rejects.toThrow(/closed 4402/);
    expect((await hello(open(`other=1; svall-pass=${pass}`))).protocol).toBe(PROTOCOL_VERSION);
    const call = { id: 1, method: 'robot.answer', params: { id: 'c_none', answer: 'approve' } };
    const post = (cookie?: string) => fetch(`http://127.0.0.1:${api.port}/${key}/rpc`, { method: 'POST', body: JSON.stringify(call), headers: { 'Tailscale-User-Login': 'me@example.com', ...(cookie ? { cookie } : {}) } });
    expect((await post()).status).toBe(401);
    expect((await post(`svall-pass=${pass}`)).status).toBe(200);
  });

  // the home's page reaching a worker holds no cookie there
  it('takes the pass as a subprotocol from a page on an origin the fleet accepts, and names only svall back', async () => {
    const api = await boot();
    api.current.origins = ['https://mac.tail.ts.net'];
    const open = (protocols: string[], origin = 'https://mac.tail.ts.net') => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, protocols, { headers: { 'Tailscale-User-Login': 'me@example.com', origin } });
      ws.on('error', () => {});
      cleanup.push(async () => ws.close());
      return ws;
    };
    const ws = open(['svall', `svall.pass.${pass}`]);
    expect((await hello(ws)).protocol).toBe(PROTOCOL_VERSION);
    expect(ws.protocol).toBe('svall');
    await expect(hello(open(['svall', 'svall.pass.not-the-pass']))).rejects.toThrow(/closed 4402/);
    await expect(hello(open(['svall', `svall.pass.${pass}`], 'https://evil.example'))).rejects.toThrow(/closed 1006/);
  });

  it('hands the pass back as a cookie to a phone that posts it from the link, and to nobody else', async () => {
    const api = await boot();
    const me = { 'Tailscale-User-Login': 'me@example.com' };
    const post = (path: string, body: string, headers: Record<string, string> = me) => fetch(`http://127.0.0.1:${api.port}${path}`, { method: 'POST', body, headers });
    const paired = await post(`/${key}/pair`, pass);
    expect(paired.status).toBe(204);
    expect(paired.headers.get('set-cookie')).toBe(`svall-pass=${pass}; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict`);
    for (const wrong of ['not-the-pass', pass.slice(1), '']) {
      const res = await post(`/${key}/pair`, wrong);
      expect([res.status, res.headers.get('set-cookie')]).toEqual([403, null]);
    }
    expect((await post('/pair', pass)).status).toBe(401);
    expect((await post(`/${key}/pair`, pass, {})).status).toBe(401);
    expect((await post(`/${key}/pair`, pass, { 'Tailscale-User-Login': 'them@example.com' })).status).toBe(401);
    expect((await post(`/${key}/pair`, pass, { ...me, origin: 'https://evil.example' })).status).toBe(403);
  });

  // a Home Screen app opens at the manifest's start_url, with none of the page's storage
  it('leads a Home Screen app back in with the pass through a paired page\'s manifest, and through no other', async () => {
    const api = await boot(() => 'work');
    const manifest = async (path: string, headers: Record<string, string>) => JSON.parse(await (await fetch(`http://127.0.0.1:${api.port}${path}`, { headers })).text());
    expect(await manifest(`/${key}/manifest.webmanifest`, PAIRED)).toEqual({ name: 'Svall work', short_name: 'svall work', start_url: `/#${pass}` });
    expect(await manifest(`/${key}/manifest.webmanifest`, {})).toEqual({ name: 'Svall work', short_name: 'svall work' });
    expect(await manifest(`/${key}/manifest.webmanifest`, { cookie: 'svall-pass=not-the-pass' })).toEqual({ name: 'Svall work', short_name: 'svall work' });
    expect(await manifest('/manifest.webmanifest', PAIRED)).toEqual({ name: 'Svall work', short_name: 'svall work' });
  });

  // the Mac's own login is learned from tailscale after the server is up
  it('takes a phone by the logins the fleet accepts as it connects, and none while it accepts none', async () => {
    const api = await boot();
    const open = (login: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': login, ...PAIRED } });
      cleanup.push(async () => ws.close());
      return ws;
    };
    api.current.logins = [];
    await expect(hello(open('me@example.com'))).rejects.toThrow(/closed 4403/);
    api.current.logins = ['me@example.com'];
    expect((await hello(open('me@example.com'))).protocol).toBe(PROTOCOL_VERSION);
  });

  it('asks tailscale once who owns this Mac while phones behind the key find no login accepted, then takes the owner', async () => {
    let looks = 0;
    let answer = () => {};
    const looked = new Promise<void>((r) => { answer = r; });
    const api = await boot(undefined, {
      get: async () => { looks++; await looked; api.current.logins = ['me@example.com']; return stubMobile.get(); },
      set: stubMobile.set,
    });
    api.current.logins = [];
    const open = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
      cleanup.push(async () => ws.close());
      return ws;
    };
    const refused = [open(), open(), open()].map((ws) => expect(hello(ws)).rejects.toThrow(/closed 4403/));
    const call = { id: 1, method: 'robot.answer', params: { id: 'c_none', answer: 'approve' } };
    const post = fetch(`http://127.0.0.1:${api.port}/${key}/rpc`, { method: 'POST', body: JSON.stringify(call), headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
    expect((await post).status).toBe(401);
    await Promise.all(refused);
    expect(looks).toBe(1);
    answer();
    await waitFor(() => api.current.logins.length > 0);
    expect((await hello(open())).protocol).toBe(PROTOCOL_VERSION);
    expect(looks).toBe(1);
  });

  it('asks tailscale again when a phone is refused behind the key, so a Mac signed in as someone else since takes its new owner', async () => {
    let looks = 0;
    const api = await boot(undefined, {
      get: async () => { looks++; api.current.logins = ['me@example.com']; return stubMobile.get(); },
      set: stubMobile.set,
    });
    api.current.logins = ['before@example.com'];
    const open = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
      cleanup.push(async () => ws.close());
      return ws;
    };
    await expect(hello(open())).rejects.toThrow(/closed 4403/);
    await waitFor(() => looks === 1);
    expect((await hello(open())).protocol).toBe(PROTOCOL_VERSION);
    expect(looks).toBe(1);
  });

  it('takes a phone only behind the key it holds now', async () => {
    const api = await boot();
    const me = { 'Tailscale-User-Login': 'me@example.com', ...PAIRED };
    const open = (k: string) => { const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${k}/`, { headers: me }); cleanup.push(async () => ws.close()); return ws; };
    expect((await hello(open(key))).protocol).toBe(PROTOCOL_VERSION);
    api.current.key = 'f00d'.repeat(12);
    const stale = open(key);
    await new Promise((r) => stale.once('open', r));
    stale.send(JSON.stringify({ id: 1, method: 'state.get', params: {} }));
    await expect(hello(stale)).rejects.toThrow(/closed 4401/);
    expect((await hello(open(api.current.key))).protocol).toBe(PROTOCOL_VERSION);
  });

  // turning the link on or off turns the key over, so a phone already in has to come in again through the new one
  it('closes every phone socket once the link turns on or off, and leaves the app\'s socket open', async () => {
    const api = await boot();
    const app = new WebSocket(`ws://127.0.0.1:${api.port}`);
    cleanup.push(async () => app.close());
    await new Promise((r) => app.once('open', r));
    const hi = hello(app);
    app.send(JSON.stringify({ token: 'secret' }));
    await hi;
    for (const [id, enabled] of [[1, false], [2, true]] as const) {
      const phone = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
      cleanup.push(async () => phone.close());
      await hello(phone);
      const closed = new Promise<number | string>((r) => { phone.once('close', (code) => r(code)); setTimeout(() => r('still open'), 2000); });
      const answered = new Promise((r) => app.on('message', (raw) => { if (JSON.parse(raw.toString()).id === id) r(undefined); }));
      app.send(JSON.stringify({ id, method: 'mobile.set', params: { enabled } }));
      expect(await closed).toBe(4401);
      await answered;
      expect(app.readyState).toBe(WebSocket.OPEN);
    }
  });

  it('closes a phone socket at its next call once the fleet no longer lists its login', async () => {
    const api = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
    cleanup.push(async () => ws.close());
    await hello(ws);
    api.current.logins = ['them@example.com'];
    const closed = new Promise<number>((r) => ws.once('close', r));
    ws.send(JSON.stringify({ id: 1, method: 'state.get', params: {} }));
    expect(await closed).toBe(4401);
  });

  // anything on the machine reaches the port; only tailscaled knows the key, so a header without it proves nothing
  it('holds a login header without the key to the token like any other socket', async () => {
    const api = await boot();
    for (const path of ['/', `/${'d'.repeat(48)}/`]) {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}${path}`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
      cleanup.push(async () => ws.close());
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ token: 'not the token' }));
      await expect(hello(ws)).rejects.toThrow(/closed 4401/);
    }
  });

  it('refuses a socket from a page svalld did not serve', async () => {
    const api = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}`, { origin: 'https://evil.example' });
    await expect(new Promise((_r, reject) => { ws.once('error', reject); })).rejects.toThrow(/403/);
  });

  it('takes the page on the tailnet name only behind the key, where the proxy vouches for the name', async () => {
    const api = await boot();
    const tailnet = { origin: 'https://mac.tail.ts.net', headers: { host: 'mac.tail.ts.net', 'Tailscale-User-Login': 'me@example.com', ...PAIRED } };
    const phone = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, tailnet);
    cleanup.push(async () => phone.close());
    expect((await hello(phone)).protocol).toBe(PROTOCOL_VERSION);
    const rebound = new WebSocket(`ws://127.0.0.1:${api.port}/`, tailnet);
    cleanup.push(async () => rebound.close());
    rebound.once('error', () => {});
    expect(await new Promise((resolve) => {
      rebound.once('open', () => resolve(101));
      rebound.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    })).toBe(403);
  });

  it('tells the app which phones are on the page, as they arrive and as they leave', async () => {
    const api = await boot();
    const told: PhoneSession[][] = [];
    const desktop = new WebSocket(`ws://127.0.0.1:${api.port}`);
    cleanup.push(async () => desktop.close());
    await new Promise((r) => desktop.once('open', r));
    desktop.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Event;
      if ('event' in msg && msg.event === 'mobile.phones') told.push(msg.data.phones);
    });
    desktop.send(JSON.stringify({ token: 'secret' }));

    const phone = new WebSocket(`ws://127.0.0.1:${api.port}/${key}/`, { headers: { 'Tailscale-User-Login': 'me@example.com', ...PAIRED } });
    cleanup.push(async () => phone.close());
    await hello(phone);
    await waitFor(() => told.length === 1);
    expect(told[0]).toEqual([{ login: 'me@example.com', since: expect.any(Number) }]);

    phone.close();
    await waitFor(() => told.length === 2);
    expect(told[1]).toEqual([]);
  });

  // what the worker posts when Approve on a notification is tapped, from the page on the tailnet name
  it('answers the prompt a notification carried, once', async () => {
    const api = await boot();
    // an agent's pane runs something other than a shell, or the poll ends the agent
    const c = await api.fleet.createRobot({ islandId: api.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await api.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: '11111111-1111-1111-1111-111111111111', transcriptPath: '/t.jsonl' } });
    await api.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Notification', notificationType: 'permission_prompt', message: 'Bash?' } });
    expect(api.store.state.robots[c.id].agent?.status).toBe('blocked');
    // a tap comes seconds later, after the fleet has polled the pane several times
    await waitForPolls(api.fleet, 3);
    const approve = () => new Promise<unknown>((resolve, reject) => {
      const body = JSON.stringify({ id: 1, method: 'robot.answer', params: { id: c.id, answer: 'approve' } });
      const req = http.request({
        host: '127.0.0.1', port: api.port, path: `/${key}/rpc`, method: 'POST',
        headers: { host: 'mac.tail.ts.net', origin: 'https://mac.tail.ts.net', 'tailscale-user-login': 'me@example.com', 'content-type': 'application/json', ...PAIRED },
      }, (res) => { let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') })); });
      req.on('error', reject);
      req.end(body);
    });
    expect(await approve()).toEqual({ status: 200, body: { id: 1, result: {} } });
    expect(api.store.state.robots[c.id].agent?.status).toBe('working');
    // a second tap on the same notification finds nothing waiting
    expect(await approve()).toMatchObject({ status: 200, body: { error: { code: 'invalid' } } });
  });

  it('takes one call over POST from a worker behind the key, and nothing from anyone else', async () => {
    const api = await boot();
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${api.port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
    const me = { 'Tailscale-User-Login': 'me@example.com', ...PAIRED };
    const call = { id: 1, method: 'robot.answer', params: { id: 'c_none', answer: 'approve' } };
    const ok = await post(`/${key}/rpc`, call, me);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 1, error: { code: 'not_found' } });
    // a worker an older svalld served answers with char.answer
    expect(await (await post(`/${key}/rpc`, { ...call, method: 'char.answer' }, me)).json()).toMatchObject({ id: 1, error: { code: 'not_found' } });
    expect((await post('/rpc', call, me)).status).toBe(401);
    expect((await post(`/${key}/rpc`, call, { 'Tailscale-User-Login': 'them@example.com' })).status).toBe(401);
    for (const method of ['state.get', 'robot.seen']) expect((await post(`/${key}/rpc`, { id: 1, method, params: { id: 'c_none' } }, me)).status).toBe(400);
    expect((await post(`/${key}/rpc`, call, { ...me, origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${api.port}/${key}/rpc`, { method: 'POST', body: '{', headers: me })).status).toBe(400);
  });

  it('reads a POST body whole, a character split across its chunks and all, and lets a dropped one go', async () => {
    const api = await boot();
    const headers = { 'tailscale-user-login': 'me@example.com', 'content-type': 'application/json', ...PAIRED };
    const body = Buffer.from(JSON.stringify({ id: 1, method: 'robot.answer', params: { id: 'c_ö', answer: 'approve' } }));
    const split = body.indexOf(Buffer.from('ö')) + 1;
    const answer = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: api.port, path: `/${key}/rpc`, method: 'POST', headers: { ...headers, 'content-length': body.length } },
        (res) => { let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve(text)); });
      req.on('error', reject);
      req.write(body.subarray(0, split));
      setTimeout(() => req.end(body.subarray(split)), 50);
    });
    expect(JSON.parse(answer)).toMatchObject({ error: { code: 'not_found', message: expect.stringContaining('c_ö') } });

    const dropped = http.request({ host: '127.0.0.1', port: api.port, path: `/${key}/rpc`, method: 'POST', headers: { ...headers, 'content-length': 100 } });
    dropped.on('error', () => {});
    dropped.write('{"id":1,');
    await new Promise((r) => setTimeout(r, 50));
    dropped.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`http://127.0.0.1:${api.port}/${key}/`)).status).toBe(200);
  });
});
