import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PROTOCOL_VERSION, type Event, type MachineId } from '@svall/protocol';
import { Api, type Status } from '../src/api.js';
import { FollowApi, SourceLeft } from '../src/sources.js';
import { createAppStore, type AppStore } from '../src/store/index.js';
import { chr, fleet } from './fixtures.js';

const ME = '11111111-1111-4111-8111-111111111111' as MachineId;
const HOME = '22222222-2222-4222-8222-222222222222' as MachineId;
const OTHER = '33333333-3333-4333-8333-333333333333' as MachineId;
const TOKEN = 'the-homes-token';
const CONNECTED = { machine: HOME, name: 'studio', state: 'connected', ssh: 'ada@studio', controlSocket: '/tmp/m', port: 50_000, token: TOKEN, release: '0.21' };
const url = (port: number) => `ws://127.0.0.1:${port}`;

type Answer = (params: unknown) => unknown;

/** A daemon as `server.ts` is one: it greets a socket that says its token, answers each call, and closes a wrong token 4401. */
class Daemon {
  calls: [string, unknown][] = [];
  sockets: Socket[] = [];
  answers: Record<string, Answer> = {};
  token?: string;
  protocol = PROTOCOL_VERSION;
  said(method: string) { return this.calls.filter(([m]) => m === method).map(([, p]) => p); }
  answer(method: string, f: Answer) { this.answers[method] = f; }
  /** Every open socket closes, as one lost to a daemon that died. */
  drop() { for (const s of this.sockets) s.lost(1006); this.sockets = []; }
}

/** What listens where: a port no daemon holds takes the socket, as ssh's forward does, and closes it ungreeted. */
class Net {
  daemons = new Map<string, Daemon>();
  knocks: string[] = [];
  tokens: (string | undefined)[] = [];
  hellos: unknown[] = [];
  get WS(): typeof WebSocket {
    const net = this;
    return class extends Socket { constructor(u: string) { super(u, net); } } as unknown as typeof WebSocket;
  }
}

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  private gone = false;
  private daemon?: Daemon;
  constructor(readonly url: string, private net: Net) {
    net.knocks.push(url);
    setTimeout(() => {
      if (this.gone) return;
      this.onopen?.();
      this.daemon = net.daemons.get(url);
      if (!this.daemon) this.lost(1006);
    }, 1);
  }
  send(json: string): void {
    const m = JSON.parse(json) as { token?: string; id: number; method: string; params: unknown };
    const d = this.daemon ?? this.net.daemons.get(this.url);
    if (!d) return;
    if ('token' in m) {
      this.net.tokens.push(m.token);
      this.net.hellos.push(m);
      if (d.token !== undefined && m.token !== d.token) { setTimeout(() => this.lost(4401), 0); return; }
      d.sockets.push(this);
      setTimeout(() => this.deliver({ id: 0, result: { ok: true, protocol: d.protocol } }), 0);
      return;
    }
    d.calls.push([m.method, m.params]);
    const a = d.answers[m.method];
    void Promise.resolve().then(() => (a ? a(m.params) : {})).then(
      (result) => this.deliver({ id: m.id, result }),
      (e: ApiError) => this.deliver({ id: m.id, error: { code: e.code ?? 'internal', message: e.message, ...(e.data && { data: e.data }) } }),
    );
  }
  deliver(body: unknown): void { if (!this.gone) this.onmessage?.({ data: JSON.stringify(body) }); }
  event(e: Event): void { this.deliver(e); }
  lost(code: number): void {
    if (this.gone) return;
    this.gone = true;
    this.onclose?.({ code });
  }
  close(): void { setTimeout(() => this.lost(1000), 0); }
}

const settle = () => vi.advanceTimersByTimeAsync(5);

