import { useEffect, useRef } from 'react';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { closeCharacter } from './keyboard.js';

// Cmd+W asks before a character goes: Enter or a second Cmd+W deletes it, Esc keeps it
export function ConfirmClose() {
  const id = useApp((s) => s.closingCharacter);
  const name = useApp((s) => (s.closingCharacter ? s.fleet.characters[s.closingCharacter]?.name : undefined));
  const unsaved = useApp((s) => (s.closingCharacter ? s.ide[s.closingCharacter]?.dirty.length ?? 0 : 0));
  const del = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (id) del.current?.focus(); }, [id]);

  if (!id) return null;
  const cancel = () => app.store.getState().setClosingCharacter(undefined);
  const confirm = () => {
    cancel();
    closeCharacter(deps(), id)
      .catch((e: Error) => app.store.getState().showToast(e.message));
  };

  return (
    <div className="modal-back" data-testid="confirm-close" onPointerDown={cancel}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would open or deselect the character behind the dialog
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirm(); }
          if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        }}>
        <div className="kicker">Delete character</div>
        <div className="modal-name">{name}</div>
        <div className="modal-note" data-testid="confirm-close-note">
          Closing kills its terminal and deletes its docs.{unsaved > 0 && ` ${unsaved} unsaved ${unsaved === 1 ? 'file goes' : 'files go'} with it.`}
        </div>
        <div className="acts">
          <button ref={del} className="btn dan" data-testid="confirm-close-delete" onClick={confirm}>Delete</button>
          <button className="btn" data-testid="confirm-close-cancel" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
