import { useState, type JSX } from 'react';
import type { Character } from '@svall/protocol';
import { useApp } from '../hooks.js';
import { phone } from './boot.js';
import { Sheet } from './Sheet.js';

/** What closing a character costs and the button that closes it, with a refusal told beside them. */
export function CloseConfirm({ c, onClosed }: { c: Character; onClosed(): void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = async () => {
    if (busy) return;
    setBusy(true);
    try { await phone.api().call('char.close', { id: c.id }); onClosed(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <>
      <p className="sheet-note">Closing kills its terminal and deletes its docs.</p>
      <button type="button" className="dan" disabled={busy} onClick={() => void close()}>Close {c.name}</button>
      {error && <p className="sheet-error">{error}</p>}
    </>
  );
}

export function CloseCharacter({ id, onClose }: { id: string; onClose(): void }): JSX.Element | null {
  const c = useApp((s) => s.fleet.characters[id]);
  if (!c) return null;
  return (
    <Sheet title={c.name} onClose={onClose}>
      <div className="sheet-form"><CloseConfirm c={c} onClosed={onClose} /></div>
    </Sheet>
  );
}
