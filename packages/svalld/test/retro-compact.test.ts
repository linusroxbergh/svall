import { describe, expect, it } from 'vitest';
import { compact, lineText } from '../src/retro/compact.js';
import { outliner } from '../src/retro/outline.js';

const T = Date.parse('2026-10-26T09:00:00Z');
const head = { agent: 'claude', session: 's1', file: '/t/s1.jsonl' } as const;

// a session that asks, reads two files, edits one, runs a test that passes and one that fails, then says why
function session() {
  const o = outliner();
  o.prompt(1, T, 'fix the spec');
  o.said(2, T + 1, 'Looking.');
  o.tool(3, T + 2, 'Read', { file_path: '/w/a.ts' });
  o.tool(3, T + 2, 'Read', { file_path: '/w/b.ts' }, 1);
  o.tool(4, T + 3, 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' });
  o.ran(o.tool(5, T + 4, 'Bash', { command: 'pnpm test' }), 6, T + 5, 'pnpm test', { failed: false });
  const rspec = o.tool(7, T + 6, 'Bash', { command: 'bundle exec rspec x_spec.rb' });
  o.ran(rspec, 8, T + 7, 'bundle exec rspec x_spec.rb', { failed: true, exit: 1, out: '\nRedis::CannotConnectError: Error connecting to Redis on 127.0.0.1:6379\n  from x' });
  o.said(9, T + 8, 'Redis is down.');
  return o;
}

describe('compact', () => {
  it('folds a run of tools into one line with counts, files and command marks', () => {
    expect(compact(session().outline(head)).map(lineText)).toEqual([
      'L1.0 USER: fix the spec',
      'L2.0 AGENT: Looking.',
      'L3.0–7.0 TOOLS Read×2 Edit (a.ts, b.ts) · ✓ pnpm test · ✗(1) bundle exec rspec x_spec.rb → "Redis::CannotConnectError: Error connecting to Redis on 127.0.0.1:6379"',
      'L9.0 AGENT: Redis is down.',
    ]);
  });

  it('keeps subagent results, PR bodies, rejections and interrupts as lines of their own, and names a skill call', () => {
    const o = outliner();
    o.prompt(1, T, 'review it');
    const skill = o.tool(2, T + 1, 'Skill', { skill: 'work-review' });
    o.skill('work-review', 2, T + 1, { id: skill.id });
    o.tool(3, T + 2, 'Grep', { pattern: 'x' });
    o.error(4, T + 3, 'String to replace not found in file.\nmore');
    o.subagent(5, T + 4, 'code-reviewer', 'Two findings.');
    o.tool(6, T + 5, 'Bash', { command: 'gh pr comment 7 --body "LGTM"' });
    o.rejected(7, T + 6, 'Bash');
    o.interrupt(8, T + 7);
    o.ran(undefined, 9, T + 8, 'cat a/skills/review/SKILL.md', { failed: false });
    o.skill('review', 9, T + 8, { id: 'L9.0', inferred: true });
    expect(compact(o.outline(head)).map(lineText)).toEqual([
      'L1.0 USER: review it',
      'L2.0 SKILL work-review',
      'L3.0–4.0 TOOLS Grep · ✗ String to replace not found in file.',
      'L5.0 SUBAGENT code-reviewer: Two findings.',
      'L6.0 GH_BODY: Bash {"command":"gh pr comment 7 --body \\"LGTM\\""}',
      'L7.0 REJECTED Bash',
      'L8.0 USER: [interrupted]',
      'L9.0 SKILL review (inferred)',
    ]);
  });

  it('covers every turn once, in order', () => {
    const o = session().outline(head);
    expect(compact(o).flatMap((l) => l.ids)).toEqual(o.turns.map((t) => t.id));
    expect(compact(o).map((l) => l.at)).toEqual([T, T + 1, T + 2, T + 8]);
  });

  it('lists every failure and fills up to eight commands with the rest, then says how many more', () => {
    const o = outliner();
    for (let i = 1; i <= 12; i++) o.ran(o.tool(i, T + i, 'Bash', { command: `step ${i}` }), i, T + i, `step ${i}`, { failed: i === 11, exit: 2 });
    expect(compact(o.outline(head)).map(lineText)).toEqual([
      'L1.0–12.0 TOOLS · ✓ step 1 · ✓ step 2 · ✓ step 3 · ✓ step 4 · ✓ step 5 · ✓ step 6 · ✓ step 7 · ✗(2) step 11 · +4 more',
    ]);
  });

  it('marks a shell call with no result yet, and clips a long command', () => {
    const o = outliner();
    o.tool(1, T, 'Bash', { command: 'x' });
    o.ran(o.tool(2, T, 'Bash', { command: 'y' }), 2, T, `echo ${'a'.repeat(200)}`, { failed: false });
    const [line] = compact(o.outline(head)).map(lineText);
    expect(line).toBe(`L1.0–2.0 TOOLS Bash · ✓ echo ${'a'.repeat(74)}…`);
  });
});
