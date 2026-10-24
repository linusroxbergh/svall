import { useEffect, useRef } from 'react';
import { sleepRobot } from './actions.js';
import { app, deps } from './boot.js';
import { CloseX } from './CloseX.js';
import { useApp } from './hooks.js';

// a working robot loses the turn it is on, so its sleep asks once more; a reflex Enter keeps it
export function ConfirmSleep() {
  const id = useApp((s) => s.sleepingRobot);
  const name = useApp((s) => (s.sleepingRobot ? s.fleet.robots[s.sleepingRobot]?.name : undefined));
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (id) keep.current?.focus(); }, [id]);

  if (!id) return null;
  const cancel = () => app.store.getState().setSleepingRobot(undefined);
  const confirm = () => { cancel(); void sleepRobot(deps(), id); };

  return (
    <div className="modal-back" data-testid="confirm-sleep-dialog" onPointerDown={cancel}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the dialog; Enter presses the focused button
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        }}>
        <div className="kicker">Sleep<CloseX onClose={cancel} testid="confirm-sleep-close" /></div>
        <div className="modal-name">{name}</div>
        <div className="modal-note">{name} is working. Sleep anyway?</div>
        <div className="acts">
          {/* a double click's second press must not answer the dialog its first opened */}
          <button className="btn dan" data-testid="confirm-sleep" onClick={(e) => { if (e.detail < 2) confirm(); }}>Sleep</button>
          <button ref={keep} className="btn" data-testid="confirm-sleep-cancel" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
