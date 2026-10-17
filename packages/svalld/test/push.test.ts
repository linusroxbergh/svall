import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStatus, Character, MobileStatus } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { silentLogger } from '../src/log.js';
import webpush from 'web-push';
import { startPusher, type PushPayload, type Send } from '../src/push/pusher.js';
import { PushStore } from '../src/push/store.js';
import { readOrCreateVapid } from '../src/push/vapid.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const sub = () => ({ endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked' as const], login: 'me@example.com', addedAt: 1 });

describe('PushStore', () => {
  it('keeps a device by endpoint, takes its new statuses, and forgets it', () => {
    const file = path.join(makeHome(), 'push.json');
    const s = new PushStore(file, () => {});
    s.upsert(sub());
    s.upsert({ ...sub(), statuses: ['blocked', 'done'], addedAt: 2 });
    expect(s.list()).toEqual([{ ...sub(), statuses: ['blocked', 'done'] }]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new PushStore(file, () => {}).get(sub().endpoint)?.statuses).toEqual(['blocked', 'done']);
    expect(s.remove(sub().endpoint)).toBe(true);
    expect(s.remove(sub().endpoint)).toBe(false);
    expect(s.list()).toEqual([]);
  });

  it('starts with no devices on an unreadable file, and says so', () => {
    const file = path.join(makeHome(), 'push.json');
    fs.writeFileSync(file, '{not json');
    const said: string[] = [];
    expect(new PushStore(file, (m) => said.push(m)).list()).toEqual([]);
    expect(said[0]).toMatch(/push\.json unreadable/);
  });

  it('moves an unparseable file aside instead of clobbering it', () => {
    const file = path.join(makeHome(), 'push.json');
    fs.writeFileSync(file, '{not json');
    const said: string[] = [];
    expect(new PushStore(file, (m) => said.push(m)).list()).toEqual([]);
    expect(said[0]).toMatch(/push\.json unreadable/);
    const dir = fs.readdirSync(path.dirname(file));
    const broken = dir.find((f) => f.startsWith('push.json.broken-'));
    expect(broken).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(file), broken!), 'utf8')).toBe('{not json');
  });
});

