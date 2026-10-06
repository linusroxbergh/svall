import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installOpencodePlugin, opencodePaths, opencodePluginCurrent, removeOpencodePlugin } from '../src/opencode/install.js';
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
