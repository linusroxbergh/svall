import { useState } from 'react';
import { app } from '../boot.js';
import { useApp } from '../hooks.js';
import { Close } from '../icons.js';
import { basename } from '../paths.js';
import { closeFile } from './files.js';

export function FileTabs({ id }: { id: string }) {
  const ide = useApp((s) => s.ide[id]);
  const [closing, setClosing] = useState<string>();
  if (!ide || ide.open.length === 0) return null;
  const close = (path: string) => { closeFile(app, id, path); setClosing(undefined); };
  return (
    <div className="ftabs" data-testid="file-tabs">
      <div className="dtabs">
        {ide.open.map((path) => (
          <div key={path} className="dtab" data-testid={`file-tab-${path}`} data-active={path === ide.active} data-dirty={ide.dirty.includes(path)}
            onClick={() => app.store.getState().activateFile(id, path)} data-tip={path}>
            <span className="dtab-name">{basename(path)}</span>
            {ide.dirty.includes(path) && <span className="dtab-dot" />}
            <button className="ib bar" data-testid={`file-close-${path}`} aria-label={`Close ${basename(path)}`}
              onClick={(e) => { e.stopPropagation(); if (ide.dirty.includes(path)) setClosing(path); else close(path); }}><Close size="xs" /></button>
          </div>
        ))}
      </div>
      {closing && (
        <div className="ftab-ask" data-testid="discard-ask">
          Discard changes to {basename(closing)}?
          <button className="btn sm dan" data-testid="discard-yes" onClick={() => close(closing)}>Discard</button>
          <button className="btn sm" data-testid="discard-no" onClick={() => setClosing(undefined)}>Keep</button>
        </div>
      )}
    </div>
  );
}
