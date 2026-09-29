import { useState, type JSX } from 'react';
import { useApp } from '../hooks.js';
import { phone } from './boot.js';
import { cwdChoices, islandCwd } from './choices.js';
import { Sheet } from './Sheet.js';

export function NewCharacter({ islandId, onClose, onCreated }: { islandId: string; onClose(): void; onCreated(id: string): void }): JSX.Element {
  const fleet = useApp((s) => s.fleet);
  const island = fleet.islands[islandId];
  const choices = cwdChoices(fleet, islandId);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(() => islandCwd(fleet, islandId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const c = await phone.api().call('char.create', { islandId, cwd, ...(name.trim() ? { name: name.trim() } : {}) });
      onCreated(c.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={`New character on ${island?.name ?? 'island'}`} onClose={onClose}>
      <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={name} placeholder="name (optional)" aria-label="Name" enterKeyHint="done" autoCapitalize="off" onChange={(e) => setName(e.target.value)} />
        <div className="choices" role="radiogroup" aria-label="Directory">
          {choices.map((c) => (
            <label key={c.path} className="choice">
              <input type="radio" name="cwd" value={c.path} checked={cwd === c.path} onChange={() => setCwd(c.path)} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        {error && <p className="sheet-error">{error}</p>}
        <button type="submit" className="pri" disabled={busy}>Create</button>
      </form>
    </Sheet>
  );
}
