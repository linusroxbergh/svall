import type { ChangedFile, DiffBase } from '@svall/protocol';
import { useEffect, useState } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { pick } from '../panes.js';
import { panesOf } from '../selectors.js';
import { Diff } from './Diff.js';
import { openFile } from './files.js';

type Status = { branch?: string; files: ChangedFile[] };
// error is why the file cannot be shown, said in the diff's place
type Sides = { before?: string; after?: string; binary?: true } | { error: string };

const KIND: Record<ChangedFile['status'], string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', '?': 'untracked' };

export function Changes({ id }: { id: string }) {
  // a worktree is branched off for one piece of work, and HEAD there holds all of it already committed:
  // what the character has done is the diff against main, so that is where the pane rests until a base is picked
  const worktree = useApp((s) => !!s.fleet.characters[id]?.repo?.isWorktree);
  const [chosen, setChosen] = useState<DiffBase>();
  const base = chosen ?? (worktree ? 'main' : 'head');
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  // of is the file the sides were read for: a refresh keeps them on screen, another file does not borrow them
  const [loaded, setLoaded] = useState<{ of: string; sides: Sides }>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const w = app.repoWatch();
    const stop = w.watch(id);
    const off = w.on(id, () => setTick((t) => t + 1));
    return () => { off(); stop(); };
  }, [id]);

  useEffect(() => {
    let live = true;
    app.api().call('repo.status', { id, base }).then((r) => {
      if (!live) return;
      setStatus(r);
      setError(undefined);
      // the selection survives a refresh while its file is still changed; otherwise the first file is shown
      setSelected((cur) => (cur && r.files.some((f) => f.path === cur) ? cur : r.files[0]?.path));
    }).catch((e: Error & { code?: string }) => {
      if (live) { setError(e.code === 'no_repo' ? 'Not a git repository' : e.message); setStatus(undefined); }
    });
    return () => { live = false; };
  }, [id, base, tick]);

  const file = status?.files.find((f) => f.path === selected);
  const shown = file && `${id}:${base}:${file.path}`;
  const sides = loaded && loaded.of === shown ? loaded.sides : undefined;
  useEffect(() => {
    if (!file || !shown) return;
    let live = true;
    app.api().call('repo.file', { id, path: file.path, base, from: file.from })
      .then((r) => { if (live) setLoaded({ of: shown, sides: r }); })
      .catch((e: Error) => { if (live) setLoaded({ of: shown, sides: { error: e.message } }); });
    return () => { live = false; };
  }, [id, base, tick, file?.path, file?.from]);

  if (error) return <div className="ide-empty" data-testid="changes">{error}</div>;
  return (
    <div className="ide" data-testid="changes">
      <div className="ide-side">
        <div className="base-switch">
          {(['head', 'main'] as DiffBase[]).map((b) => (
            <button key={b} className="base-btn" data-testid={`base-${b}`} data-active={base === b} onClick={() => setChosen(b)}>{b === 'head' ? 'HEAD' : 'main'}</button>
          ))}
          {status?.branch && <span className="base-branch mono">{status.branch}</span>}
        </div>
        {status?.files.length === 0 && <div className="ide-root">Nothing changed</div>}
        {status?.files.map((f) => (
          <button key={f.path} className="change-row" data-testid="change-row" data-status={f.status} data-active={f.path === selected} onClick={() => setSelected(f.path)} title={KIND[f.status]}>
            <span className="change-st">{f.status}</span>
            <span className="tree-name">{f.from ? `${f.from} → ${f.path}` : f.path}</span>
          </button>
        ))}
      </div>
      <div className="ide-main">
        {file && (
          <div className="diff-head">
            <span className="mono">{file.path}</span>
            <span className="diff-kind">{KIND[file.status]}</span>
            <span className="spacer" />
            {file.status !== 'D' && (
              <button className="btn" data-testid="diff-open" onClick={() => {
                const s = app.store.getState();
                const p = panesOf(s, id);
                s.setPanes(id, pick(p, p.right === 'changes' ? 'right' : 'left', 'files'));
                void openFile(deps(), id, file.path);
              }}>Open</button>
            )}
          </div>
        )}
        {!file || !sides ? <div className="ide-empty">{file ? '' : 'Pick a file'}</div>
          : 'error' in sides ? <div className="ide-empty" data-testid="diff-error">{sides.error}</div>
          : <Diff key={shown} path={file.path} {...sides} />}
      </div>
    </div>
  );
}
