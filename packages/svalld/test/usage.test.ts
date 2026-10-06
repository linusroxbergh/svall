import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind, FleetState, UsageSnapshot } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { cachedUsage, codexWindows, fleetUsage, usageFetcher } from '../src/usage/usage.js';
import { cleanHomes, makeHome } from './helpers.js';

const limits = (extra: string): string =>
  `{"type":"control_response","response":{"subtype":"success","request_id":"u1","response":{"subscription_type":"max","rate_limits_available":true,"rate_limits":{${extra}}}}}`;

const full = limits([
  '"five_hour":{"utilization":35,"resets_at":"2026-09-16T13:50:00Z"}',
  '"seven_day":{"utilization":56,"resets_at":"2026-09-20T22:00:00Z"}',
  '"seven_day_opus":null',
  '"model_scoped":[{"display_name":"Fable","utilization":52,"resets_at":"2026-09-20T21:59:59Z"}]',
].join(','));

const apiKey = '{"type":"control_response","response":{"subtype":"success","request_id":"u1","response":{"subscription_type":null,"rate_limits_available":false,"rate_limits":null}}}';

// a stand-in for `claude` in stream-json mode, found first on PATH; FAKE_CLAUDE picks how it answers
const FAKE = `#!/bin/sh
read line
case "$FAKE_CLAUDE" in
  ok) echo '${full}'; exec sleep 30 ;;
  apikey) echo '${apiKey}'; exec sleep 30 ;;
  noise) echo '{"type":"system","subtype":"init"}'; echo 'not json'; echo '${full}'; exec sleep 30 ;;
  failed) echo '{"type":"control_response","response":{"subtype":"error","request_id":"u1","error":"not logged in"}}' ;;
  null) echo 'null'; echo '${full}'; exec sleep 30 ;;
  shape) echo '${limits('"model_scoped":{"not":"an array"}')}'; exec sleep 30 ;;
  echo) echo "$line" > "$FAKE_OUT"; echo "char=\${SVALL_CHAR_ID:-none} key=\${ANTHROPIC_API_KEY:-none}" >> "$FAKE_OUT"; echo '${full}' ;;
  exit) echo 'no credentials' >&2; exit 3 ;;
  hang) exec sleep 30 ;;
esac
`;

describe('usageFetcher', () => {
  let home: string;
  let fetch: ReturnType<typeof usageFetcher>;
  let envFile: string;

  beforeEach(() => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'claude'), FAKE, { mode: 0o755 });
    vi.stubEnv('PATH', `${home}:${process.env.PATH}`);
    vi.stubEnv('SVALL_CHAR_ID', 'c_parent');
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    envFile = path.join(home, '.env');
    fetch = usageFetcher({ cwd: path.join(home, 'usage'), envFile });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanHomes();
  });

  it('reads the session, week and model-scoped windows, in that order', async () => {
    vi.stubEnv('FAKE_CLAUDE', 'ok');
    const snap = await fetch();
    expect(snap.available).toBe(true);
    expect(snap.windows).toEqual([
      { key: 'session', label: 'Session', pct: 35, resetsAt: '2026-09-16T13:50:00Z' },
      { key: 'week', label: 'Week', pct: 56, resetsAt: '2026-09-20T22:00:00Z' },
      { key: 'model:0:Fable', label: 'Fable', pct: 52, resetsAt: '2026-09-20T21:59:59Z' },
    ]);
  });

  it('answers before the child exits, and skips lines that are not the response', async () => {
    vi.stubEnv('FAKE_CLAUDE', 'noise');
    await expect(fetch()).resolves.toMatchObject({ available: true });
  });

  it('reports a login with no plan limits as unavailable rather than failing', async () => {
    vi.stubEnv('FAKE_CLAUDE', 'apikey');
    await expect(fetch()).resolves.toEqual({ available: false, windows: [] });
  });

  it('asks for the plan limits alone, without the character id, and with the fleet .env', async () => {
    const out = path.join(home, 'out');
    vi.stubEnv('FAKE_CLAUDE', 'echo');
    vi.stubEnv('FAKE_OUT', out);
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY="sk-ant-test"\n');
    await fetch();
    const [request, vars] = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(JSON.parse(request)).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } });
    expect(vars).toBe('char=none key=sk-ant-test');
  });

  // claude is resolved from PATH and its replies are not ours to shape: neither a bare null line
  // nor a field of the wrong type may throw past the promise and leave the read hanging to its timeout
  it('reads past a bare null line, and drops a field that is not the array it should be', async () => {
    vi.stubEnv('FAKE_CLAUDE', 'null');
    await expect(fetch()).resolves.toMatchObject({ available: true });
    vi.stubEnv('FAKE_CLAUDE', 'shape');
    await expect(fetch()).resolves.toEqual({ available: true, windows: [] });
  });

  it('rejects an error response, a failed exit and a read that hangs', async () => {
    vi.stubEnv('FAKE_CLAUDE', 'failed');
    await expect(fetch()).rejects.toThrow('not logged in');
    vi.stubEnv('FAKE_CLAUDE', 'exit');
    await expect(fetch()).rejects.toThrow('claude exited 3: no credentials');
    vi.stubEnv('FAKE_CLAUDE', 'hang');
    await expect(usageFetcher({ cwd: path.join(home, 'usage'), envFile, timeoutMs: 2000 })()).rejects.toThrow('timed out after 2000ms');
  });
});

