import fs from 'node:fs';
import path from 'node:path';
import { fleetNamed } from '@svall/svalld/fleets';
import { isProfileName, PRIVATE, profileHome, profileOf } from '@svall/svalld/profile';

// managed is false for a home that is not a profile's own directory: it gets no launchd agent
export type Target = { name: string; home: string; managed: boolean };

// a fleet's directory names it first, then the name its config gives it
export function targetFor(name: string, homedir?: string): Target {
  if (!isProfileName(name)) throw new Error(`invalid profile name ${name}`);
  const home = profileHome(name, homedir);
  const named = name === PRIVATE || fs.existsSync(path.join(home, 'config.json')) ? undefined : fleetNamed(name, homedir);
  return named ? { name: profileOf(named, homedir), home: named, managed: true } : { name, home, managed: true };
}

export function resolveTarget(o: { profile?: string; env?: string; homedir?: string }): Target {
  if (o.profile !== undefined) return targetFor(o.profile, o.homedir);
  if (o.env) {
    const home = path.resolve(o.env);
    const name = profileOf(home, o.homedir);
    return { name, home, managed: isProfileName(name) && profileHome(name, o.homedir) === home };
  }
  return targetFor(PRIVATE, o.homedir);
}
