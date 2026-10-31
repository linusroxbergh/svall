// @vitest-environment jsdom
import './setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MachineId } from '@svall/protocol';
import { setAppStore } from '../../src/hooks.js';
import { figureUrl } from '../../src/portraits.js';
import { createAppStore, type AppStore } from '../../src/store/index.js';
import { chr, fleet } from '../fixtures.js';

const call = vi.fn(() => Promise.resolve({}));
const fire = vi.fn();
vi.mock('../../src/mobile/boot.js', () => ({
  phone: { api: () => ({ call, fire }), get store() { return store; }, onTermEvent: () => () => {} },
}));
// xterm measures a real screen; the pane under test is the ask, not the terminal
const open = vi.fn(() => Promise.resolve());
const input = vi.fn();
const resize = vi.fn();
vi.mock('../../src/mobile/term.js', () => ({
  linkTerminal: () => ({ input: (d: string) => input(d), resize: () => resize(), open: () => open(), close: () => {} }),
}));
// the last terminal the view made, on the alternate screen of an app tracking the mouse, and what was painted on it
let xterm: { element: HTMLElement; typed(d: string): void; painted: string[] };
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { type: 'alternate' } };
    modes = { mouseTrackingMode: 'any' };
    element = document.createElement('div');
    typed: (d: string) => void = () => {};
    painted: string[] = [];
    constructor() { xterm = this; }
    reset(): void { this.painted = []; }
    write(d: string): void { this.painted.push(d); }
    loadAddon(): void {}
    open(host: HTMLElement): void { host.append(this.element); }
    onData(h: (d: string) => void): void { this.typed = h; }
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

const { RobotView } = await import('../../src/mobile/RobotView.js');
const { App } = await import('../../src/mobile/App.js');

const blockedFleet = (prompt = 'Run rm -rf?', promptId = 'q1') => {
  const f = fleet();
  f.robots.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { agent: { kind: 'claude', sessionId: 's', status: 'blocked', prompt, promptId, lastActivityAt: 0 } });
  return f;
};

let store: AppStore;

beforeEach(() => {
  call.mockClear();
  fire.mockClear();
  open.mockClear();
  input.mockClear();
  resize.mockClear();
  sessionStorage.clear();
  store = createAppStore();
  setAppStore(store);
});

test('a blocked robot shows what it is waiting on', () => {
  store.getState().setFleet(blockedFleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  expect(screen.getByRole('status').textContent).toContain('Run rm -rf?');
});

test('approve answers the daemon for that robot', () => {
  store.getState().setFleet(blockedFleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  expect(call).toHaveBeenCalledWith('robot.answer', { id: 'c2', answer: 'approve', promptId: 'q1' });
});

test('deny answers the daemon for that robot', () => {
  store.getState().setFleet(blockedFleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(call).toHaveBeenCalledWith('robot.answer', { id: 'c2', answer: 'deny', promptId: 'q1' });
});

test('a question dialog offers select and cancel, since Enter picks the highlighted option', () => {
  const f = blockedFleet('Claude needs your permission');
  f.robots.c2.agent!.askedTool = 'AskUserQuestion';
  store.getState().setFleet(f);
  render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'select' }));
  expect(call).toHaveBeenCalledWith('robot.answer', { id: 'c2', answer: 'approve', promptId: 'q1' });
  expect(screen.getByRole('button', { name: 'cancel' })).toBeTruthy();
});

