import { useEffect, useRef, useState, type ReactNode } from 'react';
import { columnOf } from '@svall/protocol';
import { deleteColumn, deleteIsland, sleepRobot } from './actions.js';
import { app, deps } from './boot.js';
import { CloseX } from './CloseX.js';
import { dialogKeys, useApp } from './hooks.js';
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
      <div className="modal dialog" onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(onCancel)}>
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

// a column's robots go to the column picked here, its left neighbour unless the user picks another
export function ConfirmDeleteColumn() {
  const id = useApp((s) => s.deletingColumn);
  return id ? <DeleteColumn key={id} id={id} /> : null;
}

function DeleteColumn({ id }: { id: string }) {
  const fleet = useApp((s) => s.fleet);
  const [picked, setPicked] = useState<string>();
  const pick = useRef<HTMLSelectElement>(null);
  useEffect(() => { pick.current?.focus(); }, []);
  const at = fleet.columns.findIndex((k) => k.id === id);
  const others = fleet.columns.filter((k) => k.id !== id);
  const moveTo = others.find((k) => k.id === picked)?.id ?? (fleet.columns[at - 1] ?? fleet.columns[at + 1])?.id;
  if (at < 0 || !moveTo) return null;
  const n = Object.values(fleet.robots).filter((c) => columnOf(fleet, c).id === id).length;
  const cancel = () => app.store.getState().setDeletingColumn(undefined);
  return (
    <div className="modal-back" data-testid="confirm-delete-column" onPointerDown={cancel}>
      <div className="modal dialog" onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(cancel)}>
        <div className="kicker">Delete column<CloseX onClose={cancel} testid="confirm-delete-column-close" /></div>
        <div className="modal-name">{fleet.columns[at].name}</div>
        <label className="modal-note modal-pick">
          Its {n} {n === 1 ? 'robot moves' : 'robots move'} to
          <select ref={pick} className="fld" data-testid="confirm-delete-column-to" value={moveTo} onChange={(e) => setPicked(e.target.value)}>
            {others.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
        <div className="modal-note">Their agents keep running.</div>
        <div className="acts">
          <button className="btn dan" data-testid="confirm-delete-column-delete"
            onClick={(e) => { if (e.detail < 2) { cancel(); deleteColumn(deps(), id, moveTo); } }}>Delete column</button>
          <button className="btn" data-testid="confirm-delete-column-cancel" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
