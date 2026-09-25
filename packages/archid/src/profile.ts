import os from 'node:os';
import path from 'node:path';

export const PRIVATE = 'private';
export const LAUNCHD_LABEL = 'com.archipelago.archid';
const RESERVED = ['status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'doctor', 'uninstall', 'help'];
const NAME = /^[a-z][a-z0-9-]*$/;
const PREFIX = '.archipelago-';

export function isProfileName(name: string): boolean {
  return NAME.test(name) && !RESERVED.includes(name);
}

export function profileHome(name: string, homedir = os.homedir()): string {
  return path.join(homedir, name === PRIVATE ? '.archipelago' : `${PREFIX}${name}`);
}

export function profileLabel(name: string): string {
  return name === PRIVATE ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}.${name}`;
}

export function profileOf(home: string, homedir = os.homedir()): string {
  if (home === path.join(homedir, '.archipelago')) return PRIVATE;
  const base = path.basename(home);
  return base.startsWith(PREFIX) ? base.slice(PREFIX.length) : base;
}