test('an answer in flight refuses a second tap', () => {
  store.getState().setFleet(blockedFleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  expect(call).toHaveBeenCalledTimes(1);
});

test('a new question takes its own answer, even while one for the last is in flight', () => {
  call.mockImplementationOnce(() => new Promise(() => {}));
  store.getState().setFleet(blockedFleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  act(() => { store.getState().setFleet(blockedFleet('Run it again?', 'q2')); });
  fireEvent.click(screen.getByRole('button', { name: 'approve' }));
  expect(call).toHaveBeenLastCalledWith('robot.answer', { id: 'c2', answer: 'approve', promptId: 'q2' });
});

test('a robot that is not blocked is asked nothing', () => {
  store.getState().setFleet(fleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  expect(screen.queryByRole('status')).toBeNull();
});

test('the header names the robot and its island', () => {
  store.getState().setFleet(fleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  expect(screen.getByText('alpha')).toBeTruthy();
  expect(screen.getByRole('button', { name: '‹ fleet' })).toBeTruthy();
});

test('a robot that left the fleet reads as gone', () => {
  store.getState().setFleet(fleet());
  render(<RobotView id="c9" onBack={() => {}} />);
  expect(screen.getAllByText('gone').length).toBeGreaterThan(0);
});

test('a prompt is sent to the robot and the field cleared', () => {
  store.getState().setFleet(fleet());
  render(<RobotView id="c2" onBack={() => {}} />);
  const field = screen.getByPlaceholderText('prompt…');
  fireEvent.change(field, { target: { value: 'go on' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  expect(call).toHaveBeenCalledWith('robot.run', { id: 'c2', text: 'go on', enter: true });
  expect((field as HTMLTextAreaElement).value).toBe('');
});

test('a prompt the fleet does not take comes back to the field, with the reason', async () => {
  store.getState().setFleet(fleet());
  call.mockImplementationOnce(() => Promise.reject(new Error('svalld offline')));
  render(<RobotView id="c2" onBack={() => {}} />);
  const field = screen.getByPlaceholderText('prompt…') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'please fix the failing test' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await act(async () => {});
  expect(field.value).toBe('please fix the failing test');
  expect(screen.getByText('svalld offline')).toBeTruthy();
});

test('opening a dormant robot wakes it before its terminal attaches', async () => {
  const f = fleet();
  f.robots.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { tmux: undefined });
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(call).toHaveBeenCalledWith('robot.revive', { id: 'c2' });
  expect(open).toHaveBeenCalled();
});

test('a wake the fleet refuses says why beside the revive button', async () => {
  const f = fleet();
  f.robots.c2 = chr('c2', 'i_a', { x: 1, y: 1 }, { tmux: undefined });
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  call.mockImplementationOnce(() => Promise.reject(new Error('its directory is gone')));
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText('its directory is gone')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'revive' })).toBeTruthy();
});

test('a terminal that closes while open offers the revive button', async () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  const f = fleet();
  delete f.robots.c2.tmux;
  act(() => store.getState().setFleet(f));
  expect(screen.getByRole('button', { name: 'revive' })).toBeTruthy();
});

test('the header says the phone has lost svalld rather than what the robot is doing', () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('offline');
  const { container } = render(<RobotView id="c2" onBack={() => {}} />);
  expect(container.querySelector('.conn')?.textContent).toBe('offline');
});

// the page reloads itself once svalld speaks a newer protocol
test('a prompt not yet sent is still in the field after the page reloads', () => {
  store.getState().setFleet(fleet());
  const { unmount } = render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('prompt…'), { target: { value: 'half a prompt' } });
  unmount();
  render(<RobotView id="c2" onBack={() => {}} />);
  expect((screen.getByPlaceholderText('prompt…') as HTMLTextAreaElement).value).toBe('half a prompt');
});

test('a prompt sent is not brought back by a reload', () => {
  store.getState().setFleet(fleet());
  const { unmount } = render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('prompt…'), { target: { value: 'go on' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  unmount();
  render(<RobotView id="c2" onBack={() => {}} />);
  expect((screen.getByPlaceholderText('prompt…') as HTMLTextAreaElement).value).toBe('');
});

test('the reason a prompt was not sent goes once svalld is back', async () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('offline');
  call.mockImplementationOnce(() => Promise.reject(new Error('svalld offline')));
  render(<RobotView id="c2" onBack={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('prompt…'), { target: { value: 'go on' } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await act(async () => {});
  expect(screen.getByText('svalld offline')).toBeTruthy();
  act(() => store.getState().setStatus('online'));
  expect(screen.queryByText('svalld offline')).toBeNull();
});

test('the context button opens the robot\'s card', () => {
  store.getState().setFleet(fleet());
  render(<RobotView id="c0" onBack={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'context ›' }));
  expect(screen.getByRole('dialog', { name: 'c0' })).toBeTruthy();
});

test('a note being typed is saved when the back gesture takes the view away', () => {
  history.replaceState(null, '', '/robot/c0');
  store.getState().setFleet(fleet());
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'context ›' }));
  const note = screen.getByLabelText('Note');
  note.focus();
  fireEvent.change(note, { target: { value: 'new note' } });
  history.replaceState(null, '', '/');
  act(() => { dispatchEvent(new PopStateEvent('popstate')); });
  expect(screen.queryByLabelText('Note')).toBeNull();
  expect(call).toHaveBeenCalledWith('robot.update', { id: 'c0', note: 'new note' });
});

