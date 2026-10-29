import type { Finding, RetroReport } from '@svall/protocol';

const T = Date.parse('2026-10-27T09:00:00Z');
const DAY = 86_400_000;

/** A finding as a run writes it, numbered by its place in `findings`. */
export const finding = (id: string, more: Partial<Finding> = {}): Finding => ({
  id, category: 'correction', title: `finding ${id}`, problem: 'Final reports are long and do not say what to do.', fix: 'one line in CLAUDE.md',
  evidence: [
    { source: { agent: 'claude', session: '3f2a1b4c-1111-2222', at: 'L12.0' }, when: T, repo: '/code/core-api', quote: 'what changes? should I do something?' },
    { source: { pr: 'https://github.com/o/core-api/pull/7', comment: '11' }, when: T - DAY, repo: '/code/core-api', quote: 'no spec for the retry' },
  ],
  sessions: 5, prs: 1, change: { kind: 'diff', summary: 'lead with the action', text: '@@ -1 +1,2 @@\n # Rules\n+Lead with the action.' },
  target: { id: 'rule:~/.claude/CLAUDE.md', path: '/u/.claude/CLAUDE.md', realPath: '/u/.claude/CLAUDE.md', class: 'local', hash: 'h' },
  value: { badge: 'Med', score: 10.3, n: 5, m: 194, impact: 2, confidence: 1, reason: '5 of 194 sessions' }, effort: 'rule line',
  verdict: { claim: 'holds', change: 'edited', rule: 'preference observed', reason: 'asked in five sessions' },
  groups: [{ kind: 'correction', key: 'report-style' }], kind: 'pattern',
  measure: { keys: [{ kind: 'correction', key: 'report-style' }], before: { count: 5, of: 194 }, after: null }, ...more,
});

/** A week over 194 sessions with six findings, two emerging and one seen once. */
export const report = (more: Partial<RetroReport> = {}): RetroReport => ({
  version: 2, run: 'r_1793263426', span: { from: T - 5 * DAY, to: T + 2 * DAY, label: 'last 7 days' }, preset: { read: 'haiku', judge: 'opus', verify: 'sonnet' },
  overview: { text: 'Mostly PR review loops in core-api (41% of sessions), then building in mm-ai-suite.', sessions: 194, repos: 5, activeMs: 31 * 3_600_000, mix: [{ repo: 'core-api', kind: 'review', sessions: 80 }, { repo: 'mm-ai-suite', kind: 'build', sessions: 40 }] },
  works: { text: 'slack-private-pr and gpt-validate ran clean.', skills: [{ skill: 'slack-private-pr', clean: 9, runs: 10 }, { skill: 'gpt-validate', clean: 14, runs: 16 }], wins: 3 },
  reviews: { prs: 17, later: 31, confirmed: 7, unknown: 4, missPrs: 5, themes: [{ theme: 'missing-test', severity: 'high', later: 12, confirmed: 7, unknown: 2 }, { theme: 'naming-style', severity: 'low', later: 19, confirmed: 0, unknown: 2 }] },
  previous: [],
  findings: [
    finding('a1', { title: 'Local reviews miss missing specs that others catch', category: 'review-miss', fix: 'work-review lists new branches with no spec', effort: 'skill edit', value: { badge: 'High', score: 36.2, n: 7, m: 17, impact: 4, confidence: 1, reason: '7 confirmed misses in 5 of 17 reviewed PRs' } }),
    finding('a2', { title: 'bundle exec rspec fails because Redis is not running', category: 'error', fix: "start Redis in core-api's spec step", value: { badge: 'High', score: 30.1, n: 41, m: 30, impact: 1.44, confidence: 0.6, reason: '41 failures in 12 sessions, ~3h elapsed' } }),
    finding('a3', { title: 'Final reports are long and do not say what to do' }),
    finding('a4', { title: 'You chain triage, gpt-validate, fix and reply by hand', category: 'workflow', fix: 'extend gh-address-comments', effort: 'skill edit', value: { badge: 'Low', score: 4.1, n: 4, m: 194, impact: 1, confidence: 1, reason: '4 of 194 sessions' } }),
    finding('a5', { title: 'babysit-pr posts no activity each half hour', category: 'noise', fix: 're-arm silently, stop after 24h', effort: 'skill edit', value: { badge: 'Low', score: 4, n: 7, m: 17, impact: 1, confidence: 0.6, reason: '7 of 17 runs' } }),
    finding('a6', { title: 'sixth', value: { badge: 'Low', score: 3, n: 3, m: 194, impact: 1, confidence: 1, reason: '3 of 194 sessions' } }),
  ],
  emerging: [finding('b1', { title: 'emerging one' }), finding('b2', { title: 'emerging two' })], singletons: [finding('c1', { title: 'seen once', kind: 'singleton' })],
  dropped: [{ title: 'Add an address-pr-comments skill', reason: 'gh-address-comments already does it' }],
  errors: [
    { key: 'bundle exec', signature: 'exit 1 · Redis::CannotConnectError: Error connecting to Redis on 127.0.0.1:<n>', failures: 41, sessions: 12, of: 30, elapsedMs: 3 * 3_600_000, expected: false },
    { key: 'ls', signature: 'exit 1 · ls: <path>: No such file or directory', failures: 9, sessions: 6, of: 50, elapsedMs: 0, expected: true },
  ],
  asks: [{ kind: 'ask', key: 'review pr', sessions: 22 }, { kind: 'sequence', key: 'git fetch → git rebase → pnpm test', sessions: 6 }],
  skills: [{ skill: 'gpt-validate', runs: 16, went: { 'no-issue': 14, corrected: 2 } }],
  housekeeping: { unused: 163, sources: [{ source: 'superpowers', skills: Array.from({ length: 40 }, (_, i) => `superpowers:s${i}`) }, { source: 'figma', skills: Array.from({ length: 30 }, (_, i) => `figma:f${i}`) }, { source: 'cloudflare', skills: Array.from({ length: 30 }, (_, i) => `cloudflare:c${i}`) }, { source: 'slack', skills: Array.from({ length: 20 }, (_, i) => `slack:k${i}`) }, { source: '/u/.claude/skills', skills: Array.from({ length: 43 }, (_, i) => `local${i}`) }] },
  coverage: {
    sessions: Array.from({ length: 194 }, (_, i) => ({ session: `s${String(i).padStart(3, '0')}-aaaa`, agent: i % 10 ? 'claude' as const : 'codex' as const, repo: i % 2 ? '/code/core-api' : '/code/app', day: `2026-10-${22 + (i % 7)}`, status: i % 3 ? 'carded' as const : 'cached' as const, clipped: i % 5 ? 0 : 1 })),
    quality: 0.93, joins: { joined: 17, failed: 2, ambiguous: 1, truncated: 0 }, cutGroups: 0, unverified: 0, belowGate: 9,
  },
  usage: { budget: 2_000_000, used: 1_420_000, byStage: { cards: 1_050_000, labels: 50_000, synthesis: 260_000, verify: 60_000 } },
  ...more,
});
