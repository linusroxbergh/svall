import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { codexPaths } from '@svall/svalld/codex/install';
import { unitDirOf } from '@svall/svalld/linux/setup';
import { opencodePaths } from '@svall/svalld/opencode/install';
import { realDeps } from '@svall/svalld/mobile';
import { LOGIN_SHELL_TIMEOUT_MS, takeLoginEnv } from '@svall/svalld/login-env';
import { userPaths } from '@svall/svalld/paths';
import { PRIVATE, profileHome } from '@svall/svalld/profile';
import { ownRuntime, type Runtime } from '@svall/svalld/runtime';
import { cliCommand } from '@svall/svalld/setup';
import { shq } from '@svall/svalld/text';
import { appQuit, fleetData, fleetHomes, libraryData, purge, runUninstall } from '@svall/svalld/uninstall';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
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

// the shims are gone by now, and a `svall` left on PATH may be the other build's; a companion's release went with them
export const keptLine = (kept: string[], r: Runtime): string =>
  `kept ${kept.join(', ')}; ${r.release ? `rm -rf ${kept.map(shq).join(' ')}` : `${cliCommand(r)} uninstall --purge`} deletes them`;

export function uninstallCommand(json: () => boolean, run: typeof runUninstall = runUninstall): Command {
  return new Command('uninstall')
    .description('remove what svall setup added and stop every fleet; asks before deleting the fleets and the app')
    .option('--purge', 'also delete every fleet and the app, without asking')
    .option('--from-app', 'run by the app itself: leave it open and in place')
    .option('--login-shell', 'take PATH and where the agents keep their files from the login shell, as an app opened from Finder has none')
    .option('--no-launchctl', 'leave the daemons running, only delete the files that start them')
    .action(async (o: { purge?: boolean; fromApp?: boolean; launchctl: boolean; loginShell?: boolean }) => {
      // stand-in folders would leave the hooks in the folders the user's own agents read
      if (o.loginShell && !(await takeLoginEnv())) {
        throw new Error(`the login shell did not answer within ${LOGIN_SHELL_TIMEOUT_MS / 1000} seconds, so nothing was uninstalled: try again, or run ${cliCommand(ownRuntime())} uninstall in a terminal`);
      }
      const r = await uninstall({ purge: Boolean(o.purge) }, {
        uninstall: () => run({
          home: profileHome(PRIVATE),
          homes: fleetHomes(os.homedir()),
          settingsPaths: userPaths().claudeSettingsFiles,
          codex: codexPaths(),
          opencode: opencodePaths(),
          launchAgentsDir: userPaths().launchAgents,
          shimDir: userPaths().shimDir,
          launchctl: o.launchctl,
          mobile: realDeps(),
          app: appQuit,
          tmux: process.env.TMUX,
          skipPid: o.fromApp ? process.ppid : undefined,
          unitDir: unitDirOf(os.homedir()),
          prefix: DEFAULT_PREFIX,
          cache: path.join(os.homedir(), '.cache', 'svall'),
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
        ...(r.kept.length ? [keptLine(r.kept, ownRuntime())] : []),
      ].join('\n'));
    });
}
