/** The account's home a path lies in, such as `/Users/ada` for `/Users/ada/.svall`. */
export const accountHome = (path: string | undefined): string | undefined => (path ? /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path)?.[0] : undefined);

/** A path as the user says it: `home`, by default the account's home it lies in, as `~`. */
export const shortPath = (p: string, home = accountHome(p)): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
