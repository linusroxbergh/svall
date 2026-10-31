import { useState, type JSX } from 'react';
import type { Robot } from '@svall/protocol';
import { useApp } from '../hooks.js';
import { elsewhere } from '../placement.js';
import { phone } from './boot.js';
import { Sheet } from './Sheet.js';

export function CloseConfirm({ c, onClosed }: { c: Robot; onClosed(): void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = async () => {
    if (busy) return;
    setBusy(true);
    try { await phone.api().call('robot.close', { id: c.id }); onClosed(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <>
      <p className="sheet-note">Closing kills its terminal and deletes its docs.</p>
      <button type="button" className="dan" disabled={busy} onClick={() => void close()}>Close {c.name}</button>
      {error && <p className="sheet-error">{error}</p>}
    </>
  );
}

export function CloseRobot({ id, onClose }: { id: string; onClose(): void }): JSX.Element | null {
  const c = useApp((s) => s.fleet.robots[id]);
  const away = useApp((s) => !!c && elsewhere(c, s.via));
  if (!c || away) return null;
  return (
    <Sheet title={c.name} onClose={onClose}>
      <div className="sheet-form"><CloseConfirm c={c} onClosed={onClose} /></div>
    </Sheet>
  );
}
