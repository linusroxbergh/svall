import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProfileName, RESERVED } from '@svall/protocol';
import { variant, type Variant } from './runtime.js';

export { isProfileName };

const release = variant === 'release';
export const PRIVATE = 'private';
export const BUNDLE_ID = release ? 'io.github.linusroxbergh.svall' : 'io.github.linusroxbergh.svall.dev';
export const LAUNCHD_LABEL = `${BUNDLE_ID}.svalld`;
export const SHIM = release ? 'svall' : 'svall-dev';
export const OTHER_SHIM = release ? 'svall-dev' : 'svall';
export const DEFAULT_PORT = release ? 47800 : 47900;
export const PRIVATE_HTTPS_PORT = release ? 443 : 10000;
const ROOT = release ? '.svall' : '.svall-dev';
export const homePrefix = `${ROOT}-`;
export const HOME_CWD = `~/${ROOT}/home`;

// ~/.svall and ~/.svall-<name> are the release's, ~/.svall-dev and ~/.svall-dev-<name> Svall Dev's; a home named like
// neither (a test fleet's) is no variant's. The hook scripts give such a home to Svall Dev
export const variantOf = (home: string): Variant | undefined => {
  const base = path.basename(home);
  if (/^\.svall-dev(-|$)/.test(base)) return 'dev';
  return /^\.svall(-[a-z][a-z0-9-]*)?$/.test(base) ? 'release' : undefined;
};

export function profileHome(name: string, homedir = os.homedir()): string {
  return path.join(homedir, name === PRIVATE ? ROOT : `${homePrefix}${name}`);
}

export function profileLabel(name: string): string {
  return name === PRIVATE ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}.${name}`;
}

/**
 * Each `~/.svall-<name>` holding a fleet under a name svall now keeps for a command of its own, which no `-p`
 * reaches, with a name it can move to.
 */
export function reservedProfileHomes(homedir = os.homedir()): { home: string; name: string; rename: string }[] {
  let names: string[];
  try { names = fs.readdirSync(homedir).sort(); } catch { return []; }
  return names.filter((f) => f.startsWith(homePrefix) && RESERVED.includes(f.slice(homePrefix.length)))
    .map((f) => ({ home: path.join(homedir, f), name: f.slice(homePrefix.length) }))
    .filter(({ home }) => ['fleet.json', 'config.json'].some((c) => fs.existsSync(path.join(home, c))))
    .map(({ home, name }) => ({ home, name, rename: `${name}-fleet` }));
}

export function profileOf(home: string, homedir = os.homedir()): string {
  if (home === path.join(homedir, ROOT)) return PRIVATE;
  const base = path.basename(home);
  return base.startsWith(homePrefix) ? base.slice(homePrefix.length) : base;
}
