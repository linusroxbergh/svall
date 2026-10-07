import type { Agent, Blocker, FleetState, HandoverChoices, HandoverIssueCode, TerminalSlot } from '@svall/protocol';
import { markDormant, markSlotDormant, startFlags } from '../dormancy.js';
import { installedScripts } from '../paths.js';
import type { Store } from '../store.js';
import type { TerminalHub } from '../terminals.js';
import { noServer, type LiveWindow, type Tmux } from '../tmux/tmux.js';
import { boundary } from './failpoints.js';
import { ProcessTable, killGroup, type PaneProcesses, type Proc } from './processes.js';
import type { SourceJournal } from './journal.js';
import type { HandoverService } from './service.js';

export type TerminalRef = { characterId: string; term?: 2 };

/** A live terminal as its agent's hooks and its process tree show it together. */
export type TerminalClass = 'agent-ready' | 'agent-working' | 'agent-blocked' | 'shell-ready' | 'foreground';

export type Classified = TerminalRef & { class: TerminalClass; window: LiveWindow; processes: PaneProcesses; agent?: Agent };

/**
 * What the user chose for terminals that are not at rest. Without `interruptAfterMs` no agent is sent
 * Escape; without `terminate` no foreground job is ended.
 */
export type RestChoices = { interruptAfterMs?: number; terminate?: boolean | TerminalRef[] };

/** Every terminal at rest and the ones whose window it closed, or why none was closed. */
export type SettleResult =
  | { ok: true; terminals: TerminalRef[] }
  | { ok: false; blockers: Blocker[] };

/** `sleep` clears its timer when `signal` aborts, and then never resolves. */
export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
const realClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) => new Promise((r) => {
    const timer = setTimeout(r, ms);
    signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }),
};

export type RestDeps = {
  store: Pick<Store, 'state' | 'update' | 'subscribe'>;
  tmux: Pick<Tmux, 'listWindows' | 'sendBytes' | 'killWindow'>;
  viewers: Pick<TerminalHub, 'detach'>;
  journal: Pick<HandoverService, 'journalState' | 'write'>;
  processes?: (signal?: AbortSignal) => Promise<ProcessTable>;
  kill?: (group: number, signal: NodeJS.Signals) => void;
  clock?: Clock;
};

export type RestOptions = {
  choices: RestChoices;
  /** How long a working agent nobody chose to interrupt is waited on. */
  waitMs?: number;
  /** How long an interrupted agent or a terminated job has to come to rest. */
  settleMs?: number;
  /** How often the process tree is read; a hook event in between is judged from state alone. */
  pollMs?: number;
  /** How long one ps or tmux call may take before resting gives up. */
  callTimeoutMs?: number;
  /** Stops the wait. Once windows start closing, resting runs to the end. */
  cancel?: AbortSignal;
};

// inside the freeze call's budget, with room for the settling that follows an interrupt; a later interrupt extends both
const WAIT_MS = 3 * 60_000;
const SETTLE_MS = 10_000;
const POLL_MS = 500;
const CALL_TIMEOUT_MS = 10_000;
const ESCAPE = Buffer.from('\x1b');
// OpenCode interrupts on a second Escape within 5 s, and reads two in one write as one
const ESCAPE_GAP_MS = 200;

/** A protocol choice that names a character covers both of its terminals. */
export function restChoices(c: HandoverChoices): RestChoices {
  const terminate = Array.isArray(c.terminateShells)
    ? c.terminateShells.flatMap((characterId) => [{ characterId }, { characterId, term: 2 as const }])
    : c.terminateShells;
  return { ...(c.interruptAfterMs !== undefined && { interruptAfterMs: c.interruptAfterMs }), ...(terminate !== undefined && { terminate }) };
}

const slotOf = (state: FleetState, t: TerminalRef): TerminalSlot | undefined => {
  const c = state.characters[t.characterId];
  return t.term === 2 ? c?.second : c;
};

const keyOf = (t: TerminalRef): string => (t.term === 2 ? `${t.characterId}-2` : t.characterId);
const refOf = (t: TerminalRef): TerminalRef => ({ characterId: t.characterId, ...(t.term && { term: t.term }) });

function classOf(agent: Agent | undefined, p: PaneProcesses): TerminalClass {
  // an agent whose shell is back at its prompt has exited, whatever its last hook said
  if (!p.foreground.length) return 'shell-ready';
  // the hooks speak for the terminal only while their agent is what holds it
  if (!agent || p.agent?.kind !== agent.kind) return 'foreground';
  if (agent.status === 'working') return 'agent-working';
  if (agent.status === 'blocked') return 'agent-blocked';
  return 'agent-ready';
}

