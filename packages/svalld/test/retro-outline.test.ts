import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { outlineClaude } from '../src/agent/claude-outline.js';
import { outlineCodex } from '../src/agent/codex-outline.js';
import { outlineOpencode } from '../src/agent/opencode-outline.js';
import { CLIP } from '../src/retro/outline.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'retro');
const file = path.join(dir, 'claude-session.jsonl');
const claude = fs.readFileSync(file, 'utf8');
const subagent = fs.readFileSync(path.join(dir, 'claude-subagent.jsonl'), 'utf8');
const span = { from: Date.parse('2026-10-20T00:00:00Z'), to: Date.parse('2026-10-28T00:00:00Z') };
const at = (time: string) => Date.parse(`2026-10-26T${time}Z`);
const line = (o: unknown) => JSON.stringify(o) + '\n';
const user = (content: unknown, timestamp: string, extra = {}) => line({ type: 'user', message: { role: 'user', content }, timestamp, ...extra });
const assistant = (content: unknown[], timestamp: string) => line({ type: 'assistant', message: { model: 'claude-opus-5-5', content }, timestamp });

describe('outlineClaude', () => {
  it("drops a resumed session's turns before the span", () => {
    const o = outlineClaude(claude, file, span);
    expect(o).toMatchObject({ agent: 'claude', session: 'claude-session', file, model: 'claude-opus-5-5', cwd: '/w', branch: 'feat' });
    expect(o.prompts.map((t) => t.text)).toEqual([
      'please run the tests, then API_TOKEN=[redacted] for the deploy', '/ship-it', "don't force anything, open a PR instead", 'thanks, also update the changelog',
    ]);
    expect(o.turns.some((t) => t.text.includes('old'))).toBe(false);
    expect([o.start, o.end]).toEqual([at('09:00:00.000'), at('09:07:10.000')]);
    // the session's cost since it was resumed, by what it had cost before
    expect(o.costUsd).toBe(2.5);

    const old = outlineClaude(claude, file, { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-02T00:00:00Z') });
    expect(old.prompts.map((t) => t.text)).toEqual(['an old question from before the span']);
    expect([old.model, old.branch, old.costUsd]).toEqual(['claude-sonnet-5-5', 'main', 1.5]);
  });

  it("counts a subagent file's tools with its parent", () => {
    const alone = outlineClaude(claude, file, span);
    const both = outlineClaude(claude, file, span, [subagent]);
    expect([alone.tools, alone.errors]).toEqual([3, 1]);
    // the subagent's call from before the span is not counted
    expect([both.tools, both.errors]).toEqual([5, 2]);
    expect(both.turns).toEqual(alone.turns);
  });

  it('never parses an api-request-blob line', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const o = outlineClaude(claude, file, span, [subagent]);
      expect(o.prompts).toHaveLength(4);
      const parsed = parse.mock.calls.map(([s]) => String(s));
      expect(parsed.some((s) => s.startsWith('{"type":"api-request'))).toBe(false);
      expect(parsed.some((s) => s.startsWith('{"type":"mode"'))).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });

  it('a skill run followed by an interrupt is marked interrupt', () => {
    const o = outlineClaude(claude, file, span);
    // typed as /ship-it, it runs from that prompt to the next
    expect(o.skills[0]).toEqual({ name: 'ship-it', line: 10, at: at('09:00:30.000'), end: at('09:05:00.000'), next: 'interrupt', replyMs: 240_000 });
    expect(o.skills.map((s) => s.name)).toEqual(['ship-it', 'babysit-pr']);
    expect([o.interrupts, o.rejected, o.hookErrors]).toEqual([2, 1, 1]);
    expect(o.turns.filter((t) => t.role === 'error').map((t) => t.text)).toEqual(['[rejected] Bash', 'Exit code 1\nFAIL test/one.test.ts']);
    // a rejected command never ran
    expect(o.commands).toEqual([{ text: 'pnpm test', failed: true }]);
  });

  it('a reply within two minutes is marked reply', () => {
    expect(outlineClaude(claude, file, span).skills[1]).toEqual({
      name: 'babysit-pr', line: 16, at: at('09:05:05.000'), end: at('09:07:00.000'), next: 'reply', replyMs: 60_000,
    });
    const slow = user('go', '2026-10-26T09:00:00.000Z', { origin: { kind: 'human' } })
      + assistant([{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'babysit-pr' } }], '2026-10-26T09:00:05.000Z')
      + assistant([{ type: 'text', text: 'Watching.' }], '2026-10-26T09:01:00.000Z')
      + user('and now?', '2026-10-26T09:04:00.000Z', { origin: { kind: 'human' } });
    const [run] = outlineClaude(slow, file, span).skills;
    expect(run.next).toBeUndefined();
    expect(run.replyMs).toBe(180_000);
  });

  it('clips agent text to 1500 and tool input to 300 and drops tool output', () => {
    const text = user('go', '2026-10-26T09:00:00.000Z', { origin: { kind: 'human' } })
      + assistant([{ type: 'text', text: 'a'.repeat(5000) }], '2026-10-26T09:00:01.000Z')
      + assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x'.repeat(1000) } }], '2026-10-26T09:00:02.000Z')
      + user([{ type: 'tool_result', tool_use_id: 't1', content: 'OUTPUT-MARKER' }], '2026-10-26T09:00:03.000Z')
      + user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'e'.repeat(1000) }], '2026-10-26T09:00:04.000Z');
    const o = outlineClaude(text, file, span);
    const [agent, tool, error] = o.turns.slice(1);
    expect(agent).toMatchObject({ role: 'agent', line: 2 });
    expect(agent.text).toHaveLength(CLIP.text);
    expect(tool.text.startsWith('Read {"file_path":"xxx')).toBe(true);
    expect(tool.text).toHaveLength('Read '.length + CLIP.input);
    expect(error.text).toHaveLength(CLIP.error);
    expect(o.turns.some((t) => t.text.includes('OUTPUT-MARKER'))).toBe(false);
  });

  it('finds PR links', () => {
    // one in what the agent said, one Claude Code noted for the session
    expect(outlineClaude(claude, file, span).prs).toEqual(['https://github.com/acme/app/pull/42', 'https://github.com/acme/app/pull/43']);
    const said = assistant([{ type: 'text', text: 'see https://github.com/acme/app/pull/42#discussion_r1 and https://github.com/acme/app/pull/42.' }], '2026-10-26T09:00:01.000Z');
    expect(outlineClaude(said, file, span).prs).toEqual(['https://github.com/acme/app/pull/42']);
  });
});

