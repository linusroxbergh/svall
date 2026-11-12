import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import { ApiError, aside, asideLine, checksAgain, ellipsis, keyLabel, keyMask, notNeeded, PROTOCOL_VERSION, tierOf, toTick, wayOn, type FleetAgents, type MachineId, type SetupRow } from '@svall/protocol';
import { configDir, machineId } from '@svall/svalld/machine';
import { realDeps as realMobileDeps, resolveTailscale, tailnetSelf } from '@svall/svalld/mobile';
import { resolvePaths } from '@svall/svalld/paths';
import { owedWhy, owedWorkers } from '@svall/svalld/fleet/home-move';
import { tokenFor } from '@svall/svalld/placement/workers';
import { askpassPath, isRelease, releaseRoot, releaseSigned, releaseVersion } from '@svall/svalld/release';
import { allowedSigners } from '../../../../scripts/install-release.mjs';
import { sshVerify } from '../../../../scripts/release-manifest.mjs';
import { Client, withClient } from '../client.js';
import { printResult, table } from '../format.js';
import { addHost, consentHost, dialingFleet, doctorHost, fleetOf, removeHost, rollbackHost, rowStep, sameRelease, upgradeHost, type HostDeps, type HostOutcome, type HostReport, type StepEvent } from '../controller/host.js';
import { carriedCompanion } from '../controller/install.js';
import { byHome, carriedDir, farDocument, relay, relayFor, type FarHome } from '../controller/on-home.js';
import { forgetCheck, lastChecks, recordCheck, type LastCheck } from '../controller/checks.js';
import { MachineRegistry } from '../controller/registry.js';
import { closeMastersOnSignal, SshMaster } from '../controller/ssh.js';
import { ask } from '../prompt.js';
import { farProfile, type Target } from '../target.js';
import { MARK, rawLines, tickMark, type Check } from '../checks-view.js';
import { connectArgs, connectChoice, hostLimits } from './limits.js';
import { checkLines } from './doctor.js';

/**
 * Where the first ssh asks its questions: the terminal, or a dialog when there is none, as when the
 * app runs `svall host add`.
 */
export function interactiveEnv(o: { tty: boolean; platform: NodeJS.Platform; askpass: string; env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  return !o.tty && o.platform === 'darwin' ? { ...o.env, SSH_ASKPASS: o.askpass, SSH_ASKPASS_REQUIRE: 'force' } : o.env;
}

// whether this run is a relay's, for a person at another machine
let relayedRun = false;

/** A relayed run has no one at this machine's screen, and a server's run with no terminal no one at all: neither asks. */
export const asksNoOne = (o: { relayed: boolean; platform: NodeJS.Platform; tty: boolean }): boolean => o.relayed || (o.platform === 'linux' && !o.tty);

/**
 * The one ssh the user answers: a new host key, a passphrase, a password. Its prompts go to the terminal or the dialog;
 * what it writes to stderr is passed on, and its last lines handed back for the step to name.
 */
export function interactiveSsh(destination: string): Promise<{ code: number; stderr: string; batch?: true }> {
  const env = interactiveEnv({ tty: process.stdin.isTTY === true, platform: process.platform, askpass: askpassPath(), env: process.env });
  const batch = asksNoOne({ relayed: relayedRun, platform: process.platform, tty: process.stdin.isTTY === true });
  return new Promise((resolve, reject) => {
    // a RemoteCommand in the user's config would refuse `true`. Not detached, so the app's Stop, sent to svall's process group, ends it
    const child = spawn('ssh', [...(batch ? ['-o', 'BatchMode=yes'] : []), '-o', 'RemoteCommand=none', '--', destination, 'true'], { stdio: [batch ? 'ignore' : 'inherit', 'inherit', 'pipe'], env });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); said = (said + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: said.trim().split('\n').slice(-3).join('\n').slice(-400), ...(batch && { batch: true as const }) }));
  });
}

/** The signers a companion is checked against: the ones this release carries, or the checkout's. */
export const controllerSigners = (): string => (isRelease() ? path.join(releaseRoot(), 'release', 'allowed_signers') : allowedSigners());

