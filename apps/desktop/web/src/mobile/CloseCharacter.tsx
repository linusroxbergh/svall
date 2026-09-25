import { useState, type JSX } from 'react';
import { useApp } from '../hooks.js';
import { phone } from './boot.js';
import { Sheet } from './Sheet.js';

export function CloseCharacter({ id, onClose }: { id: string; onClose(): void }): JSX.Element | null {
  const c = useApp((s) => s.fleet.characters[id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!c) return null;

  const close = async () => {
    if (busy) return;
    setBusy(true);
    try { await phone.api().call('char.close', { id }); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Sheet title={c.name} onClose={onClose}>
      <div className="sheet-form">
        <p className="sheet-note">Closing kills its terminal and deletes its docs.</p>
        <button type="button" className="dan" disabled={busy} onClick={() => void close()}>Close {c.name}</button>
        {error && <p className="sheet-error">{error}</p>}
      </div>
    </Sheet>
  );
}
