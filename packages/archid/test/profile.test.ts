import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isProfileName, LAUNCHD_LABEL, PRIVATE, profileHome, profileLabel, profileOf, reservedProfileHomes } from '../src/profile.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

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

  it('finds a fleet made under a name archi now keeps for a command, and a name it can move to', () => {
    const u = makeHome();
    for (const [name, file] of [['host', 'fleet.json'], ['handover', 'config.json'], ['work', 'fleet.json'], ['gateway', undefined]] as const) {
      fs.mkdirSync(path.join(u, `.archipelago-${name}`));
      if (file) fs.writeFileSync(path.join(u, `.archipelago-${name}`, file), '{}');
    }
    expect(reservedProfileHomes(u)).toEqual([
      { home: path.join(u, '.archipelago-handover'), name: 'handover', rename: 'handover-fleet' },
      { home: path.join(u, '.archipelago-host'), name: 'host', rename: 'host-fleet' },
    ]);
    expect(isProfileName('host-fleet')).toBe(true);
    expect(reservedProfileHomes(path.join(u, 'none'))).toEqual([]);
  });

  it('names the profile a home belongs to', () => {
    expect(profileOf('/u/.archipelago', '/u')).toBe(PRIVATE);
    expect(profileOf('/u/.archipelago-work', '/u')).toBe('work');
    expect(profileOf('/tmp/archi-dev', '/u')).toBe('archi-dev');
  });
});