describe('vapid', () => {
  it('makes a pair once and reads it back', () => {
    const file = path.join(makeHome(), 'vapid.json');
    const a = readOrCreateVapid(file);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(a.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(readOrCreateVapid(file)).toEqual(a);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses an incomplete pair rather than regenerating it', () => {
    const file = path.join(makeHome(), 'vapid.json');
    const partial = '{"publicKey":"x"}';
    fs.writeFileSync(file, partial);
    expect(() => readOrCreateVapid(file)).toThrow(/vapid\.json/);
    expect(fs.readFileSync(file, 'utf8')).toBe(partial);
  });

  it('refuses truncated JSON with a named error, not a bare SyntaxError', () => {
    const file = path.join(makeHome(), 'vapid.json');
    fs.writeFileSync(file, '{"publicKey":"x",');
    expect(() => readOrCreateVapid(file)).toThrow(/vapid\.json/);
  });
});

describe('pusher', () => {
  const agent = (status: AgentStatus, prompt?: string): Character['agent'] =>
    ({ kind: 'claude', sessionId: 's', transcriptPath: '/t', status, lastActivityAt: 0, ...(prompt ? { prompt } : {}) });
  const tick = () => new Promise((r) => setImmediate(r));

  const SERVED = 'https://mac.tailnet.ts.net:8443/';

  function setup(o: { logins?: string[]; off?: boolean; contact?: string } = {}) {
    const home = makeHome();
    const store = Store.load(path.join(home, 'state.json'), () => {});
    const push = new PushStore(path.join(home, 'push.json'), () => {});
    const sent: { endpoint: string; payload: PushPayload }[] = [];
    const subjects: string[] = [];
    const dead = new Map<string, number>();
    const send: Send = (s, payload, subject) => {
      const code = dead.get(s.endpoint);
      if (code) return Promise.reject(Object.assign(new Error('gone'), { statusCode: code }));
      sent.push({ endpoint: s.endpoint, payload });
      subjects.push(subject);
      return Promise.resolve();
    };
    store.update((d) => {
      d.islands.i = { id: 'i', name: 'i', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
      d.characters.c = { id: 'c', islandId: 'i', cell: { x: 1, y: 1 }, name: 'otter', portrait: 'fox', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false, agent: agent('working') };
    });
    push.upsert({ endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked'], login: 'me', addedAt: 1 });
    push.upsert({ endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' }, statuses: ['done'], login: 'me', addedAt: 1 });
    const accepted = { logins: o.logins ?? ['me'] };
    const stop = startPusher({ store, push, send, log: silentLogger, logins: () => accepted.logins, served: () => (o.off ? undefined : SERVED), contact: o.contact });
    return { store, push, sent, subjects, dead, stop, accepted };
  }

  it('tells a device when an agent turns blocked or done, with what it asked, and only about the turns it chose', async () => {
    const { store, sent } = setup();
    store.update((d) => { d.characters.c.agent = agent('blocked', 'Bash?'); });
    store.update((d) => { d.characters.c.note = 'still blocked, nothing new'; });
    store.update((d) => { d.characters.c.agent = agent('done'); d.characters.c.unread = true; });
    store.update((d) => { d.characters.c.agent = agent('idle'); });
    await tick();
    expect(sent).toEqual([
      { endpoint: 'https://push.example/a', payload: { id: 'c', name: 'otter', status: 'blocked', prompt: 'Bash?' } },
      { endpoint: 'https://push.example/b', payload: { id: 'c', name: 'otter', status: 'done' } },
    ]);
  });

  it('names the question it tells of, tells of the next one too, and says why an API error ended a turn', async () => {
    const { store, sent } = setup();
    store.update((d) => { d.characters.c.agent = { ...agent('blocked', 'Bash?')!, promptId: 'q1' }; });
    store.update((d) => { d.characters.c.agent = { ...agent('blocked', 'Write?')!, promptId: 'q2' }; });
    store.update((d) => { d.characters.c.agent = agent('done', 'API Error: 529 Overloaded'); d.characters.c.unread = true; });
    await tick();
    expect(sent).toEqual([
      { endpoint: 'https://push.example/a', payload: { id: 'c', name: 'otter', status: 'blocked', prompt: 'Bash?', promptId: 'q1' } },
      { endpoint: 'https://push.example/a', payload: { id: 'c', name: 'otter', status: 'blocked', prompt: 'Write?', promptId: 'q2' } },
      { endpoint: 'https://push.example/b', payload: { id: 'c', name: 'otter', status: 'done', prompt: 'API Error: 529 Overloaded' } },
    ]);
  });

  it('tells a device about the second terminal turning blocked, under the character and marked as its own session', async () => {
    const { store, sent } = setup();
    store.update((d) => { d.characters.c.second = { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: agent('blocked', 'Write?') }; });
    await tick();
    expect(sent).toEqual([{ endpoint: 'https://push.example/a', payload: { id: 'c', name: 'otter', status: 'blocked', term: 2, prompt: 'Write?' } }]);
  });

  it('forgets a device the push service says is gone', async () => {
    const { store, push, dead } = setup();
    dead.set('https://push.example/a', 410);
    store.update((d) => { d.characters.c.agent = agent('blocked'); });
    await tick();
    expect(push.get('https://push.example/a')).toBeUndefined();
    expect(push.get('https://push.example/b')).toBeDefined();
  });

  it('tells only a device whose login the fleet still accepts', async () => {
    const { store, push, sent } = setup({ logins: ['me'] });
    push.upsert({ endpoint: 'https://push.example/revoked', keys: { p256dh: 'p', auth: 'a' }, statuses: ['blocked'], login: 'former', addedAt: 1 });
    store.update((d) => { d.characters.c.agent = agent('blocked', 'Bash?'); });
    await tick();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/a']);
  });

  // the Mac's own login is learned from tailscale after the pusher starts
  it('tells no device while the fleet accepts no login, and a device of a login it accepts later', async () => {
    const { store, sent, accepted } = setup({ logins: [] });
    store.update((d) => { d.characters.c.agent = agent('blocked'); });
    await tick();
    expect(sent).toEqual([]);
    accepted.logins = ['me'];
    store.update((d) => { d.characters.c.agent = agent('done'); });
    await tick();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/b']);
  });

  it('says nothing while the phone link is off', async () => {
    const { store, sent } = setup({ off: true });
    store.update((d) => { d.characters.c.agent = agent('blocked', 'Bash?'); });
    await tick();
    expect(sent).toEqual([]);
  });

  // Apple refuses a push whose sender names no contact it can reach, and the served page is the fleet's own
  it('names the link it serves as the sender, unless a contact is set', async () => {
    const plain = setup();
    plain.store.update((d) => { d.characters.c.agent = agent('blocked'); });
    const named = setup({ contact: 'mailto:me@mac.dev' });
    named.store.update((d) => { d.characters.c.agent = agent('blocked'); });
    await tick();
    expect(plain.subjects).toEqual([SERVED]);
    expect(named.subjects).toEqual(['mailto:me@mac.dev']);
    const vapid = readOrCreateVapid(path.join(makeHome(), 'vapid.json'));
    const headers = webpush.getVapidHeaders('https://web.push.apple.com', SERVED, vapid.publicKey, vapid.privateKey, 'aes128gcm');
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/);
  });

  it('says nothing once stopped', async () => {
    const { store, sent, stop } = setup();
    stop();
    store.update((d) => { d.characters.c.agent = agent('blocked'); });
    await tick();
    expect(sent).toEqual([]);
  });
});

describe('turning the phone link off', () => {
  // the key turns over before tailscale is asked, so even an off tailscale refuses leaves no link to come back by
  it('forgets every device once an off has run, even a refused one, and none on an on', async () => {
    const push = new PushStore(path.join(makeHome(), 'push.json'), () => {});
    push.upsert(sub());
    const heldDuringSet: number[] = [];
    const mobile = {
      get: () => Promise.reject(new Error('not asked')),
      set: (): Promise<MobileStatus> => {
        heldDuringSet.push(push.list().length);
        return Promise.resolve({ serving: false, url: '', port: 443, logins: [], phones: [], error: 'tailscale is Stopped' });
      },
    };
    const set = (enabled: boolean) => dispatch({ id: 1, method: 'mobile.set', params: { enabled } }, { mobile, push, ownership: { assertOwner: () => {} } } as unknown as Ctx);
    await set(true);
    expect(push.list()).toHaveLength(1);
    await set(false);
    expect(push.list()).toEqual([]);
    expect(heldDuringSet).toEqual([1, 1]);
  });
});
