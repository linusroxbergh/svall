import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type net from 'node:net';
import readline from 'node:readline';
import { Command, Option as Flag } from 'commander';
import { FleetConfig, type Blocker, type HandoverChoices, type HandoverEvent, type HandoverPhase, type MachineId, type Outcome, type Verdict } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import { profileOf } from '@svall/svalld/profile';
import type { Handover } from '../controller/handover.js';
import { connectHandover, type Connected } from '../controller/reach.js';
import { connectHelper, helperPaths, HelperServer, Live, lockHolder, probe, readPid, takeLock, type HelperPaths } from '../controller/helper.js';
import { redact } from '../controller/process.js';
import { closeMastersOnSignal } from '../controller/ssh.js';
import { fileStore, forgettable } from '../controller/recovery.js';
import { MachineRegistry } from '../controller/registry.js';
import type { Target } from '../target.js';
import { options, Prompter, View, type Words } from './handover-view.js';

/** The one handover transaction of a fleet, as the commands drive it. */
export type Transaction = Pick<Connected, 'secrets' | 'close'> & {
  handover: Pick<Handover, 'start' | 'resume' | 'abort' | 'status' | 'choose' | 'cancel'> & { readonly finished?: Promise<Outcome> };
};

export type Decide = (blockers: Blocker[], phase: HandoverPhase) => Promise<HandoverChoices | 'cancel'>;

export type CliDeps = {
  connect(o: { fleetHome: string; profile?: string; record(e: HandoverEvent): void; decide: Decide }): Transaction;
  registry(): MachineRegistry;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(s: string): unknown; on?(event: 'error', fn: (e: Error) => void): unknown };
  stderr: { write(s: string): unknown };
  signals: NodeJS.EventEmitter;
  /** starts this command again as the helper, in a session of its own, its stderr on `log` */
  launch(args: string[], log: number): ChildProcess;
  /** this invocation's own arguments, which the helper is started with */
  argv(): string[];
  tmpdir?: string;
  launchTimeoutMs?: number;
};

export type Job = { kind: 'start'; to: string; choices: HandoverChoices } | { kind: 'resume' } | { kind: 'abort' };
/** `helper`: the process a launcher left running, with no terminal; its decisions wait for an attached client. */
export type Ctx = { fleetHome: string; profile?: string; json: boolean; deps: CliDeps; helper?: boolean };
/** `hard`: the process is to exit now, the transaction behind it or not. */
export type Ran = { code: number; hard?: boolean };

const LAUNCH_TIMEOUT_MS = 20_000;
const POLL_MS = 50;
// a replayed decision is followed within the same burst by whatever answered it
const SETTLE_MS = 150;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const stopped = (error: string): Outcome => ({ status: 'interrupted', phase: 'begin', error, safe: [] });
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}": seconds, or a number with ms, s, m or h after it, like 30s`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Math.round(Number(m[1]) * unit);
}

function words(c: Ctx): Words {
  return {
    svall: (args) => `svall ${c.profile ? `-p ${c.profile} ` : ''}${args}`,
    machine: (id) => (id ? c.deps.registry().get(id)?.record.name ?? id : 'a machine no journal names'),
  };
}

function gatewayOf(fleetHome: string): MachineId | undefined {
  const file = resolvePaths(fleetHome).fleetConfig;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`there is no fleet at ${fleetHome} (${file} cannot be read)`); }
  return FleetConfig.parse(JSON.parse(text)).gatewayMachineId;
}

const noGateway = (c: Ctx): string =>
  `this fleet has no gateway, so no other machine can be handed it; name one with \`svall host enable <host> --fleet ${c.profile ?? profileOf(c.fleetHome)}\``;
const live = (pid: number | undefined, w: Words): string =>
  `a handover of this fleet is already running here${pid ? ` (pid ${pid})` : ''}; \`${w.svall('handover attach')}\` follows it`;

/** Why the lock was refused: a helper that answers, or a holder that does not, such as a --forget under way. */
async function refusal(e: Live, paths: HelperPaths, w: Words): Promise<string> {
  if ((await probe(paths.socket)) === 'live') return live(e.pid, w);
  return `pid ${e.pid ?? '?'} holds this fleet's handover lock without answering on its control socket; try again, and if no svall handover runs here, remove ${paths.lock}`;
}

