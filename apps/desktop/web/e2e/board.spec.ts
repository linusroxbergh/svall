import { FAKE_CLAUDE, expect, test } from './fixtures.js';
import type { ToShell } from '../src/bridge.js';

test('lists islands and characters in the sidebar, follows agent status, and shows the selected terminal', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('board') });
  const shell = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'plain' });
  const agent = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'agent', command: FAKE_CLAUDE });
  await svall.open();
  await expect(page.getByTestId(`sb-island-${island.id}`).getByTestId('island-name')).toHaveText(island.name);
  await expect(page.getByTestId(`sb-island-${island.id}`)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId(`sb-char-${shell.id}`)).toHaveAttribute('data-status', 'shell');
  await expect(page.getByTestId(`sb-char-${agent.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
  // the first character in strip order is viewed: its tab is active and its terminal is up
  await expect(page.getByTestId(`tab-${shell.id}`)).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', shell.id);

  await svall.api.call('char.run', { id: agent.id, text: 'hello', enter: true });
  await expect(page.getByTestId(`sb-char-${agent.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(page.getByTestId(`sb-char-${agent.id}`)).toHaveAttribute('data-unread', 'true');
  await expect(page.getByTestId(`sb-char-${agent.id}`)).toHaveAttribute('data-attention', 'true');
  // a folded island hides its characters and says how many of them want the user
  await page.getByTestId(`sb-island-toggle-${island.id}`).click();
  await expect(page.getByTestId(`sb-char-${agent.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`sb-island-attention-${island.id}`)).toHaveText('1');
  await page.getByTestId(`sb-island-toggle-${island.id}`).click();
  await page.getByTestId(`sb-char-${agent.id}`).click();
  await expect(page.getByTestId(`sb-char-${agent.id}`)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', agent.id);
  await page.getByTestId(`tab-${shell.id}`).click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', shell.id);
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
  // the new island is selected and empty: no terminal, a delete button
  await expect(page.getByTestId('board-empty')).toBeVisible();
  await expect(page.getByTestId('island-delete')).toBeVisible();
  await page.getByTestId('island-new').click();
  await expect(page.getByTestId('board-empty')).toHaveCount(0);
  const state = await svall.api.call('state.get', {});
  const islandId = Object.values(state.islands).find((i) => i.name === name)!.id;
  const c = Object.values(state.characters).find((x) => x.islandId === islandId)!;
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);
  await expect(page.getByTestId(`tab-${c.id}`)).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('island-delete')).toHaveCount(0);
  await svall.api.call('char.close', { id: c.id });
  await expect(page.getByTestId(`sb-char-${c.id}`)).toHaveCount(0);
  await page.getByTestId(`sb-island-${islandId}`).click();
  // the island's docs go with it, so the first press only asks
  await page.getByTestId('island-delete').click();
  await expect(page.getByTestId('island-name').filter({ hasText: name })).toHaveCount(1);
  await page.getByTestId('confirm-delete-island-delete').click();
  await expect(page.getByTestId('island-name').filter({ hasText: name })).toHaveCount(0);
});

test('an island selected on the map lands on the board with its first character', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('sel'), position: { x: 0, y: 100 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'first' });
  await svall.open('map');
  await page.getByTestId(`island-label-${island.id}`).click();
  await expect(page.getByTestId('side-island-card')).toBeVisible();
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);
  await expect(page.getByTestId(`tab-${c.id}`)).toHaveAttribute('data-active', 'true');
  // the side card follows the viewed character
  await expect(page.getByTestId('side-card').getByTestId('side-name')).toHaveValue('first');
});

test('the islands panel is on the map too, and folds away', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('panel'), position: { x: 0, y: 100 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'panelist' });
  await svall.open('map');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  // on the map a row reads a character rather than opening its terminal
  await page.getByTestId(`sb-char-${c.id}`).click();
  await expect(page.getByTestId('side-card').getByTestId('side-name')).toHaveValue('panelist');
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  await page.getByTestId('sidebar-hide').click();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await page.getByTestId('sidebar-show').click();
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
});

test('the board brings the folded panel back from its own tab bar', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('back'), position: { x: 0, y: 140 } });
  await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'boarder' });
  await svall.open('board');
  await page.getByTestId('sidebar-hide').click();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  // the terminal is drawn over the window's left edge, so the board's control sits in the tab bar
  await expect(page.getByTestId('tabs').getByTestId('sidebar-show')).toBeVisible();
  await page.getByTestId('sidebar-show').click();
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
});

test('shows the connect screen without a daemon address', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connect-screen')).toBeVisible();
});

test('a toast takes a hole in the terminal under it, on the board and over a full card', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('toast') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
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
  // a path that is not there, dropped on the character's row, is refused on a toast
  const refused = async () => {
    const row = (await page.getByTestId(`sb-char-${c.id}`).boundingBox())!;
    await receive({ type: 'drag.drop', paths: ['/no/such/path'], x: row.x + row.width / 2, y: row.y + row.height / 2 });
    await expect(toast).toContainText('no such file');
  };

  await page.getByTestId(`sb-char-${c.id}`).click();
  await expect.poll(async () => (await sent()).some((m) => m.type === 'term.show' && m.id === c.id)).toBe(true);
  await refused();
  await expect.poll(holed).toBe(true);
  await expect(toast).toHaveCount(0);
  await expect.poll(async () => (await cutout())?.passive).toEqual([]);

  // the full card leaves no corner free, so the toast stands on its terminal
  await page.getByTestId('board-map').click();
  await page.getByTestId('card-size').click();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-size', 'full');
  await refused();
  await expect(toast).toHaveAttribute('data-corner', 'bottom-left');
  await expect.poll(holed).toBe(true);
});
