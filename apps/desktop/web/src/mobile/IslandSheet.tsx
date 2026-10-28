import { useState, type JSX } from 'react';
import { useApp } from '../hooks.js';
import { robotsOf } from '../selectors.js';
import { phone } from './boot.js';
import { DocsList } from './DocsList.js';
import { startMission } from './mission.js';
import { Sheet } from './Sheet.js';

type Props = { islandId: string; onClose(): void; onNewRobot(): void; onOpen(id: string): void };

export function IslandSheet({ islandId, onClose, onNewRobot, onOpen }: Props): JSX.Element | null {
  const fleet = useApp((s) => s.fleet);
  const island = fleet.islands[islandId];
  const crew = useApp((s) => robotsOf(s.fleet, islandId).length);
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
  // a button starts a home robot on its skill and opens it, as the island's own buttons do on the Mac
  const press = (prompt: string, label: string) => run(async () => { onOpen((await startMission(phone.api(), fleet, prompt, label)).id); });

  return (
    <Sheet title={island.name} onClose={onClose}>
      <form className="sheet-form" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
        <input value={name} aria-label="Name" enterKeyHint="done" autoCapitalize="off" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="pri" disabled={busy || !name.trim() || name.trim() === island.name}>Rename</button>
      </form>
      {island.kind === 'home' && fleet.home.actions.length > 0 && (
        <div className="sheet-form m-shortcuts">
          {fleet.home.actions.map((a) => (
            <button key={a.label} type="button" disabled={busy} onClick={() => void press(a.prompt, a.label)}>{a.label}</button>
          ))}
        </div>
      )}
      <DocsList tier="island" id={islandId} />
      <div className="sheet-form">
        <button type="button" onClick={onNewRobot}>New robot in another directory</button>
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
