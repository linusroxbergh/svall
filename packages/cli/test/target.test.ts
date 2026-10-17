import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { farProfile, resolveTarget, targetFor } from '../src/target.js';

describe('target', () => {
  it('prefers --profile, then $SVALL_HOME, then private', () => {
    expect(resolveTarget({ profile: 'work', env: '/u/.svall-side', homedir: '/u' })).toEqual({ name: 'work', home: '/u/.svall-work', managed: true });
    expect(resolveTarget({ env: '/u/.svall-side', homedir: '/u' })).toEqual({ name: 'side', home: '/u/.svall-side', managed: true });
    expect(resolveTarget({ homedir: '/u' })).toEqual({ name: 'private', home: '/u/.svall', managed: true });
    expect(resolveTarget({ env: '', homedir: '/u' })).toEqual({ name: 'private', home: '/u/.svall', managed: true });
  });

  it('reads a trailing slash as the same home', () => {
    expect(resolveTarget({ env: '/u/.svall/', homedir: '/u' })).toEqual({ name: 'private', home: '/u/.svall', managed: true });
    expect(resolveTarget({ env: '/u/.svall-work/', homedir: '/u' })).toEqual({ name: 'work', home: '/u/.svall-work', managed: true });
  });

  it('marks a home that is not a profile directory unmanaged', () => {
    expect(resolveTarget({ env: '/tmp/svall-dev', homedir: '/u' })).toEqual({ name: 'svall-dev', home: '/tmp/svall-dev', managed: false });
    expect(resolveTarget({ env: '/tmp/svall dev', homedir: '/u' })).toEqual({ name: 'svall dev', home: '/tmp/svall dev', managed: false });
  });

  it('opens a fleet by the name its config gives it, and by its directory first', () => {
    const u = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-target-'));
    const fleet = (dir: string, config: object) => {
      fs.mkdirSync(path.join(u, dir));
      fs.writeFileSync(path.join(u, dir, 'config.json'), JSON.stringify(config));
    };
    fleet('.svall', { name: 'home' });
    fleet('.svall-work', { name: 'office' });
    fleet('.svall-side', {});
    expect(targetFor('home', u)).toEqual({ name: 'private', home: path.join(u, '.svall'), managed: true });
    expect(targetFor('office', u)).toEqual({ name: 'work', home: path.join(u, '.svall-work'), managed: true });
    expect(targetFor('side', u)).toEqual({ name: 'side', home: path.join(u, '.svall-side'), managed: true });
    // a config edited by hand can name a fleet after another's directory; the directory wins
    fs.writeFileSync(path.join(u, '.svall-side', 'config.json'), JSON.stringify({ name: 'work' }));
    expect(targetFor('work', u)).toEqual({ name: 'work', home: path.join(u, '.svall-work'), managed: true });
    expect(targetFor('new', u)).toEqual({ name: 'new', home: path.join(u, '.svall-new'), managed: true });
    // bare svall means ~/.svall, set up or not, whatever another config calls itself
    fs.rmSync(path.join(u, '.svall'), { recursive: true });
    fs.writeFileSync(path.join(u, '.svall-side', 'config.json'), JSON.stringify({ name: 'private' }));
    expect(resolveTarget({ homedir: u })).toEqual({ name: 'private', home: path.join(u, '.svall'), managed: true });
    fs.rmSync(u, { recursive: true, force: true });
  });

  it('opens a fleet split into fleet.json by its name and by its directory first, the same', () => {
    const u = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-target-'));
    const fleet = (dir: string, name: string) => {
      fs.mkdirSync(path.join(u, dir));
      fs.writeFileSync(path.join(u, dir, 'fleet.json'), JSON.stringify({ id: crypto.randomUUID(), name }));
    };
    fleet('.svall-work', 'office');
    fleet('.svall-side', 'work');
    expect(targetFor('office', u)).toEqual({ name: 'work', home: path.join(u, '.svall-work'), managed: true });
    expect(targetFor('work', u)).toEqual({ name: 'work', home: path.join(u, '.svall-work'), managed: true });
    fs.rmSync(u, { recursive: true, force: true });
  });

  it('asks a far machine for the named fleet the target is, and for its default for the private one or a home that is no profile\'s', () => {
    expect(farProfile(resolveTarget({ env: '/u/.svall-side', homedir: '/u' }))).toBe('side');
    expect(farProfile(resolveTarget({ profile: 'work', homedir: '/u' }))).toBe('work');
    expect(farProfile(resolveTarget({ homedir: '/u' }))).toBeUndefined();
    expect(farProfile(resolveTarget({ env: '/tmp/svall-dev', homedir: '/u' }))).toBeUndefined();
  });

  it('refuses a name that is not a profile', () => {
    expect(() => targetFor('status')).toThrow('invalid profile name status');
    expect(() => resolveTarget({ profile: 'Work' })).toThrow('invalid profile name Work');
  });
});
