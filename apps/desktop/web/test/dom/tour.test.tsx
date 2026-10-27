// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { freshStore, shell, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { readStep, Tour } = await import('../../src/Tour.js');

beforeEach(() => { localStorage.clear(); window.__svallHome = '/u/.svall'; freshStore(); });
afterEach(() => { vi.restoreAllMocks(); delete window.__svallHome; });

test('the tour is offered on a first run and not on a machine with settings under its fleet key or the unscoped one', () => {
  expect(readStep()).toBe(0);
  localStorage.setItem('svall.settings@/u/.svall', '{}');
  expect(readStep()).toBeGreaterThan(0);
  localStorage.clear();
  localStorage.setItem('svall.settings', '{}');
  expect(readStep()).toBeGreaterThan(0);
});

test('a step kept from last time is where the tour goes on, and done is done', () => {
  localStorage.setItem('svall.tour', '2');
  expect(readStep()).toBe(2);
  localStorage.setItem('svall.tour', 'done');
  expect(readStep()).toBeGreaterThan(2);
});

test('a store switched off offers no tour rather than throwing', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('site data switched off'); });
  expect(readStep()).toBeGreaterThan(0);
});

test('the tour selects its first robot once, so a robot shown after a sheet closes stays selected', () => {
  render(<Tour />);
  expect(store.getState().selectedId).toBe('c1');
  act(() => store.getState().setNamingRobot(true));
  act(() => store.getState().focus('c2'));
  act(() => store.getState().setNamingRobot(false));
  expect(store.getState().selectedId).toBe('c2');
});

test('with its anchor out of sight the tour still offers its buttons, and Escape ends it for good', () => {
  const { getByTestId, queryByTestId } = render(<>
    <Tour />
    <input data-testid="rename" onKeyDown={(e) => { if (e.key === 'Escape') e.stopPropagation(); }} />
    <div className="map" data-testid="sea" />
  </>);
  expect(queryByTestId('tour-next')).not.toBeNull();
  expect(queryByTestId('tour-skip')).not.toBeNull();
  const esc = (at: Element = document.body) => act(() => { at.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  // a field, a dialog over the page and a map drag keep their own Escape
  esc(getByTestId('rename'));
  act(() => store.getState().setMissionPrompt(true));
  esc();
  act(() => store.getState().setMissionPrompt(false));
  getByTestId('sea').dataset.dragging = 'true';
  esc();
  getByTestId('sea').dataset.dragging = 'false';
  expect(queryByTestId('tour')).not.toBeNull();
  esc();
  expect(queryByTestId('tour')).toBeNull();
  expect(localStorage.getItem('svall.tour')).toBe('done');
});

test('a key the user left unbound drops the sentence that names it', () => {
  // the settings saved in between would mark the machine past its first run
  const bodies = () => {
    localStorage.clear();
    const { getByTestId, queryByTestId, unmount } = render(<Tour />);
    const out: string[] = [];
    while (queryByTestId('tour')) {
      out.push(getByTestId('tour').querySelector('.tour-body')!.textContent!);
      fireEvent.click(getByTestId('tour-next'));
    }
    unmount();
    return out;
  };
  const bound = bodies();
  expect(bound[0]).toMatch(/opencode\. ⌘T makes another\.$/);
  expect(bound[1]).toMatch(/add your own\. ⌘I shows or hides it\.$/);
  expect(bound[2]).toMatch(/here\. ⌘⇧R opens it\.$/);
  expect(bound[4]).toContain('quick actions. ⌘G asks it anything.');
  act(() => store.getState().setSettings({ bindings: { newRobot: null, toggleSideCard: null, toggleResources: null, missionControl: null } }));
  const unbound = bodies();
  expect(unbound[0]).toMatch(/opencode\.$/);
  expect(unbound[1]).toMatch(/add your own\.$/);
  expect(unbound[2]).toMatch(/here\.$/);
  expect(unbound[4]).toContain('quick actions. The first time');
});

test('a press outside the bubble, on the page or on a terminal, goes to the next step', () => {
  const { getByTestId } = render(<><Tour /><div data-testid="sea" /></>);
  const kicker = () => getByTestId('tour').querySelector('.kicker')!.textContent;
  fireEvent.pointerDown(getByTestId('tour').querySelector('.tour-body')!);
  expect(kicker()).toBe('1 of 5');
  fireEvent.pointerDown(getByTestId('sea'));
  expect(kicker()).toBe('2 of 5');
  act(() => shell({ type: 'shell.pressedAway' }));
  expect(kicker()).toBe('3 of 5');
  // a dialog over the page takes its own presses
  act(() => store.getState().setMissionPrompt(true));
  fireEvent.pointerDown(getByTestId('sea'));
  expect(kicker()).toBe('3 of 5');
});

test('a tour with nothing to point at stays mid-window as the window resizes', async () => {
  const { getByTestId } = render(<Tour />);
  const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  const size = (w: number, h: number) => { Object.defineProperty(window, 'innerWidth', { value: w, configurable: true }); Object.defineProperty(window, 'innerHeight', { value: h, configurable: true }); };
  const [w, h] = [innerWidth, innerHeight];
  try {
    await frame();
    size(600, 400);
    await frame();
    // jsdom lays nothing out, so the bubble measures 0×0 and its corner is the window's middle
    expect([getByTestId('tour').style.left, getByTestId('tour').style.top]).toEqual(['300px', '200px']);
  } finally {
    size(w, h);
  }
});

test('an anchor outside the window is out of sight: the bubble stands mid-window without a ring', async () => {
  const { container, getByTestId } = render(<><Tour /><div data-testid="token-c1" /></>);
  const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  const at = (left: number) => { getByTestId('token-c1').getBoundingClientRect = () => ({ x: left, y: 100, left, top: 100, right: left + 80, bottom: 200, width: 80, height: 100 }) as DOMRect; };
  at(-500);
  await frame();
  expect(container.querySelector('.tour-ring')).toBeNull();
  expect(getByTestId('tour').dataset.side).toBeUndefined();
  at(200);
  await frame();
  expect(container.querySelector('.tour-ring')).not.toBeNull();
  expect(getByTestId('tour').dataset.side).toBe('bottom');
});
