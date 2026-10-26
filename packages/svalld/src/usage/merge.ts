import type { UsageSnapshot } from '@svall/protocol';

/** The home's reading with each window only a worker reports after its own, and the newest of a window more than one
 *  machine read off a transcript; plan limits apply when a running machine's do, as an idle one asks no plan. */
export function mergeUsage(home: UsageSnapshot, workers: UsageSnapshot[]): UsageSnapshot {
  const windows = [...home.windows];
  for (const w of workers.flatMap((s) => s.windows)) {
    const at = windows.findIndex((h) => h.key === w.key);
    if (at === -1) windows.push(w);
    // a window read live was read as the panel asked
    else if ((w.at ?? Infinity) > (windows[at].at ?? Infinity)) windows[at] = w;
  }
  const running = [home, ...workers].filter((s) => !s.idle);
  return {
    available: !running.length || running.some((s) => s.available),
    ...(!running.length && { idle: true }),
    ...(home.account && { account: home.account }),
    windows,
  };
}
