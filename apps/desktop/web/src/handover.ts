import {
  HANDOVER_PHASES,
  type Blocker, type EntityData, type HandoverChoices, type HandoverEntityKind, type HandoverEvent, type HandoverPhase, type ManifestSummary, type Names, type Outcome, type SafeAction, type Verdict, type Warning,
} from '@svall/protocol';
import { withoutTokens } from './host.js';

// what `svall handover --json` prints
export type { CharacterResult, EntityData, HandoverEvent, Names, Outcome, SafeAction, Standing, Verdict } from '@svall/protocol';

export type SectionId = 'checks' | 'rest' | 'transfer' | 'commit' | 'resume';
export const SECTIONS: { id: SectionId; label: string; phases: HandoverPhase[] }[] = [
  { id: 'checks', label: 'Checks', phases: ['begin'] },
  { id: 'rest', label: 'Resting characters', phases: ['freeze'] },
  { id: 'transfer', label: 'Transferring files and sessions', phases: ['transfer'] },
  { id: 'commit', label: 'Verifying and committing', phases: ['verify', 'prepare', 'ready', 'commit'] },
  { id: 'resume', label: 'Resuming characters', phases: ['activate', 'complete'] },
];
export type SectionState = 'pending' | 'active' | 'waiting' | 'done' | 'stopped';

type Progress = { done?: number; total?: number; bytes?: number; totalBytes?: number; error?: string; notice?: string; archivedTo?: string };
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
        && optional(d.error, isString) && optional(d.notice, isString) && optional(d.archivedTo, isString);
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
  const next: HandoverRun = { ...run, transactionId: run.transactionId ?? tx, ...(e.event === 'handover.changed' && { decision: undefined }) };
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
  ({ ...run, following: false, ...(error ? { error: withoutTokens(error) } : code !== 0 && !run.result && !run.status ? { error: `the helper exited with code ${code}` } : {}) });

const live = (run: HandoverRun): boolean => run.following && !run.result && !run.status;

export const decisionPending = (run: HandoverRun | undefined): boolean => !!run && live(run) && !!run.decision;

/** A standing the user has something to do about: a step that may follow, or a journal only Forget clears. */
export const needsUser = (v: Verdict): boolean => v.safe.length > 0 || v.standing === 'superseded';

/** A run that stopped sending its commit without hearing whether the gateway took it: only the gateway can say, and nothing is safe until it does. */
const commitUnknown = (r: Outcome | undefined): boolean => r?.status === 'interrupted' && r.phase === 'commit' && r.safe.length === 0;

/** Past the commit: the fleet is the destination's, and only going on is left. */
export function isCommitted(run: HandoverRun): boolean {
  if (run.status) return run.status.standing === 'committed' || run.status.standing === 'moved';
  const r = run.result;
  if (r?.status === 'complete' || r?.status === 'detached') return true;
  if (r?.status === 'interrupted') return step(r.phase) >= step('commit') && !r.safe.includes('abort') && !commitUnknown(r);
  return !!run.phase && step(run.phase) >= step('activate');
}

/** Where the sheet stands, section by section. */
export function sectionStates(run: HandoverRun): { id: SectionId; label: string; state: SectionState }[] {
  const r = run.result;
  const phase = r && 'phase' in r ? r.phase : run.status?.phase ?? run.phase;
  const finished = r?.status === 'complete' || run.status?.standing === 'moved';
  const at = phase && phase !== 'aborted' ? sectionAt(phase) : phase === 'aborted' ? sectionAt(run.phase ?? 'begin') : run.preflight ? 0 : -1;
  const here: SectionState = decisionPending(run) ? 'waiting' : live(run) ? 'active' : 'stopped';
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
  const s = run.status;
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
    default: return { ...none, start: true, follow: !!run.error };
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

export type Choice = 'interrupt' | 'terminate' | 'archive';

/** The one choice that clears a blocker, if one does. */
export function choiceFor(b: Blocker): Choice | undefined {
  if (b.code === 'agent_working' || b.code === 'agent_blocked') return 'interrupt';
  if (b.code === 'shell_busy' || b.code === 'agent_unsettled') return 'terminate';
  if ((b.code === 'destination_diverged' || b.code === 'destination_occupied') && b.entity?.kind === 'root') return 'archive';
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
    default: return choices;
  }
}

