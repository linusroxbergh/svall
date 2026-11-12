import { useEffect, useRef, useState } from 'react';
import { ROBOT_NOTE_MAX, type Result } from '@svall/protocol';
import { newNamedRobot, newRobotFolder, placeRobot, showCreated } from './actions.js';
import { app, deps } from './boot.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { shortPath } from './paths.js';
import { homeName, startsOn, type Via } from './placement.js';

// away from its home a worker starts a robot only inside a clone
const offeredOf = (r: Result<'workspace.clones'>, via: Via) => r.folders.filter((f) => via.online || f.clone);

// name is enough: Enter creates. A note and links are there when the name alone is not. A window on a home elsewhere has
// no folder of its own to go by, so there the dialog asks for one of that machine's.
export function NewRobot() {
  const open = useApp((s) => s.namingRobot);
  const via = useApp((s) => s.via);
  const machines = useApp((s) => s.fleet.machines);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [links, setLinks] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState('');
  // the field is for a folder the list does not hold
  const [other, setOther] = useState(false);
  // null: the list could not be read
  const [listed, setListed] = useState<Result<'workspace.clones'> | null>();
  const [refused, setRefused] = useState<string>();
  // a folder the user chose stands through the list being read again
  const chosen = useRef(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setName(''); setNote(''); setLinks(''); setMore(false); setBusy(false); setCwd(''); setOther(false); setListed(undefined); setRefused(undefined); chosen.current = false; return; }
    field.current?.focus();
  }, [open]);

  // answered by whichever machine a robot would start on now, so a window that changes source reads the list again
  const startsAt = via && startsOn(via);
  useEffect(() => {
    if (!open || !via) return;
    let left = false;
    setListed(undefined);
    app.api().call('workspace.clones', {}).then((r) => {
      if (left) return;
      setListed(r);
      const offered = offeredOf(r, via).map((f) => f.path);
      const s = app.store.getState();
      const start = newRobotFolder(s);
      // state holds the fleet's own folders as they were typed, `~` and all
      const wanted = start === s.fleet.home.cwd ? r.defaults.home : start === s.fleet.defaultCwd ? r.defaults.cwd : start;
      if (!chosen.current) setCwd([wanted, r.defaults.cwd, offered[0]].find((p) => p !== undefined && offered.includes(p)) ?? '');
    }, () => { if (!left) setListed(null); });
    return () => { left = true; };
  }, [open, startsAt]);

  if (!open) return null;
  const close = () => app.store.getState().setNamingRobot(false);
  const on = via && (listed?.machine ?? startsOn(via));
  const where = via && (on === via.machine ? 'this Mac' : homeName({ machines }, via));
  const folders = via && listed ? offeredOf(listed, via) : [];
  const folder = cwd.trim();
  // a chosen folder a list read again no longer holds stays in the field
  const typing = other || (listed !== undefined && !folders.some((f) => f.path === folder));

  const create = async () => {
    if (busy || (via && !folder)) return;
    setBusy(true);
    setRefused(undefined);
    const d = deps();
    const refs = links.split('\n').map((u) => u.trim()).filter(Boolean);
    try {
      const id = await newNamedRobot(d, { name: name.trim(), note: note.trim(), refs, ...(via && { cwd: folder }) });
      const column = d.store.getState().namingColumn;
      close();
      showCreated(d, id);
      if (column) await placeRobot(d, id, column);
    } catch (e) {
      const { code, data } = e as { code?: string; data?: { kind?: string } };
      if (via && code === 'not_a_folder') setRefused(data?.kind === 'file' ? `${folder} is a file, not a folder` : `${where === 'this Mac' ? 'This Mac' : where} has no folder ${folder}`);
      else d.store.getState().showToast((e as Error).message);
      setBusy(false);
    }
  };
  const choose = (path: string, typed = false) => { chosen.current = true; setOther(typed); setCwd(path); setRefused(undefined); };

  return (
    <div className="modal-back" data-testid="new-robot" onPointerDown={close}>
      <div className="modal dialog" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="kicker">New robot<CloseX onClose={close} testid="new-robot-close" /></div>
        <input ref={field} className="h2" placeholder="name" aria-label="Name" value={name} data-testid="new-robot-name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
        {via && (
          <div className="new-folder">
            <span className="modal-sub" id="new-robot-where" data-testid="new-robot-where">folder on {where}{on === via.machine && !via.online && `, while ${homeName({ machines }, via)} is not reachable`}</span>
            <div className="new-folder-list" role="listbox" aria-labelledby="new-robot-where" aria-busy={listed === undefined || undefined} data-testid="new-robot-folders">
              {listed === undefined && <span className="new-folder-quiet"><span className="move-spin" aria-hidden />Reading {where}'s folders…</span>}
              {listed === null && <span className="new-folder-quiet">Could not read {where}'s folders.</span>}
              {listed && !folders.length && <span className="new-folder-quiet" data-testid="new-robot-none">{via.online ? `No clone or robot folder on ${where} yet.` : 'No clone listed here; type a path inside one.'}</span>}
              {folders.map((f) => (
                <button key={f.path} className="list-row sm mono" role="option" aria-selected={!typing && f.path === folder} data-testid={`new-robot-pick-${f.path}`} data-tip={f.path} onClick={() => choose(f.path)}><bdi>{shortPath(f.path)}</bdi></button>
              ))}
              {folders.length > 0 && <button className="list-row sm" role="option" aria-selected={typing} data-testid="new-robot-other" onClick={() => choose('', true)}>Other folder…</button>}
            </div>
            {typing && (
              <input className="fld mono" placeholder="~/code/project" aria-label="Folder" value={cwd} data-testid="new-robot-folder" {...AS_TYPED} autoFocus={other}
                onChange={(e) => choose(e.target.value, true)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
            )}
            {refused && <span className="new-folder-refused" role="alert" data-testid="new-robot-refused">{refused}</span>}
          </div>
        )}
        {!more && (
          <button className="btn ghost" data-testid="new-robot-more" onClick={() => setMore(true)}>Add a note and links</button>
        )}
        {more && (
          <>
            <textarea className="fld desc" placeholder="note" value={note} maxLength={ROBOT_NOTE_MAX} data-testid="new-robot-note"
              onChange={(e) => setNote(e.target.value)} />
            <textarea className="fld" placeholder="links or paths, one per line" value={links} data-testid="new-robot-links" {...AS_TYPED}
              onChange={(e) => setLinks(e.target.value)} />
          </>
        )}
        <div className="acts">
          <button className="btn pri" data-testid="new-robot-create" disabled={busy || (!!via && !folder)} data-tip={via && !folder ? `Choose a folder on ${where}` : undefined} onClick={() => void create()}>Create</button>
          <button className="btn" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
