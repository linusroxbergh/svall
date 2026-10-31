import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MobileStatus, SetupRow } from '@svall/protocol';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { silentLogger } from '../../src/log.js';
import { readConsent, setConsent } from '../../src/placement/mirror-consent.js';
import { PhoneFallbacks } from '../../src/placement/phone.js';
import { PushStore } from '../../src/push/store.js';
import type { Tmux } from '../../src/tmux/tmux.js';
import { WorkerPhone } from '../../src/worker/phone.js';
import { H, W, placed, stopWorlds, until, world } from './world.js';

afterEach(stopWorlds);

const MAC = 'https://mac.tailnet.ts.net:8443/';
const FAR = 'https://w1.tailnet.ts.net:8443/';
const VAPID = { publicKey: 'pub', privateKey: 'priv' };
const SUB = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked' as const], login: 'me@example.com', addedAt: 1 };
const status = (o: Partial<MobileStatus> = {}): MobileStatus => ({ serving: true, url: MAC, port: 8443, logins: ['me@example.com'], phones: [], ...o });

/** The home's phone link as tailscale shows it, and w1's own, which serves on its first on unless tailscale refuses it. */
function phones(w: ReturnType<typeof world>) {
  const mac = { status: status() };
  const push = new PushStore(path.join(w.home.paths.home, 'push.json'), () => {});
  const fallbacks = new PhoneFallbacks({
    me: H, file: w.home.paths.phoneFallbacks, consent: w.home.paths.mirrorConsent, store: w.home.store, links: w.home.links,
    mobile: { get: async () => mac.status, logins: () => ['me@example.com'] }, vapid: VAPID, push, log: silentLogger,
  });
  const far = { serving: false, sets: [] as boolean[], refuse: undefined as string | undefined };
  const workerPhone = new WorkerPhone({
    file: w.worker.paths.phone, pass: 'far-pass', log: () => {},
    link: () => ({
      get: async () => status({ url: FAR, serving: far.serving }),
      set: async (on) => {
        far.sets.push(on);
        far.serving = on && !far.refuse;
        return status({ url: FAR, serving: far.serving, ...(on && far.refuse && { error: far.refuse }) });
      },
      served: () => (far.serving ? FAR : undefined),
    }),
  });
  w.worker.handlers['phone.set'] = (p) => workerPhone.set(p);
  // the parts of the home's mirror machines.consent and machines.setup read
  const mirror = {
    consent: (m: typeof W, item: string, fields: string[], on: boolean) => setConsent(w.home.paths.mirrorConsent, m, item, fields, on),
    report: async (): Promise<SetupRow[]> => [], unreadFile: () => undefined,
  };
  // the Mac's own switch, which turns its link over as tailscale then shows it
  const mobile = { get: async () => mac.status, set: async (on: boolean) => (mac.status = status({ serving: on })) };
  const ctx = { ...w.home.ctx, phone: fallbacks, mirror, mobile, push } as unknown as Ctx;
  const tick = (on: boolean) => dispatch({ id: 1, method: 'machines.consent', params: { machine: W, item: 'phone', fields: ['on'], on } }, ctx);
  return { mac, push, fallbacks, far, workerPhone, ctx, tick };
}

const listed = { home: H, fallbacks: [{ machine: W, name: 'w1', url: FAR, pass: 'far-pass' }] };

