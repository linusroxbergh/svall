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
    expect(isProfileName('devops')).toBe(true);
    for (const kept of ['dev', 'dev-work']) expect(isProfileName(kept)).toBe(false);
    for (const bad of ['status', 'island', 'char', 'scribe', 'browser', 'mobile', 'setup', 'doctor', 'uninstall', 'help', 'Work', '2nd', 'a b', '', '-x']) {
      expect(isProfileName(bad)).toBe(false);
    }
  });

  it('maps private to ~/.svall and a name to ~/.svall-<name>', () => {
    expect(profileHome(PRIVATE, '/u')).toBe('/u/.svall');
    expect(profileHome('work', '/u')).toBe('/u/.svall-work');
  });

  it('suffixes the launchd label for every profile but private', () => {
    expect(profileLabel(PRIVATE)).toBe(LAUNCHD_LABEL);
    expect(profileLabel('work')).toBe(`${LAUNCHD_LABEL}.work`);
  });

  it('finds a fleet made under a name svall now keeps for a command, and a name it can move to', () => {
    const u = makeHome();
    for (const [name, file] of [['host', 'fleet.json'], ['handover', 'config.json'], ['work', 'fleet.json'], ['gateway', undefined]] as const) {
      fs.mkdirSync(path.join(u, `.svall-${name}`));
      if (file) fs.writeFileSync(path.join(u, `.svall-${name}`, file), '{}');
    }
    expect(reservedProfileHomes(u)).toEqual([
      { home: path.join(u, '.svall-handover'), name: 'handover', rename: 'handover-fleet' },
      { home: path.join(u, '.svall-host'), name: 'host', rename: 'host-fleet' },
    ]);
    expect(isProfileName('host-fleet')).toBe(true);
    expect(reservedProfileHomes(path.join(u, 'none'))).toEqual([]);
  });

  it('names the profile a home belongs to', () => {
    expect(profileOf('/u/.svall', '/u')).toBe(PRIVATE);
    expect(profileOf('/u/.svall-work', '/u')).toBe('work');
    expect(profileOf('/tmp/svall-dev', '/u')).toBe('svall-dev');
  });
});
