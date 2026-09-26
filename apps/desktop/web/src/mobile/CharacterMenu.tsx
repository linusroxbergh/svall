import { useState, type JSX } from 'react';
import { useApp } from '../hooks.js';
import { islandsSorted } from '../selectors.js';
import { phone } from './boot.js';
import { DocsList } from './DocsList.js';
import { Sheet } from './Sheet.js';

export function CharacterMenu({ id, onClose, onClosed }: { id: string; onClose(): void; onClosed(): void }): JSX.Element | null {
  const c = useApp((s) => s.fleet.characters[id]);
  const fleet = useApp((s) => s.fleet);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!c) return null;

  const run = async (call: () => Promise<unknown>, after: () => void = onClose) => {
    if (busy) return;
    setBusy(true);
    try { await call(); after(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const others = islandsSorted(fleet).filter((i) => i.id !== c.islandId);

  return (
    <Sheet title={c.name} onClose={onClose}>
      <div className="sheet-form">
        {others.length > 0 && (
          <div className="choices" role="group" aria-label="Move to">
            <p className="sheet-note">Move to</p>
            {others.map((i) => (
              <button key={i.id} type="button" disabled={busy} onClick={() => void run(() => phone.api().call('char.move', { id, islandId: i.id }))}>{i.name}</button>
            ))}
          </div>
        )}
        {!confirm && <button type="button" className="dan" disabled={busy} onClick={() => setConfirm(true)}>Close character</button>}
        {confirm && <button type="button" className="dan" disabled={busy} onClick={() => void run(() => phone.api().call('char.close', { id }), onClosed)}>Close {c.name} and delete its docs?</button>}
        {error && <p className="sheet-error">{error}</p>}
      </div>
      <DocsList tier="character" id={id} />
    </Sheet>
  );
}
