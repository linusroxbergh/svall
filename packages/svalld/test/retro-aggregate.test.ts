import { describe, expect, it } from 'vitest';
import { aggregate, program, sequences, signature, type AggregateInput, type Group } from '../src/retro/aggregate.js';
import type { SessionCard } from '../src/retro/cards.js';
import type { Label, LabelItem } from '../src/retro/labels.js';
import { outliner, type Command, type Outline } from '../src/retro/outline.js';
import type { PrComment } from '../src/retro/prs.js';
import type { Target } from '../src/retro/targets.js';

const T = Date.parse('2026-10-26T09:00:00Z');
const MIN = 60_000;
const cmd = (text: string, failed: boolean, exit?: number, out?: string): Command => ({ id: 'L1.0', at: T, text, failed, ...(exit !== undefined && { exit }), ...(out && { out }) });

// a session that runs `commands` a minute apart, each [text, failed, output], after a prompt, and the skills given
function session(id: string, commands: [string, boolean, string?][] = [], skills: string[] = [], start = T): Outline {
  const o = outliner();
  o.prompt(1, start, `task ${id}`);
  commands.forEach(([text, failed, out], i) => o.ran(o.tool(i + 2, start + (i + 1) * MIN, 'Bash', { command: text }), i + 2, start + (i + 1) * MIN, text, { failed, ...(failed && { exit: 1 }), ...(out && { out }) }));
  skills.forEach((s, i) => {
    const t = o.tool(100 + i, start + (50 + i) * MIN, 'Skill', { skill: s });
    o.skill(s, 100 + i, start + (50 + i) * MIN, { id: t.id });
    o.prompt(200 + i, start + (51 + i) * MIN, 'ok');
  });
  return o.outline({ agent: 'claude', session: id, file: `/t/${id}.jsonl` });
}

const card = (session: string, more: Partial<SessionCard> = {}): SessionCard => ({
  session, agent: 'claude', chunks: [`${session}#1`], goal: 'g', kind: 'build', outcome: 'done',
  asks: [], corrections: [], rules: [], friction: [], skills: [], reviews: [], wins: [], ...more,
});

const input = (o: Partial<AggregateInput>): AggregateInput => ({
  outlines: [], cards: new Map(), labelled: [], reviews: [], repoOf: new Map(), targets: [], unused: [], ...o,
});
const byKind = (gs: Group[], kind: Group['kind']) => gs.filter((g) => g.kind === kind);

describe('signature', () => {
  it('keeps exit codes, status codes and error class names, and strips paths, hashes, line numbers and durations', () => {
    const out = 'Running...\nRedis::CannotConnectError: Error connecting to Redis on 127.0.0.1:6379 (Errno::ECONNREFUSED) at /w/app/spec/x_spec.rb:12 after 3.2s in 4f2a9c1d';
    expect(signature(cmd('bundle exec rspec spec/x_spec.rb', true, 1, out))).toEqual({
      key: 'bundle exec', signature: 'exit 1 · Redis::CannotConnectError: Error connecting to Redis on 127.0.0.1:<n> (Errno::ECONNREFUSED) at <path>:<n> after <t> in <hash>', expected: false,
    });
    expect(signature(cmd('curl -f https://x', true, 22, 'curl: (22) The requested URL returned error: 404')).signature).toBe('exit 22 · curl: (22) The requested URL returned error: 404');
    expect(signature(cmd('pnpm test', true, 1, 'FAIL x.test.ts\n  line 42: expected 1')).signature).toBe('exit 1 · FAIL x.test.ts');
  });

  it('calls a probe failing with no such file, not found or no output expected, and any other probe failure a failure', () => {
    expect(signature(cmd('ls /nope', true, 1, 'ls: /nope: No such file or directory')).expected).toBe(true);
    expect(signature(cmd('grep -r foo .', true, 1)).expected).toBe(true);
    expect(signature(cmd('which bun', true, 1, 'bun not found')).expected).toBe(true);
    expect(signature(cmd('cat secrets.json', true, 1, 'cat: secrets.json: Permission denied')).expected).toBe(false);
    expect(signature(cmd('pnpm test', true, 1)).expected).toBe(false);
  });

  it('names a command by its program and subcommand, past a cd and the variables set for it', () => {
    expect(['cd /repo && git push -u origin x', 'GIT_TRACE=1 git push', 'bundle exec rspec', 'ls -la'].map(program)).toEqual(['git push', 'git push', 'bundle exec', 'ls']);
  });
});

describe('sequences', () => {
  it('finds runs of 3–5 commands two sessions share, keeping the longest that holds the same sessions', () => {
    const steps: [string, boolean][] = [['git fetch', false], ['git rebase origin/main', false], ['git rebase origin/main', false], ['pnpm test', false], ['git push', false], ['ls', false]];
    const found = sequences([session('a', steps), session('b', steps), session('c', steps.slice(0, 3))]);
    expect(found).toEqual([
      { steps: ['git fetch', 'git rebase', 'pnpm test', 'git push'], sessions: ['a', 'b'] },
    ]);
  });
});

