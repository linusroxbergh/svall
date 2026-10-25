import { z } from 'zod';
import { FleetState, Robot, WORKER_OWNED, type MachineId } from '@svall/protocol';
import type { Store } from '../store.js';

/** The fleet as the home holds it, and the home's Claude, Codex and OpenCode config folders that paths in it may name. */
export const Snapshot = z.object({
  version: z.number().int(),
  state: FleetState,
  agentHomes: z.object({ claude: z.string(), codex: z.string(), opencode: z.string() }),
});
export type Snapshot = z.infer<typeof Snapshot>;

type Owned = (typeof WORKER_OWNED)[number];

/** A worker's own fields of a robot placed there, stamped with the placement they were taken at. */
export const RobotSync = z.object({
  robotId: z.string(),
  generation: z.number().int().nonnegative(),
  fields: Robot.pick(Object.fromEntries(WORKER_OWNED.map((k) => [k, true])) as { [K in Owned]: true }),
});
export type RobotSync = z.infer<typeof RobotSync>;

/** What a worker holds as the link opens: its robots, and how far the home has acknowledged its outbox. */
export const Inventory = z.object({ robots: z.array(RobotSync), last: z.number().int().nonnegative(), acked: z.number().int().nonnegative() });
export type Inventory = z.infer<typeof Inventory>;

const generation = (r: Robot): number => r.placement?.generation ?? 0;

// `to` with the worker-owned fields `from` holds, and without those it lacks
function withOwned(to: Robot, from: Pick<Robot, Owned>): Robot {
  const next: Record<string, unknown> = { ...to };
  for (const k of WORKER_OWNED) {
    if (from[k] === undefined) delete next[k];
    else next[k] = from[k];
  }
  return next as Robot;
}

/**
 * Takes the home's snapshot into a worker's store: every field is the home's but the scribe switch and, for a robot
 * placed here at the same placement, the worker-owned ones. A robot placed here that the snapshot lacks stays until the
 * home forgets it; any other it lacks goes.
 */
export function mergeSnapshot(store: Store, snap: Snapshot, me: MachineId): void {
  store.update((d) => {
    const incoming = structuredClone(snap.state);
    const robots = Object.fromEntries(Object.entries(d.robots).filter(([, r]) => r.machine === me));
    for (const [id, r] of Object.entries(incoming.robots)) {
      const held = d.robots[id];
      robots[id] = held?.machine === me && r.machine === me && generation(held) === generation(r) ? withOwned(r, held) : r;
    }
    const { scribeOff } = d;
    for (const k of Object.keys(d)) delete (d as Record<string, unknown>)[k];
    Object.assign(d, incoming, { robots }, scribeOff && { scribeOff });
  });
}

export function ownedReport(robot: Robot): RobotSync {
  const fields = Object.fromEntries(WORKER_OWNED.filter((k) => robot[k] !== undefined).map((k) => [k, robot[k]]));
  return { robotId: robot.id, generation: generation(robot), fields: fields as Pick<Robot, Owned> };
}

/** Writes a worker's report over the home's record of the robot, when the robot is still placed on that worker at that generation. */
export function applyReport(store: Store, r: RobotSync, machine: MachineId): 'applied' | 'stale' | 'unknown' {
  const held = store.state.robots[r.robotId];
  if (!held) return 'unknown';
  if (held.machine !== machine || generation(held) !== r.generation) return 'stale';
  store.update((d) => { d.robots[r.robotId] = withOwned(d.robots[r.robotId], structuredClone(r.fields)); });
  return 'applied';
}
