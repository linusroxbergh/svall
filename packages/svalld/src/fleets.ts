import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { fleetNameProblem, HelloReply, PROTOCOL_VERSION, type FleetEntry } from '@svall/protocol';
import { loadConfig } from './config.js';
import { Invalid, NotFound } from './errors.js';
import { resolvePaths, userPaths } from './paths.js';
import { PRIVATE, profileHome, profileLabel, profileOf } from './profile.js';
import { ownRuntime, variant, type Runtime } from './runtime.js';
import { setupHome, type HomeSetup } from './setup.js';
import { appPid, appQuit, fleetHomes } from './uninstall.js';

// the daemon and this build disagree on the protocol: waiting will not fix it
export class ProtocolMismatch extends Error {}

// managed is false for a home that is not a profile's own directory: it gets no launchd agent
export type FleetTarget = { name: string; home: string; managed: boolean };

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const homeSetup = (t: FleetTarget, d: Pick<StartDeps, 'runtime' | 'launchAgentsDir'>): HomeSetup => ({
  home: t.home, label: profileLabel(t.name), runtime: d.runtime, launchAgentsDir: d.launchAgentsDir, launchctl: false,
  port: t.name === PRIVATE ? undefined : 0,
});

/** Loads a profile's launchd agent when launchd has not and starts its daemon, then waits for it to answer. */
export async function startFleet(t: FleetTarget, d: StartDeps): Promise<void> {
  const label = profileLabel(t.name);
  const domain = `gui/${d.uid}`;
  const plist = path.join(d.launchAgentsDir, `${label}.plist`);

  // an ad-hoc $SVALL_HOME is opened as it stands; only a profile's own home gets an agent
  if (t.managed) {
    const loaded = await d.exec('launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false);
    if (!loaded) {
      if (!d.exists(plist)) await d.setupHome(homeSetup(t, d));
      await d.exec('launchctl', ['bootstrap', domain, plist]);
    }
    // launchd starts no daemon at login; the window opening on the fleet does
    await d.exec('launchctl', ['kickstart', `${domain}/${label}`]);
  }

  const end = Date.now() + d.timeoutMs;
  for (;;) {
    try { (await d.connect(t.home)).close(); return; } catch (e) {
      if (e instanceof ProtocolMismatch) throw e;
      const why = (e as Error).message;
      if (Date.now() >= end) throw new Error(`svalld did not start; see ${path.join(t.home, 'svalld.log')} (${why})`);
      await sleep(d.intervalMs);
    }
  }
}

const configName = (home: string): string | undefined => {
  try { return loadConfig(resolvePaths(home).config).name; } catch { return undefined; }
};

export const displayName = (home: string, homedir = os.homedir()): string => configName(home) ?? profileOf(home, homedir);

const homesIn = (homedir: string): string[] => {
  try { return fleetHomes(homedir); } catch { return []; }
};

/** What the fleets other than `except` go by, their config names and their directories alike. */
export const takenNames = (homedir = os.homedir(), except?: string): string[] => [...new Set(homesIn(homedir)
  .filter((h) => except === undefined || h !== path.resolve(except))
  .flatMap((h) => [configName(h), profileOf(h, homedir)].filter((n) => n !== undefined)))];

export const fleetNamed = (name: string, homedir = os.homedir()): string | undefined =>
  homesIn(homedir).find((h) => configName(h) === name);

const CONNECT_TIMEOUT = 2000;

/** A socket to the daemon at `home` that said its token and found it speaks this protocol; `restart` adds a way out of a mismatch. */
export async function handshake(home: string, timeoutMs: number, restart?: string): Promise<WebSocket> {
  const paths = resolvePaths(home);
  const port = Number(fs.readFileSync(paths.port, 'utf8'));
  const token = fs.readFileSync(paths.token, 'utf8').trim();
  const host = loadConfig(paths.config).host;
  const ws = new WebSocket(`ws://${host}:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`svalld on ${host}:${port} did not answer the handshake within ${timeoutMs}ms`)), timeoutMs);
      const done = (e?: Error) => { clearTimeout(timer); if (e) reject(e); else resolve(); };
      ws.once('open', () => ws.send(JSON.stringify({ token })));
      ws.once('message', (raw) => {
        let msg: unknown;
        try { msg = JSON.parse(raw.toString()); } catch { msg = undefined; }
        const r = HelloReply.safeParse(msg);
        const fix = variant === 'release' ? 'quit and reopen Svall' : 'run `pnpm desktop:install`';
        if (!r.success) done(new Error('svalld refused the token'));
        else if (r.data.result.protocol !== PROTOCOL_VERSION) done(new ProtocolMismatch(`the svalld of ${home} speaks protocol ${r.data.result.protocol} and this build speaks ${PROTOCOL_VERSION}: ${fix}${restart ? `, or ${restart}` : ''}`));
        else done();
      });
      ws.once('error', (e) => done(new Error(`svalld not reachable on ${host}:${port}: ${e.message}`)));
      ws.once('close', (code) => done(new Error(`svalld closed the connection (${code})`)));
    });
  } catch (e) {
    // a socket left open keeps a caller that handles the error from exiting
    ws.terminate();
    throw e;
  }
  return ws;
}

/** Holds once the daemon at `home` takes its token and speaks this protocol. */
export async function answers(home: string): Promise<{ close(): void }> {
  (await handshake(home, CONNECT_TIMEOUT)).terminate();
  return { close() {} };
}

/** Lists, creates and starts the fleets beside `current`, which all belong to this user. */
export function fleetControl(current: string, d: FleetDeps) {
  const here = path.resolve(current);
  return {
    list: (): Promise<FleetEntry[]> => Promise.all(homesIn(d.homedir).map(async (home) => ({
      home,
      name: displayName(home, d.homedir),
      current: home === here,
      running: home === here || await d.connect(home).then((c) => { c.close(); return true; }, () => false),
      windowOpen: appPid(home, d) !== undefined,
    }))),
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
