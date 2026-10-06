import { spacedCells } from '@svall/protocol';
import { expect, settleMap, test, type Svall } from './fixtures.js';
import type { Page } from '@playwright/test';

// where the map has actually drawn an island, which trails the daemon's state by a patch and a refit
const drawnAt = (page: Page, id: string) =>
  page.evaluate((i) => window.__map!.dump().islands.find((x) => x.id === i), id);
const screenOf = (page: Page, cell: { x: number; y: number }) =>
  page.evaluate((c) => window.__map!.screenOf(c), cell);
const cellPx = (page: Page) => page.evaluate(() => { const l = window.__map!.layout(); return l.scale * l.tile; });

// a token card is centred on its cell; press the cell centre
async function centre(page: Page, cell: { x: number; y: number }) {
  const p = await screenOf(page, cell);
  const cs = await cellPx(page);
  const box = await page.getByTestId('map').boundingBox();
  return { x: box!.x + p.x + cs / 2, y: box!.y + p.y + cs / 2 };
}
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await settleMap(page);
  const a = await centre(page, from), b = await centre(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}
const charOf = async (svall: Svall, id: string) => (await svall.api.call('state.get', {})).characters[id];

test('moves a character by drag, swaps on an occupied cell, makes an island on water', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('drag'), seed: 4, position: { x: 0, y: 40 } });
  const cells = spacedCells(island.size, 3);
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a', cell: cells[0] });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'b', cell: cells[1] });
  await svall.open('map');
  await expect(page.getByTestId(`token-${a.id}`)).toBeVisible();
  const world = (c: { x: number; y: number }) => ({ x: island.position.x + c.x, y: island.position.y + c.y });

  const target = cells[2];
  await dragTo(page, world(a.cell), world(target));
  await expect.poll(() => charOf(svall, a.id).then((c) => c.cell)).toEqual(target);

  await dragTo(page, world(target), world(b.cell));
  await expect.poll(() => charOf(svall, a.id).then((c) => c.cell)).toEqual(b.cell);
  expect((await charOf(svall, b.id)).cell).toEqual(target);

  // footprints grown by a cell must stay clear, so the drop is far enough right that the new 6-wide island misses this one
  const water = { x: island.position.x + island.size.w + 6, y: island.position.y };
  await dragTo(page, world(b.cell), water);
  await expect.poll(async () => (await charOf(svall, a.id)).islandId).not.toBe(island.id);
  const state = await svall.api.call('state.get', {});
  const created = state.islands[(await charOf(svall, a.id)).islandId];
  expect(created.name).toMatch(/^tmp/);
  await expect(page.getByTestId(`island-label-${created.id}`)).toBeVisible();
});