/** Where lines go: one event per line on stdout with --json, a person's reading otherwise, and nothing from a helper. */
type Out = { line(line: string): void; event(e: HandoverEvent): void; note(text: string): void };

function output(c: Ctx, view: View): Out {
  // a reader that has gone (EPIPE) ends the output, never the run: the journals carry it on
  c.deps.stdout.on?.('error', () => undefined);
  const err = (text: string) => { c.deps.stderr.write(`svall handover: ${text}\n`); };
  // a helper's run is in the events file; what stops it before it listens goes to its log
  if (c.helper) return { line: () => undefined, event: (e) => err(JSON.stringify(e)), note: err };
  if (c.json) return { line: (l) => { c.deps.stdout.write(`${l}\n`); }, event: (e) => { c.deps.stdout.write(`${JSON.stringify(e)}\n`); }, note: err };
  return {
    line: (l) => { try { view.show(JSON.parse(l) as HandoverEvent); } catch { /* not an event */ } },
    event: (e) => view.show(e),
    note: (text) => { c.deps.stdout.write(`${text}\n`); },
  };
}

function viewFor(c: Ctx, interactive = false): View {
  return new View((line) => { c.deps.stdout.write(`${line}\n`); }, words(c), interactive);
}

// a socket nobody answers on is left to the next helper, which holds the lock that lets it remove one
const answers = async (paths: HelperPaths): Promise<boolean> => (await probe(paths.socket)) === 'live';

/** Where the journals leave the handover, scrubbed of the tokens asking it took. */
async function verdictOf(c: Ctx): Promise<Verdict> {
  if (!gatewayOf(c.fleetHome)) return { standing: 'none', journals: {}, safe: [], action: 'none', reason: noGateway(c) };
  const tx = c.deps.connect({ fleetHome: c.fleetHome, profile: c.profile, record: () => undefined, decide: async () => 'cancel' });
  try {
    const { verdict } = await tx.handover.status();
    return JSON.parse(redact(JSON.stringify(verdict), tx.secrets())) as Verdict;
  } catch (e) {
    throw new Error(redact(messageOf(e), tx.secrets()));
  } finally {
    await tx.close();
  }
}

/** The decision a run waits on, which a person at the terminal or an attached client answers, whichever is first. */
class Decisions {
  private pending?: (a: HandoverChoices | 'cancel') => void;
  get open(): boolean { return this.pending !== undefined; }
  ask(): Promise<HandoverChoices | 'cancel'> { return new Promise((resolve) => { this.pending = resolve; }); }
  answer(a: HandoverChoices | 'cancel'): boolean {
    const p = this.pending;
    this.pending = undefined;
    p?.(a);
    return p !== undefined;
  }
}

const done = (job: Job, o: Outcome): boolean => (job.kind === 'abort' ? o.status === 'aborted' : o.status === 'complete');

// an answer is the whole of the choices from here on: one it leaves out is turned off
const replace = (held: HandoverChoices, answer: HandoverChoices): void => {
  for (const k of Object.keys(held) as (keyof HandoverChoices)[]) delete held[k];
  Object.assign(held, answer);
};

/**
 * Runs one start, resume or abort as this fleet's helper: it holds the control socket, keeps the events file and
 * serves attached clients. In the foreground it also reports to the terminal, asks there when it can, and takes
 * Ctrl-C: before the commit a safe stop, after it the move goes on, and a second one leaves.
 */
