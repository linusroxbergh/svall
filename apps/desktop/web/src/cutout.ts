import type { Bridge, Rect } from './bridge.js';

// every overlay holding a hole in the surfaces, and whether the presses in it are the overlay's
const holders = new WeakMap<Bridge, Map<Element, boolean>>();

function send(bridge: Bridge): void {
  const rects: Rect[] = [], passive: Rect[] = [];
  for (const [el, presses] of holders.get(bridge) ?? []) {
    const r = el.getBoundingClientRect();
    // an overlay already taken off the page measures as nothing until its release lands
    if (r.width > 0 && r.height > 0) (presses ? rects : passive).push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  bridge.send({ type: 'shell.cutout', rects, passive });
}

/** The shell draws terminals and browser tabs above the page, so an overlay that lands on one is seen and
 * clicked only where the surfaces give its rect up. One that takes no presses leaves them to the surface.
 * Returns the call that hands the region back. */
export function holdCutout(bridge: Bridge, el: Element, presses = true, win: Window & typeof globalThis = window): () => void {
  const held = holders.get(bridge) ?? new Map<Element, boolean>();
  holders.set(bridge, held);
  held.set(el, presses);
  const update = () => send(bridge);
  update();
  const ro = new win.ResizeObserver(update);
  ro.observe(el);
  // an overlay anchored in its parent moves when the parent changes size, and one that eases in settles later
  if (el.parentElement) ro.observe(el.parentElement);
  // a button inside eases its own hover, and that bubbles up here too
  const settled = (e: Event) => { if (e.target === el) update(); };
  el.addEventListener('transitionend', settled);
  // the panel is anchored to a corner, so a window that changes size moves it without resizing it
  win.addEventListener('resize', update);
  return () => {
    ro.disconnect();
    el.removeEventListener('transitionend', settled);
    win.removeEventListener('resize', update);
    held.delete(el);
    update();
  };
}