describe('a worker serving the phone', () => {
  it('serves once ticked, with the home\'s logins, origin, push keys and devices, and the home lists its link and pass to the phone alone', async () => {
    const w = world({});
    const p = phones(w);
    p.push.upsert(SUB);
    await w.link();
    expect(p.fallbacks.row(W)).toMatchObject({ key: 'phone', status: 'skip', tick: { item: 'phone', fields: ['on'], on: false } });
    expect(p.fallbacks.row(W).gap).toBeUndefined();

    const rows = await p.tick(true);
    expect(rows).toMatchObject({ result: { rows: [{ key: 'phone', status: 'ok', detail: expect.stringContaining(FAR), tick: { on: true } }] } });
    expect(readConsent(w.home.paths.mirrorConsent, W)).toEqual(new Set(['phone#on']));
    expect(JSON.parse(fs.readFileSync(w.worker.paths.phone, 'utf8'))).toEqual({
      on: true, logins: ['me@example.com'], origin: 'https://mac.tailnet.ts.net:8443', vapid: VAPID, subscriptions: [SUB],
    });
    expect(fs.statSync(w.worker.paths.phone).mode & 0o777).toBe(0o600);
    expect(fs.statSync(w.home.paths.phoneFallbacks).mode & 0o777).toBe(0o600);
    expect(p.fallbacks.serves(W)).toBe(true);

    expect(await dispatch({ id: 2, method: 'mobile.fallbacks', params: {} }, p.ctx)).toEqual({ id: 2, result: listed });
    expect(await dispatch({ id: 3, method: 'mobile.fallbacks', params: {} }, w.worker.ctx)).toMatchObject({ id: 3, error: { code: 'not_on_worker' } });
    for (const store of [w.home.store, w.worker.store]) expect(JSON.stringify(store.state)).not.toContain('far-pass');

    // a new device reaches the worker with the next sync, and the link stays as it was
    p.push.upsert({ ...SUB, endpoint: 'https://push.example/b' });
    await p.fallbacks.syncAll();
    expect(p.workerPhone.list().map((s) => s.endpoint)).toEqual(['https://push.example/a', 'https://push.example/b']);
    expect(p.far.sets).toEqual([true]);
  });

  it('stops serving once the Mac\'s own link is off or the tick is, through no look at it that fails, and serves again with the same pass', async () => {
    const w = world({});
    const p = phones(w);
    await w.link();
    await p.tick(true);

    p.mac.status = status({ serving: false, url: '', error: 'tailscale is not connected (Stopped)' });
    await p.fallbacks.syncAll();
    expect([p.workerPhone.on, p.fallbacks.fallbacks()]).toEqual([true, listed]);

    await dispatch({ id: 1, method: 'mobile.set', params: { enabled: false } }, p.ctx);
    await until(() => expect([p.workerPhone.on, p.far.sets, p.fallbacks.fallbacks().fallbacks, p.fallbacks.serves(W)]).toEqual([false, [true, false], [], false]));
    expect(fs.existsSync(w.worker.paths.phone)).toBe(false);

    await dispatch({ id: 1, method: 'mobile.set', params: { enabled: true } }, p.ctx);
    await until(() => expect(p.fallbacks.fallbacks()).toEqual(listed));

    await p.tick(false);
    expect([p.workerPhone.on, p.far.sets, p.fallbacks.fallbacks().fallbacks]).toEqual([false, [true, false, true, false], []]);
  });

  it('says why a worker does not serve, with the command a tailscale that refuses this user needs', async () => {
    const w = world({});
    const p = phones(w);
    await w.link();
    p.far.refuse = 'sending serve config: Access denied: serve config denied';
    await p.tick(true);
    expect(p.fallbacks.row(W)).toMatchObject({
      key: 'phone', status: 'warn', detail: expect.stringContaining('Access denied'), action: 'sudo tailscale set --operator=$USER', gap: { name: 'phone' },
    });
    expect(p.fallbacks.fallbacks().fallbacks).toEqual([]);
    p.far.refuse = 'tailscale is not connected (Stopped)';
    await p.fallbacks.sync(W);
    expect(p.fallbacks.row(W)).toMatchObject({ status: 'warn', action: 'check w1 again' });
  });

  it('tells a worker again after a sync to it failed', async () => {
    const w = world({});
    const p = phones(w);
    await w.link();
    setConsent(w.home.paths.mirrorConsent, W, 'phone', ['on'], true);
    w.worker.handlers['phone.set'] = () => Promise.reject(new Error('disk full'));
    await p.fallbacks.sync(W);
    w.worker.handlers['phone.set'] = (raw) => p.workerPhone.set(raw);
    await p.fallbacks.sync(W);
    expect(p.fallbacks.fallbacks()).toEqual(listed);
  });

  it('waits for a worker that is not linked, which takes the tick once it links', async () => {
    const w = world({});
    const p = phones(w);
    setConsent(w.home.paths.mirrorConsent, W, 'phone', ['on'], true);
    await p.fallbacks.sync(W);
    expect(p.fallbacks.row(W)).toMatchObject({ status: 'skip', tick: { on: true } });
    await w.link();
    await p.fallbacks.sync(W);
    expect(p.fallbacks.fallbacks()).toEqual(listed);
  });
});

