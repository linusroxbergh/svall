import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTarget, targetFor } from '../src/target.js';

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

  it('refuses a name that is not a profile', () => {
    expect(() => targetFor('status')).toThrow('invalid profile name status');
    expect(() => resolveTarget({ profile: 'Work' })).toThrow('invalid profile name Work');
  });
});
