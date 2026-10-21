import {
  HANDOVER_PHASES,
  type Blocker, type EntityData, type HandoverChoices, type HandoverEntityKind, type HandoverEvent, type HandoverPhase, type ManifestSummary, type Names, type Outcome, type SafeAction, type Verdict, type Warning,
} from '@svall/protocol';
import { machineName, withoutTokens } from './host.js';

// what `svall handover --json` prints
export type { CharacterResult, EntityData, HandoverEvent, Names, Outcome, SafeAction, Standing, Verdict } from '@svall/protocol';

export type SectionId = 'checks' | 'rest' | 'transfer' | 'verify' | 'commit' | 'resume';
// Abort is possible up to the commit, which has a section of its own
export const SECTIONS: { id: SectionId; label: string; phases: HandoverPhase[] }[] = [
  { id: 'checks', label: 'Checks', phases: ['begin'] },
  { id: 'rest', label: 'Resting characters', phases: ['freeze'] },
  { id: 'transfer', label: 'Transferring files and sessions', phases: ['transfer'] },
  { id: 'verify', label: 'Verifying', phases: ['verify', 'prepare', 'ready'] },
  { id: 'commit', label: 'Committing', phases: ['commit'] },
  { id: 'resume', label: 'Resuming characters', phases: ['activate', 'complete'] },
];
export type SectionState = 'pending' | 'active' | 'waiting' | 'done' | 'stopped';

type Progress = { done?: number; total?: number; bytes?: number; totalBytes?: number; error?: string; notice?: string; archivedTo?: string; verified?: boolean };
export type Row = Progress & { section: SectionId; kind: HandoverEntityKind; id: string; phase: HandoverPhase };

/** One handover as the sheet follows it: what the helper has said so far, and what the user chose. */
export type HandoverRun = {
  // the destination the page started it towards: `local` or the gateway's name; absent when rebuilt
  to?: string;
  // a helper process the page is watching is still running
  following: boolean;
  transactionId?: string;
  // the furthest step reached; `aborting` once an abort has begun letting go
  phase?: HandoverPhase;
  aborting?: boolean;
  preflight?: { summary: ManifestSummary; blockers: Blocker[]; warnings: Warning[]; names?: Names };
  // a step that waits for the user's choose or cancel
  decision?: { phase: HandoverPhase; blockers: Blocker[] };
  rows: Row[];
  retry?: { phase: HandoverPhase; attempt: number; error: string };
  result?: Outcome;
  status?: Verdict;
  // the shell could not run or follow the helper
  error?: string;
  choices: HandoverChoices;
  cancelled?: boolean;
  // the fleet has moved and the page has not yet loaded it from its new owner
  awaitingOwner: boolean;
  // the sheet resumed it by itself, since past the commit nothing else was safe
  goingOn?: boolean;
  // the sheet asked where the handover stands, and nothing has answered yet
  checking?: boolean;
};

const step = (p: HandoverPhase): number => (p === 'aborted' ? -1 : HANDOVER_PHASES.indexOf(p));
const sectionAt = (p: HandoverPhase): number => Math.max(0, SECTIONS.findIndex((s) => s.phases.includes(p)));

export const followRun = (to?: string, choices: HandoverChoices = {}): HandoverRun => ({ to, following: true, rows: [], choices, awaitingOwner: false });

const sectionOf = (kind: HandoverEntityKind, phase: HandoverPhase): SectionId =>
  kind !== 'character' ? 'transfer' : phase === 'activate' || phase === 'complete' ? 'resume' : 'rest';

function withEntity(rows: Row[], e: EntityData): Row[] {
  const section = sectionOf(e.kind, e.phase);
  const at = rows.findIndex((r) => r.section === section && r.kind === e.kind && r.id === e.id);
  const row: Row = {
    section, kind: e.kind, id: e.id, phase: e.phase, done: e.done, total: e.total, bytes: e.bytes, totalBytes: e.totalBytes,
    ...(e.error && { error: withoutTokens(e.error) }), ...(e.notice && { notice: withoutTokens(e.notice) }), ...(e.archivedTo && { archivedTo: e.archivedTo }),
    ...(e.verified && { verified: true }),
  };
  return at < 0 ? [...rows, row] : rows.map((r, i) => (i === at ? row : r));
}

const scrubbed = (blockers: Blocker[]): Blocker[] => blockers.map((b) => ({ ...b, message: withoutTokens(b.message) }));

