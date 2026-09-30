import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { AGENTS, AGENT_KINDS } from './agents.js';
import { LAUNCHD_LABEL, SHIM, profileLabel, profileOf } from './profile.js';
import { bundledVersion, type Runtime } from './runtime.js';

export type FoundAgent = { kind: AgentKind; path: string; version?: string };
export type SetupPlan = {
  agents: FoundAgent[]; integrations?: AgentKind[]; writes: { what: string; path: string; agent?: AgentKind }[];
  shimDir: string; shimOnPath: boolean; blockers: string[];
};

/** What the app's setup screen shows before anything is written: the screen leaves out the files of the agents it turns off. */
export function setupPlan(o: {
  home: string; found: FoundAgent[]; folders: AgentKind[]; integrations?: AgentKind[]; settingsPath: string; codexHooks: string;
  launchAgentsDir: string; fleets: string[]; shimDir: string; pathEnv: string; answered: boolean;
}): SetupPlan {
  // setup writes an agent's hooks when its CLI is on PATH or its own folder is here
  const has = (k: AgentKind) => o.found.some((a) => a.kind === k) || o.folders.includes(k);
  const writes = [
    ...(has('claude') ? [{ what: 'Claude Code hooks and status line', path: o.settingsPath, agent: 'claude' as const }] : []),
    ...(has('codex') ? [{ what: 'Codex hooks', path: o.codexHooks, agent: 'codex' as const }] : []),
    { what: 'the background service that keeps fleets running', path: path.join(o.launchAgentsDir, `${LAUNCHD_LABEL}.plist`) },
    ...o.fleets.map((h) => ({ what: `the background service of the ${profileOf(h)} fleet`, path: path.join(o.launchAgentsDir, `${profileLabel(profileOf(h))}.plist`) })),
    { what: `the ${SHIM} command`, path: path.join(o.shimDir, SHIM) },
    { what: 'your fleet', path: o.home },
  ];
  let blockers: string[] = [];
  if (!o.answered) blockers = ['Your login shell did not answer within 5 seconds, so Svall cannot see where Claude Code and Codex are. Check again.'];
  else if (!o.found.length) blockers = [`Install ${AGENT_KINDS.map((k) => `${AGENTS[k].label} (${AGENTS[k].installUrl})`).join(' or ')} first, then check again.`];
  return {
    agents: o.found, integrations: o.integrations, writes, shimDir: o.shimDir, shimOnPath: o.pathEnv.split(':').includes(o.shimDir), blockers,
  };
}

/** The integrations to save: the agents chosen, and every one not found now, so only an agent found and left out stays off. */
export const integrationsFor = (chosen: AgentKind[], found: AgentKind[]): AgentKind[] =>
  AGENT_KINDS.filter((k) => chosen.includes(k) || !found.includes(k));

/** Throws for an app run from a disk image or translocated by macOS, where the paths setup writes would not last. */
export function requireInstalledApp(r: Runtime): void {
  if (r.bundle && (r.bundle.startsWith('/Volumes/') || r.bundle.includes('/AppTranslocation/'))) {
    throw new Error('Move Svall to your Applications folder and open it from there, then set it up.');
  }
}

export const runtimeVersion = (): string => bundledVersion ?? 'dev';

const readVersion = (home: string): string | undefined => {
  try { return fs.readFileSync(path.join(home, 'version'), 'utf8').trim(); } catch { return undefined; }
};

/** The launchd labels of the loaded fleets whose daemon started as another version than `version`, or wrote none. */
export function staleFleets(homes: string[], version: string, loaded: (label: string) => boolean,
  label: (home: string) => string = (h) => profileLabel(profileOf(h))): string[] {
  return homes.map((h) => [h, label(h)] as const)
    .filter(([h, l]) => loaded(l) && readVersion(h) !== version)
    .map(([, l]) => l);
}
