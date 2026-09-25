// @vitest-environment jsdom
import './setup.js';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { fleet } from '../fixtures.js';

let store: AppStore;
vi.mock('../../src/boot.js', () => ({ deps: () => ({ api: { call: () => Promise.resolve({}) }, store }) }));

const { ScribeAsk } = await import('../../src/ScribeAsk.js');

beforeEach(() => {
  store = createAppStore();
  setAppStore(store);
  store.getState().setFleet({ ...fleet(), scribeAsk: true });
});

// Enter presses the focused button, so a reflex Enter must not opt in to spending usage
test('the scribe question opens with Keep off focused', () => {
  render(<ScribeAsk />);
  expect(document.activeElement).toBe(screen.getByTestId('scribe-ask-off'));
});
