import { useEffect, useState } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { Editor } from './Editor.js';
import { checkDisk, openFile } from './files.js';
import { FileTabs } from './FileTabs.js';
import { Tree } from './Tree.js';

export function FilesArea({ id }: { id: string }) {
  const active = useApp((s) => s.ide[id]?.active);
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
    <div className="ide" data-testid="files">
      <div className="ide-side">
        <div className="ide-root" title={root}>{root.slice(root.lastIndexOf('/') + 1)}</div>
        <Tree id={id} dir="" depth={0} tick={tick} onOpen={open} />
      </div>
      <div className="ide-main">
        <FileTabs id={id} />
        {active ? <Editor key={`${id}:${active}`} id={id} path={active} /> : <div className="ide-empty">Pick a file</div>}
      </div>
    </div>
  );
}
