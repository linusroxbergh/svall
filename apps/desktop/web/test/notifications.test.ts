import type { Agent, AgentStatus, Character, FleetState } from '@svall/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import { answerFailed, decide, followNotifications, type NoticeView } from '../src/notifications.js';
import type { NotifySettings } from '../src/settings.js';
import { createAppStore } from '../src/store/index.js';
import { fleet } from './fixtures.js';

const agent = (status: AgentStatus, prompt?: string): Agent =>
  ({ kind: 'claude', sessionId: 's', transcriptPath: '/t', status, lastActivityAt: 0, ...(prompt === undefined ? {} : { prompt }) });
const patch = (f: FleetState, id: string, p: Partial<Character>): FleetState =>
  ({ ...f, characters: { ...f.characters, [id]: { ...f.characters[id]!, ...p } } });
const without = (f: FleetState, id: string): FleetState =>
  ({ ...f, characters: Object.fromEntries(Object.entries(f.characters).filter(([k]) => k !== id)) });
const ON: NotifySettings = { on: true, sound: true, statuses: ['blocked', 'done'] };
const look = (f: FleetState, o: Partial<NoticeView> = {}): NoticeView =>
  ({ fleet: f, loaded: true, active: false, settings: ON, permission: 'granted', ...o });

// c1 lives on island i_b, named beta
const working = patch(fleet(), 'c1', { agent: agent('working') });
const blocked = patch(fleet(), 'c1', { agent: agent('blocked', 'Bash: rm -rf dist') });
const done = patch(fleet(), 'c1', { agent: agent('done'), unread: true });

describe('decide', () => {
  it('posts a blocked banner with what the agent asked, and Approve/Deny on the main terminal', () => {
    const d = decide(look(working), look(blocked), new Map());
    expect(d.post).toEqual([{ key: 'c1', title: 'c1 needs you', subtitle: 'beta', body: 'Bash: rm -rf dist', sound: true, actions: true }]);
    expect(d.remove).toEqual([]);
    expect([...d.posted]).toEqual([['c1', 'blocked']]);
  });

  it('posts a done banner with no body and no buttons', () => {
    const d = decide(look(working), look(done), new Map());
    expect(d.post).toEqual([{ key: 'c1', title: 'c1 is done', subtitle: 'beta', body: '', sound: true, actions: false }]);
  });

  it('says in a done banner why an API error ended the turn', () => {
    const failed = patch(fleet(), 'c1', { agent: agent('done', 'API Error: 529 Overloaded'), unread: true });
    expect(decide(look(working), look(failed), new Map()).post[0]!.body).toBe('API Error: 529 Overloaded');
  });

  it('carries the sound switch', () => {
    expect(decide(look(working), look(blocked, { settings: { ...ON, sound: false } }), new Map()).post[0]!.sound).toBe(false);
  });

  it('posts a second terminal under its own key, with no buttons', () => {
    const second = (status: AgentStatus) => patch(working, 'c1', { second: { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, agent: agent(status), unread: false } });
    const d = decide(look(second('working')), look(second('blocked')), new Map());
    expect(d.post).toEqual([{ key: 'c1-2', title: 'c1 needs you', subtitle: 'beta', body: '', sound: true, actions: false }]);
  });

  it('posts nothing for the first snapshot, an unchanged status, or a done already read', () => {
    expect(decide(look(fleet(), { loaded: false }), look(blocked), new Map()).post).toEqual([]);
    expect(decide(look(blocked), look(blocked), new Map()).post).toEqual([]);
    expect(decide(look(working), look(patch(done, 'c1', { unread: false })), new Map()).post).toEqual([]);
  });

  it('posts nothing while off, without permission, or for a status not chosen', () => {
    expect(decide(look(working), look(blocked, { settings: { ...ON, on: false } }), new Map()).post).toEqual([]);
    expect(decide(look(working), look(blocked, { permission: 'unknown' }), new Map()).post).toEqual([]);
    expect(decide(look(working), look(blocked, { permission: 'denied' }), new Map()).post).toEqual([]);
    expect(decide(look(working), look(blocked, { settings: { ...ON, statuses: ['done'] } }), new Map()).post).toEqual([]);
  });

  it('leaves out the character in view in the active window, but not when the app is behind', () => {
    expect(decide(look(working), look(blocked, { active: true, viewed: 'c1' }), new Map()).post).toEqual([]);
    expect(decide(look(working), look(blocked, { active: false, viewed: 'c1' }), new Map()).post).toHaveLength(1);
    expect(decide(look(working), look(blocked, { active: true, viewed: 'c2' }), new Map()).post).toHaveLength(1);
  });

  describe('takes a banner down', () => {
    const up = new Map([['c1', 'blocked' as const]]);
    it('when the status moves on', () => {
      expect(decide(look(blocked), look(working), up)).toMatchObject({ post: [], remove: ['c1'] });
    });
    it('when a done banner has been read', () => {
      const d = decide(look(done), look(patch(done, 'c1', { unread: false })), new Map([['c1', 'done' as const]]));
      expect(d.remove).toEqual(['c1']);
      expect([...d.posted]).toEqual([]);
    });
    it('when the character is gone', () => {
      expect(decide(look(blocked), look(without(blocked, 'c1')), up).remove).toEqual(['c1']);
    });
    it('when the character comes into view in the active window', () => {
      expect(decide(look(blocked), look(blocked, { active: true, viewed: 'c1' }), up).remove).toEqual(['c1']);
    });
    it('all at once when switched off or refused', () => {
      const both = new Map([['c1', 'blocked' as const], ['c2', 'done' as const]]);
      const f = patch(blocked, 'c2', { agent: agent('done'), unread: true });
      expect(decide(look(f), look(f, { settings: { ...ON, on: false } }), both).remove.sort()).toEqual(['c1', 'c2']);
      expect(decide(look(f), look(f, { permission: 'denied' }), both).remove.sort()).toEqual(['c1', 'c2']);
    });
    it('when its status is switched off', () => {
      const up = new Map([['c1', 'done' as const]]);
      expect(decide(look(done), look(done, { settings: { ...ON, statuses: ['blocked'] } }), up).remove).toEqual(['c1']);
    });
  });

  it('follows a status that flickers blocked, working, blocked with one banner at a time', () => {
    const a = decide(look(working), look(blocked), new Map());
    const b = decide(look(blocked), look(working), a.posted);
    const c = decide(look(working), look(blocked), b.posted);
    expect([a.post.length, a.remove]).toEqual([1, []]);
    expect([b.post.length, b.remove]).toEqual([0, ['c1']]);
    expect([c.post.length, c.remove]).toEqual([1, []]);
    expect([...c.posted]).toEqual([['c1', 'blocked']]);
  });

  it('does not post again for a fresh snapshot with the same status', () => {
    const up = new Map([['c1', 'blocked' as const]]);
    const d = decide(look(blocked), look(structuredClone(blocked)), up);
    expect(d).toMatchObject({ post: [], remove: [] });
    expect([...d.posted]).toEqual([['c1', 'blocked']]);
  });
});

