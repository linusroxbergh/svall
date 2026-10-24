import {
  HANDOVER_PHASES,
  type Blocker, type Robot, type EntityData, type HandoverChoices, type HandoverEntityKind, type HandoverEvent, type HandoverPhase, type ManifestSummary, type Names, type Outcome, type SafeAction, type StopReason, type Verdict,
  type Warning,
} from '@svall/protocol';
import { ids, machineName, withoutGenerations, withoutTokens } from './host.js';
import { shortPath } from './paths.js';

// what `svall handover --json` prints
export type { HandoverEvent, Names, Outcome, Verdict } from '@svall/protocol';

export type SectionId = 'checks' | 'rest' | 'transfer' | 'verify' | 'commit' | 'resume';
// Abort is possible up to the commit, which has a section of its own
const SECTIONS: { id: SectionId; label: string; phases: HandoverPhase[] }[] = [
  { id: 'checks', label: 'Checks', phases: ['begin'] },
  { id: 'rest', label: 'Resting robots', phases: ['freeze'] },
  { id: 'transfer', label: 'Transferring files and sessions', phases: ['transfer'] },
  { id: 'verify', label: 'Verifying', phases: ['verify', 'prepare', 'ready'] },
  { id: 'commit', label: 'Committing', phases: ['commit'] },
  { id: 'resume', label: 'Resuming robots', phases: ['activate', 'complete'] },
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
  // the run it asked about, which a status that finds nothing open hands back
  stopped?: HandoverRun;
  // the status is the sheet's own look at this run, which a status found by a later look is not
  checked?: boolean;
  // the transfer's bytes when this page started and last counted them, by its clock, and when it first did; a run read back has none
  pace?: { since: number; from: { at: number; bytes: number }; last: { at: number; bytes: number } };
};

const step = (p: HandoverPhase): number => (p === 'aborted' ? -1 : HANDOVER_PHASES.indexOf(p));
const sectionAt = (p: HandoverPhase): number => Math.max(0, SECTIONS.findIndex((s) => s.phases.includes(p)));

export const followRun = (to?: string, choices: HandoverChoices = {}): HandoverRun => ({ to, following: true, rows: [], choices, awaitingOwner: false });

const sectionOf = (kind: HandoverEntityKind, phase: HandoverPhase): SectionId =>
  kind !== 'robot' ? 'transfer' : phase === 'activate' || phase === 'complete' ? 'resume' : 'rest';

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

/**
 * The controller's words without the ids and generations it names: the shapes it writes in whole, a transaction as the
 * handover, and any other id as a machine.
 */
const plain = (text: string): string => withoutGenerations(withoutTokens(text)
  .replace(ids('\\b(holds|with) UUID at generation \\d+(?: in handover UUID \\([^)]*\\))?'), '$1 a different record of the fleet')
  .replace(ids(' in handover UUID'), ' in another handover'))
  .replace(ids('(^|; )UUID\\b'), '$1the handover')
  .replace(ids(': UUID is committed'), ': the handover is committed')
  .replace(ids('\\bhandover UUID\\b'), 'the handover')
  .replace(ids('\\b(record|commit|of|abort|whether|past) UUID\\b'), '$1 the handover')
  .replace(ids('\\bmachine UUID\\b'), 'another machine')
  .replace(ids('\\bthe gateway UUID\\b'), 'the gateway')
  .replace(ids('\\bUUID\\b'), 'a machine');

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
    case 'complete': return isEach(d.robots, (c) => isObject(c) && isString(c.id) && typeof c.ok === 'boolean' && optional(c.error, isString) && optional(c.notice, isString))
      && optional(d.pending, isSafe) && optional(d.error, isString);
    case 'none': return isString(d.reason);
    case 'blocked': return isPhase(d.phase) && isEach(d.blockers, isIssue);
    case 'aborted': return isPhase(d.phase);
    case 'interrupted': return isPhase(d.phase) && isString(d.error) && isSafe(d.safe) && optional(d.stop, isString) && optional(d.detail, isString);
    case 'detached': return isString(d.transactionId);
    case 'ready': return true;
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
        && optional(d.names, (n) => isObject(n) && isObject(n.robots) && isObject(n.roots) && optional(n.landing, isObject) && optional(n.sessions, isObject));
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