/** Both terminals of every character that still has a window and a process in it. */
export function classifyTerminals(state: FleetState, live: LiveWindow[], table: ProcessTable): Classified[] {
  const byWindow = new Map(live.map((w) => [w.windowId, w]));
  const out: Classified[] = [];
  for (const characterId of Object.keys(state.characters)) {
    for (const t of [{ characterId }, { characterId, term: 2 as const }]) {
      const slot = slotOf(state, t);
      const window = slot?.tmux && byWindow.get(slot.tmux.windowId);
      const processes = window && !window.dead ? table.pane(window.panePid) : undefined;
      if (!slot || !window || !processes) continue;
      out.push({ ...t, class: classOf(slot.agent, processes), window, processes, ...(slot.agent && { agent: slot.agent }) });
    }
  }
  return out;
}

// `groups` are what terminating it signalled: the job holding the terminal, and the groups of its agent's tool commands
type Track = TerminalRef & {
  key: string; agent?: Agent; flags?: string[]; interruptedAt?: number; terminatedAt?: number; killedAt?: number; groups?: number[];
};

// the launch flags the idle close would resume this terminal's agent with; none when its launch cannot be repeated
export function launchFlags(c: Classified): string[] | undefined {
  const p = c.processes.agent;
  const args = p && p.kind === c.agent?.kind ? c.processes.foreground.find((x) => x.pid === p.pid)?.args : undefined;
  return args === undefined ? undefined : startFlags(args, p!.kind);
}
type Step = 'rest' | 'wait' | 'interrupt' | 'terminate' | 'kill' | { blocker: Blocker };
type Moment = {
  choices: RestChoices; start: number; now: number; waitMs: number; settleMs: number; pollMs: number; state: FleetState;
  alive: (group: number) => boolean;
};

const terminates = (t: TerminalRef, choices: RestChoices): boolean =>
  choices.terminate === true || (Array.isArray(choices.terminate) && choices.terminate.some((r) => keyOf(r) === keyOf(t)));

function blocker(code: HandoverIssueCode, c: TerminalRef, state: FleetState, what: string): { blocker: Blocker } {
  const name = state.characters[c.characterId]?.name ?? c.characterId;
  const where = c.term === 2 ? `${name}'s second terminal` : `${name}'s terminal`;
  return { blocker: { code, message: `${where} ${what}`, entity: { kind: 'character', id: c.characterId } } };
}

const job = (c: Classified): string =>
  (c.processes.foreground.find((p) => p.pid === c.processes.group) ?? c.processes.foreground[0]).args;

// what an agent that will not settle still runs, for whoever decides whether to terminate it
const lingering = (c: Classified | undefined): string => {
  const commands = c?.processes.agent?.commands ?? [];
  return commands.length ? `: ${commands.map((p) => p.args).join(', ')} still runs` : '';
};

// what one terminal needs next; decided for every terminal before any of them is touched
function step(t: Track, c: Classified | undefined, x: Moment): Step {
  if (t.terminatedAt !== undefined) {
    // at rest once nothing holds the terminal and none of what was signalled with it still runs
    if ((!c || c.class === 'shell-ready') && !(t.groups ?? []).some(x.alive)) return 'rest';
    if (t.killedAt === undefined) return x.now >= t.terminatedAt + x.settleMs ? 'kill' : 'wait';
    if (x.now < t.killedAt + x.settleMs) return 'wait';
    return c?.class === 'foreground'
      ? blocker('shell_busy', t, x.state, `is still running ${job(c)} after it was terminated`)
      : blocker('agent_unsettled', t, x.state, `did not come to rest after it was terminated${lingering(c)}`);
  }
  if (!c) return 'rest';
  if (c.class === 'shell-ready') return 'rest';
  // a command an idle agent left running in the background is work in progress, as the idle close judges it
  if (c.class === 'agent-ready' && !c.processes.agent?.commands.length) return 'rest';
  if (c.class === 'foreground') return terminates(t, x.choices) ? 'terminate' : blocker('shell_busy', c, x.state, `is running ${job(c)}`);
  if (t.interruptedAt !== undefined) {
    // Claude Code sends no hook for an interrupted turn, so rest shows as its tool commands having ended; OpenCode's plugin reports it
    const reported = c.agent?.kind !== 'opencode' || c.class !== 'agent-working';
    if (x.now - t.interruptedAt >= x.pollMs && reported && !c.processes.agent?.commands.length) return 'rest';
    if (x.now < t.interruptedAt + x.settleMs) return 'wait';
    return terminates(t, x.choices) ? 'terminate' : blocker('agent_unsettled', c, x.state, `did not come to rest after it was interrupted${lingering(c)}`);
  }
  if (c.class === 'agent-ready') {
    return terminates(t, x.choices) ? 'terminate' : blocker('agent_unsettled', c, x.state, `is idle with work still running in the background${lingering(c)}`);
  }
  const { interruptAfterMs } = x.choices;
  if (interruptAfterMs !== undefined && x.now >= x.start + interruptAfterMs) return 'interrupt';
  const blocked = blocker('agent_blocked', c, x.state, `is waiting on an answer${c.agent?.prompt ? `: ${c.agent.prompt}` : ''}`);
  if (c.class === 'agent-blocked' && interruptAfterMs === undefined) return blocked;
  if (x.now < x.start + x.waitMs) return 'wait';
  return c.class === 'agent-blocked' ? blocked : blocker('agent_working', c, x.state, 'is still working');
}

