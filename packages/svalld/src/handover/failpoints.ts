import { isRelease } from '../release.js';

/** The party a failpoint's step runs on. */
export type FailSide = 'controller' | 'source' | 'destination' | 'gateway';

/**
 * Every step of a handover a crash can fall before or after, by the party that takes it: each authority, journal and
 * ownership write, removal of a handover's files, terminal kill and start, verification, prepared-state write, promotion
 * and commit answer. A step runs inside `boundary`, which gives it both edges; the fault suite fails on a name here that
 * no case crashes at.
 */
export const FAILPOINTS = {
  'source.freeze.journal': 'source',
  'source.freeze.surrender': 'source',
  'source.rest.terminated': 'source',
  'source.rest.terminate': 'source',
  'source.rest.forcekill': 'source',
  'source.rest.stopped': 'source',
  'source.rest.kill': 'source',
  'source.rest.server.journal': 'source',
  'source.rest.server.kill': 'source',
  'source.freeze.export': 'source',
  'source.freeze.manifest': 'source',
  'source.freeze.digest': 'source',
  'source.startup.surrender': 'source',
  'source.abort.journal': 'source',
  'source.revive': 'source',
  'source.release.manifest': 'source',
  'source.release.journal': 'source',
  'source.release.unfreeze': 'source',
  'source.release.activate': 'source',
  'source.complete.seal': 'source',
  'source.complete.install': 'source',
  'source.complete.deactivate': 'source',
  'source.complete.manifest': 'source',
  'source.complete.journal': 'source',

  'destination.claim.seal': 'destination',
  'destination.claim.root': 'destination',
  'destination.claim.archive': 'destination',
  'destination.verify.journal': 'destination',
  'destination.verify.landed': 'destination',
  'destination.verify.record': 'destination',
  'destination.prepare.seal': 'destination',
  'destination.prepare.delete': 'destination',
  'destination.prepare.import': 'destination',
  'destination.prepare.state': 'destination',
  'destination.prepare.journal': 'destination',
  'destination.prepare.stage': 'destination',
  'destination.activate.install': 'destination',
  'destination.commit.journal': 'destination',
  'destination.promote.fleet': 'destination',
  'destination.promote.state': 'destination',
  'destination.activate.journal': 'destination',
  'destination.activate.fleet': 'destination',
  'destination.activate.kill': 'destination',
  'destination.activate.open': 'destination',
  'destination.activate.record': 'destination',
  'destination.complete.seal': 'destination',
  'destination.complete.clear': 'destination',
  'destination.complete.journal': 'destination',
  'destination.abort.stage': 'destination',
  'destination.abort.seal': 'destination',
  'destination.abort.clear': 'destination',
  'destination.abort.journal': 'destination',

  'gateway.begin.write': 'gateway',
  'gateway.ready.write': 'gateway',
  'gateway.commit.write': 'gateway',
  'gateway.abort.write': 'gateway',
  'gateway.complete.write': 'gateway',
  'gateway.commit.respond': 'gateway',

  'controller.journal': 'controller',
  'controller.manifest': 'controller',
  'controller.landed': 'controller',
  'controller.clear': 'controller',
  'controller.rsync': 'controller',
  'controller.verify': 'controller',
  'controller.commit': 'controller',
} as const satisfies Record<string, FailSide>;

export type Failpoint = keyof typeof FAILPOINTS;
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
