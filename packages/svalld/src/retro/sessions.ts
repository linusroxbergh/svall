import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AgentKind, type Robot, type TerminalSlot } from '@svall/protocol';
import { jsonLines } from '../agent/jsonl.js';

/** One line of retro/sessions.ndjson: the first for a session says where it ran, a later one only what changed since. */
export const SessionLine = z.object({
  at: z.number(), session: z.string(),
  robot: z.string().optional(), island: z.string().optional(), cwd: z.string().optional(), repo: z.string().optional(), branch: z.string().optional(),
  agent: AgentKind.optional(), model: z.string().optional(), transcript: z.string().optional(), end: z.number().optional(),
});
export type SessionLine = z.infer<typeof SessionLine>;
/** A session as its lines add up, with when its first line was written. */
export type SessionRecord = SessionLine & { start: number };

const started = (c: Robot, slot: TerminalSlot, at: number): SessionLine => {
  const a = slot.agent!;
  return {
    at, session: a.sessionId, robot: c.id, island: c.islandId, cwd: slot.cwd,
    ...(c.repo && { repo: c.repo.mainRoot, branch: c.repo.branch }),
    agent: a.kind, ...(a.model && { model: a.model }), ...(a.transcriptPath && { transcript: a.transcriptPath }),
  };
};

// what changed in one terminal: a session that took it, one that left it, or a model or transcript that moved
function slotLines(c: Robot | undefined, was: TerminalSlot | undefined, now: TerminalSlot | undefined, at: number): SessionLine[] {
  const [a, b] = [was?.agent, now?.agent];
  if (a?.sessionId === b?.sessionId) {
    if (!a || !b) return [];
    const moved = { ...(b.model !== a.model && b.model && { model: b.model }), ...(b.transcriptPath !== a.transcriptPath && b.transcriptPath && { transcript: b.transcriptPath }) };
    return Object.keys(moved).length ? [{ at, session: b.sessionId, ...moved }] : [];
  }
  return [...(a ? [{ at, session: a.sessionId, end: at }] : []), ...(b && c && now ? [started(c, now, at)] : [])];
}

/** The lines a robot's change from `before` to `after` adds, for its main terminal and its second. */
export const sessionLines = (before: Robot | undefined, after: Robot | undefined, at: number): SessionLine[] =>
  [...slotLines(after, before, after, at), ...slotLines(after, before?.second, after?.second, at)];

/** A line for each session a robot holds now. */
export const currentLines = (robots: Robot[], at: number): SessionLine[] =>
  robots.flatMap((c) => [c, c.second].flatMap((slot) => (slot?.agent ? [started(c, slot, at)] : [])));

export function appendSessions(file: string, lines: SessionLine[]): void {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
}

/** Each session the file records, its lines folded in order; a line of another shape is skipped. */
export function readSessions(file: string): Map<string, SessionRecord> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  const out = new Map<string, SessionRecord>();
  for (const raw of jsonLines<unknown>(text)) {
    const line = SessionLine.safeParse(raw).data;
    if (!line) continue;
    const had = out.get(line.session);
    const next: SessionRecord = { ...had, ...line, start: had?.start ?? line.at };
    // a session that takes a slot again, as a resume elsewhere does, has not ended
    if (line.robot && line.end === undefined) delete next.end;
    out.set(line.session, next);
  }
  return out;
}
