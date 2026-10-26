import fs from 'node:fs';
import { z } from 'zod';
import { bareUrl, columnOf, placingOn, type Column, type Robot, type ContextItem, type Island } from '@svall/protocol';
import { condenseTurns, readTail } from '../agent/transcript.js';
import { carryBrief } from '../context/brief.js';
import { prFirst } from '../context/items.js';
import { Invalid } from '../errors.js';
import type { Logger } from '../log.js';
import { pool } from '../pool.js';
import type { Store } from '../store.js';
import { eligible, REST_MS, type Seen } from './eligible.js';
import {
  RobotAnswer, DESCRIPTION_MAX, IslandAnswer, NOTE_MAX, SYSTEM_ROBOT, SYSTEM_ISLAND,
  acceptLine, acceptLinks, acceptName, robotPrompt, islandPrompt, parseAnswer, prEvidence,
} from './prompt.js';
import type { RunScribe } from './run.js';

// at most one automatic pass starts per SPACING_MS; an island waits SETTLE_MS after its last member change
export const SPACING_MS = 60_000;
export const SETTLE_MS = 60_000;
// a failing robot waits RETRY_MS, doubling with each failure in a row up to MAX_RETRY_MS
export const RETRY_MS = 10 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
const TURNS = 40;
const TRANSCRIPT_MAX = 40_000;
const SWEEP_WIDTH = 3;
const SCRIBE_OFF = 'the scribe is off, so nothing was swept; turn it on with the scribe switch in the app\'s settings (Cmd+,)';

type Deps = {
  store: Store; log: Logger; run: RunScribe; now?: () => number;
  // whether a pass started now could finish; absent, always
  awake?: () => Promise<boolean>;
  // how a robot's brief reads; the fleet's carries the docs in scope
  brief: (island: Island, robot: Robot) => string;
  // a robot whose transcript is on this machine; absent, every robot's is
  runsHere?: (c: Robot) => boolean;
  // the pass the machine a robot runs on makes over its transcript, when that is another one; undefined when it made none
  far?: (id: string, only?: Only, columns?: Column[], sweep?: true) => Promise<FarPass | undefined>;
};
type Job = { kind: 'robot' | 'island'; id: string };
export type SweepOptions = { names?: boolean; columns?: boolean; islands?: boolean };
// what a sweep's robot pass writes, when not all of it
export type Only = 'names' | 'columns';
/** A pass over a robot's transcript: the model's answer, and the transcript and PR lines it was given. */
export const FarPass = z.object({ answer: RobotAnswer, evidence: z.string() });
export type FarPass = z.infer<typeof FarPass>;

// a path no file can have, too long or with a name too long, holds nothing
const transcriptSize = (c: Robot): number => {
  try { return (c.agent?.transcriptPath && fs.statSync(c.agent.transcriptPath, { throwIfNoEntry: false })?.size) || 0; } catch { return 0; }
};

const scribeKey = (items: ContextItem[]): string =>
  items.filter((it) => it.source === 'scribe').map((it) => `${it.ref} ${it.label} ${it.pinned ?? ''}`).join('\n');

// the scribe's own change stays out of the session's next prompt
function carry(c: Robot, before: string, after: string): void {
  const brief = c.agent && carryBrief(c.agent.brief, before, after);
  if (brief !== undefined) c.agent!.brief = brief;
}

// keeps names, notes, the links a transcript names, and island descriptions up to date, one headless pass at a time
export class Scribe {
  private seen = new Map<string, Seen>();
  // island id to the time a member last changed
  private dirty = new Map<string, number>();
  private queue: Job[] = [];
  // robots with a pass running, which must not queue again before it records what it saw
  private active = new Set<string>();
  private current?: Promise<unknown>;
  private lastStart = -Infinity;
  // the last sweep asked for, which runs after any before it
  private sweeping?: { key: string; done: Promise<string[]> };
  private stopped = false;
  private aborter = new AbortController();

  // what a transcript holds at a daemon start was there for the passes before it; only what it grows by is new
  constructor(private deps: Deps) {
    for (const c of Object.values(deps.store.state.robots)) {
      if (c.agent?.transcriptPath) this.seen.set(c.id, { lastPassAt: 0, path: c.agent.transcriptPath, bytes: transcriptSize(c) });
    }
  }

  /** Drops what the scribe remembers of a robot that is gone. */
  forget(id: string): void {
    this.seen.delete(id);
  }

