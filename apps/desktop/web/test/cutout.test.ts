import { describe, expect, it } from 'vitest';
import type { Bridge, ToShell } from '../src/bridge.js';
import { holdCutout } from '../src/cutout.js';

type Box = { left: number; top: number; width: number; height: number };

// an overlay in the page: its box, the parent it is anchored in, and the listeners it holds
function overlay(box: Box) {
  const listeners = new Map<string, EventListener>();
  const parent = {} as Element;
  const el = {
    getBoundingClientRect: () => box,
    parentElement: parent,
    addEventListener: (type: string, h: EventListener) => listeners.set(type, h),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Element;
  return { el, parent, box, listeners };
}

function fakes(box = { left: 900, top: 38, width: 330, height: 220 }) {
  const sent: ToShell[] = [];
  const bridge: Bridge = { present: true, send: (m) => { sent.push(m); }, onMessage: () => () => {} };
  const panel = overlay(box);
  const observed: Element[] = [];
  let resized: (() => void) | undefined;
  let disconnected = false;
  const listeners = new Map<string, EventListener>();
  const win = {
    ResizeObserver: class {
      constructor(cb: () => void) { resized = cb; }
      observe(target: Element) { observed.push(target); }
      disconnect() { disconnected = true; }
    },
    addEventListener: (type: string, h: EventListener) => listeners.set(type, h),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Window & typeof globalThis;
  return { sent, bridge, el: panel.el, panel, observed, listeners, box, resize: () => resized?.(), isDisconnected: () => disconnected, win };
}

describe('holdCutout', () => {
  it('gives the shell the rect at once, and again whenever the panel, its parent or the window changes size', () => {
    const f = fakes();
    const release = holdCutout(f.bridge, f.el, true, f.win);
    expect(f.sent).toEqual([{ type: 'shell.cutout', rects: [{ x: 900, y: 38, width: 330, height: 220 }], passive: [] }]);
    expect(f.observed).toEqual([f.el, f.panel.parent]);

    f.box.height = 260;
    f.resize();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 900, y: 38, width: 330, height: 260 }], passive: [] });

    // the panel is anchored to a corner: a narrower window moves it without resizing it
    f.box.left = 700;
    f.listeners.get('resize')!(new Event('resize'));
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 700, y: 38, width: 330, height: 260 }], passive: [] });

    release();
  });

  it('measures again once the overlay has eased in, but not for a button easing inside it', () => {
    const f = fakes();
    const release = holdCutout(f.bridge, f.el, true, f.win);
    const settled = f.panel.listeners.get('transitionend')!;
    f.box.top = 30;
    settled({ target: {} } as unknown as Event);
    expect(f.sent).toHaveLength(1);
    settled({ target: f.el } as unknown as Event);
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 900, y: 30, width: 330, height: 220 }], passive: [] });
    release();
    expect(f.panel.listeners.has('transitionend')).toBe(false);
  });

  it('hands the region back on release and stops watching', () => {
    const f = fakes();
    const release = holdCutout(f.bridge, f.el, true, f.win);
    release();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
    expect(f.isDisconnected()).toBe(true);
    expect(f.listeners.has('resize')).toBe(false);
  });

  it('hands the shell a rect for every overlay holding one, and the rest once one lets go', () => {
    const f = fakes();
    const toast = overlay({ left: 300, top: 700, width: 200, height: 40 });
    const releasePanel = holdCutout(f.bridge, f.el, true, f.win);
    const releaseToast = holdCutout(f.bridge, toast.el, true, f.win);
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 900, y: 38, width: 330, height: 220 }, { x: 300, y: 700, width: 200, height: 40 }], passive: [] });
    releasePanel();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 300, y: 700, width: 200, height: 40 }], passive: [] });
    releaseToast();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
  });

  it('marks the rect of an overlay that takes no presses, so the surface keeps them', () => {
    const f = fakes();
    const toast = overlay({ left: 300, top: 700, width: 200, height: 40 });
    const releasePanel = holdCutout(f.bridge, f.el, true, f.win);
    const releaseToast = holdCutout(f.bridge, toast.el, false, f.win);
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [{ x: 900, y: 38, width: 330, height: 220 }], passive: [{ x: 300, y: 700, width: 200, height: 40 }] });
    releaseToast();
    releasePanel();
  });

  it('leaves out an overlay already off the page, which measures as nothing', () => {
    const f = fakes();
    const release = holdCutout(f.bridge, f.el, true, f.win);
    f.box.width = 0;
    f.box.height = 0;
    f.resize();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
    release();
  });
});
