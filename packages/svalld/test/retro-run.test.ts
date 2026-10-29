import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { JudgeReply, NoteReply, type Finding, type Note, type Preset, type RetroPlan, type RetroStatus } from '@svall/protocol';
import type { Call, Runner } from '../src/scribe/run.js';
import { judgeTokens, readTokens } from '../src/retro/budget.js';
import { findingId, mark, readLedger, recordFindings, writeLedger } from '../src/retro/ledger.js';
import type { Outline, SkillRun } from '../src/retro/outline.js';
import { wireSchema } from '../src/retro/prompts.js';
import { runPlan, type RunInput } from '../src/retro/run.js';
import type { Excerpt } from '../src/retro/select.js';
import type { Target } from '../src/retro/targets.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const T0 = Date.parse('2026-10-20T09:00:00Z');
const DAY = 86_400_000;
const PR = 'https://github.com/o/r/pull/7';
const USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const PRESET: Preset = { name: 'balanced', label: 'Balanced', read: { agent: 'claude', model: 'sonnet' }, judge: { agent: 'claude', model: 'opus' }, tokens: { min: 1, max: 2 } };

const excerpt = (session: string, more: Partial<Excerpt> = {}): Excerpt => ({
  id: `${session}:2`, focus: 'skill-tweaks', priority: 1, session: { agent: 'claude', session }, skill: 'publish', text: `L2 TOOL: Skill publish in ${session}`, ...more,
});

const note = (session: string, more: Partial<Note> = {}): Note => ({
  source: { agent: 'claude', session, line: 2 }, focus: 'skill-tweaks', category: 'skipped-step', target: 'skill:publish',
  claim: `${session} skipped the changelog`, quote: 'L2 TOOL: Skill publish', ...more,
});

type Judged = z.infer<typeof JudgeReply>['findings'][number];
const judged = (sessions: string[], more: Partial<Judged> = {}): Judged => ({
  focus: 'skill-tweaks', category: 'skipped-step', title: 'publish skips the changelog', claim: `${sessions.length} runs skipped it`,
  evidence: sessions.map((s) => ({ source: { agent: 'claude', session: s, line: 2 }, quote: 'L2 TOOL: Skill publish' })),
  change: { kind: 'diff', summary: 'add the changelog step', text: '--- a/SKILL.md\n+++ b/SKILL.md' }, target: 'skill:publish', subject: 'publish',
  measure: { kind: 'followups-after-skill', subject: 'publish', name: 'follow-ups after /publish' }, rank: 1, ...more,
});

const finding = (id: string): Finding => ({
  id, focus: 'skill-tweaks', category: 'skipped-step', title: `t ${id}`, claim: 'c', evidence: [], sessions: 3, prs: 0,
  change: { kind: 'proposal', summary: 's', text: 't' }, target: null,
  measure: { kind: 'followups-after-skill', subject: 'publish', name: 'follow-ups after /publish', before: { count: 9, of: 20 }, after: null }, rank: 1,
});

const session = (id: string, at: number, next?: SkillRun['next']): Outline => ({
  agent: 'claude', session: id, file: `/t/${id}.jsonl`, start: at, end: at + 500, turns: [], prompts: [],
  skills: [{ name: 'publish', line: 2, at: at + 10, end: at + 20, ...(next && { next }) }],
  tools: 0, errors: 0, interrupts: 0, rejected: 0, prs: [], commands: [], hookErrors: 0, work: { wrote: {}, ran: {} },
});

type Seen = { side: 'read' | 'judge'; prompt: string; call: Call; signal?: AbortSignal };
// a runner that answers each call from `answer`, given which side asked, its prompt and how often that prompt was asked
function fake(answer: (side: 'read' | 'judge', prompt: string, n: number) => string | Promise<string>) {
  const seen: Seen[] = [];
  const runner: Runner = async (system, prompt, call, signal) => {
    const side = system.startsWith('You judge') ? 'judge' : 'read';
    seen.push({ side, prompt, call, signal });
    const text = await answer(side, prompt, seen.filter((s) => s.prompt === prompt).length);
    return { text, usage: USAGE };
  };
  return { runner, seen };
}

