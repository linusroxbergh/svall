import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peekConfig } from './config.js';
import { resolvePaths } from './paths.js';
import { homePrefix, isFleetName, PRIVATE, profileHome } from './profile.js';

// a fleet home is one that holds a fleet.json, the config.json it is split out of, or the config.json.bak a split
// left, so a folder of the user's that happens to be named like one is never offered up for deletion
const isFleetHome = (p: string): boolean =>
  fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
  && [resolvePaths(p).fleetConfig, resolvePaths(p).legacyConfig, `${resolvePaths(p).legacyConfig}.bak`].some((f) => fs.existsSync(f));

export const fleetHomes = (homedir: string): string[] => fs.readdirSync(homedir)
  .filter((f) => f === path.basename(profileHome(PRIVATE, homedir)) || (f.startsWith(homePrefix) && isFleetName(f.slice(homePrefix.length))))
  .sort()
  .map((f) => path.join(homedir, f))
  .filter(isFleetHome);

export const configName = (home: string): string | undefined => {
  try { return peekConfig(resolvePaths(home)).name; } catch { return undefined; }
};

export const homesIn = (homedir: string): string[] => {
  try { return fleetHomes(homedir); } catch { return []; }
};

export const fleetNamed = (name: string, homedir = os.homedir()): string | undefined =>
  homesIn(homedir).find((h) => configName(h) === name);
