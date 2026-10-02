import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import type { AgentKind } from '@svall/protocol';
import { CODEX_TRUST } from '@svall/svalld/agent-hooks';
import { AGENTS, AGENT_KINDS, findAgents, mainAgent, onPath } from '@svall/svalld/agents';
import { codexPaths } from '@svall/svalld/codex/install';
import { loadConfig, saveConfig } from '@svall/svalld/config';
import { isRunning, kickstart, plistCurrent, takenOverBy } from '@svall/svalld/launchd';
import { expandHome, resolvePaths, userPaths } from '@svall/svalld/paths';
import { LOGIN_SHELL_TIMEOUT_MS, takeLoginEnv } from '@svall/svalld/login-env';
import { LAUNCHD_LABEL, PRIVATE, SHIM, profileLabel, profileOf } from '@svall/svalld/profile';
import { ownRuntime, runtimeVersion } from '@svall/svalld/runtime';
import { readOrUndefined } from '@svall/svalld/settings-file';
import { cliCommand, refreshFleetPlists, runSetup, setupState, type SetupState } from '@svall/svalld/setup';
import { inheritingFleets, integrationsFor, projectsFolder, requireInstalledApp, setupPlan, staleFleets, suggestProjects } from '@svall/svalld/setup-plan';
import { fleetHomes } from '@svall/svalld/uninstall';
import { grouped, renderGroups, useColor } from '../checks-view.js';
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
    .option('--found <list>', 'the agents the setup screen showed; those left out of --agents stay off (default: the agents found now)')
    .option('--projects <dir>', 'where new characters start, made if missing; saved as defaultCwd')
    .option('--if-needed', 'set up only what is missing or out of date, and restart daemons of another version')
    .option('--login-shell', 'take PATH, CLAUDE_CONFIG_DIR and CODEX_HOME from the login shell, as an app opened from Finder has none')
    .action(async (o: { launchctl: boolean; check?: boolean; plan?: boolean; agents?: string; found?: string; projects?: string; ifNeeded?: boolean; loginShell?: boolean }) => {
      const answered = o.loginShell ? await takeLoginEnv() : true;
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (t.name !== PRIVATE) throw new Error(`${SHIM} setup configures the private fleet; run ${SHIM} ${t.name} to open that one`);
      const runtime = ownRuntime();
      requireInstalledApp(runtime);
      // stand-in folders could put the hooks where the user's own agents never look
      if (!answered && !o.plan && !o.check && !o.ifNeeded) {
        throw new Error(`the login shell did not answer within ${LOGIN_SHELL_TIMEOUT_MS / 1000} seconds, so setup changed nothing: try again, or run ${cliCommand(runtime)} setup in a terminal`);
      }
      const configFile = resolvePaths(t.home).config;
      const settingsPath = userPaths().claudeSettings;
      const codex = codexPaths();
      const { launchAgents, shimDir } = userPaths();
      // setup takes an agent whose own folder is here as installed, even when its CLI is not on PATH
      const folderOf = (k: AgentKind) => (k === 'claude' ? path.dirname(settingsPath) : codex.dir);
      const hasFolder = (k: AgentKind) => fs.existsSync(folderOf(k));
      // the choices are saved only once setup is about to write, so a run that stops has changed nothing
      let choices: Parameters<typeof saveConfig>[1] | undefined;
      if (o.agents !== undefined) {
        if (o.plan || o.check || o.ifNeeded) throw new Error('--agents is for a setup that writes everything');
        const kinds = (list: string): AgentKind[] => list.split(',').map((name) => {
          if (!AGENT_KINDS.includes(name as AgentKind)) throw new Error(`unknown agent ${name}`);
          return name as AgentKind;
        });
        const chosen = kinds(o.agents);
        const runnable = findAgents(process.env.PATH ?? '');
        const found = o.found !== undefined ? kinds(o.found) : AGENT_KINDS.filter((k) => runnable.includes(k) || hasFolder(k));
        const config = loadConfig(configFile);
        // a fleet with no main agent set runs claude when both are found; turning off the main agent, saved or not, makes
        // the one left on whose CLI is here the main agent
        const on = chosen.filter((k) => runnable.includes(k));
        if (!on.length && runnable.length) throw new Error(`--agents ${o.agents} leaves on no agent whose CLI is on PATH; add ${runnable.join(' or ')}`);
        const main = on.length && !on.includes(mainAgent(config.mainAgent, found)) ? { mainAgent: on[0] } : {};
        choices = { integrations: integrationsFor(chosen, found, config.integrations), ...main };
      }
      if (o.projects !== undefined) {
        if (o.plan || o.check || o.ifNeeded) throw new Error('--projects is for a setup that writes everything');
        choices = { ...choices, defaultCwd: projectsFolder(o.projects) };
      }
      const integrations = choices?.integrations ?? loadConfig(configFile).integrations;
      const homes = fleetHomes(os.homedir());
      const label = (h: string) => profileLabel(profileOf(h));
      if (o.plan) {
        const found = await Promise.all(findAgents(process.env.PATH ?? '').map(async (kind) => {
          const bin = path.join(onPath(AGENTS[kind].bin, process.env.PATH ?? '')!, AGENTS[kind].bin);
          const version = await execFileP(bin, ['--version'], { timeout: 5_000 }).then((r) => r.stdout.trim().split('\n')[0], () => undefined);
          return { kind, path: bin, version };
        }));
        // the stand-in folders say nothing of whether the user's own PATH holds the shim
        const plan = setupPlan({
          home: t.home, projects: suggestProjects(os.homedir(), loadConfig(configFile).defaultCwd), found, folders: AGENT_KINDS.filter(hasFolder).map((kind) => ({ kind, path: folderOf(kind) })), integrations, settingsPath, codexHooks: codex.hooks, launchAgentsDir: launchAgents,
          // the plists a setup from this screen writes for the other fleets, taking over any another copy runs
          fleets: homes.filter((h) => profileOf(h) !== PRIVATE && !plistCurrent({ home: h, label: label(h), launchAgentsDir: launchAgents, runtime })),
          shimDir, pathEnv: answered ? process.env.PATH ?? '' : '', answered, cli: cliCommand(runtime),
        });
        process.stdout.write(`${JSON.stringify(plan)}\n`);
        return;
      }
      const plistOf = (h: string) => readOrUndefined(path.join(launchAgents, `${label(h)}.plist`));
      if (o.ifNeeded) {
        const owner = takenOverBy(plistOf(t.home), runtime);
        if (owner) {
          const warnings = [`${owner} runs these fleets; open that copy of Svall, or run ${cliCommand(runtime)} setup to move them here`];
          printResult({ done: [], warnings }, json(), () => warnings.join('\n'));
          return;
        }
      }
      const options = { home: t.home, settingsPath, codex, launchAgentsDir: launchAgents, shimDir, runtime, agents: findAgents(process.env.PATH ?? ''), integrations };
      // this throws on a file setup could not write back, so --check covers it too; a refresh still restarts old daemons
      let state: SetupState | undefined;
      let unwritable: string | undefined;
      try {
        state = setupState(options);
      } catch (e) {
        if (!o.ifNeeded || o.check) throw e;
        unwritable = (e as Error).message;
      }
      if (o.check) {
        const checks = await preflight(realPreflightDeps(t.home));
        const notes: Check[] = [];
        // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks, the shims or the plist;
        // it puts this checkout's app in place, so shims or a plist that run another checkout, moved or not, are out of date
        if (state!.hooksStale) notes.push({ name: 'hooks', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
        if (state!.shimsStale) notes.push({ name: 'shims', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
        if (state!.plistStale) notes.push({ name: 'launchd plist', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
        // a failed check is listed too, as --json has no other way to say why it exits 1
        const warnings = [...checks.filter((c) => c.status === 'warn' || c.status === 'fail').map(checkLine), ...notes.map(checkLine)];
        printResult({ done: [], warnings }, json(), () => renderGroups(grouped([...checks, ...notes]), useColor()));
        if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
        return;
      }
      const system = o.launchctl && process.platform === 'darwin';
      // a fleet another copy on disk runs keeps its daemon, whatever version it is
      const ours = homes.filter((h) => !takenOverBy(plistOf(h), runtime));
      // only a fleet whose window is open runs; the rest start on the new build with their window
      const running = new Set<string>();
      if (system) for (const h of ours) if (await isRunning(label(h))) running.add(label(h));
      const stale = staleFleets(homes, runtimeVersion(), (l) => running.has(l));
      if (o.ifNeeded) {
        const fleetsStale = ours.some((h) => profileOf(h) !== PRIVATE && !plistCurrent({ home: h, label: label(h), launchAgentsDir: launchAgents, runtime }));
        // stand-in folders must not replace what a setup with the real login environment wrote
        if (!answered || !state || (!state.hooksStale && !state.shimsStale && !state.plistStale && !fleetsStale)) {
          const done = system ? await kickstart(stale) : [];
          const warnings = [
            ...answered ? [] : ['the login shell did not answer, so the hooks, shims and plists were left as they are'],
            ...unwritable ? [unwritable] : [],
          ];
          printResult({ done, warnings }, json(), () => [...done, ...warnings].join('\n'));
          return;
        }
      }
      const warnings = requireReady(await preflight({ ...realPreflightDeps(t.home), ...choices?.mainAgent ? { mainAgent: choices.mainAgent } : {} }));
      if (choices) {
        fs.mkdirSync(t.home, { recursive: true });
        if (choices.defaultCwd) fs.mkdirSync(expandHome(choices.defaultCwd), { recursive: true });
        saveConfig(configFile, choices);
      }
      const lines = await runSetup({ ...options, launchctl: system, replaceSettings: !o.ifNeeded }, state);
      const fleets = await refreshFleetPlists({ homes, runtime, launchAgentsDir: launchAgents, launchctl: system, takeOver: !o.ifNeeded });
      lines.push(...fleets.done);
      // a running fleet took the private fleet's main agent at its start, so a switch reaches it only through a restart
      const inheriting = choices?.mainAgent ? inheritingFleets(ours, (l) => running.has(l)) : [];
      const restart = [...new Set([...stale, ...inheriting])].filter((l) => l !== LAUNCHD_LABEL && !fleets.restarted.includes(l));
      if (system) lines.push(...await kickstart(restart));
      // Codex's trust ask is the user's next step, so it goes with the warnings the setup screen shows
      const done = lines.filter((l) => l !== CODEX_TRUST);
      if (done.length < lines.length) warnings.push(CODEX_TRUST);
      printResult({ done, warnings }, json(), () => [...done, ...warnings].join('\n'));
    });
}
