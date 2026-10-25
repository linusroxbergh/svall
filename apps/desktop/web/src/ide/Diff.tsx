import { getOriginalDoc, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { ChangeSet, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { basename } from '../paths.js';
import { changes } from './buffers.js';
import { languageFor, readOnlyExtensions } from './codemirror.js';

type Props = { path: string; before?: string; after?: string; binary?: true };

/** The working file over the base version: deletions inline, unchanged stretches folded. */
export function Diff({ path, before, after, binary }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const sides = useRef({ before, after });

  useEffect(() => {
    const el = host.current;
    if (!el || binary) return;
    let live = true;
    languageFor(basename(path)).then((lang) => {
      if (!live) return;
      view.current = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: sides.current.after ?? '',
          extensions: [readOnlyExtensions(), lang ?? [], unifiedMergeView({ original: sides.current.before ?? '', mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 } })],
        }),
      });
    });
    return () => { live = false; view.current?.destroy(); view.current = undefined; };
  }, [path, binary]);

  // new sides change the view in place, so its scroll and the stretches unfolded stay
  useEffect(() => {
    sides.current = { before, after };
    const v = view.current;
    if (!v) return;
    const original = getOriginalDoc(v.state).toString();
    v.dispatch({
      changes: changes(v.state.doc.toString(), after ?? ''),
      effects: originalDocChangeEffect(v.state, ChangeSet.of(changes(original, before ?? ''), original.length)),
    });
  }, [before, after]);

  if (binary) return <div className="ide-empty">Binary file</div>;
  return <div ref={host} className="diff" data-testid="diff" data-path={path} />;
}
