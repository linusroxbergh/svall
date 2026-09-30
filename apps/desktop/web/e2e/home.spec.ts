import { spacedCells } from '@svall/protocol';
import { theme } from '../src/theme.js';
import { expect, setMapWidth, test } from './fixtures.js';

test('a button spawns a crew member on home and hands it the prompt', async ({ page, svall }) => {
  await svall.open('map');
  const home = page.getByTestId('home');
  await expect(home).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('island-label-home')).toContainText('mission control');
  await expect(page.getByTestId('island-home')).toBeVisible();

  await page.getByTestId('home-action-organise').click();
  await expect(home.locator('.tok')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('toast')).toContainText('organise started', { timeout: 15_000 });

  const state = await svall.api.call('state.get', {});
  const crew = Object.values(state.characters).find((c) => c.islandId === 'home');
  expect(crew).toBeDefined();
  expect(crew!.name).toBe('organise');
  expect(crew!.cell).toEqual({ x: 1, y: 1 });
  await expect(page.getByTestId(`token-${crew!.id}`)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect.poll(async () => (await svall.api.call('char.read', { id: crew!.id, source: 'transcript', lines: 5 })).text, { timeout: 15_000 })
    .toContain('/svall-organise');

  await page.getByTestId('home-new').click();
  await expect(home.locator('.tok')).toHaveCount(2, { timeout: 15_000 });
  const second = Object.values((await svall.api.call('state.get', {})).characters).find((c) => c.islandId === 'home' && c.id !== crew!.id);
  expect(second!.cell).toEqual({ x: 4, y: 1 });
});

test('the chevron collapses home to its row and the choice survives a reload', async ({ page, svall }) => {
  await svall.open('map');
  const home = page.getByTestId('home');
  await page.getByTestId('home-toggle').click();
  await expect(home).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('island-home')).toHaveCount(0);
  await expect(page.getByTestId('home-action-rename')).toBeVisible();

  await svall.open('map');
  await expect(page.getByTestId('home')).toHaveAttribute('data-collapsed', 'true');
  await page.getByTestId('home-toggle').click();
  await expect(page.getByTestId('island-home')).toBeVisible();
});

// a crew card crossing the home boundary changes its DOM parent mid-drag; the drag has to survive that
test('a card drags onto a home slot and back out to the map', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('crew'), seed: 4, position: { x: 0, y: 40 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'wanderer' });
  await svall.open('map');
  const token = page.getByTestId(`token-${c.id}`);
  await expect(token).toBeVisible();

  // the fit ease keeps shifting the layout for a few frames after a move
  const settle = () => page.waitForFunction(() => {
    const m = (window as unknown as { __map: { layout(): unknown } }).__map;
    const before = JSON.stringify(m.layout());
    return new Promise<boolean>((done) => setTimeout(() => done(before === JSON.stringify(m.layout())), 100));
  });
  const drag = async (to: { x: number; y: number }) => {
    await settle();
    const from = (await token.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move((from.x + from.width / 2 + to.x) / 2, (from.y + from.height / 2 + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  };

  // the first crew slot, in page coordinates: home is drawn in screen space, flush with the bottom edge
  const map = (await page.getByTestId('map').boundingBox())!;
  const homeBox = (await page.getByTestId('home').boundingBox())!;
  const slot = { x: homeBox.x + theme.pad + 1.5 * theme.cell, y: map.y + map.height - theme.home.visible + 1.5 * theme.cell };

  await drag(slot);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].islandId).toBe('home');
  expect((await svall.api.call('state.get', {})).characters[c.id].cell).toEqual({ x: 1, y: 1 });

  // and back out: a drop on its own island must move it there, not strand it on the crossing cell
  const back = spacedCells(island.size, island.seed, 3)[2];
  const world = { x: island.position.x + back.x, y: island.position.y + back.y };
  await settle();
  const at = await page.evaluate((w) => (window as unknown as { __map: { screenOf(c: { x: number; y: number }): { x: number; y: number } } }).__map.screenOf(w), world);
  const cs = await page.evaluate(() => { const l = (window as unknown as { __map: { layout(): { scale: number; tile: number } } }).__map.layout(); return l.scale * l.tile; });
  await settle();
  await drag({ x: map.x + at.x + cs / 2, y: map.y + at.y + cs / 2 });
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].islandId).toBe(island.id);
  expect((await svall.api.call('state.get', {})).characters[c.id].cell).toEqual(back);
});

