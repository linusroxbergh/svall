import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleRuntime } from '../src/runtime.js';
import { inheritingFleets, integrationsFor, projectsFolder, requireInstalledApp, setupPlan, staleFleets, suggestProjects } from '../src/setup-plan.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('setupPlan', () => {
  it('lists the agents found and every file setup writes for them', () => {
    const home = makeHome();
    const plan = setupPlan({
      home, projects: '~/Developer', found: [{ kind: 'claude', path: '/u/.local/bin/claude', version: '2.1.0' }], folders: [], integrations: undefined,
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', opencodePlugin: '/u/.config/opencode/plugins/svall.js', launchAgentsDir: '/u/Library/LaunchAgents',
      fleets: [], shimDir: '/u/.local/bin', pathEnv: '/usr/bin:/u/.local/bin', answered: true, cli: 'svall',
    });
    expect(plan.agents.map((a) => a.kind)).toEqual(['claude']);
    expect(plan.writes.map((w) => w.path)).toEqual([
      '/u/.claude/settings.json', expect.stringMatching(/\.plist$/), '/u/.local/bin/svall', home,
    ]);
    expect(plan.writes[0]!.agent).toBe('claude');
    expect(plan.shimOnPath).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.install).toBeUndefined();
    expect(plan.projects).toBe('~/Developer');
  });

  it('says what blocks setup when only an agent\'s folder is here', () => {
    const plan = setupPlan({ projects: '~/Developer', home: makeHome(), found: [], folders: [{ kind: 'codex', path: '/u/.codex' }], integrations: undefined, settingsPath: '/s', codexHooks: '/c', opencodePlugin: '/u/.config/opencode/plugins/svall.js',
      launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.blockers).toEqual([expect.stringContaining('needs the claude, codex or opencode command')]);
    expect(plan.install?.map((i) => i.kind)).toEqual(['claude', 'codex', 'opencode']);
  });

  it('says the CLI is what setup needs when no agent is installed, and how to install each', () => {
    const plan = setupPlan({ projects: '~/Developer', home: makeHome(), found: [], folders: [], integrations: undefined, settingsPath: '/s', codexHooks: '/c', opencodePlugin: '/u/.config/opencode/plugins/svall.js',
      launchAgentsDir: '/l', fleets: [], shimDir: '/u/.local/bin', pathEnv: '/usr/bin', answered: true, cli: 'svall' });
    expect(plan.blockers).toEqual(["Svall runs Claude Code, Codex or OpenCode in its terminals, so it needs the claude, codex or opencode command. The desktop apps don't install it. Install one in Terminal, then check again."]);
    expect(plan.install).toEqual([
      { kind: 'claude', command: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://code.claude.com/docs/en/setup' },
      { kind: 'codex', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', url: 'https://learn.chatgpt.com/docs/codex/cli' },
      { kind: 'opencode', command: 'curl -fsSL https://opencode.ai/install | bash', url: 'https://opencode.ai/docs/' },
    ]);
    expect(plan.shimOnPath).toBe(false);
  });

  it('lists the OpenCode plugin when OpenCode is found', () => {
    const plan = setupPlan({ projects: '~/Developer', home: makeHome(), found: [{ kind: 'opencode', path: '/u/.opencode/bin/opencode' }], folders: [], integrations: undefined,
      settingsPath: '/s', codexHooks: '/c', opencodePlugin: '/u/.config/opencode/plugins/svall.js', launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.writes).toContainEqual({ what: 'OpenCode plugin', path: '/u/.config/opencode/plugins/svall.js', agent: 'opencode' });
  });

  it('says the login shell did not answer rather than that nothing is installed', () => {
    const plan = setupPlan({ projects: '~/Developer', home: makeHome(), found: [], folders: [], integrations: undefined, settingsPath: '/s', codexHooks: '/c', opencodePlugin: '/u/.config/opencode/plugins/svall.js',
      launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: false, cli: "'/A/node' '/A/svall.mjs'" });
    expect(plan.blockers).toEqual([expect.stringContaining('login shell did not answer')]);
    expect(plan.blockers[0]).toContain("run '/A/node' '/A/svall.mjs' setup in a terminal");
    expect(plan.install).toBeUndefined();
  });

  it('lists a turned-off agent\'s file with the choice saved, for the screen to leave out while it stays off', () => {
    const plan = setupPlan({ projects: '~/Developer', home: makeHome(), found: [{ kind: 'claude', path: '/c' }, { kind: 'codex', path: '/x' }], folders: [], integrations: ['codex'],
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', opencodePlugin: '/u/.config/opencode/plugins/svall.js', launchAgentsDir: '/l', fleets: [], shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.integrations).toEqual(['codex']);
    expect(plan.writes.filter((w) => w.agent)).toEqual([
      { what: 'Claude Code hooks and status line', path: '/u/.claude/settings.json', agent: 'claude' },
      { what: 'Codex hooks', path: '/u/.codex/hooks.json', agent: 'codex' },
    ]);
  });

  it('lists an agent whose folder is here without its CLI, with its hooks, and the plists of the other fleets', () => {
    const plan = setupPlan({ projects: '~/Developer', home: makeHome(), found: [{ kind: 'claude', path: '/c' }], folders: [{ kind: 'claude', path: '/u/.claude' }, { kind: 'codex', path: '/u/.codex' }], integrations: undefined,
      settingsPath: '/u/.claude/settings.json', codexHooks: '/u/.codex/hooks.json', opencodePlugin: '/u/.config/opencode/plugins/svall.js', launchAgentsDir: '/l', fleets: ['/u/.svall-work'],
      shimDir: '/b', pathEnv: '', answered: true, cli: 'svall' });
    expect(plan.agents).toEqual([{ kind: 'claude', path: '/c' }, { kind: 'codex', path: '/u/.codex', folderOnly: true }]);
    expect(plan.writes.map((w) => w.path)).toContain('/u/.codex/hooks.json');
    expect(plan.writes).toContainEqual({ what: 'Service for the work fleet', path: expect.stringMatching(/^\/l\/.*work\.plist$/) });
  });
});

describe('suggestProjects', () => {
  it('keeps a folder saved before, and otherwise suggests the first usual code folder in home, as named there', () => {
    const user = makeHome();
    expect(suggestProjects(user, '~/work')).toBe('~/work');
    fs.mkdirSync(path.join(user, 'code'));
    fs.mkdirSync(path.join(user, 'repos'));
    fs.writeFileSync(path.join(user, 'Developer'), '');
    expect(suggestProjects(user, '~')).toBe('~/code');
  });

  it('suggests ~/Developer when home has none of the usual code folders', () => {
    expect(suggestProjects(makeHome(), '~')).toBe('~/Developer');
  });
});

describe('projectsFolder', () => {
  it('takes a folder by full path or from ~, here or still to be made', () => {
    const dir = makeHome();
    expect(projectsFolder(` ${dir} `)).toBe(dir);
    expect(projectsFolder('~/Developer')).toBe('~/Developer');
  });

  it('refuses a relative path, an empty one and a file', () => {
    const file = path.join(makeHome(), 'notes');
    fs.writeFileSync(file, '');
    expect(() => projectsFolder('code')).toThrow('the projects folder must be a full path or start with ~');
    expect(() => projectsFolder('  ')).toThrow('the projects folder must be a full path or start with ~');
    expect(() => projectsFolder(file)).toThrow(`${file} is a file, not a folder`);
  });
});

describe('integrationsFor', () => {
  it('keeps every agent not found on, so only one found and left out stays off', () => {
    expect(integrationsFor(['claude'], ['claude'])).toEqual(['claude', 'codex', 'opencode']);
    expect(integrationsFor(['claude'], ['claude', 'codex'])).toEqual(['claude', 'opencode']);
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
  it('names the running fleets whose daemon wrote another version, and leaves one still starting and the rest', () => {
    const a = makeHome(), b = makeHome(), c = makeHome(), d = makeHome(), e = makeHome(), f = makeHome();
    fs.writeFileSync(path.join(a, 'version'), '0.1.0 (10)\n');
    fs.writeFileSync(path.join(b, 'version'), '0.1.1 (12)\n7\n');
    fs.writeFileSync(path.join(c, 'version'), '0.1.0 (10)\n7\n');
    fs.writeFileSync(path.join(e, 'version'), '0.1.0 (10)\n6\n');
    fs.writeFileSync(path.join(f, 'version'), '0.1.0 (10)\n7\n');
    const pidOf = (label: string) => (label.endsWith(path.basename(c)) ? undefined : 7);
    const label = (home: string) => `L.${path.basename(home)}`;
    expect(staleFleets([a, b, c, d, e, f], '0.1.1 (12)', pidOf, label)).toEqual([label(a), label(f)]);
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
