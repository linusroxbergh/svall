import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import type { AgentKind } from '@svall/protocol';
import { AGENTS, AGENT_KINDS, findAgents, onPath } from '@svall/svalld/agents';
import { codexPaths } from '@svall/svalld/codex/install';
import { loadConfig, saveConfig } from '@svall/svalld/config';
import { resolvePaths, userPaths } from '@svall/svalld/paths';
import { takeLoginEnv } from '@svall/svalld/login-env';
import { LAUNCHD_LABEL, PRIVATE, SHIM, profileLabel, profileOf } from '@svall/svalld/profile';
import { ownRuntime } from '@svall/svalld/runtime';
import {
  claudeHooksCurrent, codexHooksCurrent, isLoaded, kickstart, plistCurrent, readCodexHooks, readJsonSettings, readOrUndefined, refreshFleetPlists,
  requireWritableHooks, runSetup, shimsCurrent, takenOverBy,
} from '@svall/svalld/setup';
import { integrationsFor, requireInstalledApp, runtimeVersion, setupPlan, staleFleets } from '@svall/svalld/setup-plan';
import { fleetHomes } from '@svall/svalld/uninstall';
import { renderGroups, useColor } from '../checks-view.js';
import { printResult } from '../format.js';
import { checkLine, preflight, realPreflightDeps, requireReady, type Check } from './doctor.js';
import type { Target } from '../target.js';

const execFileP = promisify(execFile);

