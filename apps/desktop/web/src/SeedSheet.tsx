import { useEffect, useState } from 'react';
import type { Result, SetupRow } from '@svall/protocol';
import { SetupTicks } from './AgentSetup.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { homeName } from './placement.js';
import { reloadResources } from './resources/load.js';
import { CloseX } from './CloseX.js';

const asked = (home: string): string => `svall.seedAsked@${home}`;
const answered = (home: string): boolean => {
  try { return localStorage.getItem(asked(home)) !== null; } catch { return false; }
};
const answer = (home: string): void => {
  try { localStorage.setItem(asked(home), '1'); } catch { /* it asks once more */ }
};

/** A window that reaches a far home with no agent setup yet, on a Mac that holds one: this Mac's goes there first, with what each key asks, or not at all. */
export function SeedSheet() {
  const follows = useApp((s) => !!s.via?.online && !!s.home?.master);
  const open = useApp((s) => s.seedAsk === true);
  const home = useApp((s) => (s.via ? homeName(s.fleet, s.via) : ''));
  const me = useApp((s) => s.via?.machine);
  const fleetHome = useApp((s) => s.shell?.home);
  const [rows, setRows] = useState<SetupRow[]>();
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const show = (r: Result<'home.setup'>) => { setRows(r.rows); setFailed(undefined); };
  const fail = (e: Error) => setFailed(e.message);
  useEffect(() => {
    if (!follows || !fleetHome || answered(fleetHome)) return;
    let left = false;
    const here = app.api().local ?? app.api();
    void Promise.all([here.call('machines.holdsSetup', {}), app.api().call('machines.holdsSetup', {})]).then(([mine, there]) => {
      if (left || !mine.holds || there.holds) return;
      app.store.getState().setSeedAsk(true);
      here.call('home.setup', {}).then(show, fail);
    }, () => {});
    return () => { left = true; };
  }, [follows, fleetHome]);
  if (!open) return null;
  const close = () => {
    if (fleetHome) answer(fleetHome);
    app.store.getState().setSeedAsk(false);
  };
  const tick = (r: SetupRow, fields: string[], on: boolean) => {
    setPending((n) => n + 1);
    (app.api().local ?? app.api()).call('home.setupConsent', { item: r.tick!.item, fields, on }).then(show, fail).finally(() => setPending((n) => n - 1));
  };
  const copy = () => {
    setBusy(true);
    setFailed(undefined);
    app.api().call('machines.copySetupFrom', { machine: me!, seed: true }).then(
      () => { close(); void reloadResources(deps()); },
      fail,
    ).finally(() => setBusy(false));
  };
  return (
    <div className="modal-back" data-testid="seed-sheet">
      <div className="modal dialog" role="dialog" aria-label={`Copy your agent setup to ${home}`} onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker"><span data-testid="seed-title">{home} has no agent setup yet</span><CloseX onClose={close} testid="seed-close" /></div>
        <div className="desc" data-testid="seed-says">
          Your agent setup lives on the fleet's home, and every worker takes it from there, this Mac included. Copy this Mac's to {home} first, or start {home} from nothing. Keys in config files stay on this Mac unless you tick them.
        </div>
        {!!rows?.length && <SetupTicks rows={rows} tick={tick} />}
        {failed && <div className="desc" role="alert" data-testid="seed-failed" data-error>{failed}</div>}
        <div className="opens">
          <button className="btn pri sm" data-testid="seed-copy" disabled={busy || rows === undefined || pending > 0} onClick={copy}>{busy ? 'Copying…' : `Copy to ${home}`}</button>
          <button className="btn sm" data-testid="seed-no" disabled={busy} data-tip="Settings → Agent setup copies it whenever you want" onClick={close}>Not now</button>
        </div>
      </div>
    </div>
  );
}
