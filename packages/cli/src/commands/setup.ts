import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { findAgents } from '@svall/svalld/agents';
import { codexPaths } from '@svall/svalld/codex/install';
import { repoRoot, resolvePaths, userPaths } from '@svall/svalld/paths';
import { LAUNCHD_LABEL, PRIVATE } from '@svall/svalld/profile';
import { claudeHooksCurrent, codexHooksCurrent, plistCurrent, readCodexHooks, readJsonSettings, requireWritableHooks, runSetup, shimsCurrent } from '@svall/svalld/setup';
import { renderGroups, useColor } from '../checks-view.js';
import { printResult } from '../format.js';
import { checkLine, preflight, realPreflightDeps, requireReady, type Check } from './doctor.js';
import type { Target } from '../target.js';

export function setupCommand(target: () => Target, json: () => boolean): Command {
  return new Command('setup')
    .description('install hooks, tmux.conf, launchd agent and the svall shim')
    .option('--no-launchctl', 'write files only; leave launchd alone')
    .option('--check', 'only check what setup needs; change nothing')
    .action(async (o: { launchctl: boolean; check?: boolean }) => {
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (t.name !== PRIVATE) throw new Error(`svall setup configures the private fleet; run svall ${t.name} to open that one`);
      const checks = await preflight(realPreflightDeps(t.home));
      const settingsPath = userPaths().claudeSettings;
      const agents = findAgents(process.env.PATH ?? '');
      const codex = codexPaths();
      const claudeWanted = agents.includes('claude') || fs.existsSync(path.dirname(settingsPath));
      const codexWanted = agents.includes('codex') || fs.existsSync(codex.dir);
      // these throw on a file setup could not write back, so --check covers it too
      const settings = claudeWanted ? readJsonSettings(settingsPath) : undefined;
      const codexHooks = readCodexHooks(codex, codexWanted);
      requireWritableHooks(t.home, settings, codexHooks);
      if (o.check) {
        const notes: Check[] = [];
        // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks, the shims or the plist
        const script = resolvePaths(t.home).hookScript;
        if ((settings && !claudeHooksCurrent(settings.settings, t.home)) || (codexHooks && !codexHooksCurrent(codexHooks.settings, script))) {
          notes.push({ name: 'hooks', status: 'warn', detail: 'missing or out of date: run svall setup' });
        }
        // desktop:install puts this checkout's app in place, so shims or a plist that run another checkout, moved or not, are out of date
        if (!shimsCurrent(userPaths().shimDir, repoRoot())) notes.push({ name: 'shims', status: 'warn', detail: 'missing or out of date: run svall setup' });
        if (!plistCurrent({ home: t.home, label: LAUNCHD_LABEL, launchAgentsDir: userPaths().launchAgents, repoRoot: repoRoot() })) {
          notes.push({ name: 'launchd', status: 'warn', detail: 'plist missing or out of date: run svall setup' });
        }
        // a failed check is listed too, as --json has no other way to say why it exits 1
        const warnings = [...checks.filter((c) => c.status === 'warn' || c.status === 'fail').map(checkLine), ...notes.map(checkLine)];
        printResult({ done: [], warnings }, json(), () => renderGroups([
          { title: 'Tools', checks: checks.filter((c) => c.name === 'tmux' || c.name === 'node' || c.name === 'path') },
          { title: 'Agents', checks: checks.filter((c) => c.name === 'claude' || c.name === 'codex' || c.name === 'agents') },
          { title: 'Setup', checks: notes },
        ], useColor()));
        if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
        return;
      }
      const warnings = requireReady(checks);
      const system = o.launchctl && process.platform === 'darwin';
      const lines = await runSetup({
        home: t.home,
        settingsPath,
        codex,
        launchAgentsDir: userPaths().launchAgents,
        shimDir: userPaths().shimDir,
        repoRoot: repoRoot(),
        launchctl: system,
        agents,
      });
      printResult({ done: lines, warnings }, json(), () => [...lines, ...warnings].join('\n'));
    });
}