test('the header words a blocked robot as the list does', () => {
  store.getState().setFleet(blockedFleet());
  store.getState().setStatus('online');
  const { container } = render(<RobotView id="c2" onBack={() => {}} />);
  expect(container.querySelector('.conn')?.textContent).toBe('needs you');
});

test('the header says unknown for a robot on a worker out of reach', () => {
  const f = blockedFleet();
  const vault = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
  f.machines = { [vault]: { name: 'linus-vault', reachable: false, since: 0 } };
  f.robots.c2.machine = vault;
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  const { container } = render(<RobotView id="c2" onBack={() => {}} />);
  expect(container.querySelector('.conn')?.textContent).toBe('unknown');
  expect(container.querySelector('.conn')?.getAttribute('data-status')).toBe('unknown');
});

const vault = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const onVault = (reachable: boolean, mismatch?: true) => {
  const f = fleet();
  f.machines = { [vault]: { name: 'linus-vault', reachable, since: 0, ...(mismatch && { mismatch }) } };
  f.robots.c2.machine = vault;
  return f;
};

test('the phone shows "<machine> is not reachable" over a placed robot\'s terminal while the home has lost it', () => {
  store.getState().setFleet(onVault(false));
  render(<RobotView id="c2" onBack={() => {}} />);
  expect(screen.getByRole('status').textContent).toBe('linus-vault is not reachable');
  act(() => store.getState().setFleet(onVault(true)));
  expect(screen.queryByTestId('phone-unreachable')).toBeNull();
});

test('a phone opening a placed robot while its worker is away shows the last screen the home saw under the sentence, and opens the terminal once it is back', async () => {
  store.getState().setFleet(onVault(false));
  store.getState().setStatus('online');
  call.mockResolvedValueOnce({ text: '$ make test\r\nok', at: 1 });
  const { container } = render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(call).toHaveBeenCalledWith('term.lastScreen', { id: 'c2' });
  expect(xterm.painted).toEqual(['$ make test\r\nok']);
  expect(open).not.toHaveBeenCalled();
  expect(container.querySelector('.failed')).toBeNull();
  expect(screen.getByTestId('phone-unreachable').textContent).toBe('linus-vault is not reachable');
  await act(async () => { store.getState().setFleet(onVault(true)); });
  expect(open).toHaveBeenCalledTimes(1);
});

test('a robot that lands on another machine while open streams again once its window is up there', async () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(open).toHaveBeenCalledTimes(1);
  // the move rests it here and lands it on linus-vault, dormant until it starts there
  const landed = onVault(true);
  delete landed.robots.c2.tmux;
  act(() => store.getState().setFleet(landed));
  expect(open).toHaveBeenCalledTimes(1);
  const started = onVault(true);
  started.robots.c2.tmux = { windowId: '@7', paneId: '%7' };
  await act(async () => { store.getState().setFleet(started); });
  expect(open).toHaveBeenCalledTimes(2);
  expect(call).not.toHaveBeenCalledWith('robot.revive', { id: 'c2' });
  expect(screen.queryByText('The terminal closed.')).toBeNull();
});

test('the key row and the terminal\'s size go nowhere while its worker is away, and go again once it is back', () => {
  store.getState().setFleet(onVault(false));
  render(<RobotView id="c2" onBack={() => {}} />);
  const esc = screen.getByRole('button', { name: 'esc' }) as HTMLButtonElement;
  const more = screen.getByRole('button', { name: 'More keys' }) as HTMLButtonElement;
  expect(esc.disabled).toBe(true);
  expect(more.disabled).toBe(true);
  act(() => store.getState().setFleet(onVault(true)));
  expect(esc.disabled).toBe(false);
  fireEvent.click(esc);
  expect(input).toHaveBeenCalledWith('\x1b');
  fireEvent.click(more);
  fireEvent.click(screen.getByRole('button', { name: 'Larger text' }));
  expect(resize).toHaveBeenCalledTimes(1);
  // a shell's sheet has the terminal keys alone; one sends and the sheet goes
  expect(screen.queryByText('Claude Code')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /clear the screen/ }));
  expect(input).toHaveBeenCalledWith('\x0c');
  expect(screen.queryByRole('dialog', { name: 'Keys' })).toBeNull();
});

