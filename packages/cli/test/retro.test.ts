import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetroPlan, RetroStatus } from '@svall/protocol';
import { finding, report } from '@svall/svalld/retro/test-report';
import type { Client } from '../src/client.js';
import { formatPlan, retroCommands } from '../src/commands/retro.js';

const plan: RetroPlan = {
  version: 2, id: 'r_1761562980', created: 0, span: { from: 0, to: 1, label: 'since the last retro (2026-10-13)' },
  scope: { exclude: { repos: [], islands: [] }, unrecorded: [] },
  counts: { inScope: 412, excluded: 37, otherFleets: 9, remote: 3, unrecorded: [{ repo: '/code/storefront', count: 12, picked: false }], missing: { cost: 31 } },
  reviews: 'gh', agent: 'claude', billing: 'api-key',
  presets: [
    { name: 'thrifty', label: 'Thrifty — Haiku reads, Sonnet judges, Sonnet verifies', read: { agent: 'claude', model: 'haiku' }, judge: { agent: 'claude', model: 'sonnet' }, verify: { agent: 'claude', model: 'sonnet' }, tokens: { min: 700_000, max: 900_000 }, cost: { min: 0.3, max: 0.6 } },
    { name: 'balanced', label: 'Balanced — Haiku reads, Opus judges, Sonnet verifies', read: { agent: 'claude', model: 'haiku' }, judge: { agent: 'claude', model: 'opus' }, verify: { agent: 'claude', model: 'sonnet' }, tokens: { min: 960_000, max: 1_210_000 }, cost: { min: 2.3, max: 4 } },
  ],
  work: { sessions: 194, chunks: 230, cached: 120, calls: 35, prs: 17, comments: 31 }, pricesChecked: '2026-10-27',
};

