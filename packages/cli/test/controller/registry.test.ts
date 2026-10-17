import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineRecord } from '@svall/protocol';
import { svallHome } from '@svall/svalld/paths';
import { MachineRegistry } from '../../src/controller/registry.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/svall-t-'); made.push(d); return d; };
afterEach(() => { delete process.env.SVALL_CONFIG_DIR; for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const mode = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8);
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'machines.json'), 'utf8'));

const trift: MachineRecord = {
  name: 'trift',
  ssh: 'trift',
  platform: 'linux',
  arch: 'arm64',
  home: '/home/linus',
  svallBase: '/home/linus/.local/share/svall',
  gateway: true,
};

describe('machine registry', () => {
  it('writes the local machine on the first load and reads it back after', () => {
    const dir = path.join(tmp(), 'svall');
    const registry = MachineRegistry.load(dir, { hostname: 'Kolvik.local' });
    expect(registry.localMachine()).toEqual({
      name: 'kolvik',
      platform: process.platform === 'linux' ? 'linux' : 'darwin',
      arch: process.arch,
      home: os.homedir(),
      svallBase: svallHome(),
      gateway: false,
    });
    expect(registry.localId).toBe(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8')).id);
    expect(read(dir)).toEqual({ machines: { [registry.localId]: registry.localMachine() } });
    expect(mode(dir)).toBe('700');
    expect(mode(path.join(dir, 'machines.json'))).toBe('600');

    const again = MachineRegistry.load(dir, { hostname: 'other' });
    expect(again.localId).toBe(registry.localId);
    expect(again.localMachine().name).toBe('kolvik');
    expect(again.recovered).toBeUndefined();
  });

  it('keeps a local machine whose home directory has a space in it', () => {
    const dir = path.join(tmp(), 'svall');
    const home = path.join(tmp(), "Linus's home");
    fs.mkdirSync(home, { recursive: true });
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(MachineRegistry.load(dir, { hostname: 'kolvik' }).localMachine().home).toBe(home);
      const again = MachineRegistry.load(dir, { hostname: 'kolvik' });
      expect(again.recovered).toBeUndefined();
      expect(again.localMachine().home).toBe(home);
    } finally {
      if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    }
  });

  it('loads a registry an earlier build wrote with named path roots, and saves it without them', () => {
    const dir = path.join(tmp(), 'svall');
    const first = MachineRegistry.load(dir, { hostname: 'kolvik' });
    const remote = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    fs.writeFileSync(path.join(dir, 'machines.json'), JSON.stringify({
      machines: {
        [first.localId]: { ...first.localMachine(), pathRoots: { home: os.homedir() } },
        [remote]: { ...trift, pathRoots: { home: '/home/linus', work: '/srv/work' } },
      },
    }));
    const again = MachineRegistry.load(dir);
    expect(again.recovered).toBeUndefined();
    expect(again.get('trift')?.record).toEqual(trift);
    expect(again.localMachine()).toEqual(first.localMachine());
    again.save();
    expect(JSON.stringify(read(dir))).not.toContain('pathRoots');
  });

  it('falls back to the platform when the hostname gives no usable name', () => {
    const fallback = process.platform === 'linux' ? 'linux' : 'mac';
    expect(MachineRegistry.load(path.join(tmp(), 'c'), { hostname: '42' }).localMachine().name).toBe(fallback);
    expect(MachineRegistry.load(path.join(tmp(), 'c'), { hostname: 'local' }).localMachine().name).toBe(fallback);
    expect(MachineRegistry.load(path.join(tmp(), 'c'), { hostname: "Linus's MacBook Pro.lan" }).localMachine().name).toBe('linus-s-macbook-pro');
  });

  it('takes the directory from the environment when none is given', () => {
    const dir = path.join(tmp(), 'svall');
    process.env.SVALL_CONFIG_DIR = dir;
    expect(MachineRegistry.load().localId).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'machines.json'))).toBe(true);
  });

  it('adds, finds, renames and removes a remote machine', () => {
    const dir = path.join(tmp(), 'svall');
    const registry = MachineRegistry.load(dir, { hostname: 'kolvik' });
    const added = registry.add(trift);
    expect(added.record).toEqual(trift);
    expect(registry.get('trift')).toEqual(added);
    expect(registry.get(added.id)).toEqual(added);
    expect(registry.list().map((m) => m.record.name).sort()).toEqual(['kolvik', 'trift']);
    expect(registry.get('nowhere')).toBeUndefined();

    registry.rename('trift', 'gateway-box');
    registry.save();
    expect(read(dir).machines[added.id].name).toBe('gateway-box');

    const reloaded = MachineRegistry.load(dir, { hostname: 'kolvik' });
    expect(reloaded.get('gateway-box')?.id).toBe(added.id);
    reloaded.remove('gateway-box');
    reloaded.save();
    expect(Object.keys(read(dir).machines)).toEqual([reloaded.localId]);
  });

  it('keeps an id the machine already has when one is given', () => {
    const registry = MachineRegistry.load(path.join(tmp(), 'c'), { hostname: 'kolvik' });
    const id = '9b4d4d3e-5f6a-4c2b-8f11-7a2c1d0e5b33';
    expect(registry.add(trift, id).id).toBe(id);
    expect(registry.get('trift')?.id).toBe(id);
    expect(() => registry.add({ ...trift, name: 'trift2' }, id)).toThrow(id);
  });

  it('resolves local to the invoking machine and never stores it as a name', () => {
    const registry = MachineRegistry.load(path.join(tmp(), 'c'), { hostname: 'kolvik' });
    expect(registry.get('local')).toEqual({ id: registry.localId, record: registry.localMachine() });
    expect(() => registry.add({ ...trift, name: 'local' })).toThrow(/local/);
    expect(() => registry.rename('kolvik', 'local')).toThrow(/local/);
  });

  it('refuses a duplicate name, an invalid record and losing the local machine', () => {
    const registry = MachineRegistry.load(path.join(tmp(), 'c'), { hostname: 'kolvik' });
    registry.add(trift);
    expect(() => registry.add({ ...trift, ssh: 'other' })).toThrow(/trift/);
    expect(() => registry.rename('trift', 'kolvik')).toThrow(/kolvik/);
    expect(() => registry.add({ ...trift, name: 'Trift' })).toThrow();
    expect(() => registry.remove(registry.localId)).toThrow(/local machine/);
    expect(() => registry.rename('nowhere', 'trift2')).toThrow(/nowhere/);
    expect(() => registry.remove('nowhere')).toThrow(/nowhere/);
  });

  it('moves a registry it cannot read aside and starts a fresh one', () => {
    const dir = path.join(tmp(), 'svall');
    fs.mkdirSync(dir, { recursive: true });
    const broken = '{ "machines": ';
    fs.writeFileSync(path.join(dir, 'machines.json'), broken);
    const registry = MachineRegistry.load(dir, { hostname: 'kolvik' });
    expect(registry.recovered).toMatch(/machines\.json\.broken-/);
    expect(fs.readFileSync(registry.recovered as string, 'utf8')).toBe(broken);
    expect(read(dir)).toEqual({ machines: { [registry.localId]: registry.localMachine() } });
  });

  it('says where a registry it could not read went, when it moves it and at every load after, and in what finds no machine', () => {
    const dir = path.join(tmp(), 'svall');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'machines.json'), '{ "machines": ');
    const warned: string[] = [];
    const first = MachineRegistry.load(dir, { hostname: 'kolvik', warn: (l) => warned.push(l) });
    expect(warned).toEqual([expect.stringContaining(`was moved to ${first.recovered}`)]);
    const later = MachineRegistry.load(dir, { hostname: 'kolvik', warn: (l) => warned.push(l) });
    expect(warned).toHaveLength(1);
    expect(later.recovered).toBe(first.recovered);
    expect(later.setAside()).toContain(first.recovered);
    expect(MachineRegistry.load(path.join(tmp(), 'fresh'), { hostname: 'kolvik' }).setAside()).toBe('');
  });

  it('recovers the same way from a registry where two machines share a name', () => {
    const dir = path.join(tmp(), 'svall');
    fs.mkdirSync(dir, { recursive: true });
    const twice = JSON.stringify({ machines: { '9b4d4d3e-5f6a-4c2b-8f11-7a2c1d0e5b33': trift, 'b0f2a1c4-3d5e-4a6b-9c8d-1e2f3a4b5c6d': { ...trift, ssh: 'trift2' } } });
    fs.writeFileSync(path.join(dir, 'machines.json'), twice);
    const registry = MachineRegistry.load(dir, { hostname: 'kolvik' });
    expect(registry.recovered).toMatch(/machines\.json\.broken-/);
    expect(fs.readFileSync(registry.recovered as string, 'utf8')).toBe(twice);
    expect(registry.list()).toEqual([{ id: registry.localId, record: registry.localMachine() }]);
  });

  it('recovers the same way from a registry that does not match the schema', () => {
    const dir = path.join(tmp(), 'svall');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'machines.json'), JSON.stringify({ machines: { trift: { name: 'trift' } } }));
    const registry = MachineRegistry.load(dir, { hostname: 'kolvik' });
    expect(registry.recovered).toMatch(/machines\.json\.broken-/);
    expect(registry.list()).toEqual([{ id: registry.localId, record: registry.localMachine() }]);
  });
});
