import { Fragment, useRef, useState, type JSX, type RefObject } from 'react';
import { contextKind, type Character, type ContextItem, type Params } from '@svall/protocol';
import { webUrl } from '../bridge.js';
import { commitFocused, FollowTextarea } from '../Field.js';
import { useApp, useTick } from '../hooks.js';
import { LinkIcon } from '../map/LinkIcon.js';
import { ago, hintText, linkText } from '../map/tokenText.js';
import { usePromptHistory } from '../promptHistory.js';
import { contextPctOf } from '../selectors.js';
import { phone } from './boot.js';
import { CloseConfirm } from './CloseCharacter.js';
import { DocsList } from './DocsList.js';
import { Sheet } from './Sheet.js';

// a refusal is told beside the edit it refused
function useSave(id: string) {
  const [error, setError] = useState<string>();
  const save = (patch: Omit<Params<'char.update'>, 'id'>): Promise<boolean> => {
    setError(undefined);
    return phone.api().call('char.update', { id, ...patch }).then(() => true, (e: Error) => { setError(e.message); return false; });
  };
  return [error, save] as const;
}

// a pinned item is read before the agent starts; only one added by hand can be taken off
function Context({ c }: { c: Character }) {
  const [ref, setRef] = useState('');
  const [error, save] = useSave(c.id);
  const set = (context: ContextItem[]) => save({ context });
  const pin = (i: number) => set(c.context.map((it, j) => (j !== i ? it : it.pinned ? (({ pinned: _p, ...r }) => r)(it) : { ...it, pinned: true })));
  const add = () => {
    const r = ref.trim();
    if (!r) return;
    setRef('');
    // a refused ref goes back in the field, unless another is being typed
    void set([...c.context, { kind: contextKind(r), ref: r, label: '', source: 'manual' }]).then((ok) => { if (!ok) setRef((now) => now || r); });
  };
  return (
    <div className="m-sec">
      <h4>Context</h4>
      {c.context.map((it, i) => {
        const name = linkText(it);
        // the phone opens only links; a path names a file on the Mac
        const href = it.kind === 'file' || it.kind === 'folder' ? undefined : webUrl(it.ref);
        return (
          <div key={`${it.ref}-${i}`} className="m-link">
            <i className="lg"><LinkIcon item={it} /></i>
            {href ? <a className="m-link-text" href={href} target="_blank" rel="noreferrer">{name}</a> : <span className="m-link-text">{name}</span>}
            <button type="button" aria-pressed={Boolean(it.pinned)} aria-label={`Pin ${name}`} onClick={() => pin(i)}>{it.pinned ? '●' : '○'}</button>
            {it.source === 'manual' && <button type="button" aria-label={`Remove ${name}`} onClick={() => set(c.context.filter((_, j) => j !== i))}>×</button>}
          </div>
        );
      })}
      <form className="m-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={ref} placeholder="Add a url or path" aria-label="Add a url or path" enterKeyHint="done" autoCapitalize="off" autoCorrect="off"
          onChange={(e) => setRef(e.target.value)} />
        <button type="submit" disabled={!ref.trim()}>Add</button>
      </form>
      {error && <p className="sheet-error">{error}</p>}
    </div>
  );
}

function Note({ c, saving }: { c: Character; saving: RefObject<Promise<boolean> | undefined> }) {
  const [error, save] = useSave(c.id);
  return (
    <div className="m-sec">
      <h4>Note</h4>
      <FollowTextarea className="m-field" rows={3} aria-label="Note" placeholder="What this character is doing" value={c.note}
        onSave={(v) => { if (v !== c.note) saving.current = save({ note: v }); }} />
      {error && <p className="sheet-error">{error}</p>}
    </div>
  );
}

function LastCommand({ c }: { c: Character }) {
  const { list, at, step } = usePromptHistory(phone.api, c.id, c.agent);
  if (!c.agent) return null;
  return (
    <div className="m-sec">
      <h4>
        Last command
        {list.length > 0 && (
          <span className="m-nav">
            <button type="button" aria-label="Earlier command" disabled={at >= list.length - 1} onClick={() => step(1)}>‹</button>
            <b>{at + 1}/{list.length}</b>
            <button type="button" aria-label="Later command" disabled={at === 0} onClick={() => step(-1)}>›</button>
          </span>
        )}
      </h4>
      <p className="m-text">{list[at] ?? 'nothing sent yet'}</p>
    </div>
  );
}

// the phone reads the agent's instructions; they are written on the Mac
function Instructions({ c }: { c: Character }) {
  if (!c.instructions) return null;
  return (
    <div className="m-sec">
      <h4>Instructions</h4>
      <p className="m-text">{c.instructions}</p>
    </div>
  );
}

function Details({ c }: { c: Character }) {
  const pct = contextPctOf(c);
  // last activity counts on while a busy agent sends nothing
  useTick(10_000);
  return (
    <div className="m-sec">
      <h4>Details</h4>
      <div className="m-rows">
        {c.repo && <div><span>branch</span><b className="mono">{c.repo.branch}{c.repo.isWorktree ? ' · worktree' : ''}</b></div>}
        <div><span>model</span><b className="mono">{c.agent?.model ?? 'no agent'}</b></div>
        {c.agentProfile && <div><span>profile</span><b>{c.agentProfile}</b></div>}
        {pct !== undefined && <div><span>context</span><b>{Math.round(pct)}%</b></div>}
        {/* a path wraps at its slashes */}
        <div><span>cwd</span><b className="mono">{c.cwd.split(/(?<=\/)/).map((part, i) => <Fragment key={i}>{part}<wbr /></Fragment>)}</b></div>
        <div><span>last activity</span><b>{ago(c.agent?.lastActivityAt ?? c.shell.lastOutputAt)} ago</b></div>
      </div>
    </div>
  );
}

/** The side card of the Mac, as a sheet: what the character works from. */
export function CharacterMenu({ id, onClose, onClosed }: { id: string; onClose(): void; onClosed(): void }): JSX.Element | null {
  const c = useApp((s) => s.fleet.characters[id]);
  const [confirm, setConfirm] = useState(false);
  const saving = useRef<Promise<boolean>>(undefined);
  if (!c) return null;

  // a field saves on blur, which a sheet taken away never sends; a note the fleet refused keeps the sheet up beside its error
  const close = async () => {
    commitFocused();
    const note = saving.current;
    saving.current = undefined;
    if (!note || await note) onClose();
  };
  const hint = hintText(c);

  return (
    <Sheet title={c.name} onClose={close}>
      {hint && <p className="sheet-note">{hint}</p>}
      <Context c={c} />
      <Note c={c} saving={saving} />
      <DocsList tier="character" id={id} />
      <LastCommand c={c} />
      <Instructions c={c} />
      <Details c={c} />
      <div className="sheet-form m-acts">
        {confirm
          ? <CloseConfirm c={c} onClosed={onClosed} />
          : <button type="button" className="dan" onClick={() => setConfirm(true)}>Close character</button>}
      </div>
    </Sheet>
  );
}
