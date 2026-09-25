export type TouchSurface = Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>;

/** The terminal a repaint scrolls back: enough of xterm to hold a reader's place. */
export type HeldTerm = {
  readonly buffer: { readonly active: { readonly baseY: number; readonly viewportY: number } };
  write(bytes: Uint8Array, done: () => void): void;
  reset(): void;
  scrollLines(n: number): void;
};

const FRICTION = 0.95; // of the speed kept per 16ms
const REST = 0.02; // px/ms under which a flick has stopped
const STALE = 80; // ms a finger may rest before lifting and still count as a flick
const SLOP = 5; // px a finger may drift and still be a tap

/** A finger's travel in pixels as whole lines, the remainder carried so a slow drag still adds up. */
export function lineSteps(lineHeight: number): (dy: number) => number {
  let carry = 0;
  const height = Math.max(1, lineHeight);
  return (dy) => {
    carry += dy / height;
    const lines = Math.trunc(carry);
    carry -= lines;
    return lines;
  };
}

/**
 * A repaint resets the terminal, which drops the viewport to the bottom, so the distance a reader had
 * scrolled back is measured first and re-applied once the repaint's own write has been parsed.
 */
export function holdScroll(term: HeldTerm): { write(bytes: Uint8Array): void; reset(): void } {
  let held = 0;
  return {
    write: (b) => { const back = held; held = 0; term.write(b, () => { if (back) term.scrollLines(-back); }); },
    reset: () => { held = term.buffer.active.baseY - term.buffer.active.viewportY; term.reset(); },
  };
}

/**
 * xterm scrolls on wheel events only, so a one-finger drag is turned into scrollLines here, and a flick
 * coasts to a stop. Dragging down moves back through the scrollback.
 */
export function dragToScroll(el: TouchSurface, scrollLines: (n: number) => void, lineHeight: () => number): () => void {
  let steps = lineSteps(lineHeight());
  let lastY = 0;
  let lastT = 0;
  let startY = 0;
  let velocity = 0;
  let frame = 0;
  let anchored = true;

  const travel = (dy: number) => { const n = steps(dy); if (n) scrollLines(-n); };
  const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; velocity = 0; };

  const start = (e: TouchEvent) => {
    stop();
    if (e.touches.length !== 1) { anchored = false; return; }
    steps = lineSteps(lineHeight());
    lastY = startY = e.touches[0].clientY;
    lastT = e.timeStamp;
    anchored = true;
  };
  const move = (e: TouchEvent) => {
    if (e.touches.length !== 1) { anchored = false; return; }
    const y = e.touches[0].clientY;
    if (!anchored) { anchored = true; lastY = y; lastT = e.timeStamp; return; }
    velocity = (y - lastY) / Math.max(1, e.timeStamp - lastT);
    travel(y - lastY);
    lastY = y;
    lastT = e.timeStamp;
    // a drift within SLOP is left alone so a tap still focuses the terminal
    if (Math.abs(y - startY) > SLOP) e.preventDefault();
  };
  const end = (e: TouchEvent) => {
    // a finger still down is the rest of the same gesture, not a flick to coast on
    if (e.touches.length) return;
    if (Math.abs(lastY - startY) <= SLOP || e.timeStamp - lastT > STALE) return;
    let then = performance.now();
    const coast = (now: number) => {
      const dt = now - then;
      then = now;
      velocity *= FRICTION ** (dt / 16);
      if (Math.abs(velocity) < REST) { frame = 0; return; }
      travel(velocity * dt);
      frame = requestAnimationFrame(coast);
    };
    frame = requestAnimationFrame(coast);
  };

  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', stop);
  return () => {
    stop();
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', stop);
  };
}
