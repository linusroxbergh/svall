import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { accountHome, basename } from '../paths.js';
import { useWidthGrip } from '../widthGrip.js';
import { Editor } from './Editor.js';
import { checkDisk, openFile } from './files.js';
import { FileTabs } from './FileTabs.js';
import { Tree } from './Tree.js';
import { absOf, parent, placeOf, rootOf } from './where.js';

/** The handle on the tree's edge; the width follows the pointer and is written to storage on release. */
function TreeGrip() {
  const grip = useWidthGrip(
    // a narrow area draws the tree below its stored width, so a drag starts from what is on screen
    (el) => el.previousElementSibling!.getBoundingClientRect().width,
    (from, dx) => app.store.getState().setFilesTreeWidth(from + dx, false),
    () => { const { filesTree, setFilesTreeWidth } = app.store.getState(); if (filesTree.width !== undefined) setFilesTreeWidth(filesTree.width); });
  return <i className="ide-drag" data-testid="files-tree-drag" role="separator" aria-orientation="vertical" aria-label="Resize the files" title="Drag to resize" {...grip} />;
}

/** The folders from the home folder, or the disk's top, down to the tree's top; each takes the tree up to it. */
function Crumbs({ id, root, top }: { id: string; root: string; top: string }) {
  const nav = useRef<HTMLElement>(null);
  const home = accountHome(root);
  const chain: string[] = [];
  for (let d = absOf(top, root); ; d = parent(d)) { chain.unshift(d); if (d === home || d === '/') break; }
  // a long chain keeps its end, the folder the tree shows, in view
  useLayoutEffect(() => { if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth; }, [root, top]);
  const go = (d: string) => app.store.getState().setTop(id, placeOf(d, root));
  return (
    <div className="ide-where">
      <nav className="ide-root ide-crumbs" ref={nav} aria-label="Folder">
        {chain.map((d, i) => (
          <Fragment key={d}>
            {i > 0 && <span className="ide-sep">›</span>}
            <button className="ide-crumb" data-testid={`crumb-${d}`} title={d} aria-current={i === chain.length - 1 || undefined} onClick={() => go(d)}>
              {d === home ? '~' : basename(d) || '/'}
            </button>
          </Fragment>
        ))}
      </nav>
      {top !== '' && <button className="ide-back" data-testid="files-back" title="Back to the robot's folder" onClick={() => go(root)}>↩ {basename(root)}</button>}
    </div>
  );
}

export function FilesArea({ id }: { id: string }) {
  const active = useApp((s) => s.ide[id]?.active);
  const tree = useApp((s) => s.filesTree);
  const root = useApp((s) => { const c = s.fleet.robots[id]; return c ? rootOf(c) : ''; });
  const top = useApp((s) => s.ide[id]?.top ?? '');
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
          <Crumbs id={id} root={root} top={top} />
          <Tree key={top} id={id} root={root} dir={top} depth={0} tick={tick} onOpen={open} />
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
