import { useEffect } from 'react';
import { saveEntityField } from '../actions.js';
import { app, deps } from '../boot.js';
import { FollowTextarea } from '../Field.js';
import { useApp } from '../hooks.js';
import { Editor } from '../ide/Editor.js';
import { asDoc } from './docEditor.js';
import { isFresh, letGo } from './docs.js';
import { DocHeader } from './DocHeader.js';
import { takesKeys } from './keys.js';
import { entityOf, fieldLabel, fieldValue, isAgentProfiles, isDoc, kindOf, tierOf, type FieldRef } from './model.js';

/** An island's or a character's own field, written straight back to the fleet as the side card does. */
function Field({ r }: { r: FieldRef }) {
  const e = useApp((s) => entityOf(s, r))!;
  const value = fieldValue(e, r.field);
  const save = (v: string) => {
    if (v === value) return;
    saveEntityField(deps(), r, v);
  };
  return (
    <FollowTextarea className="res-field" data-testid="resources-field" aria-label={fieldLabel(r)}
      placeholder={r.field === 'note' ? fieldLabel(r) : 'Instructions for the agent'} key={`${r.id}:${r.field}`} value={value} onSave={save} />
  );
}

/** The resource file that last opened, wherever its root; it stays up while the tree moves on. */
export function EditorPane({ onClose }: { onClose(): void }) {
  const sources = useApp((s) => s.resources);
  const shown = useApp((s) => s.resourcesShown);
  // a field whose island or character the fleet has lost is no field at all, and the pane falls back to what it shows without one
  const field = useApp((s) => (s.resourcesField && entityOf(s, s.resourcesField) ? s.resourcesField : undefined));
  const name = useApp((s) => (s.resourcesField ? entityOf(s, s.resourcesField)?.name : undefined));
  const full = useApp((s) => s.resourcesFull);
  // the row whose file or folder holds the shown file names its tier, source and kind; a file with no such row shows its name alone
  const home = shown && sources.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => ({ s, g, i }))))
    .find(({ i }) => i.open?.rootId === shown.rootId && (i.open.path === shown.path || (i.open.folder !== undefined && shown.path.startsWith(`${i.open.folder}/`))));
  const file = shown?.path.slice(shown.path.lastIndexOf('/') + 1);
  const doc = !field && shown !== undefined && isDoc(sources, shown.rootId, shown.path);
  // a doc hides its frontmatter and saves itself; letting go saves what waits, or drops a blank one this session made
  useEffect(() => {
    if (!doc || !shown) return;
    const { rootId, path } = shown;
    asDoc(deps(), rootId, path);
    return () => { void letGo(deps(), rootId, path); };
  }, [doc, shown?.rootId, shown?.path]);
  // a doc just made hands the keys to its description, and the text leaves them there for as long as the field holds them
  const fresh = doc && shown !== undefined && isFresh(shown.rootId, shown.path);
  return (
    <div className="res-editor">
      <header>
        {field ? (
          <span className="res-crumb" data-testid="resources-editor-crumb">
            <b style={{ color: `var(${tierOf(field.tier).colour})` }}>{tierOf(field.tier).one}</b><i>/</i>{name}<i>/</i>{fieldLabel(field)}
          </span>
        ) : home ? (
          <span className="res-crumb" data-testid="resources-editor-crumb">
            <b style={{ color: `var(${tierOf(home.s.tier).colour})` }}>{tierOf(home.s.tier).one}</b><i>/</i>{home.s.name}<i>/</i>{kindOf(home.g.kind).label}<i>/</i>{file}
          </span>
        ) : <span className="res-crumb">{file}</span>}
        <span className="res-ctl">
          <button className="res-x res-size" data-testid="resources-size" title={full ? 'Back to its size' : 'Full size'}
            aria-label={full ? 'Back to its size' : 'Full size'} onClick={() => app.store.getState().toggleResourcesFull()}>{full ? '⤡' : '⤢'}</button>
          <button className="res-x" data-testid="resources-close" aria-label="Close resources" onClick={onClose}>✕</button>
        </span>
      </header>
      {field ? <Field r={field} /> : shown ? (
        <>
          {doc && <DocHeader key={`desc:${shown.rootId}:${shown.path}`} id={shown.rootId} path={shown.path} focus={fresh} profile={isAgentProfiles(sources, shown.rootId)} />}
          <Editor key={`${shown.rootId}:${shown.path}`} id={shown.rootId} path={shown.path} takes={() => takesKeys() && !document.activeElement?.closest('.res-desc')} />
        </>
      ) : <div className="ide-empty">Pick a resource</div>}
    </div>
  );
}
