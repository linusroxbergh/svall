import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { repoRoot, userPaths } from '@archipelago/archid/paths';
import { OLD_LAUNCHD_LABEL, PRIVATE, profileLabel } from '@archipelago/archid/profile';
import { setupHome, type HomeSetup } from '@archipelago/archid/setup';
import { Client, ProtocolMismatch } from './client.js';
import { ask } from './prompt.js';
import type { Target } from './target.js';

export type LaunchDeps = {
  exists(p: string): boolean;
  exec(cmd: string, args: string[]): Promise<void>;
  prompt(q: string): Promise<string>;
  isTTY: boolean;
  connect(home: string): Promise<{ close(): void }>;
  setupHome(o: HomeSetup): Promise<string[]>;
  uid: number;
  launchAgentsDir: string;
  repoRoot: string;
  timeoutMs: number;
  intervalMs: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launch(t: Target, d: LaunchDeps): Promise<void> {
  const label = profileLabel(t.name);
  const domain = `gui/${d.uid}`;
  const plist = path.join(d.launchAgentsDir, `${label}.plist`);
  const home: HomeSetup = {
    home: t.home, label, repoRoot: d.repoRoot, launchAgentsDir: d.launchAgentsDir, launchctl: false,
    port: t.name === PRIVATE ? undefined : 0,
  };

  if (!d.exists(t.home)) {
    if (t.name === PRIVATE) throw new Error('no private fleet yet; run archi setup first');
    if (!t.managed) throw new Error(`no fleet at ${t.home}; $ARCHI_HOME must name a profile home`);
    const yes = d.isTTY && /^y(es)?$/i.test((await d.prompt(`create profile ${t.name} at ${t.home}? [y/N] `)).trim());
    if (!yes) throw new Error(`no profile ${t.name}; run archi ${t.name} in a terminal to create it`);
    await d.setupHome(home);
  }

  // an ad-hoc $ARCHI_HOME is opened as it stands; only a profile's own home gets an agent
  if (t.managed) {
    const loaded = await d.exec('launchctl', ['print', `${domain}/${label}`]).then(() => true, () => false);
    if (!loaded) {
      // setup moves an older install's agent; a second one beside it would lose the fleet's port and home to it
      if (d.exists(path.join(d.launchAgentsDir, `${profileLabel(t.name, OLD_LAUNCHD_LABEL)}.plist`))) {
        throw new Error('this fleet still runs under its old launchd label; run pnpm desktop:install to finish the update');
      }
      if (!d.exists(plist)) await d.setupHome(home);
      await d.exec('launchctl', ['bootstrap', domain, plist]);
    }
  }

  const end = Date.now() + d.timeoutMs;
  for (;;) {
    try { (await d.connect(t.home)).close(); break; } catch (e) {
      if (e instanceof ProtocolMismatch) throw e;
      const why = (e as Error).message;
      if (Date.now() >= end) throw new Error(`archid did not start; see ${path.join(t.home, 'archid.log')} (${why})`);
      await sleep(d.intervalMs);
    }
  }

  await d.exec('open', ['-n', '--env', `ARCHI_HOME=${t.home}`, '-a', 'Archipelago']).catch((e: Error) => {
    throw new Error(`Archipelago.app is not installed; run pnpm desktop:install (open: ${e.message})`);
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
