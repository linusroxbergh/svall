// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { freshStore, sent, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');

beforeEach(() => {
  freshStore();
  render(<Sidebar />);
});

test('the sidebar names a waiting update under the islands, and its press installs it', () => {
  expect(screen.queryByTestId('sidebar-update')).toBeNull();
  act(() => store.getState().setUpdate('0.15.0'));
  const row = screen.getByTestId('sidebar-update');
  expect(row.textContent).toBe('Update to 0.15.0');
  expect(screen.getByTestId('sidebar').querySelector('.sb-list')!.nextElementSibling).toBe(row);
  fireEvent.click(row);
  expect(sent).toContainEqual({ type: 'update.install' });
  act(() => store.getState().setUpdate(undefined));
  expect(screen.queryByTestId('sidebar-update')).toBeNull();
});
