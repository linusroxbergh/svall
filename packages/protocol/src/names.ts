// svall's own commands, which `svall <name>` would run instead of opening a fleet by that name
const RESERVED = ['status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'agent', 'doctor', 'uninstall', 'help'];
const NAME = /^[a-z][a-z0-9-]*$/;
// Svall Dev's homes are ~/.svall-dev and ~/.svall-dev-<name>, so no release fleet may be named into them
const DEV = /^dev(-|$)/;

export function isProfileName(name: string): boolean {
  return NAME.test(name) && !RESERVED.includes(name) && !DEV.test(name);
}

/** Why `name` cannot name a fleet, given the names the other fleets go by; undefined when it can. */
export function fleetNameProblem(name: string, taken: string[]): string | undefined {
  if (!NAME.test(name)) return 'use lowercase letters, digits and dashes, starting with a letter';
  if (DEV.test(name)) return 'dev names are kept for Svall Dev';
  if (RESERVED.includes(name)) return `svall ${name} is a command`;
  // the profile name of ~/.svall, so no other fleet may go by it
  if (name === 'private') return 'private is the fleet in ~/.svall';
  if (taken.includes(name)) return `another fleet is called ${name}`;
  return undefined;
}
