import type { FleetState, UsageSnapshot, UsageWindow } from '@svall/protocol';
import { lastTokenCount, type RawRateLimits, type RawRateWindow } from '../agent/codex-transcript.js';
import { readTail as readFileTail } from '../agent/transcript.js';
import { spawnClaude } from '../claude.js';

export type FetchUsage = () => Promise<UsageSnapshot>;

const TIMEOUT_MS = 20_000;
const REQUEST_ID = 'u1';

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null;
type RawLimits = {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  model_scoped?: { display_name?: string; utilization?: number | null; resets_at?: string | null }[];
};
type RawUsage = { subscription_type?: string | null; rate_limits_available?: boolean; rate_limits?: RawLimits | null };

const windowOf = (key: string, label: string, w: RawWindow): UsageWindow[] =>
  w && typeof w.utilization === 'number' ? [{ key, label, pct: w.utilization, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }] : [];

// the server names the model buckets, so a renamed or a second one carries its own label through;
// its index joins the key, which two buckets may otherwise share
function toSnapshot(raw: RawUsage): UsageSnapshot {
  const limits = raw.rate_limits;
  if (raw.rate_limits_available !== true || !limits) return { available: false, windows: [] };
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  return {
    available: true,
    windows: [
      ...windowOf('session', 'Session', limits.five_hour ?? null),
      ...windowOf('week', 'Week', limits.seven_day ?? null),
      ...scoped.flatMap((m, i) => (m.display_name ? windowOf(`model:${i}:${m.display_name}`, m.display_name, m) : [])),
    ],
  };
}

// a headless Claude that runs no model turn: one control request over stdin answers with the plan's
// rate-limit windows and costs nothing. skip_behaviors keeps it off a scan of every transcript
// touched in the last seven days
export function usageFetcher(o: { cwd: string; envFile: string; timeoutMs?: number }): FetchUsage {
  return () => new Promise((resolve, reject) => {
    const proc = spawnClaude({
      args: ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      cwd: o.cwd,
      envFile: o.envFile,
    });

    const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`claude usage read timed out after ${timeoutMs}ms`))), timeoutMs);

    let err = '', buf = '';
    // claude is resolved from PATH and its output shape is not ours, so a reply that reads
    // nothing like one answers the caller rather than throwing past the promise
    proc.stdout.setEncoding('utf8').on('data', (d: string) => {
      try {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: { type?: string; response?: { subtype?: string; request_id?: string; error?: unknown; response?: RawUsage } } | null;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg?.type !== 'control_response' || msg.response?.request_id !== REQUEST_ID) continue;
          const r = msg.response;
          if (r.subtype !== 'success' || !r.response) {
            finish(() => reject(new Error(`claude usage read failed: ${String(r.error ?? r.subtype).slice(0, 300)}`)));
            return;
          }
          const snapshot = toSnapshot(r.response);
          finish(() => resolve(snapshot));
          return;
        }
      } catch (e) {
        finish(() => reject(new Error(`claude usage reply could not be read: ${(e as Error).message.slice(0, 300)}`)));
      }
    });
    proc.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    proc.on('error', (e) => finish(() => reject(e)));
    // the answer arrives long before the child would exit on its own, so reaching here means it never came
    proc.on('close', (code) => finish(() => reject(new Error(`claude exited ${code}: ${(err || buf).trim().slice(0, 300)}`))));

    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify({
      type: 'control_request', request_id: REQUEST_ID,
      request: { subtype: 'get_usage', skip_behaviors: true },
    }) + '\n');
  });
}

// the panel asks on every open, so a snapshot is held briefly and callers arriving together share one read
export function cachedUsage(fetch: FetchUsage, ttlMs: number, now: () => number = Date.now): FetchUsage {
  let held: { at: number; snapshot: UsageSnapshot } | undefined;
  let pending: Promise<UsageSnapshot> | undefined;
  return () => {
    // a clock stepped backwards by sleep or NTP would otherwise hold the snapshot until wall time caught up
    const age = held ? now() - held.at : Infinity;
    if (held && age >= 0 && age < ttlMs) return Promise.resolve(held.snapshot);
    if (pending) return pending;
    const at = now();
    pending = fetch()
      .then((snapshot) => { held = { at, snapshot }; return snapshot; })
      .finally(() => { pending = undefined; });
    return pending;
  };
}

// codex names a window by its length alone, and the length differs by plan
const windowLabel = (minutes: number | undefined): string => {
  if (!minutes) return 'Codex';
  if (minutes % 1440 === 0) return `Codex ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `Codex ${minutes / 60} hours`;
  return `Codex ${minutes} minutes`;
};

const codexWindow = (key: string, w: RawRateWindow | undefined): UsageWindow[] =>
  w && typeof w.used_percent === 'number'
    ? [{ key: `codex:${key}`, label: windowLabel(w.window_minutes), pct: w.used_percent, ...(w.resets_at ? { resetsAt: new Date(w.resets_at * 1000).toISOString() } : {}) }]
    : [];

export const codexWindows = (limits: RawRateLimits): UsageWindow[] =>
  [...codexWindow('primary', limits.primary), ...codexWindow('secondary', limits.secondary)];

const CODEX_TAIL = 64 * 1024;

// a plan shows only while a character runs on it. Codex answers no usage question out of band and
// reports its limits on every turn instead, so they are read off the live sessions' rollouts when the
// panel asks: nothing is remembered, and a reading is no older than the last turn of an open session
export function fleetUsage(o: { state: () => FleetState; claude: FetchUsage; readTail?: (file: string) => string }): FetchUsage {
  const tail = o.readTail ?? ((file: string) => readFileTail(file, CODEX_TAIL));
  return async () => {
    const agents = Object.values(o.state().characters).flatMap((c) => (c.tmux && c.agent ? [c.agent] : []));
    const newest = agents
      .flatMap((a) => (a.kind === 'codex' && a.transcriptPath ? [lastTokenCount(tail(a.transcriptPath))] : []))
      .flatMap((t) => (t?.limits ? [{ at: t.at, limits: t.limits }] : []))
      .sort((a, b) => b.at - a.at)[0];
    const codex = newest ? codexWindows(newest.limits) : [];
    if (!agents.length) return { available: true, idle: true, windows: [] };
    // OpenCode runs on any provider and reports no plan's limits
    if (agents.every((a) => a.kind === 'opencode')) return { available: false, windows: [] };
    if (!agents.some((a) => a.kind === 'claude')) return { available: true, windows: codex };
    // a claude that is logged out or slow must not take the codex windows down with it
    const claude = await o.claude().catch((e: unknown): UsageSnapshot => { if (!codex.length) throw e; return { available: false, windows: [] }; });
    return { available: claude.available || codex.length > 0, windows: [...claude.windows, ...codex] };
  };
}
