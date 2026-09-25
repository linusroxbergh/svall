import { expect, test } from './fixtures.js';

test('shows an offline banner while archid is down and recovers with fresh state', async ({ page, archi }) => {
  const island = await archi.api.call('island.create', { name: archi.uniq('reconnect') });
  await archi.open();
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
  await archi.stopDaemon();
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 10_000 });
  await archi.startDaemon();
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId(`sb-island-${island.id}`)).toBeVisible();
  const later = await archi.api.call('island.create', { name: archi.uniq('after') });
  await expect(page.getByTestId(`sb-island-${later.id}`)).toBeVisible();
});
