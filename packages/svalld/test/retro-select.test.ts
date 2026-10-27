import { describe, expect, it } from 'vitest';
import type { Focus } from '@svall/protocol';
import type { Outline, SkillRun, Turn } from '../src/retro/outline.js';
import { prThread, type PrComment } from '../src/retro/prs.js';
import { select } from '../src/retro/select.js';
import type { Target } from '../src/retro/targets.js';

const T0 = Date.parse('2026-10-20T09:00:00Z');
const MIN = 60_000;

// a session whose turns are [role, text] pairs on lines 1, 2, …, a minute apart from `start`
function session(id: string, start: number, turns: [Turn['role'], string][], extra: Partial<Outline> = {}): Outline {
  const ts: Turn[] = turns.map(([role, text], i) => ({ line: i + 1, at: start + i * MIN, role, text }));
  return {
    agent: 'claude', session: id, file: `/t/${id}.jsonl`, start, end: ts.at(-1)?.at ?? start, turns: ts,
    prompts: ts.filter((t) => t.role === 'user' && t.text !== '[interrupted]'), skills: [],
    tools: 0, errors: 0, interrupts: 0, rejected: 0, prs: [], commands: [], hookErrors: 0, ...extra,
  };
}

// a session that runs `skill` at line 2 and is answered at line 4
function runOf(id: string, start: number, skill: string, next?: SkillRun['next']): Outline {
  const s = session(id, start, [['user', `please ${skill}`], ['tool', `Skill {"skill":"${skill}"}`], ['agent', 'done'], ['user', next === 'interrupt' ? 'no, redo it' : 'thanks'], ['agent', 'after']]);
  s.skills = [{ name: skill, line: 2, at: start + MIN, end: start + 3 * MIN, ...(next && { next }) }];
  return s;
}

const target = (name: string, review = false): Target => ({
  id: `skill:${name}`, kind: 'skill', name, path: `/s/${name}/SKILL.md`, realPath: `/s/${name}/SKILL.md`, class: 'local', hash: 'h', review,
});

const pick = (o: { outlines: Outline[]; focus: Focus[]; targets?: Target[]; skillsSeen?: string[]; gh?: boolean; prs?: Map<string, PrComment[]>; prOf?: Map<string, string> }) => select({
  outlines: o.outlines, focus: o.focus, targets: o.targets ?? [], skillsSeen: new Set(o.skillsSeen ?? o.targets?.map((t) => t.name)),
  gh: o.gh ?? true, prs: o.prs ?? new Map(), prOf: o.prOf ?? new Map(),
});

