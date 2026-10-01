import fs from 'node:fs';
import { bareUrl, type Character, type ContextItem, type Island } from '@svall/protocol';
import { condenseTurns, readTail } from '../agent/transcript.js';
import { carryBrief } from '../context/brief.js';
import { prFirst } from '../context/items.js';
import { Invalid } from '../errors.js';
import type { Logger } from '../log.js';
import { pool } from '../pool.js';
import type { Store } from '../store.js';
import { eligible, type Seen } from './eligible.js';
import {
  CharacterAnswer, DESCRIPTION_MAX, IslandAnswer, NOTE_MAX, SYSTEM_CHARACTER, SYSTEM_ISLAND,
  acceptLine, acceptLinks, acceptName, characterPrompt, islandPrompt, parseAnswer, prEvidence,
} from './prompt.js';
import type { RunScribe } from './run.js';

// at most one automatic pass starts per SPACING_MS; an island waits SETTLE_MS after its last member change
export const SPACING_MS = 60_000;
export const SETTLE_MS = 60_000;
// a failing character waits RETRY_MS, doubling with each failure in a row up to MAX_RETRY_MS
export const RETRY_MS = 10 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;
const TURNS = 40;
const TRANSCRIPT_MAX = 40_000;
const SWEEP_WIDTH = 3;
const SCRIBE_OFF = 'the scribe is off, so nothing was swept; turn it on with the scribe switch in the app\'s settings (Cmd+,)';

type Deps = {
  store: Store; log: Logger; run: RunScribe; now?: () => number;
  // how a character's brief reads; the fleet's carries the docs in scope
  brief: (island: Island, character: Character) => string;
};
type Job = { kind: 'char' | 'island'; id: string };
export type SweepOptions = { names?: boolean; islands?: boolean };

// a path no file can have, too long or with a name too long, holds nothing
const transcriptSize = (c: Character): number => {
  try { return (c.agent?.transcriptPath && fs.statSync(c.agent.transcriptPath, { throwIfNoEntry: false })?.size) || 0; } catch { return 0; }
};

const scribeKey = (items: ContextItem[]): string =>
  items.filter((it) => it.source === 'scribe').map((it) => `${it.ref} ${it.label} ${it.pinned ?? ''}`).join('\n');

// the scribe's own change stays out of the session's next prompt
function carry(c: Character, before: string, after: string): void {
  const brief = c.agent && carryBrief(c.agent.brief, before, after);
  if (brief !== undefined) c.agent!.brief = brief;
}

// keeps names, notes, the links a transcript names, and island descriptions up to date, one headless pass at a time
export class Scribe {
  private seen = new Map<string, Seen>();
  // island id to the time a member last changed
  private dirty = new Map<string, number>();
  private queue: Job[] = [];
  // characters with a pass running, which must not queue again before it records what it saw
  private active = new Set<string>();
  private current?: Promise<unknown>;
  private lastStart = -Infinity;
  // the last sweep asked for, which runs after any before it
  private sweeping?: { key: string; done: Promise<string[]> };

  // what a transcript holds at a daemon start was there for the passes before it; only what it grows by is new
  constructor(private deps: Deps) {
    for (const c of Object.values(deps.store.state.characters)) {
      if (c.agent?.transcriptPath) this.seen.set(c.id, { lastPassAt: 0, path: c.agent.transcriptPath, bytes: transcriptSize(c) });
    }
  }

