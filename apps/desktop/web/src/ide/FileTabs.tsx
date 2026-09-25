import { useState } from 'react';
import { app } from '../boot.js';
import { useApp } from '../hooks.js';
import { closeFile } from './files.js';

const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function FileTabs({ id }: { id: string }) {
  const ide = useApp((s) => s.ide[id]);
  const [closing, setClosing] = useState<string>();
  if (!ide || ide.open.length === 0) return null;
  const close = (path: string) => { closeFile(app, id, path); setClosing(undefined); };
  return (
    <div className="ftabs" data-testid="file-tabs">
      <div className="ftab-row">
        {ide.open.map((path) => (
          <div key={path} className="ftab" data-testid={`file-tab-${path}`} data-active={path === ide.active} data-dirty={ide.dirty.includes(path)}
            onClick={() => app.store.getState().activateFile(id, path)} title={path}>
            <span className="ftab-name">{name(path)}</span>
            <span className="ftab-dot" />
            <button className="ftab-x" data-testid={`file-close-${path}`} aria-label={`Close ${name(path)}`}
              onClick={(e) => { e.stopPropagation(); if (ide.dirty.includes(path)) setClosing(path); else close(path); }}>×</button>
          </div>
        ))}
      </div>
      {closing && (
        <div className="ftab-ask" data-testid="discard-ask">
          Discard changes to {name(closing)}?
          <button className="btn dan" data-testid="discard-yes" onClick={() => close(closing)}>Discard</button>
          <button className="btn" data-testid="discard-no" onClick={() => setClosing(undefined)}>Keep</button>
        </div>
      )}
    </div>
  );
}
