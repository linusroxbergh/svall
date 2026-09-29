import { spawn } from 'node:child_process';
import os from 'node:os';
import { Command } from 'commander';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { configDir, machineId } from '@svall/svalld/machine';
import { askpassPath, releaseRoot, releaseVersion } from '@svall/svalld/release';
import { allowedSigners } from '../../../../scripts/install-release.mjs';
import { sshVerify } from '../../../../scripts/release-manifest.mjs';
import { printResult, table } from '../format.js';
import { addHost, doctorHost, enableHost, removeHost, rollbackHost, upgradeHost, type HostDeps, type HostOutcome, type StepEvent } from '../controller/host.js';
import { MachineRegistry } from '../controller/registry.js';
import { closeMastersOnSignal, SshMaster } from '../controller/ssh.js';
import { targetFor } from '../target.js';
import { MARK } from '../checks-view.js';
import { checkLines } from './doctor.js';

/**
 * Where the first ssh asks its questions: the terminal, or a dialog when there is none, as when the
 * app runs `svall host add`.
 */
export function interactiveEnv(o: { tty: boolean; platform: NodeJS.Platform; askpass: string; env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return !o.tty && o.platform === 'darwin' ? { ...o.env, SSH_ASKPASS: o.askpass, SSH_ASKPASS_REQUIRE: 'force' } : o.env;
}

/** The one ssh the user answers: a new host key, a passphrase, a password. Nothing is captured. */
function interactiveSsh(destination: string): Promise<number> {
  const env = interactiveEnv({ tty: process.stdin.isTTY === true, platform: process.platform, askpass: askpassPath(), env: process.env });
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['--', destination, 'true'], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function realDeps(emit: (e: StepEvent) => void, dir: string): HostDeps {
  return {
    emit,
    registry: MachineRegistry.load(dir),
    openMaster: (destination) => SshMaster.open({ destination }),
    interactiveSsh,
    fetch: (url) => fetch(url),
    controller: { release: releaseVersion(), protocol: PROTOCOL_VERSION, releaseRoot: releaseRoot() },
    machineId: () => machineId(dir),
    homedir: os.homedir(),
    verify: sshVerify({ allowedSigners: allowedSigners() }),
  };
}

const line = (e: StepEvent): string =>
  `${MARK[e.status as keyof typeof MARK] ?? ' '} ${e.step}  ${[e.detail, e.action].filter(Boolean).join(' -> ')}`.trimEnd();

/** Either one NDJSON object per step and a final result, or the same events as doctor-style lines. */
function reporter(json: boolean): { emit: (e: StepEvent) => void; finish: (o: HostOutcome) => void } {
  const write = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (json) return { emit: write, finish: write };
  return {
    emit: (e) => { if (e.status !== 'start') process.stdout.write(`${line(e)}\n`); },
    finish: (o) => {
      process.stdout.write(o.result === 'ready'
        ? 'ready for handover\n'
        : `${['still to do:', ...o.actions.map((a) => `  ${a}`)].join('\n')}\n`);
    },
  };
}

async function runFlow(json: boolean, run: (d: HostDeps) => Promise<HostOutcome>, dir: string): Promise<void> {
  const out = reporter(json);
  const outcome = await run(realDeps(out.emit, dir));
  out.finish(outcome);
  if (outcome.result !== 'ready') process.exitCode = 1;
}

export function hostCommands(json: () => boolean, dir: () => string = configDir): Command {
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
      runFlow(json(), (d) => addHost({ name, ...o }, d), dir()));

  host.command('list')
    .description('every machine in the registry')
    .action(() => {
      const rows = MachineRegistry.load(dir()).list().map(({ id, record }) => ({
        name: record.name, ssh: record.ssh ?? '(this machine)',
        platform: `${record.platform}-${record.arch}`, gateway: record.gateway ? 'yes' : 'no', id,
      }));
      printResult(rows, json(), () => table(rows));
    });

  host.command('doctor')
    .description('what the machine answers about itself, and what only this controller can check')
    .argument('<name>', 'the machine in the registry')
    .action(async (name: string) => {
      const report = await doctorHost(name, realDeps(() => { /* a diagnosis prints a table, not steps */ }, dir()));
      printResult(report, json(), () => [`machine ${report.machine}`, ...checkLines(report.checks)].join('\n'));
      if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });

  host.command('upgrade')
    .description('install a new companion release, and go back to the old one if it does not answer')
    .argument('<name>', 'the machine in the registry')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .option('--rollback [release]', 'put the machine back on this release, or on the one before, and check its daemons answer from it')
    .action((name: string, o: { release?: string; allowUnsigned?: boolean; rollback?: boolean | string }) => {
      if (o.rollback === undefined) return runFlow(json(), (d) => upgradeHost(name, o, d), dir());
      if (o.release !== undefined || o.allowUnsigned) throw new Error('--rollback installs nothing, so it takes no --release or --allow-unsigned');
      const to = typeof o.rollback === 'string' ? o.rollback : undefined;
      return runFlow(json(), (d) => rollbackHost(name, { ...(to !== undefined && { to }) }, d), dir());
    });

  host.command('remove')
    .description('uninstall Svall on the machine and drop its route')
    .argument('<name>', 'the machine in the registry')
    .option('--forget', 'drop the route for a machine that cannot be reached, leaving it untouched')
    .action((name: string, o: { forget?: boolean }) =>
      runFlow(json(), (d) => removeHost(name, o, d), dir()));

  host.command('enable')
    .description('name this machine the gateway for a fleet')
    .argument('<name>', 'the machine in the registry')
    .requiredOption('--fleet <profile>', 'the fleet whose gateway it is to be')
    .action((name: string, o: { fleet: string }) =>
      runFlow(json(), (d) => enableHost(name, { fleetHome: targetFor(o.fleet).home }, d), dir()));

  return host;
}
