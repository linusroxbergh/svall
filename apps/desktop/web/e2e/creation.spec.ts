import { expect, test } from './fixtures.js';

test('creation actions stay findable and create on the intended island', async ({ page, svall }) => {
  const a = await svall.api.call('island.create', { name: svall.uniq('first'), position: { x: 0, y: 200 } });
  const b = await svall.api.call('island.create', { name: svall.uniq('second'), position: { x: 12, y: 200 } });
  await svall.open('map');

  await expect(page.getByTestId('sidebar-new-island')).toHaveText('+ New island');
  const sidebarAction = page.getByTestId(`sb-island-new-${a.id}`);
  await expect(sidebarAction).toBeVisible();
  await expect(sidebarAction).toHaveAccessibleName(`New character on ${a.name}`);
  await expect(page.getByTestId(`island-new-${a.id}`)).toHaveAttribute('data-empty', 'true');

  // An empty island's action folds away with it.
  await page.getByTestId(`sb-island-toggle-${a.id}`).click();
  await expect(sidebarAction).toBeHidden();
  await page.getByTestId(`sb-island-toggle-${a.id}`).click();
  await sidebarAction.click();
  await expect.poll(async () => Object.values((await svall.api.call('state.get', {})).characters).filter((c) => c.islandId === a.id).length).toBe(1);
  await expect(page.getByTestId('terminal-card')).toBeVisible();
  await page.getByTestId('card-close').click();

  // An occupied row's add action shows only under the pointer or keyboard focus; an empty map island gets a land action.
  const rowAction = page.getByTestId(`sb-island-new-${a.id}`);
  await expect(rowAction).toHaveAccessibleName(`New character on ${a.name}`);
  await expect(rowAction).toHaveCSS('opacity', '0');
  await expect(page.getByTestId(`island-new-${a.id}`)).toHaveAttribute('data-empty', 'false');
  await rowAction.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(rowAction).toBeFocused();
  await expect(rowAction).toHaveCSS('opacity', '1');
  await rowAction.click();
  await expect.poll(async () => Object.values((await svall.api.call('state.get', {})).characters).filter((c) => c.islandId === a.id).length).toBe(2);
  await page.getByTestId('card-close').click();

  const coastAction = (await page.getByTestId(`island-new-${a.id}`).boundingBox())!;
  const coast = (await page.getByTestId(`island-${a.id}`).locator('path.grass').boundingBox())!;
  expect(coastAction.x + coastAction.width).toBeLessThanOrEqual(coast.x + coast.width + 10);
  const mapAction = page.getByTestId(`island-new-${b.id}`);
  await expect(mapAction).toHaveAttribute('data-empty', 'true');
  await mapAction.click();
  await expect.poll(async () => Object.values((await svall.api.call('state.get', {})).characters).filter((c) => c.islandId === b.id).length).toBe(1);
  await page.getByTestId('card-close').click();

  await page.getByTestId(`island-label-${b.id}`).click();
  const cardAction = page.getByTestId('side-island-new');
  const heading = page.getByTestId('side-island-name');
  const description = page.getByTestId('side-island-description');
  await expect(cardAction).toBeVisible();
  expect((await cardAction.boundingBox())!.y).toBeLessThan((await description.boundingBox())!.y);
  expect((await heading.boundingBox())!.y).toBeLessThan((await description.boundingBox())!.y);
});

test('creation controls fit at the minimum sidebar and card widths', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: 'A long island name', position: { x: 0, y: 200 } });
  await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'first' });
  await svall.open('map');
  const grip = (await page.getByTestId('side-drag-sidebar').boundingBox())!;
  const y = grip.y + grip.height / 4;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 100, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())!.width).toBeLessThanOrEqual(181);

  const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
  for (const id of ['sidebar-new-island', `sb-island-new-${island.id}`]) {
    const control = (await page.getByTestId(id).boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(sidebar.x);
    expect(control.x + control.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  }
  const islandRow = (await page.getByTestId(`sb-island-${island.id}`).boundingBox())!;
  const islandName = (await page.getByTestId(`sb-island-${island.id}`).getByTestId('island-name').boundingBox())!;
  const islandAction = (await page.getByTestId(`sb-island-new-${island.id}`).boundingBox())!;
  expect(islandName.width).toBeGreaterThan(55);
  expect(islandAction.y).toBeGreaterThanOrEqual(islandRow.y);
  expect(islandAction.y + islandAction.height).toBeLessThanOrEqual(islandRow.y + islandRow.height);

  await page.getByTestId(`island-label-${island.id}`).click();
  const cardGrip = (await page.getByTestId('side-drag-card').boundingBox())!;
  const cardY = cardGrip.y + cardGrip.height / 4;
  await page.mouse.move(cardGrip.x + cardGrip.width / 2, cardY);
  await page.mouse.down();
  await page.mouse.move(cardGrip.x + 100, cardY, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await page.getByTestId('side-island-card').boundingBox())!.width).toBeLessThanOrEqual(241);
  const card = (await page.getByTestId('side-island-card').boundingBox())!;
  const action = (await page.getByTestId('side-island-new').boundingBox())!;
  expect(action.x + action.width).toBeLessThanOrEqual(card.x + card.width);

  await page.setViewportSize({ width: 960, height: 720 });
  const map = (await page.getByTestId('map').boundingBox())!;
  for (const id of ['home-new-island', 'home-new']) {
    const control = (await page.getByTestId(id).boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(map.x);
    expect(control.x + control.width).toBeLessThanOrEqual(map.x + map.width);
  }
});
