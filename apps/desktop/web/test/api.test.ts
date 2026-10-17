import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { LOGIN_REFUSED, PROTOCOL_VERSION } from '@svall/protocol';
import { Api, ApiError, type Status } from '../src/api.js';

type Server = { wss: WebSocketServer; port: number; close(): Promise<void> };

function serve(protocol: number = PROTOCOL_VERSION): Promise<Server> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => {
    let authed = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!authed) {
        if (msg.token !== 'tok') { ws.close(4401); return; }
        authed = true;
        ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol } }));
        return;
      }
      if (msg.method === 'state.get') ws.send(JSON.stringify({ id: msg.id, result: { version: 1, islands: {}, characters: {} } }));
      else if (msg.method === 'char.seen') ws.send(JSON.stringify({ id: msg.id, error: { code: 'not_found', message: 'nope' } }));
      else if (msg.method === 'garbage') { ws.send('not json'); ws.send(JSON.stringify({ id: msg.id, result: {} })); }
      else if (msg.method === 'hang') { /* never answered */ }
      else if (msg.method === 'ping') { ws.send(JSON.stringify({ event: 'state.patch', data: { ops: [] } })); ws.send(JSON.stringify({ id: msg.id, result: {} })); }
    });
  });
  return new Promise((resolve) => wss.once('listening', () => {
    const port = (wss.address() as { port: number }).port;
    resolve({ wss, port, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) });
  }));
}

const until = (check: () => boolean, ms = 3000) => new Promise<void>((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = () => { if (check()) resolve(); else if (Date.now() > end) reject(new Error('timeout')); else setTimeout(tick, 10); };
  tick();
});