describe('cachedUsage', () => {
  const snapshot: UsageSnapshot = { available: true, windows: [{ key: 'session', label: 'Session', pct: 5 }] };

  it('serves a snapshot within the window, and reads again once it is past', async () => {
    const fetch = vi.fn(async () => snapshot);
    let now = 1000;
    const cached = cachedUsage(fetch, 60_000, () => now);
    const first = await cached();
    now += 59_000;
    expect(await cached()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2000;
    await cached();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one read between callers asking at once', async () => {
    let answer!: (s: UsageSnapshot) => void;
    const fetch = vi.fn(() => new Promise<UsageSnapshot>((r) => { answer = r; }));
    const cached = cachedUsage(fetch, 60_000);
    const both = Promise.all([cached(), cached()]);
    answer(snapshot);
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    const fetch = vi.fn<() => Promise<UsageSnapshot>>().mockRejectedValueOnce(new Error('claude exited 3')).mockResolvedValue(snapshot);
    const cached = cachedUsage(fetch, 60_000);
    await expect(cached()).rejects.toThrow();
    await expect(cached()).resolves.toEqual(snapshot);
  });
});

describe('usage.get', () => {
  it('answers a caller with the reading the fetcher gives', async () => {
    const snapshot = { available: true, windows: [{ key: 'session', label: 'Session', pct: 7 }] };
    const res = await dispatch({ id: 1, method: 'usage.get', params: {} }, { usage: () => Promise.resolve(snapshot) } as unknown as Ctx);
    expect(res).toEqual({ id: 1, result: snapshot });
  });

  it('hands a failed reading back as an error', async () => {
    const usage = () => Promise.reject(new Error('not logged in'));
    const res = await dispatch({ id: 2, method: 'usage.get', params: {} }, { usage } as unknown as Ctx);
    expect(res).toEqual({ id: 2, error: { code: 'internal', message: 'not logged in' } });
  });
});

describe('fleetUsage', () => {
  const rate = (pct: number) => ({ primary: { used_percent: pct, window_minutes: 300, resets_at: 1784729990 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1784729990 }, plan_type: 'plus' });
  const tokenLine = (at: string, pct: number) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 }, rate_limits: rate(pct) } }) + '\n';
  const char = (id: string, kind: AgentKind, o: { live?: boolean; transcriptPath?: string } = {}) => ({
    id, ...(o.live === false ? {} : { tmux: { windowId: '@1', paneId: '%1' } }),
    agent: { kind, sessionId: 's', status: 'idle', lastActivityAt: 0, ...(o.transcriptPath && { transcriptPath: o.transcriptPath }) },
  });
  const stateOf = (...cs: ReturnType<typeof char>[]) => () => ({ characters: Object.fromEntries(cs.map((c) => [c.id, c])) }) as unknown as FleetState;
  const claudeSnapshot: UsageSnapshot = { available: true, windows: [{ key: 'session', label: 'Session', pct: 5 }] };
  const noon = () => tokenLine('2026-06-22T12:00:00.000Z', 22);

  it('turns codex rate limits into windows named by their own length', () => {
    expect(codexWindows(rate(13))).toEqual([
      { key: 'codex:primary', label: 'Codex 5 hours', pct: 13, resetsAt: '2026-07-22T14:19:50.000Z' },
      { key: 'codex:secondary', label: 'Codex 7 days', pct: 40, resetsAt: '2026-07-22T14:19:50.000Z' },
    ]);
    expect(codexWindows({ primary: { used_percent: 1, window_minutes: 43200 }, secondary: null })).toEqual([{ key: 'codex:primary', label: 'Codex 30 days', pct: 1 }]);
  });

  it('reports no plan limits while only opencode characters run', async () => {
    const claude = vi.fn(async () => claudeSnapshot);
    expect(await fleetUsage({ state: stateOf(char('a', 'opencode')), claude })()).toEqual({ available: false, windows: [] });
    expect(claude).not.toHaveBeenCalled();
  });

  it('does not ask claude when no claude character is running', async () => {
    const claude = vi.fn(async () => claudeSnapshot);
    expect(await fleetUsage({ state: stateOf(char('a', 'claude', { live: false })), claude })()).toEqual({ available: true, idle: true, windows: [] });
    expect(claude).not.toHaveBeenCalled();
    // a codex session that has not finished a turn has reported nothing yet, which is not an idle fleet
    expect(await fleetUsage({ state: stateOf(char('b', 'codex', { transcriptPath: '/b.jsonl' })), claude, readTail: () => '' })()).toEqual({ available: true, windows: [] });
    expect(claude).not.toHaveBeenCalled();
  });

  it('shows the newest reading among the live codex characters, and none from one that is gone', async () => {
    const tails: Record<string, string> = { '/a.jsonl': tokenLine('2026-06-22T10:00:00.000Z', 11), '/b.jsonl': noon(), '/c.jsonl': tokenLine('2026-06-22T14:00:00.000Z', 33) };
    const state = stateOf(char('a', 'codex', { transcriptPath: '/a.jsonl' }), char('b', 'codex', { transcriptPath: '/b.jsonl' }), char('c', 'codex', { live: false, transcriptPath: '/c.jsonl' }));
    const usage = fleetUsage({ state, claude: async () => claudeSnapshot, readTail: (f) => tails[f] ?? '' });
    expect((await usage()).windows.map((w) => [w.key, w.pct])).toEqual([['codex:primary', 22], ['codex:secondary', 40]]);
  });

  it('shows both plans when both are running, claude first', async () => {
    const state = stateOf(char('a', 'claude'), char('b', 'codex', { transcriptPath: '/b.jsonl' }));
    expect((await fleetUsage({ state, claude: async () => claudeSnapshot, readTail: noon })()).windows.map((w) => w.key)).toEqual(['session', 'codex:primary', 'codex:secondary']);
  });

  it('keeps the codex windows when the claude read fails, and fails when there is nothing else to show', async () => {
    const broken = async (): Promise<UsageSnapshot> => { throw new Error('claude exited 1'); };
    const both = stateOf(char('a', 'claude'), char('b', 'codex', { transcriptPath: '/b.jsonl' }));
    expect((await fleetUsage({ state: both, claude: broken, readTail: noon })()).windows).toHaveLength(2);
    await expect(fleetUsage({ state: stateOf(char('a', 'claude')), claude: broken })()).rejects.toThrow('claude exited 1');
  });

  it('says plan limits do not apply only when claude is the one plan in use', async () => {
    const apiKeyLogin = async (): Promise<UsageSnapshot> => ({ available: false, windows: [] });
    expect(await fleetUsage({ state: stateOf(char('a', 'claude')), claude: apiKeyLogin })()).toEqual({ available: false, windows: [] });
    const both = stateOf(char('a', 'claude'), char('b', 'codex', { transcriptPath: '/b.jsonl' }));
    expect((await fleetUsage({ state: both, claude: apiKeyLogin, readTail: noon })()).available).toBe(true);
  });
});
