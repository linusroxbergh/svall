import { afterEach, describe, expect, it } from 'vitest';
import type { AgentKind, Robot, UsageSnapshot } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import { mergeUsage } from '../../src/usage/merge.js';
import { cleanHomes } from '../helpers.js';
import { placed, robot, until, world } from '../placement/world.js';

const worlds: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.stop();
  cleanHomes();
});
const open = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };

// a robot whose agent runs in its pane, its transcript at `file`
const running = (make: typeof robot, id: string, kind: AgentKind, file: string): Robot =>
  make({ id, tmux: { windowId: '@1', paneId: '%1' }, agent: { kind, sessionId: 's', status: 'idle', lastActivityAt: 0, transcriptPath: file } });

// a codex rollout whose last turn, at `at`, reports its primary window at `pct`
const rollout = (pct: number, at: string): string => JSON.stringify({
  timestamp: at, type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 }, rate_limits: { primary: { used_percent: pct, window_minutes: 300 } } },
}) + '\n';
// the home's robot took the newer turn, which a worker reading it would show
const tails = { '/w1/c_1.jsonl': rollout(40, '2026-10-25T12:00:00.000Z'), '/mac/c_h.jsonl': rollout(90, '2026-10-25T13:00:00.000Z') };
const session: UsageSnapshot = { available: true, windows: [{ key: 'session', label: 'Session', pct: 10 }] };
// a claude robot on the home beside a codex one on w1, as both stores hold them
const fleet = { c_m: running(robot, 'c_m', 'claude', '/mac/c_m.jsonl'), c_1: running(placed, 'c_1', 'codex', '/w1/c_1.jsonl') };

const linked = async (w: ReturnType<typeof world>): Promise<void> => {
  await w.link();
  await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
};

describe('usage across machines', () => {
  it('a worker reads codex windows off its own robots\' rollouts and leaves the home\'s robots alone', async () => {
    const w = open({ worker: { robots: { c_1: running(placed, 'c_1', 'codex', '/w1/c_1.jsonl'), c_h: running(robot, 'c_h', 'codex', '/mac/c_h.jsonl') } }, usage: { tails } });
    const usage = w.worker.usage;
    expect(await usage()).toMatchObject({ available: true, windows: [{ key: 'codex:primary', pct: 40, at: Date.parse('2026-10-25T12:00:00.000Z') }] });
  });

  it('a window more than one machine reads off a transcript shows the newest reading, in the home\'s place', () => {
    const codex = (pct: number, at?: number) => ({ key: 'codex:primary', label: 'Codex 5 hours', pct, ...(at && { at }) });
    const home: UsageSnapshot = { available: true, windows: [{ key: 'session', label: 'Session', pct: 10 }, codex(5, 1_000)] };
    expect(mergeUsage(home, [{ available: true, windows: [codex(40, 3_000)] }, { available: true, windows: [codex(60, 2_000)] }]).windows)
      .toEqual([{ key: 'session', label: 'Session', pct: 10 }, codex(40, 3_000)]);
    expect(mergeUsage(home, [{ available: true, windows: [codex(40, 500)] }]).windows).toEqual(home.windows);
    // a window read live was read as the panel asked, so the home's stands
    expect(mergeUsage({ available: true, windows: [codex(5)] }, [{ available: true, windows: [codex(40, 3_000)] }]).windows).toEqual([codex(5)]);
  });

  it('the home\'s usage.get carries a worker\'s codex window beside its own claude windows, home first where keys meet', async () => {
    expect(mergeUsage({ available: true, windows: [{ key: 'session', label: 'Session', pct: 10 }, { key: 'codex:primary', label: 'Codex', pct: 5 }] }, [{ available: true, windows: [{ key: 'codex:primary', label: 'Codex', pct: 40 }, { key: 'codex:secondary', label: 'Codex 7 days', pct: 3 }] }]).windows.map((w) => [w.key, w.pct]))
      .toEqual([['session', 10], ['codex:primary', 5], ['codex:secondary', 3]]);
    const w = open({ home: { robots: fleet }, worker: { robots: fleet }, usage: { claude: async () => session, tails } });
    await linked(w);
    expect(await dispatch({ id: 1, method: 'usage.get', params: {} }, w.home.ctx))
      .toMatchObject({ result: { available: true, windows: [{ key: 'session', pct: 10 }, { key: 'codex:primary', pct: 40 }] } });
  });

  it('merges plan limits as available when a running machine\'s are, idle when every machine is, and names the home\'s login', () => {
    const idle: UsageSnapshot = { available: true, idle: true, windows: [] };
    const codex = [{ key: 'codex:primary', label: 'Codex', pct: 40 }];
    expect(mergeUsage(idle, [idle])).toEqual(idle);
    expect(mergeUsage({ ...session, account: 'a@x.io' }, [idle])).toEqual({ ...session, account: 'a@x.io' });
    expect(mergeUsage({ available: false, windows: [] }, [{ available: true, account: 'b@x.io', windows: codex }])).toEqual({ available: true, windows: codex });
    // an idle machine asks no plan, so it says nothing of whether plan limits apply
    expect(mergeUsage({ available: false, windows: [] }, [idle])).toEqual({ available: false, windows: [] });
    expect(mergeUsage(idle, [{ available: false, windows: [] }])).toEqual({ available: false, windows: [] });
  });

  it('a worker that does not answer leaves the home\'s windows standing', async () => {
    const w = open({ home: { robots: fleet }, worker: { robots: fleet }, far: { 'usage.get': () => new Promise(() => {}) }, usage: { claude: async () => session, tails } });
    await linked(w);
    const asked = Date.now();
    expect(await dispatch({ id: 1, method: 'usage.get', params: {} }, w.home.ctx)).toEqual({ id: 1, result: session });
    expect(Date.now() - asked).toBeLessThan(6_000);
  }, 15_000);
});
