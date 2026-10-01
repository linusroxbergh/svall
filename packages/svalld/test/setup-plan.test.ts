import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleRuntime } from '../src/runtime.js';
import { inheritingFleets, integrationsFor, requireInstalledApp, setupPlan, staleFleets } from '../src/setup-plan.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('setupPlan', () => {
  it('lists the agents found and every file setup writes for them', () => {
    const home = makeHome();
    const plan = setupPlan({
      home, found: [{ kind: 'claude', path: '/u/.local/bin/claude', version: '2.1.0' }], folders: [], integrations: undefined,
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', launchAgentsDir: '/u/Library/LaunchAgents',
      fleets: [], shimDir: '/u/.local/bin', pathEnv: '/usr/bin:/u/.local/bin', answered: true, cli: 'svall',
    });
    expect(plan.agents.map((a) => a.kind)).toEqual(['claude']);
    expect(plan.writes.map((w) => w.path)).toEqual([
      '/u/.claude/settings.json', expect.stringMatching(/\.plist$/), '/u/.local/bin/svall', home,
    ]);
    expect(plan.writes[0]!.agent).toBe('claude');
    expect(plan.shimOnPath).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it('says what blocks setup when only an agent\'s folder is here', () => {
    const plan = setupPlan({ home: makeHome(), found: [], folders: [{ kind: 'codex', path: '/u/.codex' }], integrations: undefined, settingsPath: '/s', codexHooks: '/c',
      launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.blockers).toEqual([expect.stringMatching(/^Install /)]);
  });

  it('says what blocks setup when no agent is installed', () => {
    const plan = setupPlan({ home: makeHome(), found: [], folders: [], integrations: undefined, settingsPath: '/s', codexHooks: '/c',
      launchAgentsDir: '/l', fleets: [], shimDir: '/u/.local/bin', pathEnv: '/usr/bin', answered: true, cli: 'svall' });
    expect(plan.blockers).toEqual(['Install Claude Code (https://code.claude.com/docs/en/setup) or Codex (https://learn.chatgpt.com/docs/codex/cli) first, then check again.']);
    expect(plan.shimOnPath).toBe(false);
  });

  it('says the login shell did not answer rather than that nothing is installed', () => {
    const plan = setupPlan({ home: makeHome(), found: [], folders: [], integrations: undefined, settingsPath: '/s', codexHooks: '/c',
      launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: false, cli: "'/A/node' '/A/svall.mjs'" });
    expect(plan.blockers).toEqual([expect.stringContaining('login shell did not answer')]);
    expect(plan.blockers[0]).toContain("run '/A/node' '/A/svall.mjs' setup in a terminal");
  });

  it('lists a turned-off agent\'s file with the choice saved, for the screen to leave out while it stays off', () => {
    const plan = setupPlan({ home: makeHome(), found: [{ kind: 'claude', path: '/c' }, { kind: 'codex', path: '/x' }], folders: [], integrations: ['codex'],
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.integrations).toEqual(['codex']);
    expect(plan.writes.filter((w) => w.agent)).toEqual([
      { what: 'Claude Code hooks and status line', path: '/u/.claude/settings.json', agent: 'claude' },
      { what: 'Codex hooks', path: '/u/.codex/hooks.json', agent: 'codex' },
    ]);
  });

  it('lists an agent whose folder is here without its CLI, with its hooks, and the plists of the other fleets', () => {
    const plan = setupPlan({ home: makeHome(), found: [{ kind: 'claude', path: '/c' }], folders: [{ kind: 'claude', path: '/u/.claude' }, { kind: 'codex', path: '/u/.codex' }], integrations: undefined,
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', launchAgentsDir: '/l', fleets: ['/u/.svall-work'],
      shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.agents).toEqual([{ kind: 'claude', path: '/c' }, { kind: 'codex', path: '/u/.codex', folderOnly: true }]);
    expect(plan.writes.map((w) => w.path)).toContain('/u/.codex/hooks.json');
    expect(plan.writes).toContainEqual({ what: 'the background service of the work fleet', path: expect.stringMatching(/^\/l\/.*work\.plist$/) });
  });
});

describe('integrationsFor', () => {
  it('keeps every agent not found on, so only one found and left out stays off', () => {
    expect(integrationsFor(['claude'], ['claude'])).toEqual(['claude', 'codex']);
    expect(integrationsFor(['claude'], ['claude', 'codex'])).toEqual(['claude']);
  });
  it('keeps an agent turned off before off while no setup shows it', () => {
    expect(integrationsFor(['claude'], ['claude'], ['claude'])).toEqual(['claude']);
    expect(integrationsFor(['claude'], ['claude'], ['claude', 'codex'])).toEqual(['claude', 'codex']);
  });
});

describe('requireInstalledApp', () => {
  it('refuses an app run from a disk image or translocated by macOS', () => {
    expect(() => requireInstalledApp(bundleRuntime('/Volumes/Svall/Svall.app'))).toThrow(/Applications/);
    expect(() => requireInstalledApp(bundleRuntime('/private/var/folders/x/AppTranslocation/y/d/Svall.app'))).toThrow(/Applications/);
    expect(() => requireInstalledApp(bundleRuntime('/Applications/Svall.app'))).not.toThrow();
    expect(() => requireInstalledApp({ daemon: [], cli: [] })).not.toThrow();
  });
});

describe('staleFleets', () => {
  it('names the loaded fleets whose daemon runs another version or wrote none, and leaves the rest', () => {
    const a = makeHome(), b = makeHome(), c = makeHome(), d = makeHome();
    fs.writeFileSync(path.join(a, 'version'), '0.1.0 (10)\n');
    fs.writeFileSync(path.join(b, 'version'), '0.1.1 (12)\n');
    fs.writeFileSync(path.join(c, 'version'), '0.1.0 (10)\n');
    const loaded = (label: string) => !label.endsWith(path.basename(c));
    const label = (home: string) => `L.${path.basename(home)}`;
    expect(staleFleets([a, b, c, d], '0.1.1 (12)', loaded, label)).toEqual([label(a), label(d)]);
  });
});

describe('inheritingFleets', () => {
  it('names the loaded fleets whose config names no main agent, and leaves the private fleet, a stopped one and the rest', () => {
    const a = makeHome(), b = makeHome(), c = makeHome(), d = makeHome();
    fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ mainAgent: 'claude' }));
    fs.writeFileSync(path.join(d, 'config.json'), '{');
    const loaded = (label: string) => !label.endsWith(path.basename(c));
    const label = (home: string) => `L.${path.basename(home)}`;
    expect(inheritingFleets([path.join(os.homedir(), '.svall'), a, b, c, d], loaded, label)).toEqual([label(a)]);
  });
});
