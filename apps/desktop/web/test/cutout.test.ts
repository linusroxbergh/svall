import { describe, expect, it } from 'vitest';
import type { Bridge, ToShell } from '../src/bridge.js';
import { holdCutout } from '../src/cutout.js';

function fakes(box = { left: 900, top: 38, width: 330, height: 220 }) {
  const sent: ToShell[] = [];
  const bridge: Bridge = { present: true, send: (m) => { sent.push(m); }, onMessage: () => () => {} };
  const el = { getBoundingClientRect: () => box } as unknown as Element;
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
  return { sent, bridge, el, observed, listeners, box, resize: () => resized?.(), isDisconnected: () => disconnected, win };
}

describe('holdCutout', () => {
  it('gives the shell the rect at once, and again whenever the panel or the window changes size', () => {
    const f = fakes();
    const release = holdCutout(f.bridge, f.el, f.win);
    expect(f.sent).toEqual([{ type: 'shell.cutout', rect: { x: 900, y: 38, width: 330, height: 220 } }]);
    expect(f.observed).toEqual([f.el]);

    f.box.height = 260;
    f.resize();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rect: { x: 900, y: 38, width: 330, height: 260 } });

    // the panel is anchored to a corner: a narrower window moves it without resizing it
    f.box.left = 700;
    f.listeners.get('resize')!(new Event('resize'));
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout', rect: { x: 700, y: 38, width: 330, height: 260 } });

    release();
  });

  it('hands the region back on release and stops watching', () => {
    const f = fakes();
    const release = holdCutout(f.bridge, f.el, f.win);
    release();
    expect(f.sent.at(-1)).toEqual({ type: 'shell.cutout' });
    expect(f.isDisconnected()).toBe(true);
    expect(f.listeners.has('resize')).toBe(false);
  });
});
