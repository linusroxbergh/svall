import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_LABEL, fleetNameProblem, type AgentKind } from '@svall/protocol';
import { renameFleet, setMainAgent, setPlacing, setScribe } from './actions.js';
import { deps } from './boot.js';
import { shim } from './bridge.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import { dialogKeys, useApp } from './hooks.js';
import { directoryName, NO_AGENTS, placingAsking } from './selectors.js';

// the private fleet lives in ~/.svall
const isPrivateHome = (): boolean => window.__svallHome !== undefined && directoryName(window.__svallHome) === 'private';

// a fresh private fleet is named before anything else, and Skip leaves it private
function NameAsk({ skip }: { skip(): void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const problem = name ? fleetNameProblem(name, []) : undefined;
  const save = () => {
    if (!name || problem) return;
    renameFleet(deps(), name).catch((e: Error) => setError(e.message));
  };
  return (
    <div className="modal-back" data-testid="fleet-name-ask">
      <div className="modal panel" onKeyDown={dialogKeys(skip)}>
        <div className="kicker">Your fleet<CloseX onClose={skip} testid="fleet-name-close" /></div>
        <div className="modal-name">Name this fleet</div>
        <input className="fld" autoFocus placeholder="private" aria-label="Fleet name" value={name} data-testid="fleet-name-input" {...AS_TYPED}
          onChange={(e) => { setName(e.target.value.trim()); setError(undefined); }} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        {problem || error
          ? <div className="fleet-error">{problem ?? error}</div>
          : <div className="modal-note">Open it from a terminal with <code>{shim()} {name || '<name>'}</code></div>}
        <div className="acts">
          <button className="btn pri" data-testid="fleet-name-save" disabled={!name || !!problem} onClick={save}>Name it</button>
          <button className="btn" data-testid="fleet-name-skip" onClick={skip}>Skip</button>
        </div>
      </div>
    </div>
  );
}

// an opt-in's one question: Escape, the × and a reflex Enter on the focused Keep off all keep it off
function Ask({ id, title, answer, children }: { id: string; title: string; answer(on: boolean): void; children: ReactNode }) {
  const off = useRef<HTMLButtonElement>(null);
  useEffect(() => { off.current?.focus(); }, []);
  return (
    <div className="modal-back" data-testid={id}>
      <div className="modal panel" onKeyDown={dialogKeys(() => answer(false))}>
        <div className="kicker">Scribe<CloseX onClose={() => answer(false)} testid={`${id}-close`} /></div>
        <div className="modal-name">{title}</div>
        {children}
        <div className="acts">
          <button className="btn pri" data-testid={`${id}-on`} onClick={() => answer(true)}>Turn on</button>
          <button ref={off} className="btn" data-testid={`${id}-off`} onClick={() => answer(false)}>Keep off</button>
        </div>
      </div>
    </div>
  );
}

// a new fleet's scribe stays off until the user accepts its extra agent calls
export function ScribeAsk() {
  const asking = useApp((s) => !!s.fleet.scribeAsk && !s.fleetPicker);
  const named = useApp((s) => !!s.fleet.name);
  const [skipped, setSkipped] = useState(false);
  const naming = asking && !named && !skipped && isPrivateHome();
  const scribeAgent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const found = useApp((s) => s.fleet.agentsFound ?? NO_AGENTS);

  if (!asking) return null;
  if (naming) return <NameAsk skip={() => setSkipped(true)} />;
  return (
    <Ask id="scribe-ask" title="Keep names and notes up to date?" answer={(on) => setScribe(deps(), on)}>
      <div className="modal-note">Runs a headless {AGENT_LABEL[scribeAgent]} call after an agent stops, which may cost API credits.</div>
      {found.length > 1 && (
        <>
          <div className="modal-note">{[found.slice(0, -1).map((k) => AGENT_LABEL[k]).join(', '), AGENT_LABEL[found.at(-1)!]].join(' and ')} are installed. Mission control and the scribe run:</div>
          <select className="fld" aria-label="Main agent" data-testid="scribe-ask-agent" value={main}
            onChange={(e) => setMainAgent(deps(), e.target.value as AgentKind)}>
            {found.map((k) => <option key={k} value={k}>{AGENT_LABEL[k]}</option>)}
          </select>
        </>
      )}
    </Ask>
  );
}

// the board's placing waits on its own ask; Turn on also turns on a scribe that is off
export function PlacingAsk() {
  const asking = useApp(placingAsking);
  const scribeOff = useApp((s) => !!s.fleet.scribeOff);
  if (!asking) return null;
  return (
    <Ask id="placing-ask" title="Let the scribe place robots on the board?" answer={(on) => setPlacing(deps(), on)}>
      <div className="modal-note">
        After each pass it also picks the column that fits the robot's work, by your column names. A robot you move by hand stays where you put it.
        {scribeOff && ' Turning this on turns the scribe on too.'}
      </div>
      <div className="modal-note modal-quiet">Rides the pass the scribe already makes; no extra calls.</div>
    </Ask>
  );
}