function fake(answers: Partial<Record<string, unknown | ((p: unknown) => unknown)>>) {
  const calls: [string, unknown][] = [];
  const out: string[] = [];
  const client = {
    call: (method: string, p: unknown) => {
      calls.push([method, p]);
      const a = answers[method];
      return Promise.resolve(typeof a === 'function' ? (a as (p: unknown) => unknown)(p) : a);
    },
    close: () => {},
  } as unknown as Client;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-'));
  const run = (...args: string[]) => retroCommands(() => Promise.resolve(client), () => false, () => home).parseAsync(args, { from: 'user' });
  return { calls, out, run, home };
}

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('svall retro', () => {
  it('plan prints scope counts, what the cache holds, and typical and cap tokens and cost per preset, and passes the picks on', async () => {
    const f = fake({ 'retro.plan': plan });
    await f.run('plan', '--span', '7d', '--exclude-island', 'Life', '--pick', '/code/storefront');
    expect(f.calls).toEqual([['retro.plan', { span: '7d', exclude: { repos: undefined, islands: ['Life'] }, unrecorded: ['/code/storefront'] }]]);
    const text = f.out.join('');
    expect(text).toContain('scope: 412 in scope, 37 excluded, 9 in other fleets, 3 robots on another machine');
    expect(text).toContain('not recorded by a fleet (read only when picked): /code/storefront 12');
    expect(text).toContain('missing: 31 sessions without cost');
    expect(text).toContain('cards: 194 sessions, 120 of 230 chunks cached, 35 calls');
    expect(text).toContain('reviews: 17 PRs from gh, 31 later comments to label');
    expect(text).toContain('Claude Code, API key: this is billed as money');
    expect(text).toMatch(/balanced\s+Balanced — Haiku reads, Opus judges, Sonnet verifies\s+typical ~960k, cap 1\.2M\s+~\$2\.3–4\.0/);
    expect(text).toContain('prices checked 2026-10-27');
    const options = retroCommands(() => Promise.reject(new Error('no daemon')), () => false, () => f.home).commands.find((c) => c.name() === 'plan')!.options;
    expect(options.map((o) => o.long)).not.toContain('--focus');
  });

  it('says when reviews are skipped for want of gh', () => {
    expect(formatPlan({ ...plan, reviews: 'no-gh' })).toContain('reviews: skipped: gh is not installed or signed in');
  });

  it('findings prints the summary, pointing at the report in the fleet home', async () => {
    const f = fake({ 'retro.findings': report() });
    await f.run('findings');
    const text = f.out.join('');
    expect(text).toContain(`Report: \`${path.join(f.home, 'retro', 'runs', 'r_1793263426', 'report.md')}\``);
    expect(text).toContain('Local reviews miss missing specs that others catch');
  });

  it('show prints a finding of the newest run or the one named, without control bytes', async () => {
    const f = fake({ 'retro.show': { text: '### 2. real\x1b]0;pwned\x07\n```diff\n+b\x1b[2J\n```' } });
    await f.run('show', '2');
    await f.run('show', '1', 'r_5');
    expect(f.calls).toEqual([['retro.show', { n: 2, run: undefined }], ['retro.show', { n: 1, run: 'r_5' }]]);
    expect(f.out.join('')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    await expect(f.run('show', 'a1')).rejects.toThrow('bad finding "a1"');
  });

  it('shows a subscription tokens, not money', () => {
    const text = formatPlan({ ...plan, billing: 'subscription' });
    expect(text).toContain("subscription: tokens count toward your plan's limits");
    expect(text).not.toContain('$');
  });

  it('mark maps numbers to the ids of the latest findings, and a dismissal needs a reason', async () => {
    const f = fake({ 'retro.findings': report({ findings: [finding('aaa'), finding('bbb')] }), 'retro.mark': { results: [{ id: 'bbb', outcome: 'later' }] } });
    await f.run('mark', 'later', '2');
    expect(f.calls.at(-1)).toEqual(['retro.mark', { marks: [{ id: 'bbb', action: 'later' }] }]);
    expect(f.out.at(-1)).toContain('2: later');
    await expect(f.run('mark', 'dismiss', '1')).rejects.toThrow('--reason wrong|not-worth-it');
    // a number past the findings, or of none, is an id, as an id may be all digits
    await f.run('mark', 'fix', '3', '0', '1234567890');
    expect(f.calls.at(-1)).toEqual(['retro.mark', { marks: [{ id: '3', action: 'fix' }, { id: '0', action: 'fix' }, { id: '1234567890', action: 'fix' }] }]);
  });

  it('mark names each result by the number the user gave, and applies by the id', async () => {
    const f = fake({ 'retro.findings': report({ findings: [finding('aaa')] }), 'retro.mark': { results: [{ id: 'aaa', outcome: 'apply', path: '/u/.claude/CLAUDE.md', diff: '+x' }] } });
    await f.run('mark', 'fix', '1');
    expect(f.out.join('')).toContain('1: show the user this diff for /u/.claude/CLAUDE.md; on their OK, svall retro apply aaa\n');
  });

  it('run names a preset only when given one, for svalld to pick the plan\'s own', async () => {
    const f = fake({ 'retro.run': { run: 'r_1' } });
    await f.run('run', 'r_1');
    await f.run('run', 'r_1', '--preset', 'default');
    expect(f.calls.map(([, p]) => (p as { preset?: string }).preset)).toEqual([undefined, 'default']);
  });

  it('run passes the budget the user gave, and refuses one that is not a whole number of tokens', async () => {
    const f = fake({ 'retro.run': { run: 'r_1' } });
    await f.run('run', 'r_1', '--preset', 'thrifty', '--budget', '500000');
    expect(f.calls).toEqual([['retro.run', { plan: 'r_1', preset: 'thrifty', budget: 500_000, robot: process.env.SVALL_ROBOT_ID }]]);
    await expect(f.run('run', 'r_1', '--budget', '5e5x')).rejects.toThrow('bad --budget');
  });

  it('wait follows the stages and the tokens used, and exits 1 on an interrupted run', async () => {
    const stages: RetroStatus[] = [
      { run: 'r_1', stage: 'reading', done: 0, total: 194 }, { run: 'r_1', stage: 'reading', done: 84, total: 194, used: 410_000 },
      { run: 'r_1', stage: 'judging', done: 194, total: 194, used: 600_000 }, { run: 'r_1', stage: 'interrupted', done: 194, total: 194, used: 640_000 },
    ];
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const f = fake({ 'retro.status': () => stages.shift() });
    const waiting = f.run('wait');
    await vi.runAllTimersAsync();
    await waiting;
    vi.useRealTimers();
    expect(f.out.join('')).toBe('r_1 reading 0/194\nr_1 reading 84/194 · 410k\nr_1 judging · 600k\nr_1 interrupted · 640k\n');
    expect(process.exitCode).toBe(1);
  });

  it('config writes the retro section of fleet.json', async () => {
    const f = fake({});
    fs.writeFileSync(path.join(f.home, 'fleet.json'), JSON.stringify({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' }));
    await f.run('config', '--exclude-island', 'Life', '--read-model', 'haiku', '--review-skills', 'work-review, deep-review');
    await f.run('config', '--verify-model', 'opus');
    const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'fleet.json'), 'utf8')) as { retro: unknown };
    expect(saved.retro).toEqual({ exclude: { repos: [], islands: ['Life'] }, unrecorded: [], model: { claude: { read: 'haiku', verify: 'opus' } }, reviewSkills: ['work-review', 'deep-review'] });
  });
});
