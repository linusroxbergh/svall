// receives push for the page; caches nothing, so every load is the daemon's own bundle
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
      body: JSON.stringify({ id: 1, method: 'char.answer', params: { id, answer: e.action, promptId: e.notification.data.promptId } }),
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
  const url = `/char/${encodeURIComponent(id)}`;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const here = list.find((c) => c.url.endsWith(url));
    if (here) return here.focus();
    const open = list[0];
    return open ? open.navigate(url).then((c) => c && c.focus()).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
  }));
});
