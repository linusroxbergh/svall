import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { findAgents } from '@archipelago/archid/agents';
import { codexPaths } from '@archipelago/archid/codex/install';
import { restartUnits, setupLinuxRelease, unitDirOf } from '@archipelago/archid/linux/setup';
import { realRun } from '@archipelago/archid/linux/service';
import { defaultsPrefs, moveOldIds, oldIdsLeft, runLaunchctl, signInsLeft, type Launchctl } from '@archipelago/archid/legacy';
import { resolvePaths, userPaths } from '@archipelago/archid/paths';
import { LAUNCHD_LABEL, PRIVATE, profileHome } from '@archipelago/archid/profile';
import { repoRoot } from '@archipelago/archid/release';
import { claudeHooksCurrent, codexHooksCurrent, plistCurrent, readCodexHooks, readJsonSettings, requireWritableHooks, runSetup, shimsCurrent, type RunFrom } from '@archipelago/archid/setup';
import { appQuit, fleetHomes } from '@archipelago/archid/uninstall';
import type { AgentKind } from '@archipelago/protocol';
import { DEFAULT_PREFIX, allowedSigners, installRelease, rollbackRelease } from '../../../../scripts/install-release.mjs';
import { sshVerify } from '../../../../scripts/release-manifest.mjs';
import { renderGroups, useColor } from '../checks-view.js';
import { Client } from '../client.js';
import { printResult } from '../format.js';
import { checkLine, preflight, realPreflightDeps, requireReady, type Check } from './doctor.js';
import type { Target } from '../target.js';

type Options = { launchctl: boolean; check?: boolean; release?: string; allowUnsigned?: boolean; replaceSettings?: boolean; rollback?: boolean | string };

type From = RunFrom & { rollbackTo?: string; version?: string };

// a release install replaces the checkout entirely: the service and the shims reach it through `current`
function runFrom(o: Options, done: string[]): From {
  if (!o.release) return { repoRoot: repoRoot() };
  const installed = installRelease({
    source: o.release,
    allowUnsigned: o.allowUnsigned,
    verify: sshVerify({ allowedSigners: allowedSigners() }),
  });
  done.push(`release ${installed.version} -> ${installed.release}`, `current -> ${installed.current}`);
  return { release: installed.current, rollbackTo: installed.rollbackTo ?? undefined, version: installed.version };
}

// launchd starts each fleet's daemon through `current`, so each is started again to run the release it now names
async function kickstartAgents(launchAgentsDir: string, launchctl: Launchctl): Promise<string[]> {
  const labels = (fs.existsSync(launchAgentsDir) ? fs.readdirSync(launchAgentsDir) : [])
    .filter((f) => f.endsWith('.plist') && (f === `${LAUNCHD_LABEL}.plist` || f.startsWith(`${LAUNCHD_LABEL}.`)))
    .map((f) => f.slice(0, -'.plist'.length)).sort();
  const done: string[] = [];
  for (const label of labels) {
    const target = `gui/${os.userInfo().uid}/${label}`;
    await launchctl(['kickstart', '-k', target]).then(
      () => { done.push(`launchctl kickstart -k ${target}`); },
      (e: Error) => { done.push(`${label} did not restart (${e.message.split('\n')[0]}); it runs the release current names from its next start`); },
    );
  }
  return done;
}

/** Recovery, so it asks nothing of the machine but the release it is going back to: the one named, or the one before. */
async function rollback(o: { systemd: boolean; restart: boolean; launchctl: Launchctl }, to?: string): Promise<string[]> {
  const releases = path.join(DEFAULT_PREFIX, 'releases');
  if (to !== undefined && path.dirname(path.resolve(releases, to)) !== releases) throw new Error(`${to} names no release under ${releases}`);
  const back = rollbackRelease(DEFAULT_PREFIX, to === undefined ? undefined : path.join(releases, to));
  const done = [`current -> ${back.release}`];
  if (!o.restart) return [...done, 'nothing was restarted: each daemon runs the release current names from its next start'];
  return [...done, ...await (o.systemd ? restartUnits(realRun, unitDirOf(os.homedir())) : kickstartAgents(userPaths().launchAgents, o.launchctl))];
}

type Daemon = { call(method: 'system.info', params: Record<string, never>): Promise<{ release: string }>; close(): void };

/**
 * The unit's daemon answers, and from the release just installed: a daemon still running the release
 * it replaced answers too. It writes its port within a few seconds of starting.
 */
export async function daemonRuns(release: string, connect: () => Promise<Daemon>, ms = 20_000, every = 500): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const daemon = await connect();
      try {
        if ((await daemon.call('system.info', {})).release === release) return true;
      } finally {
        daemon.close();
      }
    } catch { /* not up yet */ }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

