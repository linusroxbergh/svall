import { useEffect, useRef } from 'react';
import { app, deps } from '../boot.js';
import { commitFocused } from '../Field.js';
import { useHalfGrip } from '../halfGrip.js';
import { useApp } from '../hooks.js';
import { checkDisk } from '../ide/files.js';
import { flushDocs } from './autosave.js';
import { EditorPane } from './EditorPane.js';
import { Foot } from './Foot.js';
import { pointerPicked, shelfKey } from './keys.js';
import { List } from './List.js';
import { loadResources } from './load.js';
import { Split } from './Split.js';
import { Where } from './Where.js';

// the listing and the open files are read again; nothing under ~/.claude is watched
function refresh(): void {
  void loadResources(deps());
  for (const id of Object.keys(app.store.getState().ide)) if (id.startsWith('r:')) void checkDisk(deps(), id);
}

function Shelf({ tip }: { tip: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cols = useApp((s) => s.resourceCols);
  const size = useApp((s) => s.resourceSize);
  const full = useApp((s) => s.resourcesFull);
  const { resizing, grip } = useHalfGrip(() => app.store.getState().resourceSize, (v, persist) => app.store.getState().setResourceSize(v, persist),
    (g) => { const r = g.closest('.res-room')!.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  // centred in the room over mission control and sized as the terminal card is; full, it fills the room and points at the islet
  const { w, h } = full ? { w: 1, h: 1 } : size;
  useEffect(() => {
    refresh();
    // the shelf takes the keyboard as it opens, so the arrows walk it without a click first
    box.current?.focus();
    // a press on the map is where the user wants the keys; the islet's own presses open and close by
    // themselves, and a toast answers for what the shelf just did. the map's presses send no mousedown
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || t.closest?.('.res-islet, .res-pill, .res-open, .toast')) return;
      commitFocused();
      app.store.getState().toggleResources(false, { keepPageFocus: true });
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, []);
  return (
    <div className="res-room">
      <div className="res-shelf" ref={box} data-testid="resources-shelf" role="dialog" aria-label="Resources" tabIndex={-1}
        data-full={full} data-resizing={resizing}
        style={{ left: `${(1 - w) * 50}%`, top: `${(1 - h) * 50}%`, width: `${w * 100}%`, height: `${h * 100}%`,
          '--tip': `${tip}px`, '--rail': `${cols.rail}px`, '--list': `${cols.list}px` } as React.CSSProperties}
        onDoubleClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}
        onPointerDown={pointerPicked}
        onKeyDown={(e) => { if (box.current && shelfKey(e.nativeEvent, box.current)) e.preventDefault(); }}>
        <div className="res-in">
          <div className="res-panes">
            <Where />
            <Split col="rail" label="Resize the sources" />
            <List />
            <Split col="list" label="Resize the list" />
            <EditorPane onClose={() => app.store.getState().toggleResources(false)} />
          </div>
          <Foot onRefresh={refresh}>
            {!full && <i className="card-grip" data-testid="resources-grip" title="Drag to resize" {...grip} />}
          </Foot>
        </div>
      </div>
    </div>
  );
}

/** Always mounted, so a close is answered even though the shelf is gone: the surfaces then take the keyboard as they always do. */
export function ResourcesLayer({ tip }: { tip: number }) {
  const open = useApp((s) => s.resourcesOpen);
  useEffect(() => { if (!open) app.store.getState().pageFocusSettled(); }, [open]);
  // a doc waiting to be saved is written before the window goes out of sight
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') void flushDocs(); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  return open ? <Shelf tip={tip} /> : null;
}