test('a card dropped on a shrunk mission control lands in the slot under the pointer', async ({ page, svall }) => {
  // five crew make home 17 cells wide; the first leaves its slot free
  const crew = [];
  for (let n = 0; n < 5; n++) crew.push(await svall.api.call('char.create', { islandId: 'home', cwd: '/tmp', name: `crew-${n}` }));
  await svall.api.call('char.close', { id: crew[0].id });
  const island = await svall.api.call('island.create', { name: svall.uniq('crew'), seed: 4, position: { x: 0, y: 40 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'wanderer' });
  await svall.open('map');
  await setMapWidth(page, 700);

  const map = (await page.getByTestId('map').boundingBox())!;
  const drawn = async () => (await page.getByTestId('island-home').boundingBox())!;
  // home shrinks a frame after the map takes its width
  await expect.poll(async () => (await drawn()).width / (17 * theme.cell + 2 * theme.pad)).toBeLessThan(0.75);
  const land = await drawn(), s = land.width / (17 * theme.cell + 2 * theme.pad);
  // the middle of slot 1, on land drawn at s and standing on the map's bottom edge
  const slot = { x: land.x + (theme.pad + 1.5 * theme.cell) * s, y: map.y + map.height - (theme.home.visible - 1.5 * theme.cell) * s };
  const from = (await page.getByTestId(`token-${c.id}`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(slot.x, slot.y - 100, { steps: 6 });
  await page.mouse.move(slot.x, slot.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].islandId).toBe('home');
  expect((await svall.api.call('state.get', {})).characters[c.id].cell).toEqual({ x: 1, y: 1 });
  expect((await svall.api.call('state.get', {})).characters[crew[1].id].cell).toEqual({ x: 4, y: 1 });
});

test('a card dropped past the last slot of a full mission control joins it at the end, and nobody leaves', async ({ page, svall }) => {
  // two crew fill home's two slots
  const crew = [];
  for (let n = 0; n < 2; n++) crew.push(await svall.api.call('char.create', { islandId: 'home', cwd: '/tmp', name: `crew-${n}` }));
  const island = await svall.api.call('island.create', { name: svall.uniq('crew'), seed: 4, position: { x: 0, y: 40 } });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'wanderer' });
  await svall.open('map');

  const map = (await page.getByTestId('map').boundingBox())!;
  const land = (await page.getByTestId('island-home').boundingBox())!;
  // the middle of home's last column, where the slot after slot 4 would stand
  const end = { x: land.x + theme.pad + 7.5 * theme.cell, y: map.y + map.height - theme.home.visible + 1.5 * theme.cell };
  const from = (await page.getByTestId(`token-${c.id}`).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y - 100, { steps: 6 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].islandId).toBe('home');
  const s = await svall.api.call('state.get', {});
  expect(s.characters[c.id].cell).toEqual({ x: 7, y: 1 });
  expect(s.islands.home.size.w).toBe(11);
  expect(crew.map((m) => s.characters[m.id])).toMatchObject([{ islandId: 'home', cell: { x: 1, y: 1 } }, { islandId: 'home', cell: { x: 4, y: 1 } }]);
});

test('Cmd+G sends a prompt to a fresh mission control agent', async ({ page, svall }) => {
  await svall.open('map');
  await page.keyboard.press('Meta+g');
  await expect(page.getByTestId('mission-prompt')).toBeVisible();

  await page.getByTestId('mission-prompt-text').fill('regroup the fleet');
  // the dialog lets go before the daemon answers: record which of the two the page shows first
  await page.evaluate(() => {
    const order: string[] = ((window as unknown as { __order: string[] }).__order = []);
    const note = (what: string, seen: boolean) => { if (seen && !order.includes(what)) order.push(what); };
    new MutationObserver(() => {
      note('answered', /started/.test(document.querySelector('[data-testid="toast"]')?.textContent ?? ''));
      note('closed', !document.querySelector('[data-testid="mission-prompt"]'));
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByTestId('mission-prompt-text').press('Enter');
  await expect(page.getByTestId('mission-prompt')).toHaveCount(0);

  await expect(page.getByTestId('home').locator('.tok')).toHaveCount(1, { timeout: 15_000 });
  // only once the daemon has answered is there an agent to read
  await expect(page.getByTestId('toast')).toContainText('started', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __order: string[] }).__order)).toEqual(['closed', 'answered']);
  const crew = Object.values((await svall.api.call('state.get', {})).characters).find((c) => c.islandId === 'home');
  expect(crew).toBeDefined();
  await expect.poll(async () => (await svall.api.call('char.read', { id: crew!.id, source: 'transcript', lines: 5 })).text, { timeout: 15_000 })
    .toContain('regroup the fleet');
});
