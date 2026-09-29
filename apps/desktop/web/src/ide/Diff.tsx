import { unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { languageFor, readOnlyExtensions } from './codemirror.js';

type Props = { path: string; before?: string; after?: string; binary?: true };

/** The working file over the base version: deletions inline, unchanged stretches folded. */
export function Diff({ path, before, after, binary }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || binary) return;
    let view: EditorView | undefined;
    let live = true;
    languageFor(path.slice(path.lastIndexOf('/') + 1)).then((lang) => {
      if (!live) return;
      view = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: after ?? '',
          extensions: [readOnlyExtensions(), lang ?? [], unifiedMergeView({ original: before ?? '', mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 } })],
        }),
      });
    });
    return () => { live = false; view?.destroy(); };
  }, [path, before, after, binary]);

  if (binary) return <div className="ide-empty">Binary file</div>;
  return <div ref={host} className="diff" data-testid="diff" data-path={path} />;
}
