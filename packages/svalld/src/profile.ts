import os from 'node:os';
import path from 'node:path';
import { isProfileName } from '@svall/protocol';

export { isProfileName };

export const PRIVATE = 'private';
export const BUNDLE_ID = 'io.github.linusroxbergh.svall';
export const LAUNCHD_LABEL = `${BUNDLE_ID}.svalld`;
const PREFIX = '.svall-';

export function profileHome(name: string, homedir = os.homedir()): string {
  return path.join(homedir, name === PRIVATE ? '.svall' : `${PREFIX}${name}`);
}

export function profileLabel(name: string): string {
  return name === PRIVATE ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}.${name}`;
}

export function profileOf(home: string, homedir = os.homedir()): string {
  if (home === path.join(homedir, '.svall')) return PRIVATE;
  const base = path.basename(home);
  return base.startsWith(PREFIX) ? base.slice(PREFIX.length) : base;
}
