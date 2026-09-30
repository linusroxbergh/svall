import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { LAUNCHD_LABEL, SHIM, profileLabel, profileOf } from './profile.js';
import { bundledVersion, type Runtime } from './runtime.js';

export type FoundAgent = { kind: AgentKind; path: string; version?: string };
export type SetupPlan = { agents: FoundAgent[]; writes: { what: string; path: string }[]; shimDir: string; shimOnPath: boolean; blockers: string[] };

/** What the app's setup screen shows before anything is written. */
export function setupPlan(o: {
  home: string; found: FoundAgent[]; integrations?: AgentKind[]; settingsPath: string; codexHooks: string;
  launchAgentsDir: string; shimDir: string; pathEnv: string;
}): SetupPlan {
  const on = (k: AgentKind) => o.found.some((a) => a.kind === k) && (!o.integrations || o.integrations.includes(k));
  const writes = [
    ...(on('claude') ? [{ what: 'Claude Code hooks and status line', path: o.settingsPath }] : []),
    ...(on('codex') ? [{ what: 'Codex hooks', path: o.codexHooks }] : []),
    { what: 'the background service that keeps fleets running', path: path.join(o.launchAgentsDir, `${LAUNCHD_LABEL}.plist`) },
    { what: `the ${SHIM} command`, path: path.join(o.shimDir, SHIM) },
    { what: 'your fleet', path: o.home },
  ];
  return {
    agents: o.found, writes, shimDir: o.shimDir, shimOnPath: o.pathEnv.split(':').includes(o.shimDir),
    blockers: o.found.length ? [] : ['Install Claude Code or Codex first, then check again.'],
  };
}

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
