import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding, Preset, RetroPlan, RetroStatus } from '@svall/protocol';
import type { Call, Runner } from '../src/scribe/run.js';
import type { Aggregate, Group } from '../src/retro/aggregate.js';
import { Budget } from '../src/retro/budget.js';
import { readCalibration } from '../src/retro/calibrate.js';
import { CARD_SYSTEM } from '../src/retro/cards.js';
import { LABEL_SYSTEM } from '../src/retro/labels.js';
import { findingId, mark, readLedger, recordFindings, writeLedger } from '../src/retro/ledger.js';
import { outliner, type Outline } from '../src/retro/outline.js';
import type { PrThread } from '../src/retro/prs.js';
import { finalize, measureSince, reserver, runPlan, type RunInput } from '../src/retro/run.js';
import { SYNTHESIS_SYSTEM, type Candidate } from '../src/retro/synthesis.js';
import type { Target } from '../src/retro/targets.js';
import { VERIFY_SYSTEM, type Checked } from '../src/retro/verify.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const T = Date.parse('2026-10-20T09:00:00Z');
const MIN = 60_000, DAY = 86_400_000;
const PR = 'https://github.com/o/core-api/pull/7';
const PRESET: Preset = {
  name: 'balanced', label: 'Balanced', read: { agent: 'claude', model: 'haiku' }, judge: { agent: 'claude', model: 'opus' }, verify: { agent: 'claude', model: 'sonnet' }, tokens: { min: 1, max: 2 },
};

// a session asking for a look, with a failing rspec, then told the report is too long; one with `review` runs work-review
function session(id: string, start: number, more: { review?: boolean; filler?: number } = {}): Outline {
  const o = outliner();
  o.prompt(1, start, `please look at ${id}`);
  o.ran(o.tool(2, start + MIN, 'Bash', { command: 'bundle exec rspec' }), 3, start + 2 * MIN, 'bundle exec rspec', { failed: true, exit: 1, out: 'Redis::CannotConnectError: Error connecting to Redis' });
  if (more.review) {
    const t = o.tool(4, start + 3 * MIN, 'Skill', { skill: 'work-review' });
    o.skill('work-review', 4, start + 3 * MIN, { id: t.id });
    o.said(5, start + 4 * MIN, `Review of ${PR}: all good.`);
  }
  for (let i = 0; i < (more.filler ?? 0); i++) o.said(10 + i, start + 5 * MIN, 'f'.repeat(1_400));
  o.prompt(6, start + 6 * MIN, 'no, the report is too long');
  return o.outline({ agent: 'claude', session: id, file: `/t/${id}.jsonl` });
}

const thread: PrThread = {
  url: PR, author: 'me', truncated: false, commits: [{ sha: 'c1', at: T - DAY }, { sha: 'c2', at: T + 2 * DAY, files: ['spec/a_spec.rb'] }],
  comments: [{ id: '11', kind: 'inline', author: 'kim', bot: false, at: T + DAY, body: 'no spec for the retry', path: 'spec/a_spec.rb', commit: 'c1', hunk: '@@ +retry' }],
};

type Seen = { system: string; prompt: string; call: Call };
const kindOf = (system: string) => (system === CARD_SYSTEM ? 'cards' : system === LABEL_SYSTEM ? 'labels' : system === SYNTHESIS_SYSTEM ? 'synthesis' : system === VERIFY_SYSTEM ? 'verify' : 'other');
const ids = (prompt: string, fence: string) => [...prompt.matchAll(new RegExp(`<<<${fence} (?:id|n)=(\\S+)`, 'g'))].map((m) => m[1]);

