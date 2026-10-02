import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { codexPaths } from '@svall/svalld/codex/install';
import { realDeps } from '@svall/svalld/mobile';
import { LOGIN_SHELL_TIMEOUT_MS, takeLoginEnv } from '@svall/svalld/login-env';
import { userPaths } from '@svall/svalld/paths';
import { PRIVATE, profileHome } from '@svall/svalld/profile';
import { ownRuntime } from '@svall/svalld/runtime';
import { cliCommand } from '@svall/svalld/setup';
import { appQuit, fleetData, fleetHomes, libraryData, purge, runUninstall } from '@svall/svalld/uninstall';
import { printResult } from '../format.js';
import { ask } from '../prompt.js';

export type UninstallDeps = {
  uninstall(): Promise<string[]>;
  data(): string[];
  purge(paths: string[]): Promise<string[]>;
  prompt(q: string): Promise<string>;
  isTTY: boolean;
};

export async function uninstall(o: { purge: boolean }, d: UninstallDeps): Promise<{ done: string[]; kept: string[] }> {
  const done = await d.uninstall();
  const data = d.data();
  if (!data.length) return { done, kept: [] };
  const yes = o.purge || (d.isTTY && /^y(es)?$/i.test((await d.prompt(
    `also delete ${data.join(', ')}? this cannot be undone [y/N] `,
  )).trim()));
  if (!yes) return { done, kept: data };
  return { done: [...done, ...await d.purge(data)], kept: [] };
}

export function uninstallCommand(json: () => boolean): Command {
  return new Command('uninstall')
    .description('remove what svall setup added and stop every fleet; asks before deleting the fleets and the app')
    .option('--purge', 'also delete every fleet and the app, without asking')
    .option('--from-app', 'run by the app itself: leave it open and in place')
    .option('--login-shell', 'take PATH, CLAUDE_CONFIG_DIR and CODEX_HOME from the login shell, as an app opened from Finder has none')
    .option('--no-launchctl', 'leave the launchd agents running, only delete their plists')
    .action(async (o: { purge?: boolean; fromApp?: boolean; launchctl: boolean; loginShell?: boolean }) => {
      // stand-in folders would leave the hooks in the folders the user's own agents read
      if (o.loginShell && !(await takeLoginEnv())) {
        throw new Error(`the login shell did not answer within ${LOGIN_SHELL_TIMEOUT_MS / 1000} seconds, so nothing was uninstalled: try again, or run ${cliCommand(ownRuntime())} uninstall in a terminal`);
      }
      const r = await uninstall({ purge: Boolean(o.purge) }, {
        uninstall: () => runUninstall({
          home: profileHome(PRIVATE),
          homes: fleetHomes(os.homedir()),
          settingsPaths: userPaths().claudeSettingsFiles,
          codex: codexPaths(),
          launchAgentsDir: userPaths().launchAgents,
          shimDir: userPaths().shimDir,
          launchctl: o.launchctl && process.platform === 'darwin',
          mobile: realDeps(),
          app: appQuit,
          tmux: process.env.TMUX,
          skipPid: o.fromApp ? process.ppid : undefined,
        }),
        data: () => fleetData({
          homedir: os.homedir(),
          appDests: [process.env.SVALL_APP_DEST || '/Applications', path.join(os.homedir(), 'Applications')],
          fromApp: o.fromApp,
        }),
        purge,
        prompt: (q) => ask(q),
        isTTY: !o.fromApp && process.stdin.isTTY === true,
      });
      // the app deletes its Library data itself once it has quit, as it would write it back while it runs
      printResult(o.fromApp ? { ...r, library: libraryData(os.homedir()) } : r, json(), () => [
        ...(r.done.length ? r.done : ['nothing to remove']),
        // the shims are gone by now, and a `svall` left on PATH may be the other build's
        ...(r.kept.length ? [`kept ${r.kept.join(', ')}; ${cliCommand(ownRuntime())} uninstall --purge deletes them`] : []),
      ].join('\n'));
    });
}
