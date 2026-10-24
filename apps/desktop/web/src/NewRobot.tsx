import { useEffect, useRef, useState } from 'react';
import { newNamedRobot, showCreated } from './actions.js';
import { app, deps } from './boot.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';

// name is enough: Enter creates. A note and links are there when the name alone is not.
export function NewRobot() {
  const open = useApp((s) => s.namingRobot);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [links, setLinks] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setName(''); setNote(''); setLinks(''); setMore(false); setBusy(false); return; }
    field.current?.focus();
  }, [open]);

  if (!open) return null;
  const close = () => app.store.getState().setNamingRobot(false);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    const d = deps();
    const refs = links.split('\n').map((u) => u.trim()).filter(Boolean);
    try {
      const id = await newNamedRobot(d, { name: name.trim(), note: note.trim(), refs });
      close();
      showCreated(d, id);
    } catch (e) {
      d.store.getState().showToast((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" data-testid="new-robot" onPointerDown={close}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="kicker">New robot<CloseX onClose={close} testid="new-robot-close" /></div>
        <input ref={field} className="h2" placeholder="name" aria-label="Name" value={name} data-testid="new-robot-name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
        {!more && (
          <button className="btn ghost" data-testid="new-robot-more" onClick={() => setMore(true)}>Add a note and links</button>
        )}
        {more && (
          <>
            <textarea className="fld desc" placeholder="note" value={note} data-testid="new-robot-note"
              onChange={(e) => setNote(e.target.value)} />
            <textarea className="fld" placeholder="links or paths, one per line" value={links} data-testid="new-robot-links" {...AS_TYPED}
              onChange={(e) => setLinks(e.target.value)} />
          </>
        )}
        <div className="acts">
          <button className="btn pri" data-testid="new-robot-create" disabled={busy} onClick={() => void create()}>Create</button>
          <button className="btn" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
