import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { condenseTurnsClaude as condenseTurns, interruptedAt, userPromptsClaude as userPrompts } from '../src/agent/claude-transcript.js';
import { readTail, recordedCwd } from '../src/agent/transcript.js';
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
  it('lists a prompt sent mid-turn, which reaches the turn as a queued command, and no command queued by anyone else', () => {
    const queued = (prompt: unknown, commandMode: string, origin: unknown) =>
      line({ type: 'attachment', attachment: { type: 'queued_command', prompt, commandMode, origin } });
    const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
    const text =
      typed('first') + toolResult +
      queued('mid-turn', 'prompt', { kind: 'human' }) +
      queued([{ type: 'text', text: 'with an image' }, { type: 'image' }], 'prompt', { kind: 'human' }) +
      queued('from a peer', 'prompt', { kind: 'peer' }) +
      queued('<task-notification>done</task-notification>', 'task-notification', { kind: 'task-notification' });
    expect(userPrompts(text, 10)).toEqual(['with an image', 'mid-turn', 'first']);
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
  const notice = '<task-notification>\n<task-id>a1</task-id>\n</task-notification>';
  const notified = (id: string) => line({
    type: 'user', origin: { kind: 'task-notification' }, promptId: id, timestamp: new Date(90).toISOString(), message: { role: 'user', content: notice },
  });
  it('drops a reported prompt that opened a turn nobody typed', () => {
    expect(userPrompts(written('p1', 'first', 80) + notified('p2'), 10, hooked('p2', notice))).toEqual(['first']);
  });
  // the hook names the turn a prompt came in, so one sent mid-turn reports the id of the prompt that opened that turn
  const midTurn = (text: string) => line({
    type: 'attachment', timestamp: new Date(95).toISOString(),
    attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } },
  });
  const toolResult = (id: string) => line({ type: 'user', promptId: id, timestamp: new Date(105).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
  it('leads with a prompt sent mid-turn until the turn takes it as a queued command', () => {
    const turn = written('p1', 'first', 90) + toolResult('p1');
    expect(userPrompts(turn, 10, hooked('p1', 'second'))).toEqual(['second', 'first']);
    expect(userPrompts(turn + midTurn('second'), 10, hooked('p1', 'second'))).toEqual(['second', 'first']);
  });
  it('leads with a prompt queued mid-turn until it opens the next turn', () => {
    const turn = written('p1', 'first', 90);
    expect(userPrompts(turn, 10, hooked('p1', 'second'))).toEqual(['second', 'first']);
    expect(userPrompts(turn + written('p2', 'second', 120), 10, hooked('p1', 'second'))).toEqual(['second', 'first']);
  });
  it('leads with a prompt sent mid-turn into a turn nobody typed', () => {
    expect(userPrompts(written('p1', 'first', 80) + notified('p2') + toolResult('p2'), 10, hooked('p2', 'mine'))).toEqual(['mine', 'first']);
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
  it('pairs a reported slash command with its entry when its args hold a tag', () => {
    const entry = line({
      type: 'user', origin: { kind: 'human' }, promptId: 'p2', timestamp: new Date(90).toISOString(),
      message: { role: 'user', content: '<command-message>echoit</command-message>\n<command-name>/echoit</command-name>\n<command-args>fix the <div> bug</command-args>' },
    });
    expect(userPrompts(entry, 10, hooked('p2', '/echoit fix the <div> bug'))).toEqual(['/echoit fix the <div> bug']);
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

describe('recordedCwd', () => {
  const write = (lines: unknown[], pad = ''): string => {
    const f = path.join(makeHome(), 't.jsonl');
    fs.writeFileSync(f, lines.map((l) => `${JSON.stringify(l)}\n`).join('') + pad);
    return f;
  };

  it('reads the folder a Codex rollout last records, from a turn\'s context or the settings a resume applied', () => {
    const meta = { type: 'session_meta', payload: { cwd: '/Users/ada/app' } };
    const turn = { type: 'turn_context', payload: { cwd: '/Users/ada/app/wt' } };
    const resumed = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { cwd: '/home/ada/app' } } };
    const said = { type: 'response_item', payload: { type: 'function_call_output', cwd: '/elsewhere' } };
    expect(recordedCwd('codex', write([meta]))).toBe('/Users/ada/app');
    expect(recordedCwd('codex', write([meta, turn, said]))).toBe('/Users/ada/app/wt');
    expect(recordedCwd('codex', write([meta, turn, resumed, said]))).toBe('/home/ada/app');
  });

  it('reads the folder a Claude transcript\'s last line with one records, past a tail longer than one read', () => {
    const big = `${JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(600 * 1024) } })}\n`;
    expect(recordedCwd('claude', write([{ type: 'user', cwd: '/Users/ada/app' }, { type: 'user', cwd: '/Users/ada/app/sub' }], big))).toBe('/Users/ada/app/sub');
  });

  it('reads no further back than 8 MB, however long the transcript', () => {
    const big = (mb: number) => `${JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(mb * 1024 * 1024) } })}\n`;
    expect(recordedCwd('codex', write([{ type: 'turn_context', payload: { cwd: '/Users/ada/app' } }], big(7)))).toBe('/Users/ada/app');
    expect(recordedCwd('codex', write([{ type: 'turn_context', payload: { cwd: '/Users/ada/app' } }], big(9)))).toBeUndefined();
    expect(recordedCwd('claude', write([{ type: 'summary' }], big(1)))).toBeUndefined();
  });

  it('finds none in a transcript that records none, one that is gone, or an OpenCode log', () => {
    expect(recordedCwd('claude', write([{ type: 'summary' }]))).toBeUndefined();
    expect(recordedCwd('codex', '/nope')).toBeUndefined();
    expect(recordedCwd('opencode', write([{ cwd: '/Users/ada/app' }]))).toBeUndefined();
  });
});

describe('interruptedAt', () => {
  const at = (iso: string, content: unknown, more = {}) => line({ type: 'user', timestamp: iso, message: { role: 'user', content }, ...more });
  it('finds the Esc or "No" that ended a question or a turn, as the newest user entry', () => {
    const asked = assistant([{ type: 'tool_use', name: 'AskUserQuestion', input: {} }]) +
      at('2026-10-11T10:13:39.254Z', [{ type: 'tool_result', is_error: true, content: "The user doesn't want to proceed with this tool use." }]) +
      at('2026-10-11T10:13:39.256Z', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]) +
      line({ type: 'system', subtype: 'turn_duration' });
    expect(interruptedAt(asked)).toBe(Date.parse('2026-10-11T10:13:39.256Z'));
    const cut = '{"partial":\n' + at('2026-10-11T10:20:17.868Z', [{ type: 'text', text: '[Request interrupted by user]' }]);
    expect(interruptedAt(cut)).toBe(Date.parse('2026-10-11T10:20:17.868Z'));
  });
  it('finds none once anything else is the newest user entry, or the mark is a sidechain\'s; a meta entry after it is passed over', () => {
    const esc = at('2026-10-11T10:13:39Z', [{ type: 'text', text: '[Request interrupted by user]' }]);
    expect(interruptedAt(esc + at('2026-10-11T10:14:27Z', 'next prompt'))).toBeUndefined();
    expect(interruptedAt(esc + at('2026-10-11T10:14:28Z', [{ type: 'tool_result', content: 'ok' }]))).toBeUndefined();
    expect(interruptedAt(at('2026-10-11T10:13:39Z', [{ type: 'text', text: '[Request interrupted by user]' }], { isSidechain: true }))).toBeUndefined();
    expect(interruptedAt(esc + at('2026-10-11T10:13:40Z', 'caveat', { isMeta: true }))).toBe(Date.parse('2026-10-11T10:13:39Z'));
    expect(interruptedAt(user('[Request interrupted by user]'))).toBeUndefined();
    expect(interruptedAt('')).toBeUndefined();
  });
});
