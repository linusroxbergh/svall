// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '@svall/protocol';
import { bridge, freshStore, sent, store } from './harness.js';

bridge.present = true;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { Toast } = await import('../../src/Toast.js');
const { theme } = await import('../../src/theme.js');

beforeEach(() => {
  freshStore();
  // jsdom lays nothing out, and a hole that measures as nothing is left out
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 26, top: 700, width: 200, height: 40 } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const sheet = (f: string) => fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8');
const layer = (name: string) => Number(sheet('tokens.css').match(new RegExp(`--z-${name}: (\\d+)`))?.[1]);

test('a toast stands over every dialog\'s scrim', () => {
  expect(sheet('map/chrome.css')).toMatch(/\.toast \{[^}]*z-index: var\(--z-toast\)/);
  expect(sheet('modal.css')).toMatch(/\.modal-back \{[^}]*z-index: var\(--z-modal\)/);
  expect(layer('toast')).toBeGreaterThan(layer('modal'));
});

const last = () => sent.filter((m) => m.type === 'shell.cutout').at(-1);
const hole = { x: 26, y: 700, width: 200, height: 40 };

test('an ok toast with nothing to press shows through the terminal and leaves the presses there to it', () => {
  render(<Toast />);
  act(() => store.getState().showToast('Copied', 'ok'));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [hole] });
  act(() => store.getState().clearToast());
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
});

test('Dismiss takes the presses in its hole and clears the toast without running its action', () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const { getByTestId, queryByTestId } = render(<Toast />);
  act(() => store.getState().showToast('every robot starts in To do', 'ok', { label: 'Let the scribe place them', run }, true));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [hole], passive: [] });
  act(() => getByTestId('toast-dismiss').click());
  expect(getByTestId('toast').dataset.leaving).toBe('true');
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [] });
  act(() => { vi.advanceTimersByTime(theme.toastLeaveMs); });
  expect(queryByTestId('toast')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

test('a toast with an action takes the presses in its hole, and gives them back once it has none', () => {
  render(<Toast />);
  act(() => store.getState().showToast('Deleted plan', 'ok', { label: 'Undo', run() {} }));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [hole], passive: [] });
  act(() => store.getState().showToast('Copied', 'ok'));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [], passive: [hole] });
});

test('an error toast takes the presses in its hole, so its words can be selected over a terminal, and offers Dismiss', () => {
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  expect(last()).toEqual({ type: 'shell.cutout', rects: [hole], passive: [] });
  expect(getByTestId('toast-text').textContent).toBe('no such file');
  act(() => getByTestId('toast-dismiss').click());
  expect(store.getState().toast).toBeUndefined();
});

test('an ok toast offers no Dismiss of its own', () => {
  const { queryByTestId } = render(<Toast />);
  act(() => store.getState().showToast('Copied', 'ok'));
  expect(queryByTestId('toast-dismiss')).toBeNull();
});

const after = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

test('an ok toast stands as long as it always has, with or without something to take back', () => {
  vi.useFakeTimers();
  render(<Toast />);
  act(() => store.getState().showToast('Copied', 'ok'));
  after(theme.toastMs - 1);
  expect(store.getState().toast).toBeDefined();
  after(1);
  expect(store.getState().toast).toBeUndefined();
  act(() => store.getState().showToast('Deleted plan', 'ok', { label: 'Undo', run() {} }));
  after(theme.toastActionMs - 1);
  expect(store.getState().toast).toBeDefined();
  after(1);
  expect(store.getState().toast).toBeUndefined();
});

test('an error toast stands clearly longer than any ok toast', () => {
  vi.useFakeTimers();
  render(<Toast />);
  expect(theme.toastErrorMs).toBeGreaterThan(theme.toastActionMs);
  act(() => store.getState().showToast('no such file'));
  after(theme.toastErrorMs - 1);
  expect(store.getState().toast).toBeDefined();
  after(1);
  expect(store.getState().toast).toBeUndefined();
});

test('an error toast waits while the pointer is over it, and has its whole time again once the pointer leaves', () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  fireEvent.pointerEnter(getByTestId('toast'));
  after(theme.toastErrorMs * 3);
  expect(store.getState().toast).toBeDefined();
  fireEvent.pointerLeave(getByTestId('toast'));
  after(theme.toastErrorMs - 1);
  expect(store.getState().toast).toBeDefined();
  after(1);
  expect(store.getState().toast).toBeUndefined();
});

test('a press holds an error toast as the pointer over it does, until the pointer leaves', () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  fireEvent.pointerDown(getByTestId('toast-text'));
  after(theme.toastErrorMs * 3);
  expect(store.getState().toast).toBeDefined();
  fireEvent.pointerLeave(getByTestId('toast'));
  after(theme.toastErrorMs);
  expect(store.getState().toast).toBeUndefined();
});

test('an ok toast does not wait for the pointer', () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('Deleted plan', 'ok', { label: 'Undo', run() {} }));
  fireEvent.pointerEnter(getByTestId('toast'));
  after(theme.toastActionMs);
  expect(store.getState().toast).toBeUndefined();
});

test('a toast dismissed under the pointer, which never saw it leave, does not hold up the next', () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  fireEvent.pointerEnter(getByTestId('toast'));
  act(() => getByTestId('toast-dismiss').click());
  after(theme.toastLeaveMs);
  act(() => store.getState().showToast('no such file either'));
  after(theme.toastErrorMs);
  expect(store.getState().toast).toBeUndefined();
});

