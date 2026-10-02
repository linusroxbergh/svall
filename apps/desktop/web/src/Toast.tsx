import { useEffect, useRef } from 'react';
import { app } from './boot.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { theme } from './theme.js';

const CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const;
type Corner = (typeof CORNERS)[number];
// the toast takes the first corner the open card leaves free
export function toastCorner(card: { x: number; y: number; width: number; height: number } | undefined, host: { w: number; h: number }): Corner {
  if (!card) return 'bottom-left';
  const m = theme.card.margin;
  const free = (c: Corner) => {
    const x = c.endsWith('left') ? m : host.w - m;
    const y = c.startsWith('top') ? m : host.h - m;
    return x < card.x || x > card.x + card.width || y < card.y || y > card.y + card.height;
  };
  return CORNERS.find(free) ?? 'bottom-left';
}

// a toast can land on a terminal or a browser tab, which the shell draws above the page, so it takes a hole in them;
// one with nothing to press leaves the presses in that hole to the surface
export function Toast({ corner = 'bottom-left' }: { corner?: Corner }) {
  const toast = useApp((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  const shown = Boolean(toast);
  const presses = Boolean(toast?.action);
  useEffect(() => (shown && ref.current ? holdCutout(app.bridge, ref.current, presses) : undefined), [shown, presses, corner]);
  if (!toast) return null;
  return (
    <div ref={ref} className="toast" data-testid="toast" data-tone={toast.tone} data-corner={corner}>
      {toast.text}{toast.action && <button className="toast-act" data-testid="toast-action" onClick={() => app.store.getState().runToastAction()}>{toast.action.label}</button>}
    </div>
  );
}