describe('a phone on a worker whose home is away', () => {
  const pane = { windowId: '@1', paneId: '%1' };
  const phone: Ctx['viewer'] = { kind: 'phone', login: 'me@example.com', send: () => {}, backlog: () => 0 };

  it('reads, types into and answers a robot that runs there without its home, which answers none of it', async () => {
    const typed: string[] = [];
    const tmux: Partial<Tmux> = {
      capture: async () => Buffer.from('the pane'),
      sendBytes: async (_pane: string, data: Buffer) => { typed.push(data.toString()); },
    };
    const w = world({ worker: { robots: { c_1: placed({ id: 'c_1', tmux: pane }), c_2: placed({ id: 'c_2' }) } }, tmux });
    const call = (method: string, params: object) => dispatch({ id: 1, method, params }, { ...w.worker.ctx, viewer: phone, terminals: w.worker.terminals } as Ctx);
    expect(await call('term.lastScreen', { id: 'c_1' })).toMatchObject({ result: { text: 'the pane', at: expect.any(Number) } });
    expect(await call('term.lastScreen', { id: 'c_2' })).toEqual({ id: 1, result: { text: '' } });
    expect(await call('term.input', { id: 'c_1', data: Buffer.from('y').toString('base64') })).toEqual({ id: 1, result: {} });
    expect(typed).toEqual(['y']);
    expect(await call('robot.answer', { id: 'c_1', answer: 'approve' })).toMatchObject({ error: { message: 'c_1 is not waiting on an answer' } });
  });

  it('serves a phone\'s run and update there, linked or not, where another caller\'s go home while linked', async () => {
    const c_1 = placed({ id: 'c_1', tmux: pane });
    const w = world({ home: { robots: { c_1 } }, worker: { robots: { c_1 } } });
    await w.link();
    await until(() => expect(w.worker.mutations.serves('robot.run', { id: 'c_1' })).toBe(false));
    expect(w.worker.mutations.serves('robot.run', { id: 'c_1' }, true)).toBe(true);
    expect(w.worker.mutations.serves('robot.update', { id: 'c_1' }, true)).toBe(true);
  });

  it('answers push.key and push.get from the home\'s keys and devices its phone.json holds, and neither before it holds one', async () => {
    const w = world({});
    const p = phones(w);
    const ctx = { ...w.worker.ctx, workerPhone: p.workerPhone } as Ctx;
    expect(await dispatch({ id: 1, method: 'push.key', params: {} }, ctx)).toMatchObject({ error: { code: 'not_on_worker' } });
    await p.workerPhone.set({ on: true, logins: ['me@example.com'], origin: 'https://mac.tailnet.ts.net:8443', vapid: VAPID, subscriptions: [SUB] });
    expect(await dispatch({ id: 1, method: 'push.key', params: {} }, ctx)).toEqual({ id: 1, result: { publicKey: 'pub' } });
    expect(await dispatch({ id: 1, method: 'push.get', params: { endpoint: SUB.endpoint } }, ctx)).toEqual({ id: 1, result: { statuses: ['blocked'] } });
  });
});
