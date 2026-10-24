import { useEffect, useRef, type ReactNode } from 'react';
import { deleteIsland, sleepRobot } from './actions.js';
import { app, deps } from './boot.js';
import { CloseX } from './CloseX.js';
import { useApp } from './hooks.js';
import { closeRobot } from './keyboard.js';

function Confirm({ id, testid, title, name, note, act, focusAct, onCancel, onConfirm }: {
  id: string | undefined;
  testid: string;
  title: string;
  name: string | undefined;
  note: ReactNode;
  act: string;
  focusAct?: boolean;
  onCancel(): void;
  onConfirm(id: string): void;
}) {
  const go = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (id) (focusAct ? go : keep).current?.focus(); }, [id]);

  if (!id) return null;
  return (
    <div className="modal-back" data-testid={testid} onPointerDown={onCancel}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the dialog; Enter presses the focused button
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        }}>
        <div className="kicker">{title}<CloseX onClose={onCancel} testid={`${testid}-close`} /></div>
        <div className="modal-name">{name}</div>
        <div className="modal-note" data-testid={`${testid}-note`}>{note}</div>
        <div className="acts">
          {/* a double click's second press must not answer the dialog its first opened */}
          <button ref={go} className="btn dan" data-testid={`${testid}-${act.toLowerCase()}`}
            onClick={(e) => { if (e.detail < 2) { onCancel(); onConfirm(id); } }}>{act}</button>
          <button ref={keep} className="btn" data-testid={`${testid}-cancel`} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Cmd+W asks before a robot goes: Enter on Delete, which has the focus, or a second Cmd+W deletes it, Esc keeps it
export function ConfirmClose() {
  const id = useApp((s) => s.closingRobot);
  const name = useApp((s) => (s.closingRobot ? s.fleet.robots[s.closingRobot]?.name : undefined));
  const unsaved = useApp((s) => (s.closingRobot ? s.ide[s.closingRobot]?.dirty.length ?? 0 : 0));
  return (
    <Confirm id={id} testid="confirm-close" title="Delete robot" name={name} act="Delete" focusAct
      note={<>Closing kills its terminal and deletes its docs.{unsaved > 0 && ` ${unsaved} unsaved ${unsaved === 1 ? 'file goes' : 'files go'} with it.`}</>}
      onCancel={() => app.store.getState().setClosingRobot(undefined)}
      onConfirm={(id) => { closeRobot(deps(), id).catch((e: Error) => app.store.getState().showToast(e.message)); }} />
  );
}

// a working robot loses the turn it is on, so its sleep asks once more; a reflex Enter keeps it
export function ConfirmSleep() {
  const id = useApp((s) => s.sleepingRobot);
  const name = useApp((s) => (s.sleepingRobot ? s.fleet.robots[s.sleepingRobot]?.name : undefined));
  return (
    <Confirm id={id} testid="confirm-sleep" title="Sleep" name={name} act="Sleep" note={<>{name} is working. Sleep anyway?</>}
      onCancel={() => app.store.getState().setSleepingRobot(undefined)}
      onConfirm={(id) => void sleepRobot(deps(), id)} />
  );
}

// an island's docs go with it, so its delete asks once more; a reflex Enter keeps it
export function ConfirmDeleteIsland() {
  const id = useApp((s) => s.deletingIsland);
  const name = useApp((s) => (s.deletingIsland ? s.fleet.islands[s.deletingIsland]?.name : undefined));
  return (
    <Confirm id={id} testid="confirm-delete-island" title="Delete island" name={name} act="Delete" note="Its docs go with it."
      onCancel={() => app.store.getState().setDeletingIsland(undefined)}
      onConfirm={(id) => deleteIsland(deps(), id)} />
  );
}
