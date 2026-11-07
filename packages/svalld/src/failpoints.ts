import fs from 'node:fs';
import path from 'node:path';
import { svallHome } from './paths.js';
import { isRelease } from './release.js';

/** Every step of a robot move, the worker's outbox and the home's apply of it that a crash can fall before or after; the
 *  fault suite fails on a name here that no case crashes at. */
export const FAILPOINTS = [
  // a move's steps, on the machine it leaves and the one it goes to
  'move.rest',
  'move.rest.terminated',
  'move.rest.terminate',
  'move.rest.forcekill',
  'move.rest.stopped',
  'move.rest.kill',
  'move.rest.server.journal',
  'move.rest.server.kill',
  'move.bundle',
  'move.journal.rest',
  'move.journal.bundle',
  'move.journal.prepare',
  'move.journal.commit',
  'move.journal.activate',
  'move.journal.release',
  'move.journal.done',
  'move.journal.aborted',
  'move.commit.state',
  'move.release.lock',
  'worker.prepare.worktree',
  'worker.prepare.apply',
  'worker.prepare.session',
  'worker.prepare.journal',
  'worker.activate.open',
  'worker.activate.trust',
  'worker.abort.remove',
  // the worker's outbox, and the home's write of each event it applies from it
  'worker.outbox.append',
  'worker.outbox.acked',
  'worker.outbox.trim',
  'home.event.applied',
] as const;

export type Failpoint = (typeof FAILPOINTS)[number];

/** Every operation of a home move a crash can fall before or after: each file replaced, each role change and each commit. */
export const HOME_FAILPOINTS = [
  'adopt.staging', 'adopt.staged', 'adopt.stopped', 'adopt.installing', 'adopt.file', 'adopt.dropped', 'adopt.registry', 'adopt.installed', 'adopt.started', 'restore.restarting', 'adopt.committed',
  'restore.file', 'restore.done', 'abort.recorded',
  'join.kept', 'join.state', 'join.docs', 'join.worker', 'join.done',
  'mark.written', 'enrol.written', 'move.paused', 'move.copied', 'move.marked', 'move.joined', 'deliver.owed', 'deliver.told',
] as const;
export type HomeFailpoint = (typeof HOME_FAILPOINTS)[number];
/** What a test throws at a home move's failpoint, as a crash there: no catch of the move's takes it for a failure to undo. */
export class HomeCrash extends Error {}
let homeArmed: ((name: HomeFailpoint) => void) | undefined;
/** A crash in a test falls here, or in the integration run, whose image alone sets SVALL_HOME_FAULTS: that run names failpoints in a file in the fleet home, one a line, and this process dies on the first once, or with `stop` after its name, stands still on it until it is continued; the rest wait their turn. */
export function homePoint(name: HomeFailpoint): void {
  homeArmed?.(name);
  if (process.env.SVALL_HOME_FAULTS !== '1') return;
  const file = path.join(svallHome(), 'home-fault');
  if (!fs.existsSync(file)) return;
  const [first, ...rest] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const [point, how] = first.split(' ');
  if (point !== name) return;
  if (rest.length) fs.writeFileSync(file, `${rest.join('\n')}\n`);
  else fs.rmSync(file, { force: true });
  process.kill(process.pid, how === 'stop' ? 'SIGSTOP' : 'SIGKILL');
}
export function armHomeFailpoints(hook: (name: HomeFailpoint) => void): () => void {
  homeArmed = hook;
  return () => { if (homeArmed === hook) homeArmed = undefined; };
}
export type Edge = 'before' | 'after';
/** `threw` is no failpoint: it tells the hook that a step ended by throwing, and so reaches no `after`. */
export type FailpointHook = (name: Failpoint, edge: Edge | 'threw') => void;

let armed: FailpointHook | undefined;

/** Runs `step` between its two failpoints; one that returns a promise reaches `after` once that promise fulfils. */
export function boundary<T>(name: Failpoint, step: () => T): T {
  if (!armed) return step();
  armed(name, 'before');
  let out: T;
  try { out = step(); } catch (e) {
    armed?.(name, 'threw');
    throw e;
  }
  if (out instanceof Promise) {
    return out.then((v: unknown) => { armed?.(name, 'after'); return v; }, (e: unknown) => { armed?.(name, 'threw'); throw e; }) as T;
  }
  armed?.(name, 'after');
  return out;
}

/** Arms every failpoint with `hook` until the returned function disarms it. Only a test does this, and never in a release. */
export function armFailpoints(hook: FailpointHook): () => void {
  if (isRelease()) throw new Error('failpoints cannot be armed in a release');
  armed = hook;
  return () => { if (armed === hook) armed = undefined; };
}
