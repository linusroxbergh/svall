import os from 'node:os';
import path from 'node:path';

export const PRIVATE = 'private';
export const BUNDLE_ID = 'io.github.linusroxbergh.archipelago';
export const LAUNCHD_LABEL = `${BUNDLE_ID}.archid`;
// the ids an older install ran under: setup moves what they hold to the ones above, and uninstall takes both
export const OLD_BUNDLE_ID = 'com.archipelago.desktop';
export const OLD_LAUNCHD_LABEL = 'com.archipelago.archid';
const RESERVED = ['status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'doctor', 'uninstall', 'help'];
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

export function profileOf(home: string, homedir = os.homedir()): string {
  if (home === path.join(homedir, '.archipelago')) return PRIVATE;
  const base = path.basename(home);
  return base.startsWith(PREFIX) ? base.slice(PREFIX.length) : base;
}