export async function runHandover(job: Job, c: Ctx): Promise<Ran> {
  const interactive = !c.helper && !c.json && c.deps.stdin.isTTY === true;
  const w = words(c);
  const view = viewFor(c, interactive);
  const out = output(c, view);
  const refuse = (o: Outcome): Ran => { out.event({ event: 'handover.result', data: o }); return { code: 1 }; };

  let gateway: MachineId | undefined;
  try { gateway = gatewayOf(c.fleetHome); } catch (e) { return refuse(stopped(messageOf(e))); }
  if (!gateway) return refuse(stopped(noGateway(c)));
  const to = job.kind === 'start' ? c.deps.registry().get(job.to) : undefined;
  if (job.kind === 'start' && !to) return refuse(stopped(`no machine ${job.to} in the registry; add it with \`svall host add\`${c.deps.registry().setAside()}`));
  view.about.destination = to?.record.name;
  // a controller hands a fleet only to or from the machine it runs on, so one handed away is this machine's
  if (to && to.id !== c.deps.registry().localId) view.about.source = c.deps.registry().localMachine().name;

  const paths = helperPaths(c.fleetHome, c.deps.tmpdir);
  let tx: Transaction | undefined;
  let server: HelperServer;
  try {
    server = await HelperServer.open(paths, { scrub: (line) => redact(line, tx?.secrets() ?? []) });
  } catch (e) {
    return refuse(stopped(e instanceof Live ? await refusal(e, paths, w) : messageOf(e)));
  }
  const record = (e: HandoverEvent): void => out.line(server.record(e));

  const held: HandoverChoices = job.kind === 'start' ? { ...job.choices } : {};
  const decisions = new Decisions();
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    prompter?.abandon();
    decisions.answer('cancel');
    tx?.handover.cancel();
  };
  const idle = (line: string): void => {
    if (line === 'c') { signal(); return; }
    if (line === 'i' && view.phase === 'freeze') {
      const who = [...view.resting].map((id) => view.names.characters[id] ?? id);
      out.note(`Interrupting ${who.length ? who.join(', ') : 'the agents still working'}; each is carried once its hook or process tree confirms it rested`);
      tx?.handover.choose({ interruptAfterMs: 0 });
      return;
    }
    out.note('Type i and Enter to interrupt and carry the agents still working, or c to cancel.');
  };
  const prompter = interactive ? new Prompter(c.deps.stdin, (l) => out.note(l), idle) : undefined;
  const decide: Decide = async (blockers, phase) => {
    if (!c.helper && !interactive) return 'cancel';
    const asked = decisions.ask();
    if (prompter) void prompter.pick(options(blockers, phase, view.names, held)).then((a) => { if (a !== undefined) decisions.answer(a); });
    const a = await asked;
    if (a === 'cancel') return a;
    replace(held, a);
    return { ...held };
  };

  const cancellers = new Set<net.Socket>();
  let detached: Outcome | undefined;
  server.onControl((ctl, from) => {
    if ('choose' in ctl) {
      if (decisions.open) {
        prompter?.abandon();
        decisions.answer(ctl.choose);
      } else {
        tx?.handover.choose(ctl.choose);
      }
      return;
    }
    if (detached) { server.release(from, { event: 'handover.result', data: detached }); return; }
    cancellers.add(from);
    cancel();
  });

  let signalled = 0;
  let leave!: (r: Ran) => void;
  const left = new Promise<Ran>((resolve) => { leave = resolve; });
  const goesOn = (): void => {
    out.note(`The fleet is committed${view.about.destination ? ` to ${view.about.destination}` : ''}, so the move goes on until it finishes. `
      + `Ctrl-C again stops watching; \`${w.svall('handover --resume')}\` finishes it then.`);
  };
  const signal = (): void => {
    if (++signalled === 1) {
      if (detached) { goesOn(); return; }
      out.note('Cancelling: before the commit the handover is aborted and the fleet stays where it was; once committed, the move goes on.');
      cancel();
      return;
    }
    out.note(detached
      ? `Stopped watching. The fleet is committed; \`${w.svall('handover --resume')}\` finishes the move.`
      : `Stopped watching. \`${w.svall('handover status')}\` says what is safe: \`${w.svall('handover --resume')}\` goes on, and before the commit \`${w.svall('handover --abort')}\` takes the fleet back.`);
    leave({ code: 1, hard: true });
  };
  const hangup = (): void => leave({ code: 1, hard: true });
  const listening = !c.helper;
  if (listening) {
    c.deps.signals.on('SIGINT', signal);
    c.deps.signals.on('SIGTERM', signal);
    c.deps.signals.on('SIGHUP', hangup);
    c.deps.signals.on('SIGQUIT', hangup);
  }

  const run = async (t: Transaction): Promise<Outcome> => {
    if (job.kind === 'start' && to) {
      let o = await t.handover.start(to.id, { ...held });
      // nothing began, so a person's answer is a new start with the choices it names
      while (prompter && !cancelled && o.status === 'blocked' && !o.transactionId) {
        const opts = options(o.blockers, 'begin', view.names, held);
        if (!opts.length) break;
        const picked = await prompter.pick(opts);
        if (picked === undefined || picked === 'cancel' || cancelled) break;
        replace(held, picked);
        o = await t.handover.start(to.id, { ...held });
      }
      return o;
    }
    const { verdict } = await t.handover.status();
    view.about = { source: w.machine(verdict.fromMachineId), destination: verdict.toMachineId && w.machine(verdict.toMachineId) };
    if (verdict.standing === 'superseded') {
      return {
        status: 'interrupted', ...(verdict.transactionId && { transactionId: verdict.transactionId }), phase: verdict.phase ?? 'begin', safe: [],
        error: `${verdict.reason}; \`${w.svall('handover --forget')}\` drops this controller's journal of it`,
      };
    }
    return job.kind === 'resume' ? t.handover.resume() : t.handover.abort();
  };

  let ran: Ran;
  try {
    tx = c.deps.connect({
      fleetHome: c.fleetHome, profile: c.profile, decide,
      record: (e) => {
        // a question comes with the choices the journal holds, which its answer starts from
        if (e.event === 'handover.blocked' && e.data.choices) replace(held, e.data.choices);
        // the command writes the one result, once the run is over for it
        if (e.event !== 'handover.result') record(e);
      },
    });
    const t = tx;
    let outcome = await Promise.race([run(t).catch((e: unknown): Outcome => stopped(redact(messageOf(e), t.secrets()))), left]);
    if ('status' in outcome && outcome.status === 'detached') {
      detached = outcome;
      for (const s of cancellers) server.release(s, { event: 'handover.result', data: outcome });
      cancellers.clear();
      if (signalled) goesOn();
      const finished = t.handover.finished ?? new Promise<Outcome>(() => undefined);
      outcome = await Promise.race([finished.catch((e: unknown): Outcome => stopped(redact(messageOf(e), t.secrets()))), left]);
    }
    if ('code' in outcome) {
      ran = outcome;
    } else {
      record({ event: 'handover.result', data: outcome });
      ran = { code: done(job, outcome) ? 0 : 1 };
    }
  } catch (e) {
    record({ event: 'handover.result', data: stopped(redact(messageOf(e), tx?.secrets() ?? [])) });
    ran = { code: 1 };
  } finally {
    // once the run is over a signal leaves at once, and the exit ends the masters still open
    if (listening) for (const s of ['SIGINT', 'SIGTERM'] as const) { c.deps.signals.off(s, signal); c.deps.signals.on(s, hangup); }
    prompter?.close();
  }
  await server.close().catch(() => undefined);
  if (!ran.hard && tx) {
    const closing = tx.close().then(() => false, () => false);
    if (await Promise.race([closing, left.then(() => true)])) ran = { ...ran, hard: true };
  }
  if (listening) for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) c.deps.signals.off(s, hangup);
  return ran;
}