  /** Starts no more passes and ends the one running; nothing a pass answers from here on reaches the fleet. */
  stop(): void {
    this.stopped = true;
    this.aborter.abort();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private queued(job: Job): boolean {
    return this.queue.some((j) => j.kind === job.kind && j.id === job.id);
  }

  private here(c: Robot): boolean {
    return this.deps.runsHere?.(c) ?? true;
  }

  private due(id: string, now: number): boolean {
    const c = this.deps.store.state.robots[id];
    if (!c) return false;
    // a transcript on another machine is measured there, once its pass is asked for
    if (!this.here(c)) return !!this.deps.far && eligible(c, this.seen.get(id), Number.MAX_SAFE_INTEGER, now);
    return eligible(c, this.seen.get(id), transcriptSize(c), now);
  }

  // called on every fleet poll: queue what is due, and start the next pass once the last one is done and spaced
  tick(): void {
    if (this.stopped || this.off() || this.sweeping) return;
    const now = this.now();
    for (const id of Object.keys(this.deps.store.state.robots)) {
      const job: Job = { kind: 'robot', id };
      if (!this.active.has(id) && !this.queued(job) && this.due(id, now)) this.queue.push(job);
    }
    for (const [id, at] of this.dirty) {
      if (now - at < SETTLE_MS) continue;
      this.dirty.delete(id);
      if (!this.queued({ kind: 'island', id })) this.queue.push({ kind: 'island', id });
    }
    if (this.current || now - this.lastStart < SPACING_MS) return;
    // a robot queued at rest may be working again, or waiting on the user, by its turn
    let job = this.queue.shift();
    while (job?.kind === 'robot' && !this.due(job.id, now)) job = this.queue.shift();
    if (!job) return;
    this.lastStart = now;
    this.current = this.start(job).finally(() => { this.current = undefined; });
  }

  // a pass started in a Mac's dark wake is cut off by its sleep; the job waits for a full wake
  private async start(job: Job): Promise<unknown> {
    if (this.deps.awake && !(await this.deps.awake())) {
      if (!this.queued(job)) this.queue.unshift(job);
      return;
    }
    return this.safe(job);
  }

  /** Resolves once the automatic pass and the sweep in flight have finished. */
  async settled(): Promise<void> {
    while (this.current || this.sweeping) await Promise.allSettled([this.current, this.sweeping?.done]);
  }

  // a sweep asked for while the same one is waiting or running joins it; a different one runs after it
  sweep(o: SweepOptions = {}): Promise<string[]> {
    if (this.off()) return Promise.reject(new Invalid(SCRIBE_OFF));
    const key = `${!!o.names} ${!!o.columns} ${!!o.islands}`;
    if (this.sweeping?.key === key) return this.sweeping.done;
    const before = this.sweeping?.done;
    const done: Promise<string[]> = (async () => { await before?.catch(() => {}); return this.doSweep(o); })()
      .finally(() => { if (this.sweeping?.done === done) this.sweeping = undefined; });
    this.sweeping = { key, done };
    return done;
  }

  private async doSweep(o: SweepOptions): Promise<string[]> {
    // an automatic pass in flight finishes first, so two passes never write the same robot at once
    await this.current;
    if (this.off()) throw new Invalid(SCRIBE_OFF);
    const state = this.deps.store.state;
    const lines: string[] = [];
    const only: Only | undefined = o.names ? 'names' : o.columns ? 'columns' : undefined;
    if (!o.islands) {
      // a robot placed by hand stays where it is
      const ids = Object.values(state.robots).filter((c) => c.tmux && c.agent?.transcriptPath && c.agent.status !== 'blocked' &&
        !(only === 'columns' && c.columnSource === 'manual')).map((c) => c.id);
      this.queue = this.queue.filter((j) => j.kind !== 'robot');
      lines.push(...(await pool(ids, SWEEP_WIDTH, (id) => this.safe({ kind: 'robot', id }, only, true))).flat());
    }
    if (!only) {
      const ids = Object.values(this.deps.store.state.islands).filter((i) => i.kind !== 'home').map((i) => i.id);
      for (const id of ids) this.dirty.delete(id);
      this.queue = this.queue.filter((j) => j.kind !== 'island');
      lines.push(...(await pool(ids, SWEEP_WIDTH, (id) => this.safe({ kind: 'island', id }))).flat());
    }
    return lines;
  }

  // a scribe switched off, or not yet answered, starts no pass
  private off(): boolean {
    const { scribeOff, scribeAsk } = this.deps.store.state;
    return !!(scribeOff || scribeAsk);
  }

  private async safe(job: Job, only?: Only, sweep?: true): Promise<string[]> {
    if (this.stopped || this.off()) return [];
    if (job.kind === 'robot') this.active.add(job.id);
    try {
      return job.kind === 'robot' ? await this.passRobot(job.id, only, sweep) : await this.passIsland(job.id);
    } catch (e) {
      if (this.stopped) return [];
      const what = job.kind === 'robot' ? this.deps.store.state.robots[job.id]?.name : `island ${this.deps.store.state.islands[job.id]?.name}`;
      const { message: head, cause } = e as Error;
      // the child's stderr is shown, and kept out of the log a tester pastes into a bug report
      const message = `${head}${typeof cause === 'string' ? `: ${cause}` : ''}`.split('\n')[0];
      this.deps.log.error(`scribe: ${what ?? job.id}: ${head}`);
      this.deps.store.update((d) => { d.scribeError = { message, at: this.now() }; });
      return [`${what ?? job.id}  failed: ${message}`];
    } finally {
      if (job.kind === 'robot') this.active.delete(job.id);
    }
  }

  private async ask(system: string, prompt: string): Promise<string> {
    const text = await this.deps.run(system, prompt, this.aborter.signal);
    // an answer that came as the fleet stopped is not written, nor is the pass's failure
    if (this.stopped) throw new Error('the scribe has stopped');
    return text;
  }

  private answered(): void {
    if (this.deps.store.state.scribeError) this.deps.store.update((d) => { delete d.scribeError; });
  }

  private failed(id: string, path: string): void {
    const last = this.seen.get(id) ?? { lastPassAt: 0, path, bytes: 0 };
    const failures = (last.failures ?? 0) + 1;
    this.seen.set(id, { ...last, failures, retryAt: this.now() + Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS) });
  }

