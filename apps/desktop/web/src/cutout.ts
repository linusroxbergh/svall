import type { Bridge } from './bridge.js';

/** The shell draws terminals and browser tabs above the page, so an overlay that lands on one is seen and
 * clicked only where the surfaces give their own rect up. Returns the call that hands the region back. */
export function holdCutout(bridge: Bridge, el: Element, win: Window & typeof globalThis = window): () => void {
  const send = () => {
    const r = el.getBoundingClientRect();
    bridge.send({ type: 'shell.cutout', rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  };
  send();
  const ro = new win.ResizeObserver(send);
  ro.observe(el);
  // the panel is anchored to a corner, so a window that changes size moves it without resizing it
  win.addEventListener('resize', send);
  return () => {
    ro.disconnect();
    win.removeEventListener('resize', send);
    bridge.send({ type: 'shell.cutout' });
  };
}
