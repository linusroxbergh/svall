import { describe, expect, it, vi } from 'vitest';
import { emptyState, type ContextItem } from '@svall/protocol';
import type { Api } from '../src/api.js';
import type { Bridge, FromShell, ToShell } from '../src/bridge.js';
import type { BrowserManager } from '../src/browser.js';
import { closeCharacter, dispatchKey, installKeyHandlers } from '../src/keyboard.js';
import { panesOf } from '../src/selectors.js';
import { createAppStore } from '../src/store/index.js';
import { chr, fleet, isl } from './fixtures.js';

function ctx(present = false) {
  const calls: { method: string; params: unknown }[] = [];
  const sent: ToShell[] = [];
  const handlers = new Set<(m: FromShell) => void>();
  const api = {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'island.create') return Promise.resolve(isl('i_new', 'home', 0));
      if (method === 'char.create') return Promise.resolve(chr('c_new', (params as { islandId: string }).islandId, { x: 9, y: 0 }));
      return Promise.resolve({});
    },
  } as unknown as Api;
  const bridge: Bridge & { emit(m: FromShell): void } = {
    present, send: (m) => { sent.push(m); },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    emit: (m) => { for (const h of handlers) h(m); },
  };
  const store = createAppStore(undefined);
  store.getState().setFleet(fleet());
  return { calls, sent, api, bridge, store };
}

