export type Route = { view: 'fleet' } | { view: 'robot'; id: string };

/** The page's path as a view: `/robot/<id>` is one robot, anything else the list. */
export function parseRoute(pathname: string): Route {
  const m = /^\/robot\/([^/]+)\/?$/.exec(pathname);
  if (!m) return { view: 'fleet' };
  try { return { view: 'robot', id: decodeURIComponent(m[1]) }; } catch { return { view: 'fleet' }; }
}

export const routePath = (r: Route): string => (r.view === 'robot' ? `/robot/${encodeURIComponent(r.id)}` : '/');
