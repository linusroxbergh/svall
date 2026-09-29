import { useEffect, useRef, useState } from 'react';
import { fleetNameProblem, type FleetEntry } from '@svall/protocol';
import { app } from './boot.js';
import { shim } from './bridge.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { directoryName } from './selectors.js';

// the fleets on this Mac: one opens beside this window, or on a bare launch in its place
export function FleetPicker() {
  const mode = useApp((s) => s.fleetPicker);
  // each opening starts fresh
  return mode ? <Picker key={mode} mode={mode} /> : null;
}

const listFleets = (): Promise<FleetEntry[]> => app.api().call('fleets.list', {}).then((r) => r.fleets);

function Picker({ mode }: { mode: 'bare' | 'menu' }) {
  const online = useApp((s) => s.status === 'online');
  // a fleet on another machine talks to that machine's daemon, which knows nothing of this Mac's fleets
  const away = useApp((s) => (s.connection && s.connection.owner !== 'local' ? s.connection.owner : undefined));
  // a pick still running when the picker closes opens nothing
  const shown = useRef(true);
  const [fleets, setFleets] = useState<FleetEntry[]>();
  const [listError, setListError] = useState<string>();
  // the home being started, or new for the fleet being made
  const [busy, setBusy] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState('');

  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);
  const load = () => { listFleets().then((f) => { setFleets(f); setListError(undefined); }, (e: Error) => setListError(e.message)); };
  useEffect(() => { if (online && !away) load(); }, [online, away]);

  const close = () => app.store.getState().setFleetPicker(undefined);
  const problem = name ? fleetNameProblem(name, (fleets ?? []).flatMap((f) => [f.name, directoryName(f.home)])) : undefined;

  // the page asks for the window; on a bare launch this instance then leaves it to that one
  const run = async (key: string, home: () => Promise<string>) => {
    setBusy(key);
    setErrors((x) => ({ ...x, [key]: '' }));
    try {
      const target = await home();
      if (!shown.current) return;
      app.bridge.send({ type: 'openFleet', home: target, quit: mode === 'bare' });
      if (mode === 'menu') close();
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: (e as Error).message }));
      // a fleet made but slow to answer is a row to start from, not a name to make again
      load();
    } finally {
      setBusy(undefined);
    }
  };
  const open = (f: FleetEntry) => {
    if (f.current) return close();
    void run(f.home, () => app.api().call('fleets.start', { home: f.home }).then((r) => r.home));
  };
  const create = () => {
    if (!name || problem || busy) return;
    void run('new', () => app.api().call('fleets.create', { name }).then((r) => r.home));
  };

  return (
    <div className="modal-back" data-testid="fleet-picker" onPointerDown={close}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the dialog; Enter presses the focused row
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
        }}>
        <div className="kicker">Fleets</div>
        {!online && <div className="modal-note" data-testid="fleet-picker-offline">svalld is not connected, so fleets can't be listed or made.</div>}
        {away && <div className="modal-note" data-testid="fleet-picker-away">This fleet runs on {away}; open other fleets from a window of a fleet on this Mac.</div>}
        {listError && <div className="fleet-error">{listError}</div>}
        <div className="fleet-rows">
          {!away && fleets?.map((f) => (
            <div key={f.home}>
              {/* a reflex Enter keeps this window's fleet */}
              <button className="fleet-row" data-testid={`fleet-row-${f.name}`} autoFocus={f.current} disabled={!online || busy !== undefined} onClick={() => open(f)}>
                <span className="fleet-name">{f.name}</span>
                {f.current && <span className="fleet-tag">this window</span>}
                {!f.current && busy === f.home && <span className="fleet-tag">starting…</span>}
                {!f.current && busy !== f.home && f.windowOpen && <span className="fleet-tag">open</span>}
              </button>
              {errors[f.home] && <div className="fleet-error" data-testid={`fleet-error-${f.name}`}>{errors[f.home]}</div>}
            </div>
          ))}
        </div>
        {!away && <div className="fleet-new">
          <input className="fld" placeholder="New fleet" aria-label="New fleet name" value={name} disabled={!online} data-testid="fleet-new-name" {...AS_TYPED}
            onChange={(e) => setName(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <button className="btn" data-testid="fleet-new-create" disabled={!online || !name || !!problem || busy !== undefined} onClick={create}>
            {busy === 'new' ? 'Creating…' : 'Create'}
          </button>
        </div>}
        {problem && <div className="fleet-error" data-testid="fleet-new-problem">{problem}</div>}
        {errors.new && <div className="fleet-error">{errors.new}</div>}
        <div className="modal-note">From a terminal: <code>{shim()} &lt;name&gt;</code></div>
      </div>
    </div>
  );
}