  /** Drops what the scribe remembers of a character that is gone. */
  forget(id: string): void {
    this.seen.delete(id);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private queued(job: Job): boolean {
    return this.queue.some((j) => j.kind === job.kind && j.id === job.id);
  }

  private due(id: string, now: number): boolean {
    const c = this.deps.store.state.characters[id];
    return !!c && eligible(c, this.seen.get(id), transcriptSize(c), now);
  }

  // called on every fleet poll: queue what is due, and start the next pass once the last one is done and spaced
  tick(): void {
    if (this.off() || this.sweeping) return;
    const now = this.now();
    for (const id of Object.keys(this.deps.store.state.characters)) {
      const job: Job = { kind: 'char', id };
      if (!this.active.has(id) && !this.queued(job) && this.due(id, now)) this.queue.push(job);
    }
    for (const [id, at] of this.dirty) {
      if (now - at < SETTLE_MS) continue;
      this.dirty.delete(id);
      if (!this.queued({ kind: 'island', id })) this.queue.push({ kind: 'island', id });
    }
    if (this.current || now - this.lastStart < SPACING_MS) return;
    // a character queued at rest may be working again, or waiting on the user, by its turn
    let job = this.queue.shift();
    while (job?.kind === 'char' && !this.due(job.id, now)) job = this.queue.shift();
    if (!job) return;
    this.lastStart = now;
    this.current = this.safe(job).finally(() => { this.current = undefined; });
  }

  // a sweep asked for while the same one is waiting or running joins it; a different one runs after it
  sweep(o: SweepOptions = {}): Promise<string[]> {
    if (this.off()) return Promise.reject(new Invalid(SCRIBE_OFF));
    const key = `${!!o.names} ${!!o.islands}`;
    if (this.sweeping?.key === key) return this.sweeping.done;
    const before = this.sweeping?.done;
    const done: Promise<string[]> = (async () => { await before?.catch(() => {}); return this.doSweep(o); })()
      .finally(() => { if (this.sweeping?.done === done) this.sweeping = undefined; });
    this.sweeping = { key, done };
    return done;
  }

  private async doSweep(o: SweepOptions): Promise<string[]> {
    // an automatic pass in flight finishes first, so two passes never write the same character at once
    await this.current;
    if (this.off()) throw new Invalid(SCRIBE_OFF);
    const state = this.deps.store.state;
    const lines: string[] = [];
    if (!o.islands) {
      const ids = Object.values(state.characters).filter((c) => c.tmux && c.agent?.transcriptPath && c.agent.status !== 'blocked').map((c) => c.id);
      this.queue = this.queue.filter((j) => j.kind !== 'char');
      lines.push(...(await pool(ids, SWEEP_WIDTH, (id) => this.safe({ kind: 'char', id }, o.names))).flat());
    }
    if (!o.names) {
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

  private async safe(job: Job, namesOnly?: boolean): Promise<string[]> {
    if (this.off()) return [];
    if (job.kind === 'char') this.active.add(job.id);
    try {
      return job.kind === 'char' ? await this.passCharacter(job.id, namesOnly) : await this.passIsland(job.id);
    } catch (e) {
      const what = job.kind === 'char' ? this.deps.store.state.characters[job.id]?.name : `island ${this.deps.store.state.islands[job.id]?.name}`;
      const { message: head, cause } = e as Error;
      // the child's stderr is shown, and kept out of the log a tester pastes into a bug report
      const message = `${head}${typeof cause === 'string' ? `: ${cause}` : ''}`.split('\n')[0];
      this.deps.log.error(`scribe: ${what ?? job.id}: ${head}`);
      this.deps.store.update((d) => { d.scribeError = { message, at: this.now() }; });
      return [`${what ?? job.id}  failed: ${message}`];
    } finally {
      if (job.kind === 'char') this.active.delete(job.id);
    }
  }

  private async ask(system: string, prompt: string): Promise<string> {
    const text = await this.deps.run(system, prompt);
    if (this.deps.store.state.scribeError) this.deps.store.update((d) => { delete d.scribeError; });
    return text;
  }

  private async passCharacter(id: string, namesOnly?: boolean): Promise<string[]> {
    const state = this.deps.store.state;
    const c = state.characters[id];
    if (!c?.agent?.transcriptPath) return [];
    const path = c.agent.transcriptPath;
    const bytes = transcriptSize(c);
    const tail = readTail(path);
    const transcript = condenseTurns(c.agent.kind, tail, TURNS, { toolLinks: true }).slice(-TRANSCRIPT_MAX);
    if (!transcript.trim()) { this.seen.set(id, { lastPassAt: this.now(), path, bytes }); return []; }
    const others = Object.values(state.characters).filter((o) => o.id !== id).map((o) => o.name);
    const prLinks = prEvidence(c, transcript, tail);
    let answer: CharacterAnswer;
    try {
      answer = parseAnswer(CharacterAnswer, await this.ask(SYSTEM_CHARACTER, characterPrompt(c, transcript, others, prLinks)));
    } catch (e) {
      const last = this.seen.get(id) ?? { lastPassAt: 0, path, bytes: 0 };
      const failures = (last.failures ?? 0) + 1;
      this.seen.set(id, { ...last, failures, retryAt: this.now() + Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS) });
      throw e;
    }
    // a names-only pass leaves this transcript's note and links to the next pass
    if (!namesOnly) this.seen.set(id, { lastPassAt: this.now(), path, bytes });
    return this.writeCharacter(c, answer, [transcript, ...prLinks].join('\n'), namesOnly);
  }

  // each field is written only if nobody changed it while the model was thinking
  private writeCharacter(before: Character, a: CharacterAnswer, transcript: string, namesOnly?: boolean): string[] {
    const lines: string[] = [];
    this.deps.store.update((d) => {
      const cur = d.characters[before.id];
      if (!cur) return;
      const island = d.islands[cur.islandId];
      const prevBrief = island ? this.deps.brief(island, cur) : '';
      const taken = new Set(Object.values(d.characters).filter((o) => o.id !== cur.id).map((o) => o.name));
      const name = cur.name === before.name ? acceptName(cur.name, a.name, taken) : undefined;
      if (name) { lines.push(`${cur.name} → ${name}`); cur.name = name; }
      const note = namesOnly ? undefined : acceptLine(a.note, NOTE_MAX);
      const noted = !!note && note !== cur.note && cur.note === before.note && cur.noteSource !== 'manual';
      if (noted) { cur.note = note; lines.push(`${cur.name}  note: ${note}`); }
      if (!namesOnly && a.links && scribeKey(cur.context) === scribeKey(before.context)) {
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
      if (!lines.length || !island) return;
      carry(cur, prevBrief, this.deps.brief(island, cur));
      if (island.kind !== 'home') this.dirty.set(island.id, this.now());
    });
    return lines;
  }

  private async passIsland(id: string): Promise<string[]> {
    const state = this.deps.store.state;
    const i = state.islands[id];
    if (!i || i.kind === 'home') return [];
    const members = Object.values(state.characters).filter((c) => c.islandId === id);
    if (!members.length) return [];
    const a = parseAnswer(IslandAnswer, await this.ask(SYSTEM_ISLAND, islandPrompt(i, members)));
    const description = acceptLine(a.description, DESCRIPTION_MAX);
    // an island's links come from its members' links, never from a transcript
    const refs = members.flatMap((c) => c.context.map((it) => it.ref)).join('\n');
    const lines: string[] = [];
    this.deps.store.update((d) => {
      const cur = d.islands[id];
      if (!cur) return;
      const crew = Object.values(d.characters).filter((c) => c.islandId === id);
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
