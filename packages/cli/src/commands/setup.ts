import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { findAgents } from '@archipelago/archid/agents';
import { codexPaths } from '@archipelago/archid/codex/install';
import { defaultsPrefs, moveOldIds, oldIdsLeft, runLaunchctl, signInsLeft } from '@archipelago/archid/legacy';
import { repoRoot, resolvePaths, userPaths } from '@archipelago/archid/paths';
import { LAUNCHD_LABEL, PRIVATE } from '@archipelago/archid/profile';
import { claudeHooksCurrent, codexHooksCurrent, plistCurrent, readCodexHooks, readJsonSettings, requireWritableHooks, runSetup, shimsCurrent } from '@archipelago/archid/setup';
import { appQuit, fleetHomes } from '@archipelago/archid/uninstall';
import { renderGroups, useColor } from '../checks-view.js';
import { printResult } from '../format.js';
import { checkLine, preflight, realPreflightDeps, requireReady, type Check } from './doctor.js';
import type { Target } from '../target.js';

export function setupCommand(target: () => Target, json: () => boolean): Command {
  return new Command('setup')
    .description('install hooks, tmux.conf, launchd agent and the archi and archipelago shims')
    .option('--no-launchctl', 'write files only; leave launchd, the app and what an older install left alone')
    .option('--check', 'only check what setup needs; change nothing')
    .action(async (o: { launchctl: boolean; check?: boolean }) => {
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (t.name !== PRIVATE) throw new Error(`archi setup configures the private fleet; run archi ${t.name} to open that one`);
      const checks = await preflight(realPreflightDeps(t.home));
      const settingsPath = userPaths().claudeSettings;
      const library = path.join(os.homedir(), 'Library');
      const notes: Check[] = [];
      const signIns = signInsLeft(library);
      if (signIns) notes.push({ name: 'sign-ins', status: 'warn', detail: signIns });
      const agents = findAgents(process.env.PATH ?? '');
      const codex = codexPaths();
      const claudeWanted = agents.includes('claude') || fs.existsSync(path.dirname(settingsPath));
      const codexWanted = agents.includes('codex') || fs.existsSync(codex.dir);
      // these throw on a file setup could not write back, so --check covers it too
      const settings = claudeWanted ? readJsonSettings(settingsPath) : undefined;
      const codexHooks = readCodexHooks(codex, codexWanted);
      requireWritableHooks(t.home, settings, codexHooks);
      if (o.check) {
        // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks, the shims or the plist
        const script = resolvePaths(t.home).hookScript;
        if ((settings && !claudeHooksCurrent(settings.settings, t.home)) || (codexHooks && !codexHooksCurrent(codexHooks.settings, script))) {
          notes.push({ name: 'hooks', status: 'warn', detail: 'missing or out of date: run archi setup' });
        }
        // desktop:install puts this checkout's app in place, so shims or a plist that run another checkout, moved or not, are out of date
        if (!shimsCurrent(userPaths().shimDir, repoRoot())) notes.push({ name: 'shims', status: 'warn', detail: 'missing or out of date: run archi setup' });
        if (!plistCurrent({ home: t.home, label: LAUNCHD_LABEL, launchAgentsDir: userPaths().launchAgents, repoRoot: repoRoot() })) {
          notes.push({ name: 'launchd', status: 'warn', detail: 'plist missing or out of date: run archi setup' });
        }
        if (oldIdsLeft(userPaths().launchAgents, library)) notes.push({ name: 'ids', status: 'warn', detail: 'launchd agents or app data under the old com.archipelago ids, out of date: run archi setup' });
        const warnings = [...checks.filter((c) => c.status === 'warn').map(checkLine), ...notes.map(checkLine)];
        printResult({ done: [], warnings }, json(), () => renderGroups([
          { title: 'Tools', checks: checks.filter((c) => c.name === 'tmux' || c.name === 'node' || c.name === 'path') },
          { title: 'Agents', checks: checks.filter((c) => c.name === 'claude' || c.name === 'codex' || c.name === 'agents') },
          { title: 'Setup', checks: notes },
        ], useColor()));
        if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
        return;
      }
      const warnings = [...requireReady(checks), ...notes.map(checkLine)];
      const system = o.launchctl && process.platform === 'darwin';
      if (!system && oldIdsLeft(userPaths().launchAgents, library)) {
        // an old agent left beside the plist setup writes would start with it at login
        warnings.push('! ids  what an older install left under the com.archipelago ids stays, as --no-launchctl moves nothing: run archi setup without it before you next log in');
      }
      // before setup starts the private fleet's agent, whose old one would hold its port. launchctl, defaults and
      // osascript reach the real user's services whatever $HOME says, so --no-launchctl moves nothing
      const moved = system ? await moveOldIds({
        library,
        launchAgentsDir: userPaths().launchAgents,
        homes: fleetHomes(os.homedir()),
        appDests: [process.env.ARCHI_APP_DEST || '/Applications', path.join(os.homedir(), 'Applications')],
        app: appQuit,
        run: runLaunchctl,
        prefs: defaultsPrefs,
      }) : [];
      const lines = [...moved, ...await runSetup({
        home: t.home,
        settingsPath,
        codex,
        launchAgentsDir: userPaths().launchAgents,
        shimDir: userPaths().shimDir,
        repoRoot: repoRoot(),
        launchctl: system,
        agents,
      }).catch((e: Error) => {
        // what moved stays moved, and a second run finds nothing left to say it
        if (moved.length) e.message = [...moved, e.message].join('\n');
        throw e;
      })];
      printResult({ done: lines, warnings }, json(), () => [...lines, ...warnings].join('\n'));
    });
}
