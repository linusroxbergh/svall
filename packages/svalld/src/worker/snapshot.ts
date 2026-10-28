import jsonpatch from 'fast-json-patch';
import { z } from 'zod';
import { FleetState, Robot, UPDATE_FIELDS, WORKER_OWNED, type MachineId, type Mutation } from '@svall/protocol';
import type { Store } from '../store.js';

/** The fleet as the home holds it, and the home's user folder and Claude, Codex and OpenCode config folders that paths in it may name. */
export const Snapshot = z.object({
  version: z.number().int(),
  state: FleetState,
  agentHomes: z.object({ claude: z.string(), codex: z.string(), opencode: z.string() }),
  home: z.string(),
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

/** What a worker holds as the link opens: its robots, and how far the home has acknowledged its outbox in the outbox's epoch. */
export const Inventory = z.object({ robots: z.array(RobotSync), last: z.number().int().nonnegative(), acked: z.number().int().nonnegative(), epoch: z.string() });
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

// what the mutations the home has yet to take changed here: the fields an update named, and a robot a close took away
function keepPending(robots: Record<string, Robot>, held: Record<string, Robot>, pending: Mutation[]): void {
  for (const m of pending) {
    const p = m.params as Record<string, unknown>;
    if (typeof p?.id !== 'string') continue;
    if (m.method === 'robot.close') delete robots[p.id];
    if (m.method !== 'robot.update' || !Object.hasOwn(held, p.id) || !Object.hasOwn(robots, p.id)) continue;
    const named: string[] = UPDATE_FIELDS.filter((k) => p[k] !== undefined);
    const to = robots[p.id] as Record<string, unknown>;
    const from = held[p.id] as Record<string, unknown>;
    for (const k of named.includes('note') ? [...named, 'noteSource'] : named) {
      if (from[k] === undefined) delete to[k];
      else to[k] = from[k];
    }
  }
}

/** Takes the home's snapshot into a worker's store, keeping the scribe switch, the robots placed here with their own fields at
 *  that placement, and what `pending` mutations changed; `home` gets its entry with this snapshot's version. */
export function mergeSnapshot(store: Store, snap: Snapshot, me: MachineId, home?: { id: MachineId; name: string; reachable: boolean }, pending: Mutation[] = []): void {
  store.update((d) => {
    const held = home && d.machines?.[home.id];
    const incoming = structuredClone(snap.state);
    const robots = Object.fromEntries(Object.entries(d.robots).filter(([, r]) => r.machine === me));
    for (const [id, r] of Object.entries(incoming.robots)) {
      const held = d.robots[id];
      robots[id] = held?.machine === me && r.machine === me && generation(held) === generation(r) ? withOwned(r, held) : r;
    }
    keepPending(robots, d.robots, pending);
    const { scribeOff } = d;
    for (const k of Object.keys(d)) delete (d as Record<string, unknown>)[k];
    Object.assign(d, incoming, { robots }, scribeOff && { scribeOff });
    if (!home) return;
    const since = held && held.reachable === home.reachable ? held.since : Date.now();
    (d.machines ??= {})[home.id] = { ...held, name: home.name, reachable: home.reachable, since, home: snap.home, snapshot: { version: snap.version, at: Date.now() } };
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

/** Reports the worker-owned fields of each robot running here whenever a change to the store leaves them other than last reported. */
export function watchOwned(store: Store, runsHere: (c: Robot) => boolean, report: (r: RobotSync) => void): () => void {
  const sent = new Map<string, string>();
  return store.subscribe((ops) => {
    const touched = new Set(ops.filter((o) => o.path.startsWith('/robots/')).map((o) => jsonpatch.unescapePathComponent(o.path.split('/')[2])));
    for (const id of touched) {
      const c = Object.hasOwn(store.state.robots, id) ? store.state.robots[id] : undefined;
      if (!c || !runsHere(c)) { sent.delete(id); continue; }
      const r = ownedReport(c);
      const key = JSON.stringify(r);
      if (sent.get(id) === key) continue;
      sent.set(id, key);
      report(r);
    }
  });
}
