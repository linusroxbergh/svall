import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, MachineId, MethodName, Params, Result } from '@svall/protocol';
import { Api, type Status } from '../src/api.js';
import { FollowApi } from '../src/sources.js';
import { createAppStore, type AppStore } from '../src/store/index.js';
import { chr, fleet } from './fixtures.js';

const ME = '11111111-1111-4111-8111-111111111111' as MachineId;
const HOME = '22222222-2222-4222-8222-222222222222' as MachineId;
const TOKEN = 'the-homes-token';
const CONNECTED = { machine: HOME, name: 'studio', state: 'connected', ssh: 'ada@studio', controlSocket: '/tmp/m', port: 50_000, token: TOKEN, release: '0.21' };

type Answers = Record<string, (params: unknown) => unknown>;

class FakeApi extends Api {
  calls: [string, unknown][] = [];
  started = 0;
  stops = 0;
  endpoints: unknown[] = [];
  constructor(private answers: Answers = {}) { super({ url: 'ws://fake' }); }
  override start(): void { this.started++; }
  override stop(): void { this.stops++; }
  override setEndpoint(e: Parameters<Api['setEndpoint']>[0]): void { this.endpoints.push(e); }
  override call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    this.calls.push([method, params]);
    const a = this.answers[method];
    return Promise.resolve(a ? a(params) : {}) as Promise<Result<M>>;
  }
  said(method: string) { return this.calls.filter(([m]) => m === method).map(([, p]) => p); }
  answer(method: string, f: (params: unknown) => unknown) { this.answers[method] = f; }
  come(): void { this.onStatus('online'); this.onOpen(); }
  go(s: Status = 'offline'): void { this.onStatus(s); }
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the page follows the home while it answers, and this machine otherwise', () => {
  let store: AppStore;
  let local: FakeApi;
  let home: FakeApi;
  let api: FollowApi;
  let opens: number;
  let statuses: Status[];
  let events: Event[];
  let switches: number;

  const worker = () => {
    local.answer('fleet.home', () => ({ machine: HOME, name: 'studio', mine: false, me: ME }));
    local.answer('home.connection', () => CONNECTED);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = createAppStore();
    store.getState().setFleet({ ...fleet(), robots: { here: chr('here', 'i1', { x: 0, y: 0 }, { machine: ME }), there: chr('there', 'i1', { x: 1, y: 0 }) } });
    local = new FakeApi();
    home = new FakeApi();
    switches = 0;
    api = new FollowApi(local, store, { makeApi: () => home, onSwitch: () => { switches++; } });
    opens = 0;
    statuses = [];
    events = [];
    api.onOpen = () => { opens++; };
    api.onStatus = (s) => { statuses.push(s); };
    api.onEvent = (e) => { events.push(e); };
    api.start();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a window on the home has one source and asks for no route, as ever', async () => {
    local.answer('fleet.home', () => ({ machine: ME, name: 'mac', mine: true, me: ME }));
    local.come();
    await settle();
    expect(statuses.at(-1)).toBe('online');
    expect(opens).toBe(1);
    expect(store.getState().via).toBeUndefined();
    expect(store.getState().home).toBeUndefined();
    expect(local.said('home.connection')).toEqual([]);
    expect(local.said('home.fallback')).toEqual([]);
    expect(switches).toBe(0);
    await api.call('state.get', {});
    expect(local.said('state.get')).toHaveLength(1);
  });

  it('opens on this machine, standing in for the home, asks once as a person would, then follows it', async () => {
    worker();
    local.come();
    await settle();
    expect(local.said('home.connection')).toEqual([{ retry: true }]);
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio' });
    expect(local.said('home.fallback').at(0)).toEqual({ on: true });
    expect(home.started).toBe(1);
    home.come();
    await settle();
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio', online: true });
    expect(store.getState().home).toMatchObject({ state: 'connected', master: { ssh: 'ada@studio', controlSocket: '/tmp/m' } });
    expect(local.said('home.fallback').at(-1)).toEqual({ on: false });
    expect(opens).toBeGreaterThan(1);
    await api.call('state.get', {});
    expect(home.said('state.get')).toHaveLength(1);
  });

  it('never keeps the home\'s token where the page stores what it knows', async () => {
    worker();
    local.come();
    await settle();
    home.come();
    await settle();
    expect(JSON.stringify(store.getState().home)).not.toContain(TOKEN);
    expect(JSON.stringify(store.getState().via)).not.toContain(TOKEN);
  });

  it('asks this machine for what is this machine\'s, and for a robot here, wherever it follows', async () => {
    worker();
    local.come();
    await settle();
    home.come();
    await settle();
    for (const method of ['term.attach', 'fs.write', 'fs.read', 'repo.status', 'repo.watch'] as const) {
      await api.call(method, { id: 'here', path: 'a', text: '' } as never);
      expect(local.said(method)).toHaveLength(1);
      await api.call(method, { id: 'there', path: 'a', text: '' } as never);
      expect(home.said(method)).toHaveLength(1);
    }
    await api.call('fleets.list', {});
    await api.call('fleet.stop', {});
    expect(home.said('fleets.list')).toEqual([]);
    expect(home.said('fleet.stop')).toEqual([]);
    expect(local.said('fleet.stop')).toHaveLength(1);
    await api.call('robot.update', { id: 'here', note: 'x' });
    expect(home.said('robot.update')).toHaveLength(1);
  });

  it('events from a source it has left land nowhere, but for a watch of a robot here', async () => {
    worker();
    local.come();
    await settle();
    const patch: Event = { event: 'state.patch', data: { ops: [] } };
    local.onEvent(patch);
    expect(events).toEqual([patch]);
    home.come();
    await settle();
    events.length = 0;
    local.onEvent(patch);
    expect(events).toEqual([]);
    const changed: Event = { event: 'repo.changed', data: { id: 'here' } };
    local.onEvent(changed);
    expect(events).toEqual([changed]);
    home.onEvent(patch);
    expect(events).toEqual([changed, patch]);
    home.go();
    await settle();
    events.length = 0;
    home.onEvent(patch);
    expect(events).toEqual([]);
  });

  it('an answer from a source it has left lands nowhere', async () => {
    worker();
    local.come();
    await settle();
    let answer!: (v: unknown) => void;
    local.answer('state.get', () => new Promise((r) => { answer = r; }));
    const asked = api.call('state.get', {});
    await settle();
    home.come();
    await settle();
    answer(fleet());
    await expect(asked).rejects.toThrow('svalld connection closed');
  });

  it('falls back when the home goes, invalidating routes, and comes back with no reload on the port it now has', async () => {
    worker();
    local.come();
    await settle();
    home.come();
    await settle();
    const before = switches;
    local.calls.length = 0;
    home.go();
    await settle();
    expect(switches).toBe(before + 1);
    expect(store.getState().via).toEqual({ machine: ME, home: HOME, name: 'studio' });
    expect(local.said('home.fallback')).toEqual([{ on: true }]);
    expect(statuses.at(-1)).toBe('online');
    local.answer('home.connection', () => ({ ...CONNECTED, port: 50_001 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(local.said('home.connection')).toEqual([{}]);
    expect(home.endpoints).toEqual([{ url: 'ws://127.0.0.1:50001', token: TOKEN }]);
    home.come();
    await settle();
    expect(store.getState().via?.online).toBe(true);
    expect(switches).toBe(before + 2);
  });

  it('spaces out its asks while the home stays down, and takes a mismatch\'s sentence with no route', async () => {
    worker();
    const mismatch = { machine: HOME, name: 'studio', state: 'unreachable', detail: 'studio answered with fleetId x' };
    local.answer('home.connection', () => mismatch);
    local.come();
    await settle();
    expect(store.getState().home).toMatchObject({ state: 'unreachable', detail: mismatch.detail });
    expect(home.started).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const asks = local.said('home.connection').length;
    expect(asks).toBeGreaterThan(1);
    expect(asks).toBeLessThan(10);
  });

  it.each(['auth', 'version'])('asks nothing again by itself after %s, and does for a person', async (state) => {
    worker();
    local.answer('home.connection', () => ({ machine: HOME, name: 'studio', state }));
    local.come();
    await settle();
    expect(store.getState().home?.state).toBe(state);
    const asks = local.said('home.connection').length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(local.said('home.connection')).toHaveLength(asks);
    expect(home.started).toBe(0);
    local.answer('home.connection', () => CONNECTED);
    api.retryHome();
    await settle();
    expect(local.said('home.connection').at(-1)).toEqual({ retry: true });
    expect(home.started).toBe(1);
  });

  it('stops knocking on a home on another protocol, stays on this machine, and a person asks again', async () => {
    worker();
    local.come();
    await settle();
    home.go('outdated');
    await settle();
    expect(home.stops).toBe(1);
    expect(store.getState().home?.state).toBe('version');
    expect(store.getState().via?.online).toBeUndefined();
    const asks = local.said('home.connection').length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(local.said('home.connection')).toHaveLength(asks);
    expect(statuses.at(-1)).toBe('online');
  });

  it('asks the shell again when its own daemon goes, and goes on following the home', async () => {
    const lost: Status[] = [];
    api.onLocalLost = (s) => lost.push(s);
    worker();
    local.come();
    await settle();
    home.come();
    await settle();
    statuses.length = 0;
    local.go();
    await settle();
    expect(lost).toEqual(['offline']);
    expect(statuses).not.toContain('offline');
    await api.call('robot.update', { id: 'there', note: 'x' });
    expect(home.said('robot.update')).toHaveLength(1);
  });

  it('falls back to no daemon that does not say it serves this home: one that calls itself the home ends the following', async () => {
    worker();
    local.come();
    await settle();
    home.come();
    await settle();
    local.answer('fleet.home', () => ({ machine: ME, name: 'mac', mine: true, me: ME }));
    local.come();
    await settle();
    expect(home.stops).toBe(1);
    expect(store.getState().via).toBeUndefined();
    expect(store.getState().home).toBeUndefined();
  });
});
