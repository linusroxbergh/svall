import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetConfig, NodeConfig } from '@svall/protocol';
import { InvalidConfig, configRefusal, configRelinked, configuredMainAgent, initConfig, loadConfig, patchFleetConfig, peekConfig, reservedFleetNames } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LEGACY = '{\n  "port": 47900,\n  "host": "0.0.0.0",\n  "shell": "/bin/sh",\n  "defaultCwd": "/w",\n  "mainAgent": "codex",\n  "mobile": { "logins": ["you@example.com"], "httpsPort": 10000 },\n  "somethingOld": true\n}\n';

const mode = (file: string): string => (fs.statSync(file).mode & 0o777).toString(8);
const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A fleet home holding only the legacy file. */
function legacyHome(text = LEGACY, name?: string): string {
  const root = makeHome();
  const home = name === undefined ? root : path.join(root, `.svall-${name}`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), text);
  return home;
}

describe('splitting config.json', () => {
  it('writes both files, keeps the legacy one byte-exact and routes every field', () => {
    const home = legacyHome();
    const p = resolvePaths(home);
    const config = loadConfig(p);

    expect(config.port).toBe(47900);
    expect(config.host).toBe('0.0.0.0');
    expect(config.shell).toBe('/bin/sh');
    expect(config.defaultCwd).toBe('/w');
    expect(config.mainAgent).toBe('codex');
    expect(config.mobile).toMatchObject({ logins: ['you@example.com'], httpsPort: 10000 });
    expect(config.id).toMatch(UUID);

    // only what the file held: a default is the schema's, and a later release may change it
    expect(read(p.fleetConfig)).toEqual({ id: config.id, defaultCwd: '/w', mainAgent: 'codex', mobile: { logins: ['you@example.com'] } });
    expect(read(p.nodeConfig)).toEqual({ port: 47900, host: '0.0.0.0', shell: '/bin/sh', mobile: { httpsPort: 10000 } });
    expect(read(p.nodeConfig)).not.toHaveProperty('defaultCwd');

    expect(fs.existsSync(p.legacyConfig)).toBe(false);
    expect(fs.readFileSync(`${p.legacyConfig}.bak`, 'utf8')).toBe(LEGACY);
  });

  it('keeps the two files to the owner', () => {
    const p = resolvePaths(legacyHome());
    loadConfig(p);
    expect(mode(p.fleetConfig)).toBe('600');
    expect(mode(p.nodeConfig)).toBe('600');
  });

  it('drops keys no schema knows, and the backup keeps them', () => {
    const p = resolvePaths(legacyHome());
    loadConfig(p);
    expect(read(p.fleetConfig)).not.toHaveProperty('somethingOld');
    expect(read(p.nodeConfig)).not.toHaveProperty('somethingOld');
    expect(read(`${p.legacyConfig}.bak`).somethingOld).toBe(true);
    expect(loadConfig(p)).not.toHaveProperty('somethingOld');
  });

  it('splits a named fleet the same way as the private one', () => {
    for (const p of [resolvePaths(legacyHome()), resolvePaths(legacyHome(LEGACY, 'work'))]) {
      expect(loadConfig(p).port).toBe(47900);
      expect(read(p.fleetConfig).id).toMatch(UUID);
    }
  });

  it('gives every fleet its own id and keeps it across loads', () => {
    const first = resolvePaths(legacyHome());
    const second = resolvePaths(legacyHome());
    const id = loadConfig(first).id;
    expect(loadConfig(first).id).toBe(id);
    expect(loadConfig(second).id).not.toBe(id);
  });

  it('refuses to half-migrate a config.json that is not JSON', () => {
    const p = resolvePaths(legacyHome('{ port: 47900 '));
    expect(() => loadConfig(p)).toThrow(`invalid config ${p.legacyConfig}`);
    expect(fs.existsSync(p.fleetConfig)).toBe(false);
    expect(fs.existsSync(p.nodeConfig)).toBe(false);
    expect(fs.existsSync(p.legacyConfig)).toBe(true);
  });

  it('refuses a config.json the schema rejects', () => {
    const p = resolvePaths(legacyHome('{"mobile":{"httpsPort":0}}'));
    expect(() => loadConfig(p)).toThrow(`invalid config ${p.legacyConfig}`);
    expect(fs.existsSync(p.fleetConfig)).toBe(false);
  });

  it('reads a name svall now keeps for a command as no name, and splits the rest', () => {
    const text = '{"name":"host","mainAgent":"codex"}';
    const p = resolvePaths(legacyHome(text));
    expect(peekConfig(p)).toMatchObject({ mainAgent: 'codex' });
    expect(peekConfig(p).name).toBeUndefined();
    expect(configuredMainAgent(p)).toBe('codex');
    expect(fs.existsSync(p.fleetConfig)).toBe(false);

    const config = loadConfig(p);
    expect(config.name).toBeUndefined();
    expect(read(p.fleetConfig)).toEqual({ id: config.id, mainAgent: 'codex' });
    expect(fs.readFileSync(`${p.legacyConfig}.bak`, 'utf8')).toBe(text);
  });

  it('refuses a config.json whose name no fleet can go by', () => {
    const p = resolvePaths(legacyHome('{"name":"Home Base"}'));
    expect(() => peekConfig(p)).toThrow(/name: /);
    expect(() => loadConfig(p)).toThrow(`invalid config ${p.legacyConfig}`);
    expect(fs.existsSync(p.fleetConfig)).toBe(false);
  });

  it('names each fleet home whose config.json named it with a word svall now keeps, until fleet.json names it', () => {
    const root = makeHome();
    const home = (dir: string, text: string): string => {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'config.json'), text);
      return path.join(root, dir);
    };
    const [own, work] = [home('.svall', '{"name":"host"}'), home('.svall-work', '{"name":"version"}')];
    home('.svall-side', '{"name":"side"}');
    expect(reservedFleetNames(root)).toEqual([{ home: own, name: 'host' }, { home: work, name: 'version' }]);
    // the backup the split leaves still says so
    loadConfig(resolvePaths(own));
    expect(reservedFleetNames(root)).toEqual([{ home: own, name: 'host' }, { home: work, name: 'version' }]);
    patchFleetConfig(resolvePaths(own).fleetConfig, { name: 'base' });
    expect(reservedFleetNames(root)).toEqual([{ home: work, name: 'version' }]);
  });
});

