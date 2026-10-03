// The relay shape Tasks 30 and 31 will build against: one outbound owner socket per fleet, fenced
// by a secret and a generation, carrying viewer RPC and terminal bytes multiplexed by request id.
// Everything runs in-process on loopback ws://; tailscale serve terminates TLS in front of the real
// gateway, so nothing here asserts anything about certificates.
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  CLOSE_BAD_FRAME,
  CLOSE_SUPERSEDED,
  OWNER_PATH,
  type Frame,
  type Gateway,
  type Identity,
  decodeBinary,
  encodeBinary,
  startGateway,
  verifyIdentity,
} from './fake-gateway.js';

const FLEET = 'private';
const SECRET = 'relay-secret-for-the-private-fleet';
const OTHER_FLEET = 'work';
const OTHER_SECRET = 'relay-secret-for-the-work-fleet';
const IDENTITY_KEY = crypto.randomBytes(32);
const LOGIN = 'skipper@example.com';

// a few-kilobyte RPC payload, and a terminal burst over the 1 MiB the spec names
const RPC_PARAMS = { path: 'packages/svalld/src/main.ts', text: 'x'.repeat(4096) };
const TERMINAL_BYTES = 1024 * 1024 + 7;

function terminalPayload(seed: number): Buffer {
  const buf = Buffer.allocUnsafe(TERMINAL_BYTES);
  for (let i = 0; i < buf.length; i++) buf[i] = (i + seed) & 0xff;
  return buf;
}

type Received = { frame: Frame; payload?: Buffer };

