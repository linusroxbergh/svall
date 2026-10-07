import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installOpencodePlugin, linkOpencodeConfig, opencodePaths, opencodePluginCurrent, removeOpencodePlugin } from '../src/opencode/install.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('the OpenCode plugin file', () => {
  it("lives in OpenCode's plugins folder under XDG_CONFIG_HOME, named for this build", () => {
    const o = opencodePaths({ XDG_CONFIG_HOME: '/x/config', XDG_DATA_HOME: '/x/data' }, '/u');
    expect(o).toEqual({ dir: '/x/config/opencode', plugin: '/x/config/opencode/plugins/svall.js', data: '/x/data/opencode' });
    expect(opencodePaths({}, '/u')).toEqual({ dir: '/u/.config/opencode', plugin: '/u/.config/opencode/plugins/svall.js', data: '/u/.local/share/opencode' });
  });

  it('is written once, kept while current, and removed', () => {
    const home = makeHome();
    const o = opencodePaths({ XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data') });
    expect(installOpencodePlugin(o)).toEqual([`opencode plugin -> ${o.plugin}`]);
    expect(opencodePluginCurrent(fs.readFileSync(o.plugin, 'utf8'))).toBe(true);
    expect(installOpencodePlugin(o)).toEqual([]);
    fs.writeFileSync(o.plugin, '// old');
    expect(opencodePluginCurrent(fs.readFileSync(o.plugin, 'utf8'))).toBe(false);
    expect(removeOpencodePlugin(o)).toEqual([`removed ${o.plugin}`]);
    expect(fs.existsSync(o.plugin)).toBe(false);
    expect(removeOpencodePlugin(o)).toEqual([]);
  });
});

describe("a character's OpenCode config dir", () => {
  it("links the user's config, turns the shared server off, and hands saved settings back", () => {
    const home = makeHome();
    const o = opencodePaths({ XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data') });
    const dir = path.join(home, 'opencode-config');
    fs.mkdirSync(path.join(o.dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(o.dir, 'opencode.json'), '{}');
    fs.writeFileSync(path.join(o.dir, 'service.json'), '{"password":"p"}');
    expect(linkOpencodeConfig(dir, o)).toBe(dir);
    expect(fs.readlinkSync(path.join(dir, 'plugins'))).toBe(path.join(o.dir, 'plugins'));
    expect(fs.readlinkSync(path.join(dir, 'opencode.json'))).toBe(path.join(o.dir, 'opencode.json'));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'service.json'), 'utf8'))).toEqual({ disabled: true });
    expect(fs.readFileSync(path.join(o.dir, 'service.json'), 'utf8')).toBe('{"password":"p"}');

    // OpenCode renames a saved setting over the link; a file the user removed loses its link
    fs.rmSync(path.join(dir, 'opencode.json'));
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{"theme":"x"}');
    fs.writeFileSync(path.join(dir, 'cli.json'), '{"a":1}');
    fs.rmSync(path.join(o.dir, 'plugins'), { recursive: true });
    linkOpencodeConfig(dir, o);
    expect(fs.readFileSync(path.join(o.dir, 'opencode.json'), 'utf8')).toBe('{"theme":"x"}');
    expect(fs.readFileSync(path.join(o.dir, 'cli.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.lstatSync(path.join(dir, 'cli.json')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'plugins'), { throwIfNoEntry: false })).toBeUndefined();
  });
});
