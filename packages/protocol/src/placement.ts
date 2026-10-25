import { z } from 'zod';
import { FleetId, MachineId, MachinePath, ObjectName, Sha256 } from './ids.js';

export const MoveId = z.string().regex(/^mv_[0-9a-z]{10}$/);
export const MovePhase = z.enum(['rest', 'bundle', 'prepare', 'commit', 'activate', 'release', 'done', 'aborted']);
export type MovePhase = z.infer<typeof MovePhase>;

export const Refusal = z.object({ reason: z.string(), action: z.string(), run: z.string().optional(), details: z.array(z.string()) });
export type Refusal = z.infer<typeof Refusal>;

// stays holds the sheet's phrases for what is left on this Mac: ".env stays here", "node_modules is not carried"
export const MoveSheet = z.object({
  sessionBytes: z.number(), branch: z.string(), commits: z.number(), changedFiles: z.number(), untrackedFiles: z.number(),
  clone: z.enum(['warm', 'clone']), credentialFiles: z.array(z.string()), stays: z.array(z.string()), interrupts: z.boolean(), question: z.boolean(),
  converts: z.object({ main: z.string(), branch: z.string(), changed: z.number() }).optional(), notInRepo: z.boolean(),
});
export type MoveSheet = z.infer<typeof MoveSheet>;

export const Placement = z.object({ generation: z.number().int().nonnegative() });
export type Placement = z.infer<typeof Placement>;

export const Moving = z.object({ id: MoveId, to: MachineId, phase: MovePhase, error: z.string().optional() });
export type Moving = z.infer<typeof Moving>;

export const LeftBehind = z.object({ moveId: MoveId, machine: MachineId, path: MachinePath, branch: z.string(), branchSha: ObjectName, fingerprint: Sha256 });
export type LeftBehind = z.infer<typeof LeftBehind>;

export const MachineLink = z.object({ name: z.string(), reachable: z.boolean(), since: z.number(), release: z.string().optional() });
export type MachineLink = z.infer<typeof MachineLink>;

/** The robot fields only the machine running the robot writes. */
export const WORKER_OWNED = ['tmux', 'agent', 'unread', 'revive', 'resumeError', 'panePath', 'cwd', 'repo', 'second', 'shell', 'hint', 'codexDaemon'] as const;

/** A worker's fleet home: the home it serves, and the token that home proves itself with. */
export const WorkerFile = z.object({ homeMachineId: MachineId, fleetId: FleetId, token: z.string().min(32), homeName: z.string() });
export type WorkerFile = z.infer<typeof WorkerFile>;