async function setupPlatform(t: Target, o: Options, from: From, systemd: boolean, agents: AgentKind[]): Promise<string[]> {
  const shared = {
    home: t.home,
    settingsPath: userPaths().claudeSettings,
    codex: codexPaths(),
    shimDir: userPaths().shimDir,
    replaceSettings: o.replaceSettings,
    agents,
  };
  if (!systemd) {
    return runSetup({ ...from, ...shared, launchAgentsDir: userPaths().launchAgents, launchctl: o.launchctl && process.platform === 'darwin' });
  }
  // the conf setup writes leaves out what this tmux would refuse
  const tmuxVersion = await realRun('tmux', ['-V']).then((r) => r.stdout.trim(), () => undefined);
  return setupLinuxRelease({
    ...from, ...shared,
    fleet: t.name,
    tmuxVersion,
    homedir: os.homedir(),
    prefix: DEFAULT_PREFIX,
    unitDir: unitDirOf(os.homedir()),
    user: os.userInfo().username,
    run: realRun,
    systemctl: o.launchctl,
    probe: (fleet) => daemonRuns(from.version ?? '', () => Client.connect(profileHome(fleet))),
    rollback: (p) => rollbackRelease(p, from.rollbackTo),
  });
}

export function setupCommand(target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform, launchctl: Launchctl = runLaunchctl): Command {
  const systemd = platform === 'linux';
  return new Command('setup')
    .description(`install hooks, tmux.conf, ${systemd ? 'systemd user units' : 'the launchd agent'} and the archi and archipelago shims`)
    .option('--no-launchctl', systemd ? 'write files only, do not (re)start the systemd unit' : 'write files only; leave launchd, the app and what an older install left alone')
    .option('--check', 'only check what setup needs; change nothing')
    .option('--release <path>', 'install this release tree or archive and run the daemon from it')
    .option('--allow-unsigned', 'install a --release that carries no signature')
    .option('--replace-settings', 'replace the mission-control .claude/settings.json you have edited, keeping a copy')
    .option('--rollback [release]', 'put current back on this release, or on the one before, and restart the daemon')
    .action(async (o: Options) => {
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (o.rollback) {
        const done = await rollback({ systemd, restart: o.launchctl, launchctl }, typeof o.rollback === 'string' ? o.rollback : undefined);
        printResult({ done, warnings: [] }, json(), () => done.join('\n'));
        return;
      }
      if (t.name !== PRIVATE) throw new Error(`archi setup configures the private fleet; run archi ${t.name} to open that one`);
      const pre = realPreflightDeps(t.home, platform);
      const checks = await preflight(pre);
      const settingsPath = userPaths().claudeSettings;
      const library = path.join(os.homedir(), 'Library');
      const notes: Check[] = [];
      const signIns = systemd ? undefined : signInsLeft(library);
      if (signIns) notes.push({ name: 'sign-ins', status: 'warn', detail: signIns });
      // the agent CLIs the daemon's unit finds, which an ssh login's PATH may not reach
      const agents = findAgents(pre.agentPath ?? pre.pathEnv);
      const codex = codexPaths();
      const claudeWanted = agents.includes('claude') || fs.existsSync(path.dirname(settingsPath));
      const codexWanted = agents.includes('codex') || fs.existsSync(codex.dir);
      // these throw on a file setup could not write back, so --check covers it too
      const settings = claudeWanted ? readJsonSettings(settingsPath) : undefined;
      const codexHooks = readCodexHooks(codex, codexWanted);
      requireWritableHooks(t.home, settings, codexHooks);
      if (o.check) {
        // what a run of setup with the same flags would rewrite, as nothing else rewrites the Claude hooks, the shims or the plist
        const script = resolvePaths(t.home).hookScript;
        if ((settings && !claudeHooksCurrent(settings.settings, t.home)) || (codexHooks && !codexHooksCurrent(codexHooks.settings, script))) {
          notes.push({ name: 'hooks', status: 'warn', detail: 'missing or out of date: run archi setup' });
        }
        // shims or a plist that run another checkout or release, moved or not, are out of date
        const from: RunFrom = o.release ? { release: path.join(DEFAULT_PREFIX, 'current') } : { repoRoot: repoRoot() };
        if (!shimsCurrent(userPaths().shimDir, from)) notes.push({ name: 'shims', status: 'warn', detail: 'missing or out of date: run archi setup' });
        if (!systemd && !plistCurrent({ home: t.home, label: LAUNCHD_LABEL, launchAgentsDir: userPaths().launchAgents, ...from })) {
          notes.push({ name: 'launchd', status: 'warn', detail: 'plist missing or out of date: run archi setup' });
        }
        if (!systemd && oldIdsLeft(userPaths().launchAgents, library)) notes.push({ name: 'ids', status: 'warn', detail: 'launchd agents or app data under the old com.archipelago ids, out of date: run archi setup' });
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
      const warnings = [...requireReady(checks), ...notes.map(checkLine)];
      const system = o.launchctl && platform === 'darwin';
      if (!system && !systemd && oldIdsLeft(userPaths().launchAgents, library)) {
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
        run: launchctl,
        prefs: defaultsPrefs,
      }) : [];
      const done: string[] = [...moved];
      try {
        done.push(...await setupPlatform(t, o, runFrom(o, done), systemd, agents));
      } catch (e) {
        // what moved stays moved, and a second run finds nothing left to say it
        if (moved.length) (e as Error).message = [...moved, (e as Error).message].join('\n');
        throw e;
      }
      printResult({ done, warnings }, json(), () => [...done, ...warnings].join('\n'));
    });
}
