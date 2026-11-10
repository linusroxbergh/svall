import { useEffect, useRef, useState } from 'react';
import type { Result, SetupRow } from '@svall/protocol';
import { SetupTicks } from './AgentSetup.js';
import { app, deps } from './boot.js';
import { dialogKeys, useApp } from './hooks.js';
import { homeName } from './placement.js';
import { reloadResources } from './resources/load.js';
import { CloseX } from './CloseX.js';
import { seedAnswered } from './store/host.js';

/** A window that reaches a far home with no agent setup yet, on a Mac that holds one: this Mac's goes there first, with what each key asks, or not at all. */
export function SeedSheet() {
  const follows = useApp((s) => !!s.via?.online && !!s.home?.master);
  const open = useApp((s) => s.seedAsk === true);
  const home = useApp((s) => (s.via ? homeName(s.fleet, s.via) : ''));
  const me = useApp((s) => s.via?.machine);
  const fleetHome = useApp((s) => s.shell?.home);
  const [rows, setRows] = useState<SetupRow[]>();
  const [pending, setPending] = useState(0);
  const busy = useApp((s) => s.seedCopying === true);
  const [failed, setFailed] = useState<string>();
  const shut = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const show = (r: Result<'home.setup'>) => { setRows(r.rows); setFailed(undefined); };
  const fail = (e: Error) => setFailed(e.message);
  useEffect(() => {
    if (!follows || !fleetHome || seedAnswered(fleetHome)) return;
    let left = false;
    const here = app.api().local ?? app.api();
    void Promise.all([here.call('machines.holdsSetup', {}), app.api().call('machines.holdsSetup', {})]).then(([mine, there]) => {
      if (left || !mine.holds || there.holds) return;
      app.store.getState().setSeedAsk(true);
      here.call('home.setup', {}).then(show, fail);
    }, () => {});
    return () => { left = true; };
  }, [follows, fleetHome]);
  // the focus stays in the sheet, whose Esc answers as Not now
  useEffect(() => { if (open && !panel.current?.contains(document.activeElement)) (shut.current ?? panel.current)?.focus(); });
  if (!open) return null;
  const close = () => { app.store.getState().answerSeed(); };
  const shutUnlessCopying = () => { if (!busy) close(); };
  const tick = (r: SetupRow, fields: string[], on: boolean) => {
    setPending((n) => n + 1);
    (app.api().local ?? app.api()).call('home.setupConsent', { item: r.tick!.item, fields, on }).then(show, fail).finally(() => setPending((n) => n - 1));
  };
  const copy = () => {
    const { setSeedCopying } = app.store.getState();
    setSeedCopying(true);
    setFailed(undefined);
    app.api().call('machines.copySetupFrom', { machine: me!, seed: true }).then(
      () => { close(); void reloadResources(deps()); },
      fail,
    ).finally(() => setSeedCopying(false));
  };
  return (
    <div className="modal-back" data-testid="seed-sheet">
      <div className="modal dialog" ref={panel} tabIndex={-1} role="dialog" aria-label={`Copy your agent setup to ${home}`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(shutUnlessCopying)}>
        <div className="kicker"><span data-testid="seed-title">{home} has no agent setup yet</span>{!busy && <CloseX ref={shut} onClose={close} testid="seed-close" />}</div>
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
