import { useEffect, useRef } from 'react';
import { AGENT_LABEL, type AgentKind } from '@archipelago/protocol';
import { setMainAgent, setScribe } from './actions.js';
import { deps } from './boot.js';
import { useApp } from './hooks.js';

// a stable identity, so a selector defaulting to "no CLIs found" does not retrigger on every render
const NO_AGENTS: AgentKind[] = [];

// a new fleet's scribe stays off until the user accepts its extra agent calls
export function ScribeAsk() {
  const asking = useApp((s) => !!s.fleet.scribeAsk);
  const scribeAgent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const found = useApp((s) => s.fleet.agentsFound ?? NO_AGENTS);
  // a reflex Enter keeps it off
  const off = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (asking) off.current?.focus(); }, [asking]);

  if (!asking) return null;
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
        <div className="modal-note">
          About a minute after an agent stops, the scribe reads the end of its transcript and updates the character's
          name, note and links, and its island's description. Each pass is one headless call to {AGENT_LABEL[scribeAgent]} on
          its login, and may incur API charges. You can change this later with the scribe switch in Settings.
        </div>
        {found.length > 1 && (
          <>
            <div className="modal-note">Claude Code and Codex are both installed. Mission control and the scribe run:</div>
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