describe('the page follows the home while it answers, and this machine otherwise', () => {
  let store: AppStore;
  let net: Net;
  let local: Daemon;
  let home: Daemon;
  let api: FollowApi;
  let opens: number;
  let statuses: Status[];
  let events: Event[];
  let switches: number;
  let backs: number;

  const worker = () => {
    local.answer('fleet.home', () => ({ machine: HOME, name: 'studio', mine: false, me: ME }));
    local.answer('home.connection', () => CONNECTED);
  };
  const open = async () => { api.start(); await settle(); };
  const following = async () => {
    worker();
    await open();
    expect(store.getState().via?.online).toBe(true);
  };
  const asks = () => local.said('home.connection').length;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createAppStore();
    store.getState().setFleet({ ...fleet(), robots: {
      here: chr('here', 'i1', { x: 0, y: 0 }, { machine: ME }), there: chr('there', 'i1', { x: 1, y: 0 }), elsewhere: chr('elsewhere', 'i1', { x: 2, y: 0 }, { machine: OTHER }),
    } });
    net = new Net();
    local = new Daemon();
    home = new Daemon();
    home.token = TOKEN;
    net.daemons.set('ws://local', local);
    net.daemons.set(url(50_000), home);
    switches = 0;
    backs = 0;
    api = new FollowApi(new Api({ url: 'ws://local', token: 't' }, { WS: net.WS }), store, {
      makeApi: (endpoint) => new Api(endpoint, { WS: net.WS }),
      onSwitch: () => { switches++; },
      onLocalBack: () => { backs++; },
    });
    opens = 0;
    statuses = [];
    events = [];
    api.onOpen = () => { opens++; };
    api.onStatus = (s) => { statuses.push(s); };
    api.onEvent = (e) => { events.push(e); };
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a window on the home has one source and asks for no route, as ever', async () => {
    local.answer('fleet.home', () => ({ machine: ME, name: 'mac', mine: true, me: ME }));
    await open();
    expect(statuses.at(-1)).toBe('online');
    expect(opens).toBe(1);
    expect(store.getState().via).toBeUndefined();
    expect(store.getState().home).toBeUndefined();
    expect(asks()).toBe(0);
    expect(local.said('home.fallback')).toEqual([]);
    expect(switches).toBe(0);
    await api.call('state.get', {});
    expect(local.said('state.get')).toHaveLength(1);
  });

  it('opens on this machine, standing in for the home, asks once as a person would, then follows it', async () => {
    worker();
    home.protocol = PROTOCOL_VERSION;
    const held = net.daemons.get(url(50_000))!;
    net.daemons.delete(url(50_000));
    await open();
    expect(local.said('home.connection')).toEqual([{ retry: true }]);
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio' });
    expect(local.said('home.fallback').at(0)).toEqual({ on: true });
    expect(net.knocks).toContain(url(50_000));
    net.daemons.set(url(50_000), held);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio', online: true });
    expect(store.getState().home).toMatchObject({ state: 'connected', master: { ssh: 'ada@studio', controlSocket: '/tmp/m' } });
    expect(local.said('home.fallback').at(-1)).toEqual({ on: false });
    expect(opens).toBeGreaterThan(1);
    await api.call('state.get', {});
    expect(home.said('state.get')).toHaveLength(1);
  });

  it('asks with retry only on the first open: a reopen asks plainly', async () => {
    await following();
    expect(local.said('home.connection')).toEqual([{ retry: true }]);
    local.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(local.said('home.connection').at(-1)).toEqual({});
  });

  it('tells the home what this window calls it and which machine the window is on, and its own daemon neither', async () => {
    await following();
    expect(net.hellos).toEqual([{ token: 't' }, { token: TOKEN, home: 'studio', me: ME }]);
  });

  it('never keeps the home\'s token where the page stores what it knows', async () => {
    await following();
    expect(net.tokens).toContain(TOKEN);
    expect(JSON.stringify(store.getState().home)).not.toContain(TOKEN);
    expect(JSON.stringify(store.getState().via)).not.toContain(TOKEN);
  });

  it('says a window is served by its own daemon only while it is: a followed home is not', async () => {
    await following();
    expect(store.getState().via?.served).toBeUndefined();
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state: 'connected' }));
    home.drop();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getState().via).toMatchObject({ online: true, served: true });
  });

  it('says served from the start of a reopened socket, and no longer once a route has come', async () => {
    worker();
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state: 'connected' }));
    await open();
    expect(store.getState().via).toMatchObject({ online: true, served: true });
    const seen: unknown[] = [];
    const stop = store.subscribe((s) => { if (s.via?.online && !s.via.served) seen.push(s.via); });
    local.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    stop();
    expect(seen).toEqual([]);
    expect(store.getState().via).toMatchObject({ online: true, served: true });
    local.answer('home.connection', () => CONNECTED);
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(store.getState().via?.online).toBe(true);
    expect(store.getState().via?.served).toBeUndefined();
  });

  it('asks where a robot would start for its folders, and the home alone for its config', async () => {
    await following();
    const answers = (d: Daemon) => { d.answer('workspace.clones', () => ({ machine: d === home ? HOME : ME, folders: [] })); d.answer('fleet.config', () => ({ rootId: 'r:/h', path: 'fleet.json' })); };
    answers(home);
    answers(local);
    expect((await api.call('workspace.clones', {})).machine).toBe(HOME);
    await api.call('fleet.config', {});
    await api.call('fs.read', { id: 'r:/h', path: 'fleet.json' });
    expect(home.said('fleet.config')).toHaveLength(1);
    expect(home.said('fs.read')).toEqual([{ id: 'r:/h', path: 'fleet.json' }]);
    expect(local.said('workspace.clones')).toEqual([]);
    expect(local.said('fs.read')).toEqual([]);
    home.drop();
    await settle();
    expect(store.getState().via?.online).toBeUndefined();
    expect((await api.call('workspace.clones', {})).machine).toBe(ME);
  });

  it('asks this machine for what is this machine\'s, and for a robot here, wherever it follows', async () => {
    await following();
    for (const method of ['term.attach', 'fs.write', 'fs.read', 'repo.status', 'repo.watch'] as const) {
      await api.call(method, { id: 'here', path: 'a', text: '' } as never);
      expect(local.said(method)).toHaveLength(1);
      expect(home.said(method)).toHaveLength(0);
      await api.call(method, { id: 'there', path: 'a', text: '' } as never);
      expect(home.said(method)).toHaveLength(1);
      await api.call(method, { id: 'elsewhere', path: 'a', text: '' } as never);
      expect(home.said(method)).toHaveLength(2);
      expect(local.said(method)).toHaveLength(1);
    }
    await api.call('fleets.list', {});
    await api.call('fleet.stop', {});
    await api.call('feedback.preview', {});
    for (const method of ['fleets.list', 'fleet.stop', 'feedback.preview']) {
      expect(home.said(method)).toEqual([]);
      expect(local.said(method)).toHaveLength(1);
    }
    await api.call('robot.update', { id: 'here', note: 'x' });
    expect(home.said('robot.update')).toHaveLength(1);
  });

  it('events from a source it has left land nowhere, but for a watch of a robot here', async () => {
    worker();
    const held = net.daemons.get(url(50_000))!;
    net.daemons.delete(url(50_000));
    await open();
    const patch: Event = { event: 'state.patch', data: { ops: [] } };
    local.sockets[0].event(patch);
    expect(events).toEqual([patch]);
    const localSocket = local.sockets[0];
    net.daemons.set(url(50_000), held);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getState().via?.online).toBe(true);
    events.length = 0;
    localSocket.event(patch);
    expect(events).toEqual([]);
    const changed: Event = { event: 'repo.changed', data: { id: 'here' } };
    localSocket.event(changed);
    expect(events).toEqual([changed]);
    const homeSocket = home.sockets[0];
    homeSocket.event(patch);
    expect(events).toEqual([changed, patch]);
    net.daemons.delete(url(50_000));
    home.drop();
    await settle();
    events.length = 0;
    homeSocket.deliver(patch);
    expect(events).toEqual([]);
  });

  it('an answer from a source it has left lands nowhere, and so does a socket\'s plain refusal', async () => {
    worker();
    const held = net.daemons.get(url(50_000))!;
    net.daemons.delete(url(50_000));
    await open();
    let answer!: (v: unknown) => void;
    let refuse!: (e: Error) => void;
    local.answer('state.get', () => new Promise((r) => { answer = r; }));
    local.answer('robot.update', () => new Promise((_, r) => { refuse = r; }));
    const asked = api.call('state.get', {});
    const refused = api.call('robot.update', { id: 'there', note: 'x' });
    await settle();
    net.daemons.set(url(50_000), held);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getState().via?.online).toBe(true);
    answer(fleet());
    refuse(new ApiError('not_reachable', 'no'));
    await expect(asked).rejects.toBeInstanceOf(SourceLeft);
    await expect(refused).rejects.toBeInstanceOf(SourceLeft);
  });

  it('a refusal from the source it still follows stays what it is', async () => {
    await following();
    home.answer('robot.update', () => { throw new ApiError('not_found', 'no robot'); });
    await expect(api.call('robot.update', { id: 'there', note: 'x' })).rejects.toThrow('no robot');
  });

  it('a far home frozen for a move to this machine says this Mac, and names any other machine as it is', async () => {
    await following();
    home.answer('robot.update', () => { throw new ApiError('frozen', 'the fleet is moving to ada-mac; try again once it has', { to: ME }); });
    await expect(api.call('robot.update', { id: 'there', note: 'x' })).rejects.toThrow('the fleet is moving to this Mac; try again once it has');
    home.answer('robot.update', () => { throw new ApiError('frozen', 'the fleet is moving to studio2; try again once it has', { to: 'another' }); });
    await expect(api.call('robot.update', { id: 'there', note: 'x' })).rejects.toThrow('the fleet is moving to studio2');
  });

  it('a save for a robot here that lands across a switch stands, as the same daemon answered it', async () => {
    worker();
    const held = net.daemons.get(url(50_000))!;
    net.daemons.delete(url(50_000));
    await open();
    let answer!: (v: unknown) => void;
    local.answer('fs.write', () => new Promise((r) => { answer = r; }));
    const saved = api.call('fs.write', { id: 'here', path: 'a', text: 'x' } as never);
    await settle();
    net.daemons.set(url(50_000), held);
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getState().via?.online).toBe(true);
    answer({ mtimeMs: 1 });
    await expect(saved).resolves.toEqual({ mtimeMs: 1 });
  });

  it('falls back when the home goes, invalidating routes, and comes back with no reload on the port it now has', async () => {
    await following();
    const before = switches;
    local.calls.length = 0;
    net.daemons.delete(url(50_000));
    home.drop();
    await settle();
    expect(switches).toBe(before + 1);
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio' });
    expect(local.said('home.fallback')).toEqual([{ on: true }]);
    expect(statuses.at(-1)).toBe('online');
    net.daemons.set(url(50_001), home);
    local.answer('home.connection', () => ({ ...CONNECTED, port: 50_001 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(local.said('home.connection')).toEqual([{}]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(net.knocks.at(-1)).toBe(url(50_001));
    expect(store.getState().via?.online).toBe(true);
    expect(switches).toBe(before + 2);
  });

  it('a far daemon killed with its port file left says unreachable within seconds, spaces its asks, and finds it back on another port', async () => {
    await following();
    net.daemons.delete(url(50_000));
    home.drop();
    // the far connection-info still reads the old port file, and the daemon's probe finds no API behind the forward
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state: 'unreachable', detail: 'the API on studio does not answer' }));
    const before = asks();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getState().home).toMatchObject({ state: 'unreachable', detail: 'the API on studio does not answer' });
    expect(asks() - before).toBeGreaterThanOrEqual(1);
    const knocks = net.knocks.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(net.knocks).toHaveLength(knocks);
    const inFiveMinutes = asks() - before;
    expect(inFiveMinutes).toBeGreaterThan(5);
    expect(inFiveMinutes).toBeLessThan(40);
    net.daemons.set(url(50_001), home);
    local.answer('home.connection', () => ({ ...CONNECTED, port: 50_001 }));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(store.getState().via?.online).toBe(true);
    expect(store.getState().home?.state).toBe('connected');
  });

  it('a socket that keeps failing does not put off the ask that would find the home again', async () => {
    await following();
    net.daemons.delete(url(50_000));
    home.drop();
    // an answer that still says connected on the old port: the socket's own retries report offline each time
    const before = asks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asks() - before).toBeGreaterThan(3);
    net.daemons.set(url(50_001), home);
    local.answer('home.connection', () => ({ ...CONNECTED, port: 50_001 }));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(store.getState().via?.online).toBe(true);
  });

  it('re-asks after connecting, as every Try again and wake rides on', async () => {
    worker();
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state: 'connecting' }));
    await open();
    const before = asks();
    expect(store.getState().home?.state).toBe('connecting');
    local.answer('home.connection', () => CONNECTED);
    await vi.advanceTimersByTimeAsync(600);
    expect(asks()).toBe(before + 1);
    expect(store.getState().via?.online).toBe(true);
  });

  it('takes a mismatch\'s sentence with no route, and asks again only for a person', async () => {
    worker();
    const mismatch = { machine: HOME, name: 'studio', state: 'mismatch', detail: 'studio holds a different fleet than this Mac expects (x… there, y… here)' };
    local.answer('home.connection', () => mismatch);
    await open();
    expect(store.getState().home).toMatchObject({ state: 'mismatch', detail: mismatch.detail });
    expect(net.knocks).not.toContain(url(50_000));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asks()).toBe(1);
  });

  it('goes from following to a mismatch: its socket stops, the sentence stands, and the page stays on this machine', async () => {
    await following();
    const mismatch = { machine: HOME, name: 'studio', state: 'mismatch', detail: 'studio holds a different fleet than this Mac expects (x… there, y… here)' };
    local.answer('home.connection', () => mismatch);
    net.daemons.delete(url(50_000));
    home.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getState().home).toMatchObject({ state: 'mismatch', detail: mismatch.detail });
    expect(store.getState().via?.online).toBeUndefined();
    const knocks = net.knocks.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.knocks).toHaveLength(knocks);
  });

  it.each(['auth', 'version'])('asks nothing again by itself after %s, and does for a person', async (state) => {
    worker();
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state }));
    await open();
    expect(store.getState().home?.state).toBe(state);
    const before = asks();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(asks()).toBe(before);
    expect(net.knocks).not.toContain(url(50_000));
    local.answer('home.connection', () => CONNECTED);
    api.retryHome();
    await settle();
    expect(local.said('home.connection').at(-1)).toEqual({ retry: true });
    expect(store.getState().via?.online).toBe(true);
  });

  it('keeps the release a version answer names, which the card\'s words go by', async () => {
    worker();
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state: 'version', release: '0.20', detail: 'studio runs an older Svall than this Mac (0.20, here 0.21); upgrade it to reach its robots' }));
    await open();
    expect(store.getState().home).toMatchObject({ state: 'version', release: '0.20' });
  });

  it('stops knocking on a home on another protocol, stays on this machine, and a person asks again', async () => {
    home.protocol = PROTOCOL_VERSION + 1;
    worker();
    await open();
    expect(store.getState().home?.state).toBe('version');
    expect(store.getState().via?.online).toBeUndefined();
    const before = asks();
    const knocks = net.knocks.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(asks()).toBe(before);
    expect(net.knocks).toHaveLength(knocks);
    expect(statuses.at(-1)).toBe('online');
  });

  it('a home that closed each socket and then answers on another protocol says only that, also when a person asks again', async () => {
    worker();
    const held = net.daemons.get(url(50_000))!;
    net.daemons.delete(url(50_000));
    await open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().home).toMatchObject({ state: 'unreachable', detail: 'the API on studio answers, and closes this window\'s socket' });
    held.protocol = PROTOCOL_VERSION + 1;
    net.daemons.set(url(50_000), held);
    await vi.advanceTimersByTimeAsync(60_000);
    const found = { name: 'studio', state: 'version', release: '0.21', master: { ssh: 'ada@studio', controlSocket: '/tmp/m' } };
    expect(store.getState().home).toEqual(found);
    api.retryHome();
    await settle();
    expect(store.getState().home).toEqual(found);
  });

  it('a home that closes a wrong token is asked for the right one, with no word of a refused login', async () => {
    home.token = 'another';
    worker();
    await open();
    expect(store.getState().home?.state).toBe('connecting');
    home.token = TOKEN;
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getState().via?.online).toBe(true);
  });

  it('asks the shell again when its own daemon goes, and goes on following a home whose socket stands', async () => {
    const lost: Status[] = [];
    api.onLocalLost = (s) => lost.push(s);
    await following();
    statuses.length = 0;
    net.daemons.delete('ws://local');
    local.drop();
    await settle();
    expect(lost).toEqual(['offline']);
    expect(statuses).not.toContain('offline');
    await api.call('robot.update', { id: 'there', note: 'x' });
    expect(home.said('robot.update')).toHaveLength(1);
  });

  it('offers the home\'s token to no port while its own daemon is down, and follows again from its next answer', async () => {
    await following();
    net.daemons.delete('ws://local');
    local.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    // just past a failed open of this machine's socket, whose next report is seconds off
    const opened = net.knocks.filter((k) => k === 'ws://local').length;
    while (net.knocks.filter((k) => k === 'ws://local').length === opened) await vi.advanceTimersByTimeAsync(50);
    await settle();
    net.daemons.delete(url(50_000));
    home.drop();
    await settle();
    const knocks = net.knocks.filter((k) => k === url(50_000)).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.knocks.filter((k) => k === url(50_000))).toHaveLength(knocks);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(net.knocks.filter((k) => k === url(50_000))).toHaveLength(knocks);
    expect(store.getState().via?.online).toBeUndefined();
    net.daemons.set('ws://local', local);
    net.daemons.set(url(50_000), home);
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.getState().via?.online).toBe(true);
  });

  it('with its own daemon lost while the home\'s socket is not up, that socket goes at once', async () => {
    worker();
    const held = net.daemons.get(url(50_000))!;
    net.daemons.delete(url(50_000));
    await open();
    expect(store.getState().via?.online).toBeUndefined();
    net.daemons.delete('ws://local');
    local.drop();
    await settle();
    const knocks = net.knocks.filter((k) => k === url(50_000)).length;
    net.daemons.set(url(50_000), held);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(net.knocks.filter((k) => k === url(50_000))).toHaveLength(knocks);
  });

  it('a reconnect of this machine\'s socket while it follows the home sends this machine\'s watches again', async () => {
    await following();
    expect(backs).toBe(0);
    local.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(backs).toBe(1);
    expect(store.getState().via?.online).toBe(true);
  });

  it('a fleet.home that goes unanswered keeps the home it follows, and is asked again', async () => {
    await following();
    local.answer('fleet.home', () => new Promise(() => {}));
    const before = local.said('fleet.home').length;
    local.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(local.said('fleet.home').length).toBe(before + 1);
    expect(store.getState().via?.online).toBe(true);
    expect(store.getState().home?.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().via?.online).toBe(true);
    await api.call('robot.update', { id: 'there', note: 'x' });
    expect(home.said('robot.update')).toHaveLength(1);
    worker();
    await vi.advanceTimersByTimeAsync(6000);
    expect(local.said('fleet.home').length).toBeGreaterThan(before + 1);
  });

  it('a fleet.home lost to a closed socket does not read this machine as online', async () => {
    worker();
    let answered = 0;
    local.answer('fleet.home', () => { answered++; return new Promise(() => {}); });
    await open();
    net.daemons.delete('ws://local');
    local.drop();
    await settle();
    expect(answered).toBe(1);
    expect(statuses.at(-1)).toBe('offline');
    await expect(api.call('state.get', {})).rejects.toThrow('svalld offline');
  });

  it('a daemon that answers it names no home is a home of its own, and is not asked again', async () => {
    local.answer('fleet.home', () => { throw new ApiError('not_found', 'this daemon names no home'); });
    await open();
    expect(statuses.at(-1)).toBe('online');
    expect(store.getState().via).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(local.said('fleet.home')).toHaveLength(1);
  });

  it('a daemon enrolled meanwhile under another home leaves nothing to follow of the old one', async () => {
    await following();
    const stale = home.sockets[0];
    const closed = vi.spyOn(stale, 'close');
    local.answer('fleet.home', () => ({ machine: OTHER, name: 'other', mine: false, me: ME }));
    local.answer('home.connection', () => new Promise(() => {}));
    local.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(closed).toHaveBeenCalled();
    expect(store.getState().via).toEqual({ machine: ME, home: OTHER, name: 'other' });
    expect(store.getState().home?.name).toBe('other');
  });

  it('follows only the home its own daemon names: one that calls itself the home ends the following', async () => {
    await following();
    const stale = home.sockets[0];
    const closed = vi.spyOn(stale, 'close');
    local.answer('fleet.home', () => ({ machine: ME, name: 'mac', mine: true, me: ME }));
    local.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(closed).toHaveBeenCalled();
    expect(store.getState().via).toBeUndefined();
    expect(store.getState().home).toBeUndefined();
  });

  it('a socket that keeps failing though the daemon says connected turns into a banner', async () => {
    worker();
    net.daemons.delete(url(50_000));
    await open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().home).toMatchObject({ state: 'unreachable', detail: expect.stringContaining('studio') });
    net.daemons.set(url(50_000), home);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(store.getState().via?.online).toBe(true);
    expect(store.getState().home?.state).toBe('connected');
  });

  it('a socket that closes knocks on its port again only from an answer that says so', async () => {
    await following();
    local.answer('home.connection', () => new Promise(() => {}));
    net.daemons.delete(url(50_000));
    const knocks = net.knocks.length;
    home.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(net.knocks).toHaveLength(knocks);
  });

  it('a daemon that names its home only on a later try tells the daemon the window stands in, and asks with retry', async () => {
    worker();
    let first = true;
    local.answer('fleet.home', () => {
      if (first) { first = false; return new Promise(() => {}); }
      return { machine: HOME, name: 'studio', mine: false, me: ME };
    });
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state: 'auth' }));
    await open();
    await vi.advanceTimersByTimeAsync(36_000);
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio' });
    expect(local.said('home.fallback').at(-1)).toEqual({ on: true });
    expect(local.said('home.connection')[0]).toEqual({ retry: true });
  });

  it('a daemon that refuses to say gives a banner rather than asking in silence', async () => {
    worker();
    local.answer('home.connection', () => { throw new ApiError('invalid_config', 'worker.json is gone'); });
    await open();
    expect(store.getState().home).toMatchObject({ state: 'unreachable', detail: 'worker.json is gone' });
  });

  it('an answer that lands after the daemon said it is the home is dropped', async () => {
    worker();
    let answer!: (v: unknown) => void;
    local.answer('home.connection', () => new Promise((r) => { answer = r; }));
    await open();
    local.answer('fleet.home', () => ({ machine: ME, name: 'mac', mine: true, me: ME }));
    local.drop();
    await vi.advanceTimersByTimeAsync(600);
    answer(CONNECTED);
    await settle();
    expect(store.getState().home).toBeUndefined();
    expect(net.knocks).not.toContain(url(50_000));
  });

  describe('a home that dials this machine, which gives no route', () => {
    const dialed = (state: string) => () => ({ machine: HOME, name: 'studio', state });

    it('reads as the linked home the daemon here serves, with no banner state and no fallback', async () => {
      worker();
      local.answer('home.connection', dialed('connected'));
      await open();
      expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio', online: true, served: true });
      expect(store.getState().home?.state).toBe('connected');
      expect(local.said('home.fallback').at(-1)).toEqual({ on: false });
      await api.call('robot.update', { id: 'there', note: 'x' });
      expect(local.said('robot.update')).toHaveLength(1);
    });

    it('stays online through a reopen of its own socket', async () => {
      worker();
      local.answer('home.connection', dialed('connected'));
      await open();
      local.answer('home.connection', () => new Promise(() => {}));
      local.drop();
      await vi.advanceTimersByTimeAsync(600);
      expect(store.getState().via?.online).toBe(true);
    });

    it('falls back when that link goes, and is back when it returns', async () => {
      worker();
      local.answer('home.connection', dialed('connected'));
      await open();
      local.answer('home.connection', dialed('unreachable'));
      await vi.advanceTimersByTimeAsync(16_000);
      expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio' });
      expect(store.getState().home?.state).toBe('unreachable');
      expect(local.said('home.fallback').at(-1)).toEqual({ on: true });
      local.answer('home.connection', dialed('connected'));
      await vi.advanceTimersByTimeAsync(16_000);
      expect(store.getState().via?.online).toBe(true);
      expect(local.said('home.fallback').at(-1)).toEqual({ on: false });
    });
  });
});
