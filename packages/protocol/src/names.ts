// svall's own commands, which `svall <name>` would run instead of opening a fleet by that name
const RESERVED = ['status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'agent', 'doctor', 'uninstall', 'help'];
const NAME = /^[a-z][a-z0-9-]*$/;

export function isProfileName(name: string): boolean {
  return NAME.test(name) && !RESERVED.includes(name);
}

/** Why `name` cannot name a fleet, given the names the other fleets go by; undefined when it can. */
export function fleetNameProblem(name: string, taken: string[]): string | undefined {
  if (!NAME.test(name)) return 'use lowercase letters, digits and dashes, starting with a letter';
  if (RESERVED.includes(name)) return `svall ${name} is a command`;
  // the profile name of ~/.svall, so no other fleet may go by it
  if (name === 'private') return 'private is the fleet in ~/.svall';
  if (taken.includes(name)) return `another fleet is called ${name}`;
  return undefined;
}
