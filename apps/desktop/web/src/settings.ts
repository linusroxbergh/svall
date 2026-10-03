import { PUSH_STATUSES, type PushStatus } from '@svall/protocol';
import type { Bridge } from './bridge.js';
import { ACTIONS, LEGACY_BINDINGS, type ActionId, type Bindings } from './keys.js';

// macOS banners for a character that turns blocked or done
export type NotifySettings = { on: boolean; sound: boolean; statuses: PushStatus[] };

export type Settings = {
  // the half card floats over the map; the full card and the board fill the view
  cardOpacity: number;
  fullOpacity: number;
  zoom: number;
  // a fill button and ⌘⇧P in every browser tab, answered by the 1Password CLI
  onePassword: boolean;
  // the ◔ tab in the top right corner; the phone tab beside it follows whether the fleet is served
  usageTab: boolean;
  // arrange the fleet on its own once the map is in full view again, or the window has settled
  autoArrange: boolean;
  // only the chords the user changed; every other action keeps the one it ships with
  bindings: Bindings;
  // off until the user turns it on, since macOS asks too
  notifications: NotifySettings;
};

export const DEFAULT_SETTINGS: Settings = {
  cardOpacity: 0.65, fullOpacity: 1, zoom: 0.9, onePassword: false, usageTab: true, autoArrange: true, bindings: {},
  notifications: { on: false, sound: true, statuses: [...PUSH_STATUSES] },
};
export const OPACITY = { min: 0.3, max: 1, step: 0.05 };

// the fill is on offer only where the user asked for it and the shell found the CLI
export const canFill = (s: { settings: Settings; shell?: { op: boolean } }): boolean => s.settings.onePassword && !!s.shell?.op;

// the gap CSS leaves between a settings row and the tip that belongs to it
const TIP_GAP = 5;

export type Box = { top: number; bottom: number };

// a tip hangs under its row, and flips over it when the floor is nearer than the tip is tall;
// either way it is capped at the room on the side it lands on, so all of it stays in the panel
export function placeTip(row: Box, tipHeight: number, panel: Box): { above: boolean; maxHeight: number } {
  const under = panel.bottom - row.bottom - TIP_GAP;
  const over = row.top - panel.top - TIP_GAP;
  const above = over > 0 && tipHeight > under && over > under;
  return { above, maxHeight: Math.max(above ? over : under, 0) };
}

// the ladder the whole page climbs, as a browser's zoom does
export const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
// Ghostty's default font size: the point the terminal's text scales from
const BASE_FONT_PT = 13;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

// a zoom off the ladder — an older build's, or a hand-edited one — is read as the step nearest it
const nearest = (zoom: number): number => ZOOMS.reduce((a, b) => (Math.abs(b - zoom) < Math.abs(a - zoom) ? b : a));

export const zoomBy = (zoom: number, steps: number): number =>
  ZOOMS[clamp(ZOOMS.indexOf(nearest(zoom)) + steps, 0, ZOOMS.length - 1)];

// the terminal has no layout to reflow, so the page's factor reaches it as a font size in points
export const fontDelta = (zoom: number): number => Math.round((zoom - 1) * BASE_FONT_PT * 2) / 2;

// both sides build a chord from the key the user actually pressed, so the key itself can be anything
// that layout puts there; what has to match is the cmd/shift prefix neither side will look past
const CHORD = /^cmd\+(shift\+)?(enter|.)$/u;

function readBindings(v: unknown): Bindings {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const out: Bindings = {};
  for (const id of Object.keys(o)) {
    if (!(id in ACTIONS)) continue;
    const chord = o[id];
    if (chord === null) out[id as ActionId] = null;
    else if (typeof chord === 'string' && CHORD.test(chord)) out[id as ActionId] = chord;
  }
  return out;
}

function readNotify(v: unknown): NotifySettings {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const statuses = Array.isArray(o.statuses) ? PUSH_STATUSES.filter((s) => (o.statuses as unknown[]).includes(s)) : DEFAULT_SETTINGS.notifications.statuses;
  return { on: o.on === true, sound: o.sound !== false, statuses: [...statuses] };
}

export function readSettings(v: unknown): Settings {
  const stored = typeof v === 'object' && v !== null;
  const o = (stored ? v : {}) as Partial<Settings>;
  return {
    cardOpacity: num(o.cardOpacity, DEFAULT_SETTINGS.cardOpacity, OPACITY.min, OPACITY.max),
    fullOpacity: num(o.fullOpacity, DEFAULT_SETTINGS.fullOpacity, OPACITY.min, OPACITY.max),
    zoom: nearest(num(o.zoom, DEFAULT_SETTINGS.zoom, ZOOMS[0], ZOOMS[ZOOMS.length - 1])),
    onePassword: o.onePassword === true,
    usageTab: o.usageTab !== false,
    autoArrange: o.autoArrange !== false,
    // settings stored before the chords could be changed: that machine has been used, so it keeps the set it learned
    bindings: !stored || 'bindings' in o ? readBindings(o.bindings) : { ...LEGACY_BINDINGS },
    notifications: readNotify(o.notifications),
  };
}

// the shell zooms the page itself, so every rect the page sends is still in its own pixels;
// in a browser there is no shell to ask, and CSS carries the same factor
export function applyZoom(bridge: Bridge, zoom: number, root: { style: CSSStyleDeclaration } = document.documentElement): void {
  if (bridge.present) bridge.send({ type: 'zoom', factor: zoom, fontDelta: fontDelta(zoom) });
  else root.style.setProperty('zoom', zoom === 1 ? '' : String(zoom));
}
