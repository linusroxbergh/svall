import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ApiError, fleetNameProblem, type FleetEntry } from '@svall/protocol';
import { Invalid, NotFound } from './errors.js';
import { configName, homesIn } from './fleet-homes.js';
import { handshakeHome, ProtocolMismatch } from './handshake.js';
import { plistFile } from './launchd.js';
import { userPaths } from './paths.js';
import { PRIVATE, profileHome, profileLabel, profileOf } from './profile.js';
import { ownRuntime, type Runtime } from './runtime.js';
import { setupHome, type HomeSetup } from './setup.js';
import { appPid, appQuit } from './uninstall.js';

// managed is false for a home that is not a profile's own directory: it gets no launchd agent
type FleetTarget = { name: string; home: string; managed: boolean };

export type StartDeps = {
  exists(p: string): boolean;
  exec(cmd: string, args: string[]): Promise<void>;
  connect(home: string): Promise<{ close(): void }>;
  setupHome(o: HomeSetup): Promise<string[]>;
  uid: number;
  launchAgentsDir: string;
  runtime: Runtime;
  timeoutMs: number;
  intervalMs: number;
};

export type FleetDeps = StartDeps & { homedir: string; isApp(pid: number): boolean };

export const homeSetup = (t: FleetTarget, d: Pick<StartDeps, 'runtime' | 'launchAgentsDir'>): HomeSetup => ({
  home: t.home, label: profileLabel(t.name), runtime: d.runtime, launchAgentsDir: d.launchAgentsDir,
  port: t.name === PRIVATE ? undefined : 0,
});

/** Loads a profile's launchd agent when launchd has not, setting up its home if it has no plist; it starts no daemon. */
export async function loadFleetAgent(t: FleetTarget, d: Pick<StartDeps, 'exec' | 'exists' | 'setupHome' | 'uid' | 'launchAgentsDir' | 'runtime'>): Promise<void> {
  const label = profileLabel(t.name);
  const domain = `gui/${d.uid}`;
  const plist = plistFile(d.launchAgentsDir, label);
  if (await d.exec('launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false)) return;
  if (!d.exists(plist)) await d.setupHome(homeSetup(t, d));
  await d.exec('launchctl', ['bootstrap', domain, plist]);
}

/** Loads a profile's launchd agent when launchd has not and starts its daemon, then waits for it to answer. */
export async function startFleet(t: FleetTarget, d: StartDeps): Promise<void> {
  // an ad-hoc $SVALL_HOME is opened as it stands; only a profile's own home gets an agent
  if (t.managed) {
    await loadFleetAgent(t, d);
    // launchd starts no daemon at login; the window opening on the fleet does
    await d.exec('launchctl', ['kickstart', `gui/${d.uid}/${profileLabel(t.name)}`]);
  }

  const end = Date.now() + d.timeoutMs;
  for (;;) {
    try { (await d.connect(t.home)).close(); return; } catch (e) {
      if (e instanceof ProtocolMismatch) throw e;
      const why = (e as Error).message;
      if (Date.now() >= end) throw new ApiError('internal', "Svall's background service did not start", { raw: `${why}\nlog: ${path.join(t.home, 'svalld.log')}` });
      await sleep(d.intervalMs);
    }
  }
}

export const displayName = (home: string, homedir = os.homedir()): string => configName(home) ?? profileOf(home, homedir);

/** What the fleets other than `except` go by, their config names and their directories alike. */
export const takenNames = (homedir = os.homedir(), except?: string): string[] => [...new Set(homesIn(homedir)
  .filter((h) => except === undefined || h !== path.resolve(except))
  .flatMap((h) => [configName(h), profileOf(h, homedir)].filter((n) => n !== undefined)))];

const CONNECT_TIMEOUT = 2000;

/** Holds once the daemon at `home` takes its token and speaks this protocol. */
export async function answers(home: string): Promise<{ close(): void }> {
  (await handshakeHome(home, CONNECT_TIMEOUT)).terminate();
  return { close() {} };
}

/** Lists, creates and starts the fleets beside `current`, which all belong to this user. */
export function fleetControl(current: string, d: FleetDeps) {
  const here = path.resolve(current);
  return {
    list: async (): Promise<FleetEntry[]> => homesIn(d.homedir).map((home) => ({
      home,
      name: displayName(home, d.homedir),
      current: home === here,
      windowOpen: appPid(home, d) !== undefined,
    })),
    create: async (name: string): Promise<string> => {
      const problem = fleetNameProblem(name, takenNames(d.homedir));
      if (problem) throw new Invalid(problem);
      const home = profileHome(name, d.homedir);
      if (d.exists(home)) throw new Invalid(`${home} already exists`);
      const t = { name, home, managed: true };
      await d.setupHome(homeSetup(t, d));
      await startFleet(t, d);
      return home;
    },
    start: async (home: string): Promise<string> => {
      if (!homesIn(d.homedir).includes(home)) throw new NotFound(`no fleet at ${home}`);
      await startFleet({ name: profileOf(home, d.homedir), home, managed: true }, d);
      return home;
    },
  };
}

export type Fleets = ReturnType<typeof fleetControl>;

const execFileP = promisify(execFile);

export const realFleetDeps = (): FleetDeps => ({
  homedir: os.homedir(),
  exists: (p) => fs.existsSync(p),
  exec: async (cmd, args) => { await execFileP(cmd, args); },
  connect: answers,
  setupHome,
  isApp: appQuit.isApp,
  uid: os.userInfo().uid,
  launchAgentsDir: userPaths().launchAgents,
  runtime: ownRuntime(),
  timeoutMs: 15_000,
  intervalMs: 200,
});
