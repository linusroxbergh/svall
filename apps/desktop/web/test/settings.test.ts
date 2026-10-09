import { describe, expect, it } from 'vitest';
import type { Bridge, ToShell } from '../src/bridge.js';
import { applyZoom, DEFAULT_SETTINGS, fontDelta, placeTip, readSettings, ZOOMS, zoomBy } from '../src/settings.js';

const bridge = (present: boolean): Bridge & { sent: ToShell[] } => {
  const sent: ToShell[] = [];
  return { present, sent, send: (m) => { sent.push(m); }, onMessage: () => () => {} };
};

describe('settings', () => {
  it('steps the zoom along the ladder and stops at its ends', () => {
    expect(zoomBy(1, 1)).toBe(1.1);
    expect(zoomBy(1, -1)).toBe(0.9);
    expect(zoomBy(1, 2)).toBe(1.25);
    expect(zoomBy(ZOOMS[ZOOMS.length - 1], 1)).toBe(ZOOMS[ZOOMS.length - 1]);
    expect(zoomBy(ZOOMS[0], -1)).toBe(ZOOMS[0]);
  });
  it('steps from the nearest rung when the zoom is off the ladder', () => {
    expect(zoomBy(1.07, 1)).toBe(1.25);
    expect(zoomBy(3, -1)).toBe(1.25);
  });
  it('scales the terminal font with the page, in half points', () => {
    expect(fontDelta(1)).toBe(0);
    expect(fontDelta(1.25)).toBe(3.5);
    expect(fontDelta(0.8)).toBe(-2.5);
  });
  it('reads stored settings back, and falls back to the defaults', () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ cardOpacity: 0.5, fullOpacity: 0.9, zoom: 1.1, onePassword: true, usageTab: false, autoArrange: false, bindings: {} }))
      .toEqual({ cardOpacity: 0.5, fullOpacity: 0.9, zoom: 1.1, onePassword: true, usageTab: false, autoArrange: false, cardLinks: false, bindings: {}, notifications: DEFAULT_SETTINGS.notifications });
    // out of range, the wrong type, or off the ladder
    expect(readSettings({ cardOpacity: 4, fullOpacity: 'x', zoom: 1.12, onePassword: 'yes', bindings: {} }))
      .toEqual({ cardOpacity: 1, fullOpacity: 1, zoom: 1.1, onePassword: false, usageTab: true, autoArrange: true, cardLinks: false, bindings: {}, notifications: DEFAULT_SETTINGS.notifications });
  });
  it('starts a fresh install at 90% and keeps a stored zoom of 100%', () => {
    expect(readSettings(undefined).zoom).toBe(0.9);
    expect(readSettings({ zoom: 1 }).zoom).toBe(1);
  });
  it('arranges on its own until the machine says otherwise', () => {
    expect(DEFAULT_SETTINGS.autoArrange).toBe(true);
    expect(readSettings({ zoom: 1.1 }).autoArrange).toBe(true);
    expect(readSettings({ autoArrange: false }).autoArrange).toBe(false);
  });
  it('hides the links on the cards until the machine shows them', () => {
    expect(DEFAULT_SETTINGS.cardLinks).toBe(false);
    expect(readSettings({ cardLinks: 'yes' }).cardLinks).toBe(false);
    expect(readSettings({ cardLinks: true }).cardLinks).toBe(true);
  });
  it('keeps notifications off until the machine turns them on, and reads back only what it can post', () => {
    expect(DEFAULT_SETTINGS.notifications).toEqual({ on: false, sound: true, statuses: ['blocked', 'done'] });
    expect(readSettings({ zoom: 1.1 }).notifications).toEqual(DEFAULT_SETTINGS.notifications);
    expect(readSettings({ notifications: { on: true, sound: false, statuses: ['done'] } }).notifications)
      .toEqual({ on: true, sound: false, statuses: ['done'] });
    // a truthy non-boolean is not on, and a status the app never posts is dropped
    expect(readSettings({ notifications: { on: 'yes', sound: 0, statuses: ['idle', 'blocked', 7] } }).notifications)
      .toEqual({ on: false, sound: true, statuses: ['blocked'] });
    // none chosen stays none
    expect(readSettings({ notifications: { on: true, statuses: [] } }).notifications.statuses).toEqual([]);
    expect(readSettings({ notifications: 'on' }).notifications).toEqual(DEFAULT_SETTINGS.notifications);
  });
  it('gives settings with no bindings of their own the shipped chords', () => {
    expect(readSettings(undefined).bindings).toEqual({});
    expect(readSettings({ zoom: 1.1 }).bindings).toEqual({});
  });
  it('keeps only bindings it can act on', () => {
    const b = readSettings({
      bindings: {
        newCharacter: 'cmd+n',
        quit: null,
        prevCharacter: 'ctrl+p',
        nextCharacter: 'cmd+shift+',
        nextIsland: 42,
        notAnAction: 'cmd+z',
      },
    }).bindings;
    expect(b).toEqual({ newCharacter: 'cmd+n', quit: null });
  });
  it('accepts any key the two sides agree on, not only the ones we ship', () => {
    const b = readSettings({ bindings: { newCharacter: 'cmd+shift+}', nextIsland: 'cmd+ö', quit: 'cmd+enter' } }).bindings;
    expect(b).toEqual({ newCharacter: 'cmd+shift+}', nextIsland: 'cmd+ö', quit: 'cmd+enter' });
  });
  it('hangs an info tip under its row while the panel has room for it', () => {
    const panel = { top: 0, bottom: 800 };
    expect(placeTip({ top: 100, bottom: 120 }, 60, panel)).toEqual({ above: false, maxHeight: 675 });
  });
  it('flips the tip of a row at the foot of the panel over it', () => {
    const panel = { top: 0, bottom: 800 };
    // 780 leaves 15px under the row and 755 over it
    expect(placeTip({ top: 760, bottom: 780 }, 60, panel)).toEqual({ above: true, maxHeight: 755 });
    // a tip that still fits under the last row stays under it
    expect(placeTip({ top: 760, bottom: 780 }, 12, panel)).toEqual({ above: false, maxHeight: 15 });
  });
  it('caps the tip at the room on the side it lands on, and never below nothing', () => {
    // a row taller than the panel it is scrolled in leaves no room either way
    expect(placeTip({ top: -40, bottom: 900 }, 60, { top: 0, bottom: 800 })).toEqual({ above: false, maxHeight: 0 });
    // the top row of a scrolled panel has nothing over it, so a tall tip stays under it
    expect(placeTip({ top: 0, bottom: 20 }, 900, { top: 0, bottom: 800 })).toEqual({ above: false, maxHeight: 775 });
  });
  it('hands the zoom to the shell, and to CSS when there is none', () => {
    const shell = bridge(true);
    applyZoom(shell, 1.25, { style: {} as CSSStyleDeclaration });
    expect(shell.sent).toEqual([{ type: 'zoom', factor: 1.25, fontDelta: 3.5 }]);

    const props: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => { props[k] = v; } } as unknown as CSSStyleDeclaration };
    const web = bridge(false);
    applyZoom(web, 1.25, root);
    expect(web.sent).toEqual([]);
    expect(props.zoom).toBe('1.25');
    applyZoom(web, 1, root);
    expect(props.zoom).toBe('');
  });
});
