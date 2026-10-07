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
  const setup = () => {
    const home = makeHome();
    const o = opencodePaths({ XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data') });
    fs.mkdirSync(o.dir, { recursive: true });
    return { o, dir: path.join(home, 'opencode-config'), replaced: path.join(home, 'replaced'), old: path.join(home, 'old') };
  };
  const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
  // what OpenCode does to save a setting: rename a file over the link
  const save = (file: string, text: string, at: number) => {
    fs.rmSync(file);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, at, at);
  };

  it("links the user's config, turns the shared server off, and hands a newer saved setting back", () => {
    const { o, dir, replaced } = setup();
    fs.mkdirSync(path.join(o.dir, 'plugins'));
    fs.writeFileSync(path.join(o.dir, 'opencode.json'), '{}');
    fs.utimesSync(path.join(o.dir, 'opencode.json'), 1000, 1000);
    fs.writeFileSync(path.join(o.dir, 'service.json'), '{"password":"p"}');
    expect(linkOpencodeConfig(dir, o, replaced)).toEqual([]);
    expect(fs.readlinkSync(path.join(dir, 'plugins'))).toBe(path.join(o.dir, 'plugins'));
    expect(fs.readlinkSync(path.join(dir, 'opencode.json'))).toBe(path.join(o.dir, 'opencode.json'));
    expect(JSON.parse(read(dir, 'service.json'))).toEqual({ disabled: true });
    expect(read(o.dir, 'service.json')).toBe('{"password":"p"}');

    // a file the user removed loses its link
    save(path.join(dir, 'opencode.json'), '{"theme":"x"}', 2000);
    fs.writeFileSync(path.join(dir, 'cli.json'), '{"a":1}');
    fs.rmSync(path.join(o.dir, 'plugins'), { recursive: true });
    expect(linkOpencodeConfig(dir, o, replaced)).toEqual([]);
    expect(read(o.dir, 'opencode.json')).toBe('{"theme":"x"}');
    expect(read(replaced, 'opencode.json')).toBe('{}');
    expect(read(o.dir, 'cli.json')).toBe('{"a":1}');
    expect(fs.lstatSync(path.join(dir, 'cli.json')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'plugins'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps a saved setting the user's newer file beats, and leaves files mid-save alone", () => {
    const { o, dir, replaced } = setup();
    fs.writeFileSync(path.join(o.dir, 'cli.json'), '{"user":1}');
    fs.writeFileSync(path.join(o.dir, 'service.json.tmp'), '{"password":"p"}');
    linkOpencodeConfig(dir, o, replaced);
    expect(fs.lstatSync(path.join(dir, 'service.json.tmp'), { throwIfNoEntry: false })).toBeUndefined();
    expect(read(o.dir, 'service.json.tmp')).toBe('{"password":"p"}');

    save(path.join(dir, 'cli.json'), '{"char":1}', 1000);
    fs.writeFileSync(path.join(dir, 'cli.json.tmp'), '{"char":2}');
    expect(linkOpencodeConfig(dir, o, replaced)).toEqual([]);
    expect(read(o.dir, 'cli.json')).toBe('{"user":1}');
    expect(read(replaced, 'cli.json')).toBe('{"char":1}');
    expect(fs.readlinkSync(path.join(dir, 'cli.json'))).toBe(path.join(o.dir, 'cli.json'));
    expect(read(dir, 'cli.json.tmp')).toBe('{"char":2}');
    expect(fs.existsSync(path.join(o.dir, 'cli.json.tmp'))).toBe(false);
  });

  it("points a stray link back at the user's config and goes on past an entry it cannot hand back", () => {
    const { o, dir, replaced, old } = setup();
    fs.writeFileSync(path.join(o.dir, 'opencode.json'), '{}');
    fs.writeFileSync(path.join(o.dir, 'AGENTS.md'), '# rules');
    fs.mkdirSync(path.join(o.dir, 'agents'));
    fs.utimesSync(path.join(o.dir, 'agents'), 1000, 1000);
    fs.mkdirSync(dir);
    // a file saved where the user now has a folder
    fs.writeFileSync(path.join(dir, 'agents'), 'x');
    // a link into the config folder XDG_CONFIG_HOME named before
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'opencode.json'), '{"old":true}');
    fs.symlinkSync(path.join(old, 'opencode.json'), path.join(dir, 'opencode.json'));
    expect(linkOpencodeConfig(dir, o, replaced)).toEqual([expect.stringMatching(/^agents: /)]);
    expect(fs.readlinkSync(path.join(dir, 'opencode.json'))).toBe(path.join(o.dir, 'opencode.json'));
    expect(fs.readlinkSync(path.join(dir, 'AGENTS.md'))).toBe(path.join(o.dir, 'AGENTS.md'));
    expect(JSON.parse(read(dir, 'service.json'))).toEqual({ disabled: true });
  });
});
