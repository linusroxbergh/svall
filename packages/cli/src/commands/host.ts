import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import { z } from 'zod';
import { ApiError, aside, asideLine, checksAgain, notNeeded, PROTOCOL_VERSION, toTick, wayOn, type MachineId, type SetupRow } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/durable';
import { configDir, machineId } from '@svall/svalld/machine';
import { askpassPath, isRelease, releaseRoot, releaseSigned, releaseVersion } from '@svall/svalld/release';
import { allowedSigners } from '../../../../scripts/install-release.mjs';
import { sshVerify } from '../../../../scripts/release-manifest.mjs';
import { Client } from '../client.js';
import { printResult, table } from '../format.js';
import { addHost, consentHost, doctorHost, removeHost, rollbackHost, rowStep, upgradeHost, type HostDeps, type HostOutcome, type HostReport, type StepEvent } from '../controller/host.js';
import { MachineRegistry } from '../controller/registry.js';
import { closeMastersOnSignal, SshMaster } from '../controller/ssh.js';
import { ask } from '../prompt.js';
import { farProfile, type Target } from '../target.js';
import { MARK, tickMark, type Check } from '../checks-view.js';
import { checkLines } from './doctor.js';
import { withClient } from './fleet.js';

/**
 * Where the first ssh asks its questions: the terminal, or a dialog when there is none, as when the
 * app runs `svall host add`.
 */
export function interactiveEnv(o: { tty: boolean; platform: NodeJS.Platform; askpass: string; env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return !o.tty && o.platform === 'darwin' ? { ...o.env, SSH_ASKPASS: o.askpass, SSH_ASKPASS_REQUIRE: 'force' } : o.env;
}

/**
 * The one ssh the user answers: a new host key, a passphrase, a password. Its prompts go to the terminal or the dialog;
 * what it writes to stderr is passed on, and its last lines handed back for the step to name.
 */
export function interactiveSsh(destination: string): Promise<{ code: number; stderr: string }> {
  const env = interactiveEnv({ tty: process.stdin.isTTY === true, platform: process.platform, askpass: askpassPath(), env: process.env });
  return new Promise((resolve, reject) => {
    // a RemoteCommand in the user's config would refuse `true`. Not detached, so the app's Stop, sent to svall's process group, ends it
    const child = spawn('ssh', ['-o', 'RemoteCommand=none', '--', destination, 'true'], { stdio: ['inherit', 'inherit', 'pipe'], env });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); said = (said + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: said.trim().split('\n').slice(-3).join('\n').slice(-400) }));
  });
}

/** The signers a companion is checked against: the ones this release carries, or the checkout's. */
export const controllerSigners = (): string => (isRelease() ? path.join(releaseRoot(), 'release', 'allowed_signers') : allowedSigners());

function realDeps(emit: (e: StepEvent) => void, dir: string, fleet: Target): HostDeps {
  return {
    emit,
    registry: MachineRegistry.load(dir),
    openMaster: (destination) => SshMaster.open({ destination }),
    interactiveSsh,
    fetch: (url) => fetch(url),
    controller: { release: releaseVersion(), protocol: PROTOCOL_VERSION, releaseRoot: releaseRoot(), signed: releaseSigned() },
    localAgents: () => withClient(() => Client.connect(), async (c) => (await c.call('system.info', {})).agentAdapters),
    machineId: () => machineId(dir),
    homedir: os.homedir(),
    verify: sshVerify({ allowedSigners: controllerSigners() }),
    fleet: { home: fleet.home, ...(farProfile(fleet) && { profile: farProfile(fleet) }) },
    // a daemon that is not running links the machine when it starts
    refreshLinks: () => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.refresh', {})).then(() => undefined, () => undefined),
    setupRows: (machine, waitMs) => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.setup', { machine, waitMs })).then((r) => r.rows),
    consent: (machine, item, fields, on) => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.consent', { machine, item, fields, on })).then((r) => r.rows),
  };
}

/** A step as a run prints it; a detail of several lines, as a command there can print, lists them under the step. */
export const stepLine = (e: StepEvent): string =>
  `${MARK[e.status as keyof typeof MARK] ?? ' '} ${e.step}  ${tickMark(e.tick)}${[e.detail, e.action].filter(Boolean).join(' -> ')}`.trimEnd().replaceAll('\n', '\n    ');