/** Collects every frame a socket receives, so a test can await the one it wants by id. */
class Tap {
  readonly got: Received[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const { header, payload } = decodeBinary(data);
        this.got.push({ frame: header, payload });
      } else {
        this.got.push({ frame: JSON.parse(data.toString()) as Frame });
      }
      for (const w of this.waiters.splice(0)) w();
    });
  }
  async take(id: string, t: Frame['t']): Promise<Received> {
    const end = Date.now() + 5000;
    for (;;) {
      const hit = this.got.find((r) => r.frame.id === id && r.frame.t === t);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no ${t} frame ${id} after ${this.got.length} frames`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
}

const opened = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

const closedWith = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once('close', (code) => r(code)));

describe('gateway relay contract', () => {
  const sockets: WebSocket[] = [];
  let gateway: Gateway;

  afterEach(async () => {
    // a refused dial never opened, and terminating one of those throws rather than closing it
    for (const ws of sockets.splice(0)) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try { ws.terminate(); } catch { /* never established */ }
    }
    await gateway.close();
  });

  const boot = async (): Promise<Gateway> =>
    (gateway = await startGateway({ secrets: { [FLEET]: SECRET, [OTHER_FLEET]: OTHER_SECRET }, identityKey: IDENTITY_KEY }));

  function dialOwner(port: number, o: { fleet?: string; secret?: string; generation?: number; machine?: string } = {}): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${OWNER_PATH}`, {
      headers: {
        'x-svall-fleet': o.fleet ?? FLEET,
        'x-svall-machine': o.machine ?? 'this-mac',
        'x-svall-generation': String(o.generation ?? 1),
        'x-svall-secret': o.secret ?? SECRET,
      },
    });
    sockets.push(ws);
    return ws;
  }

  function dialViewer(port: number, o: { fleet?: string; login?: string | null; name?: string } = {}): WebSocket {
    const headers: Record<string, string> = {};
    if (o.login !== null) headers['tailscale-user-login'] = o.login ?? LOGIN;
    if (o.name) headers['tailscale-user-name'] = o.name;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/f/${o.fleet ?? FLEET}/socket`, { headers });
    sockets.push(ws);
    return ws;
  }

  const rejection = (ws: WebSocket): Promise<number> =>
    new Promise((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => reject(new Error('the gateway accepted a connection it should have refused')));
    });

  it('accepts an owner that presents the fleet secret and a generation', async () => {
    const g = await boot();
    await opened(dialOwner(g.port, { generation: 3, machine: 'trift' }));
    expect(g.owner(FLEET)).toEqual({ machine: 'trift', generation: 3 });
  });

  it('refuses an owner with the wrong secret', async () => {
    const g = await boot();
    await expect(rejection(dialOwner(g.port, { secret: `${SECRET}x` }))).resolves.toBe(401);
    expect(g.owner(FLEET)).toBeUndefined();
  });

  it('refuses an owner for a fleet the gateway holds no secret for', async () => {
    const g = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}${OWNER_PATH}`, {
      headers: { 'x-svall-fleet': 'unknown', 'x-svall-generation': '1', 'x-svall-secret': SECRET },
    });
    sockets.push(ws);
    await expect(rejection(ws)).resolves.toBe(401);
  });

  it('refuses a second owner at the same generation and keeps the first', async () => {
    const g = await boot();
    await opened(dialOwner(g.port, { generation: 4, machine: 'this-mac' }));
    await expect(rejection(dialOwner(g.port, { generation: 4, machine: 'trift' }))).resolves.toBe(409);
    expect(g.owner(FLEET)).toEqual({ machine: 'this-mac', generation: 4 });
  });

  it('refuses an owner at a stale generation', async () => {
    const g = await boot();
    await opened(dialOwner(g.port, { generation: 4 }));
    await expect(rejection(dialOwner(g.port, { generation: 3, machine: 'trift' }))).resolves.toBe(409);
  });

  it('lets a newer generation take the fleet over and closes the old owner', async () => {
    const g = await boot();
    const first = dialOwner(g.port, { generation: 4, machine: 'this-mac' });
    await opened(first);
    const closed = new Promise<number>((r) => first.once('close', (code) => r(code)));
    await opened(dialOwner(g.port, { generation: 5, machine: 'trift' }));
    await expect(closed).resolves.toBe(CLOSE_SUPERSEDED);
    expect(g.owner(FLEET)).toEqual({ machine: 'trift', generation: 5 });
  });

  it('refuses a viewer that arrives without the Tailscale identity header', async () => {
    const g = await boot();
    await opened(dialOwner(g.port));
    await expect(rejection(dialViewer(g.port, { login: null }))).resolves.toBe(401);
  });

  it('refuses a viewer when no owner holds the fleet', async () => {
    const g = await boot();
    await expect(rejection(dialViewer(g.port))).resolves.toBe(503);
  });

  it('signs the identity it mints from the proxy header and forwards it on the relay', async () => {
    const g = await boot();
    const owner = dialOwner(g.port);
    await opened(owner);
    const ownerTap = new Tap(owner);
    const viewer = dialViewer(g.port, { name: 'Skipper' });
    await opened(viewer);

    viewer.send(JSON.stringify({ t: 'rpc', id: 'r1', method: 'state.get' }));
    const got = await ownerTap.take('r1', 'rpc');

    const identity = got.frame.identity as Identity;
    expect(identity.login).toBe(LOGIN);
    expect(identity.name).toBe('Skipper');
    expect(identity.fleet).toBe(FLEET);
    expect(verifyIdentity(IDENTITY_KEY, identity, got.frame.sig as string)).toBe(true);
    expect(verifyIdentity(IDENTITY_KEY, { ...identity, login: 'someone.else@example.com' }, got.frame.sig as string)).toBe(false);
    expect(verifyIdentity(crypto.randomBytes(32), identity, got.frame.sig as string)).toBe(false);
  });

  it('ignores an identity the viewer supplies itself', async () => {
    const g = await boot();
    const owner = dialOwner(g.port);
    await opened(owner);
    const ownerTap = new Tap(owner);
    const viewer = dialViewer(g.port);
    await opened(viewer);

    const forged: Identity = { fleet: FLEET, login: 'attacker@example.com', issuedAt: Date.now() };
    viewer.send(JSON.stringify({ t: 'rpc', id: 'r1', method: 'state.get', identity: forged, sig: 'forged' }));
    const got = await ownerTap.take('r1', 'rpc');

    expect((got.frame.identity as Identity).login).toBe(LOGIN);
    expect(verifyIdentity(IDENTITY_KEY, got.frame.identity as Identity, got.frame.sig as string)).toBe(true);
  });

  it('multiplexes RPC and terminal-sized frames both ways over one owner socket', async () => {
    const g = await boot();
    const owner = dialOwner(g.port);
    await opened(owner);
    const ownerTap = new Tap(owner);
    const viewer = dialViewer(g.port);
    await opened(viewer);
    const viewerTap = new Tap(viewer);

    const input = terminalPayload(11);
    const output = terminalPayload(97);

    // everything leaves the viewer at once, so the owner must tell the streams apart by id, not by order
    viewer.send(JSON.stringify({ t: 'rpc', id: 'rpc-1', method: 'file.read', params: RPC_PARAMS }));
    viewer.send(encodeBinary({ t: 'term', id: 'term-a' }, input), { binary: true });
    viewer.send(JSON.stringify({ t: 'rpc', id: 'rpc-2', method: 'state.get' }));

    const call = await ownerTap.take('rpc-1', 'rpc');
    expect(call.frame.params).toEqual(RPC_PARAMS);
    const keystrokes = await ownerTap.take('term-a', 'term');
    expect(keystrokes.payload).toHaveLength(TERMINAL_BYTES);
    expect(Buffer.compare(keystrokes.payload as Buffer, input)).toBe(0);
    const second = await ownerTap.take('rpc-2', 'rpc');

    const viewerId = call.frame.viewer as string;
    expect(viewerId).toBeTruthy();
    expect(second.frame.viewer).toBe(viewerId);

    // answers and the terminal stream come back down the same socket, still tagged by id
    owner.send(encodeBinary({ t: 'term', id: 'term-a', viewer: viewerId }, output), { binary: true });
    owner.send(JSON.stringify({ t: 'res', id: 'rpc-2', viewer: viewerId, result: { ok: true } }));
    owner.send(JSON.stringify({ t: 'res', id: 'rpc-1', viewer: viewerId, result: { bytes: RPC_PARAMS.text.length } }));
    owner.send(JSON.stringify({ t: 'event', id: 'ev-1', viewer: viewerId, event: 'state.patch' }));

    const painted = await viewerTap.take('term-a', 'term');
    expect(Buffer.compare(painted.payload as Buffer, output)).toBe(0);
    expect((await viewerTap.take('rpc-1', 'res')).frame.result).toEqual({ bytes: RPC_PARAMS.text.length });
    expect((await viewerTap.take('rpc-2', 'res')).frame.result).toEqual({ ok: true });
    expect((await viewerTap.take('ev-1', 'event')).frame.event).toBe('state.patch');
  });

  it('routes a viewer frame only to the viewer it belongs to', async () => {
    const g = await boot();
    const owner = dialOwner(g.port);
    await opened(owner);
    const ownerTap = new Tap(owner);
    const one = dialViewer(g.port, { login: 'one@example.com' });
    const two = dialViewer(g.port, { login: 'two@example.com' });
    await Promise.all([opened(one), opened(two)]);
    const oneTap = new Tap(one);
    const twoTap = new Tap(two);

    one.send(JSON.stringify({ t: 'rpc', id: 'from-one', method: 'state.get' }));
    two.send(JSON.stringify({ t: 'rpc', id: 'from-two', method: 'state.get' }));
    const a = await ownerTap.take('from-one', 'rpc');
    const b = await ownerTap.take('from-two', 'rpc');
    expect((a.frame.identity as Identity).login).toBe('one@example.com');
    expect((b.frame.identity as Identity).login).toBe('two@example.com');
    expect(a.frame.viewer).not.toBe(b.frame.viewer);

    owner.send(JSON.stringify({ t: 'res', id: 'from-one', viewer: a.frame.viewer, result: 'for one' }));
    expect((await oneTap.take('from-one', 'res')).frame.result).toBe('for one');
    expect(twoTap.got).toHaveLength(0);
  });

  it('drops an owner frame that names a viewer of another fleet', async () => {
    const g = await boot();
    const mine = dialOwner(g.port);
    const theirs = dialOwner(g.port, { fleet: OTHER_FLEET, secret: OTHER_SECRET, machine: 'trift' });
    await Promise.all([opened(mine), opened(theirs)]);
    const theirsTap = new Tap(theirs);
    const viewer = dialViewer(g.port, { fleet: OTHER_FLEET, login: 'other@example.com' });
    await opened(viewer);
    const viewerTap = new Tap(viewer);

    viewer.send(JSON.stringify({ t: 'rpc', id: 'theirs-1', method: 'state.get' }));
    const seen = await theirsTap.take('theirs-1', 'rpc');
    const otherViewer = seen.frame.viewer as string;

    // the other fleet's owner learns a viewer id; this fleet's owner must not be able to use it
    mine.send(JSON.stringify({ t: 'res', id: 'theirs-1', viewer: otherViewer, result: 'crossed fleets' }));
    mine.send(encodeBinary({ t: 'term', id: 'theirs-1', viewer: otherViewer }, Buffer.from('crossed')), { binary: true });
    theirs.send(JSON.stringify({ t: 'res', id: 'theirs-1', viewer: otherViewer, result: 'from its own owner' }));

    expect((await viewerTap.take('theirs-1', 'res')).frame.result).toBe('from its own owner');
    await new Promise((r) => setTimeout(r, 100));
    expect(viewerTap.got).toHaveLength(1);
  });

  it('closes the socket that sent a malformed frame and keeps serving', async () => {
    const g = await boot();
    const owner = dialOwner(g.port);
    await opened(owner);
    const viewer = dialViewer(g.port);
    await opened(viewer);

    // a header length that overruns the frame, and a text frame that is not JSON at all
    const truncated = Buffer.concat([Buffer.from([0, 0, 0xff, 0xff]), Buffer.from('{"t":"term"')]);
    const viewerClosed = closedWith(viewer);
    viewer.send(truncated, { binary: true });
    await expect(viewerClosed).resolves.toBe(CLOSE_BAD_FRAME);

    const ownerClosed = closedWith(owner);
    owner.send('not json at all');
    await expect(ownerClosed).resolves.toBe(CLOSE_BAD_FRAME);

    const next = dialOwner(g.port, { generation: 2 });
    await opened(next);
    const nextTap = new Tap(next);
    const fresh = dialViewer(g.port);
    await opened(fresh);
    fresh.send(JSON.stringify({ t: 'rpc', id: 'after', method: 'state.get' }));
    expect((await nextTap.take('after', 'rpc')).frame.method).toBe('state.get');
  });
});
