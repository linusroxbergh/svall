import { expect, test } from './fixtures.js';

test('the first-run tour waits for the settings card, starts on the first robot and stays done', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  const tour = page.getByTestId('tour');
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(tour).toHaveCount(0);
  await page.getByTestId('settings-close').click();
  await expect(tour).toContainText('1 of 5');
  await expect(tour).toContainText('A shell in /tmp');
  // selected, so Enter opens it, with its side card open for the next step
  await expect(page.getByTestId('side-name')).toHaveValue(c.name);
  for (const [i, title] of ['What the robot knows', 'Resources', 'Robots make robots', 'Mission control'].entries()) {
    await page.getByTestId('tour-next').click();
    await expect(tour).toContainText(`${i + 2} of 5`);
    await expect(tour).toContainText(title);
  }
  await expect(page.getByTestId('tour-skip')).toHaveCount(0);
  await page.getByTestId('tour-next').click();
  await expect(tour).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(tour).toHaveCount(0);
});

test('skipping the tour ends it for good', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { firstRun: true, tour: true });
  await page.getByTestId('settings-close').click();
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('a machine past its first run gets no tour', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('first') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp' });
  await svall.open('map', { tour: true });
  await expect(page.getByTestId(`token-${c.id}`)).toBeVisible();
  // the tour would land within a frame of its anchor showing
  await page.waitForTimeout(300);
  await expect(page.getByTestId('tour')).toHaveCount(0);
});
