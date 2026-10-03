import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDir, machineId, mintMachineId } from '../src/machine.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); delete process.env.SVALL_CONFIG_DIR; cleanHomes(); });

const mode = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8);

describe('machine id', () => {
  it('lives beside the machine registry, under the override when there is one', () => {
    expect(configDir()).toBe(path.join(process.env.HOME as string, '.config', 'svall'));
    process.env.SVALL_CONFIG_DIR = '/x';
    expect(configDir()).toBe('/x');
  });

  it('is made once and read back on every later call', () => {
    const dir = path.join(makeHome(), 'svall');
    const id = machineId(dir);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(machineId(dir)).toBe(id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))).toEqual({ id });
  });

  it('keeps the file and its directory to the owner', () => {
    const dir = path.join(makeHome(), 'svall');
    machineId(dir);
    expect(mode(dir)).toBe('700');
    expect(mode(path.join(dir, 'machine.json'))).toBe('600');
  });

  it('returns the id that reached disk first when two calls race', () => {
    const dir = path.join(makeHome(), 'svall');
    fs.mkdirSync(dir, { recursive: true });
    const first = crypto.randomUUID();
    // the file another process wrote lands between this call's existence check and its own write
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id: first }));
    expect(mintMachineId(dir)).toBe(first);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))).toEqual({ id: first });
  });

  it('puts the file in place only once its whole content is on disk', () => {
    const dir = path.join(makeHome(), 'svall');
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); });
    expect(() => mintMachineId(dir)).toThrow('EIO');
    expect(fs.existsSync(path.join(dir, 'machine.json'))).toBe(false);
    const id = mintMachineId(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))).toEqual({ id });
  });

  it('never invents a second id over a file it cannot read', () => {
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, 'machine.json'), '{ id: nope');
    expect(() => machineId(dir)).toThrow(`invalid machine file ${path.join(dir, 'machine.json')}`);
    fs.writeFileSync(path.join(dir, 'machine.json'), '{"id":"trift"}');
    expect(() => machineId(dir)).toThrow(`invalid machine file ${path.join(dir, 'machine.json')}`);
    expect(() => machineId(dir)).toThrow('delete the file to mint a new machine id, or restore it from backup');
  });
});
