import { describe, expect, it } from 'vitest';
import { fleetNameProblem, isProfileName } from '../src/index.js';

describe('fleet names', () => {
  it('takes lower-case names and refuses svall commands and odd characters', () => {
    expect(isProfileName('work')).toBe(true);
    expect(isProfileName('side-2')).toBe(true);
    for (const bad of ['status', 'help', 'Work', '2nd', 'a b', '', '-x']) expect(isProfileName(bad)).toBe(false);
  });

  it('says why a name cannot be used, and nothing for one that can', () => {
    expect(fleetNameProblem('work', ['private'])).toBeUndefined();
    expect(fleetNameProblem('Work', [])).toMatch(/lowercase letters, digits and dashes/);
    expect(fleetNameProblem('', [])).toMatch(/lowercase letters/);
    expect(fleetNameProblem('status', [])).toBe('svall status is a command');
    // even with no ~/.svall yet, where profileHome would put a fleet named private
    expect(fleetNameProblem('private', [])).toBe('private is the fleet in ~/.svall');
    expect(isProfileName('private')).toBe(true);
    for (const kept of ['dev', 'dev-work']) expect(fleetNameProblem(kept, [])).toBe('dev names are kept for Svall Dev');
    expect(fleetNameProblem('devops', [])).toBeUndefined();
    expect(fleetNameProblem('work', ['private', 'work'])).toBe('another fleet is called work');
  });
});
