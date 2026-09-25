import { useRef } from 'react';
import { app } from '../boot.js';

// a narrow map renders the column below its stored width, so a drag starts from what is on screen
const shownWidth = (grip: Element, col: 'rail' | 'list'): number => {
  const el = grip.previousElementSibling;
  const w = el ? parseFloat(getComputedStyle(el).width) : NaN;
  return Number.isFinite(w) ? w : app.store.getState().resourceCols[col];
};

/** The handle between two columns; the width follows the pointer and is written to storage on release. */
export function Split({ col, label }: { col: 'rail' | 'list'; label: string }) {
  const drag = useRef<{ x: number; from: number }>(undefined);
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    app.store.getState().setResourceCols(app.store.getState().resourceCols);
  };
  return (
    <i className="res-drag" data-testid={`resources-split-${col}`} role="separator" aria-orientation="vertical" aria-label={label} title="Drag to resize"
      onPointerDown={(e) => { drag.current = { x: e.clientX, from: shownWidth(e.currentTarget, col) }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.buttons === 0) return;
        const cols = app.store.getState().resourceCols;
        app.store.getState().setResourceCols({ ...cols, [col]: d.from + (e.clientX - d.x) }, false);
      }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
  );
}
