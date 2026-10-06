import { useEffect, useRef, useState } from 'react';
import { AGENT_LABEL, fleetNameProblem, type AgentKind } from '@svall/protocol';
import { renameFleet, setMainAgent, setScribe } from './actions.js';
import { deps } from './boot.js';
import { shim } from './bridge.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { directoryName } from './selectors.js';

// a stable identity, so a selector defaulting to "no CLIs found" does not retrigger on every render
const NO_AGENTS: AgentKind[] = [];

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
      <div className="modal panel"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); skip(); }
        }}>
        <div className="kicker">Your fleet</div>
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

// a new fleet's scribe stays off until the user accepts its extra agent calls
export function ScribeAsk() {
  const asking = useApp((s) => !!s.fleet.scribeAsk && !s.fleetPicker);
  const named = useApp((s) => !!s.fleet.name);
  const [skipped, setSkipped] = useState(false);
  const naming = asking && !named && !skipped && isPrivateHome();
  const scribeAgent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const found = useApp((s) => s.fleet.agentsFound ?? NO_AGENTS);
  // a reflex Enter keeps it off
  const off = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (asking && !naming) off.current?.focus(); }, [asking, naming]);

  if (!asking) return null;
  if (naming) return <NameAsk skip={() => setSkipped(true)} />;
  const answer = (enabled: boolean) => setScribe(deps(), enabled);

  return (
    <div className="modal-back" data-testid="scribe-ask">
      <div className="modal panel"
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the dialog; Enter presses the focused button
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); void answer(false); }
        }}>
        <div className="kicker">Scribe</div>
        <div className="modal-name">Keep names and notes up to date?</div>
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
        <div className="acts">
          <button className="btn pri" data-testid="scribe-ask-on" onClick={() => answer(true)}>Turn on</button>
          <button ref={off} className="btn" data-testid="scribe-ask-off" onClick={() => answer(false)}>Keep off</button>
        </div>
      </div>
    </div>
  );
}
