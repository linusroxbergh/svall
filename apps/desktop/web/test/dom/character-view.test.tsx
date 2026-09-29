// @vitest-environment jsdom
import './setup.js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { setAppStore } from '../../src/hooks.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { chr, fleet } from '../fixtures.js';

const call = vi.fn(() => Promise.resolve({}));
const fire = vi.fn();
vi.mock('../../src/mobile/boot.js', () => ({
  phone: { api: () => ({ call, fire }), onTermEvent: () => () => {} },
}));
// xterm measures a real screen; the pane under test is the ask, not the terminal
const open = vi.fn(() => Promise.resolve());
vi.mock('../../src/mobile/term.js', () => ({
  linkTerminal: () => ({ input: () => {}, resize: () => {}, open: () => open(), close: () => {} }),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon(): void {}
    open(): void {}
    onData(): void {}
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

const { CharacterView } = await import('../../src/mobile/CharacterView.js');
const { App } = await import('../../src/mobile/App.js');

const blockedFleet = (prompt = 'Run rm -rf?', promptId = 'q1') => {
  const f = fleet();
  f.characters.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { agent: { kind: 'claude', sessionId: 's', status: 'blocked', prompt, promptId, lastActivityAt: 0 } });
  return f;
};

let store: AppStore;

beforeEach(() => {
  call.mockClear();
  fire.mockClear();
  open.mockClear();
  sessionStorage.clear();
  store = createAppStore();
  setAppStore(store);
});

test('a blocked character shows what it is waiting on', () => {
  store.getState().setFleet(blockedFleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  expect(screen.getByRole('status').textContent).toContain('Run rm -rf?');
});

test('approve answers the daemon for that character', () => {
  store.getState().setFleet(blockedFleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  expect(call).toHaveBeenCalledWith('char.answer', { id: 'c2', answer: 'approve', promptId: 'q1' });
});

test('deny answers the daemon for that character', () => {
  store.getState().setFleet(blockedFleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(call).toHaveBeenCalledWith('char.answer', { id: 'c2', answer: 'deny', promptId: 'q1' });
});

test('an answer in flight refuses a second tap', () => {
  store.getState().setFleet(blockedFleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(call).toHaveBeenCalledTimes(1);
});

test('a new question takes its own answer, even while one for the last is in flight', () => {
  call.mockImplementationOnce(() => new Promise(() => {}));
  store.getState().setFleet(blockedFleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  act(() => { store.getState().setFleet(blockedFleet('Run it again?', 'q2')); });
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  expect(call).toHaveBeenLastCalledWith('char.answer', { id: 'c2', answer: 'approve', promptId: 'q2' });
});

test('a character that is not blocked is asked nothing', () => {
  store.getState().setFleet(fleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  expect(screen.queryByRole('status')).toBeNull();
});

test('the header names the character and its island', () => {
  store.getState().setFleet(fleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  expect(screen.getByText('alpha')).toBeTruthy();
  expect(screen.getByRole('button', { name: '‹ fleet' })).toBeTruthy();
});

test('a character that left the fleet reads as gone', () => {
  store.getState().setFleet(fleet());
  render(<CharacterView id="c9" onBack={() => {}} />);
  expect(screen.getAllByText('gone').length).toBeGreaterThan(0);
});

test('a prompt is sent to the character and the field cleared', () => {
  store.getState().setFleet(fleet());
  render(<CharacterView id="c2" onBack={() => {}} />);
  const field = screen.getByPlaceholderText('prompt…');
  fireEvent.change(field, { target: { value: 'go on' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  expect(call).toHaveBeenCalledWith('char.run', { id: 'c2', text: 'go on', enter: true });
  expect((field as HTMLTextAreaElement).value).toBe('');
});

test('a prompt the fleet does not take comes back to the field, with the reason', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementationOnce(() => Promise.reject(new Error('svalld offline')));
  render(<CharacterView id="c2" onBack={() => {}} />);
  const field = screen.getByPlaceholderText('prompt…') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'please fix the failing test' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await act(async () => {});
  expect(field.value).toBe('please fix the failing test');
  expect(screen.getByText('svalld offline')).toBeTruthy();
});

test('opening a dormant character wakes it before its terminal attaches', async () => {
  const f = fleet();
  f.characters.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { tmux: undefined });
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  render(<CharacterView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(call).toHaveBeenCalledWith('char.revive', { id: 'c2' });
  expect(open).toHaveBeenCalled();
});

test('a wake the fleet refuses says why beside the revive button', async () => {
  const f = fleet();
  f.characters.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { tmux: undefined });
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  call.mockImplementationOnce(() => Promise.reject(new Error('its directory is gone')));
  render(<CharacterView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText('its directory is gone')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'revive' })).toBeTruthy();
});

test('a terminal that closes while open offers the revive button', async () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
  render(<CharacterView id="c2" onBack={() => {}} />);
  await act(async () => {});
  const f = fleet();
  delete f.characters.c2.tmux;
  act(() => store.getState().setFleet(f));
  expect(screen.getByRole('button', { name: 'revive' })).toBeTruthy();
});

test('the header says the phone has lost svalld rather than what the character is doing', () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('offline');
  const { container } = render(<CharacterView id="c2" onBack={() => {}} />);
  expect(container.querySelector('.conn')?.textContent).toBe('offline');
});

// the page reloads itself once svalld speaks a newer protocol
test('a prompt not yet sent is still in the field after the page reloads', () => {
  store.getState().setFleet(fleet());
  const { unmount } = render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('prompt…'), { target: { value: 'half a prompt' } });
  unmount();
  render(<CharacterView id="c2" onBack={() => {}} />);
  expect((screen.getByPlaceholderText('prompt…') as HTMLTextAreaElement).value).toBe('half a prompt');
});

test('a prompt sent is not brought back by a reload', () => {
  store.getState().setFleet(fleet());
  const { unmount } = render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('prompt…'), { target: { value: 'go on' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  unmount();
  render(<CharacterView id="c2" onBack={() => {}} />);
  expect((screen.getByPlaceholderText('prompt…') as HTMLTextAreaElement).value).toBe('');
});

test('the reason a prompt was not sent goes once svalld is back', async () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('offline');
  call.mockImplementationOnce(() => Promise.reject(new Error('svalld offline')));
  render(<CharacterView id="c2" onBack={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('prompt…'), { target: { value: 'go on' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await act(async () => {});
  expect(screen.getByText('svalld offline')).toBeTruthy();
  act(() => store.getState().setStatus('online'));
  expect(screen.queryByText('svalld offline')).toBeNull();
});

test('the context button opens the character\'s card', () => {
  store.getState().setFleet(fleet());
  render(<CharacterView id="c0" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'context ›' }));
  expect(screen.getByRole('dialog', { name: 'c0' })).toBeTruthy();
});

test('a note being typed is saved when the back gesture takes the view away', () => {
  history.replaceState(null, '', '/char/c0');
  store.getState().setFleet(fleet());
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'context ›' }));
  const note = screen.getByLabelText('Note');
  note.focus();
  fireEvent.change(note, { target: { value: 'new note' } });
  history.replaceState(null, '', '/');
  act(() => { dispatchEvent(new PopStateEvent('popstate')); });
  expect(screen.queryByLabelText('Note')).toBeNull();
  expect(call).toHaveBeenCalledWith('char.update', { id: 'c0', note: 'new note' });
});
