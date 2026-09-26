import { useState, type JSX } from 'react';
import { useApp } from '../hooks.js';
import { charactersOf } from '../selectors.js';
import { phone } from './boot.js';
import { DocsList } from './DocsList.js';
import { Sheet } from './Sheet.js';

export function IslandSheet({ islandId, onClose, onNewCharacter }: { islandId: string; onClose(): void; onNewCharacter(): void }): JSX.Element | null {
  const island = useApp((s) => s.fleet.islands[islandId]);
  const crew = useApp((s) => charactersOf(s.fleet, islandId).length);
  const [name, setName] = useState(island?.name ?? '');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!island) return null;

  const run = async (call: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await call(); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const rename = () => run(() => phone.api().call('island.update', { id: islandId, name: name.trim() }));
  const remove = () => run(() => phone.api().call('island.delete', { id: islandId }));
  const deletable = island.kind !== 'home' && crew === 0;

  return (
    <Sheet title={island.name} onClose={onClose}>
      <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
        <input value={name} aria-label="Name" enterKeyHint="done" autoCapitalize="off" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="pri" disabled={busy || !name.trim() || name.trim() === island.name}>Rename</button>
      </form>
      <DocsList tier="island" id={islandId} />
      <div className="sheet-form">
        <button type="button" onClick={onNewCharacter}>New character in another directory</button>
      </div>
      {island.kind !== 'home' && (
        <div className="sheet-form">
          {!deletable && <p className="sheet-note">Move its crew away before deleting it.</p>}
          {!confirm && <button type="button" className="dan" disabled={!deletable || busy} onClick={() => setConfirm(true)}>Delete island</button>}
          {confirm && <button type="button" className="dan" disabled={busy} onClick={() => void remove()}>Delete {island.name} and its docs?</button>}
        </div>
      )}
      {error && <p className="sheet-error">{error}</p>}
    </Sheet>
  );
}