describe('Api', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

  it('handshakes, calls, receives events and reconnects after the server drops', async () => {
    const server = await serve();
    cleanup.push(server.close);
    const api = new Api({ url: `ws://127.0.0.1:${server.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    let opens = 0; const events: string[] = [];
    api.onStatus = (s) => statuses.push(s);
    api.onOpen = () => { opens++; };
    api.onEvent = (e) => events.push(e.event);
    api.start();
    await until(() => opens === 1);
    expect(statuses).toEqual(['connecting', 'online']);
    expect(await api.call('state.get', {})).toEqual({ version: 1, islands: {}, characters: {} });
    await expect(api.call('char.seen', { id: 'x' })).rejects.toBeInstanceOf(ApiError);
    await api.call('ping' as never, {} as never);
    expect(events).toEqual(['state.patch']);
    await api.call('garbage' as never, {} as never);

    for (const c of server.wss.clients) c.terminate();
    await until(() => statuses.at(-1) === 'offline');
    await expect(api.call('state.get', {})).rejects.toThrow(/offline/);
    await until(() => opens === 2);
    expect(statuses.at(-1)).toBe('online');
  });

  // svalld closes a phone socket with 4401 when the link turns over; the page comes back in through the new one
  it('connects again after the daemon closes an admitted socket with 4401', async () => {
    const server = await serve();
    cleanup.push(server.close);
    const api = new Api({ url: `ws://127.0.0.1:${server.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    let opens = 0;
    api.onStatus = (s) => statuses.push(s);
    api.onOpen = () => { opens++; };
    api.start();
    await until(() => opens === 1);
    for (const c of server.wss.clients) c.close(4401, 'phone link changed');
    await until(() => opens === 2);
    expect(statuses).toEqual(['connecting', 'online', 'offline', 'connecting', 'online']);
  });

  it('leaves the daemon it is still connected to when the shell names another', async () => {
    const [a, b] = [await serve(), await serve()];
    cleanup.push(a.close, b.close);
    const api = new Api({ url: `ws://127.0.0.1:${a.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    let opens = 0;
    api.onOpen = () => { opens++; };
    api.start();
    await until(() => opens === 1);
    api.setEndpoint({ url: `ws://127.0.0.1:${a.port}`, token: 'tok' });
    api.setEndpoint({ url: `ws://127.0.0.1:${b.port}`, token: 'tok' });
    await until(() => opens === 2);
    expect(b.wss.clients.size).toBe(1);
    await until(() => a.wss.clients.size === 0);
  });

  it('reads a fleet that has just moved again, from the daemon it already reaches when the shell names that one', async () => {
    const server = await serve();
    cleanup.push(server.close);
    const endpoint = { url: `ws://127.0.0.1:${server.port}`, token: 'tok' };
    const api = new Api(endpoint, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    let opens = 0;
    api.onOpen = () => { opens++; };
    api.start();
    await until(() => opens === 1);
    api.setEndpoint(endpoint, true);
    await until(() => opens === 2);
  });

  it('rejects a call the daemon never answers', async () => {
    const server = await serve();
    cleanup.push(server.close);
    const api = new Api({ url: `ws://127.0.0.1:${server.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, callTimeout: 30 });
    cleanup.push(() => api.stop());
    let online = false;
    api.onStatus = (s) => { online = s === 'online'; };
    api.start();
    await until(() => online);
    await expect(api.call('hang' as 'state.get', {})).rejects.toThrow(/did not answer hang/);
    await expect(api.call('state.get', {})).resolves.toMatchObject({ version: 1 });
  });

  it('rejects a call still waiting when the socket closes', async () => {
    const server = await serve();
    cleanup.push(server.close);
    const api = new Api({ url: `ws://127.0.0.1:${server.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, callTimeout: 60_000 });
    cleanup.push(() => api.stop());
    let online = false;
    api.onStatus = (s) => { online = s === 'online'; };
    api.start();
    await until(() => online);
    const waiting = api.call('hang' as 'state.get', {});
    for (const c of server.wss.clients) c.terminate();
    const unsettled = new Promise((r) => setTimeout(() => r('still waiting'), 1000));
    await expect(Promise.race([waiting, unsettled])).rejects.toThrow('svalld connection closed');
  });

  it('fire swallows a rejected call', async () => {
    const api = new Api({ url: 'ws://127.0.0.1:1', token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket });
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a); };
    try {
      api.fire('char.seen', { id: 'x' });
      await new Promise((r) => setTimeout(r, 0));
    } finally { console.warn = warn; }
    expect(warned).toHaveLength(1);
  });

  it('says nothing on arrival when the socket carries no token, and waits to be greeted', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const port = (wss.address() as { port: number }).port;
    cleanup.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    const said: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => said.push(raw.toString()));
      ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
    });
    const api = new Api({ url: `ws://127.0.0.1:${port}` }, { WS: WebSocket as unknown as typeof globalThis.WebSocket });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    api.onStatus = (s) => statuses.push(s);
    api.start();
    await until(() => statuses.includes('online'));
    expect(said).toEqual([]);
  });

  it('rejects a bad token and keeps retrying', async () => {
    const server = await serve();
    cleanup.push(server.close);
    const api = new Api({ url: `ws://127.0.0.1:${server.port}`, token: 'wrong' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    api.onStatus = (s) => statuses.push(s);
    api.start();
    await until(() => statuses.filter((s) => s === 'offline').length >= 2);
    expect(statuses).not.toContain('online');
  });

  it('reports a daemon on another protocol as outdated, and recovers once it matches', async () => {
    const old = await serve(PROTOCOL_VERSION + 1);
    const api = new Api({ url: `ws://127.0.0.1:${old.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    let opens = 0;
    api.onStatus = (s) => statuses.push(s);
    api.onOpen = () => { opens++; };
    api.start();
    await until(() => statuses.filter((s) => s === 'outdated').length >= 2);
    expect(statuses.slice(1).every((s) => s === 'outdated')).toBe(true);
    expect(opens).toBe(0);

    await old.close();
    const current = await serve();
    cleanup.push(current.close);
    api.setEndpoint({ url: `ws://127.0.0.1:${current.port}`, token: 'tok' });
    await until(() => opens === 1);
    expect(statuses.at(-1)).toBe('online');
  });

  it('ignores a socket a reconnect has already replaced', async () => {
    const sockets: Fake[] = [];
    class Fake {
      onopen?: () => void; onmessage?: (ev: { data: string }) => void; onerror?: () => void; onclose?: (ev: { code: number }) => void;
      constructor() { sockets.push(this); }
      send(): void {}
      close(): void { this.onclose?.({ code: 1000 }); }
    }
    const api = new Api({ url: 'ws://127.0.0.1:1' }, { WS: Fake as unknown as typeof globalThis.WebSocket, minDelay: 1, maxDelay: 1 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    let opens = 0;
    api.onStatus = (s) => statuses.push(s);
    api.onOpen = () => { opens++; };
    api.start();
    const hello = { data: JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }) };
    sockets[0].onmessage?.(hello);
    expect(opens).toBe(1);
    sockets[0].onclose?.({ code: 1006 });
    await until(() => sockets.length === 2);
    sockets[0].onmessage?.(hello);
    sockets[0].onclose?.({ code: 1006 });
    await new Promise((r) => setTimeout(r, 20));
    expect(opens).toBe(1);
    expect(statuses.at(-1)).toBe('connecting');
    expect(sockets).toHaveLength(2);
  });

  // the proxy brought the page from a tailnet login the fleet does not take; the owner's login may still be on its way
  it('reports a refused login as such across retries, and comes online once the login is taken', async () => {
    let accepted = false;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    cleanup.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
    wss.on('connection', (ws) => {
      if (accepted) ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
      else ws.close(LOGIN_REFUSED, 'tailnet login not accepted');
    });
    const api = new Api({ url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    api.onStatus = (s) => statuses.push(s);
    api.start();
    await until(() => statuses.filter((s) => s === 'refused').length >= 2);
    expect(statuses.slice(1).every((s) => s === 'refused')).toBe(true);
    accepted = true;
    await until(() => statuses.at(-1) === 'online');
  });

  it('reports offline once the daemon on another protocol stops answering', async () => {
    const old = await serve(PROTOCOL_VERSION + 1);
    const api = new Api({ url: `ws://127.0.0.1:${old.port}`, token: 'tok' }, { WS: WebSocket as unknown as typeof globalThis.WebSocket, minDelay: 20, maxDelay: 50 });
    cleanup.push(() => api.stop());
    const statuses: Status[] = [];
    api.onStatus = (s) => statuses.push(s);
    api.start();
    await until(() => statuses.includes('outdated'));
    await old.close();
    await until(() => statuses.at(-1) === 'offline');
  });
});
