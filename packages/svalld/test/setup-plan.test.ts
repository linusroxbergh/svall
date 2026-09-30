import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleRuntime } from '../src/runtime.js';
import { integrationsFor, requireInstalledApp, setupPlan, staleFleets } from '../src/setup-plan.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('setupPlan', () => {
  it('lists the agents found and every file setup writes for them', () => {
    const home = makeHome();
    const plan = setupPlan({
      home, found: [{ kind: 'claude', path: '/u/.local/bin/claude', version: '2.1.0' }], integrations: undefined,
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', launchAgentsDir: '/u/Library/LaunchAgents',
      shimDir: '/u/.local/bin', pathEnv: '/usr/bin:/u/.local/bin',
    });
    expect(plan.agents.map((a) => a.kind)).toEqual(['claude']);
    expect(plan.writes.map((w) => w.path)).toEqual([
      '/u/.claude/settings.json', expect.stringMatching(/\.plist$/), '/u/.local/bin/svall', home,
    ]);
    expect(plan.shimOnPath).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it('says what blocks setup when no agent is installed', () => {
    const plan = setupPlan({ home: makeHome(), found: [], integrations: undefined, settingsPath: '/s', codexHooks: '/c',
      launchAgentsDir: '/l', shimDir: '/u/.local/bin', pathEnv: '/usr/bin' });
    expect(plan.blockers).toEqual(['Install Claude Code or Codex first, then check again.']);
    expect(plan.shimOnPath).toBe(false);
  });

  it('leaves out the files of an agent the user turned off', () => {
    const plan = setupPlan({ home: makeHome(), found: [{ kind: 'claude', path: '/c' }, { kind: 'codex', path: '/x' }], integrations: ['codex'],
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', launchAgentsDir: '/l', shimDir: '/b', pathEnv: '' });
    expect(plan.writes.map((w) => w.path)).not.toContain('/u/.claude/settings.json');
    expect(plan.writes.map((w) => w.path)).toContain('/u/.codex/hooks.json');
  });
});

describe('integrationsFor', () => {
  it('keeps every agent not found on, so only one found and left out stays off', () => {
    expect(integrationsFor(['claude'], ['claude'])).toEqual(['claude', 'codex']);
    expect(integrationsFor(['claude'], ['claude', 'codex'])).toEqual(['claude']);
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
