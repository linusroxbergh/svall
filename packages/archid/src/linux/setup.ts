import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@archipelago/protocol';
import { codexPaths, type CodexPaths } from '../codex/install.js';
import { claudePaths } from '../paths.js';
import { systemdDir } from '../release.js';
import { writeAtomic } from '../jsonfile.js';
import { daemonProgram, readCodexHooks, readJsonSettings, requireWritableHooks, setupFleetHome, setupUser, type RunFrom } from '../setup.js';
import { SystemdError, daemonReload, enableUnit, lingerState, restartUnit, type Run } from './service.js';

export const GATEWAY_UNIT = 'archipelago-gateway.service';

export const archidUnitName = (fleet: string): string => `archipelago-archid@${fleet}.service`;

/** Where systemd reads a user's own units. */
export const unitDirOf = (homedir: string): string => path.join(homedir, '.config', 'systemd', 'user');

const isOurUnit = (f: string): boolean => f === GATEWAY_UNIT || /^archipelago-archid@[a-z][a-z0-9-]*\.service$/.test(f);

/** The units setup and provision wrote to `unitDir`: one daemon per fleet, then the gateway. */
export const ourUnits = (unitDir: string): string[] =>
  (fs.existsSync(unitDir) ? fs.readdirSync(unitDir).filter(isOurUnit).sort() : []);

// systemd resolves % specifiers in these values, and a value holding a space needs its quotes
const esc = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/%/g, '%%');

// it takes the command name literally but reads a $ in an argument, where "$$" is the one that survives
const execLine = (argv: string[]): string =>
  argv.map((a, i) => `"${esc(i === 0 ? a : a.replace(/\$/g, '$$$$'))}"`).join(' ');

