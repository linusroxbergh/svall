import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { codexPaths } from '@archipelago/archid/codex/install';
import { unitDirOf } from '@archipelago/archid/linux/setup';
import { realDeps } from '@archipelago/archid/mobile';
import { userPaths } from '@archipelago/archid/paths';
import { PRIVATE, profileHome } from '@archipelago/archid/profile';
import { appQuit, fleetData, fleetHomes, purge, runUninstall } from '@archipelago/archid/uninstall';
import { DEFAULT_PREFIX } from '../../../../scripts/install-release.mjs';
import { printResult } from '../format.js';
import { ask } from '../prompt.js';

export type UninstallDeps = {
  /** `force`: also where that strands a fleet a handover or another machine still needs */
  uninstall(o: { force: boolean }): Promise<string[]>;
  data(): string[];
  purge(paths: string[]): Promise<string[]>;
  prompt(q: string): Promise<string>;
  isTTY: boolean;
};

export async function uninstall(o: { purge: boolean; force?: boolean }, d: UninstallDeps): Promise<{ done: string[]; kept: string[] }> {
  const done = await d.uninstall({ force: o.force === true });
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
    .description('remove what archi setup added and stop every fleet; asks before deleting the fleets and the app')
    .option('--purge', 'also delete every fleet and the app, without asking')
    .option('--no-launchctl', 'leave the daemons running, only delete the files that start them')
    .option('--force', 'uninstall even where a fleet this machine owns, gateways or holds a handover of would be stranded; archi host remove checks all of this first')
    .action(async (o: { purge?: boolean; launchctl: boolean; force?: boolean }) => {
      const r = await uninstall({ purge: Boolean(o.purge), force: o.force === true }, {
        uninstall: ({ force }) => runUninstall({
          home: profileHome(PRIVATE),
          homes: fleetHomes(os.homedir()),
          settingsPaths: userPaths().claudeSettingsFiles,
          codex: codexPaths(),
          launchAgentsDir: userPaths().launchAgents,
          shimDir: userPaths().shimDir,
          launchctl: o.launchctl,
          mobile: realDeps(),
          app: appQuit,
          tmux: process.env.TMUX,
          unitDir: unitDirOf(os.homedir()),
          prefix: DEFAULT_PREFIX,
          force,
        }),
        data: () => fleetData({
          homedir: os.homedir(),
          appDests: [process.env.ARCHI_APP_DEST || '/Applications', path.join(os.homedir(), 'Applications')],
        }),
        purge,
        prompt: (q) => ask(q),
        isTTY: process.stdin.isTTY === true,
      });
      printResult(r, json(), () => [
        ...(r.done.length ? r.done : ['nothing to remove']),
        ...(r.kept.length ? [`kept ${r.kept.join(', ')}; archi uninstall --purge deletes them`] : []),
      ].join('\n'));
    });
}
