import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { unmergeHooks, unmergeStatusLine } from './agent-hooks.js';
import { codexPaths, type CodexPaths } from './codex/install.js';
import { gatewayPaths } from './gateway/authority.js';
import { SystemdError, daemonReload, disableUnit, realRun, type Run } from './linux/service.js';
import { agentHomesEnv, ourUnits } from './linux/setup.js';
import { configDir, machineId } from './machine.js';
import { fleetOrigin, portsServing, resolveTailscale, unserve, type MobileDeps } from './mobile.js';
import { resolvePaths } from './paths.js';
import { BUNDLE_ID, homePrefix, isProfileName, LAUNCHD_LABEL, PRIVATE, profileHome, SHIM } from './profile.js';
import { readJsonSettings, readOrUndefined, requireWritable, writeJsonSettings, type JsonSettings } from './settings-file.js';
import { shimNames } from './setup.js';
import { resolveTmux } from './tmux/tmux.js';

const exec = promisify(execFile);
const SHIM_MARKS = ['packages/cli/src/main.ts', 'Contents/Resources/runtime/svall.mjs'];
const RELEASE_DIR = path.join('share', 'svall');

const isAgentPlist = (f: string): boolean => f.startsWith(`${LAUNCHD_LABEL}.`) && f.endsWith('.plist');

// `tailscale serve --bg` outlives the daemon, the port it listened on and a reboot, so a fleet's link is found
// by the key it proxies to, or by its daemon's address; a machine without tailscale has none
async function unserveFleets(homes: string[], d: MobileDeps): Promise<string[]> {
  // every daemon start writes its fleet's key, so fleets that never started have no link, and tailscale is not asked
  if (!homes.some((h) => d.read(resolvePaths(h).mobileKey) !== undefined)) return [];
  let bin: string;
  try { bin = await resolveTailscale(d); } catch { return []; }
  let status: string;
  try {
    status = await d.run(bin, ['serve', 'status', '--json']);
    // a tailscale that cannot start can still exit 0, saying so in prose
    try { JSON.parse(status); } catch { throw new Error(status.trim() || 'no output'); }
  } catch (e) {
    return [`could not read tailscale serve status, so any phone link was left in place: ${(e as Error).message.split('\n')[0]}`];
  }
  const done: string[] = [];
  for (const home of homes) {
    const key = d.read(resolvePaths(home).mobileKey)?.trim();
    for (const port of portsServing(status, key, fleetOrigin(d, home))) {
      await unserve(d, bin, port).then(
        () => { done.push(`turned off the phone link to ${home} on port ${port}`); },
        () => { done.push(`could not turn off the phone link to ${home}; run tailscale serve --https=${port} off`); },
      );
    }
  }
  return done;
}

export type AppQuit = { isApp(pid: number): boolean; quit(pid: number): Promise<void>; wait(ms: number): Promise<void> };

