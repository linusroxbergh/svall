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

const SERVICE = 'service.json';
const SERVICE_OFF = '{"disabled":true}\n';
// the temporary a save writes before renaming it into place, OpenCode's or Svall's own
const SAVING = /\.tmp(-\d+)?$/;

/** Fills `dir` as OpenCode's config dir for characters: links to the user's config beside a service.json that turns the
 *  shared server off, so a typed `opencode` runs its own server with the character's env. A setting OpenCode saved over
 *  a link goes back to the user's config if it is newer; the copy it beats is kept in `replaced`. Answers what failed. */
export function linkOpencodeConfig(dir: string, o: OpencodePaths, replaced: string): string[] {
  const failed: string[] = [];
  const each = (names: string[], f: (name: string) => void) => {
    for (const name of names) {
      if (name === SERVICE || SAVING.test(name)) continue;
      try { f(name); } catch (e) { failed.push(`${name}: ${(e as Error).message}`); }
    }
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(o.dir, { recursive: true });
  each(fs.readdirSync(dir), (name) => {
    const here = path.join(dir, name);
    const there = path.join(o.dir, name);
    const st = fs.lstatSync(here);
    if (st.isFile()) {
      const theirs = fs.statSync(there, { throwIfNoEntry: false });
      fs.mkdirSync(replaced, { recursive: true });
      if (theirs && theirs.mtimeMs > st.mtimeMs) fs.renameSync(here, path.join(replaced, name));
      else {
        if (theirs) fs.copyFileSync(there, path.join(replaced, name));
        fs.renameSync(here, there);
      }
    } else if (st.isSymbolicLink() && (fs.readlinkSync(here) !== there || !fs.existsSync(there))) fs.rmSync(here);
  });
  each(fs.readdirSync(o.dir), (name) => {
    const here = path.join(dir, name);
    if (fs.existsSync(here)) return;
    fs.rmSync(here, { force: true });
    fs.symlinkSync(path.join(o.dir, name), here);
  });
  if (readOrUndefined(path.join(dir, SERVICE)) !== SERVICE_OFF) writeAtomic(path.join(dir, SERVICE), SERVICE_OFF, { perProcess: true });
  return failed;
}