describe('answerFailed', () => {
  it('replaces the session banner with one that says so, with no buttons', () => {
    expect(answerFailed('otter', 'c1', true)).toEqual({ key: 'c1', title: "otter: answer didn't send", subtitle: '', body: '', sound: true, actions: false });
  });
});

describe('followNotifications', () => {
  const fakeBridge = () => {
    const sent: ToShell[] = [];
    const handlers = new Set<(m: FromShell) => void>();
    return {
      present: true, sent,
      send: (m: ToShell) => { sent.push(m); },
      onMessage: (h: (m: FromShell) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
      emit: (m: FromShell) => { for (const h of handlers) h(m); },
    };
  };
  const answering = (call: (method: string, params: unknown) => Promise<unknown>) => ({ call: vi.fn(call) }) as unknown as Api;
  // no api is svalld not connected yet
  const setup = (o: { api?: Api } = { api: answering(() => Promise.resolve({})) }) => {
    const store = createAppStore();
    const bridge = fakeBridge();
    followNotifications({ store, bridge, api: () => o.api });
    store.getState().setFleet(working);
    store.getState().setSettings({ notifications: ON });
    store.getState().setStatus('online');
    bridge.emit({ type: 'notify.permission', state: 'granted' });
    return { store, bridge };
  };

  it('posts when a character turns blocked, and takes the banner down once it moves on', () => {
    const { store, bridge } = setup();
    store.getState().setFleet(blocked);
    expect(bridge.sent).toContainEqual({ type: 'notify.post', key: 'c1', title: 'c1 needs you', subtitle: 'beta', body: 'Bash: rm -rf dist', sound: true, actions: true });
    store.getState().setFleet(working);
    expect(bridge.sent.at(-1)).toEqual({ type: 'notify.remove', key: 'c1' });
  });

  it('takes every banner down when switched off', () => {
    const { store, bridge } = setup();
    store.getState().setFleet(blocked);
    store.getState().setSettings({ notifications: { ...ON, on: false } });
    expect(bridge.sent.at(-1)).toEqual({ type: 'notify.remove', key: 'c1' });
  });

  it('asks macOS once when notifications are on and it has not been asked, as under a new app id', () => {
    const { store, bridge } = setup();
    expect(bridge.sent).not.toContainEqual({ type: 'notify.enable' });
    bridge.emit({ type: 'notify.permission', state: 'unknown' });
    bridge.emit({ type: 'notify.permission', state: 'unknown' });
    expect(bridge.sent.filter((m) => m.type === 'notify.enable')).toHaveLength(1);

    const off = setup();
    off.store.getState().setSettings({ notifications: { ...ON, on: false } });
    off.bridge.emit({ type: 'notify.permission', state: 'unknown' });
    expect(off.bridge.sent).not.toContainEqual({ type: 'notify.enable' });
    expect(store.getState().notifyPermission).toBe('unknown');
  });

  it('focuses the character a banner was clicked for, second terminal or not', () => {
    const { store, bridge } = setup();
    bridge.emit({ type: 'notify.open', key: 'c1-2' });
    expect(store.getState().focusedId).toBe('c1');
    bridge.emit({ type: 'notify.open', key: 'gone' });
    expect(store.getState().focusedId).toBe('c1');
  });

  it('answers from the banner the question it named, and drops an answer that names none', async () => {
    const api = answering(() => Promise.resolve({}));
    const { bridge } = setup({ api });
    bridge.emit({ type: 'notify.action', key: 'c1', action: 'approve', promptId: '' });
    bridge.emit({ type: 'notify.action', key: 'c1', action: 'deny', promptId: 'q1' });
    await vi.waitFor(() => expect(api.call).toHaveBeenCalledWith('char.answer', { id: 'c1', answer: 'deny', promptId: 'q1' }));
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('puts a new question up in place of the last, and answers each banner for the question it showed', async () => {
    const api = answering((_m, p) => ((p as { promptId?: string }).promptId === 'q2' ? Promise.resolve({}) : Promise.reject(new Error('moved on'))));
    const { store, bridge } = setup({ api });
    const asking = (promptId: string, prompt: string) => patch(fleet(), 'c1', { agent: { ...agent('blocked', prompt), promptId } });
    store.getState().setFleet(asking('q1', 'Bash: rm -rf dist'));
    store.getState().setFleet(asking('q2', 'Write: .env'));
    const posts = () => bridge.sent.filter((m) => m.type === 'notify.post') as Extract<ToShell, { type: 'notify.post' }>[];
    expect(posts().map((m) => [m.body, m.promptId])).toEqual([['Bash: rm -rf dist', 'q1'], ['Write: .env', 'q2']]);
    // the first banner's answer comes back refused, and the second question's banner stays up
    bridge.emit({ type: 'notify.action', key: 'c1', action: 'approve', promptId: 'q1' });
    bridge.emit({ type: 'notify.action', key: 'c1', action: 'approve', promptId: 'q2' });
    await vi.waitFor(() => expect(api.call).toHaveBeenCalledWith('char.answer', { id: 'c1', answer: 'approve', promptId: 'q2' }));
    expect(api.call).toHaveBeenCalledWith('char.answer', { id: 'c1', answer: 'approve', promptId: 'q1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(posts()).toHaveLength(2);
  });

  it('says so when the answer did not reach the daemon', async () => {
    const failed = { type: 'notify.post', key: 'c1', title: "c1: answer didn't send", subtitle: '', body: '', sound: true, actions: false };
    const refused = setup({ api: answering(() => Promise.reject(new Error('refused'))) });
    refused.bridge.emit({ type: 'notify.action', key: 'c1', action: 'deny', promptId: 'q1' });
    await vi.waitFor(() => expect(refused.bridge.sent).toContainEqual(failed));
  });

  it('waits for the daemon to come online before answering, up to a limit', async () => {
    vi.useFakeTimers();
    try {
      const api = answering(() => Promise.resolve({}));
      const store = createAppStore();
      const bridge = fakeBridge();
      followNotifications({ store, bridge, api: () => api });
      store.getState().setFleet(working);
      store.getState().setSettings({ notifications: ON });
      bridge.emit({ type: 'notify.permission', state: 'granted' });
      bridge.emit({ type: 'notify.action', key: 'c1', action: 'approve', promptId: 'q1' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.call).not.toHaveBeenCalled();
      store.getState().setStatus('online');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.call).toHaveBeenCalledWith('char.answer', { id: 'c1', answer: 'approve', promptId: 'q1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the daemon never comes online within the wait', async () => {
    vi.useFakeTimers();
    try {
      const failed = { type: 'notify.post', key: 'c1', title: "c1: answer didn't send", subtitle: '', body: '', sound: true, actions: false };
      const store = createAppStore();
      const bridge = fakeBridge();
      followNotifications({ store, bridge, api: () => undefined });
      store.getState().setFleet(working);
      store.getState().setSettings({ notifications: ON });
      bridge.emit({ type: 'notify.permission', state: 'granted' });
      bridge.emit({ type: 'notify.action', key: 'c1', action: 'approve', promptId: 'q1' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(bridge.sent).toContainEqual(failed);
    } finally {
      vi.useRealTimers();
    }
  });
});