describe('select', () => {
  it('caps a skill at 20 runs, interrupted ones first', () => {
    // the three oldest runs were interrupted
    const outlines = Array.from({ length: 25 }, (_, i) => runOf(`s${i}`, T0 + i * 60 * MIN, 'work-tdd', i < 3 ? 'interrupt' : undefined));
    const { excerpts, runs } = pick({ outlines, focus: ['skill-tweaks'] });
    expect(runs).toEqual({ 'work-tdd': 25 });
    expect(excerpts).toHaveLength(20);
    expect(excerpts.every((e) => e.focus === 'skill-tweaks' && e.skill === 'work-tdd')).toBe(true);
    const ids = excerpts.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['s0:2', 's1:2', 's2:2', 's24:2']));
    // the newest of the rest are kept
    expect(ids).not.toContain('s3:2');
    const top = [...excerpts].sort((a, b) => b.priority - a.priority).slice(0, 3).map((e) => e.id);
    expect(top.sort()).toEqual(['s0:2', 's1:2', 's2:2']);
    // a run is its call to the prompt that ended it
    expect(excerpts.find((e) => e.id === 's0:2')).toMatchObject({
      session: { agent: 'claude', session: 's0' },
      text: 'L2 TOOL: Skill {"skill":"work-tdd"}\nL3 AGENT: done\nL4 USER: no, redo it',
    });
  });

  it('review runs without a PR are left out and thin says so', () => {
    const url = 'https://github.com/o/r/pull/7';
    const linked = runOf('a', T0, 'work-review');
    const unlinked = runOf('b', T0 + 60 * MIN, 'work-review');
    const thread: PrComment[] = [
      { author: 'bot', at: T0, body: 'before the run' },
      { author: 'kim', at: T0 + 10 * MIN, body: 'this leaks the handle', path: 'src/a.ts' },
    ];
    const r = pick({ outlines: [linked, unlinked], focus: ['review-tweaks'], targets: [target('work-review', true)], prs: new Map([[url, thread]]), prOf: new Map([['a', url]]) });
    expect(r.excerpts).toHaveLength(1);
    expect(r.excerpts[0]).toMatchObject({ id: 'a:2', focus: 'review-tweaks', skill: 'work-review', pr: url });
    expect(r.excerpts[0].text).toContain('PR kim on src/a.ts: this leaks the handle');
    expect(r.excerpts[0].text).not.toContain('before the run');
    expect(r.runs).toEqual({ 'work-review': 2 });
    expect(r.thin).toEqual(['review tweaks: 1 review run with a linked PR, 1 without']);

    const off = pick({ outlines: [linked], focus: ['review-tweaks'], targets: [target('work-review', true)], gh: false, prs: new Map([[url, thread]]), prOf: new Map([['a', url]]) });
    expect(off.excerpts).toEqual([]);
    expect(off.thin).toEqual(['review tweaks skipped: gh is not installed or signed in']);
  });

  it('mechanical lists a command that failed in three sessions', () => {
    const failed = (text: string) => ({ text, failed: true });
    const outlines = [
      session('a', T0, [['user', 'ship'], ['error', '[rejected] Bash']], { commands: [failed('git push origin a'), failed('git push -u origin a'), failed('ls /nope')], hookErrors: 2 }),
      session('b', T0, [['user', 'ship'], ['error', '[rejected] Bash']], { commands: [failed('cd /repo && git push'), { text: 'git push', failed: false }], hookErrors: 1 }),
      session('c', T0, [['user', 'ship']], { commands: [failed('GIT_TRACE=1 git push')] }),
    ];
    expect(pick({ outlines, focus: [] }).mechanical).toEqual([
      'hook errors: 3 in 2 sessions',
      'git push failed 4 times in 3 sessions',
      'Bash rejected 2 times in 2 sessions',
    ]);
  });

  it('sends lines that several focuses pick once, and lists unused skills', () => {
    const s = session('a', T0, [['user', 'write the release notes'], ['tool', 'Bash {"command":"gh pr create --title x --body \\"notes\\""}'], ['agent', 'opened the PR'], ['user', 'thanks'], ['agent', 'bye']]);
    const r = pick({ outlines: [s], focus: ['skill-triggers', 'new-skills', 'instructions'], targets: [target('babysit-pr'), target('ship-it')], skillsSeen: ['ship-it'] });
    expect(r.excerpts.map((e) => e.id).sort()).toEqual(['a:1', 'a:2']);
    // the first prompt for triggers and every prompt for new skills, as one excerpt
    expect(r.excerpts.find((e) => e.id === 'a:1')?.text).toBe('L1 USER: write the release notes\nL4 USER: thanks');
    expect(r.excerpts.find((e) => e.id === 'a:2')?.text).toBe('L2 TOOL: Bash {"command":"gh pr create --title x --body \\"notes\\""}\nL5 AGENT: bye');
    expect(r.mechanical).toContain('skills no transcript on disk has run, to keep or retire: babysit-pr');
    expect(r.thin).toEqual(['skill triggers: 1 session of evidence', 'new skills: 1 session of evidence', 'instructions: 1 session of evidence']);
  });
});

describe('prThread', () => {
  it("keeps others' comments, reviews and inline comments, oldest first, clipped and redacted", async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'pr') {
        return JSON.stringify({
          author: { login: 'me' },
          comments: [{ author: { login: 'me' }, body: 'my own note', createdAt: '2026-10-20T10:00:00Z' }, { author: { login: 'kim' }, body: 'x'.repeat(2000), createdAt: '2026-10-20T12:00:00Z' }],
          reviews: [{ author: { login: 'bot' }, body: '', submittedAt: '2026-10-20T09:30:00Z' }, { author: { login: 'bot' }, body: 'token ghp_abcdefghijklmnopqrstuvwx', submittedAt: '2026-10-20T11:00:00Z' }],
        });
      }
      return JSON.stringify([[{ user: { login: 'kim' }, body: 'nit', created_at: '2026-10-20T10:30:00Z', path: 'src/a.ts' }]]);
    };
    const thread = await prThread('https://github.com/o/r/pull/7', gh);
    expect(calls).toEqual([
      ['pr', 'view', 'https://github.com/o/r/pull/7', '--json', 'author,comments,reviews'],
      ['api', '--hostname', 'github.com', 'repos/o/r/pulls/7/comments', '--paginate', '--slurp'],
    ]);
    expect(thread.map((c) => [c.author, c.path])).toEqual([['kim', 'src/a.ts'], ['bot', undefined], ['kim', undefined]]);
    expect(thread[1].body).toBe('token [redacted]');
    expect(thread[2].body).toHaveLength(1500);
  });
});
