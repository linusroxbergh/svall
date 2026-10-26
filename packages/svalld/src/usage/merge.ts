import type { UsageSnapshot } from '@svall/protocol';

/** The home's reading with each window only a worker reports after its own; plan limits apply when a running
 *  machine's do, as an idle one asks no plan. */
export function mergeUsage(home: UsageSnapshot, workers: UsageSnapshot[]): UsageSnapshot {
  const windows = [...home.windows];
  for (const w of workers.flatMap((s) => s.windows)) if (!windows.some((h) => h.key === w.key)) windows.push(w);
  const running = [home, ...workers].filter((s) => !s.idle);
  return {
    available: !running.length || running.some((s) => s.available),
    ...(!running.length && { idle: true }),
    ...(home.account && { account: home.account }),
    windows,
  };
}
