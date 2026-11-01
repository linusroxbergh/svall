export type TouchSurface = Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>;

/** The terminal a repaint scrolls back: enough of xterm to hold a reader's place. */
export type HeldTerm = {
  readonly buffer: { readonly active: { readonly baseY: number; readonly viewportY: number } };
  write(data: Uint8Array | string, done?: () => void): void;
  scrollLines(n: number): void;
};

const FRICTION = 0.95; // of the speed kept per 16ms
const REST = 0.02; // px/ms under which a flick has stopped
const STALE = 80; // ms a finger may rest before lifting and still count as a flick
const SLOP = 5; // px a finger may drift and still be a tap
// ms a still finger takes to be a long press, short of the phone's own (~500ms)
const HOLD = 350;

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

/** A repaint resets the terminal to the bottom, so how far a reader had scrolled back is measured first
 *  and re-applied once the repaint's own write has been parsed. */
export function holdScroll(term: HeldTerm): { write(bytes: Uint8Array): void; reset(): void } {
  let held = 0;
  return {
    write: (b) => { const back = held; held = 0; term.write(b, () => { if (back) term.scrollLines(-back); }); },
    // ESC c rather than reset(), so output still queued ahead of the repaint is cleared with the rest
    reset: () => { held = term.buffer.active.baseY - term.buffer.active.viewportY; term.write('\x1bc'); },
  };
}

/** The terminal a drag scrolls: enough of xterm to tell its two screens apart and to wheel the app on one. */
export type DraggedTerm = {
  readonly element?: Pick<HTMLElement, 'getBoundingClientRect' | 'dispatchEvent'>;
  readonly buffer: { readonly active: { readonly type: 'normal' | 'alternate' } };
  readonly modes: { readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' };
  scrollLines(n: number): void;
};

// the mouse tracking xterm reports a wheel step in; without it, xterm types an arrow key for one
const WHEELED = ['vt200', 'drag', 'any'];

/** On the alternate screen the app keeps the scrollback, so each line goes to it as a wheel step, as a desktop
 *  terminal hands it the wheel; an app that takes no wheel gets nothing. */
export function scrollTerm(term: DraggedTerm, n: number): void {
  const el = term.element;
  if (term.buffer.active.type !== 'alternate' || !el) { term.scrollLines(n); return; }
  if (!WHEELED.includes(term.modes.mouseTrackingMode)) return;
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (let i = 0; i < Math.abs(n); i++) {
    el.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: Math.sign(n), deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true }));
  }
}

/** A tap reaches xterm as a click, which a mouse-tracking app such as a Claude Code dialog acts on, so of the SGR
 *  mouse reports only wheel steps go through: buttons 64–67, plus the modifier bits 4, 8 and 16. */
export function withoutClicks(data: string): string {
  return data.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (report, button: string) => ((Number(button) & ~31) === 64 ? report : ''));
}

/** One finger resting in place past HOLD calls held; a drift past SLOP, a lift or a second finger calls it off. */
export function onHold(el: TouchSurface, held: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let x = 0;
  let y = 0;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const start = (e: TouchEvent) => {
    cancel();
    if (e.touches.length !== 1) return;
    x = e.touches[0].clientX;
    y = e.touches[0].clientY;
    timer = setTimeout(() => { timer = undefined; held(); }, HOLD);
  };
  const move = (e: TouchEvent) => {
    const t = e.touches[0];
    if (e.touches.length !== 1 || Math.hypot(t.clientX - x, t.clientY - y) > SLOP) cancel();
  };

  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  return () => {
    cancel();
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', cancel);
    el.removeEventListener('touchcancel', cancel);
  };
}

/** xterm scrolls on wheel events only, so a one-finger drag becomes scrollLines and a flick coasts to a stop. */
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
