import { useState, type JSX } from 'react';
import { createRobot } from '../actions.js';
import { useApp } from '../hooks.js';
import { machineName } from '../placement.js';
import { islandCwd, startOf } from '../selectors.js';
import { phone } from './boot.js';
import { cwdChoices } from './choices.js';
import { Sheet } from './Sheet.js';

export function NewRobot({ islandId, onClose, onCreated }: { islandId: string; onClose(): void; onCreated(id: string): void }): JSX.Element {
  const fleet = useApp((s) => s.fleet);
  const via = useApp((s) => s.via);
  const island = fleet.islands[islandId];
  const choices = cwdChoices(fleet, islandId, via?.machine);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(() => (via ? choices[0]?.path ?? '' : islandCwd(fleet, islandId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const c = await createRobot(phone.api(), { islandId, cwd, ...(name.trim() ? { name: name.trim() } : {}), ...startOf(fleet, islandId) }, fleet.defaultCwd);
      onCreated(c.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={`New robot on ${island?.name ?? 'island'}`} onClose={onClose}>
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
        {via && !choices.length && <p className="sheet-note">No robot runs on {machineName(fleet, via.machine)} yet, so there is no folder there to start in.</p>}
        {error && <p className="sheet-error">{error}</p>}
        <button type="submit" className="pri" disabled={busy || !cwd}>Create</button>
      </form>
    </Sheet>
  );
}
