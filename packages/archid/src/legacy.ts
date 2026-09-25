import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BUNDLE_ID, LAUNCHD_LABEL, OLD_BUNDLE_ID, OLD_LAUNCHD_LABEL } from './profile.js';
import { quitApp, type AppQuit } from './uninstall.js';

const exec = promisify(execFile);

export type Launchctl = (args: string[]) => Promise<unknown>;
export const runLaunchctl: Launchctl = (args) => exec('launchctl', args);

/** Moves one app's defaults to another id; says whether there were any. */
export type Prefs = { move(from: string, to: string): Promise<boolean> };

// cfprefsd writes a moved plist file back, so the defaults go through it
export const defaultsPrefs: Prefs = {
  move: async (from, to) => {
    const { stdout } = await exec('defaults', ['export', from, '-']);
    if (/<plist[^>]*>\s*<dict\/>\s*<\/plist>/.test(stdout)) {
      await exec('defaults', ['delete', from]).catch(() => {});
      return false;
    }
    const load = exec('defaults', ['import', to, '-']);
    load.child.stdin?.end(stdout);
    await load;
    await exec('defaults', ['delete', from]);
    return true;
  },
};

const oldAgents = (launchAgentsDir: string): string[] => (fs.existsSync(launchAgentsDir) ? fs.readdirSync(launchAgentsDir) : [])
  .filter((f) => f.startsWith(`${OLD_LAUNCHD_LABEL}.`) && f.endsWith('.plist')).sort();

// the app's own folders under the old id, each beside where it goes
const oldAppDirs = (library: string): string[][] => ['WebKit', 'Caches']
  .map((d) => [path.join(library, d, OLD_BUNDLE_ID), path.join(library, d, BUNDLE_ID)]).filter(([from]) => fs.existsSync(from));

const prefsFile = (library: string, id: string): string => path.join(library, 'Preferences', `${id}.plist`);

// the defaults move only while the new id has none, so an older build run since cannot write over them
const oldPrefsLeft = (library: string): boolean => fs.existsSync(prefsFile(library, OLD_BUNDLE_ID)) && !fs.existsSync(prefsFile(library, BUNDLE_ID));

/** Whether a fleet's launchd agent or the app's sign-ins or defaults are still under the old ids. */
export const oldIdsLeft = (launchAgentsDir: string, library: string): boolean => oldAgents(launchAgentsDir).length > 0
  || oldAppDirs(library).some(([, to]) => !fs.existsSync(to)) || oldPrefsLeft(library);

/** Sign-ins left under the old id beside the new id's, which setup never merges, or nothing. */
export function signInsLeft(library: string): string | undefined {
  const [from, to] = [OLD_BUNDLE_ID, BUNDLE_ID].map((id) => path.join(library, 'WebKit', id));
  return fs.existsSync(from) && fs.existsSync(to)
    ? `${from} is left beside ${to}, which the app reads: quit the app, then keep whichever holds your sign-ins at ${to} and delete the other`
    : undefined;
}

// an Archipelago.app built under the old id reads its sign-ins and defaults there
const oldApp = (appDests: string[]): string | undefined => appDests.map((d) => path.join(d, 'Archipelago.app')).find((app) => {
  try { return fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8').includes(`<string>${OLD_BUNDLE_ID}</string>`); } catch { return false; }
});

/** Moves what an install under the old ids left: the app's sign-ins, caches and defaults, where the new id has none yet
 *  and no older build installed still reads them, and every fleet's launchd agent, which starts again under the new label. */
export async function moveOldIds(o: {
  library: string; launchAgentsDir: string; homes: string[]; appDests: string[]; app: AppQuit; run: Launchctl; prefs: Prefs;
}): Promise<string[]> {
  const dirs = oldAppDirs(o.library).filter(([, to]) => !fs.existsSync(to));
  const prefs = oldPrefsLeft(o.library);
  const installed = dirs.length || prefs ? oldApp(o.appDests) : undefined;
  const done: string[] = [];
  if (installed) {
    done.push(`left the app's sign-ins and defaults under ${OLD_BUNDLE_ID}, as ${installed} is an older build that reads them: pnpm desktop:install replaces it, or delete it if it is a spare copy`);
  } else if (dirs.length || prefs) {
    // an open window would write its sign-ins and defaults back under the old id
    done.push(...await quitApp(o.homes, o.app, 'archi setup'));
    for (const [from, to] of dirs) {
      fs.renameSync(from, to);
      done.push(`moved ${from} -> ${to}`);
    }
    if (prefs) {
      await o.prefs.move(OLD_BUNDLE_ID, BUNDLE_ID).then(
        (moved) => {
          // what cfprefsd leaves of an emptied domain
          fs.rmSync(prefsFile(o.library, OLD_BUNDLE_ID), { force: true });
          if (moved) done.push(`moved the ${OLD_BUNDLE_ID} defaults to ${BUNDLE_ID}`);
        },
        (e: Error) => { done.push(`could not move the ${OLD_BUNDLE_ID} defaults: ${e.message.split('\n')[0]}`); },
      );
    }
  }
  done.push(...await moveAgents(o.launchAgentsDir, oldAgents(o.launchAgentsDir), o.run));
  return done;
}

async function moveAgents(launchAgentsDir: string, agents: string[], run: Launchctl): Promise<string[]> {
  const done: string[] = [];
  const domain = `gui/${os.userInfo().uid}`;
  for (const name of agents) {
    const from = path.join(launchAgentsDir, name);
    const label = name.slice(0, -'.plist'.length);
    const next = LAUNCHD_LABEL + label.slice(OLD_LAUNCHD_LABEL.length);
    const to = path.join(launchAgentsDir, `${next}.plist`);
    // both would take the fleet's port and home, so the old one stops first; bootout fails too for one not loaded
    const stopped = await run(['bootout', domain, from]).then(() => true, () => run(['print', `${domain}/${label}`]).then(() => false, () => true));
    if (!stopped) {
      done.push(`could not stop ${label}, so it stays under its old label; run archi setup again`);
      continue;
    }
    if (!fs.existsSync(to)) fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(`<string>${label}</string>`, `<string>${next}</string>`));
    fs.rmSync(from);
    done.push(`moved ${from} -> ${to}`);
    // setup starts the private fleet's agent from the plist it writes
    if (next === LAUNCHD_LABEL) continue;
    // archi may have loaded the new label before setup ran, while the old one still held the port
    await run(['bootout', domain, to]).catch(() => {});
    await run(['bootstrap', domain, to]).then(
      () => { done.push(`launchctl bootstrap ${domain} ${to}`); },
      (e: Error) => { done.push(`could not start ${next}: ${e.message.split('\n')[0]}`); },
    );
  }
  return done;
}