  private async passRobot(id: string, only?: Only, sweep?: true): Promise<string[]> {
    const state = this.deps.store.state;
    const c = state.robots[id];
    if (!c?.agent?.transcriptPath) return [];
    const columns = only === 'columns' || placingOn(state) ? state.columns : undefined;
    const here = this.here(c);
    const pass = here ? await this.read(c, only, columns) : await this.readFar(c, only, columns, sweep);
    if (!pass) return [];
    this.answered();
    // a column answered without the board in the prompt places nothing
    return this.writeRobot(c, columns ? pass.answer : { ...pass.answer, column: undefined }, pass.evidence, only, here);
  }

  /** The pass a robot's home asked for over its transcript here, which writes nothing: one at rest and grown, or any in a sweep. */
  async readRobot(id: string, only?: Only, columns?: Column[], sweep?: true): Promise<FarPass | undefined> {
    const c = this.deps.store.state.robots[id];
    if (!c?.agent?.transcriptPath || !this.here(c)) return undefined;
    if (!sweep && !eligible(c, this.seen.get(id), transcriptSize(c), this.now())) return undefined;
    return this.read(c, only, columns);
  }

  // undefined for a transcript that holds nothing to pass
  private async read(c: Robot, only?: Only, columns?: Column[]): Promise<FarPass | undefined> {
    const path = c.agent!.transcriptPath!;
    const bytes = transcriptSize(c);
    const tail = readTail(path);
    const transcript = condenseTurns(c.agent!.kind, tail, TURNS, { toolLinks: true }).slice(-TRANSCRIPT_MAX);
    if (!transcript.trim()) { this.seen.set(c.id, { lastPassAt: this.now(), path, bytes }); return undefined; }
    const others = Object.values(this.deps.store.state.robots).filter((o) => o.id !== c.id).map((o) => o.name);
    const prLinks = prEvidence(c, transcript, tail);
    let answer: RobotAnswer;
    try {
      answer = parseAnswer(RobotAnswer, await this.ask(SYSTEM_ROBOT, robotPrompt(c, transcript, others, prLinks, columns)));
    } catch (e) {
      this.failed(c.id, path);
      throw e;
    }
    // a pass that writes only names or columns leaves this transcript's note and links to the next pass
    if (!only) this.seen.set(c.id, { lastPassAt: this.now(), path, bytes });
    return { answer, evidence: [transcript, ...prLinks].join('\n') };
  }

  // a machine that made no pass, being away or finding nothing new, is asked again once a robot at rest would be
  private async readFar(c: Robot, only?: Only, columns?: Column[], sweep?: true): Promise<FarPass | undefined> {
    const path = c.agent!.transcriptPath!;
    let pass: FarPass | undefined;
    try {
      pass = await this.deps.far?.(c.id, only, columns, sweep);
    } catch (e) {
      this.failed(c.id, path);
      throw e;
    }
    if (this.stopped) throw new Error('the scribe has stopped');
    if (!pass) this.seen.set(c.id, { ...(this.seen.get(c.id) ?? { lastPassAt: 0, path, bytes: 0 }), retryAt: this.now() + REST_MS });
    else if (!only) this.seen.set(c.id, { lastPassAt: this.now(), path, bytes: 0 });
    return pass;
  }

