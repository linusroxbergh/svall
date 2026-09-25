import path from 'node:path';
import { isProfileName, PRIVATE, profileHome, profileOf } from '@archipelago/archid/profile';

// managed is false for a home that is not a profile's own directory: it gets no launchd agent
export type Target = { name: string; home: string; managed: boolean };

export function targetFor(name: string, homedir?: string): Target {
  if (!isProfileName(name)) throw new Error(`invalid profile name ${name}`);
  return { name, home: profileHome(name, homedir), managed: true };
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
