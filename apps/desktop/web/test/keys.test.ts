import { describe, expect, it } from 'vitest';
import { ACTIONS, chordFor, chordOf, declineTaken, holderOf, keyTip, LEGACY_BINDINGS, resolve } from '../src/keys.js';

const ev = (key: string, o: Partial<{ metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key, metaKey: true, shiftKey: false, ctrlKey: false, altKey: false, ...o });

describe('keys', () => {
  it('binds the spec chords', () => {
    const b = resolve();
    expect(b['cmd+t']).toEqual({ type: 'newCharacter' });
    expect(b['cmd+w']).toEqual({ type: 'closeCharacter' });
    expect(b['cmd+k']).toEqual({ type: 'prevCharacter' });
    expect(b['cmd+j']).toEqual({ type: 'nextCharacter' });
    expect(b['cmd+m']).toEqual({ type: 'toggleView' });
    expect(b['cmd+i']).toEqual({ type: 'toggleSideCard' });
    expect(b['cmd+shift+j']).toEqual({ type: 'nextIsland' });
    expect(b['cmd+q']).toEqual({ type: 'none' });
    expect(b['cmd+1']).toEqual({ type: 'showPane', pane: 'terminal' });
    expect(b['cmd+2']).toEqual({ type: 'showPane', pane: 'browser' });
    expect(b['cmd+b']).toEqual({ type: 'toggleBrowser' });
    expect(b['cmd+l']).toEqual({ type: 'focusAddress' });
    expect(b['cmd+g']).toEqual({ type: 'missionControl' });
    expect(b['cmd+,']).toEqual({ type: 'toggleSettings' });
    expect(b['cmd+shift+r']).toEqual({ type: 'toggleResources' });
    expect(b['cmd+shift+a']).toEqual({ type: 'arrange' });
    expect(b['cmd+u']).toEqual({ type: 'openLink' });
    expect(b['cmd+-']).toEqual({ type: 'zoom', steps: -1 });
    expect(b['cmd+0']).toEqual({ type: 'zoom', steps: 0 });
    expect(b['cmd+3']).toEqual({ type: 'showPane', pane: 'files' });
    expect(b['cmd+4']).toEqual({ type: 'showPane', pane: 'changes' });
    expect(b['cmd+enter']).toEqual({ type: 'toggleCardSize' });
    expect(b['cmd+o']).toBeUndefined();
    expect(b['cmd+s']).toBeUndefined();
    expect(b['cmd+f']).toBeUndefined();
  });
  it('keeps the shipped chords to letters and digits, which every Latin layout types unmodified', () => {
    for (const spec of Object.values(ACTIONS)) {
      for (const c of [spec.chord, ...(spec.also ?? [])]) expect(c).toMatch(/^cmd\+(shift\+)?([a-z0-9,=+-]|enter)$/);
    }
  });
  it('ships no chord twice, so no action is quietly overwritten by a later one', () => {
    const claimed = Object.values(ACTIONS).flatMap((s) => [s.chord, ...(s.also ?? [])]);
    expect(Object.keys(resolve())).toHaveLength(claimed.length);
  });
  it('zooms in from the = key and the + key alike, whichever the layout puts first', () => {
    const b = resolve();
    expect(b[chordOf(ev('='))!]).toEqual({ type: 'zoom', steps: 1 });
    expect(b[chordOf(ev('+'))!]).toEqual({ type: 'zoom', steps: 1 });
    expect(b[chordOf(ev('+', { shiftKey: true }))!]).toEqual({ type: 'zoom', steps: 1 });
  });
  it('builds chords from keyboard events', () => {
    expect(chordOf(ev('t'))).toBe('cmd+t');
    expect(chordOf(ev('Q', { shiftKey: true }))).toBe('cmd+shift+q');
    expect(chordOf(ev('1'))).toBe('cmd+1');
    expect(chordOf(ev('t', { metaKey: false }))).toBeUndefined();
    expect(chordOf(ev('t', { ctrlKey: true }))).toBeUndefined();
    expect(chordOf(ev('Escape'))).toBeUndefined();
  });
  it('maps Cmd+Enter to cmd+enter and nothing else with a long key name', () => {
    expect(chordOf({ key: 'Enter', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false })).toBe('cmd+enter');
    expect(chordOf({ key: 'ArrowUp', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false })).toBeUndefined();
  });
});

