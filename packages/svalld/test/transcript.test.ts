import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { condenseTurnsClaude as condenseTurns, userPromptsClaude as userPrompts } from '../src/agent/claude-transcript.js';
import { readTail } from '../src/agent/transcript.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const line = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });
const assistant = (blocks: unknown[], usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 }) =>
  line({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: blocks, usage } });

describe('condenseTurns', () => {
  it('renders the last N turns with tool names and skips tool results and sidechains', () => {
    const text =
      user('first') +
      assistant([{ type: 'text', text: 'thinking about it' }, { type: 'tool_use', name: 'Bash', input: {} }]) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ignored' }] } }) +
      line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } }) +
      user('second') +
      assistant([{ type: 'text', text: 'done' }]);
    expect(condenseTurns(text, 3)).toBe('CLAUDE: thinking about it [tool: Bash]\nUSER: second\nCLAUDE: done');
  });
  it('adds the URLs tool calls were given or printed when asked', () => {
    const text =
      assistant([{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.example/plan' } }]) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'created\nhttps://github.com/o/r/pull/51.\n' }] } }) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'no links here' }] } });
    expect(condenseTurns(text, 5, { toolLinks: true })).toBe(
      'CLAUDE: [tool: WebFetch] [links: https://docs.example/plan]\nTOOL: [links: https://github.com/o/r/pull/51]');
    expect(condenseTurns(text, 5)).toBe('CLAUDE: [tool: WebFetch]');
  });
  // a /[.,;:!?]+$/ over a long run of dots backtracks from every one of them
  it('reads a tool result with a URL of tens of thousands of dots in one pass', () => {
    const text = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `https://x.test/${'.'.repeat(60_000)}a.` }] } });
    const started = performance.now();
    expect(condenseTurns(text, 1, { toolLinks: true })).toMatch(/^TOOL: \[links: https:\/\/x\.test\/\.+…$/);
    expect(performance.now() - started).toBeLessThan(500);
  });
  it('truncates long entries', () => {
    expect(condenseTurns(user('x'.repeat(5000)), 1)).toHaveLength('USER: '.length + 2000 + 1);
  });
  it('returns nothing for a non-positive turn count', () => {
    expect(condenseTurns(user('hi'), 0)).toBe('');
    expect(condenseTurns(user('hi'), -2)).toBe('');
  });
});

