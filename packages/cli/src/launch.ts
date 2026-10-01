import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { homeSetup, startFleet, type StartDeps } from '@svall/svalld/fleets';
import { userPaths } from '@svall/svalld/paths';
import { BUNDLE_ID, PRIVATE, SHIM } from '@svall/svalld/profile';
import { ownRuntime, variant } from '@svall/svalld/runtime';
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
    if (t.name === PRIVATE) throw new Error(`no private fleet yet; run ${SHIM} setup first`);
    if (!t.managed) throw new Error(`no fleet at ${t.home}; $SVALL_HOME must name a profile home`);
    const yes = d.isTTY && /^y(es)?$/i.test((await d.prompt(`create profile ${t.name} at ${t.home}? [y/N] `)).trim());
    if (!yes) throw new Error(`no profile ${t.name}; run ${SHIM} ${t.name} in a terminal to create it`);
    await d.setupHome(homeSetup(t, d));
  }

  await startFleet(t, d);

  await d.exec('open', ['-n', '--env', `SVALL_HOME=${t.home}`, ...(d.runtime.bundle ? ['-a', d.runtime.bundle] : ['-b', BUNDLE_ID])]).catch((e: Error) => {
    throw new Error(`could not open ${variant === 'release' ? 'Svall: reinstall it from svall.dev' : 'Svall Dev: run pnpm desktop:install'} (open: ${e.message})`);
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
    runtime: ownRuntime(),
    timeoutMs: 15_000,
    intervalMs: 200,
  };
}
