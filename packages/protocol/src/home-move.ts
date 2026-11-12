import { z } from 'zod';
import { FleetId, MachineId, MachinePath, SshDestination } from './ids.js';
import { MachineRecord } from './machines.js';
import { WorkerFile } from './placement.js';
import type { FleetState } from './state.js';

export const HomeMoveId = z.string().regex(/^hm_[0-9a-z]{10}$/);
export type HomeMoveId = z.infer<typeof HomeMoveId>;

/** How the machine taking the fleet reaches the old home, which has no route to it: on disk from before that home's mark until it has heard how the move ended. `from`, `fleetId`: what that home must answer as before any key goes to it. */
export const HomeDelivery = z.object({ id: HomeMoveId, ssh: SshDestination, svallBase: MachinePath, fleetHome: MachinePath, from: MachineId, fleetId: FleetId });
export type HomeDelivery = z.infer<typeof HomeDelivery>;

/** What makes the old home a worker of the new one: its worker.json, and the new home's record for its registry, none for a home it dials nothing to. */
export const Enrolment = z.object({ worker: WorkerFile, home: MachineRecord.optional() });
export type Enrolment = z.infer<typeof Enrolment>;

/**
 * home-moving.json on the machine the fleet leaves: this daemon may no longer start as a home that takes writes. `ask`: how it
 * learns the outcome itself; none where the new home has the only route, and delivers it. `enrol`: the outcome was `adopted`,
 * which the next start of this daemon finishes. `keySha256`: of the key only the move's driver holds, which every outcome sent here carries.
 * `to`, `fleetId`: all this home believes; any other machine or fleet that answers reads as no answer.
 */
export const HomeMoving = z.object({
  id: HomeMoveId, fleetId: FleetId, from: MachineId, fromName: z.string(), fromHome: MachinePath, to: MachineId, toName: z.string(), toHome: MachinePath, at: z.number(),
  keySha256: z.string().regex(/^[0-9a-f]{64}$/),
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

/** A worker a home move carries: its record, and the fleet's profile on it. */
export const HomeWorker = z.object({ id: MachineId, record: MachineRecord, profile: z.string().optional() });
export type HomeWorker = z.infer<typeof HomeWorker>;

/** What the machine that would take the fleet finds of a worker, over its own ssh: `ssh`, the route it took; `raw`, what ssh or the far command said. */
export const HomeReach = z.object({ ok: z.boolean(), ssh: z.string(), kind: z.enum(['auth', 'host_key', 'unreachable', 'release', 'machine', 'fleet', 'name', 'other']).optional(), why: z.string().optional(), raw: z.string().optional() });
export type HomeReach = z.infer<typeof HomeReach>;

/** What the fleet's archive says of itself. `phone`: whether its link served, and who it let through, as `mobile.logins` empty means a login only that machine has. */
export const HomeManifest = z.object({
  id: HomeMoveId, fleetId: FleetId, from: MachineId, to: MachineId, toName: z.string(), toHome: MachinePath, record: MachineRecord,
  phone: z.object({ serving: z.boolean(), logins: z.array(z.string()) }),
  // the fleet's profile on the old home, which the new one reaches it as once it is a worker
  fromProfile: z.string().optional(),
  // the fleet's folder on the old home, whose mission control folder becomes the new home's fleet's
  fromFleetHome: MachinePath.optional(),
  // of the key only the move's driver holds, sent once the old home is marked: without it this machine installs nothing
  adoptKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
  // the other workers the new home re-enrols once it has taken the fleet
  workers: z.array(HomeWorker).optional(),
});
export type HomeManifest = z.infer<typeof HomeManifest>;

/** A path in fleet.json that goes in as `~/…` for the new home to read as its own; `lacks`: that machine says it has nothing there. */
// `kept`: written as ~/… already, so it names the same place there, which the sheet names only while that machine lacks it
const HomeRewrite = z.object({ key: z.string(), to: z.string(), lacks: z.boolean().optional(), kept: z.literal(true).optional() });

/**
 * What a machine says of itself to a home move's check, none of it secret. `tailscale.state`: how Tailscale stands there, and `error` what it said. `workers`: those its fleet holds a token for and its registry lists, none said where it
 * cannot read them. `paths`: whether each path it was asked of is there. `fleetKb`, `rewrites`: a home's, what a move of its fleet carries and which paths change.
 */
export const HomeFacts = z.object({
  machineId: MachineId, fleetId: FleetId.optional(), release: z.string(), protocol: z.number().int(), stateSchema: z.number().int(),
  clock: z.number(), freeKb: z.number().optional(), fleetKb: z.number().optional(), fleetHome: MachinePath, moving: z.string().optional(),
  // `stopped`: how a far side of an earlier release says it, with no `state`
  tailscale: z.object({ host: z.string().optional(), state: z.enum(['missing', 'stopped', 'signedOut', 'ok']).optional(), error: z.string().optional(), stopped: z.literal(true).optional() }),
  paths: z.record(z.string(), z.boolean()).optional(), workers: z.array(z.string()).optional(), rewrites: z.array(HomeRewrite).optional(),
  // on a home: the workers a move would carry, as what takes the fleet comes back has no registry of its own for them
  carried: z.array(HomeWorker).optional(),
  // on a home: a worker is being enrolled there, which its freeze would refuse
  enrolling: z.literal(true).optional(),
});
export type HomeFacts = z.infer<typeof HomeFacts>;

/** What the sheet says will move: robots by where they run, and the mission control's that go first. */
export const HomeSheet = z.object({
  here: z.number().int(), there: z.number().int(), mission: z.array(z.object({ id: z.string(), name: z.string() })),
  rewrites: z.array(HomeRewrite),
  // the workers that do not answer: each joins the new home when it does
  waits: z.array(z.object({ id: MachineId, name: z.string() })).optional(),
  // the move carries workers besides the two machines, which it joins to the new home as its last step
  carries: z.literal(true).optional(),
});
export type HomeSheet = z.infer<typeof HomeSheet>;

// where the machine taking the fleet says a move stands, for a person who has not followed it
const STANDS: Record<string, (name: string) => string> = {
  unreachable: (n) => `${n} does not answer; the move waits until it does.`,
  unknown: (n) => `${n} cannot say how the move went; the move waits until it can.`,
  staging: (n) => `${n} has not received the fleet's files yet.`,
  staged: (n) => `${n} holds the fleet's files and has not taken over.`,
  installed: (n) => `${n} has the fleet's files in place and is starting as its home.`,
  stopping: (n) => `${n} went back as it was and has not started again.`,
  rolledback: (n) => `${n} tried to take over and went back as it was.`,
  adopted: (n) => `${n} has taken over.`,
  done: (n) => `${n} has taken over.`,
};
/** Where a home move stands at `phase`, as a sentence on `name`, the machine taking the fleet. */
export const homeMoveStands = (phase: string, name: string): string => (Object.hasOwn(STANDS, phase) ? STANDS[phase](name) : `${name} is at work on the move.`);

/** Mission control's robots a home move sent ahead that stopped, and left away from the home. */
export const crewAway = (s: Pick<FleetState, 'robots' | 'islands'>): FleetState['robots'][string][] => Object.values(s.robots).filter((r) => s.islands[r.islandId]?.kind === 'home' && r.machine !== undefined && r.sentAhead !== undefined);

type Relabel = {
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
    delete r.sentAhead;
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
