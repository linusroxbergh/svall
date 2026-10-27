import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding, RetroPlan, RetroReport, RetroStatus } from '@svall/protocol';
import type { Client } from '../src/client.js';
import { formatPlan, retroCommands } from '../src/commands/retro.js';

const plan: RetroPlan = {
  id: 'r_1761562980', created: 0, span: { from: 0, to: 1, label: 'since the last retro (2026-10-13)' }, focus: 'skills-reviews',
  scope: { exclude: { repos: [], islands: [] }, unrecorded: [] },
  counts: { inScope: 412, excluded: 37, otherFleets: 9, remote: 3, unrecorded: [{ repo: '/code/storefront', count: 12, picked: false }], missing: { cost: 31 } },
  reviews: 'gh', agent: 'claude', billing: 'api-key',
  presets: [
    { name: 'thrifty', label: 'Thrifty — Haiku reads, Sonnet judges', read: { agent: 'claude', model: 'haiku' }, judge: { agent: 'claude', model: 'sonnet' }, tokens: { min: 700_000, max: 900_000 }, cost: { min: 0.3, max: 0.6 } },
    { name: 'balanced', label: 'Balanced — Sonnet reads, Opus judges', read: { agent: 'claude', model: 'sonnet' }, judge: { agent: 'claude', model: 'opus' }, tokens: { min: 960_000, max: 1_210_000 }, cost: { min: 2.3, max: 4 } },
  ],
  batches: [{ id: 'b01', excerpts: ['s:1'], tokens: 840_000 }], thin: [], pricesChecked: '2026-10-27',
};

const finding = (id: string): Finding => ({
  id, focus: 'review-tweaks', category: 'test-gap', title: `finding ${id}`, claim: '12 of 29 PRs got a test-gap comment after work-review passed them.',
  evidence: [{ source: { pr: 'https://github.com/o/r/pull/1' }, quote: 'no test covers the revert' }], sessions: 0, prs: 12,
  change: { kind: 'diff', summary: 'add a revert question to the reviewer prompt', text: '@@ -1 +1,2 @@\n a\n+b' },
  target: { path: '/s/SKILL.md', realPath: '/s/SKILL.md', class: 'local', hash: 'h' },
  measure: { kind: 'none', subject: null, name: 'n', before: null, after: null }, rank: 1,
});

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
  it('plan prints scope counts and a token and cost range per preset, and passes the picks on', async () => {
    const f = fake({ 'retro.plan': plan });
    await f.run('plan', '--span', '7d', '--exclude-island', 'Life', '--pick', '/code/storefront');
    expect(f.calls).toEqual([['retro.plan', { span: '7d', focus: 'skills-reviews', exclude: { repos: undefined, islands: ['Life'] }, unrecorded: ['/code/storefront'] }]]);
    const text = f.out.join('');
    expect(text).toContain('scope: 412 in scope, 37 excluded, 9 in other fleets, 3 robots on another machine');
    expect(text).toContain('not recorded by a fleet (read only when picked): /code/storefront 12');
    expect(text).toContain('missing: 31 sessions without cost');
    expect(text).toContain('Claude Code, API key: this is billed as money');
    expect(text).toMatch(/balanced\s+Balanced — Sonnet reads, Opus judges\s+960k–1\.2M tokens\s+~\$2\.3–4\.0/);
    expect(text).toContain('prices checked 2026-10-27');
  });

  it('shows a subscription tokens, not money', () => {
    const text = formatPlan({ ...plan, billing: 'subscription' });
    expect(text).toContain("subscription: tokens count toward your plan's limits");
    expect(text).not.toContain('$');
  });

  it('mark maps numbers to the ids of the latest findings, and a dismissal needs a reason', async () => {
    const report: RetroReport = { run: 'r_1', findings: [finding('aaa'), finding('bbb')], previous: [], mechanical: [], thin: [], skipped: [], usage: { budget: 1, used: 1 } };
    const f = fake({ 'retro.findings': report, 'retro.mark': { results: [{ id: 'bbb', outcome: 'later' }] } });
    await f.run('mark', 'later', '2');
    expect(f.calls.at(-1)).toEqual(['retro.mark', { marks: [{ id: 'bbb', action: 'later' }] }]);
    await expect(f.run('mark', 'dismiss', '1')).rejects.toThrow('--reason wrong|not-worth-it');
    await expect(f.run('mark', 'fix', '3')).rejects.toThrow('no finding 3: the last findings have 2');
  });

  it('wait follows the stages and exits 1 on an interrupted run', async () => {
    const stages: RetroStatus[] = [
      { run: 'r_1', stage: 'reading', done: 1, total: 3 }, { run: 'r_1', stage: 'interrupted', done: 1, total: 3 },
    ];
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const f = fake({ 'retro.status': () => stages.shift() });
    const waiting = f.run('wait');
    await vi.runAllTimersAsync();
    await waiting;
    vi.useRealTimers();
    expect(f.out.join('')).toBe('r_1 reading 1/3\nr_1 interrupted\n');
    expect(process.exitCode).toBe(1);
  });

  it('config writes the retro section of fleet.json', async () => {
    const f = fake({});
    fs.writeFileSync(path.join(f.home, 'fleet.json'), JSON.stringify({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' }));
    await f.run('config', '--exclude-island', 'Life', '--read-model', 'haiku', '--review-skills', 'work-review, deep-review');
    const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'fleet.json'), 'utf8')) as { retro: unknown };
    expect(saved.retro).toEqual({ exclude: { repos: [], islands: ['Life'] }, unrecorded: [], model: { claude: { read: 'haiku' } }, reviewSkills: ['work-review', 'deep-review'] });
  });
});