/** The re-enrol this fleet's daemon owes `machine`, as its machines.list row says. */
export function joiningOf(rows: { id: string; joining?: string; joinTried?: number }[], machine: string): { why: string; tried?: number } | undefined {
  const row = rows.find((r) => r.id === machine);
  return row?.joining === undefined ? undefined : { why: row.joining, ...(row.joinTried !== undefined && { tried: row.joinTried }) };
}

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
    tailnet: async () => { const m = realMobileDeps(); await tailnetSelf(m, await resolveTailscale(m)); },
    homedir: os.homedir(),
    verify: sshVerify({ allowedSigners: controllerSigners() }),
    fleet: { home: fleet.home, ...(farProfile(fleet) && { profile: farProfile(fleet) }) },
    // a daemon that is not running links the machine when it starts
    refreshLinks: () => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.refresh', {})).then(() => undefined, () => undefined),
    setupRows: (machine, waitMs) => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.setup', { machine, waitMs })).then((r) => r.rows),
    consent: (machine, item, fields, on) => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.consent', { machine, item, fields, on })).then((r) => r.rows),
    joining: (machine) => withClient(() => Client.connect(fleet.home), (c) => c.call('machines.list', {})).then((r) => joiningOf(r.machines, machine), () => undefined),
  };
}

/** A step as a run prints it; a detail of several lines, as a command there can print, lists them under the step, and what a tool said of one that failed or warned, dim under that. */
export const stepLine = (e: StepEvent): string =>
  `${MARK[e.status as keyof typeof MARK] ?? ' '} ${e.step}  ${tickMark(e.tick)}${[e.detail, e.action].filter(Boolean).join(' -> ')}`.trimEnd().replaceAll('\n', '\n    ')
  + rawLines(e);

type Op = 'add' | 'upgrade' | 'rollback' | 'remove';
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
// a run's name, as the window's verdict on one that stopped says it
const TITLE: Record<Op, string> = { add: 'Add machine', upgrade: 'Upgrade', rollback: 'Roll back', remove: 'Remove' };

/** What a run that went through did, in the words the Machines panel uses. */
export function doneLine(op: Op, name: string, o: { forget?: boolean } = {}): string {
  switch (op) {
    case 'add': return `${name} is added`;
    case 'upgrade': return `${name} is upgraded`;
    case 'rollback': return `${name} is rolled back`;
    case 'remove': return `${name} is ${o.forget ? 'forgotten' : 'removed'}`;
  }
}

// a machine's setup ends in its verdict, then a line for what of your agent setup is not there yet, which `host doctor --all` lists
const verdict = (name: string, todo: number): string => (todo ? `${name} has ${plural(todo, 'thing')} to fix` : `${name} is ready`);
const parts = (n: number, whose = 'your'): string => `${plural(n, 'part')} of ${whose} agent setup`;
const notOn = (n: number, name: string): string => `${parts(n)} ${n === 1 ? 'is' : 'are'} not on ${name} yet`;
const setupLine = (rows: Gapped[], name: string, there: There): string[] => {
  const live = rows.filter((r) => r.gap && !aside(r)).length;
  return live ? [`${notOn(live, name)}: ${there.svall} host doctor ${name} --all lists them`] : [];
};
// the list of `rows` under its line; the rows that stand aside end it in one line, which stands alone when no other is listed
const withList = (rows: Gapped[], name: string, there: There): string[] => {
  const live = rows.filter((r) => !aside(r));
  const list = setupList(live, name, there);
  const apart = asideLine(rows.filter(aside), true);
  if (!list.length) return apart ? [`${apart}.`] : [];
  return [`${notOn(list.length, name)}:`, ...list, ...(apart ? [`  ${apart}`] : [])];
};

/**
 * The rows a run or a check ends on in a terminal: those that need a person in full, then the notes and the rows that are
 * fine counted on a line each; the agent setup's rows are left to the line after the verdict. `flow`: a step flow's rows.
 */