type Fields = Record<string, unknown>;
const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const optional = (v: unknown, is: (v: unknown) => boolean): boolean => v === undefined || is(v);
const isNumber = (v: unknown): boolean => typeof v === 'number';
const isPhase = (v: unknown): boolean => (HANDOVER_PHASES as readonly unknown[]).includes(v);
const isEach = (v: unknown, is: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(is);
const isIssue = (v: unknown): boolean => isObject(v) && isString(v.code) && isString(v.message)
  && optional(v.entity, (e) => isObject(e) && isString(e.kind) && isString(e.id));
const isSafe = (v: unknown): boolean => isEach(v, isString);

function isOutcome(d: Fields): boolean {
  switch (d.status) {
    case 'complete': return isEach(d.characters, (c) => isObject(c) && isString(c.id) && typeof c.ok === 'boolean' && optional(c.error, isString) && optional(c.notice, isString))
      && optional(d.pending, isSafe) && optional(d.error, isString);
    case 'none': return isString(d.reason);
    case 'blocked': return isPhase(d.phase) && isEach(d.blockers, isIssue);
    case 'aborted': return isPhase(d.phase);
    case 'interrupted': return isPhase(d.phase) && isString(d.error) && isSafe(d.safe);
    case 'detached': return isString(d.transactionId);
    default: return false;
  }
}

/** Whether a line carries every field the sheet reads from it; an older release's line or a newer helper's may not. */
export function readable(e: unknown): e is HandoverEvent {
  if (!isObject(e) || !isObject(e.data)) return false;
  const d = e.data;
  switch (e.event) {
    case 'handover.preflight':
      return isObject(d.summary) && ['roots', 'files', 'bytes', 'sessions'].every((k) => isNumber((d.summary as Fields)[k]))
        && isEach(d.blockers, isIssue) && isEach(d.warnings, isIssue)
        && optional(d.names, (n) => isObject(n) && isObject(n.characters) && isObject(n.roots) && optional(n.sessions, isObject));
    case 'handover.changed': return isPhase(d.phase) && optional(d.transactionId, isString);
    case 'handover.entity':
      return isString(d.kind) && isString(d.id) && isPhase(d.phase) && ['done', 'total', 'bytes', 'totalBytes'].every((k) => optional(d[k], isNumber))
        && optional(d.error, isString) && optional(d.notice, isString) && optional(d.archivedTo, isString) && optional(d.verified, (v) => typeof v === 'boolean');
    case 'handover.blocked': return isPhase(d.phase) && isEach(d.blockers, isIssue) && optional(d.choices, isObject);
    case 'handover.retry': return isPhase(d.phase) && isNumber(d.attempt) && isString(d.error);
    case 'handover.result': return isOutcome(d);
    case 'handover.status': return isString(d.standing) && isSafe(d.safe) && isString(d.reason) && optional(d.phase, isPhase);
    case 'handover.detached': return true;
    default: return false;
  }
}

/** Folds one line the helper printed onto the run it belongs to; a line it cannot read leaves the run as it was. */
export function applyEvent(run: HandoverRun, e: HandoverEvent): HandoverRun {
  if (!readable(e)) return run;
  const tx = 'transactionId' in e.data && typeof e.data.transactionId === 'string' ? e.data.transactionId : undefined;
  // the controller goes on from a decision only once it is answered; a daemon's relayed row can trail the decision
  // a line after the status the sheet asked for is the run that status found, which need not go where the start did
  const next: HandoverRun = {
    ...run, checking: undefined, ...(run.checking && { to: undefined }), transactionId: run.transactionId ?? tx, ...(e.event === 'handover.changed' && { decision: undefined }),
  };
  switch (e.event) {
    case 'handover.preflight':
      return { ...next, preflight: { summary: e.data.summary, blockers: scrubbed(e.data.blockers), warnings: scrubbed(e.data.warnings), ...(e.data.names && { names: e.data.names }) } };
    case 'handover.changed': {
      const { phase } = e.data;
      if (phase === 'aborted') return { ...next, aborting: true, retry: undefined };
      const furthest = next.phase && step(next.phase) >= step(phase) ? next.phase : phase;
      return { ...next, phase: furthest, retry: undefined };
    }
    case 'handover.entity':
      return { ...next, rows: withEntity(next.rows, e.data) };
    case 'handover.blocked':
      // an answer starts from the choices the run holds, which a sheet relaunched after the start never saw
      return { ...next, decision: { phase: e.data.phase, blockers: scrubbed(e.data.blockers) }, ...(e.data.choices && { choices: e.data.choices }) };
    case 'handover.retry':
      return { ...next, retry: { ...e.data, error: withoutTokens(e.data.error) } };
    case 'handover.result': {
      const data = e.data.status === 'interrupted' ? { ...e.data, error: withoutTokens(e.data.error) }
        : e.data.status === 'blocked' ? { ...e.data, blockers: scrubbed(e.data.blockers) } : e.data;
      return { ...next, result: data, decision: undefined, retry: undefined, awaitingOwner: data.status === 'complete' };
    }
    case 'handover.status':
      return { ...next, status: { ...e.data, reason: withoutTokens(e.data.reason) }, decision: undefined, awaitingOwner: false };
    case 'handover.detached':
      return next;
  }
}

/** The helper process the page was watching has ended. */
export const endFollow = (run: HandoverRun, code: number, error?: string): HandoverRun =>
  ({ ...run, following: false, checking: undefined, ...(error ? { error: withoutTokens(error) } : code !== 0 && !run.result && !run.status ? { error: `the helper exited with code ${code}` } : {}) });

const live = (run: HandoverRun): boolean => run.following && !run.result && !run.status;

export const decisionPending = (run: HandoverRun | undefined): boolean => !!run && live(run) && !!run.decision;

/** A standing the user has something to do about: a step that may follow, or a journal only Forget clears. */
export const needsUser = (v: Verdict): boolean => v.safe.length > 0 || v.standing === 'superseded';

/** A run that stopped sending its commit without hearing whether the gateway took it: only the gateway can say, and nothing is safe until it does. */
const commitUnknown = (r: Outcome | undefined): boolean => r?.status === 'interrupted' && r.phase === 'commit' && r.safe.length === 0;

// blockers that mean another handover of this fleet may be open, which only `handover status` can say what to do about
const OPEN_ELSEWHERE: string[] = ['transaction_open', 'generation_mismatch', 'identity_mismatch'];

/**
 * A run whose status the sheet then reads: the checks stopped it for a handover that may already be open, or a resume or
 * abort found nothing safe, which its error says in the controller's ids.
 */
export function asksStatus(run: HandoverRun | undefined): boolean {
  if (!run || run.following || run.status || run.checking) return false;
  const r = run.result;
  return r?.status === 'blocked' ? r.blockers.some((b) => OPEN_ELSEWHERE.includes(b.code)) : r?.status === 'interrupted' && !r.safe.length && !commitUnknown(r);
}

/** A blocker the status has answered, whose message names the ids and generations the sheet leaves out. */
export const answered = (run: HandoverRun, b: Blocker): boolean => !!run.status && OPEN_ELSEWHERE.includes(b.code);

/** The status the sheet goes by: one that finds nothing open leaves a run the checks stopped to its blockers. */
export const verdictOf = (run: HandoverRun): Verdict | undefined =>
  (run.status?.standing === 'none' && !run.status.safe.length && run.result?.status === 'blocked' ? undefined : run.status);

/**
 * Past the commit, a status or a stopped run that leaves only resuming, which the sheet then does without asking, once
 * per run it rebuilds or follows.
 */
export function goesOnByItself(run: HandoverRun | undefined): boolean {
  if (!run || run.following || run.goingOn) return false;
  const only = (safe: SafeAction[]) => safe.length === 1 && safe[0] === 'resume';
  const s = run.status;
  if (s) return (s.standing === 'committed' || s.standing === 'moved') && only(s.safe);
  return run.result?.status === 'interrupted' && only(run.result.safe) && isCommitted(run);
}

/** The run a resume the sheet started by itself follows: what it goes on from, at the furthest step reached. */
export function goOn(run: HandoverRun): HandoverRun {
  const at = run.status?.phase ?? (run.result && 'phase' in run.result ? run.result.phase : undefined);
  const phase = at && (!run.phase || step(at) > step(run.phase)) ? at : run.phase;
  return { ...run, following: true, goingOn: true, phase, status: undefined, result: undefined, error: undefined, decision: undefined, retry: undefined, cancelled: undefined, aborting: undefined };
}

/** `svall` as typed for a window's fleet: with `-p <profile>` for any home but the private one, as the shell's own calls are. */
export const svallFor = (fleetHome: string | undefined): string => {
  const profile = fleetHome && /^\/(?:Users|home)\/[^/]+\/\.svall-([^/]+)$/.exec(fleetHome)?.[1];
  return profile ? `svall -p ${profile}` : 'svall';
};

/** The way on from a terminal where the sheet has none, as handover.md gives it; commands stand between backticks. */
export function wayOut(run: HandoverRun, svall = 'svall'): string | undefined {
  const s = verdictOf(run);
  if (s?.standing === 'superseded') {
    return `\`${svall} handover status\` says where the fleet stands now. Forget is enough when another handover or a recovery moved it on; `
      + `if the gateway was set up again, \`${svall} fleet recover --force-owner local\` then makes this Mac the fleet's owner.`;
  }
  if (s ? s.standing === 'unknown' : commitUnknown(run.result)) {
    return `Once the gateway answers, \`${svall} handover status\` in a terminal says what is safe. If it is gone for good, `
      + `\`${svall} fleet recover --force-owner local --gateway <machine>\` makes this Mac the fleet's owner, with another of your machines as its gateway.`;
  }
  return undefined;
}

/** Past the commit: the fleet is the destination's, and only going on is left. */
export function isCommitted(run: HandoverRun): boolean {
  if (run.status) return run.status.standing === 'committed' || run.status.standing === 'moved';
  const r = run.result;
  if (r?.status === 'complete' || r?.status === 'detached') return true;
  if (r?.status === 'interrupted') return step(r.phase) >= step('commit') && !r.safe.includes('abort') && !commitUnknown(r);
  return run.goingOn || (!!run.phase && step(run.phase) >= step('activate'));
}

/**
 * Where a handover goes: `local` or the gateway's name. A sheet relaunched after the start rebuilds a run that never
 * said, and a handover runs only between this Mac and its gateway, so `owner`, where the fleet runs now, names it:
 * the other end before the commit, that end after it.
 */
export function destinationOf(run: HandoverRun, owner: string | undefined, gateway: string | undefined): string | undefined {
  if (run.to || !gateway || (owner !== 'local' && owner !== gateway)) return run.to;
  const s = run.status?.standing;
  if (s === 'unknown' || s === 'superseded') return undefined;
  const landed = s === 'none' ? run.result?.status === 'complete' : isCommitted(run);
  return landed ? owner : owner === 'local' ? gateway : 'local';
}

/** Where the sheet stands, section by section. */
export function sectionStates(run: HandoverRun): { id: SectionId; label: string; state: SectionState }[] {
  const r = run.result;
  const phase = r && 'phase' in r ? r.phase : run.status?.phase ?? run.phase;
  const finished = r?.status === 'complete' || run.status?.standing === 'moved';
  const at = phase && phase !== 'aborted' ? sectionAt(phase) : phase === 'aborted' ? sectionAt(run.phase ?? 'begin') : run.preflight ? 0 : -1;
  const here: SectionState = decisionPending(run) || r?.status === 'blocked' ? 'waiting' : live(run) ? 'active' : 'stopped';
  return SECTIONS.map((s, i) => ({
    id: s.id, label: s.label,
    state: finished || i < at ? 'done' : i === at ? (r?.status === 'detached' ? 'active' : here) : 'pending',
  }));
}

/** The blockers a section shows: the decision waiting in it, or what stopped the run there. */
export function blockersIn(run: HandoverRun, id: SectionId): Blocker[] {
  const here = (p: HandoverPhase) => SECTIONS[sectionAt(p)].id === id;
  if (run.decision && here(run.decision.phase)) return run.decision.blockers;
  return run.result?.status === 'blocked' && here(run.result.phase) ? run.result.blockers : [];
}

/** What the corner's Handover control says about the run: waiting on the user, under way, or stopped part way. */
export function badgeOf(run: HandoverRun | undefined): 'waiting' | 'live' | 'stopped' | undefined {
  if (!run) return undefined;
  if (decisionPending(run)) return 'waiting';
  if (live(run) && (run.phase || run.preflight)) return 'live';
  const a = actionsOf(run);
  return a.resume || a.abort || a.forget ? 'stopped' : undefined;
}

export type Actions = {
  // live, before the commit: Abort is a cancel sent to the helper
  cancel: boolean;
  // not live: what `--resume` does is named by which side of the commit it is on
  resume?: 'Resume' | 'Retry';
  abort: boolean;
  // a journal the gateway has moved on from, which only this Mac still holds
  forget: boolean;
  tryAgain: boolean;
  start: boolean;
  // look again: the move may be going on without this window watching
  follow: boolean;
};

/** What the sheet offers from here; never a way back once the commit has begun. */
export function actionsOf(run: HandoverRun | undefined): Actions {
  const none: Actions = { cancel: false, abort: false, forget: false, tryAgain: false, start: false, follow: false };
  if (!run) return { ...none, start: true };
  if (live(run)) {
    const begun = run.phase !== undefined || run.preflight !== undefined;
    return { ...none, cancel: begun && !run.cancelled && !run.aborting && (!run.phase || step(run.phase) < step('commit')) };
  }
  if (run.following) return none;
  const resume = (safe: SafeAction[]) => (safe.includes('resume') ? (isCommitted(run) ? 'Retry' as const : 'Resume' as const) : undefined);
  const s = verdictOf(run);
  if (s) {
    return {
      ...none, resume: resume(s.safe), abort: s.safe.includes('abort'), forget: s.standing === 'superseded',
      start: ['none', 'moved', 'returned'].includes(s.standing), follow: s.standing === 'unknown',
    };
  }
  const r = run.result;
  switch (r?.status) {
    case 'complete': return { ...none, resume: r.pending?.length ? 'Retry' : undefined, start: !r.pending?.length };
    case 'blocked': return { ...none, tryAgain: !!run.to, start: true };
    case 'aborted': case 'none': return { ...none, start: true };
    case 'interrupted': return { ...none, resume: resume(r.safe), abort: r.safe.includes('abort'), follow: r.safe.length === 0 };
    case 'detached': return { ...none, follow: true };
    // a resume the sheet started by itself that never said how it went is still the only way on
    default: return run.goingOn ? { ...none, resume: 'Retry' } : { ...none, start: true, follow: !!run.error };
  }
}

/**
 * Terminals wait from the source's freeze until the fleet runs again: on the source after an abort or a
 * blocker, or on the destination once the page has reached it.
 */
export function holdsTerminals(run: HandoverRun | undefined): boolean {
  if (!run) return false;
  if (run.awaitingOwner) return true;
  const s = run.status;
  if (s) return s.standing === 'committed' || (s.standing === 'open' && !!s.phase && step(s.phase) >= step('freeze'));
  const r = run.result;
  if (r) return r.status === 'detached' || (r.status === 'interrupted' && (r.phase === 'aborted' || step(r.phase) >= step('freeze')));
  if (run.aborting) return true;
  // a freeze that could not rest has given the fleet back while the user decides
  if (run.decision?.phase === 'freeze') return false;
  return !!run.phase && step(run.phase) >= step('freeze');
}

export type Choice = 'interrupt' | 'terminate' | 'archive' | 'carry';

/** The one choice that clears a blocker, if one does. */
export function choiceFor(b: Blocker): Choice | undefined {
  if (b.code === 'agent_working' || b.code === 'agent_blocked') return 'interrupt';
  if (b.code === 'shell_busy' || b.code === 'agent_unsettled') return 'terminate';
  if ((b.code === 'destination_diverged' || b.code === 'destination_occupied') && b.entity?.kind === 'root') return 'archive';
  if (b.code === 'repository_unused') return 'carry';
  return undefined;
}

export function chosen(choices: HandoverChoices, b: Blocker): boolean {
  switch (choiceFor(b)) {
    case 'interrupt': return choices.interruptAfterMs !== undefined;
    case 'terminate': {
      const { terminateShells } = choices;
      return terminateShells === true || (b.entity?.kind === 'character' && Array.isArray(terminateShells) && terminateShells.includes(b.entity.id));
    }
    case 'archive': return !!b.entity && !!choices.archiveRoots?.includes(b.entity.id);
    case 'carry': return choices.carryUnused === true;
    default: return false;
  }
}

/** Turns a blocker's choice on or off: interrupting is one choice for every agent; terminating adds or drops each terminal `blockers` names. */
export function withChoice(choices: HandoverChoices, b: Blocker, blockers: Blocker[]): HandoverChoices {
  const on = !chosen(choices, b);
  const { interruptAfterMs, terminateShells, archiveRoots, ...rest } = choices;
  switch (choiceFor(b)) {
    case 'interrupt': return { ...rest, ...(on && { interruptAfterMs: 0 }), ...(terminateShells !== undefined && { terminateShells }), ...(archiveRoots && { archiveRoots }) };
    case 'terminate': {
      const named = blockers.flatMap((x) => (choiceFor(x) === 'terminate' && x.entity?.kind === 'character' ? [x.entity.id] : []));
      const held = Array.isArray(terminateShells) ? terminateShells : [];
      const shells = on ? [...new Set([...held, ...named])] : held.filter((id) => !named.includes(id));
      return { ...rest, ...(interruptAfterMs !== undefined && { interruptAfterMs }), ...(shells.length && { terminateShells: shells }), ...(archiveRoots && { archiveRoots }) };
    }
    case 'archive': {
      const roots = on ? [...(archiveRoots ?? []), b.entity!.id] : (archiveRoots ?? []).filter((id) => id !== b.entity!.id);
      return { ...rest, ...(interruptAfterMs !== undefined && { interruptAfterMs }), ...(terminateShells !== undefined && { terminateShells }), ...(roots.length && { archiveRoots: roots }) };
    }
    case 'carry': {
      const { carryUnused: _held, ...others } = choices;
      return { ...others, ...(on && { carryUnused: true }) };
    }
    default: return choices;
  }
}

export const CHOICE_LABEL: Record<Choice, string> = { interrupt: 'Interrupt and carry', terminate: 'Terminate and carry', archive: 'Archive and carry', carry: 'Carry the folder whole' };

// home: the account's home, which is the same path on both machines, when the page knows it; svall: the command for this window's fleet
export type HintContext = { destination: string; source: string; pull: boolean; home?: string; svall?: string; name(id: string): string };

// a session OpenCode's database went on with; a divergence of files, whatever the agent, ends with the files
const OPENCODE_SESSION = /OpenCode went on with session (ses_[0-9a-f]{12}[0-9A-Za-z]{14}) past the copy coming in$/;

/** What a blocker or warning means for the user, beside what the helper said. */
export function blockerHint(b: Blocker, ctx: HintContext): string | undefined {
  const who = b.entity?.kind === 'character' ? ctx.name(b.entity.id) : 'it';
  // the Linux machine, by the name svall host knows it by
  const linux = ctx.pull ? ctx.source : ctx.destination;
  const svall = ctx.svall ?? 'svall';
  switch (b.code) {
    case 'identity_mismatch':
      return 'A machine, the fleet or the gateway is not the one this handover expects: follow the message. A machine set up again is added and made the gateway again, as "A gateway set up again" in Moving a fleet says.';
    case 'transaction_open':
      return 'Another handover of this fleet is still open: finish it with Resume or Abort, whichever its status says is safe, before a new one.';
    case 'incompatible_adapter':
      return "Update the agent CLI on the machine the message names; for a file in a session, move it out of that session's folder.";
    case 'home_mismatch':
      return `Both machines need the same home path: make an account on ${linux} whose home is this Mac's, then add the machine again at that account.`;
    case 'parent_missing':
      return `Create the folder it names on ${ctx.destination}, owned by your account, then try again.`;
    case 'worktree_unresolved':
      return 'Put the folder back or close the character; `git status` in it says what Git sees.';
    case 'worktree_unused':
      return 'Commit or stash its work on a branch, unlock it, or `git worktree remove` it.';
    case 'destination_no_space':
      return `Free space on ${ctx.destination}, or leave build output out with handover.exclude in fleet.json.`;
    case 'path_collision':
      return `Rename one of the files on ${ctx.source}, or move the file in the way on ${ctx.destination}.`;
    case 'path_symlinked':
      return blockerSide(b) === 'destination'
        ? `Remove the link on ${ctx.destination}, or rename the folder there to the spelling ${ctx.source} uses; then try again.`
        : "Use the real path the message names: cd there in the character's terminal, or change the context item or home.cwd that names the link.";
    case 'mission_control_shared':
      return 'Give one of the fleets a mission control folder of its own: set home.cwd in its fleet.json, such as ~/.svall-work/home.';
    case 'transcript_missing':
      return `An agent that never reported a transcript has no working hooks: run \`${svall} doctor\`. To move without that conversation, exit the agent and try again.`;
    case 'ssh_interactive':
      return `Run ssh once in Terminal to the destination ${linux} was added with and answer what it asks, and keep a key's passphrase in the agent with \`ssh-add --apple-use-keychain\`; then try again.`;
    case 'platform_unsupported':
      return "If the repository runs there, add the platform to its .svall/handover.json; otherwise close the characters working in it.";
    case 'rsync_unsupported':
      return `On ${linux}, install rsync 3.2.3 or newer (\`sudo apt install rsync\`); on this Mac, \`${svall} doctor\` checks the one Svall brings.`;
    case 'git_mismatch':
      return `Try again, which copies again. If it repeats, compare \`git status\` on both machines; a clean filter such as Git LFS needs setting up on ${ctx.destination}.`;
    case 'git_extension':
      return `Update or install git on ${ctx.destination}.`;
    case 'manifest_too_large': case 'too_many_files':
      return 'Leave generated folders out with handover.exclude in fleet.json.';
    case 'generation_mismatch': {
      const owner = !ctx.pull ? 'local' : machineName(ctx.source) ? ctx.source : '<machine>';
      return `Another handover or a recovery moved the fleet since ${ctx.source} last heard, or the gateway was set up again; \`${svall} handover status\` says which. `
        + `With nothing open, restart Svall's daemon on ${ctx.source}, which takes the gateway's newer record; a gateway set up again needs \`${svall} fleet recover --force-owner ${owner}\`.`;
    }
    case 'agent_working':
      return `Continue waiting lets it finish its turn. Interrupt and carry stops every agent still at work with Escape; each resumes from its transcript on ${ctx.destination}.`;
    case 'agent_blocked':
      return `It is waiting on an answer: answer it in its terminal and try again, or Interrupt and carry, which stops it with Escape; it resumes from its transcript on ${ctx.destination}.`;
    case 'agent_unsettled':
      return 'Something in that terminal still runs after the interrupt: a command the agent started, or a hook of your own. Terminate and carry ends whatever still runs there, in every terminal named here; the agent resumes from its transcript on '
        + `${ctx.destination}.`;
    case 'shell_busy':
      return `Terminate and carry ends the command it names, in every terminal named here; the shell opens again in its folder on ${ctx.destination}.`;
    case 'destination_diverged': case 'destination_occupied': {
      if (b.code === 'destination_occupied' || b.entity?.kind !== 'character') return `Archive and carry first moves what is there on ${ctx.destination} aside, to a timestamped folder beside it; nothing is deleted.`;
      const id = OPENCODE_SESSION.exec(b.message)?.[1];
      return `The copy of this session on ${ctx.destination} went on there. ` + (id
        ? `To keep it, run opencode session export --standalone ${id} > keep.json on ${ctx.destination}, then opencode session delete --standalone ${id}, then Try again.`
        : `Move the file the message names aside on ${ctx.destination}, then Try again.`);
    }
    case 'repository_unused':
      return `Carry the folder whole copies those repositories to ${ctx.destination} with it.`;
    case 'character_pinned':
      return `${who} is marked Keep on this machine: turn that off on ${who}'s card to hand the fleet over.`;
    case 'external_writer':
      return ctx.pull
        ? `Something kept writing there, on ${ctx.source} or in its copy on ${ctx.destination}: close whatever writes there, then try again.`
        : 'Something kept writing there: close whatever writes there, then try again.';
    case 'config_difference':
      return 'The agent CLI versions differ between the two machines.';
    case 'codex_trust':
      return `Codex asks you to trust each moved folder the first time it resumes on ${ctx.destination}.`;
    case 'claude_trust':
      return `Claude asks you to trust each moved folder the first time it resumes on ${ctx.destination}, with "No, exit" preselected: choose "Yes, I trust this folder".`;
    case 'claude_bypass':
      return `Claude warns about Bypass Permissions mode when a moved character resumes in it on ${ctx.destination}, with "No, exit" preselected: choose "Yes, I accept", once for that machine.`;
    case 'incompatible_release': case 'incompatible_protocol': case 'incompatible_schema': {
      const linux = ctx.pull ? ctx.source : ctx.destination;
      return `Both machines need the same Svall release: Upgrade ${linux} under Settings → Machines. If it runs a newer release than this Mac, update this Mac first.`;
    }
    case 'agent_cli_missing':
      return "Install it on the machine the message names, where Svall's daemon finds it, then try again.";
    case 'agent_logged_out':
      return `Log it in on ${ctx.destination}, in a terminal there. A login never moves with the fleet.`;
    case 'agent_hooks_missing':
      return `Run svall setup on ${ctx.destination}, then try again.`;
    case 'path_unsupported':
      return b.entity?.kind === 'character'
        ? 'Move what it names, or cd that terminal to a folder that travels, or close the character; then try again.'
        : `Follow the message: move what it names out of the folder that carries it, fix handover.exclude in fleet.json, or make the folder writable on ${ctx.destination}; then try again.`;
    default:
      return undefined;
  }
}

/** The Linux machine a release blocker asks to have upgraded, by the name Settings → Machines knows it by. */
export function upgradeAsked(b: Blocker, ctx: HintContext): string | undefined {
  if (b.code !== 'incompatible_release' && b.code !== 'incompatible_protocol' && b.code !== 'incompatible_schema') return undefined;
  const linux = ctx.pull ? ctx.source : ctx.destination;
  return machineName(linux) ? linux : undefined;
}

/** A path as the user says it: the account's home, when known, as `~`. */
export const shortPath = (p: string, home?: string): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** The account's home a fleet home lies in, such as `/Users/ada` for `/Users/ada/.svall`. */
export const accountHome = (fleetHome: string | undefined): string | undefined => (fleetHome ? /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(fleetHome)?.[0] : undefined);

/** Which machine the folder a blocker names is on, when its code, its message or the step that found it (`phase`) says. */
export function blockerSide(b: Blocker, phase?: HandoverPhase): 'source' | 'destination' | undefined {
  switch (b.code) {
    case 'external_writer': return /^the source /.test(b.message) ? 'source' : 'destination';
    case 'path_symlinked': return /lands at the path it has on the source/.test(b.message) ? 'destination' : 'source';
    // the checks and the freeze read the source's folders; the destination checks its own once they have landed
    case 'path_unsupported': return phase === 'begin' || phase === 'freeze' ? 'source' : undefined;
    case 'worktree_unresolved': case 'worktree_unused': case 'repository_unused': case 'platform_unsupported': case 'mission_control_shared': return 'source';
    case 'destination_occupied': case 'destination_diverged': case 'parent_missing': case 'git_mismatch': case 'git_extension': case 'path_collision': return 'destination';
    default: return undefined;
  }
}

// warnings about what the user meets on the destination, which stay in sight while the rest fold away
const AFTER_MOVE: string[] = ['claude_trust', 'claude_bypass', 'codex_trust', 'config_difference'];
export const staysInSight = (w: Warning): boolean => AFTER_MOVE.includes(w.code);

/** The full path a blocker or row is about, when it is about a folder: a root's, or the one a Git message leads with. */
export function entityPath(e: Blocker['entity'], names?: Names, message?: string): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'root') return names?.roots[e.id];
  if (e.kind === 'git') return /^(\/[^:]+):/.exec(message ?? '')?.[1];
  return undefined;
}

