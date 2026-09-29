import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Event, type Response } from '@svall/protocol';
import { Config } from '../src/config.js';
import { startApi } from '../src/api/server.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { workspaceRoot } from '../src/resources/scan.js';
import { PushStore } from '../src/push/store.js';
import { Phones } from '../src/phones.js';
import { Store } from '../src/store.js';
import { TerminalHub } from '../src/terminals.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { Workspace } from '../src/workspace/workspace.js';
import { cleanHomes, hasTmux, makeHome, stubFleets, stubMobile, stubUsage, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

class TestClient {
  private next = 1;
  private pending = new Map<number, (r: Response) => void>();
  events: Event[] = [];
  closeCode?: number;
  constructor(public ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('event' in msg) this.events.push(msg);
      else this.pending.get(msg.id)?.(msg);
    });
    ws.on('close', (code) => { this.closeCode = code; });
  }
  static async connect(port: number, token: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.once('open', r));
    const c = new TestClient(ws);
    ws.send(JSON.stringify({ token }));
    return c;
  }
  call(method: string, params?: unknown): Promise<Response> {
    const id = this.next++;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

describe('startApi', () => {
  afterEach(() => { vi.useRealTimers(); cleanHomes(); });

  // a start that cannot listen leaves nothing behind to hold the process open
  it('leaves no heartbeat running when its port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const home = makeHome();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await expect(startApi({
        host: '127.0.0.1', port: (blocker.address() as net.AddressInfo).port, token: 'secret',
        store: {} as never, fleet: {} as never, fleets: stubFleets, terminals: {} as never, workspace: {} as never, usage: stubUsage, mobileControl: stubMobile, log: silentLogger,
        push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(),
        claude: { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') },
      })).rejects.toThrow(/EADDRINUSE/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

runIf('API', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot(heartbeatMs?: number) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 200 });
    const started = fleet.start();
    cleanup.push(async () => { await started.catch(() => {}); fleet.stop(); await tmux.killServer(); });
    await started;
    const terminals = new TerminalHub(fleet, tmux, store, silentLogger);
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    const workspace = new Workspace((id) => workspaceRoot(id, store.state, claude, undefined, paths.docs, paths.agentProfiles), silentLogger, () => [claude.json], [paths.docs, paths.agentProfiles]);
    const api = await startApi({
      host: '127.0.0.1', port: 0, token: 'secret', store, fleet, fleets: stubFleets, terminals, workspace, usage: stubUsage, mobileControl: stubMobile, log: silentLogger,
      push: new PushStore(path.join(home, 'push.json'), () => {}), vapidPublicKey: 'k', phones: new Phones(),
      claude, docs: paths.docs, agentProfiles: paths.agentProfiles, heartbeatMs,
    });
    cleanup.unshift(async () => { await api.close(); workspace.close(); });
    return { api, store, fleet, terminals, claude, docs: paths.docs, agentProfiles: paths.agentProfiles };
  }

  it('rejects a bad token and accepts a good one', async () => {
    const { api } = await boot();
    const bad = await TestClient.connect(api.port, 'nope');
    await waitFor(() => bad.closeCode === 4401);
    const good = await TestClient.connect(api.port, 'secret');
    const snap = (await good.call('state.get')) as { id: number; result: { version: number; islands: Record<string, { kind?: string }>; characters: unknown; home: { command: string } } };
    expect(snap.id).toBe(1);
    expect(snap.result.version).toBe(7);
    expect(snap.result.characters).toEqual({});
    expect(snap.result.islands.home.kind).toBe('home');
    expect(snap.result.home.command).toBe('claude --model sonnet');
    good.ws.close();
  });

  it('answers resources.get with the user scope first', async () => {
    const { api } = await boot();
    const client = await TestClient.connect(api.port, 'secret');
    const r = (await client.call('resources.get')) as { result: { sources: { name: string; tier?: string }[] } };
    expect(r.result.sources[0]).toMatchObject({ name: 'Claude', tier: 'global' });
  });

  it('refuses a socket opened from a web page other than the app', async () => {
    const { api } = await boot();
    const open = (origin?: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${api.port}`, origin ? { origin } : {});
      ws.once('open', () => { ws.close(); resolve(101); });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => {});
    });
    expect(await open('https://evil.example')).toBe(403);
    expect(await open('http://localhost:8080')).toBe(403);
    for (const origin of [undefined, 'svall://app', 'http://localhost:5173', 'http://127.0.0.1:5173']) expect(await open(origin)).toBe(101);
  });

  it('names its protocol version in the handshake reply', async () => {
    const { api } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}`);
    await new Promise((r) => ws.once('open', r));
    const reply = new Promise((r) => ws.once('message', (raw) => r(JSON.parse(raw.toString()))));
    ws.send(JSON.stringify({ token: 'secret' }));
    expect(await reply).toEqual({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } });
    ws.close();
  });

  it('drives islands, characters and terminals, and pushes patches', async () => {
    const { api } = await boot();
    const c = await TestClient.connect(api.port, 'secret');
    const island = (await c.call('island.create', { name: 'x' })) as { result: { id: string } };
    await waitFor(() => c.events.some((e) => e.event === 'state.patch'));
    const ch = (await c.call('char.create', { islandId: island.result.id, cwd: '/tmp' })) as { result: { id: string } };
    const opened = (await c.call('term.open', { id: ch.result.id, cols: 80, rows: 24 })) as { result: { screen: string } };
    expect(typeof opened.result.screen).toBe('string');
    await c.call('term.input', { id: ch.result.id, data: Buffer.from('echo via-api\n').toString('base64') });
    await waitFor(() => c.events.some((e) => e.event === 'term.output' && Buffer.from((e.data as { data: string }).data, 'base64').toString().includes('via-api')));
    const read = (await c.call('char.read', { id: ch.result.id, lines: 20 })) as { result: { text: string } };
    expect(read.result.text).toContain('via-api');
    expect(await c.call('char.read', { id: 'c_nope' })).toMatchObject({ error: { code: 'not_found' } });
    expect(await c.call('nope.method')).toMatchObject({ error: { code: 'unknown_method' } });
    expect(await c.call('char.run', { id: ch.result.id })).toMatchObject({ error: { code: 'invalid_params' } });
    c.ws.close();
  });

  it('closes terminals when the socket drops', async () => {
    const { api, store, terminals } = await boot();
    const c = await TestClient.connect(api.port, 'secret');
    const island = (await c.call('island.create', { name: 'x' })) as { result: { id: string } };
    const ch = (await c.call('char.create', { islandId: island.result.id, cwd: '/tmp' })) as { result: { id: string } };
    await c.call('term.open', { id: ch.result.id, cols: 80, rows: 24 });
    expect(terminals.viewerCount(ch.result.id)).toBe(1);
    c.ws.close();
    await waitFor(() => terminals.viewerCount(ch.result.id) === 0, 2000);
    expect(store.state.characters[ch.result.id].tmux).toBeDefined();
  });

  it('lets go of a socket that stops answering pings, and of the terminal it watched', async () => {
    const { api, terminals } = await boot(200);
    const answers = await TestClient.connect(api.port, 'secret');
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}`, { autoPong: false });
    // it answers until its terminal is open, then drops off the network without a word
    let answering = true;
    ws.on('ping', () => { if (answering) ws.pong(); });
    await new Promise((r) => ws.once('open', r));
    const silent = new TestClient(ws);
    ws.send(JSON.stringify({ token: 'secret' }));
    const island = (await silent.call('island.create', { name: 'x' })) as { result: { id: string } };
    const ch = (await silent.call('char.create', { islandId: island.result.id, cwd: '/tmp' })) as { result: { id: string } };
    await silent.call('term.open', { id: ch.result.id, cols: 80, rows: 24 });
    expect(terminals.viewerCount(ch.result.id)).toBe(1);
    answering = false;
    await waitFor(() => silent.closeCode !== undefined, 2000);
    await waitFor(() => terminals.viewerCount(ch.result.id) === 0, 2000);
    expect(answers.closeCode).toBeUndefined();
    answers.ws.close();
  });

  it('answers a blocked agent, and refuses when nothing is asked', async () => {
    const { api, fleet } = await boot();
    const c = await TestClient.connect(api.port, 'secret');
    const island = (await c.call('island.create', { name: 'x' })) as { result: { id: string } };
    // an agent's pane runs something other than a shell, or the poll ends the agent
    const ch = (await c.call('char.create', { islandId: island.result.id, cwd: '/tmp', command: 'sleep 600' })) as { result: { id: string } };
    expect(await c.call('char.answer', { id: ch.result.id, answer: 'approve' })).toMatchObject({ error: { code: 'invalid' } });
    fleet.onSocketEvent({ hook: { charId: ch.result.id, backend: 'claude', name: 'SessionStart', sessionId: '11111111-1111-1111-1111-111111111111', transcriptPath: '/t.jsonl' } });
    fleet.onSocketEvent({ hook: { charId: ch.result.id, backend: 'claude', name: 'Notification', notificationType: 'permission_prompt', message: 'Bash?' } });
    expect((await c.call('state.get')) as { result: { characters: Record<string, { agent?: { prompt?: string } }> } }).toMatchObject({ result: { characters: { [ch.result.id]: { agent: { prompt: 'Bash?' } } } } });
    expect(await c.call('char.answer', { id: ch.result.id, answer: 'deny' })).toMatchObject({ result: {} });
    c.ws.close();
  });

  it('remembers a device and what it wants to hear about', async () => {
    const { api } = await boot();
    const c = await TestClient.connect(api.port, 'secret');
    const result = async (r: Promise<Response>) => (await r as { result: unknown }).result;
    const sub = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked'] };
    expect(await result(c.call('push.key'))).toEqual({ publicKey: 'k' });
    expect(await result(c.call('push.subscribe', sub))).toEqual({});
    expect(await result(c.call('push.get', { endpoint: sub.endpoint }))).toEqual({ statuses: ['blocked'] });
    expect(await result(c.call('push.unsubscribe', { endpoint: sub.endpoint }))).toEqual({});
    expect(await result(c.call('push.get', { endpoint: sub.endpoint }))).toEqual({});
    expect(await c.call('push.subscribe', { ...sub, endpoint: 'not a url' })).toMatchObject({ error: { code: 'invalid_params' } });
    c.ws.close();
  });

  it('forgets every device when the phone link is turned off, and keeps them while it is turned on', async () => {
    const { api } = await boot();
    const c = await TestClient.connect(api.port, 'secret');
    const sub = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked'] };
    await c.call('push.subscribe', sub);
    await c.call('mobile.set', { enabled: true });
    expect(await c.call('push.get', { endpoint: sub.endpoint })).toMatchObject({ result: { statuses: ['blocked'] } });
    await c.call('mobile.set', { enabled: false });
    expect(((await c.call('push.get', { endpoint: sub.endpoint })) as { result: unknown }).result).toEqual({});
    c.ws.close();
  });

  it('serves a character\'s files and refuses a path outside its root', async () => {
    const { api } = await boot();
    const client = await TestClient.connect(api.port, 'secret');
    // the path tmux reports for the pane, which the poll writes over the one it was made with
    const home = fs.realpathSync(makeHome());
    fs.writeFileSync(`${home}/hello.txt`, 'hi\n');
    const island = (await client.call('island.create', { name: 'ws' })) as { result: { id: string } };
    const c = (await client.call('char.create', { islandId: island.result.id, cwd: home })) as { result: { id: string } };
    const list = (await client.call('fs.list', { id: c.result.id, path: '' })) as { result: { entries: { name: string }[] } };
    expect(list.result.entries.map((e) => e.name)).toEqual(['hello.txt']);
    const bad = (await client.call('fs.read', { id: c.result.id, path: '../x' })) as { error: { code: string } };
    expect(bad.error.code).toBe('invalid');
    const read = (await client.call('fs.read', { id: c.result.id, path: 'hello.txt' })) as { result: { mtimeMs: number; root: string } };
    expect(read.result.root).toBe(home);
    const write = (root: string) => client.call('fs.write', { id: c.result.id, path: 'hello.txt', text: 'bye\n', mtimeMs: read.result.mtimeMs, root });
    expect(await write('/elsewhere')).toMatchObject({ error: { code: 'invalid' } });
    expect(await write(home)).toMatchObject({ result: { mtimeMs: expect.any(Number) } });
    client.ws.close();
  });

  it('serves the run\'s Claude dir through its root id and refuses a forged one', async () => {
    const { api, claude } = await boot();
    fs.mkdirSync(claude.dir, { recursive: true });
    fs.writeFileSync(path.join(claude.dir, 'CLAUDE.md'), '# me\n');
    const client = await TestClient.connect(api.port, 'secret');
    const read = (await client.call('fs.read', { id: `r:${claude.dir}`, path: 'CLAUDE.md' })) as { result: { text: string } };
    expect(read.result.text).toBe('# me\n');
    expect(await client.call('fs.read', { id: 'r:/etc', path: 'hosts' })).toMatchObject({ error: { code: 'not_found' } });
    client.ws.close();
  });

  it('creates, renames and deletes a doc in an island\'s docs folder', async () => {
    const { api, docs } = await boot();
    const client = await TestClient.connect(api.port, 'secret');
    const call = (method: string, params: unknown) => client.call(method, params) as Promise<{ result?: unknown; error?: { code: string } }>;
    const island = (await client.call('island.create', { name: 'docs' })) as { result: { id: string } };
    const id = `r:${path.join(docs, 'islands', island.result.id)}`;
    const sources = (await client.call('resources.get')) as { result: { sources: { rootId: string; tier?: string }[] } };
    expect(sources.result.sources.find((s) => s.rootId === id)).toMatchObject({ tier: 'island' });
    expect((await call('docs.create', { id, path: 'note.md', text: 'hi' })).result).toMatchObject({ mtimeMs: expect.any(Number) });
    expect((await call('docs.create', { id, path: 'note.md', text: 'hi' })).error).toMatchObject({ code: 'exists' });
    expect((await call('docs.rename', { id, path: 'note.md', to: 'memo.md' })).result).toEqual({});
    expect((await call('fs.read', { id, path: 'memo.md' })).result).toMatchObject({ text: 'hi' });
    expect((await call('docs.delete', { id, path: 'memo.md' })).result).toEqual({});
    expect((await call('fs.read', { id, path: 'memo.md' })).error).toMatchObject({ code: 'not_found' });
    client.ws.close();
  });

  it('takes the characters on an agent profile along when its file is renamed, and leaves them when the name is taken', async () => {
    const { api, store, fleet, agentProfiles } = await boot();
    const client = await TestClient.connect(api.port, 'secret');
    const call = (method: string, params: unknown) => client.call(method, params) as Promise<{ result?: unknown; error?: { code: string } }>;
    const island = fleet.createIsland({ name: 'roles' });
    const a = await fleet.createCharacter({ islandId: island.id, cwd: '/tmp', agentProfile: 'reviewer' });
    const b = await fleet.createCharacter({ islandId: island.id, cwd: '/tmp', agentProfile: 'planner' });
    const id = `r:${agentProfiles}`;
    expect((await call('docs.rename', { id, path: 'reviewer.md', to: 'planner.md' })).error).toMatchObject({ code: 'exists' });
    expect(store.state.characters[a.id].agentProfile).toBe('reviewer');
    expect((await call('docs.rename', { id, path: 'reviewer.md', to: 'critic.md' })).result).toEqual({});
    expect(store.state.characters[a.id].agentProfile).toBe('critic');
    expect(store.state.characters[b.id].agentProfile).toBe('planner');
    expect(fleet.brief(a.id)).toContain('Agent profile: critic — follow this role.');
    client.ws.close();
  });

  it('tells a watching socket that its character\'s root changed', async () => {
    const { api } = await boot();
    const client = await TestClient.connect(api.port, 'secret');
    const home = makeHome();
    const island = (await client.call('island.create', { name: 'ws' })) as { result: { id: string } };
    const c = (await client.call('char.create', { islandId: island.result.id, cwd: home })) as { result: { id: string } };
    await client.call('repo.watch', { id: c.result.id });
    // a watcher that has just started may not hear yet, so the write is made again until it is heard
    await waitFor(() => {
      fs.writeFileSync(`${home}/hello.txt`, 'hi\n');
      return client.events.some((e) => e.event === 'repo.changed' && e.data.id === c.result.id);
    }, 10_000);
    client.ws.close();
  });
});
