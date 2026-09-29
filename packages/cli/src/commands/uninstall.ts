import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { codexPaths } from '@svall/svalld/codex/install';
import { realDeps } from '@svall/svalld/mobile';
import { userPaths } from '@svall/svalld/paths';
import { PRIVATE, profileHome } from '@svall/svalld/profile';
import { appQuit, fleetData, fleetHomes, purge, runUninstall } from '@svall/svalld/uninstall';
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
    .option('--no-launchctl', 'leave the launchd agents running, only delete their plists')
    .action(async (o: { purge?: boolean; launchctl: boolean }) => {
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
        }),
        data: () => fleetData({
          homedir: os.homedir(),
          appDests: [process.env.SVALL_APP_DEST || '/Applications', path.join(os.homedir(), 'Applications')],
        }),
        purge,
        prompt: (q) => ask(q),
        isTTY: process.stdin.isTTY === true,
      });
      printResult(r, json(), () => [
        ...(r.done.length ? r.done : ['nothing to remove']),
        ...(r.kept.length ? [`kept ${r.kept.join(', ')}; svall uninstall --purge deletes them`] : []),
      ].join('\n'));
    });
}
