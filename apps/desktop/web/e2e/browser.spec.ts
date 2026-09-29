import { expect, test } from './fixtures.js';

test('the browser pane opens beside the terminal, tabs come from the address bar and close from the strip', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('web') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'surfer' });
  await svall.open();
  await expect(page.getByTestId('browser-area')).toHaveCount(0);
  // the pane opens under the key that asks for the address bar, and the address bar is where the keys land
  await page.keyboard.press('Meta+l');
  await expect(page.getByTestId('browser-area')).toBeVisible();
  await expect(page.getByTestId('browser-address')).toBeFocused();
  // the pane opens on the start page rather than an empty frame, and closing that tab leaves it empty
  const start = page.getByTestId('browser-tabs').locator('[data-testid^="btab-"]:not([data-testid^="btab-close-"])');
  await expect(start).toHaveCount(1);
  const first = (await svall.api.call('state.get', {})).characters[c.id].browser!.tabs[0];
  expect(first.url).toBe('https://www.google.com');
  await page.getByTestId(`btab-close-${first.id}`).click();
  await expect(page.getByTestId('browser-empty')).toBeVisible();
  // the terminal keeps its place on the left
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', c.id);

  await page.getByTestId('browser-address').fill('example.com');
  await page.getByTestId('browser-address').press('Enter');
  const tab = page.getByTestId('browser-tabs').locator('[data-testid^="btab-"]:not([data-testid^="btab-close-"])');
  await expect(tab).toHaveCount(1);
  await expect(tab.first()).toHaveAttribute('data-active', 'true');
  const tabs = (await svall.api.call('state.get', {})).characters[c.id].browser!.tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0].url).toBe('https://example.com');
  // without the shell the surface is a placeholder naming the tab
  await expect(page.getByTestId('browser-surface')).toHaveAttribute('data-tab', tabs[0].id);

  // + then a url is a tab of its own, not a page loaded into the first
  await page.getByTestId('browser-new').click();
  await page.getByTestId('browser-address').fill('c.test');
  await page.getByTestId('browser-address').press('Enter');
  await expect(tab).toHaveCount(2);
  await expect(page.getByTestId(`btab-${tabs[0].id}`)).toHaveAttribute('data-active', 'false');
  const third = (await svall.api.call('state.get', {})).characters[c.id].browser!.tabs[1];
  expect(third.url).toBe('https://c.test');
  await page.getByTestId(`btab-close-${third.id}`).click();
  await expect(tab).toHaveCount(1);

  // a second tab from svalld shows up active; closing it from the strip goes back to the first
  const second = await svall.api.call('browser.open', { id: c.id, url: 'https://b.test/' });
  await expect(page.getByTestId(`btab-${second.id}`)).toHaveAttribute('data-active', 'true');
  await page.getByTestId(`btab-close-${second.id}`).click();
  await expect(page.getByTestId(`btab-${second.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`btab-${tabs[0].id}`)).toHaveAttribute('data-active', 'true');
  // the stored url names the active tab until the shell reports a page of its own
  await expect(page.getByTestId('browser-address')).toHaveValue(tabs[0].url);

  // the panes are the page's own: a reload brings the character back on one, and the browser opens beside it
  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('browser-area')).toHaveCount(0);
  await page.getByTestId('pane-split').click();
  await page.getByTestId('pane-right-browser').click();
  await expect(page.getByTestId('browser-area')).toBeVisible();
});

test("the map's card flips between the terminal and the browser", async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('web') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'surfer' });
  const tab = await svall.api.call('browser.open', { id: c.id, url: 'https://a.test/' });
  await svall.open('map');
  // the card opens the way card.spec.ts opens it: the first click selects the token, the second opens it
  const token = page.getByTestId(`token-${c.id}`);
  await token.click();
  await token.click();
  const card = page.getByTestId('terminal-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('surface')).toBeVisible();
  await expect(card.getByTestId('pane-left-terminal')).toHaveAttribute('data-active', 'true');
  await card.getByTestId('pane-left-browser').click();
  await expect(card.getByTestId('browser-area')).toBeVisible();
  await expect(card.getByTestId('surface')).toHaveCount(0);
  await expect(card.getByTestId(`btab-${tab.id}`)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Meta+b');
  await expect(card.getByTestId('surface')).toBeVisible();
  await expect(card.getByTestId('browser-area')).toHaveCount(0);
});
