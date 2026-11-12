// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { contextKind, type MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, retryHome, store } from './harness.js';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
document.elementFromPoint ??= () => null;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { SideCard } = await import('../../src/SideCard.js');
const { Sidebar } = await import('../../src/Sidebar.js');
const { Board } = await import('../../src/Board.js');
const { EditorPane } = await import('../../src/resources/EditorPane.js');
const { boardRobotMenu, robotMenu } = await import('../../src/menus.js');
const { dispatchKey } = await import('../../src/keyboard.js');
const { ContextMenu } = await import('../../src/ContextMenu.js');
const { TerminalArea } = await import('../../src/TerminalArea.js');

const MAC = 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId;
const HOME = 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId;
const COPY = { machine: MAC, home: HOME, name: 'linus-vault' };
const FOLLOWING = { ...COPY, online: true as const };

// c0 runs on the home and c1 on this Mac; both starred, with a link to remove
beforeEach(() => {
  call.mockReset();
  retryHome.mockReset();
  call.mockImplementation((method: string) => Promise.resolve(method === 'robot.prompts' ? { prompts: [] } : method === 'resources.get' ? { sources: [] } : {}));
  freshStore();
  const f = fleet();
  f.robots.c1.machine = MAC;
  for (const c of [f.robots.c0, f.robots.c1]) {
    c.star = 0;
    c.context = [{ kind: contextKind('https://example.com'), ref: 'https://example.com', label: '', source: 'manual' }];
  }
  store.getState().setFleet(f);
  store.getState().setSection('robot.instructions', {});
});

const box = (testid: string) => screen.getByTestId(testid) as HTMLTextAreaElement;
const WHY = 'c0 runs on linus-vault, which is not reachable; you can change it once it answers.';
const told = () => { const text = store.getState().toast?.text; act(() => store.getState().clearToast()); return text; };
const press = { clientX: 0, clientY: 0, preventDefault() {} };
const BUTTONS = ['side-star', 'portrait-prev', 'portrait-next', 'side-agent-profile', 'side-close'];
const writes = () => call.mock.calls.filter(([m]) => /^robot\.(update|star|close|move|place|reorder)/.test(m));

test('the card of a far robot on the Mac\'s copy is read-only, says so, and says why at each try', async () => {
  act(() => store.getState().setVia(COPY));
  render(<SideCard id="c0" />);
  await act(async () => {});
  expect(screen.getByTestId('side-away-read-only').textContent).toBe('Read-only until it answers.');
  expect(screen.getByTestId('side-away').textContent).toContain('linus-vault is not reachable');
  for (const t of ['side-name', 'side-note', 'side-instructions']) {
    expect(box(t).readOnly).toBe(true);
    fireEvent.click(box(t));
    expect(told()).toBe(WHY);
    fireEvent.keyDown(box(t), { key: 'a' });
    expect(told()).toBe(WHY);
    fireEvent.keyDown(box(t), { key: 'a', repeat: true });
    fireEvent.keyDown(box(t), { key: 'Tab' });
    fireEvent.keyDown(box(t), { key: 'c', metaKey: true });
    expect(told()).toBeUndefined();
  }
  for (const t of BUTTONS) {
    expect(screen.getByTestId(t).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId(t));
    expect(told()).toBe(WHY);
  }
  expect(store.getState().closingRobot).toBeUndefined();
  expect(screen.queryByTestId('context-add')).toBeNull();
  expect(screen.queryByTestId('context-remove')).toBeNull();
  expect(writes()).toEqual([]);
});

test.each([
  ['a far robot while the window follows the home', 'c0', FOLLOWING],
  ['a robot on this Mac on the Mac\'s copy', 'c1', COPY],
  ['a robot on a Mac that is its own home', 'c0', undefined],
] as const)('the card of %s takes changes and says nothing', async (_name, id, via) => {
  act(() => store.getState().setVia(via));
  render(<SideCard id={id} />);
  await act(async () => {});
  expect(screen.queryByTestId('side-away-read-only')).toBeNull();
  for (const t of ['side-name', 'side-note', 'side-instructions']) {
    expect(box(t).readOnly).toBe(false);
    fireEvent.click(box(t));
    fireEvent.keyDown(box(t), { key: 'a' });
  }
  for (const t of BUTTONS) expect(screen.getByTestId(t).getAttribute('aria-disabled')).toBeNull();
  expect(screen.getByTestId('context-add')).toBeTruthy();
  expect(screen.getByTestId('context-remove')).toBeTruthy();
  fireEvent.click(screen.getByTestId('side-star'));
  expect(call).toHaveBeenCalledWith(expect.stringMatching(/^robot\./), expect.objectContaining({ id }));
  expect(store.getState().toast).toBeUndefined();
  fireEvent.click(screen.getByTestId('side-close'));
  expect(store.getState().closingRobot).toBe(id);
});

