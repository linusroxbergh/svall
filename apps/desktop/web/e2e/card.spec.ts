import { spacedCells } from '@svall/protocol';
import { expect, test, type Svall } from './fixtures.js';
import type { Page } from '@playwright/test';

type MapHandle = { screenOf(cell: { x: number; y: number }): { x: number; y: number }; layout(): { scale: number; tile: number } };
// the fit ease keeps shifting the layout for a few frames after the view opens, and again whenever the side card takes width
const settle = (page: Page) => page.waitForFunction(() => {
  const m = (window as unknown as { __map: MapHandle }).__map;
  const before = JSON.stringify(m.layout());
  return new Promise<boolean>((done) => setTimeout(() => done(before === JSON.stringify(m.layout())), 100));
});

async function figurePoint(page: Page, cell: { x: number; y: number }) {
  await settle(page);
  const p = await page.evaluate((c) => (window as unknown as { __map: MapHandle }).__map.screenOf(c), cell);
  const cs = await page.evaluate(() => { const l = (window as unknown as { __map: MapHandle }).__map.layout(); return l.scale * l.tile; });
  const box = (await page.getByTestId('map').boundingBox())!;
  return { x: box.x + p.x + cs / 2, y: box.y + p.y + cs / 2 };
}

const worldCellOf = async (svall: Svall, island: { position: { x: number; y: number } }, id: string) => {
  const cell = await svall.cellOf(id);
  return { x: island.position.x + cell.x, y: island.position.y + cell.y };
};

test('the first half card fills most of the map, a margin all round', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first'), seed: 2, position: { x: 0, y: 80 } });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  await svall.open('map', { firstRun: true });
  const pa = await figurePoint(page, await worldCellOf(svall, island, a.id));
  await page.mouse.dblclick(pa.x, pa.y);
  const card = page.getByTestId('terminal-card');
  await expect(card).toHaveAttribute('data-settled', 'true');
  await expect.poll(async () => {
    const map = (await page.getByTestId('map').boundingBox())!, half = (await card.boundingBox())!;
    return [Math.round((half.width / map.width) * 100), Math.round((half.height / map.height) * 100)];
  }).toEqual([94, 92]);
});

test('opens, switches, resizes and closes the terminal card; Cmd+M round-trips to the board', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('card'), seed: 2, position: { x: 0, y: 80 } });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b' });
  await svall.open('map');
  await expect(page.getByTestId(`token-${a.id}`)).toBeVisible();
  const cellA = await worldCellOf(svall, island, a.id);
  const pa = await figurePoint(page, cellA);
  await page.mouse.dblclick(pa.x, pa.y);
  const card = page.getByTestId('terminal-card');
  await expect(card).toHaveAttribute('data-char', a.id);
  await expect(card).toHaveAttribute('data-size', 'half');
  // the header names the character and nothing else about where it stands
  const header = card.locator('.phead');
  await expect(header.locator('.tname')).toHaveText('a');
  await expect(header).not.toContainText(island.name);
  await expect(header.locator('.tisl, .tbr')).toHaveCount(0);
  // the half card is centred on the map once its ease has ended
  const offCentre = async () => {
    const map = (await page.getByTestId('map').boundingBox())!, half = (await card.boundingBox())!;
    return Math.max(Math.abs(half.x + half.width / 2 - (map.x + map.width / 2)), Math.abs(half.y + half.height / 2 - (map.y + map.height / 2)));
  };
  await expect.poll(offCentre).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', a.id);
  await expect(page.getByTestId('surface')).toContainText('terminal · a');

  await page.keyboard.press('Meta+j');
  await expect(card).toHaveAttribute('data-char', b.id);
  await expect(card).toHaveAttribute('data-settled', 'true');
  await page.keyboard.press('Meta+Enter');
  await expect(card).toHaveAttribute('data-size', 'full');
  // the full card takes the map edge to edge
  await expect.poll(async () => {
    const map = (await page.getByTestId('map').boundingBox())!, full = (await card.boundingBox())!;
    return Math.max(Math.abs(full.x - map.x), Math.abs(full.y - map.y), Math.abs(full.width - map.width), Math.abs(full.height - map.height));
  }).toBeLessThanOrEqual(1);
  await page.getByTestId('card-size').click();
  await expect(card).toHaveAttribute('data-size', 'half');
  await page.keyboard.press('Meta+w');
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[b.id]).toBeTruthy();

  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-char', b.id);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await page.getByTestId(`island-label-${island.id}`).click();
  await expect(page.getByTestId('side-island-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('side-island-card')).toBeHidden();

  const pa2 = await figurePoint(page, cellA);
  await page.mouse.click(pa2.x, pa2.y);
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
  // the board's character comes back in its card
  await expect(card).toHaveAttribute('data-char', a.id);

  await page.keyboard.press('Meta+t');
  await page.getByTestId('new-character-name').fill('c');
  await page.getByTestId('new-character-name').press('Enter');
  await expect(card).not.toHaveAttribute('data-char', a.id);
  const created = await page.getByTestId('terminal-card').getAttribute('data-char');
  expect(created).not.toBe(a.id);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[created!]?.islandId).toBe(island.id);
});

