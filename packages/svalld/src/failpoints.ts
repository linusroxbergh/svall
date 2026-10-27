import { isRelease } from './release.js';

/**
 * Every step of a robot move a crash can fall before or after. A step runs inside `boundary`, which gives it both edges;
 * the fault suite fails on a name here that no case crashes at.
 */
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
