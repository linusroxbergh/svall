import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { FAKE_CLAUDE, expect, test, type Svall } from './fixtures.js';
import type { ToShell } from '../src/bridge.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTINGS_KEY } from '../src/store/index.js';

// a deleted default column comes back under a new id, so the specs find each by its name
const columns = async (svall: Svall): Promise<Record<string, string>> =>
  Object.fromEntries((await svall.api.call('state.get', {})).columns.map((k) => [k.name, k.id]));
const names = async (svall: Svall) => (await svall.api.call('state.get', {})).columns.map((k) => k.name);
const robotOf = async (svall: Svall, id: string) => (await svall.api.call('state.get', {})).robots[id];

// placing waits on the user's answer, as on a new or lifted fleet
async function askPlacing(svall: Svall): Promise<void> {
  await svall.stopDaemon();
  const file = path.join(svall.home, 'state.json');
  const { placingOff: _off, ...state } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...state, placingAsk: true }));
  await svall.startDaemon();
}

// this Mac has not had the board's one-time toast yet
const toastUnshown = (page: Page) => page.addInitScript(({ key, value }) => {
  if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
}, { key: SETTINGS_KEY, value: JSON.stringify({ ...DEFAULT_SETTINGS, zoom: 1 }) });

const placingState = async (svall: Svall) => { const s = await svall.api.call('state.get', {}); return [s.placingAsk, s.placingOff, s.scribeOff]; };

async function dragTo(page: Page, from: string, to: string): Promise<void> {
  const a = (await page.getByTestId(from).boundingBox())!, b = (await page.getByTestId(to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + 160, { steps: 8 });
}

test('draws the fleet in its columns, follows agent status, and a click selects as on the map', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('board') });
  const shell = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const agent = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'agent', command: FAKE_CLAUDE });
  const k = await columns(svall);
  await svall.api.call('robot.place', { id: agent.id, columnId: k['In review'] });
  await svall.open();
  await expect(page.locator('.kb-col-n')).toHaveText(['To do', 'In progress', 'In review', 'Done']);
  await expect(page.getByTestId(`col-${k['To do']}`).getByTestId(`kc-${shell.id}`)).toBeVisible();
  await expect(page.getByTestId(`col-${k['In review']}`).getByTestId(`kc-${agent.id}`)).toBeVisible();
  await expect(page.getByTestId(`col-count-${k['In review']}`)).toHaveText('1');
  await expect(page.getByTestId(`col-empty-${k.Done}`)).toHaveText('Nothing here yetDrop a robot, or + for a new one');
  // a robot moved by hand wears the hand
  await expect(page.getByTestId(`kc-hand-${agent.id}`)).toBeVisible();
  await expect(page.getByTestId(`kc-hand-${shell.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`kc-${shell.id}`)).toHaveAttribute('data-status', 'shell');
  await expect(page.getByTestId(`kc-${agent.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });

  await svall.api.call('robot.run', { id: agent.id, text: 'hello', enter: true });
  await expect(page.getByTestId(`kc-${agent.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(page.getByTestId(`kc-${agent.id}`)).toHaveAttribute('data-unread', 'true');
  await expect(page.getByTestId(`sb-robot-${agent.id}`)).toHaveAttribute('data-attention', 'true');

  await page.getByTestId(`kc-${shell.id}`).click();
  await expect(page.getByTestId(`kc-${shell.id}`)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId(`sb-robot-${shell.id}`)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('side-card').getByTestId('side-name')).toHaveValue('plain');
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  // a press on the bare ground lets it go
  await page.getByTestId(`col-empty-${k.Done}`).click();
  await expect(page.getByTestId(`kc-${shell.id}`)).toHaveAttribute('data-selected', 'false');
});

test('the view switch stands in one place over the map and the board, and switches them', async ({ page, svall }) => {
  await svall.open('map');
  const at = async () => (await page.getByTestId('view-board').boundingBox())!;
  const onMap = await at();
  await page.getByTestId('view-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('view-board')).toHaveAttribute('aria-pressed', 'true');
  const onBoard = await at();
  expect(onBoard.x).toBeCloseTo(onMap.x, 0);
  expect(onBoard.y).toBeCloseTo(onMap.y, 0);
  await page.getByTestId('view-map').click();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('view-map')).toHaveAttribute('aria-pressed', 'true');
});

test('a drop places the robot in the column under it and tells its agent nothing', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('drop') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'mover', command: FAKE_CLAUDE });
  const k = await columns(svall);
  await svall.open();
  await expect(page.getByTestId(`kc-${c.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });

  await dragTo(page, `kc-${c.id}`, `col-${k.Done}`);
  await expect(page.getByTestId('kc-lifted')).toBeVisible();
  await expect(page.getByTestId(`col-${k.Done}`)).toHaveAttribute('data-target', 'true');
  await expect(page.getByTestId(`col-${k.Done}`).getByTestId('kb-slot')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId(`col-${k.Done}`).getByTestId(`kc-${c.id}`)).toHaveAttribute('data-arrived', 'true');
  await expect.poll(() => robotOf(svall, c.id)).toMatchObject({ column: k.Done, columnSource: 'manual' });
  // a prompt would have set the agent working and left it done and unread
  await page.waitForTimeout(1000);
  expect((await robotOf(svall, c.id)).agent).toMatchObject({ status: 'idle' });
  await expect(page.getByTestId(`kc-${c.id}`)).toHaveAttribute('data-unread', 'false');

  // a drag let go with Escape stays where it was
  await dragTo(page, `kc-${c.id}`, `col-${k['To do']}`);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByTestId('kc-lifted')).toHaveCount(0);
  await expect(page.getByTestId(`col-${k.Done}`).getByTestId(`kc-${c.id}`)).toBeVisible();
  expect((await robotOf(svall, c.id)).column).toBe(k.Done);
});