// what the home answered; the words of the card, pane, toast and tip; the card's read-only line; its kicker
const STATES: [Record<string, string>, string, string, string, string][] = [
  [{ state: 'unreachable' }, 'linus-vault is not reachable', 'is not reachable; you can change it once it answers.', 'Read-only until it answers.', 'unreachable'],
  [{ state: 'version', release: '0.27.0' }, 'linus-vault runs another version of Svall', 'runs another version of Svall; you can change it once both run the same.', 'Read-only until both run the same.', 'read-only'],
  [{ state: 'version', detail: 'linus-vault answered with protocol 7, not 8' }, 'linus-vault cannot run this Mac\'s Svall', 'cannot run this Mac\'s Svall; you can change it once it runs this Mac\'s Svall.', 'Read-only until it runs this Mac\'s Svall.', 'read-only'],
  [{ state: 'version' }, 'linus-vault runs another version of Svall', 'runs another version of Svall; you can change it once both run the same.', 'Read-only until both run the same.', 'read-only'],
  [{ state: 'auth' }, 'this Mac cannot log in to linus-vault', 'this Mac cannot log in to; you can change it once this Mac can log in.', 'Read-only until this Mac can log in.', 'read-only'],
  [{ state: 'mismatch' }, 'linus-vault holds a different fleet', 'holds a different fleet; you can change it once it holds the fleet this Mac expects.', 'Read-only until it holds the fleet this Mac expects.', 'read-only'],
  [{ state: 'machine' }, 'linus-vault is a different machine than this Mac expects', 'is a different machine than this Mac expects; you can change it once it is the machine this Mac expects.', 'Read-only until it is the machine this Mac expects.', 'read-only'],
];
const GPU = 'a1b2c3d4-0000-4000-8000-000000000003' as MachineId;

// c0 runs on the home; c2 on a third machine, which this Mac reaches through the home and so waits on it
test.each(STATES.flatMap((row) => [['c0', 'linus-vault', 'linus-vault', ...row], ['c2', 'gpu-box, reached through linus-vault', 'gpu-box', ...row]]))(
  'on the Mac\'s copy %s, on %s, which is %s, says why with the home %o on the card, the pane, the toast and the tip', async (id, on, _machine, home, line, which, readOnly, kicker) => {
    const f = store.getState().fleet;
    act(() => {
      store.getState().setFleet({ ...f, machines: { ...f.machines, [GPU]: { name: 'gpu-box', reachable: true, since: 0 } }, robots: { ...f.robots, c2: { ...f.robots.c2, machine: GPU } } });
      store.getState().setVia(COPY);
      store.getState().setHome({ name: 'linus-vault', ...(home as { state: 'unreachable' }) });
    });
    const answers: Record<string, unknown> = { 'term.lastScreen': { text: '$ ls' }, 'robot.prompts': { prompts: [] }, 'resources.get': { sources: [] }, 'machines.setup': { rows: [] } };
    call.mockImplementation((method: string) => Promise.resolve(answers[method] ?? {}));
    render(<><SideCard id={id} /><TerminalArea id={id} /></>);
    await act(async () => {});
    // the home is what does not answer, so it is the home that is tried again, not the robot's machine checked
    expect(screen.getByTestId('side-away').textContent).toBe(`${line}${readOnly}Try again`);
    expect(screen.queryByTestId('side-away-run')).toBeNull();
    fireEvent.click(screen.getByTestId('side-away-retry'));
    expect(retryHome).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.kicker')!.textContent).toBe(kicker);
    expect(screen.getByTestId('terminal-unreachable').textContent).toBe(line);
    fireEvent.click(screen.getByTestId('side-star'));
    expect(told()).toBe(`${id} runs on ${on}, which ${which}`);
    robotMenu(press, id, () => {});
    expect(store.getState().menu!.items.find((i) => i.title === 'Delete')!.tip).toBe(`${id} runs on ${on}, which ${which}`);
  });

test('a far robot\'s island and held message take no change on the Mac\'s copy and say why, and a Mac robot\'s do', async () => {
  const f = store.getState().fleet;
  const held = { n: 3, held: 'p_1' };
  act(() => {
    store.getState().setFleet({ ...f, robots: { ...f.robots, c0: { ...f.robots.c0, relayed: held }, c1: { ...f.robots.c1, relayed: held } } });
    store.getState().setVia(COPY);
  });
  const { unmount } = render(<SideCard id="c0" />);
  await act(async () => {});
  const island = screen.getByTestId('side-island');
  expect(island.getAttribute('aria-disabled')).toBe('true');
  fireEvent.mouseDown(island);
  expect(told()).toBe(WHY);
  fireEvent.change(island, { target: { value: 'i_a' } });
  expect(told()).toBe(WHY);
  for (const t of ['side-held-let', 'side-held-drop']) {
    expect(screen.getByTestId(t).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId(t));
    expect(told()).toBe(WHY);
  }
  expect(call.mock.calls.filter(([m]) => m === 'robot.update' || m === 'robot.answer')).toEqual([]);
  unmount();
  render(<SideCard id="c1" />);
  await act(async () => {});
  expect(screen.getByTestId('side-island').getAttribute('aria-disabled')).toBeNull();
  fireEvent.change(screen.getByTestId('side-island'), { target: { value: 'i_a' } });
  fireEvent.click(screen.getByTestId('side-held-let'));
  expect(call).toHaveBeenCalledWith('robot.update', { id: 'c1', islandId: 'i_a' });
  expect(call).toHaveBeenCalledWith('robot.answer', { id: 'c1', answer: 'approve', promptId: 'p_1' });
  expect(told()).toBeUndefined();
});