/** Waits for the launched helper itself to answer on the socket, holding the lock, or to stop first. */
function started(paths: HelperPaths, child: ChildProcess, timeoutMs: number): Promise<true | string> {
  return new Promise((resolve) => {
    let over = false;
    const finish = (r: true | string): void => { if (!over) { over = true; resolve(r); } };
    child.once('exit', (code, signal) => finish(`exited (${signal ?? `code ${code}`})`));
    child.once('error', (e) => finish(`could not start: ${e.message}`));
    const end = Date.now() + timeoutMs;
    void (async () => {
      while (!over) {
        if (child.pid !== undefined && readPid(paths) === child.pid && await answers(paths)) { finish(true); return; }
        if (Date.now() >= end) {
          child.kill();
          finish(`did not open its control socket within ${Math.round(timeoutMs / 1000)} s`);
          return;
        }
        await sleep(POLL_MS);
      }
    })();
  });
}

/** Which events file is there now: a helper that listens starts it afresh, so one written since this was read is its run's. */
function writtenAs(file: string): string | undefined {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}`;
  } catch {
    return undefined;
  }
}

/** The events file's last handover.result, as the helper wrote it, and the outcome it holds. */
function lastResult(file: string): { line: string; outcome: Outcome } | undefined {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const line of text.split('\n').reverse()) {
    try {
      const e = JSON.parse(line) as HandoverEvent;
      if (e.event === 'handover.result') return { line, outcome: e.data };
    } catch { /* not an event */ }
  }
  return undefined;
}

export function spawnHelper(exe: string, script: string[], args: string[], log: number): ChildProcess {
  return spawn(exe, [...script, ...args], { detached: true, stdio: ['ignore', 'ignore', log] });
}

/** `--detach`: leaves the run to a helper in a session of its own, and says where it runs once its socket answers. */
export async function launchHelper(job: Job, c: Ctx): Promise<number> {
  const w = words(c);
  const out = output(c, viewFor(c));
  const refuse = (o: Outcome): number => { out.event({ event: 'handover.result', data: o }); return 1; };
  let gateway: MachineId | undefined;
  try { gateway = gatewayOf(c.fleetHome); } catch (e) { return refuse(stopped(messageOf(e))); }
  if (!gateway) return refuse(stopped(noGateway(c)));
  if (job.kind === 'start' && !c.deps.registry().get(job.to)) return refuse(stopped(`no machine ${job.to} in the registry; add it with \`svall host add\`${c.deps.registry().setAside()}`));
  const paths = helperPaths(c.fleetHome, c.deps.tmpdir);
  // a lock the child could not take is said here, where the app reads it, and not only in the child's log
  const holder = lockHolder(paths);
  if (holder !== undefined || await answers(paths)) return refuse(stopped(await refusal(new Live(holder ?? readPid(paths)), paths, w)));

  const before = writtenAs(paths.events);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(paths.log, 'a', 0o600);
  let child: ChildProcess;
  try {
    fs.fchmodSync(log, 0o600);
    child = c.deps.launch([...c.deps.argv().filter((a) => a !== '--detach'), '--helper'], log);
  } catch (e) {
    return refuse(stopped(`the handover helper could not be started: ${messageOf(e)}`));
  } finally {
    fs.closeSync(log);
  }
  const up = await started(paths, child, c.deps.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
  if (up !== true) {
    // a helper can listen, run and end between two looks at its socket
    const ended = writtenAs(paths.events) !== before ? lastResult(paths.events) : undefined;
    if (ended) {
      out.line(ended.line);
      return done(job, ended.outcome) ? 0 : 1;
    }
    return refuse(stopped(`the handover helper ${up} before it listened; ${paths.log} says why`));
  }
  child.unref();
  out.event({ event: 'handover.detached', data: { pid: child.pid ?? 0 } });
  return 0;
}