test('right-click Move to places the robot, and Let the scribe place it hands the hand move back', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('menu') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'menued' });
  const k = await columns(svall);
  await svall.open();
  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu').getByRole('menuitem'))
    .toHaveText(['Open terminal', 'Rename', 'Star', 'Move to›', 'Let the scribe place it', 'Delete', 'Reload']);
  await expect(page.getByTestId('menu-let the scribe place it')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('menu-move to').hover();
  const sub = page.getByTestId('context-submenu');
  await expect(sub.getByRole('menuitem')).toHaveText(['To do✓', 'In progress', 'In review', 'Done']);
  // its own column sends nothing, so the scribe keeps placing it
  await sub.getByTestId('menu-to do').click();
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await expect(page.getByTestId('menu-let the scribe place it')).toHaveAttribute('aria-disabled', 'true');
  expect((await robotOf(svall, c.id)).columnSource).toBeUndefined();
  await page.getByTestId('menu-move to').hover();
  await sub.getByTestId('menu-in progress').click();
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await expect(page.getByTestId(`col-${k['In progress']}`).getByTestId(`kc-${c.id}`)).toBeVisible();
  await expect.poll(() => robotOf(svall, c.id)).toMatchObject({ column: k['In progress'], columnSource: 'manual' });

  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await page.getByTestId('menu-let the scribe place it').click();
  await expect.poll(async () => (await robotOf(svall, c.id)).columnSource).toBeUndefined();
  await expect(page.getByTestId(`kc-hand-${c.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`col-${k['In progress']}`).getByTestId(`kc-${c.id}`)).toBeVisible();
});

test("a card's menu renames it in place and opens its terminal", async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('named') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'before' });
  await svall.open();
  const field = page.getByTestId(`kc-name-input-${c.id}`);
  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await page.getByTestId('menu-rename').click();
  await expect(field).toBeFocused();
  // the field keeps a double click and a press-drag to itself
  await field.dblclick();
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  const r = (await field.boundingBox())!;
  await page.mouse.move(r.x + 10, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 50, r.y + r.height / 2 + 30, { steps: 5 });
  await expect(page.getByTestId('kc-lifted')).toHaveCount(0);
  await page.mouse.up();
  await expect(field).toBeFocused();
  await field.fill('after');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(async () => (await robotOf(svall, c.id)).name).toBe('after');
  await expect(page.getByTestId(`kc-${c.id}`)).toContainText('after');
  // Escape keeps the name it had
  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await page.getByTestId('menu-rename').click();
  await field.fill('dropped');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  expect((await robotOf(svall, c.id)).name).toBe('after');
  // a click away saves it
  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await page.getByTestId('menu-rename').click();
  await field.fill('away');
  await page.locator('.kb-bar').click({ position: { x: 4, y: 4 } });
  await expect(field).toHaveCount(0);
  await expect.poll(async () => (await robotOf(svall, c.id)).name).toBe('away');

  await page.getByTestId(`kc-${c.id}`).click({ button: 'right' });
  await page.getByTestId('menu-open terminal').click();
  await expect(page.getByTestId('terminal-card')).toBeVisible();
});

test('a card selected out of sight comes into its column', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('crowd') });
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push((await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: `crowd ${i}` })).id);
  await svall.open();
  const last = page.getByTestId(`kc-${ids.at(-1)}`);
  const inColumn = () => last.evaluate((el) => {
    const body = el.closest('.kb-col-body')!.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.top >= body.top && r.bottom <= body.bottom;
  });
  expect(await inColumn()).toBe(false);
  await page.getByTestId(`sb-robot-${ids.at(-1)}`).click();
  await expect(last).toHaveAttribute('data-selected', 'true');
  await expect.poll(inColumn).toBe(true);
});

test('a double click on a card showing only its top under the fade opens that card', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('peek') });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push((await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: `peek ${i}` })).id);
  await svall.open();
  const peek = page.getByTestId(`kc-${ids[6]}`);
  await peek.evaluate((el) => {
    const body = el.closest('.kb-col-body')!;
    body.scrollTop += el.getBoundingClientRect().top - (body.getBoundingClientRect().bottom - 30);
  });
  const r = (await peek.boundingBox())!;
  const bottom = await peek.evaluate((el) => el.closest('.kb-col-body')!.getBoundingClientRect().bottom);
  expect(r.y).toBeLessThan(bottom);
  expect(r.y + r.height).toBeGreaterThan(bottom);
  await page.mouse.dblclick(r.x + r.width / 2, r.y + 15);
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-robot', ids[6]);
});

test('the island chips fade at the right while more of them lie past it, and the arrows page through them', async ({ page, svall }) => {
  for (let i = 0; i < 12; i++) await svall.api.call('island.create', { name: svall.uniq(`a long island name ${i}`) });
  await svall.open();
  const chips = page.getByTestId('island-chips');
  const back = page.getByTestId('chips-back'), next = page.getByTestId('chips-next');
  await expect(chips).toHaveAttribute('data-more', 'true');
  await expect(back).toBeDisabled();
  // the chip cut at the right edge comes to the left one, whole
  const cut = await chips.evaluate((el) => [...el.children].findIndex((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right));
  await next.click();
  await expect(back).toBeEnabled();
  await expect.poll(() => chips.evaluate((el, i) => el.children[i].getBoundingClientRect().left - el.getBoundingClientRect().left, cut)).toBeCloseTo(0, 0);
  await chips.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(chips).toHaveAttribute('data-more', 'false');
  await expect(next).toBeDisabled();
  const end = await chips.evaluate((el) => el.scrollLeft);
  await back.click();
  await expect.poll(() => chips.evaluate((el) => el.scrollLeft)).toBeLessThan(end);
  await chips.evaluate((el) => { el.scrollLeft = 0; });
  await expect(back).toBeDisabled();
});

test('a column renames in place, a new one comes last with its name ready to type, and its grip moves it', async ({ page, svall }) => {
  const k = await columns(svall);
  await svall.open();
  await page.getByTestId(`col-name-${k['In review']}`).dblclick();
  await page.getByTestId('col-name-input').fill('Waiting on me');
  await page.getByTestId('col-name-input').press('Enter');
  await expect(page.getByTestId(`col-name-${k['In review']}`)).toHaveText('Waiting on me');
  // Escape keeps the name it had
  await page.getByTestId(`col-name-${k['In review']}`).dblclick();
  await page.getByTestId('col-name-input').fill('Nope');
  await page.getByTestId('col-name-input').press('Escape');
  await expect(page.getByTestId(`col-name-${k['In review']}`)).toHaveText('Waiting on me');
  expect(await names(svall)).toEqual(['To do', 'In progress', 'Waiting on me', 'Done']);

  await page.getByTestId('board-add-column').click();
  await expect(page.getByTestId('col-name-input')).toBeFocused();
  await expect(page.getByTestId('col-name-input')).toHaveValue('New column');
  await page.keyboard.type('Blocked on design');
  await page.keyboard.press('Enter');
  await expect.poll(() => names(svall)).toEqual(['To do', 'In progress', 'Waiting on me', 'Done', 'Blocked on design']);
  const blocked = (await columns(svall))['Blocked on design'];
  await expect(page.getByTestId(`col-empty-${blocked}`)).toBeVisible();

  await page.getByTestId(`col-menu-${blocked}`).click();
  await expect(page.getByTestId('context-menu').getByRole('menuitem')).toHaveText(['Rename', 'Collapse', 'Delete', 'Reload']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  // the grip drags it to the side of the column it lands on
  const grip = (await page.getByTestId(`col-grip-${blocked}`).boundingBox())!, done = (await page.getByTestId(`col-${k.Done}`).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(done.x + done.width / 4, done.y + 120, { steps: 8 });
  await expect(page.getByTestId(`col-${k.Done}`)).toHaveAttribute('data-reorder', 'before');
  await page.mouse.up();
  await expect.poll(() => names(svall)).toEqual(['To do', 'In progress', 'Waiting on me', 'Blocked on design', 'Done']);
});

test('a column with robots asks where they go before it is deleted; an empty one goes at once and Undo brings it back', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('del') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'kept' });
  const k = await columns(svall);
  await svall.api.call('robot.place', { id: c.id, columnId: k['In review'] });
  await svall.open();
  await page.getByTestId(`col-menu-${k['In review']}`).click();
  await page.getByTestId('menu-delete').click();
  const dialog = page.getByTestId('confirm-delete-column');
  await expect(dialog).toContainText('Its 1 robot moves to');
  // its left neighbour unless another is picked
  await expect(page.getByTestId('confirm-delete-column-to')).toHaveValue(k['In progress']);
  await page.getByTestId('confirm-delete-column-to').selectOption({ label: 'Done' });
  await page.getByTestId('confirm-delete-column-delete').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => names(svall)).toEqual(['To do', 'In progress', 'Done']);
  expect((await robotOf(svall, c.id)).column).toBe(k.Done);
  await expect(page.getByTestId(`col-${k.Done}`).getByTestId(`kc-${c.id}`)).toBeVisible();

  await page.getByTestId(`col-menu-${k['In progress']}`).click();
  await page.getByTestId('menu-delete').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => names(svall)).toEqual(['To do', 'Done']);
  await expect(page.getByTestId('toast')).toContainText('Deleted “In progress”');
  await page.getByTestId('toast-action').click();
  await expect.poll(() => names(svall)).toEqual(['To do', 'In progress', 'Done']);

  // the board keeps its last column
  const left = await columns(svall);
  await svall.api.call('column.delete', { id: left['In progress'], moveTo: left['To do'] });
  await svall.api.call('column.delete', { id: left.Done, moveTo: left['To do'] });
  await page.getByTestId(`col-menu-${left['To do']}`).click();
  await expect(page.getByTestId('menu-delete')).toHaveAttribute('aria-disabled', 'true');
});

test('a collapsed column is a strip that keeps its count, takes a drop, opens on a click, and is remembered', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('fold') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'folded' });
  const k = await columns(svall);
  await svall.open();
  await page.getByTestId(`col-menu-${k.Done}`).click();
  await page.getByTestId('menu-collapse').click();
  const strip = page.getByTestId(`col-strip-${k.Done}`);
  await expect(strip).toContainText('0');
  await expect(page.getByTestId(`col-${k.Done}`)).toHaveCount(0);

  await dragTo(page, `kc-${c.id}`, `col-strip-${k.Done}`);
  await expect(strip).toHaveAttribute('data-target', 'true');
  await page.mouse.up();
  await expect(strip).toContainText('1');
  await expect.poll(async () => (await robotOf(svall, c.id)).column).toBe(k.Done);

  await page.reload();
  await expect(page.getByTestId(`col-strip-${k.Done}`)).toBeVisible();
  await page.getByTestId(`col-strip-${k.Done}`).click();
  await expect(page.getByTestId(`col-${k.Done}`).getByTestId(`kc-${c.id}`)).toBeVisible();
});

test('the chips show one island, or the robots that want the user, and a card names its island until one island shows', async ({ page, svall }) => {
  const a = await svall.api.call('island.create', { name: svall.uniq('alpha') });
  const b = await svall.api.call('island.create', { name: svall.uniq('beta') });
  const quiet = await svall.api.call('robot.create', { islandId: a.id, cwd: '/tmp', name: 'quiet' });
  const asking = await svall.api.call('robot.create', { islandId: a.id, cwd: '/tmp', name: 'asking', command: FAKE_CLAUDE });
  const other = await svall.api.call('robot.create', { islandId: b.id, cwd: '/tmp', name: 'other' });
  await svall.open();
  await expect(page.getByTestId(`kc-${asking.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
  await svall.api.call('robot.run', { id: asking.id, text: 'block', enter: true });
  await expect(page.getByTestId(`kc-${asking.id}`)).toHaveAttribute('data-need', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('chip-all')).toHaveText('All islands 3');
  await expect(page.getByTestId(`chip-${a.id}`)).toContainText('2');
  await expect(page.getByTestId('chip-needs')).toHaveText('Needs you 1');
  await expect(page.getByTestId(`kc-island-${other.id}`)).toHaveText(b.name);

  await page.getByTestId(`chip-${b.id}`).click();
  await expect(page.getByTestId(`chip-${b.id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.kc')).toHaveCount(1);
  await expect(page.getByTestId(`kc-${other.id}`)).toBeVisible();
  await expect(page.getByTestId(`kc-island-${other.id}`)).toHaveCount(0);
  await expect(page.getByTestId('chip-needs')).toHaveText('Needs you 0');

  await page.getByTestId(`chip-${a.id}`).click();
  await page.getByTestId('chip-needs').click();
  await expect(page.locator('.kc')).toHaveCount(1);
  await expect(page.getByTestId(`kc-${asking.id}`)).toBeVisible();
  await page.getByTestId('chip-needs').click();
  await page.getByTestId('chip-all').click();
  await expect(page.locator('.kc')).toHaveCount(3);
  await expect(page.getByTestId(`kc-${quiet.id}`)).toBeVisible();
});

test('a double click opens the terminal in the card over the board, and the card goes along to the map', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('open'), position: { x: 0, y: 100 } });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'opened' });
  await svall.open();
  await page.getByTestId(`kc-${c.id}`).dblclick();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-robot', c.id);
  await expect(page.getByTestId('surface')).toHaveAttribute('data-robot', c.id);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-robot', c.id);
  await page.keyboard.press('Meta+m');
  await page.getByTestId('card-close').click();
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  // Enter opens the selection, as on the map
  await expect(page.getByTestId(`kc-${c.id}`)).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-robot', c.id);
});

test('renames and deletes an island from the sidebar', async ({ page, svall }) => {
  await svall.open();
  const before = await page.getByTestId('island-name').count();
  const created = await svall.api.call('island.create', { name: svall.uniq('new') });
  await page.getByTestId(`sb-island-${created.id}`).dblclick();
  const input = page.getByTestId('island-name-input');
  await expect(input).toBeVisible();
  const name = svall.uniq('renamed');
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByTestId('island-name').filter({ hasText: name })).toBeVisible();
  expect(await page.getByTestId('island-name').count()).toBe(before + 1);
  // the new island is selected, and its card makes a robot on it
  await expect(page.getByTestId('side-island-card')).toBeVisible();
  await page.getByTestId('side-island-new').click();
  const state = await svall.api.call('state.get', {});
  const islandId = Object.values(state.islands).find((i) => i.name === name)!.id;
  await expect.poll(async () => Object.values((await svall.api.call('state.get', {})).robots).some((x) => x.islandId === islandId)).toBe(true);
  const c = Object.values((await svall.api.call('state.get', {})).robots).find((x) => x.islandId === islandId)!;
  await expect(page.getByTestId(`kc-${c.id}`)).toBeVisible();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-robot', c.id);
  await svall.api.call('robot.close', { id: c.id });
  await expect(page.getByTestId(`sb-robot-${c.id}`)).toHaveCount(0);
  await page.getByTestId(`sb-island-${islandId}`).click();
  // the island's docs go with it, so the first press only asks
  await page.getByTestId('side-island-delete').click();
  await expect(page.getByTestId('island-name').filter({ hasText: name })).toHaveCount(1);
  await page.getByTestId('confirm-delete-island-delete').click();
  await expect(page.getByTestId('island-name').filter({ hasText: name })).toHaveCount(0);
});

test('the islands panel folds away and comes back from the edge, on the map and on the board', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('panel'), position: { x: 0, y: 100 } });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'panelist' });
  await svall.open('map');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  // a row reads a robot rather than opening its terminal
  await page.getByTestId(`sb-robot-${c.id}`).click();
  await expect(page.getByTestId('side-card').getByTestId('side-name')).toHaveValue('panelist');
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  await page.getByTestId('sidebar-hide').click();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByTestId('sidebar-show').click();
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
});

test('shows the connect screen without a daemon address', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connect-screen')).toBeVisible();
});

test('a toast takes a hole in the terminal under it, beside a half card and over a full one', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('toast') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const { sent, receive } = await svall.nativeShell();
  await svall.open();
  const cutout = async () => (await sent()).filter((m) => m.type === 'shell.cutout').at(-1) as Extract<ToShell, { type: 'shell.cutout' }> | undefined;
  const toast = page.getByTestId('toast');
  // the terminal is drawn above the page, and the hole it gives up is where the toast stands once it has eased in;
  // a refusal has nothing to press, so the presses in it stay with the terminal
  const holed = async () => {
    const c = await cutout(), b = await toast.boundingBox();
    return !!c && !!b && c.rects.length === 0 && c.passive.some((r) => Math.max(Math.abs(r.x - b.x), Math.abs(r.y - b.y), Math.abs(r.width - b.width), Math.abs(r.height - b.height)) < 1);
  };
  // a path that is not there, dropped on the robot's card, is refused on a toast
  const refused = async () => {
    const row = (await page.getByTestId(`sb-robot-${c.id}`).boundingBox())!;
    await receive({ type: 'drag.drop', paths: ['/no/such/path'], x: row.x + row.width / 2, y: row.y + row.height / 2 });
    await expect(toast).toContainText('no such file');
  };

  await page.getByTestId(`kc-${c.id}`).dblclick();
  await expect.poll(async () => (await sent()).some((m) => m.type === 'term.show' && m.id === c.id)).toBe(true);
  await refused();
  await expect.poll(holed).toBe(true);
  await expect(toast).toHaveCount(0);
  await expect.poll(async () => (await cutout())?.passive).toEqual([]);

  // the full card leaves no corner free, so the toast stands on its terminal
  await page.getByTestId('card-size').click();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-size', 'full');
  await refused();
  await expect(toast).toHaveAttribute('data-corner', 'bottom-left');
  await expect.poll(holed).toBe(true);
});

test('the board asks once whether the scribe places robots, and Turn on brings the scribe with it', async ({ page, svall }) => {
  await askPlacing(svall);
  await svall.open();
  const ask = page.getByTestId('placing-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Let the scribe place robots on the board?');
  await expect(ask).toContainText('Turning this on turns the scribe on too.');
  await expect(ask.getByTestId('placing-ask-off')).toBeFocused();
  await expect(page.getByTestId('chip-placing')).toHaveText('Auto-place: off ▾');
  await ask.getByTestId('placing-ask-on').click();
  await expect(ask).toHaveCount(0);
  await expect.poll(() => placingState(svall)).toEqual([undefined, undefined, undefined]);
  await expect(page.getByTestId('chip-placing')).toHaveText('Auto-place: scribe ▾');
  await expect(page.getByTestId('chip-placing')).toHaveAttribute('data-on', 'true');
  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('placing-ask')).toHaveCount(0);
});

test('a reflex Return keeps placing off, the map never asks, and the first-launch toast stays away behind the ask', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('ask') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'waiting' });
  await askPlacing(svall);
  await toastUnshown(page);
  await svall.open('map');
  await expect(page.getByTestId('placing-ask')).toHaveCount(0);
  await page.keyboard.press('Meta+m');
  const ask = page.getByTestId('placing-ask');
  await expect(ask).toBeVisible();
  await expect(page.getByTestId(`kc-${c.id}`)).toBeVisible();
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(ask).toHaveCount(0);
  await expect.poll(() => placingState(svall)).toEqual([undefined, true, true]);
  await expect(page.getByTestId('chip-placing')).toHaveText('Auto-place: off ▾');
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('Keep off on an empty fleet counts as the first-launch toast, so the first robot after it brings none', async ({ page, svall }) => {
  await askPlacing(svall);
  await toastUnshown(page);
  await svall.open();
  await page.getByTestId('placing-ask-off').click();
  await expect.poll(() => placingState(svall)).toEqual([undefined, true, true]);
  const island = await svall.api.call('island.create', { name: svall.uniq('later') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'later' });
  await expect(page.getByTestId(`kc-${c.id}`)).toBeVisible();
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('the Auto-place chip says who places robots and switches it, and places them now, the scribe only while it runs', async ({ page, svall }) => {
  await svall.open();
  const chip = page.getByTestId('chip-placing');
  await expect(chip).toHaveText('Auto-place: off ▾');
  await expect(chip).toHaveAttribute('data-on', 'false');
  await chip.click();
  const menu = page.getByTestId('context-menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Place now', 'Offby hand only✓', 'Scribe', 'Scribe settings…']);
  await expect(menu.getByRole('separator')).toHaveCount(2);
  await expect(menu.getByTestId('menu-place now')).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByTestId('menu-scribe')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await svall.api.call('scribe.set', { enabled: true });
  await chip.click();
  await menu.getByTestId('menu-scribe').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await svall.api.call('state.get', {})).placingOff).toBeUndefined();
  await expect(chip).toHaveText('Auto-place: scribe ▾');
  await expect(chip).toHaveAttribute('data-on', 'true');

  // with the scribe off nothing places robots, though placing stays on for when it runs again
  await svall.api.call('scribe.set', { enabled: false });
  await expect(chip).toHaveText('Auto-place: off ▾');
  await chip.click();
  await expect(menu.getByRole('menuitem')).toHaveText(['Place now', 'Offby hand only✓', 'Scribe', 'Scribe settings…']);
  await page.keyboard.press('Escape');
  await svall.api.call('scribe.set', { enabled: true });
  await expect(chip).toHaveText('Auto-place: scribe ▾');

  await chip.click();
  await expect(menu.getByRole('menuitem')).toHaveText(['Place now', 'Offby hand only', 'Scribe✓', 'Scribe settings…']);
  await menu.getByTestId('menu-off').click();
  await expect.poll(async () => (await svall.api.call('state.get', {})).placingOff).toBe(true);
  await expect(chip).toHaveText('Auto-place: off ▾');

  // Place now runs a pass with Auto-place off too; no robot here has a session to read
  await chip.click();
  await menu.getByTestId('menu-place now').click();
  await expect(page.getByTestId('toast')).toContainText('Every robot is in its column');
  await expect(chip).toHaveAttribute('data-busy', 'false');

  await chip.click();
  await menu.getByTestId('menu-scribe settings…').click();
  await expect(page.getByTestId('settings-tab-fleet')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('set-placing')).toHaveAttribute('aria-checked', 'false');
});

test('the first board with robots on this Mac says where they start, once, and offers the scribe', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'early' });
  await toastUnshown(page);
  await svall.open();
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('Every robot starts in To do.');
  await expect(toast.getByTestId('toast-dismiss')).toHaveText('Dismiss');
  await toast.getByTestId('toast-action').click();
  await expect.poll(() => placingState(svall)).toEqual([undefined, undefined, undefined]);
  await expect(page.getByTestId('chip-placing')).toHaveText('Auto-place: scribe ▾');
  await page.reload();
  await expect(page.getByTestId(`kc-${c.id}`)).toBeVisible();
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
