import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event, PushStatus } from '@svall/protocol';
import type { Api } from '../src/api.js';
import { sections, subtitle, waiting } from '../src/mobile/list.js';
import { encode, linkTerminal, type Screen } from '../src/mobile/term.js';
import { parseRoute, routePath } from '../src/mobile/route.js';
import { NO_PAGE, OFF, phonesHere } from '../src/phoneText.js';
import { chr, fleet, isl } from './fixtures.js';
import { cwdChoices, islandCwd } from '../src/mobile/choices.js';
import { disablePush, enablePush, keyBytes, needsInstall, readPush, sameApplicationServerKey, setPushStatuses, subscriptionParams } from '../src/mobile/push.js';
import { dragOffset, isSwipe, REVEAL, settle } from '../src/mobile/swipe.js';
import { dragToScroll, holdScroll, lineSteps, type TouchSurface } from '../src/mobile/scroll.js';

type TermEvent = Extract<Event, { event: `term.${string}` }>;

const b64 = (s: string) => encode(new TextEncoder().encode(s));

function harness() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const handlers = new Set<(e: TermEvent) => void>();
  let painted = '';
  const screen = {
    cols: 41, rows: 24,
    write: (b: Uint8Array) => { painted += new TextDecoder().decode(b); },
    reset: () => { painted = ''; },
  } satisfies Screen;
  const api = {
    call: (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return Promise.resolve({ screen: b64('seed') }); },
    fire: (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); },
  } as unknown as Api;
  const link = linkTerminal({ api, subscribe: (h) => { handlers.add(h); return () => handlers.delete(h); } }, 'c1', screen);
  const emit = (e: TermEvent) => { for (const h of [...handlers]) h(e); };
  return { link, calls, emit, size: screen, screen: () => painted, viewers: () => handlers.size };
}

describe('phone terminal', () => {
  it('opens at the screen size, then streams output onto it', async () => {
    const h = harness();
    await h.link.open();
    expect(h.calls[0]).toEqual({ method: 'term.open', params: { id: 'c1', cols: 41, rows: 24, lines: 2000 } });
    expect(h.screen()).toBe('seed');
    h.emit({ event: 'term.output', data: { id: 'c1', data: b64('+more') } });
    expect(h.screen()).toBe('seed+more');
  });

  it('sends a size the screen settled on while the open ran, and none when it held still', async () => {
    const h = harness();
    const opening = h.link.open();
    h.size.cols = 50;
    await opening;
    expect(h.calls.slice(1)).toEqual([{ method: 'term.resize', params: { id: 'c1', cols: 50, rows: 24 } }]);
    const still = harness();
    await still.link.open();
    expect(still.calls.map((c) => c.method)).toEqual(['term.open']);
  });

  it('ignores frames for another character', async () => {
    const h = harness();
    await h.link.open();
    h.emit({ event: 'term.output', data: { id: 'c9', data: b64('elsewhere') } });
    expect(h.screen()).toBe('seed');
  });

  it('repaints from scratch on resync', async () => {
    const h = harness();
    await h.link.open();
    h.emit({ event: 'term.output', data: { id: 'c1', data: b64('stale') } });
    h.emit({ event: 'term.resync', data: { id: 'c1', screen: b64('fresh') } });
    expect(h.screen()).toBe('fresh');
  });

  it('reopening after a reconnect repaints and leaves one subscription behind', async () => {
    const h = harness();
    await h.link.open();
    h.emit({ event: 'term.output', data: { id: 'c1', data: b64('before lock') } });
    await h.link.open();
    expect(h.screen()).toBe('seed');
    expect(h.viewers()).toBe(1);
  });

  it('sends keys and sizes as the daemon expects, and stops on close', async () => {
    const h = harness();
    await h.link.open();
    h.link.input('\x03');
    h.link.resize();
    h.link.close();
    expect(h.calls.slice(1)).toEqual([
      { method: 'term.input', params: { id: 'c1', data: b64('\x03') } },
      { method: 'term.resize', params: { id: 'c1', cols: 41, rows: 24 } },
      { method: 'term.close', params: { id: 'c1' } },
    ]);
    h.emit({ event: 'term.output', data: { id: 'c1', data: b64('after') } });
    expect(h.screen()).toBe('seed');
  });
});

