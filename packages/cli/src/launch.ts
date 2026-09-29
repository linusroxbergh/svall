import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { homeSetup, startFleet, type StartDeps } from '@svall/svalld/fleets';
import { repoRoot, userPaths } from '@svall/svalld/paths';
import { PRIVATE } from '@svall/svalld/profile';
import { setupHome } from '@svall/svalld/setup';
import { Client } from './client.js';
import { ask } from './prompt.js';
import type { Target } from './target.js';

export type LaunchDeps = StartDeps & {
  prompt(q: string): Promise<string>;
  isTTY: boolean;
};

export async function launch(t: Target, d: LaunchDeps): Promise<void> {
  if (!d.exists(t.home)) {
    if (t.name === PRIVATE) throw new Error('no private fleet yet; run svall setup first');
    if (!t.managed) throw new Error(`no fleet at ${t.home}; $SVALL_HOME must name a profile home`);
    const yes = d.isTTY && /^y(es)?$/i.test((await d.prompt(`create profile ${t.name} at ${t.home}? [y/N] `)).trim());
    if (!yes) throw new Error(`no profile ${t.name}; run svall ${t.name} in a terminal to create it`);
    await d.setupHome(homeSetup(t, d));
  }

  await startFleet(t, d);

  await d.exec('open', ['-n', '--env', `SVALL_HOME=${t.home}`, '-a', 'Svall']).catch((e: Error) => {
    throw new Error(`Svall.app is not installed; run pnpm desktop:install (open: ${e.message})`);
  });
}

const execFileP = promisify(execFile);

export function realDeps(): LaunchDeps {
  return {
    exists: (p) => fs.existsSync(p),
    exec: async (cmd, args) => { await execFileP(cmd, args); },
    prompt: (q) => ask(q),
    isTTY: process.stdin.isTTY === true,
    connect: (home) => Client.connect(home),
    setupHome,
    uid: os.userInfo().uid,
    launchAgentsDir: userPaths().launchAgents,
    repoRoot: repoRoot(),
    timeoutMs: 15_000,
    intervalMs: 200,
  };
}
