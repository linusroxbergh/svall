import { expect, test } from './fixtures.js';

async function openCard(page: import('@playwright/test').Page, id: string) {
  // the first click selects the token, the second opens its card
  const token = page.getByTestId(`token-${id}`);
  await token.click();
  await token.click();
  const card = page.getByTestId('terminal-card');
  await expect(card).toBeVisible();
  return card;
}

test('a card opens on one pane, splits in two, and each side closes on its own', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('split') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'pair' });
  await svall.open('map');
  const card = await openCard(page, c.id);
  await expect(card.getByTestId('pane-right')).toHaveCount(0);
  await expect(card.getByTestId('pane-left-terminal')).toHaveAttribute('data-active', 'true');
  await card.getByTestId('pane-split').click();
  await expect(card.getByTestId('pane-right-terminal')).toHaveAttribute('data-active', 'true');
  await expect(card.getByTestId('pane-split')).toHaveCount(0);
  await card.getByTestId('pane-right-browser').click();
  await expect(card.getByTestId('surface')).toBeVisible();
  await expect(card.getByTestId('browser-area')).toBeVisible();
  // the keys stay with the left pane
  await page.keyboard.press('Meta+3');
  await expect(card.getByTestId('pane-left-files')).toHaveAttribute('data-active', 'true');
  await expect(card.getByTestId('pane-right-browser')).toHaveAttribute('data-active', 'true');
  await card.getByTestId('pane-left-close').click();
  await expect(card.getByTestId('pane-right')).toHaveCount(0);
  await expect(card.getByTestId('pane-left-browser')).toHaveAttribute('data-active', 'true');
});

test('a split starts the second terminal, and it shows on the token and ends with its shell', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('two') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'twin' });
  await svall.open('map');
  const card = await openCard(page, c.id);
  await card.getByTestId('pane-split').click();
  await expect(card.getByTestId('pane-right-terminal')).toHaveText(/Terminal 2/);
  await expect(card.getByTestId('surface')).toHaveCount(2);
  await expect(page.getByTestId(`token-pips-${c.id}`)).toBeVisible();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[c.id].second).toBeTruthy();
  await svall.api.call('char.run', { id: c.id, text: 'exit', term: 2 });
  await expect(card.getByTestId('pane-right')).toHaveCount(0);
  await expect(page.getByTestId(`token-pips-${c.id}`)).toHaveCount(0);
});

test('the board shows the same panes as the card', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('same') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'mirror' });
  await svall.open('map');
  const card = await openCard(page, c.id);
  await card.getByTestId('pane-split').click();
  await page.keyboard.press('Meta+m');
  const board = page.getByTestId('board');
  await expect(board.getByTestId('pane-right-terminal')).toHaveAttribute('data-active', 'true');
  await board.getByTestId('pane-right-close').click();
  await expect(board.getByTestId('pane-right')).toHaveCount(0);
});