/** `status`: where the journals leave the handover, changing nothing; a live helper is named at once, and `attach` says where it stands. */
export async function runStatus(c: Ctx): Promise<number> {
  const out = output(c, viewFor(c));
  const paths = helperPaths(c.fleetHome, c.deps.tmpdir);
  if (await answers(paths)) {
    const pid = readPid(paths) ?? 0;
    const reason = `a handover of this fleet runs here as pid ${pid}; \`${words(c).svall('handover attach')}\` follows it`;
    out.event({ event: 'handover.status', data: { standing: 'unknown', journals: {}, safe: [], action: 'none', reason, helper: { pid } } });
    return 0;
  }
  try {
    out.event({ event: 'handover.status', data: await verdictOf(c) });
    return 0;
  } catch (e) {
    out.note(messageOf(e));
    return 1;
  }
}

/**
 * `attach`: follows the live helper, socket to stdout and stdin to socket, until either ends. With no helper
 * running, what the last run left in the events file, then where the journals leave it now.
 */
export async function runAttach(c: Ctx): Promise<number> {
  const interactive = !c.json && c.deps.stdin.isTTY === true;
  const view = viewFor(c, interactive);
  const out = output(c, view);
  const paths = helperPaths(c.fleetHome, c.deps.tmpdir);

  let pending: ReturnType<typeof setTimeout> | undefined;
  let prompter: Prompter | undefined;
  const conn = await (await answers(paths)
    ? connectHelper(paths.socket, (line) => {
      out.line(line);
      if (!prompter) return;
      let e: HandoverEvent;
      try { e = JSON.parse(line) as HandoverEvent; } catch { return; }
      if (e.event === 'handover.entity') return;
      clearTimeout(pending);
      prompter.abandon();
      if (e.event !== 'handover.blocked') return;
      const p = prompter;
      pending = setTimeout(() => {
        void p.pick(options(e.data.blockers, e.data.phase, view.names, e.data.choices)).then((a) => {
          if (a !== undefined) conn?.send(JSON.stringify(a === 'cancel' ? { cancel: true } : { choose: a }));
        });
      }, SETTLE_MS);
    }).catch(() => undefined)
    : undefined);

  if (!conn) {
    let text = '';
    try { text = fs.readFileSync(paths.events, 'utf8'); } catch { /* no run has left one */ }
    for (const line of text.split('\n')) if (line.trim()) out.line(line);
    try {
      out.event({ event: 'handover.status', data: await verdictOf(c) });
      return 0;
    } catch (e) {
      out.note(messageOf(e));
      return 1;
    }
  }

  let rl: readline.Interface | undefined;
  if (interactive) {
    prompter = new Prompter(c.deps.stdin, (l) => out.note(l), (line) => {
      if (line === 'i') conn.send(JSON.stringify({ choose: { interruptAfterMs: 0 } }));
      else if (line === 'c') conn.send(JSON.stringify({ cancel: true }));
      else out.note('Type i and Enter to interrupt and carry the agents still working, or c to cancel the handover.');
    }, () => conn.close());
  } else {
    rl = readline.createInterface({ input: c.deps.stdin, terminal: false });
    rl.on('line', (line) => conn.send(line));
    rl.on('close', () => conn.close());
  }
  await conn.closed;
  clearTimeout(pending);
  prompter?.close();
  rl?.close();
  return 0;
}

