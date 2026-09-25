import { useRef } from 'react';
import { app } from './boot.js';

const LABEL = { sidebar: 'Resize the islands', card: 'Resize the side card' };

/** The handle on a sidebar's inner edge; the width follows the pointer and is written to storage on release. */
export function SideGrip({ side }: { side: 'sidebar' | 'card' }) {
  const drag = useRef<{ x: number; from: number }>(undefined);
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    app.store.getState().setSideWidths(app.store.getState().sideWidths);
  };
  return (
    <i className="side-drag" data-testid={`side-drag-${side}`} role="separator" aria-orientation="vertical" aria-label={LABEL[side]} title="Drag to resize"
      onPointerDown={(e) => { drag.current = { x: e.clientX, from: app.store.getState().sideWidths[side] }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.buttons === 0) return;
        const widths = app.store.getState().sideWidths;
        // the card grows leftwards, away from the pointer's own direction
        const by = (e.clientX - d.x) * (side === 'sidebar' ? 1 : -1);
        app.store.getState().setSideWidths({ ...widths, [side]: d.from + by }, false);
      }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
  );
}
