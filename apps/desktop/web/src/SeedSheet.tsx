import { useEffect, useRef, useState } from 'react';
import type { Result, SetupRow } from '@svall/protocol';
import { app, deps } from './boot.js';
import { dialogKeys, useApp } from './hooks.js';
import { keyLabel, keyMask, splitRaw } from './host.js';
import { Info } from './Info.js';
import { homeName } from './placement.js';
import { reloadResources } from './resources/load.js';
import { CloseX } from './CloseX.js';
import { Said } from './Said.js';
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
      () => { close(); app.store.getState().showToast(`Copied your agent setup to ${home}.`, 'ok'); void reloadResources(deps()); },
      fail,
    ).finally(() => setSeedCopying(false));
  };
  // a key row's box, one for each key of a server that sends several, and one for what travels whole
  const box = (r: SetupRow, id: string, fields: string[], on: boolean, field?: string) => {
    const mask = keyMask(r, field);
    return (
      <label key={id} className="move-pick">
        <input type="checkbox" data-testid={`setup-tick-${id}`} checked={on} disabled={busy} onChange={(e) => tick(r, fields, e.target.checked)} />
        <span>{keyLabel(r, field)}{mask && <span className="modal-sub mono">{mask}</span>}</span>
      </label>
    );
  };
  const keys = (r: SetupRow) => {
    const t = r.tick!;
    return !t.ticked || t.fields.length < 2 ? box(r, r.key, t.fields, t.on) : t.fields.map((f) => box(r, `${r.key}#${f}`, [f], t.ticked!.includes(f), f));
  };
  return (
    <div className="modal-back" data-testid="seed-sheet">
      <div className="modal sheet dialog" ref={panel} tabIndex={-1} role="dialog" aria-label={`Copy your agent setup to ${home}`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(shutUnlessCopying)}>
        <div className="kicker"><span data-testid="seed-title">Copy your agent setup to {home}?</span>{!busy && <CloseX ref={shut} onClose={close} testid="seed-close" />}</div>
        <div className="host-note" data-testid="seed-says">{home} has no agent setup yet. Agents there start from this Mac's, or from nothing.</div>
        <div className="rows">
          <div className="row">
            <span>copies<Info id="seed-copies">The fleet's home holds the agent setup, and every worker takes it from there, this Mac included. Files go as they are, anything written in them included.</Info></span>
            <b>CLAUDE.md, settings, skills, rules, plugins</b>
          </div>
        </div>
        {rows === undefined && !failed && <span className="move-state"><span className="move-mark"><span className="move-spin" /></span>Reading this Mac's keys…</span>}
        {!!rows?.length && (
          <>
            <div className="kicker">Keys<Info id="seed-keys">A key stays on this Mac unless you tick it.</Info></div>
            {rows.flatMap(keys)}
          </>
        )}
        {failed && <div role="alert" data-testid="seed-failed"><Said {...splitRaw(failed)} /></div>}
        <div className="acts">
          <button className="btn pri" data-testid="seed-copy" disabled={busy || rows === undefined || pending > 0} onClick={copy}>{busy ? 'Copying…' : `Copy to ${home}`}</button>
          <button className="btn" data-testid="seed-no" disabled={busy} onClick={close}>Not now</button>
        </div>
        <span className="modal-sub">Later: Settings → Agent setup.</span>
      </div>
    </div>
  );
}
