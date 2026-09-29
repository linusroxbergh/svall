import type { FsEntry } from '@svall/protocol';
import { useEffect, useState } from 'react';
import { app } from '../boot.js';
import { useApp } from '../hooks.js';

type Props = { id: string; dir: string; depth: number; tick: number; onOpen(path: string): void };

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
// one array for every character with nothing open: a selector must answer the same thing twice
const NONE: string[] = [];

/** One folder's rows; a folder row holds its own Tree once expanded. */
export function Tree({ id, dir, depth, tick, onOpen }: Props) {
  const expanded = useApp((s) => s.ide[id]?.expanded ?? NONE);
  const active = useApp((s) => s.ide[id]?.active);
  const [entries, setEntries] = useState<FsEntry[]>();
  const [error, setError] = useState<string>();

  // tick moves on every repo.changed, so an open folder shows a file the agent just made
  useEffect(() => {
    let live = true;
    app.api().call('fs.list', { id, path: dir })
      .then((r) => { if (live) { setEntries(r.entries); setError(undefined); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id, dir, tick]);

  if (error) return <div className="tree-err" style={{ paddingLeft: 12 + depth * 14 }}>{error}</div>;
  if (!entries) return null;
  return (
    <>
      {entries.map((e) => {
        const path = join(dir, e.name);
        const open = e.kind === 'dir' && expanded.includes(path);
        return (
          <div key={path}>
            <button className="tree-row" data-testid={`tree-${path}`} data-kind={e.kind} data-open={open} data-active={path === active} data-ignored={e.ignored}
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => (e.kind === 'dir' ? app.store.getState().toggleFolder(id, path) : onOpen(path))}>
              <span className="tree-caret">{e.kind === 'dir' ? (open ? '▾' : '▸') : ''}</span>
              <span className="tree-name">{e.name}</span>
            </button>
            {open && <Tree id={id} dir={path} depth={depth + 1} tick={tick} onOpen={onOpen} />}
          </div>
        );
      })}
    </>
  );
}