export function tiered(checks: Check[], fleet: FleetAgents | undefined, flow = false): { lines: string[]; todo: number } {
  const rows = checks.filter((c) => !c.name.startsWith(MIRROR));
  // a step flow's rollback says what the machine runs now, so it is said in full whatever it found
  const kept = (c: Check) => flow && c.name === 'rollback';
  const tier = (c: Check) => tierOf({ step: c.name, status: c.status }, fleet, flow);
  const todo = rows.filter((c) => tier(c) === 'todo');
  const full = rows.filter((c) => tier(c) === 'todo' || kept(c));
  const [notes, fine] = (['note', 'fine'] as const).map((t) => rows.filter((c) => tier(c) === t && !kept(c)).length);
  return {
    todo: todo.length,
    lines: [...(full.length ? checkLines(full) : []), ...(notes ? [`${MARK.warn} ${plural(notes, 'note')}`] : []), ...(fine ? [`${MARK.ok} ${plural(fine, 'check')} fine`] : [])],
  };
}

/** A run's steps as checks, each by the last thing it said; one still under way when the run ended said nothing. */
export const ended = (steps: StepEvent[]): Check[] => {
  const last = new Map<string, StepEvent>();
  for (const e of steps) last.set(e.step, e);
  return [...last.values()].flatMap(({ step, status, say: _, here: __, ...e }) => (status === 'start' ? [] : [{ ...e, name: step, status, detail: e.detail ?? '' }]));
};

/** How a line of the list reaches the machine from this Mac's terminal: its ssh destination, the home it goes by way of where only that reaches it, and the svall that names this fleet. */
export type There = { ssh: string; by?: string; svall: string };

// a login's port comes back over every hop
const hops = (there: There, forward?: number): string => [there.by, there.ssh].flatMap((h) => (h ? [`ssh ${forward ? `-L ${forward}:localhost:${forward} ` : ''}${h}`] : [])).join(', then ');

/** A mirror row by its key, as svalld words it, or as a step or a check carries it. */
type Gapped = Pick<SetupRow, 'key' | 'gap' | 'tick' | 'run' | 'forward' | 'action'>;
const MIRROR = 'mirror:';
const PHONE_ROW = `${MIRROR}phone`;
const asRow = <T extends { step: string } | { name: string }>(e: T): T & { key: string } => ({ ...e, key: ('step' in e ? e.step : e.name).slice(MIRROR.length) });

/** The one thing to do about a row from this Mac's terminal: tick it from here, or run its command there; Claude Code signs in with /mcp. */
function gapAction(r: Gapped, machine: string, there: There): string | undefined {
  if (toTick(r) && !notNeeded(r)) return `${there.svall} host consent ${machine} ${r.tick!.item} on`;
  if (r.run) return `${hops(there, r.forward)}, then ${r.run}${r.key.startsWith('oauth:claude:') ? ', /mcp' : ''}`;
  if (checksAgain(r)) return `${there.svall} host doctor ${machine}`;
  return r.action;
}

// a row's `what` is cut past this, so one long row does not pad every other
const WHAT_MAX = 80;

/** What will not work on `machine` yet, a line each: its name, what it lacks, and the one thing to do from here. */
export function setupList(rows: Gapped[], machine: string, there: There): string[] {
  const listed = rows.flatMap((r) => (r.gap ? [{ ...r.gap, what: ellipsis(r.gap.what, WHAT_MAX), action: gapAction(r, machine, there) }] : []));
  const [name, what] = [Math.max(0, ...listed.map((l) => l.name.length)), Math.max(0, ...listed.map((l) => l.what.length))];
  return listed.map((l) => `  ${l.name.padEnd(name)}  ${l.action ? `${l.what.padEnd(what)}  → ${l.action}` : l.what}`);
}

