import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { getBuffer, mountView, subscribeBuffer, unmountView } from './buffers.js';
import { overwriteFile, reloadFile } from './files.js';

const MarkdownPreview = lazy(() => import('./MarkdownPreview.js').then((m) => ({ default: m.MarkdownPreview })));

/** takes: asked as the view mounts, whether it should take the keyboard. A pane whose rail is being
 *  walked with the keys says no, so the walk goes on; everything else lets the file have them. */
export function Editor({ id, path, takes }: { id: string; path: string; takes?: () => boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const conflict = useApp((s) => s.ide[id]?.conflict.includes(path) ?? false);
  const markdown = /\.(md|markdown)$/i.test(path);
  const [preview, setPreview] = useState(false);
  const [text, setText] = useState(() => getBuffer(id, path)?.state.doc.toString() ?? '');

  useEffect(() => markdown ? subscribeBuffer(id, path, setText) : undefined, [id, path, markdown]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (preview) return;
    const view = mountView(id, path, el, (dirty) => app.store.getState().markFile(id, path, { dirty }));
    if (takes?.() ?? true) view.focus();
    return () => unmountView(id, path);
  }, [id, path, preview]);

  return (
    <div className="editor" data-testid="editor" data-path={path}>
      {markdown && <div className="editor-mode" role="group" aria-label="Markdown view">
        <button type="button" data-active={!preview} aria-pressed={!preview} onClick={() => setPreview(false)}>Text</button>
        <button type="button" data-active={preview} aria-pressed={preview} onClick={() => { setText(getBuffer(id, path)?.state.doc.toString() ?? ''); setPreview(true); }}>Preview</button>
      </div>}
      {conflict && (
        <div className="ide-banner" data-testid="conflict-banner">
          <span>{path} changed on disk.</span>
          <button className="btn" data-testid="conflict-reload" onClick={() => { void reloadFile(deps(), id, path); }}>Reload</button>
          <button className="btn pri" data-testid="conflict-overwrite" onClick={() => { void overwriteFile(deps(), id, path); }}>Overwrite</button>
        </div>
      )}
      {preview && markdown && <Suspense fallback={<div className="ide-empty">Loading preview…</div>}><MarkdownPreview id={id} path={path} text={text} /></Suspense>}
      <div ref={host} className="editor-host" style={preview ? { display: 'none' } : undefined} />
    </div>
  );
}
