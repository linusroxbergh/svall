import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import type { AgentKind } from '@svall/protocol';
import { CODEX_TRUST, claudeHooksCurrent, codexHooksCurrent, readCodexHooks, requireWritableHooks } from '@svall/svalld/agent-hooks';
import { AGENTS, AGENT_KINDS, findAgents, mainAgent, onPath } from '@svall/svalld/agents';
import { codexPaths } from '@svall/svalld/codex/install';
import { opencodePaths } from '@svall/svalld/opencode/install';
import { peekConfig, saveConfig } from '@svall/svalld/config';
import { kickstart, plistCurrent, runningPid, takenOverBy } from '@svall/svalld/launchd';
import { realRun } from '@svall/svalld/linux/service';
import { agentHomesEnv, ourUnits, restartUnits, setupLinuxRelease, unitDirOf } from '@svall/svalld/linux/setup';
import { claudePaths, expandHome, resolvePaths, userPaths, type Paths } from '@svall/svalld/paths';
import { LOGIN_SHELL_TIMEOUT_MS, takeLoginEnv } from '@svall/svalld/login-env';
import { LAUNCHD_LABEL, PRIVATE, SHIM, profileHome, profileLabel, profileOf } from '@svall/svalld/profile';
import { ownRuntime, releaseRuntime, runtimeVersion, type Runtime } from '@svall/svalld/runtime';
import { readJsonSettings, readOrUndefined } from '@svall/svalld/settings-file';
import { cliCommand, refreshFleetPlists, runSetup, setupState, shimsCurrent, type SetupOptions, type SetupState } from '@svall/svalld/setup';
import { inheritingFleets, integrationsFor, projectsFolder, requireInstalledApp, setupPlan, staleFleets, suggestProjects } from '@svall/svalld/setup-plan';
import { fleetHomes } from '@svall/svalld/uninstall';
import { DEFAULT_PREFIX, allowedSigners, installRelease, rollbackRelease } from '../../../../scripts/install-release.mjs';
import { sshVerify } from '../../../../scripts/release-manifest.mjs';
import { grouped, renderGroups, useColor, type Check } from '../checks-view.js';
import { Client } from '../client.js';
import { printResult } from '../format.js';
import { checkLine, preflight, realPreflightDeps, requireReady } from './preflight.js';
import type { Target } from '../target.js';

const execFileP = promisify(execFile);

type Flags = { launchctl: boolean; check?: boolean; plan?: boolean; agents?: string; found?: string; projects?: string; ifNeeded?: boolean; loginShell?: boolean };
type Choices = Parameters<typeof saveConfig>[1];

// what every part of a setup run reads
type Run = Omit<SetupOptions, 'agents' | 'integrations'> & { answered: boolean; json: boolean; paths: Paths; homes: string[] };

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
    const config = peekConfig(r.paths);
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
    home: r.home, projects: suggestProjects(os.homedir(), peekConfig(r.paths).defaultCwd), found, folders: AGENT_KINDS.filter((k) => hasFolder(r, k)).map((kind) => ({ kind, path: folderOf(r, kind) })), integrations, settingsPath: r.settingsPath, codexHooks: r.codex.hooks, opencodePlugin: r.opencode.plugin, launchAgentsDir: r.launchAgentsDir,
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
    saveConfig(r.paths, o.choices);
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

type LinuxFlags = { launchctl: boolean; check?: boolean; release?: string; allowUnsigned?: boolean; replaceSettings?: boolean; rollback?: boolean | string };

type From = { runtime: Runtime; rollbackTo?: string; version?: string };

// a release install replaces the checkout entirely: the units and the shims reach it through `current`
function runFrom(o: LinuxFlags, done: string[]): From {
  if (!o.release) return { runtime: ownRuntime() };
  const installed = installRelease({
    source: o.release,
    allowUnsigned: o.allowUnsigned,
    verify: sshVerify({ allowedSigners: allowedSigners() }),
  });
  done.push(`release ${installed.version} -> ${installed.release}`, `current -> ${installed.current}`);
  return { runtime: releaseRuntime(installed.current), rollbackTo: installed.rollbackTo ?? undefined, version: installed.version };
}

/** Whether a fleet's daemon answers from `release`. */
export type Probe = (fleet: string, release: string) => Promise<boolean>;

// the release gone back to may speak an older protocol than this svall, and its system.info still names it
const realProbe: Probe = (fleet, release) => daemonRuns(release, () => Client.connect(profileHome(fleet), { anyProtocol: true }));

/**
 * Recovery, so it asks nothing of the machine but the release it is going back to: the one named, or the one before.
 * Each fleet's daemon it restarts has to answer from that release, as after an upgrade.
 */
