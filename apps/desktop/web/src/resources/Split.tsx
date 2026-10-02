import { app } from '../boot.js';
import { useWidthGrip } from '../widthGrip.js';

// a narrow map renders the column below its stored width, so a drag starts from what is on screen
const shownWidth = (grip: Element, col: 'rail' | 'list'): number => {
  const el = grip.previousElementSibling;
  const w = el ? parseFloat(getComputedStyle(el).width) : NaN;
  return Number.isFinite(w) ? w : app.store.getState().resourceCols[col];
};

/** The handle between two columns; the width follows the pointer and is written to storage on release. */
export function Split({ col, label }: { col: 'rail' | 'list'; label: string }) {
  const grip = useWidthGrip((el) => shownWidth(el, col), (from, dx) => {
    const cols = app.store.getState().resourceCols;
    app.store.getState().setResourceCols({ ...cols, [col]: from + dx }, false);
  }, () => app.store.getState().setResourceCols(app.store.getState().resourceCols));
  return <i className="res-drag" data-testid={`resources-split-${col}`} role="separator" aria-orientation="vertical" aria-label={label} title="Drag to resize" {...grip} />;
}
