import { expect, test } from './fixtures.js';

test('a link asks where it should open, and opening it here puts it in the character\'s browser', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('lnk') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'reader' });
  await svall.api.call('char.update', { id: c.id, context: [{ kind: 'other', ref: 'https://example.com/docs', label: 'docs', source: 'manual' }] });
  await svall.open();

  // a folder has one place to go, so only a web link raises the prompt
  await expect(page.getByTestId('link-ask')).toHaveCount(0);
  await page.getByTestId('side-context').locator('a').first().click();
  const ask = page.getByTestId('link-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('example.com/docs');

  // a click anywhere else puts it away without opening anything
  await page.mouse.click(5, 5);
  await expect(ask).toHaveCount(0);
  expect((await svall.api.call('state.get', {})).characters[c.id].browser).toBeUndefined();

  // opening it here shows the browser beside the terminal with the link as its tab
  await page.getByTestId('side-context').locator('a').first().click();
  await page.getByTestId('link-ask-here').click();
  await expect(page.getByTestId('link-ask')).toHaveCount(0);
  await expect(page.getByTestId('browser-area')).toBeVisible();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].browser?.tabs.map((t) => t.url))
    .toEqual(['https://example.com/docs']);
});
