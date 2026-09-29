import { expect, test } from './fixtures.js';

test('shows an offline banner while svalld is down and recovers with fresh state', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('reconnect') });
  await svall.open();
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
  await svall.stopDaemon();
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 10_000 });
  await svall.startDaemon();
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
  const later = await svall.api.call('island.create', { name: svall.uniq('after') });
  await expect(page.getByTestId(`sb-island-${later.id}`)).toBeVisible();
});