  // each field is written only if nobody changed it while the model was thinking; a robot's delivered brief is its machine's
  private writeRobot(before: Robot, a: RobotAnswer, transcript: string, only?: Only, here = true): string[] {
    const lines: string[] = [];
    this.deps.store.update((d) => {
      const cur = d.robots[before.id];
      if (!cur) return;
      const island = d.islands[cur.islandId];
      const prevBrief = island && here ? this.deps.brief(island, cur) : '';
      const taken = new Set(Object.values(d.robots).filter((o) => o.id !== cur.id).map((o) => o.name));
      const name = only !== 'columns' && cur.name === before.name ? acceptName(cur.name, a.name, taken) : undefined;
      if (name) { lines.push(`${cur.name} → ${name}`); cur.name = name; }
      const note = only ? undefined : acceptLine(a.note, NOTE_MAX);
      const noted = !!note && note !== cur.note && cur.note === before.note && cur.noteSource !== 'manual';
      if (noted) { cur.note = note; lines.push(`${cur.name}  note: ${note}`); }
      if (!only && a.links && scribeKey(cur.context) === scribeKey(before.context)) {
        // a PR the scribe takes from the branch's lookup keeps the state that lookup read until the next one
        const states = new Map(cur.context.flatMap((it) => (it.prState ? [[bareUrl(it.ref), it.prState] as const] : [])));
        const links = prFirst(acceptLinks(a.links, transcript, cur.context)).map((l) => {
          const prState = states.get(bareUrl(l.ref));
          return prState ? { ...l, prState } : l;
        });
        const mine = new Set(links.map((l) => bareUrl(l.ref)));
        // an auto chip goes for a PR the scribe now holds, as does the repository one of its PRs is in
        const replaced = (it: ContextItem) => it.source === 'auto' && (mine.has(bareUrl(it.ref)) || (it.kind === 'github' &&
          links.some((link) => link.kind === 'pr' && bareUrl(link.ref).startsWith(`${bareUrl(it.ref).slice(0, -1)}/pull/`))));
        if (scribeKey(links) !== scribeKey(cur.context)) {
          cur.context = prFirst([...cur.context.filter((it) => it.source !== 'scribe' && !replaced(it)), ...links]);
          lines.push(`${cur.name}  links: ${links.map((l) => l.label).join(', ') || 'none'}`);
        }
      }
      if (lines.length && island) {
        if (here) carry(cur, prevBrief, this.deps.brief(island, cur));
        if (island.kind !== 'home') this.dirty.set(island.id, this.now());
      }
      // no brief or island prompt holds the column; a hand move made meanwhile wins
      const wanted = (only === 'columns' || (!only && placingOn(d))) && a.column?.trim().toLowerCase();
      const column = wanted ? d.columns.find((k) => k.name.toLowerCase() === wanted) : undefined;
      if (column && column.id !== columnOf(d, cur).id && cur.column === before.column && cur.columnSource !== 'manual') {
        cur.column = column.id;
        lines.push(`${cur.name}  column: ${column.name}`);
      }
    });
    return lines;
  }

  private async passIsland(id: string): Promise<string[]> {
    const state = this.deps.store.state;
    const i = state.islands[id];
    if (!i || i.kind === 'home') return [];
    const members = Object.values(state.robots).filter((c) => c.islandId === id);
    if (!members.length) return [];
    const a = parseAnswer(IslandAnswer, await this.ask(SYSTEM_ISLAND, islandPrompt(i, members)));
    this.answered();
    const description = acceptLine(a.description, DESCRIPTION_MAX);
    // an island's links come from its members' links, never from a transcript
    const refs = members.flatMap((c) => c.context.map((it) => it.ref)).join('\n');
    const lines: string[] = [];
    this.deps.store.update((d) => {
      const cur = d.islands[id];
      if (!cur) return;
      const crew = Object.values(d.robots).filter((c) => c.islandId === id);
      const prev = new Map(crew.map((c) => [c.id, this.deps.brief(cur, c)]));
      if (description && description !== cur.description && cur.description === i.description && cur.descriptionSource !== 'manual') {
        cur.description = description;
        lines.push(`island ${cur.name}  description: ${description}`);
      }
      if (a.links && scribeKey(cur.context) === scribeKey(i.context)) {
        const links = acceptLinks(a.links, refs, cur.context);
        if (scribeKey(links) !== scribeKey(cur.context)) {
          cur.context = [...cur.context.filter((it) => it.source !== 'scribe'), ...links];
          lines.push(`island ${cur.name}  links: ${links.map((l) => l.label).join(', ') || 'none'}`);
        }
      }
      if (lines.length) for (const c of crew) carry(c, prev.get(c.id)!, this.deps.brief(cur, c));
    });
    return lines;
  }
}