describe('finishing an interrupted split', () => {
  it('splits a backup that a crash left without either new file', () => {
    const p = resolvePaths(makeHome());
    fs.writeFileSync(`${p.legacyConfig}.bak`, LEGACY);

    const config = loadConfig(p);
    expect(config.port).toBe(47900);
    expect(config.defaultCwd).toBe('/w');
    expect(read(p.fleetConfig).id).toMatch(UUID);
    expect(fs.readFileSync(`${p.legacyConfig}.bak`, 'utf8')).toBe(LEGACY);
  });

  it('rewrites a node.json a crash left behind out of the backup', () => {
    const p = resolvePaths(makeHome());
    fs.writeFileSync(`${p.legacyConfig}.bak`, LEGACY);
    fs.writeFileSync(p.nodeConfig, JSON.stringify(NodeConfig.parse({ port: 100 })));

    expect(loadConfig(p).port).toBe(47900);
    expect(read(p.fleetConfig).id).toMatch(UUID);
  });

  it('reads nothing more once both files are there', () => {
    const p = resolvePaths(legacyHome());
    const id = loadConfig(p).id;
    const before = fs.readFileSync(p.fleetConfig, 'utf8');
    fs.writeFileSync(`${p.legacyConfig}.bak`, '{"port":1}\n');

    expect(loadConfig(p).id).toBe(id);
    expect(loadConfig(p).port).toBe(47900);
    expect(fs.readFileSync(p.fleetConfig, 'utf8')).toBe(before);
  });

  it('refuses a config.json written after the split rather than move it aside unread', () => {
    const p = resolvePaths(legacyHome());
    const fleet = FleetConfig.parse({ id: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', defaultCwd: '/kept' });
    fs.writeFileSync(p.fleetConfig, JSON.stringify(fleet));

    // the class that has a stopped svalld wait for the fix instead of restarting
    expect(() => loadConfig(p)).toThrow(InvalidConfig);
    expect(() => loadConfig(p)).toThrow(`${p.legacyConfig} is not read any more`);
    expect(() => loadConfig(p)).toThrow(p.nodeConfig);
    expect(fs.readFileSync(p.legacyConfig, 'utf8')).toBe(LEGACY);
    expect(fs.existsSync(`${p.legacyConfig}.bak`)).toBe(false);
  });

  it('refuses to split over a backup that is already there', () => {
    const p = resolvePaths(legacyHome());
    fs.writeFileSync(`${p.legacyConfig}.bak`, '{"port":1}\n');

    expect(() => loadConfig(p)).toThrow(InvalidConfig);
    expect(() => loadConfig(p)).toThrow(`${p.legacyConfig}.bak is in the way`);
    expect(fs.readFileSync(`${p.legacyConfig}.bak`, 'utf8')).toBe('{"port":1}\n');
    expect(fs.readFileSync(p.legacyConfig, 'utf8')).toBe(LEGACY);
    expect(fs.existsSync(p.fleetConfig)).toBe(false);
    expect(fs.existsSync(p.nodeConfig)).toBe(false);
  });
});

describe('a config.json a dotfile manager links in', () => {
  /** A fleet home whose config.json links to a file kept elsewhere, as stow and home-manager keep it. */
  function linkedHome(): { p: ReturnType<typeof resolvePaths>; dotfile: string } {
    const p = resolvePaths(makeHome());
    const dotfile = path.join(makeHome(), 'svall.json');
    fs.writeFileSync(dotfile, LEGACY);
    fs.symlinkSync(dotfile, p.legacyConfig);
    return { p, dotfile };
  }

  it('is split through its link, and ignored, without a word, once put back as a link to the same file', () => {
    const { p, dotfile } = linkedHome();
    const id = loadConfig(p).id;
    expect(fs.lstatSync(`${p.legacyConfig}.bak`).isSymbolicLink()).toBe(true);
    expect(configRelinked(p)).toBe(false);

    // `stow -R` or `home-manager switch` puts the link back
    fs.symlinkSync(dotfile, p.legacyConfig);
    expect(configRelinked(p)).toBe(true);
    expect(configRefusal(p, fs.existsSync)).toBeUndefined();
    // the daemon says so once, as it starts; each save and setup reads the files again
    const said = vi.spyOn(process.stderr, 'write');
    try {
      expect(loadConfig(p)).toMatchObject({ id, port: 47900 });
      expect(said).not.toHaveBeenCalled();
    } finally {
      said.mockRestore();
    }
    expect(fs.lstatSync(p.legacyConfig).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(dotfile, 'utf8')).toBe(LEGACY);
  });

  it('is refused beside fleet.json when it links anywhere else', () => {
    const { p } = linkedHome();
    loadConfig(p);
    const other = path.join(makeHome(), 'other.json');
    fs.writeFileSync(other, LEGACY);
    fs.symlinkSync(other, p.legacyConfig);

    expect(configRelinked(p)).toBe(false);
    expect(() => loadConfig(p)).toThrow(`${p.legacyConfig} is not read any more`);
    expect(fs.lstatSync(p.legacyConfig).isSymbolicLink()).toBe(true);
  });
});

describe('a fleet with nothing to split', () => {
  it('writes both files with the defaults', () => {
    const p = resolvePaths(makeHome());
    const config = loadConfig(p);
    expect(config).toMatchObject({ host: '127.0.0.1', defaultCwd: '~' });
    // no port: the daemon takes its default, or a free one while that is held
    expect(config.port).toBeUndefined();
    expect(config.handover).toEqual({ enabled: false, exclude: [], excludeDefaults: true, transferFleetEnv: false });
    expect(config.mobile).toEqual({ logins: [], origins: [] });
    // the defaults apply as the files are read, so a later release's defaults reach this fleet
    expect(read(p.fleetConfig)).toEqual({ id: config.id });
    expect(read(p.nodeConfig)).toEqual({});
  });

  it('defaults without writing when the home does not exist', () => {
    const p = resolvePaths(path.join(makeHome(), 'gone'));
    expect(loadConfig(p)).toMatchObject({ host: '127.0.0.1', defaultCwd: '~' });
    expect(fs.existsSync(p.home)).toBe(false);
  });

  it('seeds node.json with the port a named fleet was set up on', () => {
    const p = resolvePaths(makeHome());
    expect(initConfig(p, { port: 0 })).toEqual([p.nodeConfig, p.fleetConfig]);
    expect(read(p.nodeConfig).port).toBe(0);
    expect(loadConfig(p).port).toBe(0);
  });
});