describe('userPrompts', () => {
  const typed = (text: string) => line({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
  const command = (name: string, args = '') =>
    user(`<command-name>${name}</command-name>\n<command-message>x</command-message>\n<command-args>${args}</command-args>`);

  it('returns what the user typed, newest first, with slash commands as they were written', () => {
    const text =
      typed('first') +
      assistant([{ type: 'text', text: 'ok' }]) +
      command('/model', 'opus') +
      line({ type: 'user', origin: { kind: 'human' }, isSidechain: true, message: { role: 'user', content: 'sub-agent' } }) +
      line({ type: 'user', origin: { kind: 'human' }, isMeta: true, message: { role: 'user', content: 'injected' } }) +
      typed('second');
    expect(userPrompts(text, 10)).toEqual(['second', '/model opus', 'first']);
  });
  it('drops everything Claude Code writes into the user stream itself', () => {
    const noise =
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } }) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ignored' }] } }) +
      user('[Request interrupted by user]') +
      user('This session is being continued from a previous conversation…') +
      user('<local-command-stdout>Set model</local-command-stdout>') +
      user('<bash-stdout>Already up to date.</bash-stdout>');
    expect(userPrompts(noise, 10)).toEqual([]);
    expect(userPrompts(typed('mine') + noise, 10)).toEqual(['mine']);
  });
  it('lists the questions the agent asked with what the user answered, in turn with what they typed', () => {
    const result = (toolUseResult: unknown) =>
      line({ type: 'user', toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', content: 'answered' }] } });
    const asked = result({
      questions: [{ question: 'Which port?' }, { question: 'Keep logs?' }],
      answers: { 'Which port?': '8080', 'Keep logs?': 'No' },
    });
    const declined = result('User rejected tool use');
    expect(userPrompts(typed('first') + asked + declined + typed('second'), 10))
      .toEqual(['second', 'Which port?\n→ 8080\n\nKeep logs?\n→ No', 'first']);
  });
  it('keeps only the last N and truncates a long one', () => {
    expect(userPrompts(typed('a') + typed('b') + typed('c'), 2)).toEqual(['c', 'b']);
    expect(userPrompts(typed('x'.repeat(5000)), 1)[0]).toHaveLength(2001);
  });

  // the hook fires at t=100; Claude Code stamps the entry it writes for it a moment later
  const written = (id: string, text: string, at = 110) =>
    line({ type: 'user', origin: { kind: 'human' }, promptId: id, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } });
  const hooked = (id: string, text: string) => ({ id, text, at: 100 });

  it('leads with the prompt the hook reported until the transcript records it', () => {
    const pending = hooked('p2', 'second');
    expect(userPrompts(written('p1', 'first', 90), 10, pending)).toEqual(['second', 'first']);
    expect(userPrompts(written('p1', 'first', 90) + written('p2', 'second'), 10, pending)).toEqual(['second', 'first']);
  });
  it('leads with the reported prompt when the tail no longer reaches it', () => {
    expect(userPrompts('', 10, hooked('p1', 'first'))).toEqual(['first']);
  });
  it('drops a reported prompt a later entry has overtaken', () => {
    expect(userPrompts(written('p2', 'second', 200), 10, hooked('p1', 'first'))).toEqual(['second']);
  });
  it('drops a reported prompt that opened a turn nobody typed', () => {
    const notified = line({
      type: 'user', origin: { kind: 'task-notification' }, promptId: 'p2', timestamp: new Date(110).toISOString(),
      message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' },
    });
    expect(userPrompts(written('p1', 'first', 90) + notified, 10, hooked('p2', '<task-notification>'))).toEqual(['first']);
  });
  it('waits for the entry the user wrote, not another carrying the same id', () => {
    const toolResult = line({ type: 'user', promptId: 'p2', timestamp: new Date(90).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
    expect(userPrompts(toolResult, 10, hooked('p2', 'second'))).toEqual(['second']);
  });
  it('counts a resent prompt by its id, not its text', () => {
    const both = written('p1', 'again', 90) + written('p2', 'again');
    expect(userPrompts(both, 10, hooked('p2', 'again'))).toEqual(['again', 'again']);
    expect(userPrompts(written('p1', 'again', 90), 10, hooked('p3', 'again'))).toEqual(['again', 'again']);
  });
  it('truncates the reported prompt like a written one and keeps the limit', () => {
    expect(userPrompts(written('p1', 'a', 80) + written('p2', 'b', 90), 2, hooked('p3', 'c'))).toEqual(['c', 'b']);
    expect(userPrompts('', 1, hooked('p1', 'x'.repeat(5000)))[0]).toHaveLength(2001);
  });
});

describe('a line of a shape the parser does not know', () => {
  const typed = (text: string) => line({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
  const odd = [
    { type: 'user', origin: { kind: 'human' }, message: { content: { text: 'x' } } },
    { type: 'user', message: { content: 5 } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'https://a.test' }, null] } },
    { type: 'assistant', message: { content: [null, { type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 5 }] } },
  ];

  it('is skipped, and the lines around it still read', () => {
    for (const o of odd) {
      // under the reported prompt's id, so the check for its own entry reads the odd line too
      const text = typed('first') + line({ ...o, promptId: 'p9' }) + typed('second');
      expect(userPrompts(text, 10, { id: 'p9', text: 'third', at: 0 })).toEqual(['third', 'second', 'first']);
      expect(condenseTurns(text, 10, { toolLinks: true })).toBe('USER: first\nUSER: second');
      expect(condenseTurns(text, 10)).toBe('USER: first\nUSER: second');
    }
  });
});

describe('readTail', () => {
  it('returns the last bytes of a file and empty for a missing one', () => {
    const f = path.join(makeHome(), 't.jsonl');
    fs.writeFileSync(f, 'abcdef');
    expect(readTail(f, 3)).toBe('def');
    expect(readTail(f)).toBe('abcdef');
    expect(readTail('/nope')).toBe('');
  });
});