describe('aggregate', () => {
  const repoOf = new Map([['s1', '/code/core-api'], ['s2', '/code/core-api'], ['s3', '/code/app'], ['s4', '/code/app']]);

  it('counts an error group by failures, over the sessions that ran its program, with the time to the next success', () => {
    const redis = 'Redis::CannotConnectError: Error connecting to Redis';
    const outlines = [
      session('s1', [['bundle exec rspec a', true, redis], ['bundle exec rspec a', true, redis], ['bundle exec rspec a', false]]),
      session('s2', [['bundle exec rspec b', true, redis]]),
      session('s3', [['bundle exec rspec c', false], ['ls /x', true, 'ls: /x: No such file or directory']]),
    ];
    const { groups } = aggregate(input({ outlines, repoOf }));
    const [error, probe] = byKind(groups, 'error');
    expect(error).toMatchObject({ key: 'bundle exec × exit 1 · Redis::CannotConnectError: Error connecting to Redis', n: 3, hit: 2, of: 3, unit: 'sessions', sessions: ['s1', 's2'], elapsedMs: 2 * MIN });
    expect(error.examples).toHaveLength(3);
    expect(probe).toMatchObject({ key: 'ls × exit 1 · ls: <path>: No such file or directory', n: 1, expected: true });
  });

  it('counts corrections, retyped rules, asks and friction by session over the sessions in scope, a correction naming a rule file apart', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i): [string, boolean] => [`make ${i}`, false]);
    const outlines = [session('s1', steps(4)), session('s2'), session('s3', steps(1)), session('s4')];
    const cards = new Map([
      ['s1', card('s1', {
        corrections: [{ at: 'L1.0', quote: 'too long', about: 'report-style', what: 'report too long' }, { at: 'L1.0', quote: 'see CLAUDE.md', about: 'report-style', what: 'ignored CLAUDE.md' }],
        rules: [{ at: 'L1.0', quote: 'Always lead with the action!' }], asks: [{ at: 'L1.0', intent: 'Review PR' }],
        friction: [{ from: 'L1.0', to: 'L5.0', kind: 'env', what: 'redis down', elapsedMs: 4 * MIN }, { from: 'L2.0', to: 'L3.0', kind: 'env', what: 'still down', elapsedMs: MIN }],
      })],
      ['s2', card('s2', { corrections: [{ at: 'L1.0', quote: 'shorter', about: 'report-style', what: 'too long' }], rules: [{ at: 'L1.0', quote: 'always lead with the action' }], asks: [{ at: 'L1.0', intent: 'review pr' }] })],
      ['s3', card('s3', { friction: [{ from: 'L1.0', to: 'L2.0', kind: 'env', what: 'docker down', elapsedMs: MIN }] })],
    ]);
    const { groups, evidence } = aggregate(input({ outlines, cards, repoOf }));
    const shape = (g: Group) => [g.key, g.n, g.hit, g.of, g.unit];
    expect(byKind(groups, 'correction').map(shape)).toEqual([['report-style', 2, 2, 4, 'sessions'], ['report-style · CLAUDE.md', 1, 1, 4, 'sessions']]);
    expect(byKind(groups, 'retyped-rule').map(shape)).toEqual([['always lead with the action', 2, 2, 4, 'sessions']]);
    expect(byKind(groups, 'ask').map(shape)).toEqual([['review pr', 2, 2, 4, 'sessions']]);
    // overlapping intervals in a session count once
    expect(byKind(groups, 'friction').map((g) => [...shape(g), g.elapsedMs])).toEqual([['env × app', 1, 1, 4, 'sessions', MIN], ['env × core-api', 1, 1, 4, 'sessions', 4 * MIN]]);
    const e = evidence.get(byKind(groups, 'retyped-rule')[0].examples[0])!;
    expect(e).toMatchObject({ session: expect.stringMatching(/^s[12]$/), agent: 'claude', at: 'L1.0', repo: '/code/core-api', when: T });
    expect(e.text).toMatch(/lead with the action/i);
    // ids run in kind order, then by count
    expect(groups.map((g) => g.id)).toEqual(groups.map((_, i) => `g${i + 1}`));
  });

  it('counts a skill outcome by runs over the runs of that skill, and lists what ran without a correction', () => {
    const runs = (n: number) => Array.from({ length: n }, () => 'babysit-pr');
    const outlines = [session('s1', [], runs(3)), session('s2', [], runs(3))];
    const went = (s: string, ok: number) => card(s, { skills: [0, 1, 2].map((i) => ({ at: `L${100 + i}.0`, name: 'babysit-pr', went: i < ok ? 'no-issue' : 'redone', what: 'w' })) });
    const { groups, works, skills } = aggregate(input({ outlines, cards: new Map([['s1', went('s1', 3)], ['s2', went('s2', 2)]]) }));
    expect(byKind(groups, 'skill-outcome').map((g) => [g.key, g.n, g.hit, g.of, g.unit])).toEqual([['babysit-pr × redone', 1, 1, 6, 'runs']]);
    expect(works).toEqual([]);
    expect(skills).toEqual([{ skill: 'babysit-pr', runs: 6, went: { 'no-issue': 5, redone: 1 } }]);
    const clean = aggregate(input({ outlines, cards: new Map([['s1', went('s1', 3)], ['s2', went('s2', 3)]]) }));
    expect(clean.works).toEqual([{ skill: 'babysit-pr', clean: 6, runs: 6 }]);
  });

  it('counts confirmed review misses over the PRs reviewed with that skill, with later feedback and unknown beside', () => {
    const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
    const review = (session: string, n: number) => ({ session, skill: 'work-review', run: 'L5.0', pr: pr(n), end: T, findings: [] });
    const reviews = [review('s1', 1), review('s2', 2), review('s3', 3)];
    const c = (id: string): PrComment => ({ id, kind: 'inline', author: 'kim', bot: false, at: T + MIN, body: `missing spec ${id}`, path: 'a.rb' });
    const l = (id: string, severity: Label['severity'], theme: Label['theme'] = 'missing-test'): Label => ({ comment: id, theme, severity, catchable: true, inLocalFindings: false, addressed: 'yes' });
    const item = (id: string, n: number): LabelItem => ({ id, pr: pr(n), review: reviews[n - 1], comment: c(id), replies: [], atRevision: true, later: [] });
    const labelled = [
      { item: item('a', 1), label: l('a', 'high'), class: 'confirmed' as const },
      { item: item('b', 1), label: l('b', 'low'), class: 'confirmed' as const },
      { item: item('c', 2), label: l('c', 'medium'), class: 'unknown' as const },
      { item: item('d', 2), label: l('d', 'low', 'naming-style'), class: 'later' as const },
    ];
    const agg = aggregate(input({ outlines: [session('s1'), session('s2'), session('s3')], reviews, labelled }));
    const [miss] = byKind(agg.groups, 'review-miss');
    expect(miss).toMatchObject({ key: 'work-review × missing-test', n: 2, hit: 1, of: 3, unit: 'prs', prs: [pr(1)], sessions: ['s1'], impact: 3, beside: { later: 3, unknown: 1 } });
    expect(agg.evidence.get(miss.examples[0])).toMatchObject({ pr: pr(1), comment: expect.stringMatching(/^[ab]$/), session: 's1' });
    expect(agg.reviews).toEqual({
      prs: 3, later: 4, confirmed: 2, unknown: 1, missPrs: 1,
      themes: [
        { theme: 'missing-test', severity: 'high', later: 1, confirmed: 1, unknown: 0 },
        { theme: 'missing-test', severity: 'low', later: 1, confirmed: 1, unknown: 0 },
        { theme: 'missing-test', severity: 'medium', later: 1, confirmed: 0, unknown: 1 },
        { theme: 'naming-style', severity: 'low', later: 1, confirmed: 0, unknown: 0 },
      ],
    });
  });

  it('counts a sequence by sessions with its steps', () => {
    const steps: [string, boolean][] = [['git fetch', false], ['git rebase main', false], ['pnpm test', false]];
    const [seq] = byKind(aggregate(input({ outlines: [session('s1', steps), session('s2', steps)] })).groups, 'sequence');
    expect(seq).toMatchObject({ key: 'git fetch → git rebase → pnpm test', n: 2, hit: 2, of: 2, steps: 3 });
  });

  it('sums active time, mixes sessions by repo and kind, and groups unused skills by plugin or folder', () => {
    const outlines = [session('s1', [['a', false], ['b', false]]), session('s2'), session('s3')];
    const cards = new Map([['s1', card('s1', { kind: 'review' })], ['s2', card('s2', { kind: 'review' })], ['s3', card('s3')]]);
    const targets: Target[] = [
      { id: 'skill:a', kind: 'skill', name: 'a', path: '/u/.claude/skills/a/SKILL.md', realPath: '/u/.claude/skills/a/SKILL.md', class: 'local', hash: 'h', review: false },
      { id: 'skill:p:b', kind: 'skill', name: 'p:b', path: '/u/.claude/plugins/p/skills/b/SKILL.md', realPath: '/u/.claude/plugins/p/skills/b/SKILL.md', class: 'synced', hash: 'h', review: false },
      { id: 'skill:p:c', kind: 'skill', name: 'p:c', path: '/u/.claude/plugins/p/skills/c/SKILL.md', realPath: '/u/.claude/plugins/p/skills/c/SKILL.md', class: 'synced', hash: 'h', review: false },
    ];
    const agg = aggregate(input({ outlines, cards, repoOf, targets, unused: ['a', 'p:b', 'p:c'] }));
    expect(agg.activeMs).toBe(2 * MIN);
    expect(agg.mix).toEqual([{ repo: 'core-api', kind: 'review', sessions: 2 }, { repo: 'app', kind: 'build', sessions: 1 }]);
    expect(agg.unused).toEqual([{ source: 'p', skills: ['p:b', 'p:c'] }, { source: '/u/.claude/skills', skills: ['a'] }]);
  });
});