function render(name: string, values: Record<string, string>): string {
  const text = fs.readFileSync(path.join(systemdDir(), name), 'utf8');
  return text.replace(/@([A-Z_]+)@/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${name} has no value for @${key}@`);
    return value;
  });
}

/** `env`: the agent homes the daemon is given, as `agentHomesEnv` reads them. */
export type UnitOptions = RunFrom & { homedir: string; prefix: string; env?: Record<string, string> };

/** The unit line that sets `key` for the daemon. */
export const unitEnv = (key: string, value: string): string => `Environment="${key}=${esc(value)}"`;

const MARK = 'archi-agent-homes';

/**
 * Where this account keeps Claude's and Codex's files, when it says: this process's CLAUDE_CONFIG_DIR and CODEX_HOME,
 * else its login shell's, since a setup over ssh runs in a shell that read no profile. systemd gives a unit neither.
 */
export async function agentHomesEnv(run: Run): Promise<Record<string, string>> {
  let said: string[] = [];
  try {
    const out = (await run(process.env.SHELL || '/bin/sh', ['-lic', `printf '\\n%s\\n%s\\n%s\\n' ${MARK} "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"`])).stdout.split('\n');
    const at = out.lastIndexOf(MARK);
    if (at >= 0) said = out.slice(at + 1, at + 3);
  } catch { /* a shell that cannot be asked sets neither */ }
  const claude = process.env.CLAUDE_CONFIG_DIR || said[0];
  const codex = process.env.CODEX_HOME || said[1];
  return {
    ...(claude && { CLAUDE_CONFIG_DIR: claudePaths({ CLAUDE_CONFIG_DIR: claude }).dir }),
    ...(codex && { CODEX_HOME: codexPaths({ CODEX_HOME: codex }).dir }),
  };
}

// the release's own runtime first, so the daemon starts the node it was built against
export const unitPath = (o: UnitOptions): string => [
  'release' in o ? path.join(o.release, 'node', 'bin') : path.dirname(process.execPath),
  path.join(o.homedir, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin',
].join(':');

const logFile = (o: UnitOptions, unit: string): string =>
  path.join(o.prefix, 'log', `${unit.replace(/\.service$/, '')}.log`);

const archiProgram = (o: RunFrom, ...args: string[]): string[] => ('release' in o
  ? [path.join(o.release, 'bin', 'archi')]
  : [path.join(o.repoRoot, 'node_modules/.bin/tsx'), path.join(o.repoRoot, 'packages/cli/src/main.ts')]).concat(args);

export type Unit = { name: string; text: string };

export function archidUnit(o: UnitOptions & { fleet: string; home: string }): Unit {
  const name = archidUnitName(o.fleet);
  return {
    name,
    text: render('archipelago-archid@.service.in', {
      FLEET: o.fleet,
      EXEC_START: execLine(daemonProgram(o)),
      ARCHI_HOME: esc(o.home),
      HOME: esc(o.homedir),
      PATH: esc(unitPath(o)),
      ENV: Object.entries(o.env ?? {}).map(([k, v]) => `\n${unitEnv(k, v)}`).join(''),
      LOG: logFile(o, name).replace(/%/g, '%%'),
    }),
  };
}

export function gatewayUnit(o: UnitOptions): Unit {
  return {
    name: GATEWAY_UNIT,
    text: render('archipelago-gateway.service.in', {
      EXEC_START: execLine(archiProgram(o, 'gateway', 'serve')),
      HOME: esc(o.homedir),
      PATH: esc(unitPath(o)),
      LOG: logFile(o, GATEWAY_UNIT).replace(/%/g, '%%'),
    }),
  };
}

export type LinuxSetup = UnitOptions & {
  home: string; fleet: string; unitDir: string; settingsPath: string; codex: CodexPaths; shimDir: string;
  user: string; run: Run; systemctl: boolean; replaceSettings?: boolean; port?: number; tmuxVersion?: string; agents?: AgentKind[];
};

const readOrUndefined = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
};

/** The units for this machine, written only when they are not already what they should be. */
export function writeUnits(o: LinuxSetup): string[] {
  fs.mkdirSync(o.unitDir, { recursive: true });
  const logs = path.join(o.prefix, 'log');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.chmodSync(logs, 0o700);
  const done: string[] = [];
  for (const unit of [archidUnit(o), gatewayUnit(o)]) {
    const file = path.join(o.unitDir, unit.name);
    if (readOrUndefined(file) === unit.text) continue;
    writeAtomic(file, unit.text, { perProcess: true });
    done.push(`systemd unit -> ${file}`);
  }
  return done;
}

type UnitStart = { started: true; done: string[] } | { started: false; reason: string };

async function startUnit(o: LinuxSetup): Promise<UnitStart> {
  const units = [archidUnitName(o.fleet), GATEWAY_UNIT];
  let unit = units[0];
  try {
    await daemonReload(o.run);
    for (unit of units) await enableUnit(o.run, unit);
  } catch (e) {
    if (!(e instanceof SystemdError)) throw e;
    return { started: false, reason: `${unit} was not started: ${e.message}` };
  }
  const done = units.map((u) => `systemctl --user enable --now ${u}`);
  try {
    const linger = await lingerState(o.run, o.user);
    if (!linger.linger) done.push(`the fleet stops when you log out until you run: ${linger.action}`);
  } catch (e) {
    done.push(`lingering could not be read: ${(e as Error).message}`);
  }
  return { started: true, done };
}

export type LinuxSetupResult = { done: string[]; started: boolean };

/** `archi setup` on Linux: the fleet home, the per-user files and this machine's systemd units. */
export async function setupLinux(o: LinuxSetup): Promise<LinuxSetupResult> {
  // both files are read and checked before anything is written, so one that is not JSON, or cannot take
  // the change, stops a setup that has changed nothing
  const claudeWanted = !o.agents || o.agents.includes('claude') || fs.existsSync(path.dirname(o.settingsPath));
  const codexWanted = !!o.agents?.includes('codex') || fs.existsSync(o.codex.dir);
  const settings = claudeWanted ? readJsonSettings(o.settingsPath) : undefined;
  const codexHooks = readCodexHooks(o.codex, codexWanted);
  requireWritableHooks(o.home, settings, codexHooks);
  const env = o.env ?? await agentHomesEnv(o.run);
  const done = setupFleetHome(o);
  done.push(...setupUser({ ...o, settings, codexHooks }));
  done.push(...writeUnits({ ...o, env }));
  if (!o.systemctl) return { done, started: false };
  const start = await startUnit(o);
  if (!start.started) return { done: [...done, start.reason], started: false };
  return { done: [...done, ...start.done], started: true };
}

/**
 * Setup, and for a release that replaced another the probe that can put it back. Only a daemon
 * this run really started says anything about the release: a machine with no systemd would
 * otherwise roll back a release that installed perfectly well.
 */
export async function setupLinuxRelease(o: LinuxSetup & {
  rollbackTo?: string;
  probe: (fleet: string) => Promise<boolean>;
  rollback: (prefix: string) => Rollback;
}): Promise<string[]> {
  const { done, started } = await setupLinux(o);
  if (!started || !o.rollbackTo) return done;
  // `enable --now` leaves a running unit alone, so the old release would keep answering the probe
  done.push(...await restartUnits(o.run, o.unitDir));
  return [...done, ...await probeOrRollback({ prefix: o.prefix, unitDir: o.unitDir, run: o.run, probe: o.probe, rollback: o.rollback })];
}

/**
 * Every fleet's daemon and the machine's gateway, started again from the release `current` now names. A unit that does
 * not start is said, not thrown.
 */
export async function restartUnits(run: Run, unitDir: string): Promise<string[]> {
  const done: string[] = [];
  for (const unit of ourUnits(unitDir)) {
    try {
      await restartUnit(run, unit);
      done.push(`systemctl --user restart ${unit}`);
    } catch (e) {
      done.push(`${unit} did not restart: ${(e as Error).message}`);
    }
  }
  return done;
}

export type Rollback = { prefix: string; current: string; release: string; version: string };

const fleetOf = (unit: string): string | undefined => /^archipelago-archid@(.+)\.service$/.exec(unit)?.[1];

/**
 * A release any fleet's daemon does not answer from goes back where it came from, so an upgrade cannot leave
 * the machine without a daemon. Every fleet with a unit here is asked, as each was restarted onto it.
 */
export async function probeOrRollback(o: {
  prefix: string; unitDir: string; run: Run;
  probe: (fleet: string) => Promise<boolean>;
  rollback: (prefix: string) => Rollback;
}): Promise<string[]> {
  let silent: string | undefined;
  for (const fleet of ourUnits(o.unitDir).map(fleetOf).filter((f) => f !== undefined)) {
    if (!await o.probe(fleet)) { silent = fleet; break; }
  }
  if (silent === undefined) return [];
  const daemon = `the ${silent} fleet's daemon`;
  let back: Rollback;
  try {
    back = o.rollback(o.prefix);
  } catch (e) {
    return [`${daemon} did not answer and there is no release to go back to: ${(e as Error).message}`];
  }
  return [`${daemon} did not answer: current -> ${back.release}`, ...await restartUnits(o.run, o.unitDir)];
}