/** Who or what an entity is for the user: a character's name, a folder by its short path, whose a session is; an id only when nothing names it. */
export function entityLabel(e: Blocker['entity'], name: (id: string) => string, names?: Names, message?: string, home?: string): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'character') return name(e.id);
  if (e.kind === 'session') return names?.sessions?.[e.id] ? `${names.sessions[e.id]}'s session` : `session ${e.id}`;
  const path = entityPath(e, names, message);
  if (path) return shortPath(path, home);
  return e.kind === 'root' ? `folder ${e.id}` : 'repository';
}

/** A blocker's message as a problem on one line, the remedy the helper added after it, and the agent's question when it quotes one. */
export function problemOf(message: string, explained: boolean): { problem: string; remedy?: string; quote?: string } {
  const cut = explained ? message.indexOf('; ') : -1;
  const [problem, remedy] = cut < 0 ? [message, undefined] : [message.slice(0, cut), message.slice(cut + 2)];
  const q = /^(.*?): ("[^"]+")$/.exec(problem);
  return q ? { problem: q[1], quote: q[2], ...(remedy && { remedy }) } : { problem, ...(remedy && { remedy }) };
}

/** What picking a blocker's choice will do, for the row that holds it. */
export function planOf(choice: Choice, b: Blocker, ctx: HintContext, names?: Names): string {
  const who = b.entity?.kind === 'character' ? ctx.name(b.entity.id) : 'it';
  switch (choice) {
    case 'interrupt': return `${who} will be stopped with Escape and resume from its transcript on ${ctx.destination}.`;
    case 'terminate': return `What runs in ${who}'s terminal will be ended; the shell reopens in its folder on ${ctx.destination}.`;
    case 'archive': return `What is at ${entityLabel(b.entity, ctx.name, names, b.message, ctx.home) ?? 'that folder'} on ${ctx.destination} will be set aside first, to a timestamped folder beside it.`;
    case 'carry': return `${who}'s folder will be carried whole, with the repositories in it.`;
  }
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** How far a row has come, from 0 to 1, when it says. */
export function fraction(row: Progress): number | undefined {
  if (row.totalBytes) return Math.min(1, (row.bytes ?? 0) / row.totalBytes);
  if (row.total) return Math.min(1, (row.done ?? 0) / row.total);
  return undefined;
}

/** A transfer row the destination has verified; one still being checked has its phase, and often every byte. */
export const verified = (row: Row): boolean => row.section === 'transfer' && !!row.verified && !row.error;

/** Every transfer row as one: bytes sent against bytes to send, and how many rows are verified. */
export function transferTotals(rows: Row[]): { bytes: number; totalBytes: number; done: number; total: number } {
  const t = { bytes: 0, totalBytes: 0, done: 0, total: 0 };
  for (const r of rows) {
    if (r.section !== 'transfer') continue;
    t.total++;
    if (verified(r)) t.done++;
    t.totalBytes += r.totalBytes ?? 0;
    t.bytes += Math.min(r.bytes ?? 0, r.totalBytes ?? r.bytes ?? 0);
  }
  return t;
}

/** How the resume went for every character the freeze rested: agents resume from transcripts, shells reopen as they are opened. */
export function resumeTally(run: HandoverRun): { resumed: number; failed: number; shells: number } {
  const rested = run.rows.filter((r) => r.section === 'rest').map((r) => r.id);
  const agents = run.rows.filter((r) => r.section === 'resume');
  const failed = run.result?.status === 'complete' ? run.result.characters.filter((c) => !c.ok).length : agents.filter((r) => r.error).length;
  const resumed = run.result?.status === 'complete' ? run.result.characters.filter((c) => c.ok).length : agents.filter((r) => !r.error).length;
  return { resumed, failed, shells: rested.filter((id) => !agents.some((a) => a.id === id)).length };
}

export function rowText(row: Row): string {
  return row.archivedTo ? `${progressText(row)}; what was there is kept at ${row.archivedTo}` : progressText(row);
}

function progressText(row: Row): string {
  if (row.error) return row.error;
  if (row.section === 'resume') return row.notice ? `resumed; ${row.notice}` : 'resumed';
  if (row.section === 'rest') return row.total !== undefined && row.done === row.total ? 'at rest' : 'resting…';
  if (row.totalBytes !== undefined) return `${formatBytes(row.bytes ?? 0)} of ${formatBytes(row.totalBytes)}`;
  return row.total !== undefined ? `${row.done ?? 0} of ${row.total} files` : 'waiting…';
}

const label = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.label;

/** Where a status leaves the handover, from its standing, safe actions and phase; its reason names ids and generations. */
function standingLine(s: Verdict, destination: string): string {
  switch (s.standing) {
    case 'open':
      return `${s.phase === 'aborted' ? 'An abort stopped part way' : `Stopped at ${label(SECTIONS[sectionAt(s.phase ?? 'begin')].id)}`}, before the commit: the fleet has not moved.`;
    case 'committed': case 'moved':
      if (!s.safe.length) return `The fleet moved to ${destination}, but ${destination}'s record of the handover could not be read: nothing is safe until someone looks at that machine.`;
      return s.standing === 'committed'
        ? `The fleet is ${destination}'s now, and stopped before its characters resumed there.`
        : `The fleet runs on ${destination} now; what the handover left open there is still to finish.`;
    case 'returned': return 'The gateway let go of this handover, and the fleet stays where it was; Abort finishes letting go.';
    case 'superseded': return "The gateway has moved on past this handover, so nothing is left to resume or abort; Forget drops this Mac's record of it.";
    case 'unknown': return `Whether the fleet moved to ${destination} is not known yet: the gateway has not answered.`;
    case 'none': return s.safe.includes('abort') ? 'The gateway never began this handover, so nothing moved; Abort clears what is left of it.' : 'No handover of this fleet is open.';
  }
}

/** The sheet's one line on where the handover stands. `destination` is the machine it goes to, by name. */
export function headline(run: HandoverRun, destination: string): string {
  const s = verdictOf(run);
  if (s) return standingLine(s, destination);
  const r = run.result;
  switch (r?.status) {
    case 'complete': {
      const failed = r.characters.filter((c) => !c.ok).length;
      return [
        `The fleet runs on ${destination} now.`,
        failed ? `${failed} ${failed === 1 ? 'character' : 'characters'} did not resume.` : '',
        r.pending?.length ? `${r.pending.join(' and ')} has not heard that it finished${r.error ? ` (${r.error})` : ''}; Retry tells it.` : '',
      ].filter(Boolean).join(' ');
    }
    case 'aborted': return 'Stopped before the commit: the fleet stays where it was.';
    case 'blocked': {
      const n = r.blockers.length;
      return `${n} ${n === 1 ? 'thing' : 'things'} to settle before the fleet moves to ${destination}. Nothing has moved.`;
    }
    case 'interrupted':
      if (commitUnknown(r)) return standingLine({ standing: 'unknown', journals: {}, safe: [], action: 'none', reason: '' }, destination);
      return isCommitted(run)
        ? `The fleet is ${destination}'s now, and it stopped while resuming: ${r.error}`
        : `Stopped at ${label(SECTIONS[sectionAt(r.phase === 'aborted' ? run.phase ?? 'begin' : r.phase)].id)}: ${r.error}`;
    case 'detached': return `The fleet is moving to ${destination} without this window watching.`;
    case 'none': return 'There was no handover of this fleet to resume or abort.';
  }
  if (run.error) return `The helper did not run: ${run.error}`;
  if (decisionPending(run)) {
    const n = run.decision!.blockers.length;
    return `${n === 1 ? 'One thing' : `${n} things`} to decide before the fleet goes on.`;
  }
  if (!live(run)) return '';
  if (run.aborting) return 'Stopping: the fleet goes back to where it was…';
  if (run.checking) return 'Asking where the handover stands…';
  if (!run.phase && !run.preflight) return run.to ? 'Starting…' : 'Looking for a handover…';
  const now = run.goingOn ? `The fleet is ${destination}'s now, so the sheet resumes it there by itself…` : `${label(SECTIONS[sectionAt(run.phase ?? 'begin')].id)}…`;
  return run.retry ? `${now} asking again (attempt ${run.retry.attempt}): ${run.retry.error}` : now;
}

export const destinationName = (to: string | undefined): string => (to === 'local' ? 'This Mac' : to ?? 'the other machine');