describe('dispatchKey', () => {
  it('Cmd+T asks for a name instead of creating straight away', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().select('c1');
    await dispatchKey({ type: 'newCharacter' }, c);
    expect(c.store.getState().namingCharacter).toBe(true);
    expect(c.calls).toEqual([]);
  });
  it('Cmd+G opens the mission control prompt instead of creating anything', async () => {
    const c = ctx();
    await dispatchKey({ type: 'missionControl' }, c);
    expect(c.store.getState().missionPrompt).toBe(true);
    expect(c.calls).toEqual([]);
  });
  it('Cmd+Shift+O opens the fleet picker over the other dialogs, and the next dialog takes it down', async () => {
    const c = ctx();
    c.store.getState().setMissionPrompt(true);
    await dispatchKey({ type: 'openFleets' }, c);
    expect(c.store.getState()).toMatchObject({ fleetPicker: 'menu', missionPrompt: false });
    await dispatchKey({ type: 'newCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ fleetPicker: undefined, namingCharacter: true });
  });
  it('Cmd+W asks before closing the selected character, and takes the other dialogs down', async () => {
    const c = ctx();
    c.store.getState().select('c0');
    c.store.getState().setMissionPrompt(true);
    c.store.getState().toggleKeys(true);
    await dispatchKey({ type: 'closeCharacter' }, c);
    expect(c.calls).toEqual([]);
    expect(c.store.getState()).toMatchObject({ closingCharacter: 'c0', missionPrompt: false, keysOpen: false, selectedId: 'c0' });
    await dispatchKey({ type: 'newCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ closingCharacter: undefined, namingCharacter: true });
  });
  it('a confirmed close moves on to the next character', async () => {
    const c = ctx();
    c.store.getState().select('c0');
    await closeCharacter(c, 'c0');
    expect(c.calls).toEqual([{ method: 'char.close', params: { id: 'c0' } }]);
    expect(c.store.getState().selectedId).toBe('c1');
  });
  it('closing a character other than the current one stays where it is, on the map and on the board', async () => {
    const c = ctx();
    c.store.getState().select('c2');
    await closeCharacter(c, 'c0');
    expect(c.store.getState().selectedId).toBe('c2');
    c.store.getState().focus('c2');
    c.store.getState().setView('board');
    await closeCharacter(c, 'c1');
    expect(c.store.getState()).toMatchObject({ view: 'board', selectedId: 'c2', focusedId: 'c2' });
    expect(c.calls).toEqual([{ method: 'char.close', params: { id: 'c0' } }, { method: 'char.close', params: { id: 'c1' } }]);
  });
  it('Cmd+W on the board asks about the viewed character; confirmed, the board selects the next', async () => {
    const c = ctx();
    c.store.getState().focus('c0');
    c.store.getState().setView('board');
    await dispatchKey({ type: 'closeCharacter' }, c);
    expect(c.store.getState().closingCharacter).toBe('c0');
    await closeCharacter(c, 'c0');
    expect(c.calls).toEqual([{ method: 'char.close', params: { id: 'c0' } }]);
    expect(c.store.getState()).toMatchObject({ view: 'board', selectedId: 'c1', sideCardOpen: true });
  });
  it('a second Cmd+W deletes the character the dialog asks about', async () => {
    const c = ctx();
    c.store.getState().select('c0');
    await dispatchKey({ type: 'closeCharacter' }, c);
    c.store.getState().select('c2');
    await dispatchKey({ type: 'closeCharacter' }, c);
    expect(c.calls).toEqual([{ method: 'char.close', params: { id: 'c0' } }]);
    expect(c.store.getState().closingCharacter).toBeUndefined();
  });
  it('a delete confirmed by a second Cmd+W that svalld refuses says so', async () => {
    const c = ctx();
    c.api.call = () => Promise.reject(new Error('svalld offline'));
    c.store.getState().select('c0');
    await dispatchKey({ type: 'closeCharacter' }, c);
    await dispatchKey({ type: 'closeCharacter' }, c);
    expect(c.store.getState().toast?.text).toBe('svalld offline');
  });
  it('a character that vanishes takes its pending close with it', () => {
    const c = ctx();
    c.store.getState().setClosingCharacter('c0');
    c.store.getState().applyPatch([{ op: 'remove', path: '/characters/c0' }]);
    expect(c.store.getState().closingCharacter).toBeUndefined();
  });
  it('on the board the navigation chords move the selection and stay on the board', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    await dispatchKey({ type: 'nextCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'board', selectedId: 'c0', sideCardOpen: true });
    await dispatchKey({ type: 'nextIsland' }, c);
    expect(c.store.getState().selectedId).toBe('c2');
    await dispatchKey({ type: 'nextCharacter' }, c);
    expect(c.store.getState().selectedId).toBe('c0');
    await dispatchKey({ type: 'prevCharacter' }, c);
    await dispatchKey({ type: 'prevCharacter' }, c);
    expect(c.store.getState().selectedId).toBe('c1');
    expect(c.store.getState().view).toBe('board');
    await dispatchKey({ type: 'toggleView' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'map', selectedId: 'c1' });
  });
  it('walks the whole fleet with the card open', async () => {
    const c = ctx();
    c.store.getState().focus('c0');
    await dispatchKey({ type: 'nextCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ focusedId: 'c1', card: 'c1' });
    await dispatchKey({ type: 'prevCharacter' }, c);
    await dispatchKey({ type: 'prevCharacter' }, c);
    expect(c.store.getState().focusedId).toBe('c2');
    await dispatchKey({ type: 'nextIsland' }, c);
    expect(c.store.getState().focusedId).toBe('c0');
    await dispatchKey({ type: 'toggleView' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'board', card: undefined });
    await dispatchKey({ type: 'toggleView' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'map', selectedId: 'c0', card: 'c0' });
    // the board left the side card open, and it carries back to the map
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.store.getState().sideCardOpen).toBe(false);
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.store.getState().sideCardOpen).toBe(true);
  });
  it('closing the side card hands the keys to the terminal', async () => {
    const c = ctx(true);
    c.store.getState().focus('c0');
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.store.getState().sideCardOpen).toBe(true);
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.store.getState().sideCardOpen).toBe(false);
    expect(c.sent.at(-1)).toEqual({ type: 'term.focus', id: 'c0' });
    await dispatchKey({ type: 'none' }, c);
    expect(c.calls).toEqual([]);
  });

  const onBoard = (c: ReturnType<typeof ctx>) => { c.store.getState().setView('board'); c.store.getState().select('c1'); c.store.getState().focus('c1'); };
  const panes = (c: ReturnType<typeof ctx>) => panesOf(c.store.getState(), 'c1');

  it('Cmd+B opens the browser on the right and closes it, handing the keys back to the terminal', async () => {
    const c = ctx(true);
    onBoard(c);
    await dispatchKey({ type: 'toggleBrowser' }, c);
    expect(panes(c)).toEqual({ left: 'terminal', right: 'browser' });
    c.sent.length = 0;
    await dispatchKey({ type: 'toggleBrowser' }, c);
    expect(panes(c)).toEqual({ left: 'terminal' });
    expect(c.sent).toContainEqual({ type: 'term.focus', id: 'c1' });
  });

  it('Cmd+B turns a lone browser back to the terminal, in the card as on the board', async () => {
    const c = ctx(true);
    c.store.getState().focus('c1');
    c.store.getState().setPanes('c1', { left: 'browser' });
    await dispatchKey({ type: 'toggleBrowser' }, c);
    expect(panes(c)).toEqual({ left: 'terminal' });
    c.store.getState().closeCard();
    await dispatchKey({ type: 'toggleBrowser' }, c);
    expect(panes(c)).toEqual({ left: 'terminal' });
  });

  it('Cmd+L makes the browser visible and asks the address bar for the keys', async () => {
    const c = ctx();
    onBoard(c);
    await dispatchKey({ type: 'focusAddress' }, c);
    expect(panes(c)).toEqual({ left: 'terminal', right: 'browser' });
    expect(c.store.getState().addressFocus).toBe(true);
  });

  it('Cmd+L with nobody in view asks for nothing', async () => {
    const c = ctx();
    c.store.getState().setFleet({ ...fleet(), characters: {} });
    c.store.getState().setView('board');
    await dispatchKey({ type: 'focusAddress' }, c);
    expect(c.store.getState().addressFocus).toBe(false);
  });

  it('Cmd+Shift+A asks the map for an arrange, and on the board leaves the fleet be', async () => {
    const c = ctx();
    await dispatchKey({ type: 'arrange' }, c);
    expect(c.store.getState().arrangeAsk).toBe('key');
    c.store.getState().arranged();
    c.store.getState().setView('board');
    await dispatchKey({ type: 'arrange' }, c);
    expect(c.store.getState().arrangeAsk).toBe(false);
  });

  const linked = (c: ReturnType<typeof ctx>, context: ContextItem[]) => {
    const f = fleet();
    c.store.getState().setFleet({ ...f, characters: { ...f.characters, c1: { ...f.characters.c1, context } } });
    const loads: unknown[][] = [];
    return { loads, keys: { ...c, browser: { load: (...a: unknown[]) => { loads.push(a); } } as unknown as BrowserManager } };
  };
  const item = (kind: ContextItem['kind'], ref: string): ContextItem => ({ kind, ref, label: '', source: 'auto' });

  it('Cmd+U opens the first web link beside the terminal, as Open here does', async () => {
    const c = ctx();
    const { loads, keys } = linked(c, [item('folder', '/tmp'), item('pr', 'https://github.com/o/r/pull/1'), item('linear', 'https://linear.app/x/issue/A-1')]);
    onBoard(c);
    await dispatchKey({ type: 'openLink' }, keys);
    expect(loads).toEqual([['c1', undefined, 'https://github.com/o/r/pull/1']]);
    expect(panes(c)).toEqual({ left: 'terminal', right: 'browser' });
  });

  it('Cmd+U on the map opens the card of the selected character to show the link', async () => {
    const c = ctx();
    const { loads, keys } = linked(c, [item('pr', 'https://github.com/o/r/pull/1')]);
    c.store.getState().select('c1');
    await dispatchKey({ type: 'openLink' }, keys);
    expect(c.store.getState().card).toBe('c1');
    expect(loads).toHaveLength(1);
  });

  it('Cmd+U with no web link opens nothing', async () => {
    const c = ctx();
    const { loads, keys } = linked(c, [item('file', '/tmp/a.md')]);
    onBoard(c);
    await dispatchKey({ type: 'openLink' }, keys);
    expect(loads).toEqual([]);
    expect(panes(c)).toEqual({ left: 'terminal' });
  });

  it('Cmd+Shift+P asks the shell to fill the tab on show, once 1Password is on and the shell has the CLI', async () => {
    const c = ctx(true);
    c.store.getState().setView('board');
    const f = fleet();
    const id = Object.keys(f.characters)[0];
    f.characters[id] = { ...f.characters[id], browser: { tabs: [{ id: 't_1', url: 'https://github.com/login', title: '' }], active: 't_1' } };
    c.store.getState().setFleet(f);
    c.store.getState().select(id);
    c.store.getState().setPanes('c1', { left: 'terminal', right: 'browser' });
    await dispatchKey({ type: 'fillLogin' }, c);
    expect(c.sent).toEqual([]);
    // the setting alone is not enough: the switch reads off without the CLI, and the chord is off with it
    c.store.getState().setSettings({ onePassword: true });
    c.store.getState().setShell({ home: '/tmp/fleet-x', log: [], op: false });
    await dispatchKey({ type: 'fillLogin' }, c);
    expect(c.sent).toEqual([]);
    c.store.getState().setShell({ home: '/tmp/fleet-x', log: [], op: true });
    await dispatchKey({ type: 'fillLogin' }, c);
    expect(c.sent).toEqual([{ type: 'browser.fill', tab: 't_1' }]);
    c.store.getState().setPanes('c1', { left: 'terminal' });
    await dispatchKey({ type: 'fillLogin' }, c);
    expect(c.sent).toHaveLength(1);
  });

  it('Cmd+1 to Cmd+4 act on the left pane and leave the right one be', async () => {
    const c = ctx(true);
    onBoard(c);
    c.store.getState().setPanes('c1', { left: 'terminal', right: 'browser' });
    await dispatchKey({ type: 'showPane', pane: 'files' }, c);
    expect(panes(c)).toEqual({ left: 'files', right: 'browser' });
    await dispatchKey({ type: 'showPane', pane: 'changes' }, c);
    expect(panes(c)).toEqual({ left: 'changes', right: 'browser' });
    await dispatchKey({ type: 'showPane', pane: 'browser' }, c);
    expect(panes(c)).toEqual({ left: 'browser', right: 'changes' });
    c.sent.length = 0;
    await dispatchKey({ type: 'showPane', pane: 'terminal' }, c);
    expect(panes(c)).toEqual({ left: 'terminal', right: 'changes' });
    expect(c.sent).toContainEqual({ type: 'term.focus', id: 'c1' });
  });

  it('Cmd+1 brings the main terminal over from the right instead of opening a second one', async () => {
    const c = ctx();
    onBoard(c);
    c.store.getState().setPanes('c1', { left: 'files', right: 'terminal' });
    await dispatchKey({ type: 'showPane', pane: 'terminal' }, c);
    expect(panes(c)).toEqual({ left: 'terminal', right: 'files' });
    expect(c.calls.map((x) => x.method)).not.toContain('char.second');
  });

  it('closing the side card refocuses the surface only while a terminal is up', async () => {
    const c = ctx(true);
    c.store.getState().setView('board');
    c.store.getState().select('c1');
    c.store.getState().setPanes('c1', { left: 'files' });
    c.store.getState().toggleSideCard(true);
    c.sent.length = 0;
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.sent).toEqual([]);
    c.store.getState().setPanes('c1', { left: 'files', right: 'terminal' });
    c.store.getState().toggleSideCard(true);
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.sent).toEqual([{ type: 'term.focus', id: 'c1' }]);
    // the map's card shows the same panes, and holds to the same rule
    c.store.getState().setPanes('c1', { left: 'files' });
    c.store.getState().setView('map');
    c.store.getState().focus('c1');
    c.store.getState().toggleSideCard(true);
    c.sent.length = 0;
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.sent).toEqual([]);
    c.store.getState().setPanes('c1', { left: 'terminal' });
    c.store.getState().toggleSideCard(true);
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.sent).toEqual([{ type: 'term.focus', id: 'c1' }]);
  });

  it('hands the keys to the second terminal when it is the one that is up', async () => {
    const c = ctx(true);
    onBoard(c);
    c.store.getState().setPanes('c1', { left: 'files', right: 'terminal2' });
    c.store.getState().toggleSideCard(true);
    c.sent.length = 0;
    await dispatchKey({ type: 'toggleSideCard' }, c);
    expect(c.sent).toContainEqual({ type: 'term.focus', id: 'c1-2' });
  });
});

