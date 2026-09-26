import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { codexPaths } from '@archipelago/archid/codex/install';
import { defaultsPrefs, moveOldIds, oldIdsLeft, runLaunchctl, signInsLeft } from '@archipelago/archid/legacy';
import { repoRoot, resolvePaths, userPaths } from '@archipelago/archid/paths';
import { LAUNCHD_LABEL, PRIVATE } from '@archipelago/archid/profile';
import { claudeHooksCurrent, codexHooksCurrent, plistCurrent, readCodexHooks, readJsonSettings, requireWritableHooks, runSetup, shimsCurrent } from '@archipelago/archid/setup';
import { appQuit, fleetHomes } from '@archipelago/archid/uninstall';
import { printResult } from '../format.js';
import { preflight, realPreflightDeps, requireReady } from './doctor.js';
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
      const warnings = requireReady(await preflight(realPreflightDeps(t.home)));
      const settingsPath = userPaths().claudeSettings;
      const library = path.join(os.homedir(), 'Library');
      const signIns = signInsLeft(library);
      if (signIns) warnings.push(`! sign-ins  ${signIns}`);
      // these throw on a file setup could not write back, so --check covers it too
      const settings = readJsonSettings(settingsPath);
      const codex = codexPaths();
      const codexHooks = readCodexHooks(codex);
      requireWritableHooks(t.home, settings, codexHooks);
      if (o.check) {
        // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks, the shims or the plist
        const script = resolvePaths(t.home).hookScript;
        if (!claudeHooksCurrent(settings.settings, t.home) || (codexHooks && !codexHooksCurrent(codexHooks.settings, script))) {
          warnings.push('! hooks  missing or out of date: run archi setup');
        }
        // desktop:install puts this checkout's app in place, so shims or a plist that run another checkout, moved or not, are out of date
        if (!shimsCurrent(userPaths().shimDir, repoRoot())) warnings.push('! shims  missing or out of date: run archi setup');
        if (!plistCurrent({ home: t.home, label: LAUNCHD_LABEL, launchAgentsDir: userPaths().launchAgents, repoRoot: repoRoot() })) {
          warnings.push('! launchd  plist missing or out of date: run archi setup');
        }
        if (oldIdsLeft(userPaths().launchAgents, library)) warnings.push('! ids  launchd agents or app data under the old com.archipelago ids, out of date: run archi setup');
        printResult({ done: [], warnings }, json(), () => [...warnings, 'ready for archi setup'].join('\n'));
        return;
      }
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
      }).catch((e: Error) => {
        // what moved stays moved, and a second run finds nothing left to say it
        if (moved.length) e.message = [...moved, e.message].join('\n');
        throw e;
      })];
      printResult({ done: lines, warnings }, json(), () => [...lines, ...warnings].join('\n'));
    });
}