/** What would stop resting before any terminal is touched, for a check that must not change anything. */
export function unapproved(state: FleetState, terminals: Classified[], choices: RestChoices): Blocker[] {
  const x: Moment = { choices, start: 0, now: 0, waitMs: Infinity, settleMs: SETTLE_MS, pollMs: POLL_MS, state, alive: () => false };
  return terminals.flatMap((c) => {
    const s = step({ ...refOf(c), key: keyOf(c) }, c, x);
    return typeof s === 'object' ? [s.blocker] : [];
  });
}

function sourceJournal(journal: RestDeps['journal']): SourceJournal {
  const s = journal.journalState();
  if (s.kind !== 'open' || s.journal.role !== 'source') throw new Error('resting terminals needs the source journal of an open handover');
  return s.journal;
}

function recordJournal(journal: RestDeps['journal'], now: number, change: (j: SourceJournal) => Partial<SourceJournal>): void {
  const j = sourceJournal(journal);
  journal.write({ ...j, ...change(j), updatedAt: now });
}

/**
 * Brings every live terminal of a frozen fleet to rest and closes its window, leaving both slots of
 * every character dormant. It rechecks each terminal before touching any, and returns blockers
 * without closing a window when one is not at rest and the choices do not cover it.
 */
export async function restTerminals(deps: RestDeps, o: RestOptions): Promise<SettleResult> {
  const clock = deps.clock ?? realClock;
  const processes = deps.processes ?? ((signal?: AbortSignal) => ProcessTable.read({ signal, scripts: installedScripts() }));
  const kill = deps.kill ?? killGroup;
  const bounded = boundBy(clock, o.callTimeoutMs ?? CALL_TIMEOUT_MS);
  sourceJournal(deps.journal);
  // an interrupt chosen for later than the wait lasts extends the wait to it
  const waitMs = Math.max(o.waitMs ?? WAIT_MS, o.choices.interruptAfterMs ?? 0);
  const x: Moment = {
    choices: o.choices, start: clock.now(), now: clock.now(), state: deps.store.state,
    waitMs, settleMs: o.settleMs ?? SETTLE_MS, pollMs: o.pollMs ?? POLL_MS, alive: () => false,
  };
  let tracks: Track[] | undefined;
  let seen: { live: LiveWindow[]; table: ProcessTable } | undefined;
  let nextRead = -Infinity;
  let reread = false;
  for (;;) {
    o.cancel?.throwIfAborted();
    let fresh = false;
    if (!seen || reread || clock.now() >= nextRead) {
      const [live, table] = await Promise.all([bounded('tmux list-panes', windows(deps)), bounded('ps', processes)]);
      seen = { live, table };
      nextRead = clock.now() + x.pollMs;
      fresh = true;
    }
    reread = false;
    x.now = clock.now();
    x.state = deps.store.state;
    const { table } = seen;
    x.alive = (group) => table.alive(group);
    const current = new Map(classifyTerminals(x.state, seen.live, seen.table).map((c) => [keyOf(c), c]));
    // a frozen fleet opens no window, so the terminals live at the recheck are all there are
    tracks ??= [...current.entries()].map(([key, c]) => ({ ...refOf(c), key }));
    const steps = tracks.map((t) => ({ t, c: current.get(t.key), s: step(t, current.get(t.key), x) }));
    const blockers = steps.flatMap(({ s }) => (typeof s === 'object' ? [s.blocker] : []));
    const settled = steps.every(({ s }) => s === 'rest');
    const acts = steps.some(({ s }) => s === 'interrupt' || s === 'terminate' || s === 'kill');
    // a hook event is judged from state; whatever it would lead to is decided again on a fresh process tree
    if (!fresh && (blockers.length || settled || acts)) {
      reread = true;
      continue;
    }
    if (blockers.length) return { ok: false, blockers };
    for (const { t, c } of steps) if (c && t.terminatedAt === undefined) { t.agent = c.agent; t.flags = launchFlags(c); }
    if (settled) {
      const gone = (servers: Server[]) => serversGone(servers, { read: () => bounded('ps', processes), kill, clock, journal: deps.journal, state: () => deps.store.state }, x);
      return layToRest(deps, o, bounded, tracks, current, clock.now(), gone);
    }
    for (const { t, c, s } of steps) {
      if (s === 'interrupt' && c) {
        const escape = () => bounded('tmux send-keys', (signal) => deps.tmux.sendBytes(c.window.paneId, ESCAPE, signal));
        await escape();
        if (c.agent?.kind === 'opencode') { await clock.sleep(ESCAPE_GAP_MS); await escape(); }
        t.interruptedAt = x.now;
      } else if (s === 'terminate' && c) {
        // an agent's tool commands and helpers run in groups and sessions of their own, so the job's group alone would leave them running
        const tree = table.tree(c.processes.foreground);
        const groups = (t.groups = [...new Set(tree.map((p) => p.pgid))]);
        const processes = tree.map((p) => p.args);
        boundary('source.rest.terminated', () => recordJournal(deps.journal, x.now, (j) => ({ terminated: [...j.terminated, { ...refOf(t), processes }] })));
        boundary('source.rest.terminate', () => { for (const g of groups) kill(g, 'SIGTERM'); });
        t.terminatedAt = x.now;
      } else if (s === 'kill') {
        boundary('source.rest.forcekill', () => { for (const g of (t.groups ?? []).filter(x.alive)) kill(g, 'SIGKILL'); });
        t.killedAt = x.now;
      }
    }
    await wake(deps.store, clock, nextRead - clock.now(), o.cancel);
  }
}