async function rollback(o: { restart: boolean; probe: Probe }, to?: string): Promise<string[]> {
  const releases = path.join(DEFAULT_PREFIX, 'releases');
  if (to !== undefined && path.dirname(path.resolve(releases, to)) !== releases) throw new Error(`${to} names no release under ${releases}`);
  const back = rollbackRelease(DEFAULT_PREFIX, to === undefined ? undefined : path.join(releases, to));
  const done = [`current -> ${back.release}`];
  if (!o.restart) return [...done, 'nothing was restarted: each daemon runs the release current names from its next start'];
  const unitDir = unitDirOf(os.homedir());
  done.push(...await restartUnits(realRun, unitDir));
  const fleets = ourUnits(unitDir).flatMap((u) => /^svall-svalld@(.+)\.service$/.exec(u)?.[1] ?? []);
  const silent: string[] = [];
  for (const fleet of fleets) if (!await o.probe(fleet, back.version)) silent.push(fleet);
  if (silent.length) throw new Error(`${done.join('\n')}\nthe ${silent.join(' and ')} fleet's daemon did not answer from release ${back.version}; read its log`);
  return [...done, ...fleets.map((f) => `the ${f} fleet's daemon answers from release ${back.version}`)];
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

async function linuxSetup(t: Target, o: LinuxFlags, json: boolean): Promise<void> {
  const pre = realPreflightDeps(t.home, 'linux');
  const checks = await preflight(pre);
  // the agent homes the daemon is given, where its agents read their hooks: the login shell's, which an ssh command's env may not name
  const env = await agentHomesEnv(realRun);
  const settingsPath = path.join(claudePaths(env).dir, 'settings.json');
  // the agent CLIs the daemon's unit finds, which an ssh login's PATH may not reach
  const agents = findAgents(pre.agentPath ?? pre.pathEnv);
  const codex = codexPaths(env);
  const claudeWanted = agents.includes('claude') || fs.existsSync(path.dirname(settingsPath));
  const codexWanted = agents.includes('codex') || fs.existsSync(codex.dir);
  // these throw on a file setup could not write back, so --check covers it too
  const settings = claudeWanted ? readJsonSettings(settingsPath) : undefined;
  const codexHooks = readCodexHooks(codex, codexWanted);
  requireWritableHooks(t.home, settings, codexHooks);
  if (o.check) {
    const notes: Check[] = [];
    // what a run of setup with the same flags would rewrite, as nothing else rewrites the Claude hooks or the shims
    const script = resolvePaths(t.home).hookScript;
    if ((settings && !claudeHooksCurrent(settings.settings, t.home)) || (codexHooks && !codexHooksCurrent(codexHooks.settings, script))) {
      notes.push({ name: 'hooks', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
    }
    // shims that run another checkout or release, moved or not, are out of date
    const runtime = o.release ? releaseRuntime(path.join(DEFAULT_PREFIX, 'current')) : ownRuntime();
    if (!shimsCurrent(userPaths().shimDir, runtime)) notes.push({ name: 'shims', status: 'warn', detail: `missing or out of date: run ${SHIM} setup` });
    // a failed check is listed too, as --json has no other way to say why it exits 1
    const warnings = [...checks.filter((c) => c.status === 'warn' || c.status === 'fail').map(checkLine), ...notes.map(checkLine)];
    printResult({ done: [], warnings }, json, () => renderGroups(grouped([...checks, ...notes]), useColor()));
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    return;
  }
  const warnings = requireReady(checks);
  const done: string[] = [];
  const from = runFrom(o, done);
  done.push(...await setupLinuxRelease({
    runtime: from.runtime,
    home: t.home,
    settingsPath,
    codex,
    shimDir: userPaths().shimDir,
    replaceSettings: o.replaceSettings === true,
    agents,
    env,
    fleet: t.name,
    homedir: os.homedir(),
    prefix: DEFAULT_PREFIX,
    unitDir: unitDirOf(os.homedir()),
    user: os.userInfo().username,
    run: realRun,
    systemctl: o.launchctl,
    probe: (fleet) => daemonRuns(from.version ?? '', () => Client.connect(profileHome(fleet))),
    rollback: (p) => rollbackRelease(p, from.rollbackTo),
  }));
  printResult({ done, warnings }, json, () => [...done, ...warnings].join('\n'));
}

// a companion runs from an installed release under systemd, with none of the app's setup screen
function linuxSetupCommand(target: () => Target, json: () => boolean, probe: Probe): Command {
  return new Command('setup')
    .description('install hooks, systemd user units and the svall shim')
    .option('--no-launchctl', 'write files only, do not (re)start the systemd unit')
    .option('--check', 'only check what setup needs; change nothing')
    .option('--release <path>', 'install this release tree or archive and run the daemon from it')
    .option('--allow-unsigned', 'install a --release that carries no signature')
    .option('--replace-settings', 'replace the mission-control .claude/settings.json you have edited, keeping a copy')
    .option('--rollback [release]', 'put current back on this release, or on the one before, and restart the daemon')
    .action(async (o: LinuxFlags) => {
      // setup owns the per-user half — the Claude hooks and the shims — so it only ever means private
      const t = target();
      if (t.name !== PRIVATE) throw new Error(`${SHIM} setup configures the private fleet; run ${SHIM} ${t.name} to open that one`);
      if (o.rollback) {
        if (o.check || o.release) throw new Error('--rollback takes neither --check nor --release');
        const done = await rollback({ restart: o.launchctl, probe }, typeof o.rollback === 'string' ? o.rollback : undefined);
        printResult({ done, warnings: [] }, json(), () => done.join('\n'));
        return;
      }
      return linuxSetup(t, o, json());
    });
}

export function setupCommand(target: () => Target, json: () => boolean, platform: NodeJS.Platform = process.platform, probe: Probe = realProbe): Command {
  if (platform === 'linux') return linuxSetupCommand(target, json, probe);
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
        home: t.home, runtime, answered, json: json(), paths: resolvePaths(t.home), settingsPath: claudeSettings, codex: codexPaths(), opencode: opencodePaths(),
        launchAgentsDir: launchAgents, shimDir, homes: fleetHomes(os.homedir()),
      };
      const choices = parseChoices(o, r);
      const integrations = choices?.integrations ?? peekConfig(r.paths).integrations;
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
