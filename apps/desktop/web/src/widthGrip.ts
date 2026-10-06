import { useRef } from 'react';

/** A handle that drags a width, or a height along y: `move` gets the size the press started from and how far the pointer has gone, and `persist` runs once, on release. */
export function useWidthGrip(from: (grip: HTMLElement) => number, move: (from: number, dx: number) => void, persist: () => void, axis: 'x' | 'y' = 'x') {
  const at = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);
  const drag = useRef<{ x: number; from: number }>(undefined);
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    persist();
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => { drag.current = { x: at(e), from: from(e.currentTarget) }; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.buttons === 0) return;
      move(d.from, at(e) - d.x);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
}
