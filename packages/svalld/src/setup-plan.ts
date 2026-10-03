import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CWD, type AgentKind } from '@svall/protocol';
import { AGENTS, AGENT_KINDS } from './agents.js';
import { loadConfig } from './config.js';
import { expandHome, resolvePaths } from './paths.js';
import { LOGIN_SHELL_TIMEOUT_MS } from './login-env.js';
import { LAUNCHD_LABEL, PRIVATE, SHIM, profileLabel, profileOf } from './profile.js';
import type { Runtime } from './runtime.js';

// an agent found only by its folder gets hooks and a toggle, but cannot be the main agent
export type FoundAgent = { kind: AgentKind; path: string; version?: string; folderOnly?: boolean };
export type SetupPlan = {
  agents: FoundAgent[]; integrations?: AgentKind[]; writes: { what: string; path: string; agent?: AgentKind }[];
  shimDir: string; shimOnPath: boolean; blockers: string[]; projects: string;
  // how to install each agent's CLI, while setup found none
  install?: { kind: AgentKind; command: string; url: string }[];
};

/** What the app's setup screen shows before anything is written: the screen leaves out the files of the agents it turns off. */
export function setupPlan(o: {
  home: string; projects: string; found: FoundAgent[]; folders: FoundAgent[]; integrations?: AgentKind[]; settingsPath: string; codexHooks: string;
  launchAgentsDir: string; fleets: string[]; shimDir: string; pathEnv: string; answered: boolean; cli: string;
}): SetupPlan {
  // setup writes an agent's hooks when its CLI is on PATH or its own folder is here
  const agents = [...o.found, ...o.folders.filter((f) => !o.found.some((a) => a.kind === f.kind)).map((f) => ({ ...f, folderOnly: true }))];
  const has = (k: AgentKind) => agents.some((a) => a.kind === k);
  const writes = [
    ...(has('claude') ? [{ what: 'Claude Code hooks and status line', path: o.settingsPath, agent: 'claude' as const }] : []),
    ...(has('codex') ? [{ what: 'Codex hooks', path: o.codexHooks, agent: 'codex' as const }] : []),
    { what: 'Service that keeps fleets running', path: path.join(o.launchAgentsDir, `${LAUNCHD_LABEL}.plist`) },
    ...o.fleets.map((h) => ({ what: `Service for the ${profileOf(h)} fleet`, path: path.join(o.launchAgentsDir, `${profileLabel(profileOf(h))}.plist`) })),
    { what: `The ${SHIM} command`, path: path.join(o.shimDir, SHIM) },
    { what: 'Your fleet', path: o.home },
  ];
  let blockers: string[] = [];
  let install: SetupPlan['install'];
  if (!o.answered) blockers = [`Your login shell did not answer within ${LOGIN_SHELL_TIMEOUT_MS / 1000} seconds, so Svall cannot see where Claude Code and Codex are. Check again, or run ${o.cli} setup in a terminal.`];
  else if (!o.found.length) {
    const either = (f: (k: AgentKind) => string) => AGENT_KINDS.map(f).join(' or ');
    blockers = [`Svall runs ${either((k) => AGENTS[k].label)} in its terminals, so it needs the ${either((k) => AGENTS[k].bin)} command. The desktop apps don't install it. Install one in Terminal, then check again.`];
    install = AGENT_KINDS.map((kind) => ({ kind, command: AGENTS[kind].installCommand, url: AGENTS[kind].installUrl }));
  }
  return {
    agents, integrations: o.integrations, writes, shimDir: o.shimDir, shimOnPath: o.pathEnv.split(':').includes(o.shimDir), blockers, projects: o.projects, install,
  };
}

const PROJECT_DIRS = ['Developer', 'Projects', 'Code', 'src', 'dev', 'repos', 'workspace', 'git'];

/** The folder setup offers for new characters to start in: the one saved before, else the first usual code folder in
 *  `userHome`, else ~/Developer. An agent started in home reads Documents, Downloads and Music, each asking for access. */
export function suggestProjects(userHome: string, saved: string): string {
  if (saved !== DEFAULT_CWD) return saved;
  let names: string[] = [];
  try { names = fs.readdirSync(userHome); } catch { /* none to offer */ }
  const found = PROJECT_DIRS.map((d) => names.find((n) => n.toLowerCase() === d.toLowerCase()))
    .find((n) => n && fs.statSync(path.join(userHome, n), { throwIfNoEntry: false })?.isDirectory());
  return `~/${found ?? 'Developer'}`;
}

/** The projects folder as typed, to save once checked: a full path or one from ~, a folder or still to be made. */
export function projectsFolder(input: string): string {
  const dir = input.trim();
  if (!path.isAbsolute(expandHome(dir))) throw new Error('the projects folder must be a full path or start with ~');
  if (fs.statSync(expandHome(dir), { throwIfNoEntry: false })?.isFile()) throw new Error(`${dir} is a file, not a folder`);
  return dir;
}

/** The integrations to save: the agents chosen, and every one not found now that was not turned off before, so an agent
 *  found and left out stays off until a setup shows it again. */
export const integrationsFor = (chosen: AgentKind[], found: AgentKind[], saved?: AgentKind[]): AgentKind[] =>
  AGENT_KINDS.filter((k) => chosen.includes(k) || (!found.includes(k) && (!saved || saved.includes(k))));

/** Throws for an app run from a disk image or translocated by macOS, where the paths setup writes would not last. */
export function requireInstalledApp(r: Runtime): void {
  if (r.bundle && (r.bundle.startsWith('/Volumes/') || r.bundle.includes('/AppTranslocation/'))) {
    throw new Error('Move Svall to your Applications folder and open it from there, then set it up.');
  }
}

const readVersion = (home: string): string | undefined => {
  try { return fs.readFileSync(path.join(home, 'version'), 'utf8').trim(); } catch { return undefined; }
};

/** The launchd labels of the running fleets whose daemon started as another version than `version`, or wrote none. */
export function staleFleets(homes: string[], version: string, running: (label: string) => boolean,
  label: (home: string) => string = (h) => profileLabel(profileOf(h))): string[] {
  return homes.map((h) => [h, label(h)] as const)
    .filter(([h, l]) => running(l) && readVersion(h) !== version)
    .map(([, l]) => l);
}

/** The launchd labels of the running fleets that run the private fleet's main agent, as their own config names none. */
export function inheritingFleets(homes: string[], running: (label: string) => boolean,
  label: (home: string) => string = (h) => profileLabel(profileOf(h))): string[] {
  // a config that does not parse stops its daemon at start anyway
  const namesOwn = (h: string) => { try { return loadConfig(resolvePaths(h).config).mainAgent !== undefined; } catch { return true; } };
  return homes.filter((h) => profileOf(h) !== PRIVATE && running(label(h)) && !namesOwn(h)).map(label);
}