test('the phone names the upgrade over a placed robot\'s terminal while its worker runs another build', () => {
  store.getState().setFleet(onVault(false, true));
  render(<RobotView id="c2" onBack={() => {}} />);
  expect(screen.getByTestId('phone-unreachable').textContent).toBe('linus-vault runs a different build; upgrade it under Machines');
});

test('a robot closed while it is open takes its view back to the list', () => {
  history.replaceState(null, '', '/robot/c0');
  store.getState().setFleet(fleet());
  render(<App />);
  const f = fleet();
  delete f.robots.c0;
  act(() => store.getState().setFleet(f));
  expect(location.pathname).toBe('/');
  expect(screen.getByRole('button', { name: 'beta' })).toBeTruthy();
});

// the list's portraits are in the page before the path goes back to the root, and keep the URL they resolved to then
test('a portrait resolves from the root on a page opened at a robot', () => {
  const page = fs.readFileSync(path.join(__dirname, '../../mobile.html'), 'utf8');
  const head = document.head.innerHTML;
  document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(page)![1];
  try {
    history.replaceState(null, '', '/robot/c0');
    expect(new URL(figureUrl(1), document.baseURI).pathname).toBe('/robots/robot-01.svg');
  } finally {
    document.head.innerHTML = head;
  }
});

test('a drag over an app on the alternate screen wheels it, and a tap reaches it as nothing', async () => {
  store.getState().setFleet(fleet());
  const { container } = render(<RobotView id="c2" onBack={() => {}} />);
  const wheels: number[] = [];
  xterm.element.addEventListener('wheel', (e) => { wheels.push(e.deltaY); });
  const touch = (type: string, clientY: number) => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, 'touches', { value: [{ clientY }] });
    container.querySelector('.screen')!.dispatchEvent(e);
  };
  // two 16px lines up the screen
  touch('touchstart', 100);
  touch('touchmove', 68);
  expect(wheels).toEqual([1, 1]);

  xterm.typed('\x1b[<0;3;3M');
  xterm.typed('\x1b[<0;3;3m');
  xterm.typed('\x1b[<65;3;3M');
  xterm.typed('\x1b[<65;3;3M');
  await Promise.resolve();
  expect(input.mock.calls).toEqual([['\x1b[<65;3;3M\x1b[<65;3;3M']]);
});

test('a terminal that comes back under a new window shows it, not the closed message', async () => {
  store.getState().setFleet(fleet());
  store.getState().setStatus('online');
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  const f = fleet();
  f.robots.c2.tmux = { windowId: '@2', paneId: '%2' };
  act(() => store.getState().setFleet(f));
  expect(screen.queryByText('The terminal closed.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'revive' })).toBeNull();
});

const HOME = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId;
// linus-vault's copy of the fleet while the Mac does not answer: c2 runs at home, and asks
const throughVault = () => {
  const f = blockedFleet();
  f.machines = { [HOME]: { name: 'mac', reachable: false, since: 0 }, [vault]: { name: 'linus-vault', reachable: false, since: 0 } };
  store.getState().setFleet(f);
  store.getState().setStatus('online');
  store.getState().setVia({ machine: vault, home: HOME });
};

test('through a worker, a robot of the home says the home is asleep, asks nothing, and opens no terminal', async () => {
  throughVault();
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(screen.getByTestId('phone-unreachable').textContent).toBe('mac is asleep');
  expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

test('a robot running on the worker answers and streams there, whatever the stale fleet says of its link', async () => {
  throughVault();
  const f = store.getState().fleet;
  store.getState().setFleet({ ...f, robots: { ...f.robots, c2: { ...f.robots.c2, machine: vault } } });
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  expect(screen.queryByTestId('phone-unreachable')).toBeNull();
  expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy();
  expect(open).toHaveBeenCalledTimes(1);
});

test('a terminal open through a worker opens again once the Mac has the fleet back', async () => {
  throughVault();
  const f = store.getState().fleet;
  store.getState().setFleet({ ...f, robots: { ...f.robots, c2: { ...f.robots.c2, machine: vault } } });
  render(<RobotView id="c2" onBack={() => {}} />);
  await act(async () => {});
  await act(async () => { store.getState().setVia(undefined); store.getState().setFleet(onVault(true)); });
  expect(open).toHaveBeenCalledTimes(2);
});