/** `--forget`: drops this controller's journal of a handover nothing can drive any more, and nothing else. */
export async function runForget(c: Ctx): Promise<number> {
  const w = words(c);
  const view = viewFor(c);
  const out = output(c, view);
  const paths = helperPaths(c.fleetHome, c.deps.tmpdir);
  let gateway: MachineId | undefined;
  try { gateway = gatewayOf(c.fleetHome); } catch (e) { out.note(messageOf(e)); return 1; }
  if (!gateway) { out.note(noGateway(c)); return 1; }
  // held from the first look to the clear, so no helper starts on the journal in between
  let release: () => void;
  try {
    release = takeLock(paths);
  } catch (e) {
    out.note(e instanceof Live ? await refusal(e, paths, w) : messageOf(e));
    return 1;
  }
  try {
    return await forget(c, paths, w, out);
  } finally {
    release();
  }
}

async function forget(c: Ctx, paths: HelperPaths, w: Words, out: Out): Promise<number> {
  const tx = c.deps.connect({ fleetHome: c.fleetHome, profile: c.profile, record: () => undefined, decide: async () => 'cancel' });
  const scrubbed = (v: Verdict): Verdict => JSON.parse(redact(JSON.stringify(v), tx.secrets())) as Verdict;
  try {
    const { observation, verdict } = await tx.handover.status();
    const may = forgettable(observation, verdict);
    if (!may.ok) {
      const safe = verdict.safe.map((s) => `\`${w.svall(`handover --${s}`)}\``).join(' or ');
      out.note(redact(`Not forgotten: ${may.reason}.${safe ? ` ${safe} is the way on.` : ''}`, tx.secrets()));
      if (c.json) out.event({ event: 'handover.status', data: scrubbed(verdict) });
      return 1;
    }
    const id = verdict.transactionId ?? observation.controller?.transactionId;
    fileStore(paths.dir).clear(id);
    // a later attach would otherwise replay the run the gateway moved past
    fs.rmSync(paths.events, { force: true });
    out.note(`Forgot this controller's journal of ${id ?? 'a handover that never began'}; the daemons' journals and the gateway's record are as they were.`);
    if (c.json) out.event({ event: 'handover.status', data: scrubbed((await tx.handover.status()).verdict) });
    return 0;
  } catch (e) {
    out.note(redact(messageOf(e), tx.secrets()));
    return 1;
  } finally {
    await tx.close();
  }
}

let registry: MachineRegistry | undefined;

export function realDeps(): CliDeps {
  return {
    connect: (o) => connectHandover(o),
    registry: () => (registry ??= MachineRegistry.load()),
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signals: process,
    // node and whatever loads this CLI, then its entry script, as this process was started
    launch: (args, log) => spawnHelper(process.execPath, [...process.execArgv, process.argv[1]], args, log),
    argv: () => process.argv.slice(2),
  };
}