describe('overrides', () => {
  it('puts an action on the chord the user chose, and off the one it shipped with', () => {
    const b = resolve({ newCharacter: 'cmd+n' });
    expect(b['cmd+n']).toEqual({ type: 'newCharacter' });
    expect(b['cmd+t']).toBeUndefined();
    expect(chordFor('newCharacter', { newCharacter: 'cmd+n' })).toBe('cmd+n');
  });
  it('leaves an action unbound when its chord is declined', () => {
    const b = resolve({ quit: null });
    expect(b['cmd+q']).toBeUndefined();
    expect(chordFor('quit', { quit: null })).toBeNull();
    // the rest keep theirs
    expect(b['cmd+t']).toEqual({ type: 'newCharacter' });
  });
  it('carries the layout aliases only while the action sits on its shipped chord', () => {
    expect(resolve()['cmd+shift++']).toEqual({ type: 'zoom', steps: 1 });
    const moved = resolve({ zoomIn: 'cmd+y' });
    expect(moved['cmd+y']).toEqual({ type: 'zoom', steps: 1 });
    expect(moved['cmd++']).toBeUndefined();
    expect(moved['cmd+shift++']).toBeUndefined();
  });
  it('names the action holding a chord, so an override can say what it takes it from', () => {
    expect(holderOf('cmd+t')).toBe('newCharacter');
    expect(holderOf('cmd+n')).toBeUndefined();
    expect(holderOf('cmd+t', { newCharacter: 'cmd+n' })).toBeUndefined();
    expect(holderOf('cmd+n', { newCharacter: 'cmd+n' })).toBe('newCharacter');
    // a layout alias answers the key too, so the action carrying it is what an override takes it from
    expect(holderOf('cmd++')).toBe('zoomIn');
    expect(holderOf('cmd++', { zoomIn: 'cmd+y' })).toBeUndefined();
  });
  it('lets a chosen chord keep a key a layout alias would otherwise answer', () => {
    const b = resolve({ newCharacter: 'cmd++' });
    expect(b['cmd++']).toEqual({ type: 'newCharacter' });
    // zooming keeps the chord it answers to by name, and its other alias
    expect(b['cmd+=']).toEqual({ type: 'zoom', steps: 1 });
    expect(b['cmd+shift++']).toEqual({ type: 'zoom', steps: 1 });
  });
  it('leaves alone the chords the user spends in their own Ghostty config', () => {
    const b = declineTaken({ 'cmd+t': 'new_split:right', 'cmd+z': 'text:hi' });
    expect(b.newCharacter).toBeNull();
    expect(resolve(b)['cmd+t']).toBeUndefined();
    // untouched actions are not written down at all, so they follow the shipped set as it changes
    expect('quit' in b).toBe(false);
    expect(resolve(b)['cmd+q']).toEqual({ type: 'none' });
  });
  it('counts a chord an action only answers to as an alias as one the user spends', () => {
    const b = declineTaken({ 'cmd++': 'increase_font_size' });
    expect(b.zoomIn).toBeNull();
    expect(resolve(b)['cmd++']).toBeUndefined();
    expect(resolve(b)['cmd+=']).toBeUndefined();
  });
  it('measures collisions against the chord in force, not the one shipped', () => {
    expect(declineTaken({ 'cmd+t': 'x' }, { newCharacter: 'cmd+n' }).newCharacter).toBe('cmd+n');
    expect(declineTaken({ 'cmd+n': 'x' }, { newCharacter: 'cmd+n' }).newCharacter).toBeNull();
  });
  it('keeps the chords an older install learned, so an upgrade moves nothing', () => {
    const b = resolve(LEGACY_BINDINGS);
    expect(b['cmd+q']).toEqual({ type: 'prevCharacter' });
    expect(b['cmd+e']).toEqual({ type: 'nextCharacter' });
    expect(b['cmd+d']).toEqual({ type: 'nextIsland' });
    expect(b['cmd+shift+q']).toEqual({ type: 'none' });
    expect(b['cmd+j']).toBeUndefined();
    expect(b['cmd+k']).toBeUndefined();
  });
});

describe('keyTip', () => {
  it('names the key an action answers to now, and none once it is unbound', () => {
    expect(keyTip('Settings', 'toggleSettings')).toBe('Settings (⌘,)');
    expect(keyTip('Settings', 'toggleSettings', { toggleSettings: 'cmd+shift+o' })).toBe('Settings (⌘⇧O)');
    expect(keyTip('Settings', 'toggleSettings', { toggleSettings: null })).toBe('Settings');
  });
});