describe('outlineCodex', () => {
  const rollout = path.join(dir, 'codex-rollout.jsonl');
  const text = fs.readFileSync(rollout, 'utf8');

  it('codex: a SKILL.md read is a skill run and cost is missing', () => {
    const o = outlineCodex(text, rollout, span);
    expect(o).toMatchObject({ agent: 'codex', session: '01a1c0de-0000-7000-8000-000000000001', model: 'gpt-5.5', cwd: '/w/app', branch: 'fix-lint' });
    expect(o.costUsd).toBeUndefined();
    // a $name in a prompt runs that skill too; both end where the next prompt starts
    expect(o.skills).toEqual([
      { name: 'ship-it', line: 5, at: Date.parse('2026-10-26T10:00:01.000Z'), end: Date.parse('2026-10-26T10:01:00.100Z'), next: 'interrupt', replyMs: 40_100 },
      { name: 'review', line: 7, at: Date.parse('2026-10-26T10:00:03.000Z'), end: Date.parse('2026-10-26T10:01:00.100Z'), next: 'interrupt', replyMs: 40_100 },
    ]);
    expect(o.prompts.map((t) => t.text)).toEqual(['use $ship-it to land the lint fix', 'stop, just open the PR']);
    expect([o.tools, o.errors, o.interrupts, o.rejected]).toEqual([2, 1, 1, 0]);
    expect(o.commands).toEqual([{ text: 'cat /u/.codex/skills/review/SKILL.md', failed: false }, { text: 'pnpm lint', failed: true }]);
    expect(o.prs).toEqual(['https://github.com/acme/app/pull/7']);
    expect(o.turns.some((t) => t.text.includes('SKILL-BODY-MARKER') || t.text.includes('environment_context'))).toBe(false);
  });
});

describe('outlineOpencode', () => {
  const exported: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'opencode-export.json'), 'utf8'));

  it('opencode: reads an export', () => {
    const o = outlineOpencode(exported, span);
    expect(o).toMatchObject({ agent: 'opencode', session: 'ses_0123456789abAbCdEfGhIjKlMn', model: 'zen/glm-5', cwd: '/w' });
    expect(o.costUsd).toBeCloseTo(0.3);
    expect(o.prompts.map((t) => [t.line, t.text])).toEqual([[3, 'review the branch before I merge'], [6, 'fix lint first']]);
    // the declined call came before the interrupt
    expect(o.skills).toEqual([{ name: 'deep-review', line: 4, at: 1793012401500, end: 1793012460000, next: 'rejected', replyMs: 55_000 }]);
    expect([o.tools, o.errors, o.interrupts, o.rejected]).toEqual([3, 1, 1, 1]);
    expect(o.commands).toEqual([{ text: 'pnpm lint', failed: true }]);
    expect(o.prs).toEqual(['https://github.com/acme/app/pull/9']);
    expect(o.turns.some((t) => /MARKER|old/.test(t.text))).toBe(false);
  });
});
