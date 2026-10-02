import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { condenseTurnsCodex, lastTokenCount, lastWorkdir, userPromptsCodex } from '../src/agent/codex-transcript.js';
import { condenseTurns, userPrompts } from '../src/agent/transcript.js';

const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');
// codex 0.142 writes what was said as user_message and agent_message events; 0.155 writes them as completed items
const text = fixture('rollout.jsonl');
const text155 = fixture('rollout-0.155.jsonl');
const line = (o: unknown) => JSON.stringify(o) + '\n';
const call = line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } });
const said = (message: string) => line({ type: 'event_msg', payload: { type: 'agent_message', message } });

describe('userPromptsCodex', () => {
  it('reads the prompts a person typed, and none of what codex feeds itself', () => {
    expect(userPromptsCodex(text, 5)).toEqual(['recommend me any features to add']);
  });

  it('reads the items a newer codex writes, and neither its environment note nor its developer messages', () => {
    expect(userPromptsCodex(text155, 5)).toEqual(['can you add an island?']);
  });

  it('leads with a prompt an older one only begins like', () => {
    const at = Date.parse('2026-06-22T14:19:49.000Z');
    expect(userPromptsCodex(text, 5, { id: 't2', text: 'recommend me', at })).toEqual(['recommend me', 'recommend me any features to add']);
  });

  it('leads with a prompt the rollout has not written down yet, and drops it once it has', () => {
    const at = Date.parse('2026-06-22T14:19:49.000Z');
    expect(userPromptsCodex(text, 5, { id: 't2', text: 'and now the tests', at })).toEqual(['and now the tests', 'recommend me any features to add']);
    // the hook clips a long prompt and the rollout does not
    const long = 'x'.repeat(5000);
    const landed = text + line({ type: 'event_msg', payload: { type: 'user_message', message: long } });
    expect(userPromptsCodex(landed, 5, { id: 't3', text: long.slice(0, 4000), at })).toHaveLength(2);
    // nor the ends of what it clipped, which the hook leaves to be trimmed
    const spaced = `\n\n${long}`;
    const landedSpaced = text + line({ type: 'event_msg', payload: { type: 'user_message', message: spaced } });
    expect(userPromptsCodex(landedSpaced, 5, { id: 't3', text: spaced.slice(0, 4000).trim(), at })).toHaveLength(2);
  });
});

describe('condenseTurnsCodex', () => {
  it('condenses a turn with both sides, the tool calls on the agent line', () => {
    expect(condenseTurnsCodex(text, 10)).toBe('USER: recommend me any features to add\nAGENT: [tool: shell] Here are the ideas.');
  });

  it('condenses a newer codex turn the same way, a tool call counted once however many lines record it', () => {
    expect(condenseTurnsCodex(text155, 10)).toBe('USER: can you add an island?\nAGENT: [tool: exec] [tool: wait] Yes, I can.');
    expect(condenseTurnsCodex(text155, 1, { toolLinks: true })).toBe('AGENT: [tool: exec] [tool: wait] Yes, I can. [links: https://example.com/doc https://example.com/more]');
  });

  it('keeps what the agent said before its tool calls on the same line, and starts a line for what it says next', () => {
    expect(condenseTurnsCodex(said('Looking.') + call + call + said('Found it.'), 10)).toBe('AGENT: Looking. [tool: shell] [tool: shell]\nAGENT: Found it.');
  });

  it('counts a turn by what was said, not by its tool calls', () => {
    expect(condenseTurnsCodex(call.repeat(12) + text, 2)).toBe(condenseTurnsCodex(text, 2));
  });

  it('adds the urls a tool was given or printed when asked', () => {
    expect(condenseTurnsCodex(text, 1, { toolLinks: true })).toBe('AGENT: [tool: shell] Here are the ideas. [links: https://example.com/doc https://example.com/more]');
    expect(condenseTurnsCodex(text, 10)).not.toContain('example.com');
  });
});

describe('lastTokenCount', () => {
  it('reads what the context holds now, not what the session has spent, and the plan limits', () => {
    const t = lastTokenCount(text)!;
    expect(t.pct).toBe(19);
    expect(t.at).toBe(Date.parse('2026-06-22T14:19:48.200Z'));
    expect(t.limits?.primary?.used_percent).toBe(13);
  });

  it('reads a newer codex the same way', () => {
    expect(lastTokenCount(text155)).toMatchObject({ pct: 54, limits: { primary: { used_percent: 7 } } });
  });

  it('takes the newest reading, and answers nothing for a file with none', () => {
    const later = line({ timestamp: '2026-06-22T15:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 129200 }, model_context_window: 258400 } } });
    expect(lastTokenCount(text + later)?.pct).toBe(50);
    expect(lastTokenCount(line({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }))).toBeUndefined();
    expect(lastTokenCount(line({ type: 'event_msg', payload: { type: 'token_count', info: null } }))).toBeUndefined();
  });
});

describe('lastWorkdir', () => {
  const home = '/repo';
  const ran = (cwd: unknown) => line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['ls'], cwd } } });
  const exec = (args: object) => line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls', ...args }) } });

  it('reads the newest command that ran outside the session directory, as a newer codex records it', () => {
    expect(lastWorkdir(ran('file:///repo/.codex/worktrees/a') + ran('file:///repo/.codex/worktrees/b/web') + ran('file:///repo'), home))
      .toBe('/repo/.codex/worktrees/b/web');
  });

  it('reads the workdir an older codex names in its call, relative to the session directory', () => {
    expect(lastWorkdir(exec({ workdir: '/repo/wt' }) + exec({}), home)).toBe('/repo/wt');
    expect(lastWorkdir(exec({ workdir: 'wt/src' }), home)).toBe('/repo/wt/src');
  });

  it('answers nothing while every command ran in the session directory', () => {
    expect(lastWorkdir(ran('file:///repo') + ran('file:///repo/') + exec({}) + exec({ workdir: '.' }), home)).toBeUndefined();
    expect(lastWorkdir(text155, home)).toBeUndefined();
    expect(lastWorkdir(ran(42) + ran('relative') + call, home)).toBeUndefined();
  });
});

describe('a line of a shape the parser does not know', () => {
  const typed = (message: string) => line({ type: 'event_msg', payload: { type: 'user_message', message } });
  const odd = [
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: 'hi' } } }),
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [null] } } }),
    line({ type: 'event_msg', payload: { type: 'agent_message', message: { text: 'x' } } }),
  ];

  it('is skipped, and the lines around it still read', () => {
    for (const o of odd) {
      const text = typed('first') + o + typed('second');
      expect(userPromptsCodex(text, 10)).toEqual(['second', 'first']);
      expect(condenseTurnsCodex(text, 10, { toolLinks: true })).toBe('USER: first\nUSER: second');
    }
  });
});

describe('the transcript dispatcher', () => {
  const claude = line({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'plant the flag' } });

  it('reads each agent with its own parser, and nothing out of the other one file', () => {
    expect(userPrompts('codex', text, 5)).toEqual(['recommend me any features to add']);
    expect(userPrompts('claude', claude, 5)).toEqual(['plant the flag']);
    expect(userPrompts('claude', text, 5)).toEqual([]);
    expect(userPrompts('codex', claude, 5)).toEqual([]);
    expect(condenseTurns('claude', claude, 5)).toBe('USER: plant the flag');
    expect(condenseTurns('codex', claude, 5)).toBe('');
  });
});
