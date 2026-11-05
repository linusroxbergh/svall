import { z } from 'zod';
import { FleetId, MachineId, MachinePath, SshDestination } from './ids.js';
import { MachineRecord } from './machines.js';
import { WorkerFile } from './placement.js';
import type { FleetState } from './state.js';

export const HomeMoveId = z.string().regex(/^hm_[0-9a-z]{10}$/);
export type HomeMoveId = z.infer<typeof HomeMoveId>;

/** How the machine taking the fleet reaches the old home, which has no route to it: on disk from before that home's mark until it has heard how the move ended. */
export const HomeDelivery = z.object({ id: HomeMoveId, ssh: SshDestination, svallBase: MachinePath, fleetHome: MachinePath });
export type HomeDelivery = z.infer<typeof HomeDelivery>;

/** What makes the old home a worker of the new one: its worker.json, and the new home's record for its registry, none for a home it dials nothing to. */
export const Enrolment = z.object({ worker: WorkerFile, home: MachineRecord.optional() });
export type Enrolment = z.infer<typeof Enrolment>;

/**
 * home-moving.json on the machine the fleet leaves: this daemon may no longer start as a home that takes writes. `ask`: how it
 * learns the outcome itself; none where the new home has the only route, and delivers it. `enrol`: the outcome was `adopted`,
 * which the next start of this daemon finishes.
 */
export const HomeMoving = z.object({
  id: HomeMoveId, from: MachineId, fromName: z.string(), fromHome: MachinePath, to: MachineId, toName: z.string(), toHome: MachinePath, at: z.number(),
  ask: z.object({ ssh: SshDestination, svallBase: MachinePath, fleetHome: MachinePath }).optional(),
  enrol: Enrolment.optional(),
});
export type HomeMoving = z.infer<typeof HomeMoving>;

/** What the machine taking the fleet says of a move. `pending` never lets the old home thaw; `not-adopted` is final: it has refused the move for good. */
export const AdoptAnswer = z.discriminatedUnion('status', [
  z.object({ status: z.literal('adopted'), enrol: Enrolment }),
  // both sides have landed, and what the machine held of the move is gone
  z.object({ status: z.literal('done') }),
  z.object({ status: z.literal('pending'), phase: z.string(), detail: z.string().optional() }),
  z.object({ status: z.literal('not-adopted'), detail: z.string().optional() }),
]);
export type AdoptAnswer = z.infer<typeof AdoptAnswer>;

/** What the fleet's archive says of itself. `phone`: whether its link served, and who it let through, as `mobile.logins` empty means a login only that machine has. */
export const HomeManifest = z.object({
  id: HomeMoveId, fleetId: FleetId, from: MachineId, to: MachineId, toName: z.string(), toHome: MachinePath, record: MachineRecord,
  phone: z.object({ serving: z.boolean(), logins: z.array(z.string()) }), at: z.number(),
});
export type HomeManifest = z.infer<typeof HomeManifest>;

/** What a machine says of itself to a home move's check, none of it secret. */
export const HomeFacts = z.object({
  machineId: MachineId, role: z.enum(['home', 'worker']), fleetId: FleetId.optional(), release: z.string(), protocol: z.number().int(), stateSchema: z.number().int(),
  clock: z.number(), freeKb: z.number().optional(), home: MachinePath, svallBase: MachinePath, fleetHome: MachinePath, moving: z.string().optional(),
  tailscale: z.object({ host: z.string().optional(), owner: z.string().optional(), error: z.string().optional() }),
  paths: z.record(z.string(), z.boolean()).optional(),
});
export type HomeFacts = z.infer<typeof HomeFacts>;

/** What the sheet says will move: robots by where they run, and the mission control's that go first. */
export const HomeSheet = z.object({
  here: z.number().int(), there: z.number().int(), mission: z.array(z.object({ id: z.string(), name: z.string() })), toName: z.string(),
  rewrites: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })),
});
export type HomeSheet = z.infer<typeof HomeSheet>;

/** Mission control's robots that are not on the home: only a move of the home sends them away, and one that stopped leaves them there. */
export const crewAway = (s: Pick<FleetState, 'robots' | 'islands'>): FleetState['robots'][string][] => Object.values(s.robots).filter((r) => s.islands[r.islandId]?.kind === 'home' && r.machine !== undefined);

export type Relabel = {
  from: MachineId; fromName: string; fromHome?: string; to: MachineId; toName: string; toHome?: string; at: number;
  /** For the side about to run as a worker: its home's entry says a snapshot is held, which a start refuses a fleet's home without. Never for one about to start as a home, which would take itself for a worker's copy. */
  stamp?: true;
};

/**
 * The fleet as it reads once `to` is its home: what ran on the old home names it, what ran on the new one names nothing. Not
 * idempotent, as a second run reads the new home's robots as the old one's, so run it on the input alone.
 */
export function relabelHome(state: FleetState, o: Relabel): FleetState {
  const next = structuredClone(state);
  for (const r of Object.values(next.robots)) {
    if (r.machine === o.to) delete r.machine;
    else if (r.machine === undefined || r.machine === o.from) {
      r.machine = o.from;
      r.placement = { generation: r.placement?.generation ?? 0 };
    }
  }
  const machines = { ...next.machines };
  delete machines[o.to];
  machines[o.from] = { name: o.fromName, reachable: false, since: o.at, ...(o.fromHome && { home: o.fromHome }) };
  if (o.stamp) machines[o.to] = { name: o.toName, reachable: false, since: o.at, ...(o.toHome && { home: o.toHome }), snapshot: { version: 0, at: o.at } };
  next.machines = machines;
  return next;
}
