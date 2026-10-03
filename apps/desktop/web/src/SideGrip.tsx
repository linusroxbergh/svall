import { app } from './boot.js';
import { useWidthGrip } from './widthGrip.js';

const LABEL = { sidebar: 'Resize the islands', card: 'Resize the side card' };

/** The handle on a sidebar's inner edge; the width follows the pointer and is written to storage on release. */
export function SideGrip({ side }: { side: 'sidebar' | 'card' }) {
  const grip = useWidthGrip(() => app.store.getState().sideWidths[side], (from, dx) => {
    const widths = app.store.getState().sideWidths;
    // the card grows leftwards, away from the pointer's own direction
    app.store.getState().setSideWidths({ ...widths, [side]: from + dx * (side === 'sidebar' ? 1 : -1) }, false);
  }, () => app.store.getState().setSideWidths(app.store.getState().sideWidths));
  return <i className="side-drag" data-testid={`side-drag-${side}`} role="separator" aria-orientation="vertical" aria-label={LABEL[side]} title="Drag to resize" {...grip} />;
}