export const appQuit: AppQuit = {
  isApp: (pid) => {
    try { return /(^|\/)Svall$/.test(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
  },
  // by pid, as a quit sent to the bundle id can reach another window, one already asking about unsaved edits
  quit: (pid) => {
    const script = `ObjC.import('AppKit'); const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!a.isNil() && !a.terminate) throw new Error('macOS did not pass the quit on')`;
    return exec('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 60_000 })
      .then(() => undefined, (e: Error & { stderr?: string }) => { throw new Error(e.stderr?.trim() || 'osascript did not answer'); });
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// app.pid outlives a crash, after which its pid can be another process's
export const appPid = (home: string, app: Pick<AppQuit, 'isApp'>): number | undefined => {
  const [pid, owner] = (readOrUndefined(path.join(home, 'app.pid')) ?? '').trim().split('\t');
  return owner && path.resolve(owner) === path.resolve(home) && Number(pid) > 0 && app.isApp(Number(pid)) ? Number(pid) : undefined;
};

const QUIT_WAIT_S = 60;

// an open window could write its sign-ins, caches and defaults back after they move or are purged. Each is asked once and waited for:
// a second quit while it asks about unsaved edits would answer for the user. The mark in its home has it quit without asking first
export async function quitApp(homes: string[], app: AppQuit, command: string, skipPid?: number): Promise<string[]> {
  const open = homes.map((h) => [h, appPid(h, app)] as const).filter((o): o is readonly [string, number] => o[1] !== undefined && o[1] !== skipPid);
  for (const [home, pid] of open) {
    const mark = path.join(home, 'quit-quietly');
    fs.writeFileSync(mark, '');
    try {
      await app.quit(pid).catch((e: Error) => {
        throw new Error(`could not ask Svall to quit (${e.message.split('\n')[0]}), so nothing was changed; quit it, then run ${command} again`);
      });
      for (let s = 0; s < QUIT_WAIT_S && app.isApp(pid); s++) await app.wait(1000);
    } finally {
      fs.rmSync(mark, { force: true });
    }
    if (app.isApp(pid)) throw new Error(`Svall did not quit within ${QUIT_WAIT_S} s, so nothing was changed; quit it, then run ${command} again`);
  }
  return open.length ? ['quit Svall'] : [];
}

// the units this machine's setup wrote, stopped before their files go
export async function removeUnits(o: { unitDir: string; systemctl: boolean; run: Run }): Promise<string[]> {
  const done: string[] = [];
  const units = ourUnits(o.unitDir);
  for (const unit of units) {
    // a daemon that would not stop keeps running without its unit, so say so rather than claim it went
    if (o.systemctl) await disableUnit(o.run, unit).catch((e: SystemdError) => { done.push(`could not stop ${unit}: ${e.message}`); });
    fs.rmSync(path.join(o.unitDir, unit), { force: true });
    done.push(`removed ${path.join(o.unitDir, unit)}`);
  }
  if (units.length && o.systemctl) await daemonReload(o.run).catch(() => {});
  return done;
}

// the releases setup installed, the companions a controller fetched and the units' logs; the gateway's
// ownership records under the same prefix stay, as fleet data does
function removeReleases(prefix: string): string[] {
  const done: string[] = [];
  for (const name of ['releases', 'current', 'companions', 'log']) {
    const p = path.join(prefix, name);
    if (!fs.lstatSync(p, { throwIfNoEntry: false })) continue;
    fs.rmSync(p, { recursive: true, force: true });
    done.push(`removed ${p}`);
  }
  return done;
}

// only a shim of ours: one pointing into an installed release, or one that runs a checkout's or the app's CLI
function removeShims(shimDir: string): string[] {
  const done: string[] = [];
  for (const name of shimNames(shimDir)) {
    const shim = path.join(shimDir, name);
    const link = fs.lstatSync(shim, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(shim) : undefined;
    const text = readOrUndefined(shim);
    if (!(link?.includes(RELEASE_DIR) || (text && SHIM_MARKS.some((m) => text.includes(m))))) continue;
    fs.rmSync(shim, { force: true });
    done.push(`removed ${shim}`);
  }
  return done;
}

// each file once, however many linked folders lead to it; the file itself stays unresolved, so a hooks file that is
// a link is written, never removed
const once = (files: string[]): string[] => {
  const real = (file: string): string => {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { return file; }
  };
  return files.filter((file, i) => files.findIndex((f) => real(f) === real(file)) === i);
};

const readJson = (file: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

/**
 * What stopping this machine's fleets would strand: a handover open in a fleet home, a fleet run here for its gateway,
 * or the fleets this machine is the gateway of, but for those in `released`, whose keeper has checked them.
 */
export function stranded(homes: string[], prefix?: string, released: string[] = []): string[] {
  let me: string | undefined;
  try { me = fs.existsSync(path.join(configDir(), 'machine.json')) ? machineId() : undefined; } catch { me = undefined; }
  const out: string[] = [];
  for (const home of homes) {
    const p = resolvePaths(home);
    const gateway = readJson(p.fleetConfig)?.gatewayMachineId;
    if (fs.existsSync(p.journal)) out.push(`a handover of ${home} is open`);
    else if (typeof gateway === 'string' && me && readJson(p.owner)?.ownerMachineId === me) out.push(`this machine runs ${home} for its gateway ${gateway}`);
  }
  const records = prefix ? gatewayPaths(prefix).fleets : undefined;
  const held = records && fs.existsSync(records) ? fs.readdirSync(records).filter((f) => f.endsWith('.json') && !released.includes(path.basename(f, '.json'))).length : 0;
  if (held) out.push(`this machine is the gateway of ${held} fleet${held > 1 ? 's' : ''}, whose records are in ${records}`);
  return out;
}

/** The refusal of an uninstall that would strand a fleet. */
export class UninstallRefused extends Error {}

// takes back what setup put outside the fleet homes: the Claude hooks and statusline and the Codex hooks that run
// `home`'s scripts, every fleet's phone link, service and tmux server, the installed releases and the shims. The
// fleets' own data stays for purge. Unless forced, it refuses where that would strand a fleet; `forceFleets` passes
// only the gateway records of those fleets.
export async function runUninstall(o: {
  home: string; homes: string[]; settingsPaths: string[]; codex: CodexPaths; launchAgentsDir: string; shimDir: string; launchctl: boolean;
  mobile: MobileDeps; app: AppQuit; tmux?: string; skipPid?: number; platform?: NodeJS.Platform; unitDir?: string; prefix?: string; run?: Run;
  force?: boolean; forceFleets?: string[];
}): Promise<string[]> {
  // $TMUX names the server the caller's terminal runs in; stopping it would end this run before the shims and the report
  const inside = o.homes.find((h) => resolvePaths(h).tmuxSock === o.tmux?.split(',')[0]);
  if (inside) throw new Error(`this terminal runs inside the tmux server of ${inside}, which uninstall stops; run ${SHIM} uninstall from a terminal outside Svall`);
  const strands = o.force ? [] : stranded(o.homes, o.prefix, o.forceFleets);
  if (strands.length) {
    throw new UninstallRefused(`uninstalling here would strand fleets: ${strands.join('; ')}. Finish or abort the handover, bring each fleet to the machine that keeps it with ${SHIM} handover local, and remove this machine from that one with ${SHIM} host remove <name>, which checks all of this; or run ${SHIM} uninstall --force`);
  }
  const paths = resolvePaths(o.home);
  const linux = (o.platform ?? process.platform) === 'linux' && o.unitDir;
  // Linux setup put the hooks under the agent homes the daemon's unit is given, which this command's env may not name
  const agentHomes = linux ? await agentHomesEnv(o.run ?? realRun) : {};
  const settingsPaths = once([...o.settingsPaths, ...(agentHomes.CLAUDE_CONFIG_DIR ? [path.join(agentHomes.CLAUDE_CONFIG_DIR, 'settings.json')] : [])]);
  const edits = settingsPaths.map((file): [JsonSettings, Record<string, unknown>, string] => {
    const settings = readJsonSettings(file);
    return [settings, unmergeStatusLine(unmergeHooks(settings.settings, paths.hookScript), paths.statusScript), 'claude hooks and statusline removed'];
  });
  const codexes = once([o.codex.hooks, ...(agentHomes.CODEX_HOME ? [codexPaths(agentHomes).hooks] : [])])
    .filter((file) => fs.existsSync(file)).map((file) => readJsonSettings(file));
  for (const codex of codexes) edits.push([codex, unmergeHooks(codex.settings, paths.hookScript), 'codex hooks removed']);
  // a file that cannot take its change stops the run before anything is removed
  for (const [current, next] of edits) requireWritable(current, next);
  const done = await quitApp(o.homes, o.app, `${SHIM} uninstall`, o.skipPid);
  for (const [current, next, what] of edits) {
    // Codex needs no hooks file, so one that held only Svall's goes, unless it links elsewhere
    const emptied = codexes.includes(current) && !Object.keys(next).length && Object.keys(current.settings).length > 0;
    if (emptied && !fs.lstatSync(current.file).isSymbolicLink()) {
      fs.rmSync(current.file);
      done.push(`removed ${current.file}`);
    } else done.push(...writeJsonSettings(current, next, what));
  }
  done.push(...await unserveFleets(o.homes, o.mobile));

  if (linux) done.push(...await removeUnits({ unitDir: o.unitDir!, systemctl: o.launchctl, run: o.run ?? realRun }));
  const agents = !linux && fs.existsSync(o.launchAgentsDir) ? fs.readdirSync(o.launchAgentsDir).filter(isAgentPlist).sort() : [];
  for (const name of agents) {
    const plist = path.join(o.launchAgentsDir, name);
    // a daemon that would not stop keeps running without its plist, so say so rather than claim it went
    if (o.launchctl && await exec('launchctl', ['bootout', `gui/${os.userInfo().uid}`, plist]).then(() => false, () => true)) {
      done.push(`could not stop ${name}; it may still be running`);
    }
    fs.rmSync(plist, { force: true });
    done.push(`removed ${plist}`);
  }
  if (o.prefix) done.push(...removeReleases(o.prefix));

  // a character's agent would run on in tmux, spending usage with no app left to show it
  for (const home of o.homes) {
    const sock = resolvePaths(home).tmuxSock;
    if (!fs.existsSync(sock)) continue;
    await exec(resolveTmux(), ['-S', sock, 'kill-server']).then(
      () => { done.push(`stopped tmux server ${sock}`); },
      () => { done.push(`could not stop tmux server ${sock}`); },
    );
  }
  return [...done, ...removeShims(o.shimDir)];
}

// a fleet home is one that holds a fleet.json, or the config.json it is split out of, so a folder
// of the user's that happens to be named like one is never offered up for deletion
const isFleetHome = (p: string): boolean =>
  fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
  && [resolvePaths(p).fleetConfig, resolvePaths(p).legacyConfig].some((f) => fs.existsSync(f));

export const fleetHomes = (homedir: string): string[] => fs.readdirSync(homedir)
  .filter((f) => f === path.basename(profileHome(PRIVATE, homedir)) || (f.startsWith(homePrefix) && isProfileName(f.slice(homePrefix.length))))
  .sort()
  .map((f) => path.join(homedir, f))
  .filter(isFleetHome);

// what macOS keeps by the app's bundle id rather than in a fleet home: every fleet's browser sign-ins, the caches,
// the updater's HTTP storage and cookies, the saved window state and the defaults
export const libraryData = (homedir: string): string[] =>
  [path.join('WebKit', BUNDLE_ID), path.join('Caches', BUNDLE_ID), path.join('HTTPStorages', BUNDLE_ID),
    path.join('HTTPStorages', `${BUNDLE_ID}.binarycookies`), path.join('Saved Application State', `${BUNDLE_ID}.savedState`),
    path.join('Preferences', `${BUNDLE_ID}.plist`)]
    .map((p) => path.join(homedir, 'Library', p));

export function fleetData(o: { homedir: string; appDests: string[]; fromApp?: boolean }): string[] {
  if (o.fromApp) return fleetHomes(o.homedir);
  const appName = BUNDLE_ID.endsWith('.dev') ? 'Svall Dev.app' : 'Svall.app';
  const apps = [...new Set(o.appDests)].map((d) => path.join(d, appName)).filter((p) => fs.existsSync(p));
  return [...fleetHomes(o.homedir), ...apps, ...libraryData(o.homedir).filter((p) => fs.existsSync(p))];
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
