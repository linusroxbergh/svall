// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { chr, fleet } from '../fixtures.js';

const browser = { start: vi.fn(), show: vi.fn(), move: vi.fn(), hide: vi.fn(), load: vi.fn(), go: vi.fn() };
let store: AppStore;
vi.mock('../../src/boot.js', () => ({
  app: { get store() { return store; }, bridge: { present: true, send: () => {}, onMessage: () => () => {} }, browser: () => browser },
  deps: () => ({ store }),
}));

const { BrowserArea } = await import('../../src/BrowserArea.js');

test('the reload button stops a page while it loads', () => {
  store = createAppStore();
  setAppStore(store);
  const f = fleet();
  f.characters.c0 = chr('c0', 'i_b', { x: 1, y: 1 }, { browser: { tabs: [{ id: 't_1', url: 'https://a.test/', title: '' }], active: 't_1' } });
  store.getState().setFleet(f);
  store.getState().webviewOpened('t_1', { x: 0, y: 0, width: 0, height: 0 });
  render(<BrowserArea id="c0" />);
  act(() => store.getState().webviewState('t_1', { loading: true }));
  fireEvent.click(screen.getByTestId('browser-reload'));
  expect(browser.go).toHaveBeenLastCalledWith('t_1', 'stop');
  act(() => store.getState().webviewState('t_1', { loading: false }));
  fireEvent.click(screen.getByTestId('browser-reload'));
  expect(browser.go).toHaveBeenLastCalledWith('t_1', 'reload');
});