type Flags = {
  interruptAfter?: string; terminateShells?: boolean; archive: string[];
  resume?: boolean; abort?: boolean; forget?: boolean; detach?: boolean; helper?: boolean;
};

function jobOf(machine: string | undefined, f: Flags): Job | 'forget' {
  const asked = [machine !== undefined, f.resume, f.abort, f.forget].filter(Boolean).length;
  if (asked !== 1) throw new Error('name one machine to hand the fleet to (a host, or local), or one of --resume, --abort and --forget');
  if (machine === undefined && (f.interruptAfter !== undefined || f.terminateShells || f.archive.length)) {
    throw new Error('--interrupt-after, --terminate-shells and --archive go with the machine a handover starts to');
  }
  if (f.forget && f.detach) throw new Error('--forget runs in the foreground only');
  if (f.forget) return 'forget';
  if (f.resume) return { kind: 'resume' };
  if (f.abort) return { kind: 'abort' };
  const choices: HandoverChoices = {
    ...(f.interruptAfter !== undefined && { interruptAfterMs: parseDuration(f.interruptAfter) }),
    ...(f.terminateShells && { terminateShells: true }),
    ...(f.archive.length && { archiveRoots: f.archive }),
  };
  return { kind: 'start', to: machine as string, choices };
}

export function handoverCommand(o: {
  target(): Target; profile(): string | undefined; json(): boolean; deps?(): CliDeps;
  run?(job: Job, c: Ctx): Promise<Ran>;
  exit?(code: number, hard?: boolean): void;
}): Command {
  const ctx = (): Ctx => ({ fleetHome: o.target().home, profile: o.profile(), json: o.json(), deps: (o.deps ?? realDeps)() });
  // a command that holds ssh masters and no terminal's Ctrl-C of its own lets them go on a signal
  const guard = (): void => { if (!o.deps) closeMastersOnSignal(); };
  const exit = o.exit ?? ((code: number, hard?: boolean) => { if (hard) process.exit(code); process.exitCode = code; });
  const cmd = new Command('handover')
    .description('move this fleet to another machine, or bring it to this one')
    .argument('[machine]', 'a machine in the registry, or local for this one')
    .option('--interrupt-after <duration>', 'interrupt the agents still working after this long, e.g. 30s or 2m')
    .option('--terminate-shells', "terminate what keeps a terminal busy: a shell's foreground process, and an interrupted agent that will not settle; an agent with a background command still running counts as not settled")
    .option('--archive <root>', 'move a destination root that diverged or is occupied to a timestamped sibling first, by the root id a blocker names or its path; repeatable', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--resume', 'go the one safe way on with the handover left open')
    .option('--abort', 'take the fleet back to the machine it came from; before the commit only')
    .option('--forget', "drop this controller's journal of a handover the gateway has moved past")
    .option('--detach', 'leave the handover to a background helper and print where it runs; `svall handover attach` follows it')
    .addOption(new Flag('--helper').hideHelp())
    .action(async (machine: string | undefined, f: Flags) => {
      let job: Job | 'forget';
      try {
        job = jobOf(machine, f);
      } catch (e) {
        // whoever reads a --json or --detach run reads its result, not stderr
        if (!o.json() && !f.detach) throw e;
        const c = ctx();
        output(c, viewFor(c)).event({ event: 'handover.result', data: stopped(messageOf(e)) });
        exit(1);
        return;
      }
      const c = ctx();
      if (job === 'forget') { guard(); exit(await runForget(c)); return; }
      if (f.detach && !f.helper) { exit(await launchHelper(job, c)); return; }
      if (f.helper) guard();
      const ran = await (o.run ?? runHandover)(job, { ...c, helper: f.helper === true });
      // a helper has no reader left to flush to, so it goes once its run is over
      exit(ran.code, ran.hard || f.helper === true);
    });
  cmd.command('status').description('where the handover stands and what is safe, changing nothing').action(async () => { guard(); exit(await runStatus(ctx())); });
  cmd.command('attach').description('follow the handover running here, and steer it from stdin').action(async () => { guard(); exit(await runAttach(ctx())); });
  return cmd;
}