test('the far robot\'s own field on the shelf is read-only and says why, and a Mac robot\'s is not', () => {
  act(() => store.getState().setVia(COPY));
  act(() => store.getState().showResourceField({ tier: 'robot', id: 'c0', field: 'note' }));
  const { unmount } = render(<EditorPane onClose={() => {}} />);
  expect(box('resources-field').readOnly).toBe(true);
  fireEvent.click(box('resources-field'));
  expect(told()).toBe(WHY);
  unmount();
  act(() => store.getState().showResourceField({ tier: 'robot', id: 'c1', field: 'note' }));
  render(<EditorPane onClose={() => {}} />);
  expect(box('resources-field').readOnly).toBe(false);
  fireEvent.click(box('resources-field'));
  expect(told()).toBeUndefined();
});

const drag = (testid: string): boolean => fireEvent.dragStart(screen.getByTestId(testid), { dataTransfer: { setData() {}, effectAllowed: '' } });

test('the sidebar refuses a far robot\'s drag and star in words, and lets a Mac robot\'s go', () => {
  act(() => store.getState().setVia(COPY));
  render(<Sidebar />);
  for (const t of ['sb-robot-c0', 'sb-star-c0']) {
    expect(drag(t)).toBe(false);
    expect(told()).toBe(WHY);
  }
  for (const t of ['sb-robot-c1', 'sb-star-c1']) {
    expect(drag(t)).toBe(true);
    expect(told()).toBeUndefined();
  }
  expect(screen.getByTestId('sb-robot-star-c0').getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(screen.getByTestId('sb-robot-star-c0'));
  expect(told()).toBe(WHY);
  expect(store.getState().selectedId).toBeUndefined();
  expect(screen.getByTestId('sb-robot-star-c1').getAttribute('aria-disabled')).toBeNull();
});

const items = () => store.getState().menu!.items.map((i) => [i.title, Boolean(i.run || i.items), i.tip]);
const ALLOWED = [['Open terminal', true, undefined], ['Rename', true, undefined], ['Unstar', true, undefined], ['Delete', true, undefined]];

test('a far robot\'s menu rows stand disabled and say why as a tip', () => {
  act(() => store.getState().setVia(COPY));
  robotMenu(press, 'c0', () => {});
  expect(items()).toEqual([['Open terminal', true, undefined], ['Rename', false, WHY], ['Unstar', false, WHY], ['Delete', false, WHY]]);
  render(<ContextMenu />);
  expect(screen.getByTestId('menu-delete').getAttribute('data-tip')).toBe(WHY);
  expect(screen.getByTestId('menu-delete').getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByTestId('menu-open terminal').getAttribute('data-tip')).toBeNull();
  boardRobotMenu(press, 'c0', () => {});
  expect(items()).toEqual([['Open terminal', true, undefined], ['Rename', false, WHY], ['Unstar', false, WHY], ['Move to', false, WHY], ['Let the scribe place it', false, WHY], ['Delete', false, WHY]]);
  robotMenu(press, 'c1', () => {});
  expect(items()).toEqual(ALLOWED);
  act(() => store.getState().setVia(FOLLOWING));
  robotMenu(press, 'c0', () => {});
  expect(items()).toEqual(ALLOWED);
});

const pointer = (type: string, x: number) => new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: x });
test('a board card lifts only where the fleet can take the move, and says why once where not', () => {
  act(() => store.setState({ view: 'board' }));
  act(() => store.getState().setVia(COPY));
  render(<Board />);
  const tried = (id: string) => {
    act(() => { screen.getByTestId(`kc-${id}`).dispatchEvent(pointer('pointerdown', 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 200)); });
    const lifted = screen.getByTestId(`kc-${id}`).dataset.dragging;
    const first = told();
    act(() => { window.dispatchEvent(pointer('pointermove', 210)); });
    const second = told();
    act(() => { window.dispatchEvent(pointer('pointerup', 210)); });
    return [lifted, first, second];
  };
  expect(tried('c1')).toEqual(['true', undefined, undefined]);
  expect(tried('c0')).toEqual(['false', WHY, undefined]);
});

test('the close key says why for a far robot on the Mac\'s copy, and asks for one on this Mac', async () => {
  const ctx = { store, api: { call } as never, bridge };
  act(() => store.getState().setVia(COPY));
  act(() => store.getState().select('c0'));
  await act(() => dispatchKey({ type: 'closeRobot' }, ctx));
  expect(store.getState().closingRobot).toBeUndefined();
  expect(told()).toBe(WHY);
  act(() => store.getState().select('c1'));
  await act(() => dispatchKey({ type: 'closeRobot' }, ctx));
  expect(store.getState().closingRobot).toBe('c1');
});
