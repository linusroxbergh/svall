import { z } from 'zod';
import { FleetId, MachineId, MachinePath, ObjectName, Sha256 } from './ids.js';

export const MoveId = z.string().regex(/^mv_[0-9a-z]{10}$/);
export const MovePhase = z.enum(['rest', 'bundle', 'prepare', 'commit', 'activate', 'release', 'done', 'aborted']);
export type MovePhase = z.infer<typeof MovePhase>;

/** One check a move fails: its sentence, its action and the command the action runs there. */
export const Blocker = z.object({ reason: z.string(), action: z.string(), run: z.string().optional() });
export type Blocker = z.infer<typeof Blocker>;
/** Why a move cannot happen: the first check that failed, with `more` every other, each with its own action. */
export const Refusal = Blocker.extend({ details: z.array(z.string()), more: z.array(Blocker).optional() });
export type Refusal = z.infer<typeof Refusal>;

/** The actions of the refusals a move clears by interrupting: an agent at work, and a command running in a shell. */
export const INTERRUPT_ACTIONS = { agent: 'interrupt after this turn', command: 'move anyway and it ends' } as const;

/** The action of the refusal a move clears by leaving a shared main checkout for a new worktree at its HEAD. */
export const WORKTREE_ACTION = 'give it its own worktree';

/** The action of the refusal a move clears by upgrading the machine to this Mac's release. */
export const UPGRADE_ACTION = 'upgrade it under Machines';

// stays holds the sheet's phrases for what is left on this Mac: ".env stays here", "node_modules is not carried";
// converts.keep, that the main checkout keeps its `changed` files
export const MoveSheet = z.object({
  sessionBytes: z.number(), branch: z.string(), commits: z.number(), changedFiles: z.number(), untrackedFiles: z.number(),
  clone: z.enum(['warm', 'clone']), credentialFiles: z.array(z.string()), stays: z.array(z.string()), interrupts: z.boolean(), question: z.boolean(),
  converts: z.object({ main: z.string(), branch: z.string(), changed: z.number(), keep: z.literal(true).optional() }).optional(), notInRepo: z.boolean(),
});
export type MoveSheet = z.infer<typeof MoveSheet>;

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
  const leaves = `it leaves ${main}'s main checkout for a new branch ${c.branch}`;
  if (!c.changed) return leaves;
  return c.keep
    ? `${leaves}; the checkout keeps its ${count(c.changed, 'changed file')}`
    : `your ${count(c.changed, 'changed file')} in ${main}'s main checkout ${c.changed === 1 ? 'moves' : 'move'} to a new branch ${c.branch}`;
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
 * toggles, whose `item` and `fields` a tick hands to `machines.consent`; `gap` what will not work there yet, by name;
 * `here`, on a variable's row, that this Mac has the variable to copy from.
 */
export const SetupRow = z.object({
  key: z.string(), status: z.enum(['ok', 'warn', 'skip']), detail: z.string(), action: z.string().optional(), run: z.string().optional(),
  forward: z.number().int().optional(), tick: z.object({ item: z.string(), fields: z.array(z.string()), on: z.boolean(), preview: z.array(z.string()) }).optional(),
  gap: z.object({ name: z.string(), what: z.string() }).optional(), here: z.literal(true).optional(),
});
export type SetupRow = z.infer<typeof SetupRow>;

type WayOn = Pick<SetupRow, 'tick' | 'run' | 'action'>;
/** Whether a setup row asks for the machine to be checked again, as one holding a copy it should not still does. */
export const checksAgain = (r: WayOn): boolean => /^check .+ again$/.test(r.action ?? '');
/** Whether a setup row's way on is to tick it here: not ticked, and no copy of it left there to check for first. */
export const toTick = (r: WayOn): boolean => r.tick !== undefined && !r.tick.on && !checksAgain(r);
/** Whether a setup row can be set up now: ticked from here, or its command run there. */
export const settable = (r: WayOn): boolean => toTick(r) || r.run !== undefined;
/** Whether there is anything to do about a setup row: set it up now, or its action; a list with none will not work there, not yet. */
export const wayOn = (r: WayOn): boolean => settable(r) || r.action !== undefined;

/** The one field of a program row's tick: that the machine does not need the program. */
export const NOT_NEEDED = 'skip';
/** Whether a setup row's tick says the machine does not need its program, rather than copies a key. */
export const notNeeded = (r: Pick<SetupRow, 'tick'>): boolean => r.tick?.fields.length === 1 && r.tick.fields[0] === NOT_NEEDED;
type Aside = Pick<SetupRow, 'key' | 'tick' | 'gap'>;
/** Whether a setup row stands aside from what will not work there yet: it runs only on a Mac, or you ticked that the machine does not need it. */
export const aside = (r: Aside): boolean => r.key.startsWith('maconly:') || (notNeeded(r) && r.tick!.on);
/** One line for the rows that stand aside, counted or by name: "2 run only on a Mac, and adlc is not needed there"; none when no row does. */
export function asideLine(rows: Aside[], named = false): string | undefined {
  const mac = rows.filter((r) => r.key.startsWith('maconly:'));
  const skipped = rows.filter((r) => aside(r) && !r.key.startsWith('maconly:'));
  const say = (rs: Aside[], one: string, many: string): string => `${named ? rs.map((r) => r.gap?.name ?? r.key).join(', ') : rs.length} ${rs.length === 1 ? one : many}`;
  const parts = [mac.length ? say(mac, 'runs only on a Mac', 'run only on a Mac') : '', skipped.length ? say(skipped, 'is not needed there', 'are not needed there') : ''].filter(Boolean);
  return parts.length ? parts.join(', and ') : undefined;
}
