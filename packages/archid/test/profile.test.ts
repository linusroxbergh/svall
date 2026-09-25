import { describe, expect, it } from 'vitest';
import { isProfileName, LAUNCHD_LABEL, PRIVATE, profileHome, profileLabel, profileOf } from '../src/profile.js';

describe('profile', () => {
  it('accepts lower-case names and refuses subcommands and odd characters', () => {
    expect(isProfileName('work')).toBe(true);
    expect(isProfileName('side-2')).toBe(true);
    expect(isProfileName(PRIVATE)).toBe(true);
    for (const bad of ['status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'doctor', 'uninstall', 'help', 'Work', '2nd', 'a b', '', '-x']) {
      expect(isProfileName(bad)).toBe(false);
    }
  });

  it('maps private to ~/.archipelago and a name to ~/.archipelago-<name>', () => {
    expect(profileHome(PRIVATE, '/u')).toBe('/u/.archipelago');
    expect(profileHome('work', '/u')).toBe('/u/.archipelago-work');
  });

  it('suffixes the launchd label for every profile but private', () => {
    expect(profileLabel(PRIVATE)).toBe(LAUNCHD_LABEL);
    expect(profileLabel('work')).toBe(`${LAUNCHD_LABEL}.work`);
  });

  it('names the profile a home belongs to', () => {
    expect(profileOf('/u/.archipelago', '/u')).toBe(PRIVATE);
    expect(profileOf('/u/.archipelago-work', '/u')).toBe('work');
    expect(profileOf('/tmp/archi-dev', '/u')).toBe('archi-dev');
  });
});
