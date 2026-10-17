import type { Blocker, HandoverChoices, HandoverEntityKind, HandoverPhase, MachineId, ManifestSummary, Warning } from './handover.js';

// what the handover helper prints as NDJSON and the app reads: `svall handover --json`, its status and its replay

/** What the user may do about a transaction that stopped part way. */
export type SafeAction = 'resume' | 'abort';

/** One character as its destination brought it up; `notice` is what one that came up still waits on in its terminal. */
export type CharacterResult = { id: string; ok: boolean; error?: string; notice?: string };

/**
 * How a run ended. `complete`: the fleet runs on the destination, `pending` naming what a resume still finishes and `error` why.
 * `blocked` and `aborted`: nothing committed and the fleet is the source's again. `interrupted`: it stopped part
 * way, and `safe` says what may follow. `detached`: cancelled after the commit, so the move goes on unwatched.
 * `none`: there was no handover to resume or abort.
 */
export type Outcome =
  | { status: 'complete'; transactionId: string; generation: number; characters: CharacterResult[]; pending?: ('source' | 'gateway')[]; error?: string }
  | { status: 'none'; reason: string }
  | { status: 'blocked'; transactionId?: string; phase: HandoverPhase; blockers: Blocker[] }
  | { status: 'aborted'; transactionId?: string; phase: HandoverPhase }
  | { status: 'interrupted'; transactionId?: string; phase: HandoverPhase; error: string; safe: SafeAction[] }
  | { status: 'detached'; transactionId: string };

/**
 * Where a handover stands by the gateway's word. `open`: nothing has committed. `committed`: the fleet is the
 * destination's and the transaction is open. `moved`: the gateway has cleared it after the commit. `returned`:
 * the gateway no longer holds it and the fleet is still the source's. `none`: nothing began.
 */
export type Standing = 'none' | 'open' | 'committed' | 'moved' | 'returned' | 'superseded' | 'unknown';

/**
 * What a handover's journals say together, and the one way on: `continue` runs it forward from where it is,
 * `finish` completes what a moved fleet left open, `finish-abort` lets go what an abort the gateway made left.
 */
export type Verdict = {
  standing: Standing;
  transactionId?: string;
  generation?: number;
  fromMachineId?: MachineId;
  toMachineId?: MachineId;
  phase?: HandoverPhase;
  journals: { source?: HandoverPhase; destination?: HandoverPhase };
  safe: SafeAction[];
  action: 'none' | 'continue' | 'finish' | 'finish-abort';
  reason: string;
};

/** How far one character, root or session row has come, and why it stopped; `archivedTo`: where what a root held before went. */
export type EntityData = {
  transactionId: string; kind: HandoverEntityKind; id: string; phase: HandoverPhase;
  done?: number; total?: number; bytes?: number; totalBytes?: number; error?: string; notice?: string; archivedTo?: string;
};

/** What a blocker or a row points at, for a person: each character's name, where each root lands, and whose each session row `s<i>` is. */
export type Names = { characters: Record<string, string>; roots: Record<string, string>; sessions?: Record<string, string> };

/** One line of what a handover tells whoever watches it. */
export type HandoverEvent =
  | { event: 'handover.preflight'; data: { summary: ManifestSummary; blockers: Blocker[]; warnings: Warning[]; names?: Names } }
  | { event: 'handover.changed'; data: { transactionId: string; phase: HandoverPhase } }
  | { event: 'handover.entity'; data: EntityData }
  // a step that asks the user before it goes on, or before the handover is aborted; `choices`: what the run holds, which an answer builds on
  | { event: 'handover.blocked'; data: { transactionId?: string; phase: HandoverPhase; blockers: Blocker[]; choices?: HandoverChoices } }
  // a call that did not answer and is asked again
  | { event: 'handover.retry'; data: { transactionId?: string; phase: HandoverPhase; attempt: number; error: string } }
  | { event: 'handover.result'; data: Outcome }
  // where the journals leave the handover, and the helper still running it, if one is
  | { event: 'handover.status'; data: Verdict & { helper?: { pid: number } } }
  // the only line a launcher prints: the helper it left running
  | { event: 'handover.detached'; data: { pid: number } };