export function setupCommand(target: () => Target, json: () => boolean): Command {
  return new Command('setup')
    .description('install hooks, tmux.conf, launchd agent and the svall shim')
    .option('--no-launchctl', 'write files only; leave launchd alone')
    .option('--check', 'only check what setup needs; change nothing')
    .option('--plan', 'print what setup would do, as the app shows it; change nothing')
    .option('--agents <list>', 'the agents to install hooks for, comma-separated; saved for later runs')
    .option('--if-needed', 'set up only what is missing or out of date, and restart daemons of another version')
    .option('--login-shell', 'take PATH, CLAUDE_CONFIG_DIR and CODEX_HOME from the login shell, as an app opened from Finder has none')
    .action(async (o: { launchctl: boolean; check?: boolean; plan?: boolean; agents?: string; ifNeeded?: boolean; loginShell?: boolean }) => {
      const answered = o.loginShell ? await takeLoginEnv() : true;
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (t.name !== PRIVATE) throw new Error(`${SHIM} setup configures the private fleet; run ${SHIM} ${t.name} to open that one`);
      const runtime = ownRuntime();
      requireInstalledApp(runtime);
      const configFile = resolvePaths(t.home).config;
      if (o.agents !== undefined) {
        if (o.plan || o.check) throw new Error('--agents is for a setup that writes');
        const chosen = o.agents.split(',');
        for (const name of chosen) if (!AGENT_KINDS.includes(name as AgentKind)) throw new Error(`unknown agent ${name}`);
        fs.mkdirSync(t.home, { recursive: true });
        saveConfig(configFile, { integrations: integrationsFor(chosen as AgentKind[], findAgents(process.env.PATH ?? '')) });
      }
      const integrations = loadConfig(configFile).integrations;
      const settingsPath = userPaths().claudeSettings;
      const codex = codexPaths();
      const { launchAgents, shimDir } = userPaths();
      if (o.plan) {
        const found = await Promise.all(findAgents(process.env.PATH ?? '').map(async (kind) => {
          const bin = path.join(onPath(AGENTS[kind].bin, process.env.PATH ?? '')!, AGENTS[kind].bin);
          const version = await execFileP(bin, ['--version'], { timeout: 5_000 }).then((r) => r.stdout.trim().split('\n')[0], () => undefined);
          return { kind, path: bin, version };
        }));
        // the stand-in folders say nothing of whether the user's own PATH holds the shim
        const plan = setupPlan({
          home: t.home, found, integrations, settingsPath, codexHooks: codex.hooks,
          launchAgentsDir: launchAgents, shimDir, pathEnv: answered ? process.env.PATH ?? '' : '',
        });
        process.stdout.write(`${JSON.stringify(plan)}\n`);
        return;
      }
      const homes = fleetHomes(os.homedir());
      const label = (h: string) => profileLabel(profileOf(h));
      const plistOf = (h: string) => readOrUndefined(path.join(launchAgents, `${label(h)}.plist`));
      if (o.ifNeeded) {
        const owner = takenOverBy(plistOf(t.home), runtime);
        if (owner) {
          const warnings = [`${owner} runs these fleets; open that copy of Svall, or run this copy's ${SHIM} setup to move them here`];
          printResult({ done: [], warnings }, json(), () => warnings.join('\n'));
          return;
        }
      }
      const agents = findAgents(process.env.PATH ?? '');
      const wants = (k: AgentKind, fallback: boolean) => fallback && (!integrations || integrations.includes(k));
      const claudeWanted = wants('claude', agents.includes('claude') || fs.existsSync(path.dirname(settingsPath)));
      const codexWanted = wants('codex', agents.includes('codex') || fs.existsSync(codex.dir));
      // these throw on a file setup could not write back, so --check covers it too
      const settings = claudeWanted ? readJsonSettings(settingsPath) : undefined;
      const codexHooks = readCodexHooks(codex, codexWanted);
      requireWritableHooks(t.home, settings, codexHooks);
      const { hookScript, statusScript } = resolvePaths(t.home);
      const holdsOurs = (file: string) => [hookScript, statusScript].some((s) => readOrUndefined(file)?.includes(s));
      const hooksStale = (settings && !claudeHooksCurrent(settings.settings, t.home)) || (codexHooks && !codexHooksCurrent(codexHooks.settings, hookScript))
        || (!claudeWanted && holdsOurs(settingsPath)) || (!codexWanted && holdsOurs(codex.hooks));
      const shimsStale = !shimsCurrent(shimDir, runtime);
      const plistStale = !plistCurrent({ home: t.home, label: LAUNCHD_LABEL, launchAgentsDir: launchAgents, runtime });
      if (o.check) {
        const checks = await preflight(realPreflightDeps(t.home));
        const notes: Check[] = [];
        // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks, the shims or the plist
        if (hooksStale) notes.push({ name: 'hooks', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
        // desktop:install puts this checkout's app in place, so shims or a plist that run another checkout, moved or not, are out of date
        if (shimsStale) notes.push({ name: 'shims', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
        if (plistStale) notes.push({ name: 'launchd', status: 'warn', detail: `plist missing or out of date: run ${SHIM} setup` });
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
      const system = o.launchctl && process.platform === 'darwin';
      // a fleet another copy on disk runs keeps its daemon, whatever version it is
      const ours = homes.filter((h) => !takenOverBy(plistOf(h), runtime));
      const loaded = new Set<string>();
      if (system) for (const h of ours) if (await isLoaded(label(h))) loaded.add(label(h));
      const stale = staleFleets(homes, runtimeVersion(), (l) => loaded.has(l));
      if (o.ifNeeded) {
        const fleetsStale = ours.some((h) => profileOf(h) !== PRIVATE && !plistCurrent({ home: h, label: label(h), launchAgentsDir: launchAgents, runtime }));
        // stand-in folders must not replace what a setup with the real login environment wrote
        if (!answered || (!hooksStale && !shimsStale && !plistStale && !fleetsStale)) {
          const done = system ? await kickstart(stale) : [];
          const warnings = answered ? [] : ['the login shell did not answer, so the hooks, shims and plists were left as they are'];
          printResult({ done, warnings }, json(), () => [...done, ...warnings].join('\n'));
          return;
        }
      }
      const warnings = requireReady(await preflight(realPreflightDeps(t.home)));
      const lines = await runSetup({
        home: t.home,
        settingsPath,
        codex,
        launchAgentsDir: launchAgents,
        shimDir,
        runtime,
        launchctl: system,
        agents,
        integrations,
        replaceSettings: !o.ifNeeded,
      });
      const fleets = await refreshFleetPlists({ homes, runtime, launchAgentsDir: launchAgents, launchctl: system, takeOver: !o.ifNeeded });
      lines.push(...fleets.done);
      if (system) lines.push(...await kickstart(stale.filter((l) => l !== LAUNCHD_LABEL && !fleets.restarted.includes(l))));
      printResult({ done: lines, warnings }, json(), () => [...lines, ...warnings].join('\n'));
    });
}
