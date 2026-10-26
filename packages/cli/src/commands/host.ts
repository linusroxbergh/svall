import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import { PROTOCOL_VERSION, type MachineId } from '@svall/protocol';
import { writeDurable } from '@svall/svalld/handover/durable';
import { configDir, machineId } from '@svall/svalld/machine';
import { askpassPath, isRelease, releaseRoot, releaseSigned, releaseVersion } from '@svall/svalld/release';
import { allowedSigners } from '../../../../scripts/install-release.mjs';
import { sshVerify } from '../../../../scripts/release-manifest.mjs';
import { Client } from '../client.js';
import { printResult, table } from '../format.js';
import { addHost, doctorHost, fleetsNaming, removeHost, rollbackHost, upgradeHost, type HostDeps, type HostOutcome, type HostReport, type StepEvent } from '../controller/host.js';
import { MachineRegistry } from '../controller/registry.js';
import { closeMastersOnSignal, SshMaster } from '../controller/ssh.js';
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
    const child = spawn('ssh', ['--', destination, 'true'], { stdio: ['inherit', 'inherit', 'pipe'], env });
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
    // a machine just linked has up to waitMs to come up and answer
    setupRows: (machine) => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.setup', { machine, waitMs: 30_000 })).then((r) => r.rows),
  };
}

/** A step as a run prints it; a detail of several lines, as the replicas step's, lists them under the step. */
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

// the one line a machine's setup ends in: ready, or how many things are left before robots can move there
const readyLine = (name: string): string => `${name} is ready. Robots you move there keep working while this Mac sleeps.`;
const needsLine = (name: string, n: number): string => `${name} needs ${plural(n, 'thing')} before robots can move there`;

/** The last line a run prints: what it did, or what is still to do; an add or an upgrade ends in the setup's one line. */
export function outcomeText(o: HostOutcome, op: Op, name: string, flags: { forget?: boolean } = {}): string {
  const setup = op === 'add' || op === 'upgrade';
  if (o.result === 'ready') return setup ? readyLine(name) : doneLine(op, name, flags);
  const left = setup ? `${needsLine(name, o.actions.length)}:` : 'still to do:';
  return [o.stopped ? `stopped at ${o.stopped}; ${left}` : left, ...o.actions.map((a) => `  ${a}`)].join('\n');
}

/** The last line of a check: ready, or the things left before robots can move there, each failed check and each warning's action once, as a run counts them. */
export function doctorVerdict(checks: Check[], name: string): string {
  const todo = checks.filter((c) => c.status === 'fail' || (c.status === 'warn' && c.action));
  const thing = (c: Check): string => c.action ?? c.name;
  const left = todo.filter((c, i) => todo.findIndex((o) => thing(o) === thing(c)) === i);
  return left.length ? `${needsLine(name, left.length)}: ${left.map((c) => c.name).join(', ')}` : readyLine(name);
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

// a check that could not reach the machine is one that failed
function recordCheck(dir: string, id: MachineId, report: HostReport | undefined): void {
  const count = (status: string) => report?.checks.filter((c) => c.status === status).length ?? 0;
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

/** One machine as `host list --json` gives it: no ssh for this one, the fleets here it is the gateway of, and its last check. */
export type MachineRow = { name: string; id: string; ssh?: string; platform: string; gateway: boolean; fleets: string[]; check?: LastCheck };

export function machineRows(registry: MachineRegistry, checks: Record<string, LastCheck>, fleetsOf: (id: MachineId) => string[]): MachineRow[] {
  return registry.list().map(({ id, record }) => ({
    name: record.name, id, ...(record.ssh && { ssh: record.ssh }), platform: `${record.platform}-${record.arch}`, gateway: record.gateway,
    fleets: fleetsOf(id), ...(checks[id] && { check: checks[id] }),
  }));
}

const checkedLine = (c: LastCheck): string =>
  `${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}: ${c.failed ? `${plural(c.failed, 'check')} failed` : c.warned ? plural(c.warned, 'warning') : 'ready'}`;

/** Either one NDJSON object per step and a final result, or the same events as doctor-style lines. */
function reporter(json: boolean, last: (o: HostOutcome) => string): { emit: (e: StepEvent) => void; finish: (o: HostOutcome) => void } {
  const write = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (json) return { emit: write, finish: write };
  return {
    emit: (e) => { if (e.status !== 'start') process.stdout.write(`${stepLine(e)}\n`); },
    finish: (o) => { process.stdout.write(`${last(o)}\n`); },
  };
}

async function runFlow(json: boolean, last: (o: HostOutcome) => string, run: (d: HostDeps) => Promise<HostOutcome>, dir: string, fleet: Target): Promise<void> {
  const out = reporter(json, last);
  const outcome = await run(realDeps(out.emit, dir, fleet));
  out.finish(outcome);
  if (outcome.result !== 'ready') process.exitCode = 1;
}

/** `target`: the fleet a machine added or upgraded becomes a worker of. */
export function hostCommands(json: () => boolean, target: () => Target, dir: () => string = configDir): Command {
  const host = new Command('host').description('the machines this controller can hand a fleet to')
    // the app's Stop is a SIGTERM, which would otherwise leave this command's master running
    .hook('preAction', () => { closeMastersOnSignal(); });

  host.command('add')
    .description('provision a remote Svall host and add it to the registry')
    .argument('<name>', 'what to call the machine here')
    .requiredOption('--ssh <destination>', 'the ssh destination to reach it at')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .action((name: string, o: { ssh: string; release?: string; allowUnsigned?: boolean }) =>
      runFlow(json(), (out) => outcomeText(out, 'add', name), (d) => addHost({ name, ...o }, d), dir(), target()));

  host.command('list')
    .description('every machine in the registry, the fleets here it is the gateway of, and its last check')
    .action(() => {
      const rows = machineRows(MachineRegistry.load(dir()), lastChecks(dir()), (id) => fleetsNaming(id, os.homedir()));
      printResult(rows, json(), () => table(rows.map((r) => ({
        name: r.name, ssh: r.ssh ?? '(this machine)', platform: r.platform,
        gateway: r.fleets.length ? `for ${r.fleets.join(', ')}` : r.gateway ? 'yes' : 'no',
        release: r.check?.release ?? '', checked: r.check ? checkedLine(r.check) : '', id: r.id,
      }))));
    });

  host.command('doctor')
    .description('what the machine answers about itself, and what only this controller can check')
    .argument('<name>', 'the machine in the registry')
    .action(async (name: string) => {
      const entry = MachineRegistry.load(dir()).get(name);
      const report = await doctorHost(name, realDeps(() => { /* a diagnosis prints a table, not steps */ }, dir(), target())).catch((e: unknown) => {
        if (entry) recordCheck(dir(), entry.id, undefined);
        throw e;
      });
      if (entry) recordCheck(dir(), entry.id, report);
      printResult(report, json(), () => [`machine ${report.machine}`, ...checkLines(report.checks), doctorVerdict(report.checks, name)].join('\n'));
      if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });

  host.command('upgrade')
    .description('install a new companion release, and go back to the old one if it does not answer')
    .argument('<name>', 'the machine in the registry')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .option('--rollback [release]', 'put the machine back on this release, or on the one before, and check its daemons answer from it')
    .action((name: string, o: { release?: string; allowUnsigned?: boolean; rollback?: boolean | string }) => {
      if (o.rollback === undefined) return runFlow(json(), (out) => outcomeText(out, 'upgrade', name), (d) => upgradeHost(name, o, d), dir(), target());
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
