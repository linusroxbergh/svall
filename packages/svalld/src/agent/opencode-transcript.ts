import type { Pending } from './claude-transcript.js';
import { jsonLines } from './jsonl.js';
import { condenseEvents, promptsOf, type Event } from './turns.js';

// Svall's OpenCode plugin logs each session as the events themselves, one to a line
const valid = (e: Partial<Event> & Record<string, unknown>): boolean =>
  e.kind === 'user' || e.kind === 'agent' ? typeof e.text === 'string' && e.text.trim() !== ''
    : e.kind === 'tool' ? typeof e.name === 'string' : e.kind === 'output';
const events = (text: string): Event[] => jsonLines<Event & Record<string, unknown>>(text).filter(valid);

export const userPromptsOpencode = (text: string, limit: number, pending?: Pending): string[] =>
  promptsOf(events(text).flatMap((e) => (e.kind === 'user' ? [e.text] : [])), limit, pending);

export const condenseTurnsOpencode = (text: string, turns: number, opts: { toolLinks?: boolean } = {}): string =>
  condenseEvents(events(text), turns, opts);
