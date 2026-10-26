import type { UsageSnapshot } from '@svall/protocol';

/** The home's reading with each window only a worker reports after its own; plan limits apply when any machine's do. */
export function mergeUsage(home: UsageSnapshot, workers: UsageSnapshot[]): UsageSnapshot {
  const windows = [...home.windows];
  for (const w of workers.flatMap((s) => s.windows)) if (!windows.some((h) => h.key === w.key)) windows.push(w);
  const all = [home, ...workers];
  return {
    available: all.some((s) => s.available),
    ...(all.every((s) => s.idle) && { idle: true }),
    ...(home.account && { account: home.account }),
    windows,
  };
}
