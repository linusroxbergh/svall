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
import { opencodePaths } from '@svall/svalld/opencode/install';
import { loadConfig, saveConfig } from '@svall/svalld/config';
import { kickstart, plistCurrent, runningPid, takenOverBy } from '@svall/svalld/launchd';
import { expandHome, resolvePaths, userPaths } from '@svall/svalld/paths';
import { LOGIN_SHELL_TIMEOUT_MS, takeLoginEnv } from '@svall/svalld/login-env';
import { LAUNCHD_LABEL, PRIVATE, SHIM, profileLabel, profileOf } from '@svall/svalld/profile';
import { ownRuntime, runtimeVersion } from '@svall/svalld/runtime';
import { readOrUndefined } from '@svall/svalld/settings-file';
import { cliCommand, refreshFleetPlists, runSetup, setupState, type SetupOptions, type SetupState } from '@svall/svalld/setup';
import { inheritingFleets, integrationsFor, projectsFolder, requireInstalledApp, setupPlan, staleFleets, suggestProjects } from '@svall/svalld/setup-plan';
import { fleetHomes } from '@svall/svalld/uninstall';
import { grouped, renderGroups, useColor } from '../checks-view.js';
import { printResult } from '../format.js';
import { checkLine, preflight, realPreflightDeps, requireReady, type Check } from './preflight.js';
import type { Target } from '../target.js';

const execFileP = promisify(execFile);

type Flags = { launchctl: boolean; check?: boolean; plan?: boolean; agents?: string; found?: string; projects?: string; ifNeeded?: boolean; loginShell?: boolean };
type Choices = Parameters<typeof saveConfig>[1];

// what every part of a setup run reads
type Run = Omit<SetupOptions, 'agents' | 'integrations'> & { answered: boolean; json: boolean; configFile: string; homes: string[] };

const label = (home: string): string => profileLabel(profileOf(home));
const plistOf = (r: Run, home: string): string | undefined => readOrUndefined(path.join(r.launchAgentsDir, `${label(home)}.plist`));

// setup takes an agent whose own folder is here as installed, even when its CLI is not on PATH
const folderOf = (r: Run, k: AgentKind): string => (k === 'claude' ? path.dirname(r.settingsPath) : k === 'codex' ? r.codex.dir : r.opencode.dir);
const hasFolder = (r: Run, k: AgentKind): boolean => fs.existsSync(folderOf(r, k));

