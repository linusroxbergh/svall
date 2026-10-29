import { describe, expect, it } from 'vitest';
import { FleetConfig, FleetState, RetroPlan, RetroReport, RetroStatus } from '../src/index.js';

const span = { from: 0, to: 1, label: 'last 7 days' };

describe('retro contracts', () => {
  it('reads only version 2 plans and reports, so an older run says to plan again', () => {
    const plan = {
      version: 2, id: 'r_1', created: 0, span, scope: { exclude: { repos: [], islands: [] }, unrecorded: [] },
      counts: { inScope: 1, excluded: 0, otherFleets: 0, remote: 0, unrecorded: [], missing: {} }, reviews: 'gh', agent: 'claude', billing: 'subscription',
      presets: [{ name: 'balanced', label: 'b', read: { agent: 'claude', model: 'haiku' }, judge: { agent: 'claude' }, verify: { agent: 'claude' }, tokens: { min: 1, max: 2 } }],
      work: { sessions: 1, chunks: 1, cached: 0, calls: 1, prs: 0, comments: 0 }, pricesChecked: 'x',
    };
    expect(RetroPlan.safeParse(plan).success).toBe(true);
    const { version: _v, ...older } = plan;
    expect(RetroPlan.safeParse({ ...older, focus: 'all', batches: [] }).success).toBe(false);
    expect(RetroReport.safeParse({ run: 'r_1', findings: [], previous: [], mechanical: [], thin: [], skipped: [], usage: { budget: 1, used: 1 } }).success).toBe(false);
  });

  it('carries the tokens a run has used on its status and on the card', () => {
    expect(RetroStatus.parse({ run: 'r_1', stage: 'reading', done: 84, total: 194, used: 410_000 }).used).toBe(410_000);
    const state = FleetState.parse({ version: 12, islands: {}, robots: {}, retro: { run: 'r_1', stage: 'reading', done: 1, total: 2, used: 9, robot: 'c_1' } });
    expect(state.retro).toEqual({ run: 'r_1', stage: 'reading', done: 1, total: 2, used: 9, robot: 'c_1' });
  });

  it('parses a fleet.json with no retro, and keeps read, judge and verify models', () => {
    const id = '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    expect(FleetConfig.parse({ id }).retro).toEqual({ exclude: { repos: [], islands: [] }, unrecorded: [] });
    const retro = { exclude: { repos: ['/r'], islands: ['Life'] }, unrecorded: ['/u'], model: { claude: { read: 'haiku', judge: 'opus', verify: 'sonnet' } }, reviewSkills: ['work-review'] };
    expect(FleetConfig.parse({ id, retro }).retro).toEqual(retro);
  });
});
