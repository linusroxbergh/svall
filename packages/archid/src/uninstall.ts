import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodexPaths } from './codex/install.js';
import { portsServing, resolveTailscale, unserve, type MobileDeps } from './mobile.js';
import { resolvePaths } from './paths.js';
import { isProfileName, LAUNCHD_LABEL, PRIVATE, profileHome } from './profile.js';
import { readJsonSettings, requireWritable, unmergeHooks, unmergeStatusLine, writeJsonSettings, type JsonSettings } from './setup.js';

const exec = promisify(execFile);
const SHIM_MARK = 'packages/cli/src/main.ts';
const BUNDLE_ID = 'com.archipelago.desktop';

const isAgentPlist = (f: string): boolean => f.startsWith(`${LAUNCHD_LABEL}.`) && f.endsWith('.plist');

const readOrUndefined = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
};

// `tailscale serve --bg` outlives the daemon, the port it listened on and a reboot, so a fleet's link is found
// by the key it proxies to; a machine without tailscale has none
async function unserveFleets(homes: string[], d: MobileDeps): Promise<string[]> {
  let bin: string;
  try { bin = await resolveTailscale(d); } catch { return []; }
  let status: string;
  try { status = await d.run(bin, ['serve', 'status', '--json']); } catch (e) {
    return [`could not read tailscale serve status, so any phone link was left in place: ${(e as Error).message.split('\n')[0]}`];
  }
  const done: string[] = [];
  for (const home of homes) {
    const key = d.read(resolvePaths(home).mobileKey)?.trim();
    for (const port of key ? portsServing(status, key) : []) {
      await unserve(d, bin, port).then(
        () => { done.push(`turned off the phone link to ${home} on port ${port}`); },
        () => { done.push(`could not turn off the phone link to ${home}; run tailscale serve --https=${port} off`); },
      );
    }
  }
  return done;
}

// takes back what setup put outside the fleet homes: the Claude hooks and statusline and the Codex hooks that run
// `home`'s scripts, every fleet's phone link, launchd agent and tmux server, and the shims. The fleets' own data stays for purge.
export async function runUninstall(o: { home: string; homes: string[]; settingsPaths: string[]; codex: CodexPaths; launchAgentsDir: string; shimDir: string; launchctl: boolean; mobile: MobileDeps; tmux?: string }): Promise<string[]> {
  // $TMUX names the server the caller's terminal runs in; stopping it would end this run before the shims and the report
  const inside = o.homes.find((h) => resolvePaths(h).tmuxSock === o.tmux?.split(',')[0]);
  if (inside) throw new Error(`this terminal runs inside the tmux server of ${inside}, which uninstall stops; run archi uninstall from a terminal outside Archipelago`);
  const paths = resolvePaths(o.home);
  const edits = o.settingsPaths.map((file): [JsonSettings, Record<string, unknown>, string] => {
    const settings = readJsonSettings(file);
    return [settings, unmergeStatusLine(unmergeHooks(settings.settings, paths.hookScript), paths.statusScript), 'claude hooks and statusline removed'];
  });
  const codex = fs.existsSync(o.codex.hooks) ? readJsonSettings(o.codex.hooks) : undefined;
  if (codex) edits.push([codex, unmergeHooks(codex.settings, paths.hookScript), 'codex hooks removed']);
  // a file that cannot take its change stops the run before anything is removed
  for (const [current, next] of edits) requireWritable(current, next);
  const done = edits.flatMap(([current, next, what]) => writeJsonSettings(current, next, what));
  done.push(...await unserveFleets(o.homes, o.mobile));

  const agents = fs.existsSync(o.launchAgentsDir) ? fs.readdirSync(o.launchAgentsDir).filter(isAgentPlist).sort() : [];
  for (const name of agents) {
    const plist = path.join(o.launchAgentsDir, name);
    // a daemon that would not stop keeps running without its plist, so say so rather than claim it went
    if (o.launchctl && await exec('launchctl', ['bootout', `gui/${os.userInfo().uid}`, plist]).then(() => false, () => true)) {
      done.push(`could not stop ${name}; it may still be running`);
    }
    fs.rmSync(plist, { force: true });
    done.push(`removed ${plist}`);
  }

  // a character's agent would run on in tmux, spending usage with no app left to show it
  for (const home of o.homes) {
    const sock = resolvePaths(home).tmuxSock;
    if (!fs.existsSync(sock)) continue;
    await exec('tmux', ['-S', sock, 'kill-server']).then(
      () => { done.push(`stopped tmux server ${sock}`); },
      () => { done.push(`could not stop tmux server ${sock}`); },
    );
  }

  for (const name of ['archi', 'archipelago']) {
    const shim = path.join(o.shimDir, name);
    if (!readOrUndefined(shim)?.includes(SHIM_MARK)) continue;
    fs.rmSync(shim, { force: true });
    done.push(`removed ${shim}`);
  }
  return done;
}

// a fleet home is one that holds a config.json, so a folder of the user's that happens to be
// named like one is never offered up for deletion
const isFleetHome = (p: string): boolean =>
  fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true && fs.existsSync(resolvePaths(p).config);

export const fleetHomes = (homedir: string): string[] => fs.readdirSync(homedir)
  .filter((f) => f === path.basename(profileHome(PRIVATE, homedir)) || (f.startsWith('.archipelago-') && isProfileName(f.slice('.archipelago-'.length))))
  .sort()
  .map((f) => path.join(homedir, f))
  .filter(isFleetHome);

export function fleetData(o: { homedir: string; appDests: string[] }): string[] {
  const apps = [...new Set(o.appDests)].map((d) => path.join(d, 'Archipelago.app')).filter((p) => fs.existsSync(p));
  // what macOS keeps by the app's bundle id rather than in a fleet home: every fleet's browser sign-ins, the caches and the defaults
  const library = [path.join('WebKit', BUNDLE_ID), path.join('Caches', BUNDLE_ID), path.join('Preferences', `${BUNDLE_ID}.plist`)]
    .map((p) => path.join(o.homedir, 'Library', p)).filter((p) => fs.existsSync(p));
  return [...fleetHomes(o.homedir), ...apps, ...library];
}

export async function purge(paths: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const p of paths) {
    // one path that will not go must not cost the user the report of the ones that did
    try {
      fs.rmSync(p, { recursive: true, force: true });
      done.push(`deleted ${p}`);
    } catch (e) {
      done.push(`could not delete ${p}: ${(e as Error).message}`);
    }
  }
  return done;
}