const cardFor = (chunk: string) => ({
  chunk, goal: 'review the PR', kind: 'review', outcome: 'done', asks: [{ at: 'L1.0', intent: 'look at code' }],
  corrections: [{ at: 'L6.0', quote: 'the report is too long', about: 'report-style', what: 'report too long' }], rules: [], friction: [],
  skills: chunk.startsWith('s4') ? [{ at: 'L4.0', name: 'work-review', went: 'no-issue', what: 'ran' }] : [],
  reviews: chunk.startsWith('s4') ? [{ at: 'L5.0', findings: ['all good'], limits: null }] : [], wins: [],
});
const candidate = (more: Partial<Candidate> = {}): Candidate => ({
  category: 'correction', groups: ['g2'], examples: [], title: 'Final reports are long', problem: 'The user asks for shorter reports.', fix: 'one line in CLAUDE.md',
  change: { kind: 'proposal', summary: 'lead with the action', text: 'Lead with the action.' }, target: 'rule:CLAUDE.md', subject: 'reports', nearest: [], kind: 'pattern', ...more,
});

// a runner that answers each kind of call, unless `answer` says otherwise for it
function fake(answer: Partial<Record<string, (prompt: string, n: number) => unknown>> = {}) {
  const seen: Seen[] = [];
  let open = 0, most = 0;
  const runner: Runner = async (system, prompt, call) => {
    const kind = kindOf(system);
    seen.push({ system, prompt, call });
    const n = seen.filter((s) => kindOf(s.system) === kind).length;
    open++;
    most = Math.max(most, open);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const custom = answer[kind]?.(prompt, n);
      const reply = custom ?? (
        kind === 'cards' ? { cards: ids(prompt, 'CHUNK').map(cardFor) }
        : kind === 'labels' ? { labels: ids(prompt, 'ITEM').map((comment) => ({ comment, theme: 'missing-test', severity: 'high', catchable: true, inLocalFindings: false, addressed: 'yes' })) }
        : kind === 'synthesis' ? { overview: 'Mostly reviews in core-api.', works: 'Nothing stood out.', candidates: [candidate()] }
        : { verdicts: ids(prompt, 'CANDIDATE').map((n) => ({ candidate: Number(n), verdict: 'holds', reason: 'seen', change: 'ok', edited: null, extend: null, rule: 'preference' })) });
      return { text: JSON.stringify(reply), usage: { input: 1_000 + Math.ceil((system.length + prompt.length) / 4), output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
    } finally { open--; }
  };
  return { runner, seen, most: () => most };
}

function setup(answer?: Parameters<typeof fake>[0], more: Partial<RunInput> = {}) {
  const home = makeHome();
  const dir = path.join(home, 'runs', 'r_1');
  fs.mkdirSync(dir, { recursive: true });
  const rule = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(rule, '# Rules\n');
  fs.utimesSync(rule, (T - 2 * DAY) / 1000, (T - 2 * DAY) / 1000);
  const target: Target = { id: 'rule:CLAUDE.md', kind: 'rule', name: 'CLAUDE.md', path: rule, realPath: rule, class: 'local', hash: 'h', review: false };
  const outlines = [session('s1', T), session('s2', T + DAY), session('s3', T + 2 * DAY), session('s4', T, { review: true })];
  const plan: RetroPlan = {
    version: 2, id: 'r_1', created: T + 3 * DAY, span: { from: T - DAY, to: T + 3 * DAY, label: 'last 7 days' }, scope: { exclude: { repos: [], islands: [] }, unrecorded: [] },
    counts: { inScope: 4, excluded: 0, otherFleets: 0, remote: 0, unrecorded: [], missing: {} }, reviews: 'gh', agent: 'claude', billing: 'subscription', presets: [PRESET],
    work: { sessions: 4, chunks: 4, cached: 0, calls: 1, prs: 1, comments: 1 }, pricesChecked: 'x',
  };
  const f = fake(answer);
  const statuses: RetroStatus[] = [];
  const input: RunInput = {
    plan, preset: PRESET, budget: 10_000_000, runner: () => f.runner, dir, cardsDir: path.join(home, 'cards'), calibrationFile: path.join(home, 'calibration.json'),
    ledgerFile: path.join(home, 'ledger.v2.json'), targets: [target], outlines, repoOf: new Map(outlines.map((s) => [s.session, '/code/core-api'])),
    threads: new Map([[PR, thread]]), joins: { reviews: [{ session: 's4', skill: 'work-review', run: 'L4.0', pr: PR, end: T + 6 * MIN }], failed: 1, ambiguous: 0 },
    unused: [], previous: [], onStatus: (s) => statuses.push(s), signal: new AbortController().signal, now: () => T + 4 * DAY, backoffMs: 1, ...more,
  };
  return { input, dir, statuses, ...f, target };
}

const read = (dir: string, name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const calls = (seen: Seen[], kind: string) => seen.filter((s) => kindOf(s.system) === kind);

describe('runPlan', () => {
  it('cards every session, labels the later comment, synthesizes once and verifies, and reports what each stage gave', async () => {
    const { input, dir, statuses, seen, target } = setup();
    const r = await runPlan(input);

    expect(seen.map((s) => kindOf(s.system))).toEqual(['cards', 'labels', 'synthesis', 'verify']);
    expect(seen[0].call).toMatchObject({ model: 'haiku' });
    expect(seen[0].call.effort).toBeUndefined();
    expect(seen[2].call).toMatchObject({ model: 'opus' });
    expect(seen[3].call).toMatchObject({ model: 'sonnet' });
    // the synthesis reads the groups code counted, the verifier the raw lines
    expect(seen[2].prompt).toMatch(/correction "report-style" n=4 · 4 of 4 sessions/);
    expect(seen[3].prompt).toContain('> L6.0 USER: no, the report is too long');

    expect(statuses[0]).toMatchObject({ stage: 'reading', done: 0, total: 4 });
    expect(statuses.map((s) => s.stage)).toContain('judging');
    expect(statuses.at(-1)).toMatchObject({ stage: 'done', done: 4, total: 4 });
    expect(statuses.map((s) => s.used ?? 0)).toEqual([...statuses.map((s) => s.used ?? 0)].sort((a, b) => a - b));

    expect(r.findings).toHaveLength(1);
    const [f] = r.findings;
    expect(f).toMatchObject({
      id: findingId('correction', target.realPath, 'reports'), sessions: 4, effort: 'rule line', kind: 'pattern',
      verdict: { claim: 'holds', change: 'ok', rule: 'preference observed' }, value: { badge: 'High', n: 4, m: 4, impact: 2, reason: '4 of 4 sessions' },
      measure: { keys: [{ kind: 'correction', key: 'report-style' }], before: { count: 4, of: 4 } },
    });
    expect(f.target).toMatchObject({ id: 'rule:CLAUDE.md', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(f.evidence[0]).toMatchObject({ source: { agent: 'claude', at: 'L6.0' }, quote: '"the report is too long" — report too long' });
    expect(r.reviews).toMatchObject({ prs: 1, later: 1, confirmed: 1, missPrs: 1 });
    expect(r.errors[0]).toMatchObject({ key: 'bundle exec', failures: 4, sessions: 4 });
    expect(r.overview).toMatchObject({ text: 'Mostly reviews in core-api.', sessions: 4, repos: 1 });
    expect(r.coverage).toMatchObject({ quality: 1, joins: { joined: 1, failed: 1, ambiguous: 0, truncated: 0 }, unverified: 0 });
    expect(r.coverage.sessions.map((s) => s.status)).toEqual(['carded', 'carded', 'carded', 'carded']);
    expect(Object.values(r.usage.byStage).every((n) => n > 0)).toBe(true);
    expect(r.usage.used).toBe(Object.values(r.usage.byStage).reduce((a, b) => a + b, 0));

    expect(Object.keys(read(dir, 'cards.json') as object)).toEqual(['s1', 's2', 's3', 's4']);
    expect(fs.statSync(path.join(dir, 'groups.json')).mode & 0o777).toBe(0o600);
    expect(readLedger(input.ledgerFile)[f.id]).toMatchObject({ status: 'open', category: 'correction' });
    // four calls reported usage
    expect(readCalibration(input.calibrationFile).claude!.n).toBe(4);
  });

  it('reads a cached card without a call, and says so in coverage', async () => {
    const first = setup();
    await runPlan(first.input);
    const again = setup(undefined, { cardsDir: first.input.cardsDir });
    const r = await runPlan(again.input);
    expect(calls(again.seen, 'cards')).toEqual([]);
    expect(r.coverage.sessions.map((s) => s.status)).toEqual(['cached', 'cached', 'cached', 'cached']);
  });

  it('asks again alone for a chunk the reply left out, then counts its session failed', async () => {
    const { input, seen } = setup({ cards: (prompt) => ({ cards: ids(prompt, 'CHUNK').filter((id) => !id.startsWith('s2')).map(cardFor) }) });
    const r = await runPlan(input);
    const cardCalls = calls(seen, 'cards');
    expect(cardCalls).toHaveLength(2);
    expect(ids(cardCalls[1].prompt, 'CHUNK')).toEqual(['s2#1']);
    expect(r.coverage.sessions.find((s) => s.session === 's2')).toMatchObject({ status: 'failed', reason: 'no card after a retry' });
    expect(r.findings[0].sessions).toBe(3);
  });

  it('runs six calls at once, and three after a rate limit', async () => {
    // sessions of about 25k tokens, each a call of its own
    const outlines = Array.from({ length: 14 }, (_, i) => session(`b${i}`, T + i * MIN, { filler: 50 }));
    const calm = setup(undefined, { outlines });
    await runPlan(calm.input);
    expect(calls(calm.seen, 'cards')).toHaveLength(14);
    expect(calm.most()).toBe(6);
    // the first call is refused, its worker waits, and from then on three run at once
    const slowed = setup({ cards: (_, n) => { if (n === 1) throw new Error('claude -p failed: 429 rate limit'); return undefined; } }, { outlines });
    // counted once every call that began before the limit has ended
    let open = 0, before = 0, most = 0, limited = false;
    const runner = slowed.runner;
    const watched: Runner = async (system, prompt, call, signal) => {
      const pre = !limited;
      open++;
      if (pre) before++;
      if (!before) most = Math.max(most, open);
      try { return await runner(system, prompt, call, signal); } catch (e) { limited = true; throw e; } finally { open--; if (pre) before--; }
    };
    await runPlan({ ...slowed.input, runner: () => watched });
    expect(limited).toBe(true);
    expect(most).toBe(3);
    expect(calls(slowed.seen, 'cards')).toHaveLength(15);
  });

  it('verifies only what the held verify still covers after the cards cut it, the top-ranked first', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => candidate({ title: `c${i}`, subject: `s${i}`, groups: i < 2 ? ['g1', 'g2'] : ['g2'] }));
    const { input, seen } = setup({ synthesis: () => ({ overview: 'o', works: 'w', candidates: twelve }) });
    const refused = await runPlan({ ...input, budget: 1 }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    const holds = Number(/verify's (\d+)/.exec((refused as Error).message)![1]);
    const r = await runPlan({ ...input, budget: holds });
    const verify = calls(seen, 'verify');
    expect(verify).toHaveLength(2);
    expect(r.coverage.unverified).toBe(4);
    expect(r.dropped.filter((d) => d.reason === 'not verified: over the budget')).toHaveLength(4);
    expect(ids(verify[0].prompt, 'CANDIDATE')).toEqual(['1', '2', '3', '4']);
    // the two that cite two groups rank first
    expect(verify[0].prompt).toMatch(/title: c[01][\s\S]*title: c[01]/);
    expect(r.coverage.sessions.every((s) => s.status === 'carded')).toBe(true);
  });

  it("keeps the verifier's corrected change, and moves an extended one's id to its new target", async () => {
    const diff = { kind: 'diff' as const, summary: 'lead with the action', text: '@@ -1 +1,2 @@\n # Rules\n+Lead with the action.' };
    const { input } = setup({
      synthesis: () => ({ overview: 'o', works: 'w', candidates: [candidate(), candidate({ title: 'new skill', subject: 'address-pr-comments', target: '~/.claude/skills/address-pr-comments/SKILL.md', nearest: ['skill:gh-address-comments'], category: 'workflow' })] }),
      verify: () => ({ verdicts: [
        { candidate: 1, verdict: 'holds', reason: 'r', change: 'edited', edited: diff, extend: null, rule: null },
        { candidate: 2, verdict: 'partly', reason: 'r', change: 'extend', edited: { kind: 'proposal', summary: 'add a triage step', text: 't' }, extend: 'skill:gh-address-comments', rule: null },
      ] }),
    });
    const file = path.join(makeHome(), 'SKILL.md');
    fs.writeFileSync(file, '# gh-address-comments\n');
    const skill: Target = { id: 'skill:gh-address-comments', kind: 'skill', name: 'gh-address-comments', path: file, realPath: file, class: 'local', hash: 'h', review: false };
    const r = await runPlan({ ...input, targets: [...input.targets, skill] });
    const edited = r.findings.find((f) => f.title === 'Final reports are long')!;
    const extended = r.findings.find((f) => f.title === 'new skill')!;
    expect(edited.change).toEqual(diff);
    expect(edited.verdict.change).toBe('edited');
    expect(extended).toMatchObject({ id: findingId('workflow', file, 'gh-address-comments'), target: { id: 'skill:gh-address-comments' }, effort: 'skill edit', verdict: { claim: 'partly', change: 'extend' } });
  });

  it('fails a run whose synthesis fails twice, and says why', async () => {
    const { input, statuses } = setup({ synthesis: () => { throw new Error('claude -p failed: not logged in'); } });
    await expect(runPlan(input)).rejects.toThrow('not logged in');
    expect(statuses.at(-1)).toMatchObject({ stage: 'failed', error: 'claude -p failed: not logged in' });
  });

  it('calls nothing for a plan with no sessions', async () => {
    const { input, seen } = setup(undefined, { outlines: [], joins: { reviews: [], failed: 0, ambiguous: 0 }, budget: 1 });
    const r = await runPlan(input);
    expect(seen).toEqual([]);
    expect(r).toMatchObject({ findings: [], usage: { used: 0 } });
  });

  it('measures a previous fix by its group keys over the sessions since its fix date', async () => {
    const prev: Finding = { ...(await runPlan(setup().input)).findings[0], id: 'old' };
    const { input } = setup(undefined, { previous: [prev] });
    writeLedger(input.ledgerFile, mark(recordFindings({}, [prev], T - DAY), 'old', 'fixed', { at: T + DAY / 2 }));
    const r = await runPlan(input);
    // s2 and s3 started since the fix, and both were corrected again
    expect(r.previous[0].measure).toEqual({ ...prev.measure, after: { count: 2, of: 2 } });
  });
});

describe('reserver', () => {
  it('cuts the verify to its floor first, then the synthesis, before it refuses', () => {
    const budget = new Budget(100);
    const holds = { synthesis: 50, verify: 40 };
    budget.reserve(90);
    const reserve = reserver(budget, holds, { synthesis: 30, verify: 10 });
    expect(reserve(25)).toBe(true);
    expect(holds).toEqual({ synthesis: 50, verify: 25 });
    expect(reserve(30)).toBe(true);
    expect(holds).toEqual({ synthesis: 35, verify: 10 });
    expect(reserve(10)).toBe(false);
    expect(holds).toEqual({ synthesis: 30, verify: 10 });
  });
});

describe('finalize', () => {
  const g = (id: string, sessions: string[], more: Partial<Group> = {}): Group => ({
    id, kind: 'correction', key: `k${id}`, n: sessions.length, hit: sessions.length, of: 10, unit: 'sessions', occ: sessions, hits: sessions, sessions, prs: [], examples: [], last: T, ...more,
  });
  const agg = (groups: Group[]) => ({ groups, evidence: new Map() }) as unknown as Aggregate;
  const ok = (c: Candidate): Checked => ({ c, verdict: 'holds', reason: 'r', change: 'ok' });
  const run = (checked: Checked[], groups: Group[], dismissed = new Set<string>()) => finalize(checked, { agg: agg(groups), inventory: new Map(), hashes: new Map(), dismissed });

  it('passes a pattern in three sessions or two PRs, calls two sessions emerging, and counts one below the gate', () => {
    const groups = [g('g1', ['a', 'b', 'c']), g('g2', ['a', 'b']), g('g3', ['a']), g('g4', ['a'], { prs: ['p1', 'p2'] })];
    const r = run(['g1', 'g2', 'g3', 'g4'].map((id) => ok(candidate({ groups: [id], subject: id, target: null }))), groups);
    expect(r.findings.map((f) => f.groups[0].key).sort()).toEqual(['kg1', 'kg4']);
    expect(r.emerging.map((f) => f.groups[0].key)).toEqual(['kg2']);
    expect(r.belowGate).toBe(1);
  });

  it('adds up clustered groups, each of one session, to pass the gate', () => {
    const groups = [g('g1', ['a']), g('g2', ['b']), g('g3', ['c'])];
    expect(run([ok(candidate({ groups: ['g1', 'g2', 'g3'], target: null }))], groups).findings[0]).toMatchObject({ sessions: 3, value: { n: 3 } });
  });

  it('passes a singleton only as an error or a rule conflict, shown as seen once', () => {
    const r = run([
      ok(candidate({ kind: 'singleton', category: 'error', subject: 'e', target: null, groups: ['g1'] })),
      ok(candidate({ kind: 'singleton', category: 'rule-conflict', subject: 'r', target: null, groups: [] })),
      ok(candidate({ kind: 'singleton', category: 'correction', subject: 'c', target: null, groups: ['g1'] })),
    ], [g('g1', ['a'])]);
    expect(r.singletons.map((f) => f.category).sort()).toEqual(['error', 'rule-conflict']);
    expect(r.findings).toEqual([]);
    expect(r.belowGate).toBe(1);
    expect(r.singletons.find((f) => f.category === 'rule-conflict')!.measure).toEqual({ keys: [], before: null, after: null });
  });

  it('drops dismissed ids, keeps one finding per id, numbers by value, and lists what the verifier dropped', () => {
    const groups = [g('g1', ['a', 'b', 'c']), g('g2', ['a', 'b', 'c', 'd', 'e', 'f'])];
    const r = run([
      ok(candidate({ subject: 'small', groups: ['g1'], target: null })),
      ok(candidate({ subject: 'big', groups: ['g2'], target: null })),
      ok(candidate({ subject: 'big', groups: ['g1'], target: null, title: 'same id, lower value' })),
      ok(candidate({ subject: 'gone', groups: ['g2'], target: null })),
      { c: candidate({ title: 'wrong' }), dropped: 'the user asked for it' },
    ], groups, new Set([findingId('correction', '', 'gone')]));
    expect(r.findings.map((f) => f.groups[0].key)).toEqual(['kg2', 'kg1']);
    expect(r.findings.map((f) => f.title)).not.toContain('same id, lower value');
    expect(r.dropped).toEqual([{ title: 'wrong', reason: 'the user asked for it' }]);
  });

  it('measures nothing for a finding with no group, and counts the sessions since a date for one with', () => {
    const f = { measure: { keys: [{ kind: 'error' as const, key: 'bundle exec × exit 1 · Redis::CannotConnectError: Error connecting to Redis' }], before: null, after: null } } as Finding;
    const input = { outlines: [session('x', T), session('y', T + DAY)], cards: new Map(), labelled: [], reviews: [], repoOf: new Map(), targets: [], unused: [] };
    expect(measureSince(f, input, T + DAY / 2)).toEqual({ count: 1, of: 1 });
    expect(measureSince({ ...f, measure: { keys: [], before: null, after: null } }, input, T)).toBeNull();
  });
});