/** How a run ends in a terminal: the rows tiered, then what it did or that it stopped, and for an add or an upgrade the setup's line. */
export function outcomeText(o: HostOutcome, op: Op, name: string, flags: { forget?: boolean; there?: There; steps?: StepEvent[]; fleet?: FleetAgents } = {}): string {
  const setup = op === 'add' || op === 'upgrade';
  // an add's rows are the machine's checks; every other op's are a step flow's
  const { lines, todo } = tiered(ended(flags.steps ?? []), flags.fleet, op !== 'add');
  // a machine an add listed before it stopped has things to fix, as its window says; any other run that stopped did not finish
  const listed = op === 'add' && (flags.steps ?? []).some((s) => s.step === 'registry' && s.status === 'ok');
  // an upgrade that put the release before back did not finish either
  const stopped = o.stopped !== undefined || (op === 'upgrade' && (flags.steps ?? []).some((s) => s.step === 'rollback'));
  const last = stopped ? (listed && todo ? verdict(name, todo) : `${TITLE[op]} did not finish`) : setup ? verdict(name, todo) : doneLine(op, name, flags);
  return [...lines, last, ...(setup ? setupLine((o.setup ?? []).map(asRow), name, flags.there!) : [])].join('\n');
}

/** Whether a run leaves a person something to do: it stopped, or a row needs one. */
export const leftToDo = (o: HostOutcome, op: Op, steps: StepEvent[], fleet: FleetAgents | undefined): boolean => o.stopped !== undefined || tiered(ended(steps), fleet, op !== 'add').todo > 0;

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
  // a row with no gap, as the phone link while it is off, is nothing that will not work there
  const asked = (s: StepEvent | Gapped): boolean => s.gap !== undefined && toTick(s) && !notNeeded(s);
  if (!steps.some((s) => asked(s) || s.run !== undefined) || !/^(y|yes)?$/i.test((await io.ask('Set them up now? [Y/n] ')).trim())) return;
  const rows = steps.map(asRow);
  for (const r of rows.filter(asked)) {
    const { item, fields, preview } = r.tick!;
    if (!/^y(es)?$/i.test((await io.ask(`Copy ${keyLabel(r)} to ${o.name}? ${keyMask(r) ?? preview.join(', ')} [y/N] `)).trim())) continue;
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

/**
 * What `host doctor` prints: the checks tiered, the phone link's row the one setup row among them, the verdict, then what of the
 * agent setup is not there yet; `all`, every check and that list in full.
 */
export function doctorText(report: HostReport, name: string, there: There, o: { fleet?: FleetAgents; all?: boolean } = {}): string {
  const listed = report.checks.flatMap((c) => (!c.name.startsWith(MIRROR) ? [c] : c.name === PHONE_ROW ? [{ ...c, name: 'phone' }] : []));
  const { lines, todo } = tiered(listed, o.fleet);
  const rows = report.checks.filter((c) => c.name.startsWith(MIRROR) && c.gap).map(asRow);
  return [`machine ${report.machine}`, ...(o.all ? checkLines(listed) : lines), verdict(name, todo), ...(o.all ? withList(rows, name, there) : setupLine(rows, name, there))].join('\n');
}

export { forgetCheck, lastChecks, type LastCheck } from '../controller/checks.js';

// a check that could not reach the machine is one that failed; the agent setup's rows are no warnings
function checkOf(report: Pick<HostReport, 'release'> & { checks: { name: string; status: string }[] } | undefined): LastCheck {
  const count = (status: string) => report?.checks.filter((c) => c.status === status && !c.name.startsWith(MIRROR)).length ?? 0;
  return { at: Date.now(), failed: report ? count('fail') : 1, warned: count('warn'), ...(report?.release && { release: report.release }) };
}


/** What an add, upgrade or rollback that left the machine on `release` keeps as its last check: its steps, and that
 *  release against this Mac's, counted as a doctor's are. */
export const runCheck = (steps: Map<string, string>, release: string, controller: Pick<HostDeps['controller'], 'release'>): LastCheck => checkOf({
  checks: [...[...steps].map(([name, status]) => ({ name, status })), { name: 'release', status: sameRelease(release, controller) ? 'ok' : 'fail' }], release,
});

/** One machine as `host list --json` gives it: no ssh for this one, and its last check. */
// worker: holds this fleet's token here, as a Mac asks of its far home; far: a machine of that home, its `ssh` as that home reaches it
// joining: a move left this fleet owing it an enrolment, and why the last try failed; current: its last check found it on this release, with nothing to fix
export type MachineRow = { name: string; id: string; ssh?: string; platform: string; dialedBy?: string; unreadWorker?: string; check?: LastCheck; current?: true; worker?: true; far?: true; joining?: string };

const dialRow = (d: ReturnType<typeof dialingFleet>): Pick<MachineRow, 'dialedBy' | 'unreadWorker'> =>
  (!d ? {} : d.unreadable ? { unreadWorker: resolvePaths(d.home).workerFile } : { dialedBy: d.home });

export function machineRows(registry: MachineRegistry, checks: Record<string, LastCheck>, dialedBy: (id: string) => ReturnType<typeof dialingFleet> = () => undefined, release?: string): MachineRow[] {
  return registry.list().map(({ id, record }) => ({
    name: record.name, id, ...(record.ssh && { ssh: record.ssh }), platform: `${record.platform}-${record.arch}`, ...dialRow(dialedBy(id)), ...(checks[id] && { check: checks[id] }),
    // a machine on this release may still want an upgrade to become this fleet's worker, which its check says
    ...(release && checks[id]?.release === release && !checks[id].failed && !checks[id].warned && { current: true as const }),
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

/** Runs a host flow, which ends 1 while it leaves a person something to do; one that leaves the machine `after` in the registry with agent setup left asks to set it up now. */
async function runFlow(
  json: boolean, op: Op, last: (o: HostOutcome, ends: { steps: StepEvent[]; fleet?: FleetAgents }) => string, run: (d: HostDeps) => Promise<HostOutcome>, dir: string, fleet: Target, after?: { name: string; there: There },
): Promise<void> {
  const events: StepEvent[] = [];
  const ends = { steps: events, fleet: fleetOf(fleet.home) };
  const out = reporter(json, (o) => last(o, ends));
  // each step's last status, which an add, upgrade or rollback that reached the machine leaves as its last check
  const steps = new Map<string, string>();
  let release: string | undefined;
  const d = { ...realDeps((e) => { events.push(e); steps.set(e.step, e.status); out.emit(e); }, dir, fleet), runs: (r: string) => { release = r; } };
  const outcome = await run(d);
  out.finish(outcome);
  if (leftToDo(outcome, op, events, ends.fleet)) process.exitCode = 1;
  const machine = after && d.registry.get(after.name)?.id;
  if (machine && release) recordCheck(dir, machine, runCheck(steps, release, d.controller));
  if (outcome.setup && machine && askable(json)) {
    await setUpNow(outcome.setup, { name: after.name, machine, there: after.there }, { ask, write: (t) => process.stdout.write(t), consent: d.consent });
  }
}

/** Calls `stop` once the Mac this run is for has gone: a relayed run lasts no longer than the connection that follows it. */
export function endsWithConnection(stdin: NodeJS.ReadableStream & { unref?(): void }, stop: () => void): void {
  stdin.once('end', stop);
  stdin.once('close', stop);
  stdin.resume();
  // a run that has finished still exits
  stdin.unref?.();
}

// a named archive is the home's; none, and the home takes its own release, or asks the relay for what this CLI carries
const companionFlags = (o: { release?: string; allowUnsigned?: boolean }): string[] => [...(o.release ? ['--release', o.release] : []), ...(o.allowUnsigned ? ['--allow-unsigned'] : [])];

/** How a line of the list reaches a machine of a far home from this Mac's terminal: by way of that home. */
const farThere = (home: FarHome, ssh: string, fleet: Target): There => ({ ssh, by: home.ssh, svall: farProfile(fleet) ? `svall -p ${farProfile(fleet)}` : 'svall' });

const heldHere = (fleet: Target, id: string): boolean => {
  try { return tokenFor(resolvePaths(fleet.home), id as MachineId) !== undefined; } catch { return false; }
};

const open = (destination: string) => SshMaster.open({ destination });

/** What a far home says it holds of this fleet's workers; none while it does not answer. */
async function farRows(home: FarHome, registry: MachineRegistry): Promise<MachineRow[]> {
  let text = '';
  const code = await relay(home, ['host', 'list'], { open, line: (l) => { text += `${l}\n`; } });
  if (code !== 0) return [];
  try {
    return (farDocument(text) as MachineRow[]).filter((r) => r.worker && r.id !== home.machine && r.id !== registry.localId).map(({ worker: _, ...r }) => ({ ...r, far: true as const }));
  } catch { return []; }
}

/** The destination a far home reaches `name` at, for a line a person runs from this Mac's terminal; its name, where the home does not say. */
const destinationOn = async (home: FarHome, name: string, registry: MachineRegistry): Promise<string> => (await farRows(home, registry)).find((r) => r.name === name || r.id === name)?.ssh ?? name;

// a release of the home's own, as only that is one a home takes
const carried = (platform: string): { archive: string; release: string } | undefined => {
  const archive = carriedCompanion(releaseRoot(), platform);
  return archive === undefined ? undefined : { archive, release: releaseVersion() };
};

// a far run that stopped short says why, whatever its report would have been
const orLeft = <T>(text: (r: T) => string) => (r: unknown, steps: StepEvent[]): string => ((r as HostOutcome).result === 'actions' ? tiered(ended(steps), undefined, true).lines.join('\n') : text(r as T));

const reportBy = (r: HostReport, home: FarHome): HostReport => ({ ...r, checks: r.checks.map((c) => (c.action ? { ...c, action: byHome(home, c.action) } : c)) });

const CARRIED_KEPT_MS = 24 * 60 * 60_000;

/** An archive a relay copied here goes when the run does, however that ends; any other is the person's. */
export const carriedGoes = (release: string | undefined, fleet: Pick<Target, 'home'>, on: Pick<NodeJS.Process, 'once'> = process, now = Date.now()): void => {
  const dir = carriedDir(resolvePaths(fleet.home).home);
  // what a relay stopped or killed between its copy and the run left
  try {
    for (const f of fs.readdirSync(dir)) if (now - fs.statSync(path.join(dir, f)).mtimeMs > CARRIED_KEPT_MS) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* none left */ }
  if (release && path.dirname(path.resolve(release)) === dir) on.once('exit', () => { fs.rmSync(release, { force: true }); });
};

/** Runs a host command for a machine of a far home on that home, its steps handed on as they come: as they are for the app and --json, as a run's lines in a terminal. */
async function onHome(home: FarHome, args: string[], json: boolean, last: (final: unknown, steps: StepEvent[]) => string, o: { steps?: boolean; installs?: boolean } = {}): Promise<void> {
  const { steps = true } = o;
  let rest = '';
  const seen: StepEvent[] = [];
  const code = await relay(home, args, { open, ...(o.installs && { carried }), line: (l) => {
    if (json) { process.stdout.write(`${l}\n`); return; }
    let step: StepEvent | undefined;
    try { const v = JSON.parse(l) as StepEvent; if (typeof v.step === 'string') step = v; } catch { /* a line of the report */ }
    if (step) seen.push(step);
    if (!step) rest += `${l}\n`;
    else if (steps && step.status !== 'start' && !step.step.startsWith(MIRROR)) process.stdout.write(`${stepLine(step)}\n`);
  } });
  if (rest) {
    let said: string;
    try { said = last(farDocument(rest), seen); } catch { said = rest.trimEnd(); }
    process.stdout.write(`${said}\n`);
  }
  if (code !== 0) process.exitCode = code;
}

/** `target`: the fleet a machine added or upgraded becomes a worker of. */
export function hostCommands(json: () => boolean, target: () => Target, dir: () => string = configDir): Command {
  const host = new Command('host').description('the machines robots can run on')
    // the app's Stop is a SIGTERM, which would otherwise leave this command's master running
    .hook('preAction', (_host, action) => {
      closeMastersOnSignal();
      if ((action.opts() as { relayed?: boolean }).relayed) {
        relayedRun = true;
        endsWithConnection(process.stdin, () => process.kill(process.pid, 'SIGTERM'));
      }
    });
  const farFor = (name?: string) => relayFor(target().home, MachineRegistry.load(dir()), name);
  const farLines = async (home: FarHome, name: string): Promise<There> => farThere(home, json() ? name : await destinationOn(home, name, MachineRegistry.load(dir())), target());

  host.command('add')
    .description('provision a remote Svall host and add it to the registry')
    .argument('<name>', 'what to call the machine here')
    .requiredOption('--ssh <destination>', 'the ssh destination to reach it at')
    .option('--release <archive>', 'install this companion archive instead of the one this release publishes')
    .option('--allow-unsigned', 'install a --release archive that carries no signature')
    .option('--as-home', 'leave it a fleet\'s home, for svall fleet join to follow, not a worker of this fleet')
    .addOption(new Option('--limits <cores,memory>', 'what the fleet may use of the machine, such as 11,93G, set without asking'))
    .addOption(new Option('--no-limits', 'leave the fleet all of the machine, without asking'))
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action((name: string, { relayed: _, limits, ...o }: { ssh: string; release?: string; allowUnsigned?: boolean; asHome?: boolean; relayed?: boolean; limits?: string | false }) => {
      const home = o.asHome ? undefined : farFor(name);
      if (home) return onHome(home, [...['host', 'add', name, '--ssh', o.ssh], ...companionFlags(o), ...connectArgs({ limits })], json(), (r, steps) => outcomeText(r as HostOutcome, 'add', name, { there: farThere(home, o.ssh, target()), steps, fleet: fleetOf(target().home) }), { installs: true });
      carriedGoes(o.release, target());
      const there = { ...thereOf(name, dir(), target()), ssh: o.ssh };
      return runFlow(json(), 'add', (out, ends) => outcomeText(out, 'add', name, { there, ...ends }), (d) => addHost({ name, ...o, ...connectChoice({ limits }, askable(json())) }, d), dir(), target(), { name, there });
    });

  host.addCommand(hostLimits(target, json));

  host.command('list')
    .description('every machine in the registry and its last check')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(async (o: { relayed?: boolean }) => {
      const registry = MachineRegistry.load(dir());
      const home = relayFor(target().home, registry);
      const far = home ? await farRows(home, registry) : [];
      const owed = owedWorkers(resolvePaths(target().home));
      const here = machineRows(registry, lastChecks(dir()), (id) => dialingFleet(id, os.homedir()), releaseVersion()).map((r) => ({ ...r, ...(o.relayed && heldHere(target(), r.id) && { worker: true as const }), ...(owed[r.id] && { joining: owedWhy(owed[r.id], r.name) }) }));
      const rows = [...here.filter((r) => !far.some((f) => f.id === r.id)), ...far];
      printResult(rows, json(), () => table(rows.map((r) => ({
        name: r.name, ssh: r.far ? `${r.ssh ?? '(dials in)'} (from ${home!.name})` : r.ssh ?? (r.id === registry.localId ? '(this machine)' : '(dials in)'), platform: r.platform,
        release: r.check?.release ?? '', checked: r.joining !== undefined ? `has not joined yet${r.joining && `: ${r.joining}`}` : r.check ? checkedLine(r.check) : '', id: r.id,
      }))));
    });

  host.command('doctor')
    .description('what the machine answers about itself, and what only this controller can check')
    .argument('<name>', 'the machine in the registry')
    .option('--all', 'list every check and each part of your agent setup, not only what needs you')
    .addOption(new Option('--steps', 'with --json, print each step as an NDJSON line as it goes, before the report').hideHelp())
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(async (name: string, o: { steps?: boolean; all?: boolean }) => {
      const shown = { fleet: fleetOf(target().home), all: o.all };
      const far = farFor(name);
      if (far) {
        const there = await farLines(far, name);
        return onHome(far, ['host', 'doctor', name, ...(o.steps ? ['--steps'] : [])], json(), orLeft((r: HostReport) => doctorText(reportBy(r, far), name, there, shown)), { steps: Boolean(o.steps) });
      }
      const entry = MachineRegistry.load(dir()).get(name);
      // a diagnosis prints a table, not steps, unless the app follows it
      const emit = o.steps && json() ? reporter(true, String).emit : () => {};
      const report = await doctorHost(name, realDeps(emit, dir(), target())).catch((e: unknown) => {
        if (entry) recordCheck(dir(), entry.id, checkOf(undefined));
        throw e;
      });
      if (entry) recordCheck(dir(), entry.id, checkOf(report));
      const there = thereOf(name, dir(), target());
      printResult(report, json(), () => doctorText(report, name, there, shown));
      if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });

  host.command('consent')
    .description('tick or untick one item of your agent setup for the machine, as host doctor --all lists it')
    .argument('<name>', 'the machine in the registry')
    .argument('<item>', 'the agent setup item, such as claude:mcp:linear')
    .argument('<state>', 'on to copy its keys there, off to stop')
    .option('--field <field...>', 'with on, only these keys of it; off takes every key')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(async (name: string, item: string, state: string, o: { field?: string[] }) => {
      if (state !== 'on' && state !== 'off') throw new Error(`${state} is not on or off`);
      const far = farFor(name);
      if (far) return onHome(far, ['host', 'consent', name, item, state, ...(o.field ? ['--field', ...o.field] : [])], json(), orLeft((r: SetupRow[]) => r.map((row) => stepLine(rowStep(row))).join('\n')));
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
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action((name: string, { relayed: _, ...o }: { release?: string; allowUnsigned?: boolean; rollback?: boolean | string; relayed?: boolean }) => {
      const far = farFor(name);
      if (far) {
        const back = o.rollback === undefined ? [] : ['--rollback', ...(typeof o.rollback === 'string' ? [o.rollback] : [])];
        return farLines(far, name).then((there) => onHome(far, ['host', 'upgrade', name, ...back, ...companionFlags(o)], json(), (r, steps) => outcomeText(r as HostOutcome, o.rollback === undefined ? 'upgrade' : 'rollback', name, { there, steps }), { installs: o.rollback === undefined }));
      }
      if (o.rollback === undefined) {
        carriedGoes(o.release, target());
        const there = thereOf(name, dir(), target());
        return runFlow(json(), 'upgrade', (out, ends) => outcomeText(out, 'upgrade', name, { there, ...ends }), (d) => upgradeHost(name, o, d), dir(), target(), { name, there });
      }
      if (o.release !== undefined || o.allowUnsigned) throw new Error('--rollback installs nothing, so it takes no --release or --allow-unsigned');
      const to = typeof o.rollback === 'string' ? o.rollback : undefined;
      return runFlow(json(), 'rollback', (out, ends) => outcomeText(out, 'rollback', name, ends), (d) => rollbackHost(name, { ...(to !== undefined && { to }) }, d), dir(), target(), { name, there: thereOf(name, dir(), target()) });
    });

  host.command('remove')
    .description('uninstall Svall on the machine and drop its route')
    .argument('<name>', 'the machine in the registry')
    .option('--forget', 'drop the route for a machine that cannot be reached, leaving it untouched')
    .addOption(new Option('--relayed', 'run for a Mac, ending with its connection').hideHelp())
    .action(async (name: string, o: { forget?: boolean }) => {
      const far = farFor(name);
      if (far) return onHome(far, ['host', 'remove', name, ...(o.forget ? ['--forget'] : [])], json(), (r, steps) => outcomeText(r as HostOutcome, 'remove', name, { ...o, steps }));
      const id = MachineRegistry.load(dir()).get(name)?.id;
      await runFlow(json(), 'remove', (out, ends) => outcomeText(out, 'remove', name, { ...o, ...ends }), (d) => removeHost(name, o, d), dir(), target());
      if (id && !MachineRegistry.load(dir()).get(id)) forgetCheck(dir(), id);
    });

  return host;
}