// the choices are saved only once setup is about to write, so a run that stops has changed nothing
function parseChoices(o: Flags, r: Run): Choices | undefined {
  let choices: Choices | undefined;
  if (o.agents !== undefined) {
    if (o.plan || o.check || o.ifNeeded) throw new Error('--agents is for a setup that writes everything');
    const kinds = (list: string): AgentKind[] => list.split(',').map((name) => {
      if (!AGENT_KINDS.includes(name as AgentKind)) throw new Error(`unknown agent ${name}`);
      return name as AgentKind;
    });
    const chosen = kinds(o.agents);
    const runnable = findAgents(process.env.PATH ?? '');
    const found = o.found !== undefined ? kinds(o.found) : AGENT_KINDS.filter((k) => runnable.includes(k) || hasFolder(r, k));
    const config = loadConfig(r.configFile);
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
  return choices;
}

async function planAction(r: Run, integrations: AgentKind[] | undefined): Promise<void> {
  const found = await Promise.all(findAgents(process.env.PATH ?? '').map(async (kind) => {
    const bin = path.join(onPath(AGENTS[kind].bin, process.env.PATH ?? '')!, AGENTS[kind].bin);
    const version = await execFileP(bin, ['--version'], { timeout: 5_000 }).then((res) => res.stdout.trim().split('\n')[0], () => undefined);
    return { kind, path: bin, version };
  }));
  // the stand-in folders say nothing of whether the user's own PATH holds the shim
  const plan = setupPlan({
    home: r.home, projects: suggestProjects(os.homedir(), loadConfig(r.configFile).defaultCwd), found, folders: AGENT_KINDS.filter((k) => hasFolder(r, k)).map((kind) => ({ kind, path: folderOf(r, kind) })), integrations, settingsPath: r.settingsPath, codexHooks: r.codex.hooks, opencodePlugin: r.opencode.plugin, launchAgentsDir: r.launchAgentsDir,
    // the plists a setup from this screen writes for the other fleets, taking over any another copy runs
    fleets: r.homes.filter((h) => profileOf(h) !== PRIVATE && !plistCurrent({ home: h, label: label(h), launchAgentsDir: r.launchAgentsDir, runtime: r.runtime })),
    shimDir: r.shimDir, pathEnv: r.answered ? process.env.PATH ?? '' : '', answered: r.answered, cli: cliCommand(r.runtime),
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

async function checkAction(r: Run, state: SetupState): Promise<void> {
  const checks = await preflight(realPreflightDeps(r.home));
  const notes: Check[] = [];
  // desktop:install runs setup when it sees one of these lines, as nothing else rewrites the Claude hooks, the shims or the plist;
  // it puts this checkout's app in place, so shims or a plist that run another checkout, moved or not, are out of date
  if (state.hooksStale) notes.push({ name: 'hooks', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
  if (state.shimsStale) notes.push({ name: 'shims', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
  if (state.plistStale) notes.push({ name: 'launchd plist', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
  // a failed check is listed too, as --json has no other way to say why it exits 1
  const warnings = [...checks.filter((c) => c.status === 'warn' || c.status === 'fail').map(checkLine), ...notes.map(checkLine)];
  printResult({ done: [], warnings }, r.json, () => renderGroups(grouped([...checks, ...notes]), useColor()));
  if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
}

type Daemons = { ours: string[]; running: Map<string, number>; stale: string[] };

// a fleet another copy on disk runs keeps its daemon, whatever version it is; only a fleet whose window is open runs,
// and the rest start on the new build with their window
async function daemons(r: Run, system: boolean): Promise<Daemons> {
  const ours = r.homes.filter((h) => !takenOverBy(plistOf(r, h), r.runtime));
  const running = new Map<string, number>();
  if (system) for (const h of ours) { const pid = await runningPid(label(h)); if (pid !== undefined) running.set(label(h), pid); }
  return { ours, running, stale: staleFleets(r.homes, runtimeVersion(), (l) => running.get(l)) };
}

// --if-needed with nothing to set up, or nothing it may set up, still restarts old daemons
async function refreshAction(r: Run, stale: string[], system: boolean, unwritable: string | undefined): Promise<void> {
  const done = system ? await kickstart(stale) : [];
  const warnings = [
    ...r.answered ? [] : ['the login shell did not answer, so the hooks, shims and plists were left as they are'],
    ...unwritable ? [unwritable] : [],
  ];
  printResult({ done, warnings }, r.json, () => [...done, ...warnings].join('\n'));
}

async function runAction(r: Run, o: Daemons & { choices?: Choices; options: SetupOptions; system: boolean; ifNeeded?: boolean }): Promise<void> {
  const warnings = requireReady(await preflight({ ...realPreflightDeps(r.home), ...o.choices?.mainAgent ? { mainAgent: o.choices.mainAgent } : {} }));
  if (o.choices) {
    fs.mkdirSync(r.home, { recursive: true });
    if (o.choices.defaultCwd) fs.mkdirSync(expandHome(o.choices.defaultCwd), { recursive: true });
    saveConfig(r.configFile, o.choices);
  }
  const lines = await runSetup({ ...o.options, launchctl: o.system, replaceSettings: !o.ifNeeded });
  const fleets = await refreshFleetPlists({ homes: r.homes, runtime: r.runtime, launchAgentsDir: r.launchAgentsDir, launchctl: o.system, takeOver: !o.ifNeeded });
  lines.push(...fleets.done);
  // a running fleet took the private fleet's main agent at its start, so a switch reaches it only through a restart
  const inheriting = o.choices?.mainAgent ? inheritingFleets(o.ours, (l) => o.running.has(l)) : [];
  const restart = [...new Set([...o.stale, ...inheriting])].filter((l) => l !== LAUNCHD_LABEL && !fleets.restarted.includes(l));
  if (o.system) lines.push(...await kickstart(restart));
  // Codex's trust ask is the user's next step, so it goes with the warnings the setup screen shows
  const done = lines.filter((l) => l !== CODEX_TRUST);
  if (done.length < lines.length) warnings.push(CODEX_TRUST);
  printResult({ done, warnings }, r.json, () => [...done, ...warnings].join('\n'));
}

export function setupCommand(target: () => Target, json: () => boolean): Command {
  return new Command('setup')
    .description('install hooks, the launchd agent and the svall shim')
    .option('--no-launchctl', 'write files only; leave launchd alone')
    .option('--check', 'only check what setup needs; change nothing')
    .option('--plan', 'print what setup would do, as the app shows it; change nothing')
    .option('--agents <list>', 'the agents to install hooks for, comma-separated; saved for later runs')
    .option('--found <list>', 'the agents the setup screen showed; those left out of --agents stay off (default: the agents found now)')
    .option('--projects <dir>', 'where new characters start, made if missing; saved as defaultCwd')
    .option('--if-needed', 'set up only what is missing or out of date, and restart daemons of another version')
    .option('--login-shell', 'take PATH and where the agents keep their files from the login shell, as an app opened from Finder has none')
    .action(async (o: Flags) => {
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
      const { claudeSettings, launchAgents, shimDir } = userPaths();
      const r: Run = {
        home: t.home, runtime, answered, json: json(), configFile: resolvePaths(t.home).config, settingsPath: claudeSettings, codex: codexPaths(), opencode: opencodePaths(),
        launchAgentsDir: launchAgents, shimDir, homes: fleetHomes(os.homedir()),
      };
      const choices = parseChoices(o, r);
      const integrations = choices?.integrations ?? loadConfig(r.configFile).integrations;
      if (o.plan) return planAction(r, integrations);
      if (o.ifNeeded) {
        const owner = takenOverBy(plistOf(r, r.home), runtime);
        if (owner) {
          const warnings = [`${owner} runs these fleets; open that copy of Svall, or run ${cliCommand(runtime)} setup to move them here`];
          printResult({ done: [], warnings }, r.json, () => warnings.join('\n'));
          return;
        }
      }
      const options: SetupOptions = { ...r, agents: findAgents(process.env.PATH ?? ''), integrations };
      // setupState throws on a file setup could not write back, so --check covers it too
      if (o.check) return checkAction(r, setupState(options));
      // a refresh goes on past a file it could not write back, to restart old daemons
      let state: SetupState | undefined;
      let unwritable: string | undefined;
      try {
        state = setupState(options);
      } catch (e) {
        if (!o.ifNeeded) throw e;
        unwritable = (e as Error).message;
      }
      const system = o.launchctl && process.platform === 'darwin';
      const d = await daemons(r, system);
      if (o.ifNeeded) {
        const fleetsStale = d.ours.some((h) => profileOf(h) !== PRIVATE && !plistCurrent({ home: h, label: label(h), launchAgentsDir: launchAgents, runtime }));
        // stand-in folders must not replace what a setup with the real login environment wrote
        if (!answered || !state || (!state.hooksStale && !state.shimsStale && !state.plistStale && !fleetsStale)) return refreshAction(r, d.stale, system, unwritable);
      }
      return runAction(r, { ...d, choices, options, system, ifNeeded: o.ifNeeded });
    });
}
