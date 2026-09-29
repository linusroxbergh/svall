import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PRIVATE = 'private';
export const BUNDLE_ID = 'io.github.linusroxbergh.archipelago';
export const LAUNCHD_LABEL = `${BUNDLE_ID}.archid`;
// the ids an older install ran under: setup moves what they hold to the ones above, and uninstall takes both
export const OLD_BUNDLE_ID = 'com.archipelago.desktop';
export const OLD_LAUNCHD_LABEL = 'com.archipelago.archid';
const RESERVED = [
  'status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'agent', 'doctor', 'uninstall',
  'host', 'handover', 'gateway', 'fleet', 'connect', 'connection-info', 'version', 'help',
];
const NAME = /^[a-z][a-z0-9-]*$/;
const PREFIX = '.archipelago-';

export function isProfileName(name: string): boolean {
  return NAME.test(name) && !RESERVED.includes(name);
}

export function profileHome(name: string, homedir = os.homedir()): string {
  return path.join(homedir, name === PRIVATE ? '.archipelago' : `${PREFIX}${name}`);
}

export function profileLabel(name: string, base = LAUNCHD_LABEL): string {
  return name === PRIVATE ? base : `${base}.${name}`;
}

/**
 * Each `~/.archipelago-<name>` holding a fleet under a name archi now keeps for a command of its own, which no `-p`
 * reaches, with a name it can move to.
 */
export function reservedProfileHomes(homedir = os.homedir()): { home: string; name: string; rename: string }[] {
  let names: string[];
  try { names = fs.readdirSync(homedir).sort(); } catch { return []; }
  return names.filter((f) => f.startsWith(PREFIX) && RESERVED.includes(f.slice(PREFIX.length)))
    .map((f) => ({ home: path.join(homedir, f), name: f.slice(PREFIX.length) }))
    .filter(({ home }) => ['fleet.json', 'config.json'].some((c) => fs.existsSync(path.join(home, c))))
    .map(({ home, name }) => ({ home, name, rename: `${name}-fleet` }));
}

export function profileOf(home: string, homedir = os.homedir()): string {
  if (home === path.join(homedir, '.archipelago')) return PRIVATE;
  const base = path.basename(home);
  return base.startsWith(PREFIX) ? base.slice(PREFIX.length) : base;
}
