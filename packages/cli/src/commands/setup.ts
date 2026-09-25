import { Command } from 'commander';
import { codexPaths } from '@archipelago/archid/codex/install';
import { repoRoot, resolvePaths, userPaths } from '@archipelago/archid/paths';
import { PRIVATE } from '@archipelago/archid/profile';
import { claudeHooksCurrent, codexHooksCurrent, readCodexHooks, readJsonSettings, requireWritableHooks, runSetup, shimsCurrent } from '@archipelago/archid/setup';
import { printResult } from '../format.js';
import { preflight, realPreflightDeps, requireReady } from './doctor.js';
import type { Target } from '../target.js';

export function setupCommand(target: () => Target, json: () => boolean): Command {
  return new Command('setup')
    .description('install hooks, tmux.conf, launchd agent and the archi and archipelago shims')
    .option('--no-launchctl', 'write files only, do not (re)start the launchd agent')
    .option('--check', 'only check what setup needs; change nothing')
    .action(async (o: { launchctl: boolean; check?: boolean }) => {
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (t.name !== PRIVATE) throw new Error(`archi setup configures the private fleet; run archi ${t.name} to open that one`);
      const warnings = requireReady(await preflight(realPreflightDeps()));
      const settingsPath = userPaths().claudeSettings;
      // these throw on a file setup could not write back, so --check covers it too
      const settings = readJsonSettings(settingsPath);
      const codex = codexPaths();
      const codexHooks = readCodexHooks(codex);
      requireWritableHooks(t.home, settings, codexHooks);
      if (o.check) {
        // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks or the shims
        const script = resolvePaths(t.home).hookScript;
        if (!claudeHooksCurrent(settings.settings, t.home) || (codexHooks && !codexHooksCurrent(codexHooks.settings, script))) {
          warnings.push('! hooks  missing or out of date: run archi setup');
        }
        if (!shimsCurrent(userPaths().shimDir)) warnings.push('! shims  missing or out of date: run archi setup');
        printResult({ done: [], warnings }, json(), () => [...warnings, 'ready for archi setup'].join('\n'));
        return;
      }
      const lines = await runSetup({
        home: t.home,
        settingsPath,
        codex,
        launchAgentsDir: userPaths().launchAgents,
        shimDir: userPaths().shimDir,
        repoRoot: repoRoot(),
        launchctl: o.launchctl && process.platform === 'darwin',
      });
      printResult({ done: lines, warnings }, json(), () => [...lines, ...warnings].join('\n'));
    });
}
