import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('posts Approve and Deny as the answer for the robot the notification named', async () => {
    const { click, posts, shown, opened } = load();
    await click(blocked(), 'approve');
    await click(blocked(), 'deny');
    expect(posts).toEqual([
      { url: '/rpc', body: { id: 1, method: 'robot.answer', params: { id: 'c_a', answer: 'approve' } } },
      { url: '/rpc', body: { id: 1, method: 'robot.answer', params: { id: 'c_a', answer: 'deny' } } },
    ]);
    expect(shown).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('names the question the notification showed, so the daemon can refuse a stale answer', async () => {
    const { click, posts } = load();
    await click({ ...blocked(), promptId: 'q1' }, 'approve');
    expect(posts).toEqual([{ url: '/rpc', body: { id: 1, method: 'robot.answer', params: { id: 'c_a', answer: 'approve', promptId: 'q1' } } }]);
  });

  it('says so when the answer was refused, in the reply or by its status, beside any newer question', async () => {
    for (const reply of [{ status: 200, body: { id: 1, error: { code: 'invalid' } } }, { status: 401, body: {} }]) {
      const { click, shown } = load(reply);
      await click(blocked(), 'approve');
      expect(shown.map((s) => [s.title, s.options.tag])).toEqual([['otter: answer didn\'t send', 'c_a-failed']]);
    }
  });

  it('opens the robot when the notification itself is tapped', async () => {
    const { click, posts, opened } = load();
    await click(blocked());
    expect(opened).toEqual(['/robot/c_a']);
    expect(posts).toEqual([]);
  });

  it('tags each session on its own, so one terminal does not replace the other', () => {
    const { push, shown } = load();
    push(blocked());
    push({ id: 'c_a', name: 'otter', status: 'done', term: 2 });
    expect(shown.map((s) => s.options.tag)).toEqual(['c_a', 'c_a-2']);
  });
});

type Req = { url: string; method: string; mode: string };

// the worker as the phone build leaves it, with a Mac that answers navigations as `net` says
function kept(answer: (req: Req) => Promise<string>) {
  const net = (req: Req) => answer(req).then((body) => new Response(body));
  const listeners: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, string>>([['svall-old', new Map([['/', 'old page']])]]);
  const caches = {
    open: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return Promise.resolve({ addAll: (urls: string[]) => Promise.all(urls.map((u) => answer({ url: `https://mac.ts.net${u}`, method: 'GET', mode: 'cors' }).then((b) => { store.set(u, b); }))) });
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
    match: (u: string) => {
      const body = [...stores.values()].find((m) => m.has(u))?.get(u);
      return Promise.resolve(body === undefined ? undefined : new Response(body, { headers: { 'content-security-policy': "default-src 'self'" } }));
    },
  };
  const self = {
    addEventListener: (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; },
    skipWaiting: () => {},
    location: { origin: 'https://mac.ts.net' },
    clients: { claim: () => Promise.resolve() },
  };
  const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
    .replace(/^const BUILD = .*;$/m, `const BUILD = ${JSON.stringify({ version: 'v2', files: ['/', '/assets/app.js', '/robots/a.png'] })};`);
  vm.runInNewContext(source, { self, caches, fetch: net, setTimeout, URL, Response });
  const lifecycle = async (name: string) => { let done: unknown; listeners[name]({ waitUntil: (p: unknown) => { done = p; } }); await done; };
  // what the page is handed for a request, or undefined when the worker leaves it to the browser
  const fetch = (path: string, mode = 'cors', method = 'GET'): Promise<string> | undefined => {
    let handed: Promise<Response> | undefined;
    listeners.fetch({ request: { url: new URL(path, 'https://mac.ts.net').href, method, mode }, respondWith: (p: Promise<Response>) => { handed = p; } });
    return handed?.then((r) => r.text());
  };
  const headers = (path: string) => {
    let handed: Promise<Response> | undefined;
    listeners.fetch({ request: { url: new URL(path, 'https://mac.ts.net').href, method: 'GET', mode: 'navigate' }, respondWith: (p: Promise<Response>) => { handed = p; } });
    return handed!.then((r) => Object.fromEntries(r.headers));
  };
  return { install: () => lifecycle('install'), activate: () => lifecycle('activate'), fetch, headers, stores };
}

describe('service worker page keeping', () => {
  afterEach(() => vi.useRealTimers());
  const mac = (req: Req) => Promise.resolve(`mac ${new URL(req.url).pathname}`);

  it('keeps every file of the build under its version, and drops the cache of the build before', async () => {
    const sw = kept(mac);
    await sw.install();
    expect([...sw.stores.get('svall-v2')!.keys()]).toEqual(['/', '/assets/app.js', '/robots/a.png']);
    await sw.activate();
    expect([...sw.stores.keys()]).toEqual(['svall-v2']);
  });

  it("serves the build's own files from what it kept, and leaves the manifest, the pass and the Mac's answers to the network", async () => {
    let asked = 0;
    const sw = kept((req) => { asked += 1; return mac(req); });
    await sw.install();
    await sw.activate();
    asked = 0;
    expect(await sw.fetch('/assets/app.js')).toBe('mac /assets/app.js');
    expect(asked).toBe(0);
    expect(sw.fetch('/manifest.webmanifest')).toBeUndefined();
    expect(sw.fetch('/pair', 'cors', 'POST')).toBeUndefined();
    expect(sw.fetch('/rpc', 'cors', 'POST')).toBeUndefined();
    expect(sw.fetch('https://vault.ts.net/robots/a.png')).toBeUndefined();
  });

  it("opens the Mac's page when it answers in time", async () => {
    const sw = kept((req) => Promise.resolve(req.mode === 'navigate' ? 'fresh page' : 'file'));
    await sw.install();
    expect(await sw.fetch('/robot/c_a', 'navigate')).toBe('fresh page');
  });

  it('opens the kept page once the Mac has not answered for 2.5 s, or as soon as it cannot be reached, and marks it as the kept one', async () => {
    vi.useFakeTimers();
    let navigations = 0;
    const sw = kept((req) => {
      if (req.mode !== 'navigate') return Promise.resolve('<html lang="en">kept page</html>');
      navigations += 1;
      return navigations === 1 ? new Promise(() => {}) : Promise.reject(new TypeError('Load failed'));
    });
    await sw.install();
    await sw.activate();
    let page: string | undefined;
    void sw.fetch('/robot/c_a', 'navigate')!.then((p) => { page = p; });
    await vi.advanceTimersByTimeAsync(2499);
    expect(page).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(page).toBe('<html data-kept lang="en">kept page</html>');
    expect(await sw.fetch('/', 'navigate')).toBe('<html data-kept lang="en">kept page</html>');
    // the page carries the headers it was kept with, the CSP among them
    expect(await sw.headers('/')).toMatchObject({ 'content-security-policy': "default-src 'self'" });
  });

  it('waits on the network when nothing was kept', async () => {
    vi.useFakeTimers();
    let answer: (b: string) => void = () => {};
    const sw = kept((req) => (req.mode === 'navigate' ? new Promise((r) => { answer = r; }) : Promise.resolve('file')));
    await sw.activate();
    sw.stores.clear();
    let page: string | undefined;
    void sw.fetch('/', 'navigate')!.then((p) => { page = p; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(page).toBeUndefined();
    answer('fresh page');
    await vi.advanceTimersByTimeAsync(0);
    expect(page).toBe('fresh page');
  });
});