test('an error shows its sentence, and Copy details copies what a tool said after it, then says it did for a moment', () => {
  vi.useFakeTimers();
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast('the phone link could not start: Command failed: tailscale serve --bg 8443\nAccess denied'));
  expect(getByTestId('toast-text').textContent).toBe('the phone link could not start');
  expect(getByTestId('toast-dismiss')).toBeTruthy();
  sent.length = 0;
  act(() => getByTestId('toast-copy').click());
  expect(sent).toContainEqual({ type: 'copy', text: 'Command failed: tailscale serve --bg 8443\nAccess denied' });
  expect(store.getState().toast).toBeDefined();
  expect(getByTestId('toast-copy').textContent).toBe('Copied');
  after(1499);
  expect(getByTestId('toast-copy').textContent).toBe('Copied');
  after(1);
  expect(getByTestId('toast-copy').textContent).toBe('Copy details');
  act(() => getByTestId('toast-copy').click());
  act(() => store.getState().showToast('studio is not reachable: ssh: connect to host studio port 22: Connection refused'));
  expect(getByTestId('toast-text').textContent).toBe('studio is not reachable');
  expect(getByTestId('toast-copy').textContent).toBe('Copy details');
});

test('a daemon\'s refusal shows its sentence whole, and Copy details copies what the tool said as the daemon sent it apart', () => {
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast(new ApiError('internal', 'Claude Code did not update', { raw: 'claude update exited 1: token=abcdef1234567890 refused' })));
  expect(getByTestId('toast-text').textContent).toBe('Claude Code did not update');
  sent.length = 0;
  act(() => getByTestId('toast-copy').click());
  expect(sent).toContainEqual({ type: 'copy', text: 'claude update exited 1: token=… refused' });
});

test('an error with no tool\'s words offers nothing to copy, and any other toast is shown whole', () => {
  const { getByTestId, queryByTestId } = render(<Toast />);
  act(() => store.getState().showToast('no such file'));
  expect(queryByTestId('toast-copy')).toBeNull();
  act(() => store.getState().showToast('Copied: Command failed: nothing', 'ok'));
  expect(getByTestId('toast-text').textContent).toBe('Copied: Command failed: nothing');
  expect(queryByTestId('toast-copy')).toBeNull();
});

test('a fact stands as long as a toast with an action, in a look of its own', () => {
  vi.useFakeTimers();
  const { getByTestId, queryByTestId } = render(<Toast />);
  act(() => store.getState().showToast('notes.md is on studio; the editor cannot show it.', 'info'));
  expect(getByTestId('toast').dataset.tone).toBe('info');
  expect(queryByTestId('toast-dismiss')).toBeNull();
  after(theme.toastActionMs - 1);
  expect(store.getState().toast).toBeDefined();
  after(1);
  expect(store.getState().toast).toBeUndefined();
  expect(sheet('map/chrome.css')).toMatch(/\.toast\[data-tone="info"\] \{ background: var\(--panel-hi\); color: var\(--ink\); border: 1px solid var\(--line\); backdrop-filter: blur\(var\(--blur-panel\)\); \}/);
});

describe('the keys a press on an error toast takes from the terminal under it', () => {
  const ID = 'c1';
  const focuses = () => sent.filter((m) => m.type === 'term.focus');
  const pressed = () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const view = render(<Toast />);
    act(() => { store.getState().focus(ID); store.getState().showToast('no such file'); });
    sent.length = 0;
    fireEvent.pointerDown(view.getByTestId('toast-text'));
    fireEvent.pointerLeave(view.getByTestId('toast'));
    return view;
  };

  test('go back when it times out', () => {
    pressed();
    after(theme.toastErrorMs);
    expect(focuses()).toEqual([{ type: 'term.focus', id: ID }]);
  });

  test('go back when it is dismissed, however the press left the focus on its button', () => {
    const { getByTestId } = pressed();
    getByTestId('toast-dismiss').focus();
    act(() => getByTestId('toast-dismiss').click());
    expect(focuses()).toEqual([{ type: 'term.focus', id: ID }]);
  });

  test('stay with a field the user has moved them to', () => {
    pressed();
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    after(theme.toastErrorMs);
    field.remove();
    expect(focuses()).toEqual([]);
  });

  test('stay with a surface the user has pressed since', () => {
    pressed();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    after(theme.toastErrorMs);
    expect(focuses()).toEqual([]);
  });

  test('are left alone by a toast nobody pressed', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<Toast />);
    act(() => { store.getState().focus(ID); store.getState().showToast('no such file'); });
    sent.length = 0;
    after(theme.toastErrorMs);
    expect(focuses()).toEqual([]);
  });

  test('are left to what its action opens', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { getByTestId } = render(<Toast />);
    act(() => { store.getState().focus(ID); store.getState().showToast('refused', 'error', { label: 'Check again', run() {} }); });
    sent.length = 0;
    fireEvent.pointerDown(getByTestId('toast-action'));
    act(() => getByTestId('toast-action').click());
    expect(focuses()).toEqual([]);
  });
});

test('a problem with a fix says the fix under its sentence, its command as code, and copies what the tool said', () => {
  const { getByTestId } = render(<Toast />);
  act(() => store.getState().showToast({ text: 'Tailscale on this Mac does not let Svall share this fleet', fix: 'Run once on this Mac: sudo tailscale set --operator=$USER', run: 'sudo tailscale set --operator=$USER', raw: 'Access denied' }));
  expect(getByTestId('toast').getAttribute('data-tone')).toBe('error');
  expect(getByTestId('toast-text').firstChild!.textContent).toBe('Tailscale on this Mac does not let Svall share this fleet');
  expect(getByTestId('toast-fix').textContent).toBe('Run once on this Mac: sudo tailscale set --operator=$USER');
  expect(getByTestId('toast-fix').querySelector('code')!.textContent).toBe('sudo tailscale set --operator=$USER');
  expect(getByTestId('toast-copy').textContent).toBe('Copy details');
});