type Op = 'add' | 'upgrade' | 'rollback' | 'remove';
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What a run that went through did, in the words the Machines panel uses. */
export function doneLine(op: Op, name: string, o: { forget?: boolean } = {}): string {
  switch (op) {
    case 'add': return `${name} is added`;
    case 'upgrade': return `${name} is upgraded`;
    case 'rollback': return `${name} is rolled back`;
    case 'remove': return `${name} is ${o.forget ? 'forgotten' : 'removed'}`;
  }
}

// a machine's setup ends in one line: ready, or the things to fix there, then what of your agent setup will not work there yet
const readyLine = (name: string): string => `${name} is ready. Robots you move there keep working while this Mac sleeps.`;
const fixLine = (name: string, n: number): string => `${name} has ${plural(n, 'thing')} to fix`;
const parts = (n: number, whose = 'your'): string => `${plural(n, 'part')} of ${whose} agent setup`;
// the list of `rows` under its line: after ready, or after the things to fix there; yet while one has a way on; the rows that stand
// aside end it in one line, which stands alone when no other is listed
const withList = (rows: Gapped[], name: string, there: There, ready: boolean): string[] => {
  const live = rows.filter((r) => !aside(r));
  const list = setupList(live, name, there);
  const apart = asideLine(rows.filter(aside), true);
  const yet = live.some(wayOn) ? ' yet' : '';
  if (!list.length) return apart ? [ready ? `${name} is ready. ${apart}.` : `${apart}.`] : [];
  return [ready ? `${name} is ready. ${parts(list.length)} will not work there${yet}:` : `${parts(list.length)} will not work on ${name}${yet}:`, ...list, ...(apart ? [`  ${apart}`] : [])];
};

/** How a line of the list reaches the machine from this Mac's terminal: its ssh destination, and the svall that names this fleet. */
export type There = { ssh: string; svall: string };

/** A mirror row by its key, as svalld words it, or as a step or a check carries it. */
type Gapped = Pick<SetupRow, 'key' | 'gap' | 'tick' | 'run' | 'forward' | 'action'>;
const MIRROR = 'mirror:';
const asRow = <T extends { step: string } | { name: string }>(e: T): T & { key: string } => ({ ...e, key: ('step' in e ? e.step : e.name).slice(MIRROR.length) });

/** The one thing to do about a row from this Mac's terminal: tick it from here, or run its command there; Claude Code signs in with /mcp. */
function gapAction(r: Gapped, machine: string, there: There): string | undefined {
  if (toTick(r) && !notNeeded(r)) return `${there.svall} host consent ${machine} ${r.tick!.item} on`;
  if (r.run) return `ssh ${r.forward ? `-L ${r.forward}:localhost:${r.forward} ` : ''}${there.ssh}, then ${r.run}${r.key.startsWith('oauth:claude:') ? ', /mcp' : ''}`;
  if (checksAgain(r)) return `${there.svall} host doctor ${machine}`;
  return r.action;
}

/** What will not work on `machine` yet, a line each: its name, what it lacks, and the one thing to do from here. */
export function setupList(rows: Gapped[], machine: string, there: There): string[] {
  const listed = rows.flatMap((r) => (r.gap ? [{ ...r.gap, action: gapAction(r, machine, there) }] : []));
  const [name, what] = [Math.max(0, ...listed.map((l) => l.name.length)), Math.max(0, ...listed.map((l) => l.what.length))];
  return listed.map((l) => `  ${l.name.padEnd(name)}  ${l.action ? `${l.what.padEnd(what)}  → ${l.action}` : l.what}`);
}

/** The last line a run prints: what it did, or what is still to do; an add or an upgrade ends in the setup's lines. */
export function outcomeText(o: HostOutcome, op: Op, name: string, flags: { forget?: boolean; there?: There } = {}): string {
  const setup = op === 'add' || op === 'upgrade';
  const rows = setup ? (o.setup ?? []).map(asRow) : [];
  const list = (ready: boolean) => (rows.length ? withList(rows, name, flags.there!, ready) : []);
  if (o.result === 'ready') return !setup ? doneLine(op, name, flags) : rows.length ? list(true).join('\n') : readyLine(name);
  const left = setup ? `${fixLine(name, o.actions.length)}:` : 'still to do:';
  return [o.stopped ? `stopped at ${o.stopped}; ${left}` : left, ...o.actions.map((a) => `  ${a}`), ...list(false)].join('\n');
}