describe('phone fleet list', () => {
  it('leads with the island whose crew needs the user, and lists empty islands last', () => {
    const f = fleet();
    f.islands.i_z = isl('i_z', 'zulu', 24);
    f.characters.c3 = chr('c3', 'i_z', { x: 1, y: 1 }, { agent: { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'blocked', lastActivityAt: 0 } });
    const groups = sections(f);
    expect(groups.map((g) => g.island.name)).toEqual(['zulu', 'alpha', 'beta', 'empty', 'mission control']);
    expect(groups[3].characters).toEqual([]);
    expect(groups[0].characters.map((c) => c.id)).toEqual(['c3']);
    expect(waiting(f)).toBe(1);
  });

  it("puts a character's own note under its name, on one line, and nothing when there is none", () => {
    expect(subtitle(chr('c', 'i_b', { x: 0, y: 0 }, { note: 'fix the login\n\nsee the PR ' }))).toBe('fix the login · see the PR');
    const noteless = chr('c', 'i_b', { x: 0, y: 0 }, {
      agent: { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'idle', brief: '# Svall context', lastActivityAt: 0 },
      repo: { root: '/r', mainRoot: '/r', branch: 'main', isWorktree: false },
    });
    expect(subtitle(noteless)).toBe('');
  });
});

describe('phone routes', () => {
  it('reads a character out of the path and writes it back', () => {
    expect(parseRoute('/')).toEqual({ view: 'fleet' });
    expect(parseRoute('/char/c_ab12')).toEqual({ view: 'char', id: 'c_ab12' });
    expect(parseRoute('/char/c_ab12/')).toEqual({ view: 'char', id: 'c_ab12' });
    expect(parseRoute('/settings')).toEqual({ view: 'fleet' });
    expect(parseRoute('/char/%')).toEqual({ view: 'fleet' });
    expect(routePath({ view: 'char', id: 'c_ab12' })).toBe('/char/c_ab12');
    expect(routePath({ view: 'fleet' })).toBe('/');
  });
});

describe('phone cwd choices', () => {
  it("offers the island's own directories first, then the fleet's, then the default, once each", () => {
    const f = fleet();
    f.characters.c0.cwd = '/Users/me/a';
    f.characters.c1.cwd = '/Users/me/a-wt';
    f.characters.c1.repo = { root: '/Users/me/a-wt', mainRoot: '/Users/me/a', branch: 'x', isWorktree: true };
    f.characters.c2.cwd = '/Users/me/b';
    expect(cwdChoices(f, 'i_b').map((c) => c.path)).toEqual(['/Users/me/a', '/Users/me/b', '~', '/mc']);
    expect(cwdChoices(f, 'i_b')[0].label).toBe('~/a');
    expect(cwdChoices(f, 'home').map((c) => c.path)).toEqual(['/mc', '/Users/me/a', '/Users/me/b', '~']);
    expect(cwdChoices(f, 'i_e').map((c) => c.path)).toEqual(['/Users/me/a', '/Users/me/b', '~', '/mc']);
  });

  it("starts a one-tap character in its island's repo, the home cwd, or the fleet default", () => {
    const f = fleet();
    f.characters.c0.cwd = '/Users/me/a-wt';
    f.characters.c0.repo = { root: '/Users/me/a-wt', mainRoot: '/Users/me/a', branch: 'x', isWorktree: true };
    f.characters.c1.cwd = '/Users/me/b';
    expect(islandCwd(f, 'i_b')).toBe('/Users/me/a');
    expect(islandCwd(f, 'home')).toBe('/mc');
    expect(islandCwd(f, 'i_e')).toBe('~');
  });
});

