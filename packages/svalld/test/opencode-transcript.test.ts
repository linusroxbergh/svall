import { describe, expect, it } from 'vitest';
import { condenseTurnsOpencode, userPromptsOpencode } from '../src/agent/opencode-transcript.js';

const log = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const turn = log(
  { kind: 'user', text: 'fix the flaky test' },
  { kind: 'tool', name: 'bash', given: '{"command":"pnpm test"}' },
  { kind: 'output', printed: 'see https://ci.example.com/run/7' },
  { kind: 'agent', text: 'fixed' },
);

describe('the OpenCode session log', () => {
  it('reads as turns, tool calls riding on the agent line', () => {
    expect(condenseTurnsOpencode(turn, 10)).toBe('USER: fix the flaky test\nAGENT: [tool: bash] fixed');
    expect(condenseTurnsOpencode(turn, 10, { toolLinks: true })).toBe('USER: fix the flaky test\nAGENT: [tool: bash] fixed [links: https://ci.example.com/run/7]');
  });
  it('lists prompts newest first, the hook\'s prompt leading until the log holds it', () => {
    const two = turn + log({ kind: 'user', text: 'now the docs' });
    expect(userPromptsOpencode(two, 5)).toEqual(['now the docs', 'fix the flaky test']);
    expect(userPromptsOpencode(turn, 5, { id: 'msg_2', text: 'now the docs', at: 1 })).toEqual(['now the docs', 'fix the flaky test']);
  });
  it('skips a partial first line and lines of another shape', () => {
    const tail = '{"kind":"us' + '\n' + log({ kind: 'user' }, { kind: 'tool' }, { kind: 'agent', text: 'ok' });
    expect(condenseTurnsOpencode(tail, 10)).toBe('AGENT: ok');
  });
});
