// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { call, freshStore, store } from './harness.js';

vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Sidebar } = await import('../../src/Sidebar.js');
const { UtilityDock } = await import('../../src/UtilityDock.js');
const { App } = await import('../../src/App.js');

beforeEach(() => {
  freshStore();
  call.mockImplementation(async (method) => (method === 'feedback.preview' ? { text: 'preview text' } : {}));
});

test('the link sits under the islands, below a waiting update, and opens the feedback panel', async () => {
  render(<><Sidebar /><UtilityDock /></>);
  const link = screen.getByTestId('sidebar-feedback');
  expect(link.textContent).toBe('Send feedback');
  act(() => store.getState().setUpdate('0.15.0'));
  expect(screen.getByTestId('sidebar-update').nextElementSibling).toBe(link);
  fireEvent.click(link);
  expect(store.getState().feedbackOpen).toBe(true);
  const panel = screen.getByTestId('feedback-panel');
  expect(panel.querySelector('.use-panel-title > span')!.textContent).toBe('Send feedback');
  await waitFor(() => expect(call).toHaveBeenCalledWith('feedback.preview', {}));
});

test('opening feedback closes usage, phone, load and settings, and the reverse', () => {
  const s = () => store.getState();
  const open = () => [s().usageOpen, s().mobileOpen, s().loadOpen, s().settingsOpen, s().feedbackOpen];
  s().toggleUsage(true);
  s().toggleFeedback(true);
  expect(open()).toEqual([false, false, false, false, true]);
  s().toggleLoad(true);
  expect(open()).toEqual([false, false, true, false, false]);
  s().toggleFeedback(true);
  s().toggleSettings(true);
  expect(open()).toEqual([false, false, false, true, false]);
  s().toggleFeedback(true);
  expect(open()).toEqual([false, false, false, false, true]);
  s().toggleFeedback();
  expect(s().feedbackOpen).toBe(false);
});

test('the rail shows the feedback tab only while the sidebar is collapsed', () => {
  render(<UtilityDock />);
  const dock = screen.getByTestId('utility-dock');
  expect(dock.getAttribute('data-collapsed')).toBe('false');
  expect(screen.getByTestId('feedback-tab').parentElement!.firstElementChild).toBe(screen.getByTestId('feedback-tab'));
  expect(screen.getByTestId('feedback-tab').hasAttribute('data-rail')).toBe(true);
  act(() => store.getState().toggleSidebar(false));
  expect(dock.getAttribute('data-collapsed')).toBe('true');
  fireEvent.click(screen.getByTestId('feedback-tab'));
  expect(store.getState().feedbackOpen).toBe(true);
});

test('the connect screen offers Send feedback, and its form previews the shell log masked', async () => {
  act(() => {
    store.setState({ loaded: false });
    store.getState().setStatus('outdated');
    store.getState().setShell({ home: '/Users/ada/.svall', log: ['boom in /Users/ada/.svall/x'], op: false });
  });
  render(<App />);
  fireEvent.click(screen.getByTestId('connect-feedback'));
  expect(store.getState().feedbackOpen).toBe(true);
  expect(screen.getByTestId('feedback-panel')).toBeTruthy();
  const box = await waitFor(() => {
    const b = screen.getByTestId('feedback-diagnostics') as HTMLInputElement;
    expect(b.disabled).toBe(false);
    return b;
  });
  expect(box.checked).toBe(true);
  fireEvent.click(screen.getByTestId('feedback-see'));
  const text = screen.getByTestId('feedback-preview').textContent!;
  expect(text).toContain('svalld not running');
  expect(text).toContain('boom in ~/.svall/x');
  expect(text).not.toContain('ada');
});

test('closing the panel keeps the draft, and a send clears it', async () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    store.getState().toggleFeedback(true);
    const { unmount } = render(<UtilityDock />);
    fireEvent.click(screen.getByTestId('feedback-kind-idea'));
    fireEvent.change(screen.getByTestId('feedback-text'), { target: { value: 'half written' } });
    fireEvent.pointerDown(document.body);
    expect(store.getState().feedbackOpen).toBe(false);
    expect(screen.queryByTestId('feedback-panel')).toBeNull();
    act(() => store.getState().toggleFeedback(true));
    expect(screen.getByTestId('feedback-kind-idea').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('feedback-text') as HTMLTextAreaElement).value).toBe('half written');
    await waitFor(() => expect((screen.getByTestId('feedback-diagnostics') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('feedback-send'));
    await screen.findByTestId('feedback-sent');
    act(() => { store.getState().toggleFeedback(false); });
    act(() => { store.getState().toggleFeedback(true); });
    expect(screen.getByTestId('feedback-kind-bug').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('feedback-text') as HTMLTextAreaElement).value).toBe('');
    unmount();
  } finally {
    vi.unstubAllGlobals();
  }
});
