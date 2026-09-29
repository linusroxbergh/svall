import { describe, expect, it } from 'vitest';
import { farProfile, resolveTarget, targetFor } from '../src/target.js';

describe('target', () => {
  it('prefers --profile, then $ARCHI_HOME, then private', () => {
    expect(resolveTarget({ profile: 'work', env: '/u/.archipelago-side', homedir: '/u' })).toEqual({ name: 'work', home: '/u/.archipelago-work', managed: true });
    expect(resolveTarget({ env: '/u/.archipelago-side', homedir: '/u' })).toEqual({ name: 'side', home: '/u/.archipelago-side', managed: true });
    expect(resolveTarget({ homedir: '/u' })).toEqual({ name: 'private', home: '/u/.archipelago', managed: true });
    expect(resolveTarget({ env: '', homedir: '/u' })).toEqual({ name: 'private', home: '/u/.archipelago', managed: true });
  });

  it('reads a trailing slash as the same home', () => {
    expect(resolveTarget({ env: '/u/.archipelago/', homedir: '/u' })).toEqual({ name: 'private', home: '/u/.archipelago', managed: true });
    expect(resolveTarget({ env: '/u/.archipelago-work/', homedir: '/u' })).toEqual({ name: 'work', home: '/u/.archipelago-work', managed: true });
  });

  it('marks a home that is not a profile directory unmanaged', () => {
    expect(resolveTarget({ env: '/tmp/archi-dev', homedir: '/u' })).toEqual({ name: 'archi-dev', home: '/tmp/archi-dev', managed: false });
    expect(resolveTarget({ env: '/tmp/archi dev', homedir: '/u' })).toEqual({ name: 'archi dev', home: '/tmp/archi dev', managed: false });
  });

  it('asks a far machine for the named fleet the target is, and for its default for the private one or a home that is no profile\'s', () => {
    expect(farProfile(resolveTarget({ env: '/u/.archipelago-side', homedir: '/u' }))).toBe('side');
    expect(farProfile(resolveTarget({ profile: 'work', homedir: '/u' }))).toBe('work');
    expect(farProfile(resolveTarget({ homedir: '/u' }))).toBeUndefined();
    expect(farProfile(resolveTarget({ env: '/tmp/archi-dev', homedir: '/u' }))).toBeUndefined();
  });

  it('refuses a name that is not a profile', () => {
    expect(() => targetFor('status')).toThrow('invalid profile name status');
    expect(() => resolveTarget({ profile: 'Work' })).toThrow('invalid profile name Work');
  });
});