test('an occupied map drop exchanges characters across islands', async ({ page, svall }) => {
  const left = await svall.api.call('island.create', { name: svall.uniq('swap-left'), position: { x: 0, y: 40 } });
  const right = await svall.api.call('island.create', { name: svall.uniq('swap-right'), position: { x: 11, y: 40 } });
  const a = await svall.api.call('char.create', { islandId: left.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('char.create', { islandId: right.id, cwd: '/tmp', name: 'b' });
  await svall.open('map');
  await expect(page.getByTestId(`token-${a.id}`)).toBeVisible();
  const world = (island: typeof left, c: typeof a) => ({ x: island.position.x + c.cell.x, y: island.position.y + c.cell.y });
  await dragTo(page, world(left, a), world(right, b));
  await expect.poll(() => charOf(svall, a.id).then((c) => c.islandId)).toBe(right.id);
  expect((await charOf(svall, b.id)).islandId).toBe(left.id);
});

test('islands move by label and resize by handle', async ({ page, svall }) => {
  const left = await svall.api.call('island.create', { name: svall.uniq('l'), seed: 1, position: { x: 0, y: 60 } });
  const right = await svall.api.call('island.create', { name: svall.uniq('r'), seed: 1, position: { x: 11, y: 60 } });
  const c = await svall.api.call('char.create', { islandId: left.id, cwd: '/tmp', name: 'c' });
  await svall.open('map');
  await expect(page.getByTestId(`token-${c.id}`)).toBeVisible();
  const label = page.getByTestId(`island-label-${right.id}`);
  await settleMap(page);
  const box = (await label.boundingBox())!;
  const cs = await cellPx(page);
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  // up, not down: the pair sits on mission control's row, and land put down on mission control goes back
  await page.mouse.move(box.x + 4 + cs * 4, box.y + box.height / 2 - cs * 8, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[right.id].position).toEqual({ x: 15, y: 52 });

  // the move refits the world, so the cell is a different size than it was for the label drag
  await expect.poll(async () => (await drawnAt(page, right.id))?.x).toBe(15);
  await settleMap(page);
  const rcs = await cellPx(page);
  await label.hover();
  const handle = page.getByTestId(`handle-${right.id}`);
  await expect(handle).toBeVisible();
  // the handle is a diamond straddling the island's corner: press just past the corner but well inside it,
  // so press and release floor to cells exactly two apart
  const hb = (await handle.boundingBox())!;
  const grip = { x: hb.x + hb.width / 2 + rcs * 0.09, y: hb.y + hb.height / 2 + rcs * 0.09 };
  // travel from the label to the handle across the sea: the handle must survive the label's pointerleave
  await page.mouse.move(grip.x, grip.y, { steps: 5 });
  await expect(handle).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(grip.x + rcs * 1.4, grip.y + rcs * 0.6, { steps: 4 });
  await expect.poll(async () => (await handle.boundingBox())!.x - hb.x).toBeCloseTo(rcs * 1.4, 0);
  expect((await handle.boundingBox())!.y - hb.y).toBeCloseTo(rcs * 0.6, 0);
  await page.mouse.move(grip.x + rcs * 2, grip.y + rcs, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[right.id].size).toEqual({ w: 9, h: 6 });
});

test('a rejected island drop returns to its saved position and leaves the next drag usable', async ({ page, svall }) => {
  await svall.api.call('island.create', { name: svall.uniq('fixed'), seed: 1, position: { x: 0, y: 60 } });
  const moving = await svall.api.call('island.create', { name: svall.uniq('moving'), seed: 1, position: { x: 10, y: 60 } });
  await svall.open('map');
  await settleMap(page);
  const label = page.getByTestId(`island-label-${moving.id}`);
  const land = page.getByTestId(`island-${moving.id}`);
  const before = (await land.boundingBox())!;
  const box = (await label.boundingBox())!, cs = await cellPx(page);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - cs * 5, start.y);
  await page.mouse.up();
  await expect(page.getByTestId('toast')).toContainText('overlap');
  expect((await svall.api.call('state.get', {})).islands[moving.id].position).toEqual({ x: 10, y: 60 });
  await expect.poll(async () => (await land.boundingBox())!.x).toBeCloseTo(before.x, 0);
  const again = (await label.boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(again.x + again.width / 2 + cs * 2, again.y + again.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[moving.id].position).toEqual({ x: 12, y: 60 });
});

test('Escape cancels a sub-cell island drag without moving the fleet', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('cancel'), seed: 1, position: { x: 0, y: 60 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await svall.open('map');
  await settleMap(page);
  const label = page.getByTestId(`island-label-${island.id}`);
  const land = page.getByTestId(`island-${island.id}`);
  const before = (await land.boundingBox())!, box = (await label.boundingBox())!, cs = await cellPx(page);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + cs * 1.4, start.y);
  await expect.poll(async () => (await land.boundingBox())!.x - before.x).toBeCloseTo(cs * 1.4, 0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => (await land.boundingBox())!.x).toBeCloseTo(before.x, 0);
  expect((await svall.api.call('state.get', {})).islands[island.id].position).toEqual({ x: 0, y: 60 });
  await expect(page.locator('.island-landing')).toHaveCount(0);
});

test('an island and its cards follow the pointer before snapping, without an unnecessary refit', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('smooth'), seed: 1, position: { x: 0, y: 60 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'on board' });
  await svall.open('map');
  await expect(page.getByTestId(`token-${c.id}`)).toBeVisible();
  await settleMap(page);
  const land = page.getByTestId(`island-${island.id}`), token = page.getByTestId(`token-${c.id}`);
  const label = page.getByTestId(`island-label-${island.id}`);
  const origin = (await land.boundingBox())!, card = (await token.boundingBox())!;
  const box = (await label.boundingBox())!, cs = await cellPx(page);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + cs * 0.4, start.y);
  await expect.poll(async () => (await land.boundingBox())!.x - origin.x).toBeCloseTo(cs * 0.4, 0);
  expect((await token.boundingBox())!.x - card.x).toBeCloseTo(cs * 0.4, 0);
  await expect(page.locator('.island-landing')).toBeVisible();
  await page.mouse.move(start.x + cs * 3.2, start.y);
  await expect.poll(async () => (await land.boundingBox())!.x - origin.x).toBeCloseTo(cs * 3.2, 0);
  expect((await token.boundingBox())!.x - card.x).toBeCloseTo(cs * 3.2, 0);
  const refits = await page.evaluate(() => window.__map!.refits());
  await page.mouse.up();
  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[island.id].position).toEqual({ x: 3, y: 60 });
  await expect.poll(async () => (await land.boundingBox())!.x - origin.x).toBeCloseTo(cs * 3, 0);
  await expect.poll(async () => (await token.boundingBox())!.x - card.x).toBeCloseTo(cs * 3, 0);
  // the island stays where it was put down: the camera neither moved for the drop nor for its arrival
  expect(await page.evaluate(() => window.__map!.refits())).toBe(refits);
});

