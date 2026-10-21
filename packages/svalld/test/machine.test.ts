import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDir, copiedRemedy, hardwareId, machineId, machineIdentity, mintMachineId, rebindMachine } from '../src/machine.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); delete process.env.SVALL_CONFIG_DIR; cleanHomes(); });

const mode = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8);
// a machine whose hardware id cannot be read, so the file holds the id alone
const none = (): undefined => undefined;

describe('machine id', () => {
  it('lives beside the machine registry, under the override when there is one', () => {
    expect(configDir()).toBe(path.join(process.env.HOME as string, '.config', 'svall'));
    process.env.SVALL_CONFIG_DIR = '/x';
    expect(configDir()).toBe('/x');
  });

  it('is made once and read back on every later call', () => {
    const dir = path.join(makeHome(), 'svall');
    const id = machineId(dir, none);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(machineId(dir, none)).toBe(id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))).toEqual({ id });
  });

  it('keeps the file and its directory to the owner', () => {
    const dir = path.join(makeHome(), 'svall');
    machineId(dir, none);
    expect(mode(dir)).toBe('700');
    expect(mode(path.join(dir, 'machine.json'))).toBe('600');
  });

  it('returns the id that reached disk first when two calls race', () => {
    const dir = path.join(makeHome(), 'svall');
    fs.mkdirSync(dir, { recursive: true });
    const first = crypto.randomUUID();
    // the file another process wrote lands between this call's existence check and its own write
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id: first }));
    expect(mintMachineId(dir, none)).toBe(first);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))).toEqual({ id: first });
  });

  it('puts the file in place only once its whole content is on disk', () => {
    const dir = path.join(makeHome(), 'svall');
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); });
    expect(() => mintMachineId(dir, none)).toThrow('EIO');
    expect(fs.existsSync(path.join(dir, 'machine.json'))).toBe(false);
    const id = mintMachineId(dir, none);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))).toEqual({ id });
  });

  it('never invents a second id over a file it cannot read', () => {
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, 'machine.json'), '{ id: nope');
    expect(() => machineId(dir, none)).toThrow(`invalid machine file ${path.join(dir, 'machine.json')}`);
    fs.writeFileSync(path.join(dir, 'machine.json'), '{"id":"trift"}');
    expect(() => machineId(dir, none)).toThrow(`invalid machine file ${path.join(dir, 'machine.json')}`);
    expect(() => machineId(dir, none)).toThrow('delete the file to mint a new machine id, or restore it from backup');
  });
});

describe('the hardware a machine id was made on', () => {
  const file = (dir: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'));

  it('is kept beside the id it was minted with, and nothing is where it cannot be read', () => {
    const dir = path.join(makeHome(), 'svall');
    const id = machineId(dir, () => 'HW-1');
    expect(file(dir)).toEqual({ id, hardwareId: 'HW-1' });
    const bare = path.join(makeHome(), 'svall');
    const plain = machineId(bare, none);
    expect(file(bare)).toEqual({ id: plain });
  });

  it('is written beside an id that names none on its first read, and never replaces the id or the hardware it names', () => {
    const dir = makeHome();
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id }), { mode: 0o600 });
    expect(machineId(dir, () => 'HW-1')).toBe(id);
    expect(file(dir)).toEqual({ id, hardwareId: 'HW-1' });
    expect(mode(path.join(dir, 'machine.json'))).toBe('600');
    expect(machineId(dir, () => 'HW-2')).toBe(id);
    expect(file(dir)).toEqual({ id, hardwareId: 'HW-1' });
  });

  it('names both hardware ids when the file was made on other hardware, and only then', () => {
    const dir = makeHome();
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id, hardwareId: 'HW-1' }));
    expect(machineIdentity(dir, () => 'HW-1')).toEqual({ id });
    expect(machineIdentity(dir, () => undefined)).toEqual({ id });
    expect(machineIdentity(dir, () => 'HW-2')).toEqual({ id, hardware: { stored: 'HW-1', actual: 'HW-2' } });
    rebindMachine('HW-2', dir);
    expect(file(dir)).toEqual({ id, hardwareId: 'HW-2' });
    expect(machineIdentity(dir, () => 'HW-2')).toEqual({ id });
  });

  it("reads the Mac's IOPlatformUUID and Linux's machine-id", () => {
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'ioreg'), '#!/bin/sh\nprintf \'+-o J316sAP  <class IOPlatformExpertDevice>\\n    "IOPlatformUUID" = "0A1B-2C3D"\\n\'\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    expect(hardwareId('darwin')).toBe('0A1B-2C3D');
    const files: Record<string, string> = { '/var/lib/dbus/machine-id': 'f00d\n' };
    vi.spyOn(fs, 'readFileSync').mockImplementation(((f: string) => {
      if (!(f in files)) throw Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });
      return files[f];
    }) as typeof fs.readFileSync);
    expect(hardwareId('linux')).toBe('f00d');
    files['/etc/machine-id'] = 'beef\n';
    expect(hardwareId('linux')).toBe('beef');
    delete files['/etc/machine-id'];
    delete files['/var/lib/dbus/machine-id'];
    expect(hardwareId('linux')).toBeUndefined();
  });

  it('tells a machine that shares another one\'s id how to get its own', () => {
    expect(copiedRemedy('/c/machine.json')).toBe(
      "this machine shares another machine's id; move /c/machine.json aside and restart svalld so this machine mints its own id, then `svall host add` it again from the controller, or on the controller `svall fleet recover --force-owner local` runs the fleet here",
    );
  });
});
