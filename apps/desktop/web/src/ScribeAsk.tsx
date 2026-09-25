import { useEffect, useRef } from 'react';
import { setScribe } from './actions.js';
import { deps } from './boot.js';
import { useApp } from './hooks.js';

// a new fleet's scribe stays off until the user accepts its extra agent calls
export function ScribeAsk() {
  const asking = useApp((s) => !!s.fleet.scribeAsk);
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
          name, note and links, and its island's description. Each pass is one headless call that uses the selected CLI's
          login and may incur API charges. You can change this later with the scribe switch in Settings.
        </div>
        <div className="acts">
          <button className="btn pri" data-testid="scribe-ask-on" onClick={() => answer(true)}>Turn on</button>
          <button ref={off} className="btn" data-testid="scribe-ask-off" onClick={() => answer(false)}>Keep off</button>
        </div>
      </div>
    </div>
  );
}