test('a drop in the gap between two islands lands clear of both', async ({ page, svall }) => {
  const left = await svall.api.call('island.create', { name: svall.uniq('gl'), seed: 1, position: { x: 0, y: 200 } });
  const right = await svall.api.call('island.create', { name: svall.uniq('gr'), seed: 1, position: { x: 7, y: 200 } });
  const c = await svall.api.call('char.create', { islandId: left.id, cwd: '/tmp', name: 'g' });
  await svall.open('map');
  await expect(page.getByTestId(`token-${c.id}`)).toBeVisible();

  // the one-cell gap cannot hold an island, so it slides clear instead of refusing the drop
  await dragTo(page, { x: left.position.x + c.cell.x, y: left.position.y + c.cell.y }, { x: 6, y: 200 });
  await expect.poll(async () => (await charOf(svall, c.id)).islandId).not.toBe(left.id);
  const state = await svall.api.call('state.get', {});
  const made = state.islands[(await charOf(svall, c.id)).islandId];
  const clear = (a: typeof made, b: typeof made) =>
    a.position.x + a.size.w < b.position.x || b.position.x + b.size.w < a.position.x ||
    a.position.y + a.size.h < b.position.y || b.position.y + b.size.h < a.position.y;
  expect(clear(made, left)).toBe(true);
  expect(clear(made, right)).toBe(true);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('a hidden island gives up its ground, and takes it back when the sidebar shows it', async ({ page, svall }) => {
  const left = await svall.api.call('island.create', { name: svall.uniq('fl'), seed: 1, position: { x: 0, y: 200 } });
  const right = await svall.api.call('island.create', { name: svall.uniq('fr'), seed: 1, position: { x: 11, y: 200 } });
  const at = async (id: string) => (await svall.api.call('state.get', {})).islands[id].position;
  // the fit jumps rather than eases, so the label is pressed where it was measured
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await svall.open('map');
  await settleMap(page);

  const unfolded = await cellPx(page);
  await page.getByTestId(`island-toggle-${left.id}`).click();
  await expect(page.getByTestId(`island-${left.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`island-label-${left.id}`)).toHaveCount(0);

  // the fit waits out the click before it zooms into the narrower world
  await expect.poll(() => cellPx(page)).not.toBe(unfolded);
  // every cell the folded island stood on is free: drag the other one onto them
  await settleMap(page);
  const label = page.getByTestId(`island-label-${right.id}`);
  const box = (await label.boundingBox())!;
  const cs = await cellPx(page);
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 4 - cs * 11, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  // the drag refits the world as it travels, so ask only that it landed on the ground the fold gave up
  await expect.poll(async () => {
    const p = await at(right.id);
    return p.y === 200 && p.x < left.position.x + left.size.w;
  }).toBe(true);

  // shown again, it takes ground back, and the island standing on it ends up clear
  await page.getByTestId(`sb-island-toggle-${left.id}`).click();
  await expect(page.getByTestId(`island-${left.id}`)).toBeVisible();
  const apart = async () => {
    const { islands } = await svall.api.call('state.get', {});
    const [a, b] = [islands[left.id], islands[right.id]];
    return a.position.x + a.size.w <= b.position.x || b.position.x + b.size.w <= a.position.x ||
      a.position.y + a.size.h <= b.position.y || b.position.y + b.size.h <= a.position.y;
  };
  await expect.poll(apart).toBe(true);
});

// the land of mission control and of an island, as drawn
const landOf = async (page: Page, testid: string) => (await page.getByTestId(testid).locator('.land').first().boundingBox())!;
const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) => a.x < b.x + b.width && b.x < a.x + a.width;

test('an island dragged into the water beside mission control stays beside it', async ({ page, svall }) => {
  const small = { w: 6, h: 3 };
  // the pair spans the map, so the left one stands well clear of mission control
  const left = await svall.api.call('island.create', { name: svall.uniq('bl'), seed: 1, position: { x: 0, y: 0 }, size: small });
  await svall.api.call('island.create', { name: svall.uniq('br'), seed: 1, position: { x: 40, y: 0 }, size: small });
  // wide enough that water runs beside mission control's label row as well as its land
  await page.setViewportSize({ width: 1700, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await svall.open('map');
  await settleMap(page);

  const home = await landOf(page, 'island-home');
  const label = (await page.getByTestId(`island-label-${left.id}`).boundingBox())!;
  const land = await landOf(page, `island-${left.id}`);
  expect(land.x + land.width).toBeLessThan(home.x);
  // down until the land sits beside the sandbar, level with it
  const by = home.y + 20 - land.y;
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2 + by / 2, { steps: 4 });
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2 + by, { steps: 4 });
  await page.mouse.up();

  await expect.poll(async () => (await svall.api.call('state.get', {})).islands[left.id].position.y).toBeGreaterThan(3);
  await settleMap(page);
  const after = await landOf(page, `island-${left.id}`), sand = await landOf(page, 'island-home');
  expect(after.y + after.height).toBeGreaterThan(sand.y);
  expect(overlaps(after, sand)).toBe(false);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('an island put down on mission control goes back where it stood', async ({ page, svall }) => {
  const small = { w: 6, h: 3 };
  for (const x of [0, 16]) await svall.api.call('island.create', { name: svall.uniq('ol'), seed: 1, position: { x, y: 0 }, size: small });
  const mid = await svall.api.call('island.create', { name: svall.uniq('om'), seed: 1, position: { x: 8, y: 0 }, size: small });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await svall.open('map');
  await settleMap(page);

  const home = await landOf(page, 'island-home');
  const label = (await page.getByTestId(`island-label-${mid.id}`).boundingBox())!;
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(home.x + home.width / 2, home.y + 30, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId('toast')).toContainText('would stand on mission control');
  expect((await svall.api.call('state.get', {})).islands[mid.id].position).toEqual({ x: 8, y: 0 });
});

test('an island moved towards mission control closes the gap instead of refitting the map', async ({ page, svall }) => {
  const small = { w: 6, h: 3 };
  await svall.api.call('island.create', { name: svall.uniq('mt'), seed: 1, position: { x: 0, y: 0 }, size: small });
  const mid = await svall.api.call('island.create', { name: svall.uniq('mm'), seed: 1, position: { x: 0, y: 7 }, size: small });
  await svall.api.call('island.create', { name: svall.uniq('mb'), seed: 1, position: { x: 0, y: 14 }, size: small });
  await svall.open('map');
  await settleMap(page);
  const layoutOf = () => page.evaluate(() => JSON.stringify(window.__map!.layout()));
  const before = await layoutOf();
  const homeTop = (await page.getByTestId('island-home').boundingBox())!.y;

  await svall.api.call('island.update', { id: mid.id, position: { x: 0, y: 10 } });
  await expect.poll(async () => (await drawnAt(page, mid.id))?.y).toBe(10);

  // the world neither rescaled nor slid, so those three rows are three rows nearer a sandbar that stayed put
  expect(await layoutOf()).toBe(before);
  expect((await page.getByTestId('island-home').boundingBox())!.y).toBeCloseTo(homeTop, 0);

  // past mission control's row too: the floor goes down with it
  await svall.api.call('island.update', { id: mid.id, position: { x: 0, y: 20 } });
  await expect.poll(async () => (await drawnAt(page, mid.id))?.y).toBe(20);
});

test('the sidebar moves a character to another island, then reorders its new crew', async ({ page, svall }) => {
  const from = await svall.api.call('island.create', { name: svall.uniq('sba'), position: { x: 0, y: 300 } });
  const to = await svall.api.call('island.create', { name: svall.uniq('sbb'), position: { x: 11, y: 300 } });
  const a = await svall.api.call('char.create', { islandId: from.id, cwd: '/tmp', name: 'sa' });
  const b = await svall.api.call('char.create', { islandId: to.id, cwd: '/tmp', name: 'sb' });
  await svall.open('map');
  await expect(page.getByTestId(`sb-char-${a.id}`)).toBeVisible();

  await page.getByTestId(`sb-char-${a.id}`).dragTo(page.getByTestId(`sb-island-${to.id}`));
  await expect.poll(() => charOf(svall, a.id).then((c) => c.islandId)).toBe(to.id);

  const landed = (await charOf(svall, a.id)).cell;
  const target = page.getByTestId(`sb-char-${a.id}`);
  const height = (await target.boundingBox())!.height;
  await page.getByTestId(`sb-char-${b.id}`).dragTo(target, { targetPosition: { x: 20, y: height - 3 } });
  await expect.poll(() => charOf(svall, b.id).then((c) => c.cell)).toEqual(landed);
  expect((await charOf(svall, a.id)).cell).not.toEqual(landed);
});

test('a sidebar drop inserts a character and shifts the rows between it and the target', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('reorder'), position: { x: 0, y: 300 } });
  const chars = await Promise.all(['one', 'two', 'three'].map((name) => svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name })));
  await svall.open('map');
  const order = async () => {
    const state = await svall.api.call('state.get', {});
    return Object.values(state.characters).filter((c) => c.islandId === island.id)
      .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x).map((c) => c.id);
  };
  const before = await order();
  const [first, middle, last] = before;
  await page.getByTestId(`sb-char-${last}`).dragTo(page.getByTestId(`sb-char-${first}`), { targetPosition: { x: 20, y: 4 } });
  await expect.poll(order).toEqual([last, first, middle]);
  await expect(page.getByTestId(`sb-folder-${island.id}`).locator('.sb-child')).toHaveCount(chars.length);
});

test('a sidebar drop on a character in another island moves without displacing the target', async ({ page, svall }) => {
  const from = await svall.api.call('island.create', { name: svall.uniq('move-from'), position: { x: 0, y: 300 } });
  const to = await svall.api.call('island.create', { name: svall.uniq('move-to'), position: { x: 11, y: 300 } });
  const moving = await svall.api.call('char.create', { islandId: from.id, cwd: '/tmp', name: 'moving' });
  const target = await svall.api.call('char.create', { islandId: to.id, cwd: '/tmp', name: 'target' });
  await svall.open('map');
  await page.getByTestId(`sb-char-${moving.id}`).dragTo(page.getByTestId(`sb-char-${target.id}`), { targetPosition: { x: 20, y: 4 } });
  await expect.poll(() => charOf(svall, moving.id).then((c) => c.islandId)).toBe(to.id);
  expect((await charOf(svall, target.id)).islandId).toBe(to.id);
  const state = await svall.api.call('state.get', {});
  expect(state.characters[moving.id].cell.y < state.characters[target.id].cell.y ||
    (state.characters[moving.id].cell.y === state.characters[target.id].cell.y && state.characters[moving.id].cell.x < state.characters[target.id].cell.x)).toBe(true);
});

test('the sidebar reorders islands by drag, and mission control stays last', async ({ page, svall }) => {
  const a = await svall.api.call('island.create', { name: svall.uniq('order-a'), position: { x: 0, y: 300 } });
  const b = await svall.api.call('island.create', { name: svall.uniq('order-b'), position: { x: 11, y: 300 } });
  await svall.open('map');
  const listed = () => page.locator('.sb-folder').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('sb-folder-', '')));
  const pair = async () => (await listed()).filter((id) => id === a.id || id === b.id);
  await expect.poll(pair).toEqual([a.id, b.id]);
  await page.getByTestId(`sb-island-${b.id}`).dragTo(page.getByTestId(`sb-folder-${a.id}`), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(pair).toEqual([b.id, a.id]);
  expect((await listed()).at(-1)).toBe('home');
});