/** The end of a check: ready, or the things to fix there, each failed check and each warning's action once, then what of the agent setup will not work there. */
export function doctorVerdict(checks: Check[], name: string, there: There): string {
  const todo = checks.filter((c) => !c.name.startsWith(MIRROR) && (c.status === 'fail' || (c.status === 'warn' && c.action)));
  // two checks can name the same thing to do
  const thing = (c: Check): string => c.action ?? c.name;
  const left = todo.filter((c, i) => todo.findIndex((o) => thing(o) === thing(c)) === i);
  const rows = checks.filter((c) => c.name.startsWith(MIRROR) && c.gap).map(asRow);
  if (!left.length) return rows.length ? withList(rows, name, there, true).join('\n') : readyLine(name);
  return [`${fixLine(name, left.length)}: ${left.map((c) => c.name).join(', ')}`, ...withList(rows, name, there, false)].join('\n');
}

/** What of a robot's agent setup will not work on `machine` yet, as a move prints its rows that name a gap; the rows that stand aside in one line. */
export function robotSetupText(rows: SetupRow[], robot: string, machine: string, there: There): string {
  const live = rows.filter((r) => !aside(r));
  const apart = asideLine(rows.filter(aside), true);
  if (!live.length) return `${apart}.`;
  return [`${parts(live.length, `${robot}'s`)} will not work on ${machine}${live.some(wayOn) ? ' yet' : ''}:`, ...setupList(live, machine, there), ...(apart ? [`  ${apart}`] : [])].join('\n');
}

type SetUpIo = { ask(q: string): Promise<string>; write(text: string): void; consent: HostDeps['consent'] };

/** Asks to set up what of the machine's agent setup can be from here: each key to copy there, one at a time, then the commands to run there. */
export async function setUpNow(steps: StepEvent[], o: { name: string; machine: MachineId; there: There }, io: SetUpIo): Promise<void> {
  if (!steps.some((s) => (toTick(s) && !notNeeded(s)) || s.run !== undefined) || !/^(y|yes)?$/i.test((await io.ask('Set them up now? [Y/n] ')).trim())) return;
  const rows = steps.map(asRow);
  for (const r of rows.filter((x) => toTick(x) && !notNeeded(x))) {
    const { item, fields, preview } = r.tick!;
    if (!/^y(es)?$/i.test((await io.ask(`${r.action![0].toUpperCase()}${r.action!.slice(1)}? ${preview.join(', ')} [y/N] `)).trim())) continue;
    try {
      const now = (await io.consent(o.machine, item, fields, true)).find((x) => x.key === r.key);
      io.write(`  ${now?.status === 'ok' ? MARK.ok : MARK.warn} ${r.gap!.name}: ${now?.detail ?? 'ticked'}\n`);
    } catch (e) {
      io.write(`  ${MARK.warn} ${r.gap!.name}: ${(e as Error).message}\n`);
    }
  }
  const runs = [...new Set(rows.filter((x) => x.run).map((x) => gapAction(x, o.name, o.there)!))];
  if (runs.length) io.write([`Run these on ${o.name}:`, ...runs.map((a) => `  ${a}`), ''].join('\n'));
  io.write(`${o.there.svall} host doctor ${o.name} checks again once they are done.\n`);
}

const LastCheck = z.object({ at: z.number(), failed: z.number(), warned: z.number(), release: z.string().optional() });
/** What the last `host doctor` here found: when, how many checks failed and warned, and the release the machine said it runs. */
export type LastCheck = z.infer<typeof LastCheck>;

// beside the registry, by machine id, so a renamed machine keeps its check
const checksFile = (dir: string): string => path.join(dir, 'checks.json');

/** Every machine's last check; a file that cannot be read holds none. */
export function lastChecks(dir: string): Record<string, LastCheck> {
  try { return z.record(z.string(), LastCheck).parse(JSON.parse(fs.readFileSync(checksFile(dir), 'utf8'))); } catch { return {}; }
}

// a check that could not reach the machine is one that failed; the agent setup's rows are no warnings
function recordCheck(dir: string, id: MachineId, report: HostReport | undefined): void {
  const count = (status: string) => report?.checks.filter((c) => c.status === status && !c.name.startsWith(MIRROR)).length ?? 0;
  const check: LastCheck = { at: Date.now(), failed: report ? count('fail') : 1, warned: count('warn'), ...(report?.release && { release: report.release }) };
  writeDurable(checksFile(dir), { ...lastChecks(dir), [id]: check });
}

/** Drops a machine's last check, as it leaves the registry; the file goes with the last one. */
export function forgetCheck(dir: string, id: string): void {
  const { [id]: gone, ...rest } = lastChecks(dir);
  if (!gone) return;
  if (Object.keys(rest).length) writeDurable(checksFile(dir), rest);
  else fs.rmSync(checksFile(dir), { force: true });
}

/** One machine as `host list --json` gives it: no ssh for this one, and its last check. */
export type MachineRow = { name: string; id: string; ssh?: string; platform: string; check?: LastCheck };

export function machineRows(registry: MachineRegistry, checks: Record<string, LastCheck>): MachineRow[] {
  return registry.list().map(({ id, record }) => ({
    name: record.name, id, ...(record.ssh && { ssh: record.ssh }), platform: `${record.platform}-${record.arch}`, ...(checks[id] && { check: checks[id] }),
  }));
}

const checkedLine = (c: LastCheck): string =>
  `${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}: ${c.failed ? `${plural(c.failed, 'check')} failed` : c.warned ? plural(c.warned, 'warning') : 'ready'}`;

/** Either one NDJSON object per step and a final result, or the same events as doctor-style lines, the agent setup rows left to the list at the end. */
export function reporter(json: boolean, last: (o: HostOutcome) => string): { emit: (e: StepEvent) => void; finish: (o: HostOutcome) => void } {
  const write = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (json) return { emit: write, finish: write };
  return {
    emit: (e) => { if (e.status !== 'start' && !e.step.startsWith(MIRROR)) process.stdout.write(`${stepLine(e)}\n`); },
    finish: (o) => { process.stdout.write(`${last(o)}\n`); },
  };
}

// a terminal of the user's own can be asked whether to set up the machine's agent setup now
const askable = (json: boolean): boolean => !json && process.stdin.isTTY === true && process.stdout.isTTY === true;

/** How the machine `name` in the registry at `dir` is reached from this Mac's terminal, and the svall that names `fleet` there. */
export const thereOf = (name: string, dir: string, fleet: Target): There =>
  ({ ssh: MachineRegistry.load(dir).get(name)?.record.ssh ?? name, svall: farProfile(fleet) ? `svall -p ${farProfile(fleet)}` : 'svall' });

/** Runs a host flow; one that leaves the machine `after` in the registry with agent setup left asks to set it up now. */
async function runFlow(
  json: boolean, last: (o: HostOutcome) => string, run: (d: HostDeps) => Promise<HostOutcome>, dir: string, fleet: Target, after?: { name: string; there: There },
): Promise<void> {
  const out = reporter(json, last);
  const d = realDeps(out.emit, dir, fleet);
  const outcome = await run(d);
  out.finish(outcome);
  if (outcome.result !== 'ready') process.exitCode = 1;
  const machine = after && d.registry.get(after.name)?.id;
  if (outcome.setup && machine && askable(json)) {
    await setUpNow(outcome.setup, { name: after.name, machine, there: after.there }, { ask, write: (t) => process.stdout.write(t), consent: d.consent });
  }
}

/** `target`: the fleet a machine added or upgraded becomes a worker of. */
export function hostCommands(json: () => boolean, target: () => Target, dir: () => string = configDir): Command {
  const host = new Command('host').description('the machines robots can run on')
    // the app's Stop is a SIGTERM, which would otherwise leave this command's master running
    .hook('preAction', () => { closeMastersOnSignal(); });

  host.command('add')
    .description('provision a remote Svall host and add it to the registry')
    .argument('<name>', 'what to call the machine here')
    .requiredOption('--ssh <destination>', 'the ssh destination to reach it at')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .action((name: string, o: { ssh: string; release?: string; allowUnsigned?: boolean }) => {
      const there = { ...thereOf(name, dir(), target()), ssh: o.ssh };
      return runFlow(json(), (out) => outcomeText(out, 'add', name, { there }), (d) => addHost({ name, ...o }, d), dir(), target(), { name, there });
    });

  host.command('list')
    .description('every machine in the registry and its last check')
    .action(() => {
      const rows = machineRows(MachineRegistry.load(dir()), lastChecks(dir()));
      printResult(rows, json(), () => table(rows.map((r) => ({
        name: r.name, ssh: r.ssh ?? '(this machine)', platform: r.platform,
        release: r.check?.release ?? '', checked: r.check ? checkedLine(r.check) : '', id: r.id,
      }))));
    });

  host.command('doctor')
    .description('what the machine answers about itself, and what only this controller can check')
    .argument('<name>', 'the machine in the registry')
    .addOption(new Option('--steps', 'with --json, print each step as an NDJSON line as it goes, before the report').hideHelp())
    .action(async (name: string, o: { steps?: boolean }) => {
      const entry = MachineRegistry.load(dir()).get(name);
      // a diagnosis prints a table, not steps, unless the app follows it
      const emit = o.steps && json() ? reporter(true, String).emit : () => {};
      const report = await doctorHost(name, realDeps(emit, dir(), target())).catch((e: unknown) => {
        if (entry) recordCheck(dir(), entry.id, undefined);
        throw e;
      });
      if (entry) recordCheck(dir(), entry.id, report);
      const there = thereOf(name, dir(), target());
      printResult(report, json(), () => [`machine ${report.machine}`, ...checkLines(report.checks.filter((c) => !c.name.startsWith(MIRROR))), doctorVerdict(report.checks, name, there)].join('\n'));
      if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });

  host.command('consent')
    .description("tick or untick one setting of the machine's mirror, as host doctor lists it")
    .argument('<name>', 'the machine in the registry')
    .argument('<item>', 'the setting, such as claude:mcp:linear')
    .argument('<state>', 'on to copy its keys there, off to stop')
    .option('--field <field...>', 'with on, only these fields of it; off unticks every field')
    .action(async (name: string, item: string, state: string, o: { field?: string[] }) => {
      if (state !== 'on' && state !== 'off') throw new Error(`${state} is not on or off`);
      let rows;
      try {
        rows = await consentHost(name, { item, on: state === 'on', ...(o.field && { fields: o.field }) }, realDeps(() => { /* rows print below */ }, dir(), target()));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'not_mirrored')) throw e;
        process.stdout.write(`${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      printResult(rows, json(), () => rows.map((r) => stepLine(rowStep(r))).join('\n'));
    });

  host.command('upgrade')
    .description('install a new companion release, and go back to the old one if it does not answer')
    .argument('<name>', 'the machine in the registry')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .option('--rollback [release]', 'put the machine back on this release, or on the one before, and check its daemons answer from it')
    .action((name: string, o: { release?: string; allowUnsigned?: boolean; rollback?: boolean | string }) => {
      if (o.rollback === undefined) {
        const there = thereOf(name, dir(), target());
        return runFlow(json(), (out) => outcomeText(out, 'upgrade', name, { there }), (d) => upgradeHost(name, o, d), dir(), target(), { name, there });
      }
      if (o.release !== undefined || o.allowUnsigned) throw new Error('--rollback installs nothing, so it takes no --release or --allow-unsigned');
      const to = typeof o.rollback === 'string' ? o.rollback : undefined;
      return runFlow(json(), (out) => outcomeText(out, 'rollback', name), (d) => rollbackHost(name, { ...(to !== undefined && { to }) }, d), dir(), target());
    });

  host.command('remove')
    .description('uninstall Svall on the machine and drop its route')
    .argument('<name>', 'the machine in the registry')
    .option('--forget', 'drop the route for a machine that cannot be reached, leaving it untouched')
    .action(async (name: string, o: { forget?: boolean }) => {
      const id = MachineRegistry.load(dir()).get(name)?.id;
      await runFlow(json(), (out) => outcomeText(out, 'remove', name, o), (d) => removeHost(name, o, d), dir(), target());
      if (id && !MachineRegistry.load(dir()).get(id)) forgetCheck(dir(), id);
    });

  return host;
}
