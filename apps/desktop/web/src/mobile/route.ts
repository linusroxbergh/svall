export type Route = { view: 'fleet' } | { view: 'waiting' } | { view: 'robot'; id: string };

/** The page's path as a view: `/robot/<id>` is one robot, `/waiting` what waits on the user, anything else the list. */
export function parseRoute(pathname: string): Route {
  if (/^\/waiting\/?$/.test(pathname)) return { view: 'waiting' };
  const m = /^\/robot\/([^/]+)\/?$/.exec(pathname);
  if (!m) return { view: 'fleet' };
  try { return { view: 'robot', id: decodeURIComponent(m[1]) }; } catch { return { view: 'fleet' }; }
}

export const routePath = (r: Route): string => (r.view === 'robot' ? `/robot/${encodeURIComponent(r.id)}` : r.view === 'waiting' ? '/waiting' : '/');