export const CHOICE_LABEL: Record<Choice, string> = { interrupt: 'Interrupt and carry', terminate: 'Terminate and carry', archive: 'Archive and carry' };

export type HintContext = { destination: string; source: string; pull: boolean; name(id: string): string };

// a session OpenCode's database went on with; a divergence of files, whatever the agent, ends with the files
const OPENCODE_SESSION = /OpenCode went on with session (ses_[0-9a-f]{12}[0-9A-Za-z]{14}) past the copy coming in$/;

/** What a blocker or warning means for the user, beside what the helper said. */
export function blockerHint(b: Blocker, ctx: HintContext): string | undefined {
  const who = b.entity?.kind === 'character' ? ctx.name(b.entity.id) : 'it';
  switch (b.code) {
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
    default:
      return undefined;
  }
}

/** Who or what an entity is for the user: a character's name, where a root lands and whose a session is, as preflight said, or else its id. */
export function entityLabel(e: Blocker['entity'], name: (id: string) => string, names?: Names): string | undefined {
  if (!e) return undefined;
  if (e.kind === 'character') return name(e.id);
  if (e.kind === 'root') return names?.roots[e.id] ?? `folder ${e.id}`;
  if (e.kind === 'session') return names?.sessions?.[e.id] ? `${names.sessions[e.id]}'s session` : `session ${e.id}`;
  return `repository ${e.id}`;
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

/** The sheet's one line on where the handover stands. `destination` is the machine it goes to, by name. */
export function headline(run: HandoverRun, destination: string): string {
  const s = run.status;
  if (s) return s.reason;
  const r = run.result;
  switch (r?.status) {
    case 'complete': {
      const failed = r.characters.filter((c) => !c.ok).length;
      return [
        `The fleet runs on ${destination} now.`,
        failed ? `${failed} ${failed === 1 ? 'character' : 'characters'} did not resume; retry below.` : '',
        r.pending?.length ? `${r.pending.join(' and ')} has not heard that it finished${r.error ? ` (${r.error})` : ''}; Retry tells it.` : '',
      ].filter(Boolean).join(' ');
    }
    case 'aborted': return 'Stopped before the commit: the fleet stays where it was.';
    case 'blocked': return 'Nothing moved. Settle what is listed, then try again.';
    case 'interrupted':
      if (commitUnknown(r)) return `Whether the fleet moved to ${destination} is not known yet: ${r.error}. Check again asks the gateway.`;
      return isCommitted(run)
        ? `The fleet is ${destination}'s now, and it stopped while resuming: ${r.error}`
        : `Stopped at ${label(SECTIONS[sectionAt(r.phase === 'aborted' ? run.phase ?? 'begin' : r.phase)].id)}: ${r.error}`;
    case 'detached': return `The fleet is moving to ${destination} without this window watching.`;
    case 'none': return r.reason;
  }
  if (run.error) return `The helper did not run: ${run.error}`;
  if (decisionPending(run)) return 'Waiting for your choice.';
  if (!live(run)) return '';
  if (run.aborting) return 'Stopping: the fleet goes back to where it was…';
  if (!run.phase && !run.preflight) return run.to ? 'Starting…' : 'Looking for a handover…';
  const now = `${label(SECTIONS[sectionAt(run.phase ?? 'begin')].id)}…`;
  return run.retry ? `${now} asking again (attempt ${run.retry.attempt}): ${run.retry.error}` : now;
}

export const destinationName = (to: string | undefined): string => (to === 'local' ? 'This Mac' : to ?? 'the other machine');
