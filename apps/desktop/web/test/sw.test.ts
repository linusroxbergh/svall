import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Payload = { id: string; name: string; status: string; term?: 2; prompt?: string; promptId?: string };
type Shown = { title: string; options: { tag: string; actions: { action: string }[] } };

// the worker is a static file the page registers, so it runs here against a stand-in for its global;
// reply is what the daemon answers a POST with
function load(reply: { status: number; body: unknown } = { status: 200, body: { id: 1, result: {} } }) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const posts: { url: string; body: unknown }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: () => Promise.resolve([]), openWindow: (url: string) => { opened.push(url); return Promise.resolve(null); } },
    registration: { showNotification: (title: string, options: Shown['options']) => { shown.push({ title, options }); return Promise.resolve(); } },
  };
  const fetch = (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: reply.status === 200, status: reply.status, json: () => Promise.resolve(reply.body) });
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, fetch });
  const click = async (data: Payload, action = '') => {
    let done: unknown;
    listeners.notificationclick({ action, notification: { data, close: () => {} }, waitUntil: (p: unknown) => { done = p; } });
    await done;
  };
  return { push: (p: Payload) => listeners.push({ data: { json: () => p }, waitUntil: () => {} }), click, shown, posts, opened };
}

describe('service worker notifications', () => {
  const blocked = (term?: 2): Payload => ({ id: 'c_a', name: 'otter', status: 'blocked', prompt: 'Bash?', ...(term ? { term } : {}) });

  it('offers approve and deny for the main terminal only', () => {
    const { push, shown } = load();
    push(blocked());
    push(blocked(2));
    expect(shown[0].options.actions.map((a) => a.action)).toEqual(['approve', 'deny']);
    expect(shown[1].options.actions).toEqual([]);
  });

  it('posts Approve and Deny as the answer for the character the notification named', async () => {
    const { click, posts, shown, opened } = load();
    await click(blocked(), 'approve');
    await click(blocked(), 'deny');
    expect(posts).toEqual([
      { url: '/rpc', body: { id: 1, method: 'char.answer', params: { id: 'c_a', answer: 'approve' } } },
      { url: '/rpc', body: { id: 1, method: 'char.answer', params: { id: 'c_a', answer: 'deny' } } },
    ]);
    expect(shown).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('names the question the notification showed, so the daemon can refuse a stale answer', async () => {
    const { click, posts } = load();
    await click({ ...blocked(), promptId: 'q1' }, 'approve');
    expect(posts).toEqual([{ url: '/rpc', body: { id: 1, method: 'char.answer', params: { id: 'c_a', answer: 'approve', promptId: 'q1' } } }]);
  });

  it('says so when the answer was refused, in the reply or by its status, beside any newer question', async () => {
    for (const reply of [{ status: 200, body: { id: 1, error: { code: 'invalid' } } }, { status: 401, body: {} }]) {
      const { click, shown } = load(reply);
      await click(blocked(), 'approve');
      expect(shown.map((s) => [s.title, s.options.tag])).toEqual([['otter: answer didn\'t send', 'c_a-failed']]);
    }
  });

  it('opens the character when the notification itself is tapped', async () => {
    const { click, posts, opened } = load();
    await click(blocked());
    expect(opened).toEqual(['/char/c_a']);
    expect(posts).toEqual([]);
  });

  it('tags each session on its own, so one terminal does not replace the other', () => {
    const { push, shown } = load();
    push(blocked());
    push({ id: 'c_a', name: 'otter', status: 'done', term: 2 });
    expect(shown.map((s) => s.options.tag)).toEqual(['c_a', 'c_a-2']);
  });
});
