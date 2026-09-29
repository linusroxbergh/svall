import { useEffect, useState } from 'react';
import type { UsageSnapshot } from '@svall/protocol';
import { app } from './boot.js';
import { resetAt, untilReset } from './usageText.js';

// how often an open panel re-reads the clock, so a countdown left in sight keeps up with it
const TICK_MS = 30_000;

function Limit({ label, pct, resetsAt, now }: { label: string; pct: number; resetsAt?: string; now: number }) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div className="use-win">
      <div className="use-head">
        <span className="use-label">{label}</span>
        <b className="tnum">{Math.round(width)}%</b>
      </div>
      <span className="meter"><span><i style={{ width: `${width}%`, background: width >= 90 ? 'var(--blocked)' : 'var(--sand)' }} /></span></span>
      {resetsAt && <div className="use-reset">resets {resetAt(resetsAt)} · in {untilReset(resetsAt, now)}</div>}
    </div>
  );
}

export function UsagePanel() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    app.api().call('usage.get', {})
      .then((s) => { if (live) setSnapshot(s); })
      .catch((e: Error) => { if (live) setError(e.message); });
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => { live = false; clearInterval(tick); };
  }, []);

  if (error) return <div className="use-note" data-testid="usage-error">{error}</div>;
  if (!snapshot) return <div className="use-note" data-testid="usage-loading">Reading your limits…</div>;
  if (!snapshot.available) return <div className="use-note" data-testid="usage-none">Plan limits don't apply to this login.</div>;
  // a plan shows only while an agent runs on it, and codex reports its limits with its first turn
  if (snapshot.idle) return <div className="use-note" data-testid="usage-idle">No agent is running.</div>;
  if (!snapshot.windows.length) return <div className="use-note" data-testid="usage-waiting">No plan limits reported yet.</div>;
  return (
    <div className="use-wins" data-testid="usage-windows">
      {snapshot.windows.map((w) => <Limit key={w.key} label={w.label} pct={w.pct} resetsAt={w.resetsAt} now={now} />)}
    </div>
  );
}