const notes = (...ns: Note[]): string => JSON.stringify({ notes: ns });
const findings = (...fs: Judged[]): string => JSON.stringify({ findings: fs });
// one batch whose read notes s1, s2 and s3, as a finding needs three sessions of evidence
const THREE = [[excerpt('s1'), excerpt('s2'), excerpt('s3')]];
const threeNotes = (side: 'read' | 'judge', judge: string): string => (side === 'read' ? notes(note('s1'), note('s2'), note('s3')) : judge);

// a run folder holding `batches` as plan time wrote them, and a skill target on disk
function setup(batches: Excerpt[][], answer: Parameters<typeof fake>[0], more: Partial<RunInput> = {}) {
  const home = makeHome();
  const dir = path.join(home, 'runs', 'r_1');
  const file = path.join(home, 'skills', 'publish', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# publish\n1. bump\n2. tag\n');
  const ids = batches.map((_, i) => `b${String(i + 1).padStart(2, '0')}`);
  batches.forEach((b, i) => {
    fs.mkdirSync(path.join(dir, 'batches'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'batches', `${ids[i]}.json`), JSON.stringify(b));
  });
  const plan: RetroPlan = {
    id: 'r_1', created: T0, span: { from: T0 - 14 * DAY, to: T0, label: 'last 14 days' }, focus: 'skills-reviews',
    scope: { exclude: { repos: [], islands: [] }, unrecorded: [] },
    counts: { inScope: 12, excluded: 0, otherFleets: 0, remote: 0, unrecorded: [], missing: {} },
    reviews: 'gh', agent: 'claude', billing: 'subscription', presets: [PRESET],
    batches: batches.map((b, i) => ({ id: ids[i], excerpts: b.map((e) => e.id), tokens: 1_000 })), thin: [], pricesChecked: '2026-10-27',
  };
  const target: Target = { id: 'skill:publish', kind: 'skill', name: 'publish', path: file, realPath: file, class: 'local', hash: 'abc', review: false };
  const { runner, seen } = fake(answer);
  const statuses: RetroStatus[] = [];
  const signal = new AbortController().signal;
  const input: RunInput = {
    plan, preset: PRESET, budget: 10_000_000, runner: () => runner, dir, ledgerFile: path.join(home, 'ledger.json'), targets: [target],
    measure: { outlines: [], span: plan.span, prOf: new Map(), comments: new Map() },
    runs: {}, unused: [], mechanical: [], thin: [], previous: [], onStatus: (s) => statuses.push(s), signal, now: () => T0 + DAY, ...more,
  };
  return { input, dir, seen, statuses, target, signal };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const read = (dir: string, name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

describe('runPlan', () => {
  it('reads three at a time and judges once', async () => {
    let now = 0, most = 0;
    const batches = ['s1', 's2', 's3', 's4', 's5'].map((s) => [excerpt(s)]);
    const { input, dir, seen, statuses, signal } = setup(batches, async (side, prompt) => {
      if (side === 'judge') return findings(judged(['s1', 's2', 's3']));
      most = Math.max(most, ++now);
      await tick();
      now--;
      return notes(note(/session=(\w+)/.exec(prompt)![1]));
    });
    const report = await runPlan(input);

    expect(most).toBe(3);
    const reads = seen.filter((s) => s.side === 'read');
    expect(reads.map((s) => /session=(\w+)/.exec(s.prompt)![1])).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(reads[0].call).toEqual({ model: 'sonnet', effort: 'low', schema: wireSchema(NoteReply), timeoutMs: 300_000 });
    const judges = seen.filter((s) => s.side === 'judge');
    expect(judges).toHaveLength(1);
    expect(judges[0].call).toEqual({ model: 'opus', schema: wireSchema(JudgeReply), timeoutMs: 600_000 });
    expect(seen.every((s) => s.signal === signal)).toBe(true);
    // the judge reads every note, in batch order
    expect(judges[0].prompt.indexOf('s1 skipped')).toBeLessThan(judges[0].prompt.indexOf('s5 skipped'));

    expect(statuses[0]).toEqual({ run: 'r_1', stage: 'reading', done: 0, total: 5 });
    expect(statuses.map((s) => s.stage)).toEqual([...Array(6).fill('reading'), 'judging', 'done']);
    expect(statuses.at(-1)).toEqual({ run: 'r_1', stage: 'done', done: 5, total: 5 });

    expect(report).toMatchObject({ run: 'r_1', skipped: [], usage: { budget: 10_000_000, used: 6 * 150 } });
    expect(report.findings).toHaveLength(1);
    expect(read(dir, 'findings.json')).toEqual(report.findings);
    expect(read(dir, 'notes/b03.json')).toEqual([note('s3')]);
    expect(read(dir, 'totals.json')).toEqual({
      counts: input.plan.counts, measures: { [report.findings[0].id]: report.findings[0].measure },
      usage: { budget: 10_000_000, used: 900, over: 900 - 10_000_000 }, skipped: [],
    });
    expect(readLedger(input.ledgerFile)[report.findings[0].id]).toMatchObject({ status: 'open', firstSeen: T0 + DAY });
    expect(fs.existsSync(path.join(dir, 'batches'))).toBe(false);
  });

  it("stops reading when the budget won't cover the next batch and reports what it skipped", async () => {
    const batches = ['s1', 's2', 's3', 's4'].map((s) => [excerpt(s, { skill: 'babysit-pr' })]);
    // the judge's share and two reads; the third is refused, and the fourth after it
    const budget = judgeTokens(4, 'claude').max + 2 * readTokens(1_000, 'claude').max + 10;
    const { input, dir, seen } = setup(batches, (side, prompt) =>
      side === 'judge' ? findings() : notes(note(/session=(\w+)/.exec(prompt)![1])), { budget, runs: { 'babysit-pr': 131, publish: 0 } });
    const report = await runPlan(input);

    expect(seen.filter((s) => s.side === 'read')).toHaveLength(2);
    expect(seen.filter((s) => s.side === 'judge')).toHaveLength(1);
    const skipped = ['babysit-pr: 2 of 131 runs read', 'b03 not read: over the budget', 'b04 not read: over the budget'];
    expect(report.skipped).toEqual(skipped);
    expect(report.usage).toEqual({ budget, used: 450 });
    expect(read(dir, 'totals.json')).toMatchObject({ usage: { budget, used: 450, over: 450 - budget }, skipped });
    expect(fs.existsSync(path.join(dir, 'notes', 'b03.json'))).toBe(false);
  });

  it('reads nothing after a batch the budget refused, though a smaller one after it would fit', async () => {
    const batches = ['s1', 's2', 's3'].map((s) => [excerpt(s)]);
    const budget = judgeTokens(3, 'claude').max + readTokens(1_000, 'claude').max + readTokens(10, 'claude').max;
    const { input, seen } = setup(batches, (side, prompt) => (side === 'judge' ? findings() : notes(note(/session=(\w+)/.exec(prompt)![1]))), { budget });
    input.plan.batches[1].tokens = 500_000;
    input.plan.batches[2].tokens = 10;
    const report = await runPlan(input);

    expect(seen.filter((s) => s.side === 'read').map((s) => /session=(\w+)/.exec(s.prompt)![1])).toEqual(['s1']);
    expect(report.skipped).toEqual(['b02 not read: over the budget', 'b03 not read: over the budget']);
  });

  it('charges a call that fails, or whose CLI tells no usage, all it held, and reserves again for a retry', async () => {
    const hold = readTokens(1_000, 'claude').max;
    const usage = (side: 'read' | 'judge', prompt: string) => (side === 'read' && prompt.includes('session=s1') ? { ...USAGE, input: 0, output: 0 } : USAGE);
    const runner: Runner = async (system, prompt) => {
      const side = system.startsWith('You judge') ? 'judge' : 'read';
      if (prompt.includes('session=s2')) throw new Error('claude -p exited 1');
      return { text: side === 'judge' ? findings() : notes(note(/session=(\w+)/.exec(prompt)![1])), usage: usage(side, prompt) };
    };
    const { input } = setup([[excerpt('s1')], [excerpt('s2')]], () => '', { runner: () => runner });
    const report = await runPlan(input);

    // s1 told no usage, s2 failed twice, and the judge used 150
    expect(report.usage.used).toBe(3 * hold + 150);
    expect(report.skipped).toEqual([expect.stringMatching(/^b02 not read: claude -p exited 1/)]);
  });

  it('skips a retry the budget left will not cover, and reports it as unread', async () => {
    const hold = readTokens(1_000, 'claude').max;
    const { input, seen } = setup([[excerpt('s1')]], () => { throw new Error('claude -p exited 1'); }, { budget: judgeTokens(1, 'claude').max + hold });
    const report = await runPlan(input);

    expect(seen).toHaveLength(1);
    expect(report.skipped).toEqual(["b01 not read: the budget left won't cover a retry"]);
    expect(report.usage.used).toBe(hold);
  });

  it('finishes a plan with nothing to read on no budget, with no findings', async () => {
    const { input, seen, statuses } = setup([], () => findings(), { budget: 0 });
    const report = await runPlan(input);

    expect(seen).toEqual([]);
    expect(report).toMatchObject({ findings: [], skipped: [], usage: { budget: 0, used: 0 } });
    expect(statuses.at(-1)).toMatchObject({ stage: 'done' });
  });

  it('retries a failed read once then skips it', async () => {
    const batches = [[excerpt('s1')], [excerpt('s2')]];
    const { input, dir, seen } = setup(batches, (side, prompt, n) => {
      if (side === 'judge') return findings();
      if (prompt.includes('session=s1')) {
        if (n === 1) throw new Error('claude -p exited 1');
        return 'not json';
      }
      return n === 1 ? JSON.stringify({ notes: 'none' }) : notes(note('s2'));
    }, { runs: { publish: 2 } });
    const report = await runPlan(input);

    expect(seen.filter((s) => s.side === 'read' && s.prompt.includes('session=s1'))).toHaveLength(2);
    expect(seen.filter((s) => s.side === 'read' && s.prompt.includes('session=s2'))).toHaveLength(2);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped[0]).toBe('publish: 1 of 2 runs read');
    expect(report.skipped[1]).toMatch(/^b01 not read: /);
    expect(fs.existsSync(path.join(dir, 'notes', 'b01.json'))).toBe(false);
    expect(read(dir, 'notes/b02.json')).toEqual([note('s2')]);
  });

  it('drops a note pointing at a session outside its batch', async () => {
    const batches = [[excerpt('s1'), excerpt('s2', { pr: PR, focus: 'review-tweaks' })], [excerpt('s9')]];
    const secret = `token sk-ant-${'x'.repeat(20)} `;
    const { input, dir, seen } = setup(batches, (side, prompt) => {
      if (side === 'judge') return findings();
      if (prompt.includes('session=s9')) return notes();
      return notes(
        note('s1'),
        note('s9'),
        note('s1', { source: { agent: 'codex', session: 's1', line: 2 } }),
        note('s2', { source: { pr: PR }, focus: 'review-tweaks', category: 'test-gap' }),
        note('s2', { source: { pr: 'https://github.com/o/r/pull/8' }, focus: 'review-tweaks', category: 'test-gap' }),
        note('s2', { target: 'skill:nope', quote: secret + 'q'.repeat(400), claim: 'c'.repeat(700) }),
      );
    });
    await runPlan(input);

    const kept = read(dir, 'notes/b01.json') as Note[];
    expect(kept.map((n) => ('pr' in n.source ? n.source.pr : n.source.session))).toEqual(['s1', PR, 's2']);
    const last = kept[2];
    expect(last.target).toBeNull();
    expect(last.quote.length).toBeLessThanOrEqual(300);
    expect(last.quote).toContain('[redacted]');
    expect(last.quote).not.toContain('sk-ant-');
    expect(last.claim.length).toBeLessThanOrEqual(600);
    const judge = seen.find((s) => s.side === 'judge')!;
    expect(judge.prompt).not.toContain('s9 skipped');
    expect(judge.prompt).not.toContain('pull/8');
    // the targets the notes name go to the judge with their text
    expect(judge.prompt).toContain('2. tag');
  });

  it('drops a finding seen in fewer than three sessions or two PRs the notes it was given stand on', async () => {
    const review = { focus: 'review-tweaks', category: 'test-gap' } as const;
    const batch = [excerpt('s1'), excerpt('s2', { pr: PR }), excerpt('s3', { pr: `${PR}0` })];
    const unusedSkill = (subject: string, rank: number, kind: 'proposal' | 'diff' = 'proposal') =>
      judged([], { focus: 'skill-triggers', category: 'unused-skill', subject, rank, change: { kind, summary: 'retire it', text: 'remove it' } });
    const { input, target } = setup([batch], (side) => side === 'read'
      ? notes(note('s1'), note('s2'), note('s3'), note('s2', { source: { pr: PR }, ...review }), note('s3', { source: { pr: `${PR}0` }, ...review }))
      : findings(
        judged(['s1', 's2', 's3'], { rank: 2 }),
        judged(['s1', 's2', 's1'], { subject: 'two', rank: 1 }),
        // sessions no note stands on are no evidence, however many the judge names
        judged(['s1', 's8', 's9'], { subject: 'invented', rank: 1 }),
        judged([], { subject: 'prs', focus: 'review-tweaks', category: 'missed-defect', rank: 3, evidence: [{ source: { pr: PR }, quote: 'a' }, { source: { pr: `${PR}0` }, quote: 'b' }] }),
        judged([], { subject: 'one-pr', focus: 'review-tweaks', category: 'missed-defect', rank: 4, evidence: [{ source: { pr: PR }, quote: 'a' }, { source: { pr: PR }, quote: 'b' }] }),
        unusedSkill('old', 5), unusedSkill('old-diff', 6, 'diff'), unusedSkill('used', 7),
      ), { unused: ['old', 'old-diff'] });
    const report = await runPlan(input);

    expect(report.findings.map((f) => [f.category, f.sessions, f.prs])).toEqual([['skipped-step', 3, 0], ['missed-defect', 0, 2], ['unused-skill', 0, 0]]);
    expect(report.findings[2].id).toBe(findingId('skill-triggers', 'unused-skill', target.realPath, 'old'));
    expect(report.findings[0].evidence.map((e) => ('pr' in e.source ? e.source.pr : e.source.session))).toEqual(['s1', 's2', 's3']);
  });

  it("counts evidence only at a noted line, and prints the note's own quote for it", async () => {
    const { input } = setup(THREE, (side) => side === 'read'
      ? notes(note('s1'), note('s2'), note('s3', { source: { agent: 'claude', session: 's3', line: 7 } }))
      : findings(
        { ...judged(['s1', 's2', 's3']), evidence: [1, 2, 3].map((i) => ({ source: { agent: 'claude', session: `s${i}`, line: i === 3 ? 7 : 2 }, quote: 'invented' })) },
        judged(['s1', 's2', 's3'], { subject: 'unnoted-line' }),
      ));
    const report = await runPlan(input);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].evidence.map((e) => e.quote)).toEqual(['L2 TOOL: Skill publish', 'L2 TOOL: Skill publish', 'L2 TOOL: Skill publish']);
  });

  it('keeps the notes and findings of a reply that fit, and drops those that do not', async () => {
    const offFocus = note('s2', { category: 'missed-trigger' });
    const { input, dir } = setup(THREE, (side) => side === 'read'
      ? notes(note('s1'), offFocus, note('s2'), note('s3'))
      : JSON.stringify({ findings: [judged(['s1', 's2', 's3']), { ...judged(['s1', 's2', 's3'], { subject: 'bad' }), category: 'missed-trigger' }, { title: 'no shape' }] }));
    const report = await runPlan(input);

    expect(read(dir, 'notes/b01.json')).toEqual([note('s1'), note('s2'), note('s3')]);
    expect(report.findings.map((f) => f.title)).toEqual(['publish skips the changelog']);
  });

  it("cuts a read's notes to 2k tokens", async () => {
    const many = Array.from({ length: 40 }, () => note('s1', { claim: 'c'.repeat(600) }));
    const { input, dir } = setup([[excerpt('s1')]], (side) => (side === 'read' ? notes(...many) : findings()));
    await runPlan(input);

    const kept = read(dir, 'notes/b01.json') as Note[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(many.length);
    expect(kept.reduce((n, x) => n + JSON.stringify(x).length + 1, 0)).toBeLessThanOrEqual(2_000 * 3.5);
  });

  it('keeps one finding per id, the better ranked', async () => {
    const { input } = setup(THREE, (side) => threeNotes(side, findings(
      judged(['s1', 's2', 's3'], { title: 'second', rank: 2 }),
      judged(['s1', 's2', 's3'], { title: 'first', rank: 1 }),
    )));
    const report = await runPlan(input);

    expect(report.findings.map((f) => [f.title, f.rank])).toEqual([['first', 1]]);
  });

  it('gives a target the judge was not shown no hash, as no diff was made against it', async () => {
    const other: Target = { id: 'skill:other', kind: 'skill', name: 'other', path: '/s/other/SKILL.md', realPath: '/s/other/SKILL.md', class: 'local', hash: 'inventory', review: false };
    const { input } = setup(THREE, (side) => threeNotes(side, findings(judged(['s1', 's2', 's3'], { target: 'skill:other', subject: 'other' }))));
    const report = await runPlan({ ...input, targets: [...input.targets, other] });
    expect(report.findings[0].target).toMatchObject({ id: 'skill:other', hash: null });
  });

  it('keeps the seven top-ranked findings with their targets, ids and measures', async () => {
    const draft = '~/.claude/skills/changelog/SKILL.md';
    const outlines = [session('s1', T0 - DAY, 'interrupt'), session('s2', T0 - DAY), session('s3', T0 - DAY, 'reply')];
    const { input, target } = setup(THREE, (side) => threeNotes(side, findings(
      ...Array.from({ length: 8 }, (_, i) => judged(['s1', 's2', 's3'], { subject: `skill-${i}`, rank: 12 - i })),
      judged(['s1', 's2', 's3'], { rank: 1, change: { kind: 'diff', summary: 's', text: '+export KEY_TOKEN=hunter2secret' } }),
      judged(['s1', 's2', 's3'], { rank: 2, target: draft, change: { kind: 'draft', summary: 'a changelog skill', text: '# changelog' } }),
      judged(['s1', 's2', 's3'], { rank: 3, target: null, subject: 'none' }),
      judged(['s1', 's2', 's3'], { rank: 4, target: 'skill:gone', subject: 'gone' }),
    )), { measure: { outlines, span: { from: T0 - 14 * DAY, to: T0 }, prOf: new Map(), comments: new Map() } });
    const report = await runPlan(input);

    expect(report.findings.map((f) => f.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const [top, drafted, none, gone] = report.findings;
    expect(top.id).toBe(findingId('skill-tweaks', 'skipped-step', target.realPath, 'publish'));
    // the hash of the file as the judge read it, not the inventory's
    expect(top.target).toEqual({ id: 'skill:publish', path: target.path, realPath: target.realPath, class: 'local', hash: crypto.createHash('sha256').update(fs.readFileSync(target.path)).digest('hex') });
    expect(top.change.text).toBe('+export KEY_TOKEN=[redacted]');
    expect(top.measure).toEqual({ kind: 'followups-after-skill', subject: 'publish', name: 'follow-ups after /publish', before: { count: 2, of: 3 }, after: null });
    const home = path.join(os.homedir(), '.claude/skills/changelog/SKILL.md');
    expect(drafted.target).toEqual({ path: home, realPath: home, class: 'local', hash: null });
    expect(drafted.id).toBe(findingId('skill-tweaks', 'skipped-step', home, 'publish'));
    expect(none.target).toBeNull();
    expect(none.id).toBe(findingId('skill-tweaks', 'skipped-step', '', 'none'));
    expect(gone.target).toBeNull();
  });

  it('never re-proposes a dismissed id', async () => {
    const { input, seen, target } = setup(THREE, (side) => threeNotes(side, findings(
      judged(['s1', 's2', 's3']),
      judged(['s1', 's2', 's3'], { category: 'redone', rank: 2 }),
    )));
    const id = findingId('skill-tweaks', 'skipped-step', target.realPath, 'publish');
    writeLedger(input.ledgerFile, mark(recordFindings({}, [finding(id)], T0 - DAY), id, 'dismissed', { at: T0 - DAY, reason: 'wrong' }));
    const report = await runPlan(input);

    expect(report.findings.map((f) => f.category)).toEqual(['redone']);
    expect(seen.find((s) => s.side === 'judge')!.prompt).toContain('- skill-tweaks/skipped-step (wrong)');
    expect(readLedger(input.ledgerFile)[id]).toMatchObject({ status: 'dismissed', reason: 'wrong' });
  });

  it('deletes batches when the run ends, even when it fails', async () => {
    const { input, dir, seen, statuses } = setup([[excerpt('s1')]], (side) => {
      if (side === 'judge') throw new Error('claude -p failed: not logged in');
      return notes(note('s1'));
    });
    await expect(runPlan(input)).rejects.toThrow('not logged in');

    expect(seen.filter((s) => s.side === 'judge')).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'batches'))).toBe(false);
    expect(read(dir, 'notes/b01.json')).toEqual([note('s1')]);
    expect(fs.existsSync(path.join(dir, 'findings.json'))).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ run: 'r_1', stage: 'failed', error: 'claude -p failed: not logged in' });
  });

  it('measures a previous fix after its fix date', async () => {
    const fixedAt = T0 - 7 * DAY;
    const outlines = [
      session('a', fixedAt - DAY, 'interrupt'), session('b', fixedAt - DAY, 'interrupt'),
      session('c', fixedAt + DAY), session('d', fixedAt + DAY, 'interrupt'), session('e', fixedAt + 2 * DAY),
    ];
    const { input, dir, seen } = setup([], () => findings(), {
      previous: [finding('fixed1'), finding('open1')],
      measure: { outlines, span: { from: T0 - 14 * DAY, to: T0 }, prOf: new Map(), comments: new Map() },
    });
    writeLedger(input.ledgerFile, mark(recordFindings({}, [finding('fixed1'), finding('open1')], T0 - 10 * DAY), 'fixed1', 'fixed', { at: fixedAt }));
    const report = await runPlan(input);

    expect(report.previous.map((f) => f.measure)).toEqual([
      { kind: 'followups-after-skill', subject: 'publish', name: 'follow-ups after /publish', before: { count: 9, of: 20 }, after: { count: 1, of: 3 } },
      { kind: 'followups-after-skill', subject: 'publish', name: 'follow-ups after /publish', before: { count: 9, of: 20 }, after: null },
    ]);
    expect((read(dir, 'totals.json') as { measures: Record<string, unknown> }).measures.fixed1).toEqual(report.previous[0].measure);
    // nothing was read, so nothing is judged
    expect(seen).toEqual([]);
  });
});
