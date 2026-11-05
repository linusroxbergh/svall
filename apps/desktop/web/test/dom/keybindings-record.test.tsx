// @vitest-environment jsdom
import './setup.js';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FromShell } from '../../src/bridge.js';

const GHOSTTY = { 'cmd+t': 'new_split:right' };

// the Mac: its bindings.json as text, read as the shell reads it, and the windows opened on it through the real boot
function mac(file?: string, ghosttyKeys: Record<string, string> = GHOSTTY) {
  const m = { file, saves: 0, sent: [] as string[] };
  const record = () => { try { const v: unknown = JSON.parse(m.file ?? ''); return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };
  const tell = (message: FromShell) => act(() => window.__svall!.receive(JSON.stringify(message)));
  const open = async (home: string) => {
    cleanup();
    vi.resetModules();
    window.__svallHome = home;
    window.webkit = { messageHandlers: { svall: { postMessage(json: string) {
      const sent = JSON.parse(json) as { type: string; bindings?: unknown };
      m.sent.push(sent.type);
      if (sent.type === 'keys.save') { m.saves += 1; m.file = JSON.stringify(sent.bindings); }
      if (sent.type === 'connection') {
        const bindings = record();
        queueMicrotask(() => window.__svall!.receive(JSON.stringify({ type: 'shell.info', home, log: [], op: false, ghosttyKeys, ...(bindings && { bindings }) })));
      }
    } } } };
    const { initApp } = await import('../../src/boot.js');
    const { Keybindings } = await import('../../src/Keybindings.js');
    initApp();
    await act(async () => { await Promise.resolve(); });
    render(<Keybindings />);
  };
  const press = (id: string, chord: string) => {
    fireEvent.click(screen.getByTestId(`key-${id}`));
    tell({ type: 'key', chord });
  };
  // the shell as this window comes to the front: the record if the file holds one, and nothing otherwise
  const front = () => { const bindings = record(); if (bindings) tell({ type: 'keys.record', bindings: bindings as Record<string, unknown> }); };
  return Object.assign(m, { open, press, front, json: () => JSON.parse(m.file!) as unknown });
}

const shows = (id: string) => screen.getByTestId(`key-${id}`).textContent;
const save = (home: string | undefined, bindings: unknown) => localStorage.setItem(home ? `svall.settings@${home}` : 'svall.settings', JSON.stringify({ zoom: 1, bindings }));

beforeEach(() => localStorage.clear());
afterEach(() => { delete window.webkit; delete window.__svallHome; });

test('a first launch on a Mac leaves Ghostty its chords and writes that down', async () => {
  const m = mac();
  await m.open('/u/.svall');
  expect(shows('newRobot')).toBe('—');
  expect(shows('nextRobot')).toBe('⌘J');
  expect(screen.getByTestId('key-held-newRobot').textContent).toContain('new_split:right');
  expect(m.json()).toEqual({ newRobot: null });
});

test('a first launch with nothing for Ghostty to keep writes an empty record, which stands as the answer', async () => {
  const m = mac(undefined, {});
  await m.open('/u/.svall');
  expect(shows('newRobot')).toBe('⌘T');
  expect(m.json()).toEqual({});
});

test('a never-opened fleet takes the record, whatever Ghostty spends, and writes nothing', async () => {
  const m = mac('{"newRobot":"cmd+t"}');
  await m.open('/u/.svall-new');
  expect(shows('newRobot')).toBe('⌘T');
  expect(screen.queryByTestId('key-held-newRobot')).toBeNull();
  expect(m.saves).toBe(0);
});

test('an empty record is an answer: Ghostty is not asked again', async () => {
  const m = mac('{}');
  await m.open('/u/.svall-new');
  expect(shows('newRobot')).toBe('⌘T');
  expect(m.saves).toBe(0);
});

test('a second fleet has what the first one answered and changed', async () => {
  const m = mac();
  await m.open('/u/.svall-a');
  m.press('newRobot', 'cmd+n');
  expect(shows('newRobot')).toBe('⌘N');
  await m.open('/u/.svall-b');
  expect(shows('newRobot')).toBe('⌘N');
  m.press('nextRobot', 'cmd+y');
  await m.open('/u/.svall-a');
  expect(shows('newRobot')).toBe('⌘N');
  expect(shows('nextRobot')).toBe('⌘Y');
});

test('each change in the pane reaches the file, a key cleared or put back too', async () => {
  const m = mac('{}');
  await m.open('/u/.svall');
  m.press('newRobot', 'cmd+n');
  expect(m.json()).toEqual({ newRobot: 'cmd+n' });
  fireEvent.click(screen.getByTestId('key-clear-nextRobot'));
  expect(m.json()).toEqual({ newRobot: 'cmd+n', nextRobot: null });
  fireEvent.click(screen.getByTestId('key-reset-newRobot'));
  expect(m.json()).toEqual({ nextRobot: null });
});

test('another setting leaves the file alone', async () => {
  const m = mac();
  await m.open('/u/.svall');
  expect(m.saves).toBe(1);
  const { app } = await import('../../src/boot.js');
  act(() => app.store.getState().setSettings({ zoom: 1.1 }));
  expect(m.saves).toBe(1);
});

test.each(['{ "newRobot": ', '[]', '{"newRobot":5}', '{"newRobot":"cmd+opt+n"}'])('a corrupt file (%s) reads as no record and is replaced', async (file) => {
  const m = mac(file);
  await m.open('/u/.svall');
  expect(shows('newRobot')).toBe('—');
  expect(m.json()).toEqual({ newRobot: null });
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ newRobot: null, nextRobot: 'cmd+y' });
});