describe('phone push helpers', () => {
  it("turns the daemon's base64url key into bytes", () => {
    expect(Array.from(keyBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(keyBytes('_-8'))).toEqual([255, 239]);
  });

  it('asks an iPhone or an iPad to install first, and nobody else', () => {
    const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    expect(needsInstall({ userAgent: ios })).toBe(true);
    expect(needsInstall({ userAgent: ios, standalone: true })).toBe(false);
    expect(needsInstall({ userAgent: mac, maxTouchPoints: 5 })).toBe(true);
    expect(needsInstall({ userAgent: mac, maxTouchPoints: 0 })).toBe(false);
    expect(needsInstall({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' })).toBe(false);
  });

  it('keeps of a subscription only what the daemon encrypts for', () => {
    const sub = { toJSON: () => ({ endpoint: 'https://push.example/a', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }) };
    expect(subscriptionParams(sub, ['blocked'])).toEqual({ endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked'] });
    expect(() => subscriptionParams({ toJSON: () => ({ endpoint: 'x' }) }, [])).toThrow(/incomplete/);
  });

  it('trusts a subscription only against the current daemon key', () => {
    expect(sameApplicationServerKey(keyBytes('AQID').buffer, 'AQID')).toBe(true);
    expect(sameApplicationServerKey(keyBytes('BAUG').buffer, 'AQID')).toBe(false);
    expect(sameApplicationServerKey(null, 'AQID')).toBe(false);
  });
});

type FakeSub = { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; toJSON(): { endpoint: string; keys: Record<string, string> }; unsubscribe(): Promise<boolean> };
const fakeSub = (endpoint: string, key: string): FakeSub => ({
  endpoint, options: { applicationServerKey: keyBytes(key).buffer as ArrayBuffer },
  toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
  unsubscribe: vi.fn(() => Promise.resolve(true)),
});

// a browser with a service worker ready and a daemon whose key is AQID; `known` is what the daemon holds for the endpoint
function pushEnv(o: { sub?: FakeSub; known?: PushStatus[]; permission?: string } = {}) {
  let sub: FakeSub | null = o.sub ?? null;
  const subscribe = vi.fn((_opts: { applicationServerKey: Uint8Array }) => Promise.resolve(sub = fakeSub('https://push.example/new', 'AQID')));
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)', serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(sub), subscribe } }) } });
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('Notification', { permission: o.permission ?? 'default' });
  const calls: [string, Record<string, unknown>][] = [];
  const api = {
    call: (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === 'push.key') return Promise.resolve({ publicKey: 'AQID' });
      if (method === 'push.get') return Promise.resolve({ statuses: o.known });
      return Promise.resolve({});
    },
  } as unknown as Api;
  return { api, calls, subscribe };
}

describe('phone push', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads a phone with no subscription as off, holding the key a tap will need', async () => {
    const { api } = pushEnv();
    expect(await readPush(api)).toEqual({ kind: 'off', publicKey: 'AQID' });
  });

  it('reads a subscription the daemon holds as on, and one it forgot as off', async () => {
    expect(await readPush(pushEnv({ sub: fakeSub('https://push.example/a', 'AQID'), known: ['done'] }).api))
      .toEqual({ kind: 'on', endpoint: 'https://push.example/a', statuses: ['done'] });
    expect(await readPush(pushEnv({ sub: fakeSub('https://push.example/a', 'AQID') }).api)).toEqual({ kind: 'off', publicKey: 'AQID' });
  });

  it('says when the phone has refused notifications', async () => {
    expect(await readPush(pushEnv({ permission: 'denied' }).api)).toEqual({ kind: 'denied' });
  });

  // a round trip before the prompt can outlast the tap's activation, and the prompt is then refused
  it('subscribes with the key it already holds, asking the daemon nothing first', async () => {
    const { api, calls, subscribe } = pushEnv();
    expect(await enablePush(api, 'AQID')).toEqual({ kind: 'on', endpoint: 'https://push.example/new', statuses: ['blocked', 'done'] });
    expect(Array.from(subscribe.mock.calls[0][0].applicationServerKey)).toEqual([1, 2, 3]);
    expect(calls.map(([m]) => m)).toEqual(['push.subscribe']);
  });

  it('replaces a subscription made against an older key', async () => {
    const old = fakeSub('https://push.example/old', 'BAUG');
    const { api, subscribe } = pushEnv({ sub: old });
    await enablePush(api, 'AQID');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalled();
  });

  it('changes which turns it hears about, and reads a lost subscription as off', async () => {
    const { api, calls } = pushEnv({ sub: fakeSub('https://push.example/a', 'AQID') });
    expect(await setPushStatuses(api, ['blocked'])).toEqual({ kind: 'on', endpoint: 'https://push.example/a', statuses: ['blocked'] });
    expect(calls[0]).toEqual(['push.subscribe', { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked'] }]);
    expect(await setPushStatuses(pushEnv().api, ['blocked'])).toEqual({ kind: 'off', publicKey: 'AQID' });
  });

  it('turning it off forgets the phone on both sides', async () => {
    const sub = fakeSub('https://push.example/a', 'AQID');
    const { api, calls } = pushEnv({ sub });
    expect(await disablePush(api)).toEqual({ kind: 'off', publicKey: 'AQID' });
    expect(calls).toEqual([['push.key', {}], ['push.unsubscribe', { endpoint: 'https://push.example/a' }]]);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('turning it off without the daemon leaves the phone subscribed', async () => {
    const sub = fakeSub('https://push.example/a', 'AQID');
    const { api, calls } = pushEnv({ sub });
    const away = { call: (m: string, p: object) => (m === 'push.key' ? Promise.reject(new Error('svalld offline')) : api.call(m as 'push.unsubscribe', p as never)) } as unknown as Api;
    await expect(disablePush(away)).rejects.toThrow('svalld offline');
    expect(calls).toEqual([]);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('the phones on the page', () => {
  const at = (hh: number, mm: number) => new Date(2026, 8, 19, hh, mm).getTime();

  it('names each login and the minute it arrived, and says so when there is none', () => {
    expect(phonesHere([])).toBe('nobody has this open');
    expect(phonesHere()).toBe('nobody has this open');
    expect(phonesHere([], 'nobody')).toBe('nobody');
    expect(phonesHere([{ login: 'me@example.com', since: at(14, 2) }])).toBe('me@example.com since 14:02');
    expect(phonesHere([{ login: 'me@example.com', since: at(9, 5) }, { login: 'you@example.com', since: at(14, 30) }]))
      .toBe('me@example.com since 09:05 · you@example.com since 14:30');
  });

  // an off forgets every phone's notifications, so the switch and its remedy both say so
  it('tells whoever turns the link off that each phone turns notifications on again', () => {
    expect(OFF).toMatch(/re-enable notifications on each phone/);
    expect(NO_PAGE).toMatch(/re-enable notifications on each phone/);
  });
});

describe('phone row swipe', () => {
  it('follows the finger only between shut and fully revealed', () => {
    expect(dragOffset(0, -30)).toBe(-30);
    expect(dragOffset(0, 40)).toBe(0);
    expect(dragOffset(0, -500)).toBe(-REVEAL);
    expect(dragOffset(-REVEAL, 20)).toBe(-REVEAL + 20);
    expect(dragOffset(-REVEAL, 500)).toBe(0);
  });

  it('rests open past half the action, and shut otherwise', () => {
    expect(settle(-REVEAL / 2 - 1)).toBe(-REVEAL);
    expect(settle(-REVEAL / 2 + 1)).toBe(0);
    expect(settle(0)).toBe(0);
    expect(settle(-REVEAL / 2)).toBe(0);
  });

  it('takes a drag for a swipe only when it is clearly sideways', () => {
    expect(isSwipe(-12, 2)).toBe(true);
    expect(isSwipe(-6, 0)).toBe(false);
    expect(isSwipe(-12, 10)).toBe(false);
    expect(isSwipe(12, 2)).toBe(true);
  });
});

function touchHarness() {
  const handlers = new Map<string, (e: unknown) => void>();
  const surface = {
    addEventListener: (type: string, h: (e: unknown) => void) => { handlers.set(type, h); },
    removeEventListener: (type: string) => { handlers.delete(type); },
  } as unknown as TouchSurface;
  const touch = (y: number, timeStamp: number, preventDefault = () => {}) => ({ touches: [{ clientY: y }], timeStamp, preventDefault });
  const fire = (type: string, e: unknown) => handlers.get(type)!(e);
  return { handlers, surface, touch, fire };
}

describe('phone terminal scrolling', () => {
  it('turns pixels into whole lines and carries what is left over', () => {
    const step = lineSteps(8);
    expect(step(20)).toBe(2);
    expect(step(2)).toBe(0);
    expect(step(2)).toBe(1);
    expect(step(-24)).toBe(-3);
  });

  it('scrolls back as one finger drags down, and lets go of the surface when disposed', () => {
    const { handlers, surface, touch, fire } = touchHarness();
    const scrolled: number[] = [];
    const dispose = dragToScroll(surface, (n) => scrolled.push(n), () => 10);

    fire('touchstart', touch(100, 0));
    fire('touchmove', touch(130, 16));
    fire('touchmove', touch(134, 32));
    fire('touchmove', touch(141, 48));
    expect(scrolled).toEqual([-3, -1]);

    fire('touchmove', { touches: [{ clientY: 0 }, { clientY: 9 }], timeStamp: 64, preventDefault: () => {} });
    expect(scrolled).toEqual([-3, -1]);

    fire('touchmove', touch(400, 80));
    expect(scrolled).toEqual([-3, -1]);
    fire('touchmove', touch(420, 96));
    expect(scrolled).toEqual([-3, -1, -2]);

    expect([...handlers.keys()].sort()).toEqual(['touchcancel', 'touchend', 'touchmove', 'touchstart']);
    dispose();
    expect(handlers.size).toBe(0);
  });

  it('leaves a drifting tap to the browser, and claims the gesture once it is a drag', () => {
    const { surface, touch, fire } = touchHarness();
    dragToScroll(surface, () => {}, () => 10);
    let claimed = 0;
    const drag = (y: number, t: number) => touch(y, t, () => { claimed += 1; });

    fire('touchstart', drag(100, 0));
    fire('touchmove', drag(103, 16));
    expect(claimed).toBe(0);
    fire('touchmove', drag(112, 32));
    expect(claimed).toBe(1);
  });

  it('re-anchors when a gesture starts with more than one finger down', () => {
    const { surface, touch, fire } = touchHarness();
    const scrolled: number[] = [];
    dragToScroll(surface, (n) => scrolled.push(n), () => 10);

    fire('touchstart', touch(100, 0));
    fire('touchmove', touch(140, 16));
    fire('touchend', { touches: [], timeStamp: 300 }); // rested too long to be a flick
    scrolled.length = 0;

    // both fingers land in one event, then one lifts and the other barely moves
    fire('touchstart', { touches: [{ clientY: 400 }, { clientY: 420 }], timeStamp: 100, preventDefault: () => {} });
    fire('touchmove', touch(398, 116));
    expect(scrolled).toEqual([]);
  });

  it('coasts once the last finger lifts, and a cancelled gesture stops instead', () => {
    const { surface, touch, fire } = touchHarness();
    let next = 1;
    const live = new Set<number>();
    vi.stubGlobal('requestAnimationFrame', () => { const id = next++; live.add(id); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { live.delete(id); });
    try {
      const dispose = dragToScroll(surface, () => {}, () => 10);

      fire('touchstart', touch(100, 0));
      fire('touchmove', touch(103, 16));
      fire('touchend', { touches: [], timeStamp: 20 });
      expect(live.size).toBe(0);

      // a finger still down is the rest of the gesture, not a flick
      fire('touchstart', touch(100, 100));
      fire('touchmove', touch(140, 116));
      fire('touchend', { touches: [{ clientY: 140 }], timeStamp: 120 });
      expect(live.size).toBe(0);
      fire('touchend', { touches: [], timeStamp: 124 });
      expect(live.size).toBe(1);

      fire('touchstart', touch(100, 200));
      fire('touchmove', touch(140, 216));
      fire('touchcancel', { touches: [], timeStamp: 220 });
      expect(live.size).toBe(0);

      fire('touchstart', touch(100, 300));
      fire('touchmove', touch(140, 316));
      fire('touchend', { touches: [], timeStamp: 320 });
      expect(live.size).toBe(1);
      dispose();
      expect(live.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('holding the place across a repaint', () => {
  function term() {
    let baseY = 0;
    let viewportY = 0;
    const queued: (() => void)[] = [];
    const scrolled: number[] = [];
    const t = {
      buffer: { active: { get baseY() { return baseY; }, get viewportY() { return viewportY; } } },
      write: (_b: Uint8Array, done: () => void) => { queued.push(done); },
      reset: () => { baseY = 0; viewportY = 0; },
      scrollLines: (n: number) => { scrolled.push(n); viewportY += n; },
    };
    return { t, scrolled, at: (b: number, v: number) => { baseY = b; viewportY = v; }, flush: () => { for (const d of queued.splice(0)) d(); } };
  }
  const bytes = new Uint8Array();

  it('puts a reader back the same distance from the bottom once the repaint is parsed', () => {
    const { t, scrolled, at, flush } = term();
    const screen = holdScroll(t);
    at(100, 95);
    screen.reset();
    screen.write(bytes);
    expect(scrolled).toEqual([]);
    flush();
    expect(scrolled).toEqual([-5]);
  });

  it('leaves a reader at the bottom where they were already at the bottom', () => {
    const { t, scrolled, at, flush } = term();
    const screen = holdScroll(t);
    at(100, 100);
    screen.reset();
    screen.write(bytes);
    flush();
    expect(scrolled).toEqual([]);
  });

  it('restores once, not on the output that follows the repaint', () => {
    const { t, scrolled, at, flush } = term();
    const screen = holdScroll(t);
    at(100, 95);
    screen.reset();
    screen.write(bytes);
    screen.write(bytes);
    flush();
    expect(scrolled).toEqual([-5]);
  });
});
