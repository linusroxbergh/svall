import { useRef, useState } from 'react';
import type { Size } from '@svall/protocol';
import { halfCardBy } from './map/card.js';
import type { HalfCard } from './store/index.js';

/** The grip on a centred panel's bottom-right corner: the size follows the pointer and is written to storage once, on release. */
export function useHalfGrip(get: () => HalfCard, set: (size: HalfCard, persist?: boolean) => void, room: (grip: Element) => Size) {
  // the drag measures pointer travel from where it started, so it never reads the easing panel's box
  const drag = useRef<{ x: number; y: number; from: HalfCard; room: Size }>(undefined);
  const [resizing, setResizing] = useState(false);
  // the panel only leaves its size with the grip released, so a drag that outlives its grip ends here
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    setResizing(false);
    set(get());
  };
  const grip = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.stopPropagation();
      drag.current = { x: e.clientX, y: e.clientY, from: get(), room: room(e.currentTarget) };
      setResizing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.buttons === 0) return;
      set(halfCardBy(d.from, { x: e.clientX - d.x, y: e.clientY - d.y }, d.room), false);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
  return { resizing, grip };
}
