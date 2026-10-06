import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../jsonfile.js';
import { SHIM } from '../profile.js';
import { assetDir } from '../runtime.js';
import { readOrUndefined } from '../settings-file.js';

export type OpencodePaths = { dir: string; plugin: string; data: string };

/** Where OpenCode keeps its files: its config under XDG_CONFIG_HOME, else ~/.config, its data under XDG_DATA_HOME, else
 *  ~/.local/share. The plugin's name says which build's fleets it serves. */
export function opencodePaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): OpencodePaths {
  const dir = path.join(env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config'), 'opencode');
  const data = path.join(env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, '.local/share'), 'opencode');
  return { dir, plugin: path.join(dir, 'plugins', `${SHIM}.js`), data };
}

/** OpenCode's data, config, state and cache folders where `env` puts them. */
export function opencodeFolders(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const { dir, data } = opencodePaths(env, home);
  const under = (xdg: string | undefined, fallback: string): string => path.join(xdg ? path.resolve(xdg) : path.join(home, fallback), 'opencode');
  return [data, dir, under(env.XDG_STATE_HOME, '.local/state'), under(env.XDG_CACHE_HOME, '.cache')];
}

const pluginText = (): string => fs.readFileSync(path.join(assetDir('hooks'), 'opencode-plugin.js'), 'utf8');

/** Whether `text`, the plugin file as it is, is the plugin this build ships. */
export const opencodePluginCurrent = (text: string | undefined): boolean => text === pluginText();

/** Writes the plugin, which OpenCode loads at its next start with no trust step. */
export function installOpencodePlugin(o: OpencodePaths): string[] {
  if (opencodePluginCurrent(readOrUndefined(o.plugin))) return [];
  fs.mkdirSync(path.dirname(o.plugin), { recursive: true });
  // an OpenCode starting now may be reading the old file
  writeAtomic(o.plugin, pluginText(), { perProcess: true });
  return [`opencode plugin -> ${o.plugin}`];
}

export function removeOpencodePlugin(o: OpencodePaths): string[] {
  if (!fs.existsSync(o.plugin)) return [];
  fs.rmSync(o.plugin);
  return [`removed ${o.plugin}`];
}