/** Folds one line the helper printed onto the run it belongs to; a line it cannot read leaves the run as it was. `now`: when it arrived. */
export function applyEvent(run: HandoverRun, e: HandoverEvent, o: { now?: number } = {}): HandoverRun {
  if (!readable(e)) return run;
  const tx = 'transactionId' in e.data && typeof e.data.transactionId === 'string' ? e.data.transactionId : undefined;
  // the controller goes on from a decision only once it is answered; a daemon's relayed row can trail the decision
  // a line after the status the sheet asked for is the run that status found, which need not go where the start did
  const next: HandoverRun = {
    ...run, checking: undefined, ...(run.checking && { to: undefined, stopped: undefined }), transactionId: run.transactionId ?? tx, ...(e.event === 'handover.changed' && { decision: undefined }),
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
    case 'handover.entity': {
      const rows = withEntity(next.rows, e.data);
      if (o.now === undefined || sectionOf(e.data.kind, e.data.phase) !== 'transfer') return { ...next, rows };
      const sample = { at: o.now, bytes: transferTotals(rows).bytes };
      // what an attach replays arrives in one burst, so the count starts once the first second is over
      const since = next.pace?.since ?? o.now;
      return { ...next, rows, pace: { since, from: o.now - since < PACE_SETTLE_MS ? sample : next.pace!.from, last: sample } };
    }
    case 'handover.blocked':
      // an answer starts from the choices the run holds, which a sheet relaunched after the start never saw
      return { ...next, decision: { phase: e.data.phase, blockers: scrubbed(e.data.blockers) }, ...(e.data.choices && { choices: e.data.choices }) };
    case 'handover.retry':
      return { ...next, retry: { ...e.data, error: plain(e.data.error) } };
    case 'handover.result': {
      const data = e.data.status === 'interrupted' ? { ...e.data, error: plain(e.data.error), ...(e.data.detail && { detail: withoutTokens(e.data.detail) }) }
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

/** Why a run that stopped offers nothing safe, when it says. */
const stopOf = (r: Outcome | undefined): StopReason | undefined => (r?.status === 'interrupted' && !r.safe.length ? r.stop : undefined);

// stops where the status says more than the run did: whose handover is open, or the run that holds this machine
const STATUS_SAYS: (StopReason | undefined)[] = [undefined, 'superseded', 'running', 'unexpected'];

// blockers that mean another handover of this fleet may be open, which only `handover status` can say what to do about
const OPEN_ELSEWHERE: string[] = ['transaction_open', 'generation_mismatch', 'identity_mismatch'];

/**
 * A run whose status the sheet then reads: the checks stopped it for a handover that may already be open, a resume or
 * abort found nothing safe, which its error says in the controller's ids, or the helper it followed ended with no result.
 */
export function asksStatus(run: HandoverRun | undefined): boolean {
  if (!run || run.following || run.status || run.checking) return false;
  const r = run.result;
  // a look the sheet took itself that heard nothing is not taken again
  if (!r) return !run.error && !run.stopped;
  return r?.status === 'blocked' ? r.blockers.some((b) => OPEN_ELSEWHERE.includes(b.code)) : r?.status === 'interrupted' && !r.safe.length && STATUS_SAYS.includes(r.stop);
}

/** A blocker the status has answered, whose message names the ids and generations the sheet leaves out. */
export const answered = (run: HandoverRun, b: Blocker): boolean => !!run.status && OPEN_ELSEWHERE.includes(b.code);

/** The status the sheet goes by: one it read itself and finds nothing open leaves a run that stopped with no way on to its blockers or its error. */
export const verdictOf = (run: HandoverRun): Verdict | undefined => {
  const r = run.result;
  const stopped = r?.status === 'blocked' || (r?.status === 'interrupted' && !r.safe.length);
  return run.checked && run.status?.standing === 'none' && !run.status.safe.length && stopped ? undefined : run.status;
};

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

/** `svall` as typed for a window's fleet: with `-p <profile>` when the shell names one, as its own calls are. */
export const svallFor = (profile: string | undefined): string => (profile ? `svall -p ${profile}` : 'svall');

/** A status past the commit with nothing safe: the destination's journal of it could not be read. */
const lostJournal = (s: Verdict | undefined): boolean => !!s && (s.standing === 'committed' || s.standing === 'moved') && !s.safe.length;

/** The way on from a terminal where the sheet has none, as handover.md and errors.md give it; commands stand between backticks. */
export function wayOut(run: HandoverRun, ctx: Pick<HintContext, 'destination' | 'svall' | 'gateway'>): string | undefined {
  const svall = ctx.svall ?? 'svall';
  const s = verdictOf(run);
  const stop = s ? undefined : stopOf(run.result);
  if (s?.standing === 'superseded' || stop === 'superseded') {
    return `Where the fleet stands now:\n\`${svall} handover status\`\nForget is enough if another handover or a recovery moved it on.\n`
      + `If the gateway was set up again, make this Mac the fleet's owner:\n\`${svall} fleet recover --force-owner local\``;
  }
  if (s?.standing === 'unknown' || stop === 'commit_unknown' || stop === 'gateway_unknown') {
    const gateway = ctx.gateway && machineName(ctx.gateway) ? ctx.gateway : '<gateway>';
    return `Once the gateway answers, this says what is safe:\n\`${svall} handover status\`\nMeanwhile, check the link to it:\n\`${svall} host doctor ${gateway}\`\n`
      + `If it is gone for good, run the fleet on this Mac alone:\n\`${svall} fleet recover --force-owner local\`\n`
      + `Or with another machine as its gateway:\n\`${svall} fleet recover --force-owner local --gateway <machine>\``;
  }
  if (lostJournal(s) || stop === 'journal_lost') {
    return `On ${ctx.destination}, put the handover record back where Details says, restart the fleet's daemon there, then Check again.\n`
      + `Or run the fleet on a machine you name, from the state it holds:\n\`${svall} fleet recover --force-owner <machine>\``;
  }
  return undefined;
}

/** What the journals said where the sheet says it plainly: a stopped run's detail, or the reason of a status whose journal was lost. */
export function detailOf(run: HandoverRun): string | undefined {
  const s = verdictOf(run);
  if (run.result?.status === 'interrupted' && run.result.detail) return run.result.detail;
  return lostJournal(s) ? s!.reason : undefined;
}

/** Past the commit: the fleet is the destination's, and only going on is left. */
export function isCommitted(run: HandoverRun): boolean {
  if (run.status) return run.status.standing === 'committed' || run.status.standing === 'moved';
  const r = run.result;
  if (r?.status === 'complete' || r?.status === 'detached') return true;
  if (r?.status === 'interrupted') return r.stop && !r.safe.length ? r.stop === 'journal_lost' : step(r.phase) >= step('commit') && r.safe.includes('resume') && !r.safe.includes('abort');
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
    // a check that found nothing in the way has done Checks, and begun nothing after it
    state: finished || i < at || (i === at && r?.status === 'ready') ? 'done' : i === at ? (r?.status === 'detached' ? 'active' : here) : 'pending',
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
    case 'blocked': case 'ready': return { ...none, tryAgain: !!run.to, start: true };
    case 'aborted': case 'none': return { ...none, start: true };
    case 'interrupted': return { ...none, resume: resume(r.safe), abort: r.safe.includes('abort'), follow: r.safe.length === 0 };
    case 'detached': return { ...none, follow: true };
    // a resume the sheet started by itself that never said how it went is still the only way on
    default: return run.goingOn ? { ...none, resume: 'Retry' } : { ...none, start: true, follow: !!run.error || !!run.stopped };
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

/** What the rest does with a robot's main terminal, as handover.md's What restarts gives it. */
export type RestHow = 'resume' | 'wait' | 'answer' | 'background' | 'shell' | 'dormant';
export type RestGroup = { how: RestHow; names: string[] };

const REST_ORDER: RestHow[] = ['resume', 'wait', 'answer', 'background', 'shell', 'dormant'];

function restOf(c: Robot): RestHow {
  if (!c.tmux) return 'dormant';
  const a = c.agent;
  if (!a) return 'shell';
  if (a.status === 'blocked') return 'answer';
  // a turn that ended with background work out stays working
  if (a.background) return 'background';
  return a.status === 'working' ? 'wait' : 'resume';
}

/** Who stops for a handover and how, by name: the groups that have anyone in them, in the order the sheet lists them. */
export function restPlan(robots: Record<string, Robot>): RestGroup[] {
  const by = new Map<RestHow, string[]>();
  for (const c of Object.values(robots)) by.set(restOf(c), [...(by.get(restOf(c)) ?? []), c.name]);
  return REST_ORDER.flatMap((how) => (by.has(how) ? [{ how, names: by.get(how)! }] : []));
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
      return terminateShells === true || (b.entity?.kind === 'robot' && Array.isArray(terminateShells) && terminateShells.includes(b.entity.id));
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
      const named = blockers.flatMap((x) => (choiceFor(x) === 'terminate' && x.entity?.kind === 'robot' ? [x.entity.id] : []));
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

// home: this Mac's account home, when the page knows it; svall: the command for this window's fleet;
// gateway: the fleet's gateway by its registry name
export type HintContext = { destination: string; source: string; pull: boolean; home?: string; svall?: string; gateway?: string; name(id: string): string };

// a session OpenCode's database went on with; a divergence of files, whatever the agent, ends with the files
const OPENCODE_SESSION = /OpenCode went on with session (ses_[0-9a-f]{12}[0-9A-Za-z]{14}) past the copy coming in$/;

/** What a blocker or warning means for the user, beside what the helper said. */
export function blockerHint(b: Blocker, ctx: HintContext, warning = false): string | undefined {
  const who = b.entity?.kind === 'robot' ? ctx.name(b.entity.id) : 'it';
  // the Linux machine, by the name svall host knows it by
  const linux = ctx.pull ? ctx.source : ctx.destination;
  const svall = ctx.svall ?? 'svall';
  switch (b.code) {
    case 'identity_mismatch':
      return 'A machine, the fleet or the gateway is not the one this handover expects: follow the message.\nA machine set up again needs adding and making the gateway again.\nSee "A gateway set up again" in Moving a fleet.';
    case 'transaction_open':
      return 'Another handover of this fleet is still open: Resume or Abort it first, whichever is safe.';
    case 'incompatible_adapter':
      return "Update the agent CLI on the machine the message names.\nFor a file in a session, move it out of that session's folder.";
    case 'home_mismatch':
      return ctx.pull
        ? `This Mac's home is not the one this handover was sent to: start a new handover.`
        : `The home on ${linux} is not the one this handover was sent to.\nAdd the machine again as this says:\n\`${svall} host doctor ${linux}\`\nThen start a new handover.`;
    case 'parent_missing':
      return `Create the folder it names on ${ctx.destination}, owned by your account, then try again.`;
    case 'worktree_unresolved':
      return 'Put the folder back or close the robot.\nWhat Git sees, run in the folder:\n`git status`';
    case 'worktree_unused':
      return 'Commit or stash its work on a branch, unlock it, or remove it:\n`git worktree remove <path>`';
    case 'destination_no_space':
      return `Free space on ${ctx.destination}, or leave build output out with handover.exclude in fleet.json.`;
    case 'path_collision':
      return `Rename one of the files on ${ctx.source}, or move the file in the way on ${ctx.destination}.`;
    case 'path_symlinked':
      return blockerSide(b) === 'destination'
        ? `Remove the link on ${ctx.destination}, or rename the folder there as the message says; then try again.`
        : "Use the real path the message names.\ncd there in the robot's terminal, or change the context item or home.cwd that names the link.";
    case 'mission_control_shared':
      return 'Give one fleet a mission control folder of its own: set home.cwd in its fleet.json, such as ~/.svall-work/home.';
    case 'transcript_missing':
      return `The agent never reported a transcript, so its hooks are not working:\n\`${svall} doctor\`\nTo move without that conversation, exit the agent and try again.`;
    case 'ssh_interactive':
      return `In Terminal, ssh once to the destination ${linux} was added with and answer what it asks.\nKeep a key's passphrase in the agent:\n\`ssh-add --apple-use-keychain\`\nThen try again.`;
    case 'platform_unsupported':
      return 'If the repository runs there, add the platform to its .svall/handover.json.\nOtherwise close the robots working in it.';
    case 'rsync_unsupported':
      return `On ${linux}, install rsync 3.2.3 or newer:\n\`sudo apt install rsync\`\nOn this Mac, this checks the rsync Svall brings:\n\`${svall} doctor\``;
    case 'linger_off':
      return `On ${linux}, run the loginctl enable-linger command the message names, then try again.\nIt keeps the fleet running there while no one is logged in.`;
    case 'git_mismatch':
      return `Try again, which copies again. If it repeats, compare on both machines:\n\`git status\`\nA clean filter such as Git LFS needs setting up on ${ctx.destination}.`;
    case 'git_extension':
      return `Update or install git on ${ctx.destination}.`;
    case 'git_config_command':
      return `Set each command up the same in ${ctx.destination}'s global git config:\n\`git config --global <key> <command>\`\nOr remove it in the repository:\n\`git config --unset <key>\``;
    case 'manifest_too_large': case 'too_many_files':
      return 'Leave generated folders out with handover.exclude in fleet.json.';
    case 'generation_mismatch': {
      const owner = !ctx.pull ? 'local' : machineName(ctx.source) ? ctx.source : '<machine>';
      return `Another handover or a recovery moved the fleet since ${ctx.source} last heard, or the gateway was set up again.\nThis says which:\n\`${svall} handover status\`\n`
        + `With nothing open, restart Svall's daemon on ${ctx.source}; it takes the gateway's newer record.\nA gateway set up again needs:\n\`${svall} fleet recover --force-owner ${owner}\``;
    }
    case 'agent_working':
      return `Continue waiting lets it finish its turn.\nInterrupt and carry stops every agent at work with Escape; each resumes from its transcript on ${ctx.destination}.`;
    case 'agent_blocked':
      return `It waits on an answer: answer it in its terminal and try again.\nOr Interrupt and carry: it stops with Escape and resumes from its transcript on ${ctx.destination}.`;
    case 'agent_unsettled':
      return 'Something still runs in that terminal after the interrupt: a command the agent started, or a hook of your own.\n'
        + `Terminate and carry ends it in every terminal named here.\nThe agent resumes from its transcript on ${ctx.destination}.`;
    case 'shell_busy':
      return `Terminate and carry ends the command in every terminal named here.\nThe shell opens again in its folder on ${ctx.destination}.`;
    case 'destination_diverged': case 'destination_occupied': {
      if (b.code === 'destination_occupied' || b.entity?.kind !== 'robot') return `Archive and carry moves what is there on ${ctx.destination} aside to a timestamped folder beside it; nothing is deleted.`;
      const id = OPENCODE_SESSION.exec(b.message)?.[1];
      return `The copy of this session on ${ctx.destination} went on there. ` + (id
        ? `To keep it, run these on ${ctx.destination}, then Try again:\n\`opencode session export --standalone ${id} > keep.json\`\n\`opencode session delete --standalone ${id}\``
        : `Move the file the message names aside on ${ctx.destination}, then Try again.`);
    }
    case 'repository_unused':
      return `Carry the folder whole copies those repositories to ${ctx.destination} with it.`;
    case 'robot_pinned':
      return `${who} is set to Keep on this machine: turn that off on ${who}'s card.`;
    case 'external_writer':
      return ctx.pull
        ? `Something kept writing there, on ${ctx.source} or in its copy on ${ctx.destination}.\nClose whatever writes there, then try again.`
        : 'Something kept writing there: close it, then try again.';
    case 'config_difference':
      return 'The agent CLI versions differ between the two machines.';
    case 'codex_trust':
      return `Codex asks you to trust each moved folder the first time it resumes on ${ctx.destination}.`;
    case 'codex_hooks':
      return `Codex on ${ctx.destination} stops at "Hooks need review" until it trusts Svall's hooks.\nStart codex there and choose "Trust all and continue".`;
    case 'codex_sandbox':
      return `Codex on ${ctx.destination} cannot sandbox its commands, so it asks before each one.\nFix what the message names there.`;
    case 'claude_trust':
      return `Claude asks you to trust each moved folder the first time it resumes on ${ctx.destination}.\n"No, exit" is preselected: choose "Yes, I trust this folder".`;
    case 'claude_bypass':
      return `Claude warns about Bypass Permissions mode when a moved robot resumes in it on ${ctx.destination}.\n"No, exit" is preselected: choose "Yes, I accept", once for that machine.`;
    case 'incompatible_release': case 'incompatible_protocol': case 'incompatible_schema': {
      const linux = ctx.pull ? ctx.source : ctx.destination;
      return `Both machines need the same Svall release: Upgrade ${linux} under Settings → Machines.\nIf it runs a newer release than this Mac, update this Mac first.`;
    }
    case 'authority_unreachable':
      return `The gateway could not say who owns this fleet.\nCheck ${ctx.gateway ?? (ctx.pull ? ctx.source : ctx.destination)} under Settings → Machines, then try again.`;
    case 'authority_corrupt':
      return `The gateway on ${ctx.gateway ?? (ctx.pull ? ctx.source : ctx.destination)} cannot read its record of this fleet.\nPut a readable record back there, or replace the gateway:\n\`${svall} fleet recover --force-owner <machine> --gateway <other machine>\``;
    case 'agent_cli_missing':
      return "Install it on the machine the message names, where Svall's daemon finds it, then try again.";
    case 'agent_logged_out':
      // as a warning, the agent answers with no login on the source too, and its message says when one is needed
      return warning ? undefined : `Log it in on ${ctx.destination}, in a terminal there. A login never moves with the fleet.`;
    case 'agent_hooks_missing':
      return `On ${ctx.destination}, run this, then try again:\n\`svall setup\``;
    case 'path_unsupported':
      return b.entity?.kind === 'robot'
        ? 'Do one of these, then try again:\n- move what it names\n- cd that terminal to a folder that travels\n- close the robot'
        : `Follow the message, then try again:\n- move what it names out of the folder that carries it\n- fix handover.exclude in fleet.json\n- make the folder writable on ${ctx.destination}`;
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

/** Which machine the folder a blocker names is on, when its code, its message or the step that found it (`phase`) says. */
export function blockerSide(b: Blocker, phase?: HandoverPhase): 'source' | 'destination' | undefined {
  switch (b.code) {
    case 'external_writer': return /^the source /.test(b.message) ? 'source' : 'destination';
    case 'path_symlinked': return /lands at the path the handover gives it here/.test(b.message) ? 'destination' : 'source';
    // the checks and the freeze read the source's folders; the destination checks its own once they have landed
    case 'path_unsupported': return phase === 'begin' || phase === 'freeze' ? 'source' : undefined;
    case 'worktree_unresolved': case 'worktree_unused': case 'repository_unused': case 'platform_unsupported': case 'mission_control_shared': return 'source';
    case 'destination_occupied': case 'destination_diverged': case 'parent_missing': case 'git_mismatch': case 'git_extension': case 'path_collision': return 'destination';
    default: return undefined;
  }
}

// warnings about what the user meets on the destination, which stay in sight while the rest fold away
const AFTER_MOVE: string[] = ['claude_trust', 'claude_bypass', 'codex_trust', 'codex_hooks', 'codex_sandbox', 'config_difference'];
export const staysInSight = (w: Warning): boolean => AFTER_MOVE.includes(w.code);

/** `names` with each root that lands at another path named by where it lands, for what is about the destination. */
export const namesOn = (names: Names | undefined, side: 'source' | 'destination' | undefined): Names | undefined =>
  (side === 'destination' && names?.landing ? { ...names, roots: { ...names.roots, ...names.landing } } : names);

/** The full path a blocker or row is about, when it is about a folder: a root's, or the one a Git message leads with. */
export function entityPath(e: Blocker['entity'], names?: Names, message?: string): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'root') return names?.roots[e.id];
  if (e.kind === 'git') return /^(\/[^:]+):/.exec(message ?? '')?.[1];
  return undefined;
}

/** Who or what an entity is for the user: a robot's name, a folder by its short path, whose a session is; an id only when nothing names it. */
export function entityLabel(e: Blocker['entity'], name: (id: string) => string, names?: Names, message?: string, home?: string): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'robot') return name(e.id);
  if (e.kind === 'session') return names?.sessions?.[e.id] ? `${names.sessions[e.id]}'s session` : `session ${e.id}`;
  const path = entityPath(e, names, message);
  // with no home known the path may be the other machine's, so it stays whole
  if (path) return home ? shortPath(path, home) : path;
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
  const who = b.entity?.kind === 'robot' ? ctx.name(b.entity.id) : 'it';
  switch (choice) {
    case 'interrupt': return `${who} will be stopped with Escape and resume from its transcript on ${ctx.destination}.`;
    case 'terminate': return `What runs in ${who}'s terminal ends; the shell reopens in its folder on ${ctx.destination}.`;
    case 'archive': return `What is at ${entityLabel(b.entity, ctx.name, names, b.message, ctx.home) ?? 'that folder'} on ${ctx.destination} moves aside first, to a timestamped folder beside it.`;
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

/** The bytes the whole transfer sends: what preflight found, until every row has said its own size. */
export const transferBytes = (run: HandoverRun): number => Math.max(transferTotals(run.rows).totalBytes, run.preflight?.summary.bytes ?? 0);

const PACE_SETTLE_MS = 1000;

const leftText = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute left';
  return min < 60 ? `about ${min} min left` : `about ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''} left`;
};

/** The whole transfer's rate since this page first counted its bytes, and the time left at that rate, once five seconds have passed. */
export function transferPace(run: HandoverRun): { rate: number; leftMs: number; text: string } | undefined {
  const p = run.pace;
  const ms = p ? p.last.at - p.from.at : 0;
  const sent = p ? p.last.bytes - p.from.bytes : 0;
  if (!p || ms < 5000 || sent <= 0) return undefined;
  const rate = (sent / ms) * 1000;
  const leftMs = (Math.max(0, transferBytes(run) - p.last.bytes) / rate) * 1000;
  return { rate, leftMs, text: `${formatBytes(Math.round(rate))}/s, ${leftText(leftMs)}` };
}

/** What a terminal the handover rested says: the step it is at, how far the copy is, or that it waits for an answer. */
export function restingLine(run: HandoverRun | undefined): string {
  const head = 'Resting for the handover';
  if (!run) return `${head}…`;
  if (decisionPending(run)) return `${head}: it waits for you in Handover.`;
  const at = live(run) ? sectionStates(run).find((s) => s.state === 'active') : undefined;
  if (!at) return `${head}: Handover says where it stands.`;
  const whole = transferBytes(run);
  return `${head}: ${at.label}${at.id === 'transfer' && whole ? `, ${Math.floor((transferTotals(run.rows).bytes / whole) * 100)}%` : ''}…`;
}

/** How the resume went for every robot the freeze rested: agents resume from transcripts, shells reopen as they are opened. */
export function resumeTally(run: HandoverRun): { resumed: number; failed: number; shells: number } {
  const rested = run.rows.filter((r) => r.section === 'rest').map((r) => r.id);
  const agents = run.rows.filter((r) => r.section === 'resume');
  const failed = run.result?.status === 'complete' ? run.result.robots.filter((c) => !c.ok).length : agents.filter((r) => r.error).length;
  const resumed = run.result?.status === 'complete' ? run.result.robots.filter((c) => c.ok).length : agents.filter((r) => !r.error).length;
  return { resumed, failed, shells: rested.filter((id) => !agents.some((a) => a.id === id)).length };
}

export function rowText(row: Row): string {
  const text = row.archivedTo ? `${progressText(row)}; what was there is kept at ${row.archivedTo}` : progressText(row);
  return row.section === 'transfer' && row.notice ? `${text}; ${row.notice}` : text;
}

function progressText(row: Row): string {
  if (row.error) return row.error;
  if (row.section === 'resume') return row.notice ? `resumed; ${row.notice}` : 'resumed';
  if (row.section === 'rest') return row.total !== undefined && row.done === row.total ? 'at rest' : 'resting…';
  if (row.totalBytes !== undefined) return `${formatBytes(row.bytes ?? 0)} of ${formatBytes(row.totalBytes)}`;
  return row.total !== undefined ? `${row.done ?? 0} of ${row.total} files` : 'waiting…';
}

const label = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.label;

const notKnown = (destination: string, why: string) => `Whether the fleet moved to ${destination} is not known yet: ${why}.`;
const NOT_ASKED = 'The gateway could not be asked whether a handover of this fleet is open.';
const SUPERSEDED = "The gateway has moved on past this handover. Forget drops this Mac's record of it.";
const lostLine = (destination: string) =>
  `The fleet moved to ${destination}, but ${destination}'s handover record is unreadable. Nothing is safe until it is put back or the fleet is recovered.`;

/** Why a run that stopped has nothing safe, where its stop says more than its error. */
function stopLine(r: Extract<Outcome, { status: 'interrupted' }>, destination: string): string | undefined {
  switch (stopOf(r)) {
    case 'commit_unknown': return notKnown(destination, 'the gateway has not answered');
    case 'gateway_unknown': return r.transactionId ? notKnown(destination, 'the gateway could not be asked') : NOT_ASKED;
    case 'journal_lost': return lostLine(destination);
    case 'superseded': return SUPERSEDED;
    default: return undefined;
  }
}

/** Where a status leaves the handover, from its standing, safe actions and phase; its reason names ids and generations. */
function standingLine(s: Verdict, destination: string): string {
  switch (s.standing) {
    case 'open':
      return `${s.phase === 'aborted' ? 'An abort stopped part way' : `Stopped at ${label(SECTIONS[sectionAt(s.phase ?? 'begin')].id)}`}, before the commit: the fleet has not moved.`;
    case 'committed': case 'moved':
      if (!s.safe.length) return lostLine(destination);
      return s.standing === 'committed'
        ? `The fleet is ${destination}'s now, and stopped before its robots resumed there.`
        : `The fleet runs on ${destination} now; what the handover left open there is still to finish.`;
    case 'returned': return 'The gateway let go of this handover; the fleet stays where it was. Abort finishes letting go.';
    case 'superseded': return SUPERSEDED;
    case 'unknown': return s.transactionId ? notKnown(destination, 'the gateway has not answered') : NOT_ASKED;
    case 'none': return s.safe.includes('abort') ? 'The gateway never began this handover; nothing moved. Abort clears what is left of it.' : 'No handover of this fleet is open.';
  }
}

/** The sheet's one line on where the handover stands. `destination` is the machine it goes to, by name. */
export function headline(run: HandoverRun, destination: string): string {
  const s = verdictOf(run);
  if (s) return standingLine(s, destination);
  const r = run.result;
  switch (r?.status) {
    case 'complete': {
      const failed = r.robots.filter((c) => !c.ok).length;
      return [
        `The fleet runs on ${destination} now.`,
        failed ? `${failed} ${failed === 1 ? 'robot' : 'robots'} did not resume.` : '',
        r.pending?.length ? `${r.pending.join(' and ')} has not heard that it finished${r.error ? ` (${r.error})` : ''}; Retry tells it.` : '',
      ].filter(Boolean).join(' ');
    }
    case 'aborted': return 'Stopped before the commit: the fleet stays where it was.';
    case 'blocked': {
      const n = r.blockers.length;
      return `${n} ${n === 1 ? 'thing' : 'things'} to settle before the fleet moves to ${destination}. Nothing has moved.`;
    }
    case 'interrupted':
      return stopLine(r, destination) ?? (isCommitted(run)
        ? `The fleet is ${destination}'s now, and it stopped while resuming: ${r.error}`
        : `Stopped at ${label(SECTIONS[sectionAt(r.phase === 'aborted' ? run.phase ?? 'begin' : r.phase)].id)}: ${r.error}`);
    case 'detached': return `The fleet is moving to ${destination} without this window watching.`;
    case 'ready': return `Nothing stops the move to ${destination}, and nothing has moved yet.`;
    case 'none': return 'There was no handover of this fleet to resume or abort.';
  }
  if (run.error) return `The helper did not run: ${run.error}`;
  if (decisionPending(run)) {
    const n = run.decision!.blockers.length;
    return `${n === 1 ? 'One thing' : `${n} things`} to decide before the fleet goes on.`;
  }
  if (!live(run)) return run.stopped ? 'Could not read where the handover stands.' : '';
  if (run.aborting) return 'Stopping: the fleet goes back to where it was…';
  if (run.checking) return 'Asking where the handover stands…';
  if (!run.phase && !run.preflight) return run.to ? 'Starting…' : 'Looking for a handover…';
  const now = run.goingOn ? `The fleet is ${destination}'s now, so the sheet resumes it there by itself…` : `${label(SECTIONS[sectionAt(run.phase ?? 'begin')].id)}…`;
  return run.retry ? `${now} asking again (attempt ${run.retry.attempt}): ${run.retry.error}` : now;
}

export const destinationName = (to: string | undefined): string => (to === 'local' ? 'This Mac' : to ?? 'the other machine');