describe('installKeyHandlers', () => {
  it('registers chords with the shell and dispatches key messages', async () => {
    const c = ctx(true);
    c.store.getState().focus('c0');
    installKeyHandlers(c, { addEventListener() {}, removeEventListener() {} } as unknown as Window);
    expect(c.sent[0]).toMatchObject({ type: 'keys.register' });
    expect((c.sent[0] as { chords: string[] }).chords).toEqual(expect.arrayContaining(['cmd+j', 'cmd+q', 'cmd+l']));
    c.bridge.emit({ type: 'key', chord: 'cmd+j' });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.store.getState().focusedId).toBe('c1');
  });
  it('tells the shell again when a chord is changed, so the old one stops being swallowed', async () => {
    const c = ctx(true);
    installKeyHandlers(c, { addEventListener() {}, removeEventListener() {} } as unknown as Window);
    c.sent.length = 0;
    // a settings change that leaves the chords alone says nothing
    c.store.getState().setSettings({ zoom: 1.1 });
    expect(c.sent).toEqual([]);
    c.store.getState().setSettings({ bindings: { nextCharacter: 'cmd+y' } });
    const chords = (c.sent.at(-1) as { chords: string[] }).chords;
    expect(chords).toContain('cmd+y');
    expect(chords).not.toContain('cmd+j');
    c.store.getState().focus('c0');
    c.bridge.emit({ type: 'key', chord: 'cmd+y' });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.store.getState().focusedId).toBe('c1');
  });
  it('Enter on the board hands the keys to the surface, except in a field or on a control the keyboard focused', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: Event) => void> = {};
    const win = { addEventListener: (t: string, h: (e: Event) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.sent.length = 0;
    c.store.getState().setView('board');
    c.store.getState().select('c1', false);
    listeners.keydown({ key: 'Enter', target: { tagName: 'INPUT' }, preventDefault() {} } as unknown as KeyboardEvent);
    listeners.focusin({ target: { tagName: 'BUTTON', matches: () => true } } as unknown as FocusEvent);
    listeners.keydown({ key: 'Enter', target: { tagName: 'BUTTON' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.sent).toEqual([]);
    // a button left focused by a mouse click is not :focus-visible, so the selection keeps the key
    listeners.focusin({ target: { tagName: 'BUTTON', matches: () => false } } as unknown as FocusEvent);
    listeners.keydown({ key: 'Enter', target: { tagName: 'BUTTON' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.sent).toEqual([{ type: 'term.focus', id: 'c1' }]);
    c.sent.length = 0;
    listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().view).toBe('board');
    expect(c.sent).toEqual([{ type: 'term.focus', id: 'c1' }]);
  });
  it('leaves Enter and Escape from inside the editor to the editor', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: Event) => void> = {};
    const win = { addEventListener: (t: string, h: (e: Event) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().setView('board');
    // the side card is open, so an Escape that reached the page would close it
    c.store.getState().select('c1');
    c.sent.length = 0;
    const inEditor = { tagName: 'DIV', closest: (sel: string) => (sel === '.cm-editor' ? {} : null) };
    const enter = vi.fn();
    listeners.keydown({ key: 'Enter', target: inEditor, preventDefault: enter } as unknown as KeyboardEvent);
    expect(enter).not.toHaveBeenCalled();
    expect(c.sent).toEqual([]);
    listeners.keydown({ key: 'Escape', target: inEditor, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().sideCardOpen).toBe(true);
  });
  it('Enter that opens the selection is not left for the browser to act on', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: Event) => void> = {};
    const win = { addEventListener: (t: string, h: (e: Event) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().setView('board');
    c.store.getState().select('c1', false);
    const taken = vi.fn();
    listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault: taken } as unknown as KeyboardEvent);
    expect(taken).toHaveBeenCalled();
    const kept = vi.fn();
    listeners.focusin({ target: { tagName: 'BUTTON', matches: () => true } } as unknown as FocusEvent);
    listeners.keydown({ key: 'Enter', target: { tagName: 'BUTTON' }, preventDefault: kept } as unknown as KeyboardEvent);
    expect(kept).not.toHaveBeenCalled();
  });
  it('on the board the navigation chords remember the character as the focus', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    await dispatchKey({ type: 'nextCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'board', selectedId: 'c0', focusedId: 'c0', card: undefined });
  });
  it('Escape on the board closes the side card and keeps the viewed character', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().setView('board');
    c.store.getState().focus('c0');
    c.store.getState().select('c1');
    expect(c.store.getState().sideCardOpen).toBe(true);
    listeners.keydown({ key: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState()).toMatchObject({ selectedId: 'c1', sideCardOpen: false });
    expect(c.sent.at(-1)).toEqual({ type: 'term.focus', id: 'c1' });
  });
  it('Escape in a side-card field blurs it before closing the card, so the edit is saved', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().select('c1');
    const order: string[] = [];
    c.store.subscribe((s, prev) => { if (s.sideCardOpen !== prev.sideCardOpen) order.push('closed'); });
    listeners.keydown({ key: 'Escape', target: { tagName: 'INPUT', blur: () => order.push('blur') }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(order).toEqual(['blur', 'closed']);
  });
  it('handles keydown itself in a browser', async () => {
    const c = ctx(false);
    c.store.getState().focus('c0');
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    let prevented = false;
    listeners.keydown({ key: 'j', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false, preventDefault: () => { prevented = true; } } as unknown as KeyboardEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(prevented).toBe(true);
    expect(c.store.getState().focusedId).toBe('c1');
    listeners.keydown({ key: 'Escape', metaKey: false, shiftKey: false, ctrlKey: false, altKey: false, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().sideCardOpen).toBe(false);
  });
});

describe('dispatchKey on the map', () => {
  it('navigation moves the selection and the card follows when open', async () => {
    const c = ctx();
    c.store.getState().select('c0');
    await dispatchKey({ type: 'nextCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'map', selectedId: 'c1', card: undefined });
    c.store.getState().focus('c1');
    await dispatchKey({ type: 'prevCharacter' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'map', selectedId: 'c0', card: 'c0' });
    await dispatchKey({ type: 'nextIsland' }, c);
    expect(c.store.getState().card).toBe('c2');
  });
  it('Cmd+W closes the card first, then the selected character', async () => {
    const c = ctx();
    c.store.getState().focus('c0');
    await dispatchKey({ type: 'closeCharacter' }, c);
    expect(c.store.getState().card).toBeUndefined();
    expect(c.calls).toEqual([]);
    await dispatchKey({ type: 'closeCharacter' }, c);
    expect(c.calls).toEqual([]);
    expect(c.store.getState().closingCharacter).toBe('c0');
  });
  it('Cmd+M toggles the map and the board; the board returns to the map with its character in the card', async () => {
    const c = ctx();
    c.store.getState().select('c1');
    await dispatchKey({ type: 'toggleView' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'board', selectedId: 'c1', sideCardOpen: true });
    c.store.getState().setPanes('c1', { left: 'files', right: 'browser' });
    await dispatchKey({ type: 'toggleView' }, c);
    expect(c.store.getState()).toMatchObject({ view: 'map', selectedId: 'c1', card: 'c1' });
    // the character's panes come to the map as the board left them
    expect(panesOf(c.store.getState(), 'c1')).toEqual({ left: 'files', right: 'browser' });
    const empty = ctx();
    empty.store.getState().setFleet(emptyState());
    await dispatchKey({ type: 'toggleView' }, empty);
    expect(empty.store.getState().view).toBe('board');
    await dispatchKey({ type: 'toggleView' }, empty);
    expect(empty.store.getState().view).toBe('map');
  });
  it('Cmd+Enter toggles the card size', async () => {
    const c = ctx();
    c.store.getState().focus('c1');
    await dispatchKey({ type: 'toggleCardSize' }, c);
    expect(c.store.getState().cardSize).toBe('full');
  });
  it('steps over a collapsed home without opening it', async () => {
    const c = ctx();
    const f = fleet();
    f.characters.ch = chr('ch', 'home', { x: 1, y: 1 });
    f.islands.home.collapsed = true;
    c.store.getState().setFleet(f);
    c.store.getState().setView('map');
    c.store.getState().select('c0');
    await dispatchKey({ type: 'nextIsland' }, c);
    expect(c.store.getState().selectedId).toBe('c2');
    expect(c.calls).toEqual([]);
  });
  it('Cmd+, opens the settings, and closing them hands the keys back to the terminal', async () => {
    const c = ctx(true);
    c.store.getState().focus('c0');
    await dispatchKey({ type: 'toggleSettings' }, c);
    expect(c.store.getState().settingsOpen).toBe(true);
    await dispatchKey({ type: 'toggleSettings' }, c);
    expect(c.store.getState().settingsOpen).toBe(false);
    expect(c.sent.at(-1)).toEqual({ type: 'term.focus', id: 'c0' });
  });
  it('Cmd+= and Cmd+- step the zoom, and Cmd+0 puts it back', async () => {
    const c = ctx();
    c.store.getState().setSettings({ zoom: 1 });
    await dispatchKey({ type: 'zoom', steps: 1 }, c);
    await dispatchKey({ type: 'zoom', steps: 1 }, c);
    expect(c.store.getState().settings.zoom).toBe(1.25);
    await dispatchKey({ type: 'zoom', steps: -1 }, c);
    expect(c.store.getState().settings.zoom).toBe(1.1);
    await dispatchKey({ type: 'zoom', steps: 0 }, c);
    expect(c.store.getState().settings.zoom).toBe(1);
  });
  it('Cmd+Shift+R opens the resources shelf on the map, and closes it again', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    await dispatchKey({ type: 'toggleResources' }, c);
    expect(c.store.getState()).toMatchObject({ resourcesOpen: true, view: 'map' });
    await dispatchKey({ type: 'toggleResources' }, c);
    expect(c.store.getState().resourcesOpen).toBe(false);
  });
  it('Enter on the open resources shelf leaves the character behind it shut', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().select('c1', false);
    c.store.getState().toggleResources(true);
    listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().card).toBeUndefined();
    c.store.getState().toggleResources(false);
    listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().card).toBe('c1');
  });
  it('Enter under the link popup or a corner panel leaves the character behind it shut', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    const enter = () => listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    c.store.getState().select('c1', false);
    c.store.getState().askLink({ url: 'https://example.com', charId: 'c1', x: 0, y: 0 });
    enter();
    c.store.getState().closeLinkAsk();
    c.store.getState().toggleUsage(true);
    enter();
    c.store.getState().toggleUsage(false);
    c.store.getState().toggleMobile(true);
    enter();
    expect(c.store.getState().card).toBeUndefined();
  });
  it('Enter on the board behind an overlay leaves the keys with the overlay', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    const enter = () => listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    const focused = () => c.sent.filter((m) => m.type === 'term.focus');
    c.store.getState().setView('board');
    c.store.getState().select('c1');
    c.store.getState().setMissionPrompt(true);
    enter();
    c.store.getState().setMissionPrompt(false);
    c.store.getState().toggleUsage(true);
    enter();
    expect(focused()).toEqual([]);
    c.store.getState().toggleUsage(false);
    enter();
    expect(focused()).toEqual([{ type: 'term.focus', id: 'c1' }]);
  });
  it('Escape closes the settings before anything under them', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().focus('c1');
    c.store.getState().toggleSettings(true);
    listeners.keydown({ key: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState()).toMatchObject({ settingsOpen: false, card: 'c1' });
  });
  it('Escape closes the card, then the side card', () => {
    const c = ctx(true);
    const listeners: Record<string, (e: KeyboardEvent) => void> = {};
    const win = { addEventListener: (t: string, h: (e: KeyboardEvent) => void) => { listeners[t] = h; }, removeEventListener() {} } as unknown as Window;
    installKeyHandlers(c, win);
    c.store.getState().select('c1');
    c.store.getState().focus('c1');
    listeners.keydown({ key: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState()).toMatchObject({ card: undefined, sideCardOpen: true });
    listeners.keydown({ key: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().sideCardOpen).toBe(false);
    c.store.getState().select('c1', false);
    listeners.keydown({ key: 'Enter', target: { tagName: 'DIV' }, preventDefault() {} } as unknown as KeyboardEvent);
    expect(c.store.getState().card).toBe('c1');
  });
});
