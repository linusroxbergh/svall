import { useRef } from 'react';

/** A handle that drags a width: `move` gets the width the press started from and how far the pointer has gone, and `persist` runs once, on release. */
export function useWidthGrip(from: (grip: HTMLElement) => number, move: (from: number, dx: number) => void, persist: () => void) {
  const drag = useRef<{ x: number; from: number }>(undefined);
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    persist();
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => { drag.current = { x: e.clientX, from: from(e.currentTarget) }; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.buttons === 0) return;
      move(d.from, e.clientX - d.x);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
}
