import { useEffect, useRef, useState } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { Editor } from './Editor.js';
import { checkDisk, openFile } from './files.js';
import { FileTabs } from './FileTabs.js';
import { Tree } from './Tree.js';

/** The handle on the tree's edge; the width follows the pointer and is written to storage on release. */
function TreeGrip() {
  const drag = useRef<{ x: number; from: number }>(undefined);
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    const { filesTree, setFilesTreeWidth } = app.store.getState();
    if (filesTree.width !== undefined) setFilesTreeWidth(filesTree.width);
  };
  return (
    <i className="ide-drag" data-testid="files-tree-drag" role="separator" aria-orientation="vertical" aria-label="Resize the files" title="Drag to resize"
      onPointerDown={(e) => {
        // a narrow area draws the tree below its stored width, so a drag starts from what is on screen
        drag.current = { x: e.clientX, from: e.currentTarget.previousElementSibling!.getBoundingClientRect().width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.buttons === 0) return;
        app.store.getState().setFilesTreeWidth(d.from + e.clientX - d.x, false);
      }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
  );
}

export function FilesArea({ id }: { id: string }) {
  const active = useApp((s) => s.ide[id]?.active);
  const tree = useApp((s) => s.filesTree);
  const root = useApp((s) => { const c = s.fleet.characters[id]; return c?.repo?.root ?? c?.cwd ?? ''; });
  const [tick, setTick] = useState(0);

  // the root is watched while the tab shows; a change refreshes the open folders and checks the open files.
  // nobody watched while the tab was away, so the open files are checked on arrival too
  useEffect(() => {
    const w = app.repoWatch();
    const stop = w.watch(id);
    const check = () => { void checkDisk(deps(), id); };
    const off = w.on(id, () => { setTick((t) => t + 1); check(); });
    check();
    return () => { off(); stop(); };
  }, [id]);

  const open = (path: string) => { void openFile(deps(), id, path); };

  return (
    <div className="ide ide-files" data-testid="files" style={tree.width === undefined ? undefined : { '--tree-w': `${tree.width}px` } as React.CSSProperties}>
      {tree.open && (
        <div className="ide-side" data-testid="files-tree">
          <div className="ide-root" title={root}>{root.slice(root.lastIndexOf('/') + 1)}</div>
          <Tree id={id} dir="" depth={0} tick={tick} onOpen={open} />
        </div>
      )}
      {tree.open && <TreeGrip />}
      {tree.open
        ? <button className="ide-hide" data-testid="files-tree-hide" title="Hide the files" aria-label="Hide the files" onClick={() => app.store.getState().toggleFilesTree(false)}>‹</button>
        : <button className="ide-show" data-testid="files-tree-show" title="Show the files" aria-label="Show the files" onClick={() => app.store.getState().toggleFilesTree(true)}>›</button>}
      <div className="ide-main">
        <FileTabs id={id} />
        {active ? <Editor key={`${id}:${active}`} id={id} path={active} /> : <div className="ide-empty">Pick a file</div>}
      </div>
    </div>
  );
}
