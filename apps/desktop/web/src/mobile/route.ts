export type Route = { view: 'fleet' } | { view: 'char'; id: string };

/** The page's path as a view: `/char/<id>` is one character, anything else the list. */
export function parseRoute(pathname: string): Route {
  const m = /^\/char\/([^/]+)\/?$/.exec(pathname);
  if (!m) return { view: 'fleet' };
  try { return { view: 'char', id: decodeURIComponent(m[1]) }; } catch { return { view: 'fleet' }; }
}

export const routePath = (r: Route): string => (r.view === 'char' ? `/char/${encodeURIComponent(r.id)}` : '/');