type Bounded = <T>(what: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

// an OpenCode TUI's private server writes its session's database until it exits, and the export reads that database;
// one that outlasts the settle time is killed with everything it runs, journaled first as a terminated job is, and the
// rest fails if any of it still runs a settle time later
type Server = { t: TerminalRef; server: Proc };
async function serversGone(
  servers: Server[],
  d: { read: () => Promise<ProcessTable>; kill: NonNullable<RestDeps['kill']>; clock: Clock; journal: RestDeps['journal']; state: () => FleetState },
  x: Pick<Moment, 'settleMs' | 'pollMs'>,
): Promise<void> {
  const until = async (groups: number[]): Promise<{ table: ProcessTable; left: number[] }> => {
    for (const end = d.clock.now() + x.settleMs; ;) {
      const table = await d.read();
      const left = groups.filter((g) => table.alive(g));
      if (!left.length || d.clock.now() >= end) return { table, left };
      await d.clock.sleep(x.pollMs);
    }
  };
  if (!servers.length) return;
  const { table, left } = await until(servers.map((s) => s.server.pgid));
  if (!left.length) return;
  const trees = servers.filter((s) => left.includes(s.server.pgid)).map((s) => ({ ...s, tree: table.tree([s.server]) }));
  const groups = [...new Set(trees.flatMap((s) => s.tree.map((p) => p.pgid)))];
  boundary('source.rest.terminated', () => recordJournal(d.journal, d.clock.now(), (j) => ({
    terminated: [...j.terminated, ...trees.map((s) => ({ ...refOf(s.t), processes: s.tree.map((p) => p.args) }))],
  })));
  boundary('source.rest.forcekill', () => { for (const g of groups) d.kill(g, 'SIGKILL'); });
  const after = await until(groups);
  const stuck = trees.filter((s) => s.tree.some((p) => after.left.includes(p.pgid)));
  if (stuck.length) {
    const name = (t: TerminalRef) => `${d.state().characters[t.characterId]?.name ?? t.characterId}'s ${t.term === 2 ? 'second ' : ''}terminal`;
    throw new Error(stuck.map((s) => `${name(s.t)}: ${s.tree.filter((p) => after.left.includes(p.pgid)).map((p) => p.args).join(', ')} still runs after SIGKILL`).join('; '));
  }
}

// a server that died took every window with it, so there is none left to rest
const windows = (deps: RestDeps) => (signal: AbortSignal): Promise<LiveWindow[]> =>
  deps.tmux.listWindows(signal).catch((e: unknown) => { if (noServer(e)) return []; throw e; });

// a hung ps or tmux must fail the rest rather than hold the freeze open, and is told to go
function boundBy(clock: Clock, ms: number): Bounded {
  return async (what, work) => {
    const call = new AbortController();
    const timer = new AbortController();
    const late = Symbol('late');
    try {
      const r = await Promise.race([work(call.signal), clock.sleep(ms, timer.signal).then(() => late)]);
      if (r !== late) return r as Awaited<ReturnType<typeof work>>;
      call.abort();
      throw new Error(`${what} did not answer within ${ms} ms`);
    } finally {
      timer.abort();
    }
  };
}

// the next hook event, the next read of the process tree, or a cancel, whichever comes first
function wake(store: RestDeps['store'], clock: Clock, ms: number, cancel?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = new AbortController();
    const done = () => { unsubscribe(); cancel?.removeEventListener('abort', done); timer.abort(); resolve(); };
    const unsubscribe = store.subscribe(done);
    cancel?.addEventListener('abort', done);
    void clock.sleep(ms, timer.signal).then(done);
  });
}

