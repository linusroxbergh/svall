import { useEffect, useRef } from 'react';
import { deleteIsland } from './actions.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';

// an island's docs go with it, so its delete asks once more; a reflex Enter keeps it
export function ConfirmDeleteIsland() {
  const id = useApp((s) => s.deletingIsland);
  const name = useApp((s) => (s.deletingIsland ? s.fleet.islands[s.deletingIsland]?.name : undefined));
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (id) keep.current?.focus(); }, [id]);

  if (!id) return null;
  const cancel = () => app.store.getState().setDeletingIsland(undefined);
  const confirm = () => { cancel(); deleteIsland(deps(), id); };

  return (
    <div className="modal-back" data-testid="confirm-delete-island" onPointerDown={cancel}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the dialog; Enter presses the focused button
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        }}>
        <div className="kicker">Delete island</div>
        <div className="modal-name">{name}</div>
        <div className="modal-note">Its docs go with it.</div>
        <div className="acts">
          {/* the board's Delete island can stand under this one, so the second click of a double click must not answer it */}
          <button className="btn dan" data-testid="confirm-delete-island-delete" onClick={(e) => { if (e.detail < 2) confirm(); }}>Delete</button>
          <button ref={keep} className="btn" data-testid="confirm-delete-island-cancel" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