test('a record keeps what it can act on, and the next change rewrites it whole', async () => {
  const m = mac('{"newRobot":5,"quit":null,"gone":"cmd+x"}');
  await m.open('/u/.svall');
  expect(shows('newRobot')).toBe('⌘T');
  expect(shows('quit')).toBe('—');
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ quit: null, nextRobot: 'cmd+y', gone: 'cmd+x' });
});

test('a change carries on what the record holds for actions only another build has', async () => {
  const m = mac('{"futureAction":"cmd+k","newRobot":null}');
  await m.open('/u/.svall');
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ futureAction: 'cmd+k', newRobot: null, nextRobot: 'cmd+y' });
});

test('a record of another build\'s actions alone is a record, here at start and on coming to the front', async () => {
  const m = mac('{"futureAction":"cmd+k"}');
  await m.open('/u/.svall');
  expect(shows('newRobot')).toBe('⌘T');
  expect(m.saves).toBe(0);
  m.press('newRobot', 'cmd+n');
  m.file = '{"futureAction":"cmd+u"}';
  m.front();
  expect(shows('newRobot')).toBe('⌘T');
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ futureAction: 'cmd+u', nextRobot: 'cmd+y' });
});

test('coming to the front takes another build\'s entries even when this build\'s keys are the same', async () => {
  const m = mac('{"newRobot":"cmd+n"}');
  await m.open('/u/.svall');
  m.file = '{"newRobot":"cmd+n","futureAction":"cmd+k"}';
  m.front();
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ futureAction: 'cmd+k', newRobot: 'cmd+n', nextRobot: 'cmd+y' });
});

test('on upgrade the fleet that opens seeds the record, and Ghostty is not asked', async () => {
  save('/u/.svall-work', { nextRobot: 'cmd+y' });
  const m = mac();
  await m.open('/u/.svall-work');
  expect(shows('newRobot')).toBe('⌘T');
  expect(shows('nextRobot')).toBe('⌘Y');
  expect(m.json()).toEqual({ nextRobot: 'cmd+y' });
});

test.each([['/u/.svall'], [undefined]])('on upgrade the default fleet (%s) wins over the named fleet that opens', async (home) => {
  save('/u/.svall-work', { newRobot: null });
  save(home, { nextRobot: 'cmd+y' });
  const m = mac();
  await m.open('/u/.svall-work');
  expect(shows('newRobot')).toBe('⌘T');
  expect(shows('nextRobot')).toBe('⌘Y');
  expect(m.json()).toEqual({ nextRobot: 'cmd+y' });
});

test('on upgrade a default fleet that kept the shipped keys leaves a named fleet\'s changes', async () => {
  save('/u/.svall', {});
  save('/u/.svall-work', { nextRobot: 'cmd+y' });
  const m = mac();
  await m.open('/u/.svall-new');
  expect(m.json()).toEqual({ nextRobot: 'cmd+y' });
});

test('on upgrade a Mac whose fleets all kept the shipped keys keeps them, Ghostty not asked', async () => {
  save('/u/.svall', {});
  const m = mac();
  await m.open('/u/.svall-new');
  expect(shows('newRobot')).toBe('⌘T');
  expect(m.json()).toEqual({});
});

test('on upgrade a new fleet takes what another fleet saved, not Ghostty\'s word', async () => {
  save('/u/.svall-work', { nextRobot: 'cmd+y' });
  const m = mac();
  await m.open('/u/.svall-new');
  expect(shows('newRobot')).toBe('⌘T');
  expect(m.json()).toEqual({ nextRobot: 'cmd+y' });
});