async function layToRest(
  deps: RestDeps, o: RestOptions, bounded: Bounded, tracks: Track[], current: Map<string, Classified>, now: number,
  gone: (servers: Server[]) => Promise<void>,
): Promise<SettleResult> {
  o.cancel?.throwIfAborted();
  const open = tracks.flatMap((t) => { const c = current.get(t.key); return c ? [{ t, c }] : []; });
  // before any window closes, so an abort knows which terminals the handover stopped
  boundary('source.rest.stopped', () => recordJournal(deps.journal, now, (j) => {
    const known = new Set(j.stoppedTerminals.map(keyOf));
    const added = open.filter(({ t }) => !known.has(t.key)).map(({ t }) => ({ ...refOf(t), ...(t.flags?.length && { flags: t.flags }) }));
    return { stoppedTerminals: [...j.stoppedTerminals, ...added] };
  }));
  for (const id of new Set(open.map(({ t }) => t.characterId))) await bounded('tmux detach-client', (signal) => deps.viewers.detach(id, signal));
  const byKey = new Map(tracks.map((t) => [t.key, t]));
  const { transactionId, stoppedTerminals } = sourceJournal(deps.journal);
  const stopped = new Map(stoppedTerminals.map((s) => [keyOf(s), s]));
  // the agent each terminal carried before the handover stopped it: its exit hook may have taken it since; one whose
  // window a rest that died closed has no track, and keeps the launch flags that rest recorded
  const lay = (d: FleetState, t: TerminalRef, closed = false) => {
    const c = d.characters[t.characterId];
    const slot = c && (t.term === 2 ? c.second : c);
    if (!c || !slot?.tmux) return;
    const { agent, flags } = byKey.get(keyOf(t)) ?? { agent: undefined, flags: stopped.get(keyOf(t))?.flags };
    if (agent) slot.agent = agent;
    if (closed) slot.restedBy = transactionId;
    // a rest the handover chose is no crash: the agent resumes as the handover carries it, without the note on what was lost
    if (t.term !== 2) { markDormant(c, flags); delete c.revive?.interrupted; return; }
    const path = current.get(keyOf(t))?.window.path;
    if (path) slot.cwd = path;
    markSlotDormant(slot, flags);
  };
  // each slot goes dormant as its own window closes, so a later window that will not close strands none of them
  for (const { t, c } of open) {
    await boundary('source.rest.kill', () => bounded('tmux kill-window', (signal) => deps.tmux.killWindow(c.window.windowId, signal)));
    // a kill tmux refused leaves the terminal running: the rest stops there, and an abort or a resume finds it live
    if ((await bounded('tmux list-panes', windows(deps))).some((w) => w.windowId === c.window.windowId && !w.dead)) {
      const name = deps.store.state.characters[t.characterId]?.name ?? t.characterId;
      throw new Error(`${name}'s ${t.term === 2 ? 'second ' : ''}terminal is still open after tmux was asked to close its window ${c.window.windowId}`);
    }
    deps.store.update((d) => lay(d, t, true));
  }
  // and the terminals whose window had already gone, among them any whose window a rest that died closed for this handover
  deps.store.update((d) => {
    for (const id of Object.keys(d.characters)) for (const t of [{ characterId: id }, { characterId: id, term: 2 as const }]) lay(d, t, stopped.has(keyOf(t)));
  });
  await gone(open.flatMap(({ t, c }) => (c.processes.agent?.server ? [{ t, server: c.processes.agent.server }] : [])));
  return { ok: true, terminals: open.map(({ t }) => refOf(t)) };
}
