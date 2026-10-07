import { useEffect, useRef, useState } from 'react';
import { startHomeCharacter } from './actions.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { covered } from './keyboard.js';

// one prompt is the whole form: Enter sends it to a fresh mission control agent, Shift+Enter breaks the line
export function MissionPrompt() {
  const open = useApp((s) => s.missionPrompt);
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (open) field.current?.focus(); }, [open]);

  if (!open) return null;
  // a prompt sent or given up leaves the field empty; one the other dialog's key closed waits for the next open
  const close = () => { setText(''); app.store.getState().setMissionPrompt(false); };

  // the fleet takes as long as the agent takes to boot, so the dialog is done the moment the prompt is in;
  // a refusal brings it back with what was typed, the reason already on a toast. by then the user may have
  // typed a new prompt or opened the other dialog, so the text only fills an empty field and the layer is cleared
  const send = () => {
    const prompt = text.trim();
    if (!prompt) return;
    close();
    void startHomeCharacter(deps(), { prompt }).then((ok) => {
      if (ok) return;
      setText((t) => t || prompt);
      if (covered(app.store.getState())) return;
      app.store.getState().setNamingCharacter(false);
      app.store.getState().setClosingCharacter(undefined);
      app.store.getState().toggleKeys(false);
      app.store.getState().setMissionPrompt(true);
    });
  };

  return (
    <div className="modal-back" data-testid="mission-prompt" onPointerDown={close}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="kicker">Mission control</div>
        <textarea ref={field} className="fld mission" placeholder="what should the fleet do?" aria-label="Prompt"
          value={text} data-testid="mission-prompt-text" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="acts">
          <button className="btn pri" data-testid="mission-prompt-send" disabled={!text.trim()} onClick={send}>Send</button>
          <button className="btn" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
