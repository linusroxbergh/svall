// receives push for the page, and keeps the page to open while the Mac does not answer.
// The phone build fills BUILD with its files and a hash of them; unbuilt, nothing is kept or served
const BUILD = { version: '', files: [] };
const CACHE = `svall-${BUILD.version}`;
// how long a navigation waits on the Mac before the kept page opens instead
const RACE_MS = 2500;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  if (BUILD.files.length) e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BUILD.files)));
});
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  .then(() => self.clients.claim())));

// the kept page says so on its root, so it turns to a worker without waiting on the Mac first
const marked = (res) => res.text().then((html) => new Response(html.replace('<html', '<html data-kept'), { headers: res.headers }));

// the Mac's page when it answers in time; past that, or when it cannot be reached, the one kept from it
function navigate(req) {
  const net = fetch(req);
  const kept = () => caches.match('/').then((hit) => (hit ? marked(hit) : net));
  return Promise.race([net, new Promise((r) => setTimeout(r, RACE_MS)).then(kept)]).catch(kept);
}

// the manifest carries the pass and /pair and /rpc are the Mac's answers, so only the build's own files are kept
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (!BUILD.files.length || req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') e.respondWith(navigate(req));
  else if (BUILD.files.includes(url.pathname)) e.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(req)));
});

// a notification replaces only the one before it from the same session, so two terminals do not hide each other
const tagOf = (p) => (p.term ? `${p.id}-${p.term}` : p.id);

// the daemon sends { id, name, status, term?, prompt?, promptId? }; iOS shows no action buttons, the page has its own
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { /* not ours */ }
  if (!p || !p.id) return;
  const blocked = p.status === 'blocked';
  const name = p.name || 'Agent';
  e.waitUntil(self.registration.showNotification(blocked ? `${name} needs you` : `${name} is done`, {
    body: p.prompt || '',
    tag: tagOf(p),
    renotify: true,
    data: p,
    // answering reaches the main terminal only, so a second-terminal prompt is informational and opened in the app
    actions: blocked && !p.term ? [{ action: 'approve', title: 'Approve' }, { action: 'deny', title: 'Deny' }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  if (!id) return;
  if (e.action === 'approve' || e.action === 'deny') {
    e.waitUntil(fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'robot.answer', params: { id, answer: e.action, promptId: e.notification.data.promptId } }),
    }).then((r) => r.json().catch(() => ({})).then((b) => {
      // the daemon reports a refused answer as a JSON-RPC error inside a 200
      if (!r.ok) throw new Error(String(r.status));
      if (b && b.error) throw new Error(b.error.code || 'error');
    })).catch(() => self.registration.showNotification(
      `${(e.notification.data && e.notification.data.name) || 'Agent'}: answer didn't send`,
      // a tag of its own, so it never covers a newer question's notification
      { tag: `${tagOf(e.notification.data)}-failed`, data: e.notification.data },
    )));
    return;
  }
  const url = `/robot/${encodeURIComponent(id)}`;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const here = list.find((c) => c.url.endsWith(url));
    if (here) return here.focus();
    const open = list[0];
    return open ? open.navigate(url).then((c) => c && c.focus()).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
  }));
});
