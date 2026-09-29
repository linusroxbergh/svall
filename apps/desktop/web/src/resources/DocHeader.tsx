import { frontmatter, withDescription } from '@svall/protocol';
import { useEffect, useRef, useState } from 'react';
import { app } from '../boot.js';
import { editBuffer, focusBuffer, getBuffer, select, subscribeBuffer } from '../ide/buffers.js';
import { bodyStart } from './docEditor.js';

// the one change that turns a into b, so the edit stays in the frontmatter and leaves the body's cursor be
function change(a: string, b: string): { from: number; to: number; insert: string } {
  let from = 0;
  while (from < a.length && from < b.length && a[from] === b[from]) from++;
  let end = 0;
  while (end < a.length - from && end < b.length - from && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { from, to: a.length - end, insert: b.slice(from, b.length - end) };
}

/** A doc's description, the line its agent decides by, written into the frontmatter as it is typed; an agent profile's is the line its picker shows. */
export function DocHeader({ id, path, focus, profile = false }: { id: string; path: string; focus: boolean; profile?: boolean }) {
  const [text, setText] = useState(() => getBuffer(id, path)?.state.doc.toString() ?? '');
  useEffect(() => subscribeBuffer(id, path, setText), [id, path]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) input.current?.focus(); }, [id, path, focus]);
  const set = (value: string) => {
    const was = getBuffer(id, path)?.state.doc.toString();
    if (was === undefined) return;
    const dirty = editBuffer(id, path, { changes: change(was, withDescription(was, value)) });
    app.store.getState().markFile(id, path, { dirty });
  };
  const toBody = () => {
    const b = getBuffer(id, path);
    if (b) select(id, path, bodyStart(b.state));
    focusBuffer(id, path);
  };
  return (
    <label className="res-desc">
      <span>{profile ? 'What is this role for?' : 'When should the agent read this?'}</span>
      <input ref={input} data-testid="resources-doc-description" placeholder={profile ? 'e.g. reviews finished work before it merges' : 'e.g. before touching the billing code'}
        value={frontmatter(text).description ?? ''} onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); toBody(); } }} />
    </label>
  );
}
