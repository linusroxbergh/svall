import { useState, type JSX } from 'react';
import { phone } from './boot.js';
import { Sheet } from './Sheet.js';

export function NewIsland({ onClose }: { onClose(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await phone.api().call('island.create', { name: name.trim() });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet title="New island" onClose={onClose}>
      <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={name} placeholder="name" aria-label="Name" autoFocus enterKeyHint="done" autoCapitalize="off" onChange={(e) => setName(e.target.value)} />
        {error && <p className="sheet-error">{error}</p>}
        <button type="submit" className="pri" disabled={busy || !name.trim()}>Create</button>
      </form>
    </Sheet>
  );
}
