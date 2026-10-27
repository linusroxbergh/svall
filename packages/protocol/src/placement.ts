import { z } from 'zod';
import { FleetId, MachineId, MachinePath, ObjectName, Sha256 } from './ids.js';

export const MoveId = z.string().regex(/^mv_[0-9a-z]{10}$/);
export const MovePhase = z.enum(['rest', 'bundle', 'prepare', 'commit', 'activate', 'release', 'done', 'aborted']);
export type MovePhase = z.infer<typeof MovePhase>;

export const Refusal = z.object({ reason: z.string(), action: z.string(), run: z.string().optional(), details: z.array(z.string()) });
export type Refusal = z.infer<typeof Refusal>;

/** The actions of the refusals a move clears by interrupting: an agent at work, and a command running in a shell. */
export const INTERRUPT_ACTIONS = { agent: 'interrupt after this turn', command: 'move anyway and it ends' } as const;

/** The action of the refusal a move clears by leaving a shared main checkout for a new worktree at its HEAD. */
export const WORKTREE_ACTION = 'give it its own worktree';

// stays holds the sheet's phrases for what is left on this Mac: ".env stays here", "node_modules is not carried";
// converts.keep, that the main checkout keeps its `changed` files
export const MoveSheet = z.object({
  sessionBytes: z.number(), branch: z.string(), commits: z.number(), changedFiles: z.number(), untrackedFiles: z.number(),
  clone: z.enum(['warm', 'clone']), credentialFiles: z.array(z.string()), stays: z.array(z.string()), interrupts: z.boolean(), question: z.boolean(),
  converts: z.object({ main: z.string(), branch: z.string(), changed: z.number(), keep: z.literal(true).optional() }).optional(), notInRepo: z.boolean(),
});
export type MoveSheet = z.infer<typeof MoveSheet>;

// in thousands, as the sheet counts them, to the whole unit
function size(n: number): string {
  const kb = Math.round(n / 1000);
  return kb < 1000 ? `${Math.max(1, kb)} KB` : `${Math.round(n / 1_000_000)} MB`;
}
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p;

/** What a move carries, as one line: "session 4 MB · branch kanban: 2 commits not on origin, 3 changed files · …"; `repo` names the repository. */
export function moveSummary(s: MoveSheet, repo: string | undefined, machine: string): string {
  const changed = s.changedFiles + s.untrackedFiles;
  const carried = [...(s.commits ? [`${count(s.commits, 'commit')} not on origin`] : []), ...(changed ? [count(changed, 'changed file')] : [])];
  return [
    ...(s.sessionBytes ? [`session ${size(s.sessionBytes)}`] : []),
    s.notInRepo ? 'in no repository: it moves with its session only' : `branch ${s.branch}${carried.length ? `: ${carried.join(', ')}` : ''}`,
    ...(repo && !s.notInRepo ? [`${repo} on ${machine}: ${s.clone === 'clone' ? 'will clone (first time)' : 'cloned already'}`] : []),
    ...s.stays,
  ].join(' · ');
}

/** What becomes of a main checkout the move converts into a worktree. */
export function convertLine(c: NonNullable<MoveSheet['converts']>): string {
  const main = base(c.main);
  if (c.keep) return `it leaves ${main}'s main checkout for a new branch ${c.branch}${c.changed ? `; the checkout keeps its ${count(c.changed, 'changed file')}` : ''}`;
  return c.changed
    ? `your ${count(c.changed, 'changed file')} in ${main}'s main checkout ${c.changed === 1 ? 'moves' : 'move'} to a new branch ${c.branch}`
    : `it leaves ${main}'s main checkout for a new branch ${c.branch}`;
}

export const Placement = z.object({ generation: z.number().int().nonnegative() });
export type Placement = z.infer<typeof Placement>;

export const Moving = z.object({ id: MoveId, to: MachineId, phase: MovePhase, error: z.string().optional() });
export type Moving = z.infer<typeof Moving>;

export const LeftBehind = z.object({ moveId: MoveId, machine: MachineId, path: MachinePath, branch: z.string(), branchSha: ObjectName, fingerprint: Sha256 });
export type LeftBehind = z.infer<typeof LeftBehind>;

// mismatch: linked on a state schema or link protocol this home cannot read, so nothing but pings passes; home: the machine's
// user folder; replayed: the last of its outbox the home applied; snapshot: on a worker, the home's snapshot it last took
export const MachineLink = z.object({
  name: z.string(), reachable: z.boolean(), since: z.number(), release: z.string().optional(), mismatch: z.literal(true).optional(), home: z.string().optional(),
  replayed: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }).optional(), snapshot: z.object({ version: z.number().int(), at: z.number() }).optional(),
});
export type MachineLink = z.infer<typeof MachineLink>;

/** The robot fields only the machine running the robot writes. */
export const WORKER_OWNED = ['tmux', 'agent', 'unread', 'revive', 'resumeError', 'panePath', 'cwd', 'repo', 'second', 'shell', 'hint', 'codexDaemon'] as const;

/** A worker's fleet home: the home it serves, and the token that home proves itself with. */
export const WorkerFile = z.object({ homeMachineId: MachineId, fleetId: FleetId, token: z.string().min(32), homeName: z.string() });
export type WorkerFile = z.infer<typeof WorkerFile>;

/**
 * One line of a machine's setup: how a thing stands there, and what to do when it is not right; `tick` the consent it
 * toggles, whose `item` and `fields` a tick hands to `machines.consent`.
 */
export const SetupRow = z.object({
  key: z.string(), status: z.enum(['ok', 'warn', 'skip']), detail: z.string(), action: z.string().optional(), run: z.string().optional(),
  forward: z.number().int().optional(), tick: z.object({ item: z.string(), fields: z.array(z.string()), on: z.boolean(), preview: z.array(z.string()) }).optional(),
});
export type SetupRow = z.infer<typeof SetupRow>;