test('an open card follows the selection, from the sidebar and from the map', async ({ page, svall }) => {
  // a wide island keeps the left character clear of the half card, which sits over the middle of the map
  const island = await svall.api.call('island.create', { name: svall.uniq('follow'), seed: 2, size: { w: 20, h: 3 }, position: { x: 0, y: 160 } });
  const cells = spacedCells(island.size, island.seed, 3).sort((p, q) => p.x - q.x);
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a', cell: cells[0] });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b', cell: cells[cells.length - 1] });
  await svall.open('map');
  const card = page.getByTestId('terminal-card');
  await page.getByTestId(`sb-char-${a.id}`).dblclick();
  await expect(card).toHaveAttribute('data-char', a.id);

  await page.getByTestId(`sb-char-${b.id}`).click();
  await expect(card).toHaveAttribute('data-char', b.id);

  const pa = await figurePoint(page, await worldCellOf(svall, island, a.id));
  expect(pa.x).toBeLessThan((await card.boundingBox())!.x);
  await page.mouse.click(pa.x, pa.y);
  await expect(card).toHaveAttribute('data-char', a.id);

  // with no card open a single click still only selects
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await page.getByTestId(`sb-char-${b.id}`).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId(`token-${b.id}`)).toHaveAttribute('data-selected', 'true');
});

test('the half card keeps the size it was dragged to, for the next character too', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('grip'), seed: 2, position: { x: 0, y: 80 } });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b' });
  await svall.open('map');
  const pa = await figurePoint(page, await worldCellOf(svall, island, a.id));
  await page.mouse.dblclick(pa.x, pa.y);
  const card = page.getByTestId('terminal-card');
  await expect(card).toHaveAttribute('data-settled', 'true');
  // opening the card selected the character, which opened the side card; close it so the map stops resizing
  await page.keyboard.press('Meta+i');
  await expect(page.getByTestId('side-card')).toBeHidden();
  await settle(page);
  const before = (await card.boundingBox())!;
  const grip = (await page.getByTestId('card-grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  // the card stays centred, so each edge moves half as far as the grip
  await page.mouse.move(grip.x + 80, grip.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await card.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  const grown = (await card.boundingBox())!;
  await page.keyboard.press('Meta+j');
  await expect(card).toHaveAttribute('data-char', b.id);
  await expect.poll(async () => Math.round((await card.boundingBox())!.width)).toBe(Math.round(grown.width));
  await expect.poll(async () => Math.round((await card.boundingBox())!.height)).toBe(Math.round(grown.height));
});

test('a second click on the selected card opens its terminal', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('reclick') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'again' });
  await svall.open('map');

  // the sidebar: the first click reads the card, the second opens the terminal
  await page.getByTestId(`sb-char-${c.id}`).click();
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);
  await page.getByTestId(`sb-char-${c.id}`).click();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-char', c.id);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('terminal-card')).toHaveCount(0);

  // the map: the token is still selected, so one press opens it
  await page.getByTestId(`token-${c.id}`).click();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-char', c.id);
});