test('with a record, what a fleet saved before stays out of it', async () => {
  save('/u/.svall', { nextRobot: 'cmd+y' });
  const m = mac('{"nextRobot":"cmd+u"}');
  await m.open('/u/.svall');
  expect(shows('nextRobot')).toBe('⌘U');
  expect(m.saves).toBe(0);
});

test('a window coming to the front takes what another window changed, and writes nothing', async () => {
  const m = mac('{"newRobot":"cmd+t"}');
  await m.open('/u/.svall-a');
  m.file = '{"newRobot":"cmd+n"}';
  m.front();
  expect(shows('newRobot')).toBe('⌘N');
  expect(m.saves).toBe(0);
});

test('its next change keeps what the other window changed', async () => {
  const m = mac('{"newRobot":"cmd+t"}');
  await m.open('/u/.svall-a');
  m.file = '{"newRobot":"cmd+n"}';
  m.front();
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ newRobot: 'cmd+n', nextRobot: 'cmd+y' });
});

test('another window that put every key back is taken too', async () => {
  const m = mac('{"newRobot":"cmd+n"}');
  await m.open('/u/.svall-a');
  m.file = '{}';
  m.front();
  expect(shows('newRobot')).toBe('⌘T');
});

test.each([[undefined], ['{ "newRobot": '], ['[]'], ['{"newRobot":5}']])('a file found missing or corrupt (%s) leaves the window its copy', async (found) => {
  const m = mac('{"newRobot":"cmd+n"}');
  await m.open('/u/.svall-a');
  m.file = found;
  m.front();
  expect(shows('newRobot')).toBe('⌘N');
  expect(m.saves).toBe(0);
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ newRobot: 'cmd+n', nextRobot: 'cmd+y' });
});

test('a window that started with no record takes what another window wrote since', async () => {
  const m = mac();
  await m.open('/u/.svall-a');
  m.file = '{"newRobot":"cmd+n"}';
  m.front();
  expect(shows('newRobot')).toBe('⌘N');
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ newRobot: 'cmd+n', nextRobot: 'cmd+y' });
});

test('coming to the front takes what it can act on from a mixed record, and writes only that and another build\'s entries', async () => {
  const m = mac('{"newRobot":"cmd+t"}');
  await m.open('/u/.svall-a');
  m.file = '{"newRobot":"cmd+n","quit":5,"gone":"cmd+x"}';
  m.front();
  expect(shows('newRobot')).toBe('⌘N');
  expect(shows('quit')).toBe('⌘Q');
  m.press('nextRobot', 'cmd+y');
  expect(m.json()).toEqual({ newRobot: 'cmd+n', nextRobot: 'cmd+y', gone: 'cmd+x' });
});

test('a fleet\'s saved copy follows the record it takes, at start and on coming to the front', async () => {
  save('/u/.svall-a', {});
  const m = mac('{"newRobot":"cmd+n"}');
  await m.open('/u/.svall-a');
  const copy = () => JSON.parse(localStorage.getItem('svall.settings@/u/.svall-a')!).bindings as unknown;
  expect(copy()).toEqual({ newRobot: 'cmd+n' });
  m.file = '{"newRobot":"cmd+u"}';
  m.front();
  expect(copy()).toEqual({ newRobot: 'cmd+u' });
  // the file lost, the next fleet's window seeds from that copy
  m.file = undefined;
  await m.open('/u/.svall-b');
  expect(shows('newRobot')).toBe('⌘U');
  expect(m.json()).toEqual({ newRobot: 'cmd+u' });
});

test('a never-opened fleet that takes the record saves nothing of its own', async () => {
  const m = mac('{"newRobot":"cmd+n"}');
  await m.open('/u/.svall-new');
  m.file = '{"newRobot":"cmd+u"}';
  m.front();
  expect(localStorage.getItem('svall.settings@/u/.svall-new')).toBeNull();
});

test('coming to the front with nothing changed tells the shell nothing', async () => {
  const m = mac('{"newRobot":"cmd+n"}');
  await m.open('/u/.svall-a');
  m.sent.length = 0;
  m.front();
  expect(m.sent).toEqual([]);
});

test('a page with no shell keeps its keys in its own store', async () => {
  vi.resetModules();
  const app = (await import('../../src/boot.js')).initApp();
  expect(app.bridge.present).toBe(false);
  app.store.getState().setSettings({ bindings: { newRobot: 'cmd+n' } });
  expect(JSON.parse(localStorage.getItem('svall.settings')!).bindings).toEqual({ newRobot: 'cmd+n' });
});
