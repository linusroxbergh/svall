// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { contextKind, type MachineId } from '@svall/protocol';
import { fleet } from '../fixtures.js';
import { bridge, call, freshStore, store } from './harness.js';

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
document.elementFromPoint ??= () => null;
vi.mock('../../src/boot.js', async () => (await import('./harness.js')).bootModule());

const { SideCard } = await import('../../src/SideCard.js');
const { Sidebar } = await import('../../src/Sidebar.js');
const { Board } = await import('../../src/Board.js');
const { EditorPane } = await import('../../src/resources/EditorPane.js');
const { boardRobotMenu, robotMenu } = await import('../../src/menus.js');
const { dispatchKey } = await import('../../src/keyboard.js');

const MAC = 'a1b2c3d4-0000-4000-8000-000000000001' as MachineId;
const HOME = 'a1b2c3d4-0000-4000-8000-000000000002' as MachineId;
const COPY = { machine: MAC, home: HOME, name: 'linus-vault' };
const FOLLOWING = { ...COPY, online: true as const };

// c0 runs on the home and c1 on this Mac; both starred, with a link to remove
beforeEach(() => {
  call.mockReset();
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

const box = (testid: string) => screen.getByTestId(testid) as HTMLTextAreaElement & HTMLButtonElement;
const cardTakesChanges = () => ({
  fields: ['side-name', 'side-note', 'side-instructions'].map((t) => !box(t).readOnly),
  buttons: ['side-star', 'portrait-prev', 'portrait-next', 'side-close'].map((t) => !box(t).disabled),
  profile: !(screen.getByRole('combobox', { name: 'Agent profile' }) as HTMLButtonElement).disabled,
  addLink: screen.queryByTestId('context-add') !== null,
  removeLink: screen.queryByTestId('context-remove') !== null,
});
const ALL = { fields: [true, true, true], buttons: [true, true, true, true], profile: true, addLink: true, removeLink: true };
const NONE = { fields: [false, false, false], buttons: [false, false, false, false], profile: false, addLink: false, removeLink: false };

test.each([
  ['a far robot on the Mac\'s copy', 'c0', COPY, NONE],
  ['a far robot while the window follows the home', 'c0', FOLLOWING, ALL],
  ['a robot on this Mac on the Mac\'s copy', 'c1', COPY, ALL],
  ['a robot on a Mac that is its own home', 'c0', undefined, ALL],
] as const)('the card of %s', async (_name, id, via, want) => {
  act(() => store.getState().setVia(via));
  render(<SideCard id={id} />);
  await act(async () => {});
  expect(cardTakesChanges()).toEqual(want);
});

test('the far robot\'s own field on the shelf is read-only too, and an island\'s or a Mac robot\'s is not', async () => {
  act(() => store.getState().setVia(COPY));
  act(() => store.getState().showResourceField({ tier: 'robot', id: 'c0', field: 'note' }));
  const { unmount } = render(<EditorPane onClose={() => {}} />);
  expect(box('resources-field').readOnly).toBe(true);
  unmount();
  act(() => store.getState().showResourceField({ tier: 'robot', id: 'c1', field: 'note' }));
  render(<EditorPane onClose={() => {}} />);
  expect(box('resources-field').readOnly).toBe(false);
});

test('the sidebar drags and stars only what it can change', () => {
  act(() => store.getState().setVia(COPY));
  render(<Sidebar />);
  expect(['sb-robot-c0', 'sb-star-c0'].map((t) => screen.getByTestId(t).draggable)).toEqual([false, false]);
  expect(['sb-robot-c1', 'sb-star-c1'].map((t) => screen.getByTestId(t).draggable)).toEqual([true, true]);
  expect(box('sb-robot-star-c0').disabled).toBe(true);
  expect(box('sb-robot-star-c1').disabled).toBe(false);
});

const press = { clientX: 0, clientY: 0, preventDefault() {} };
const items = () => store.getState().menu!.items.map((i) => [i.title, Boolean(i.run || i.items)]);

test('a far robot\'s menus offer only opening its terminal', () => {
  act(() => store.getState().setVia(COPY));
  robotMenu(press, 'c0', () => {});
  expect(items()).toEqual([['Open terminal', true], ['Unstar', false], ['Delete', false]]);
  boardRobotMenu(press, 'c0', () => {});
  expect(items()).toEqual([['Open terminal', true], ['Rename', false], ['Unstar', false], ['Move to', false], ['Let the scribe place it', false], ['Delete', false]]);
  robotMenu(press, 'c1', () => {});
  expect(items()).toEqual([['Open terminal', true], ['Rename', true], ['Unstar', true], ['Delete', true]]);
  act(() => store.getState().setVia(FOLLOWING));
  robotMenu(press, 'c0', () => {});
  expect(items()).toEqual([['Open terminal', true], ['Rename', true], ['Unstar', true], ['Delete', true]]);
});

const pointer = (type: string, x: number) => new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: x });
test('a board card lifts only where the fleet can take the move', () => {
  act(() => store.setState({ view: 'board' }));
  act(() => store.getState().setVia(COPY));
  render(<Board />);
  const lifted = (id: string) => {
    act(() => { screen.getByTestId(`kc-${id}`).dispatchEvent(pointer('pointerdown', 10)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 200)); });
    const at = screen.getByTestId(`kc-${id}`).dataset.dragging;
    act(() => { window.dispatchEvent(pointer('pointerup', 200)); });
    return at;
  };
  expect(lifted('c1')).toBe('true');
  expect(lifted('c0')).toBe('false');
});

test('the close key leaves a far robot alone on the Mac\'s copy, and asks for one on this Mac', async () => {
  const ctx = { store, api: { call } as never, bridge };
  act(() => store.getState().setVia(COPY));
  act(() => store.getState().select('c0'));
  await act(() => dispatchKey({ type: 'closeRobot' }, ctx));
  expect(store.getState().closingRobot).toBeUndefined();
  act(() => store.getState().select('c1'));
  await act(() => dispatchKey({ type: 'closeRobot' }, ctx));
  expect(store.getState().closingRobot).toBe('c1');
});
