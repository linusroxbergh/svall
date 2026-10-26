// A path in a robot's Files is one under its root by its name there ('' for the root itself), or any other by its absolute path.

/** The folder a robot's Files open in: its repository's top, else its cwd. */
export const rootOf = (c: { cwd: string; repo?: { root: string } }): string => (c.repo?.root ?? c.cwd).replace(/(.)\/+$/, '$1');

export const isAbsolute = (p: string): boolean => p.startsWith('/');

export const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

export const parent = (abs: string): string => abs.slice(0, abs.lastIndexOf('/')) || '/';

export const absOf = (p: string, root: string): string => (isAbsolute(p) ? p : p ? `${root}/${p}` : root);

// macOS keeps /tmp, /var and /etc in /private: git names a root by its real path, while a cwd or a tool may keep the link
const unlinked = (abs: string, root: string): string =>
  within(abs, root) ? abs : within(`/private${abs}`, root) ? `/private${abs}` : abs.startsWith('/private/') && within(abs.slice(8), root) ? abs.slice(8) : abs;

export const placeOf = (abs: string, root: string): string => {
  const p = unlinked(abs, root);
  return p === root ? '' : within(p, root) ? p.slice(root.length + 1) : abs;
};

export const childOf = (dir: string, name: string, root: string): string => placeOf(`${absOf(dir, root).replace(/\/$/, '')}/${name}`, root);

/** `p` as an agent prints it, made absolute: `~` is `home`, and a relative path is `cwd`'s. Without a home, `~` stays as it is. */
export function resolve(p: string, cwd: string, home: string | undefined): string {
  const full = p === '~' || p.startsWith('~/') ? (home ? home + p.slice(1) : p) : isAbsolute(p) ? p : `${cwd}/${p}`;
  if (!isAbsolute(full)) return full;
  const out: string[] = [];
  for (const seg of full.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** The folders between `from` and the tree's top `top`, the top left out, each as a place. */
export function between(from: string, top: string, root: string): string[] {
  const t = absOf(top, root);
  const out: string[] = [];
  for (let d = absOf(from, root); d !== t && within(d, t); d = parent(d)) out.push(placeOf(d, root));
  return out;
}
