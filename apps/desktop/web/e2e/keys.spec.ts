import { expect, test } from './fixtures.js';

test('drives the app with the Cmd chords', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('keys') });
  // the path tmux reports for the pane, which the poll writes over the one a character was made with
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/private/tmp', name: 'ka' });
  await svall.open();
  await page.getByTestId(`sb-char-${a.id}`).click();

  await page.keyboard.press('Meta+t');
  await page.getByTestId('new-character-name').fill('kb');
  await page.getByTestId('new-character-name').press('Enter');
  const surface = page.getByTestId('surface');
  const find = async () =>
    Object.values((await svall.api.call('state.get', {})).characters).find((c) => c.islandId === island.id && c.id !== a.id);
  await expect.poll(async () => (await find())?.id).toBeTruthy();
  const created = (await find())!;
  expect(created.cwd).toBe('/private/tmp');
  // the new character is viewed on the board: no card, no view change
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(surface).toHaveAttribute('data-char', created.id);

  // Cmd+2 shows the browser beside the terminal and Cmd+1 puts it away again
  await page.keyboard.press('Meta+2');
  await expect(page.getByTestId('browser-area')).toBeVisible();
  await page.keyboard.press('Meta+1');
  await expect(page.getByTestId('browser-area')).toHaveCount(0);
  await expect(surface).toHaveAttribute('data-char', created.id);

  // the side card edits the viewed character; Escape closes it and the terminal stays put
  await expect(page.getByTestId('side-card')).toBeVisible();
  await expect(page.getByTestId('side-name')).toHaveValue('kb');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('side-card')).toBeHidden();
  await expect(surface).toHaveAttribute('data-char', created.id);

  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
  const card = page.getByTestId('terminal-card');
  await expect(page.getByTestId(`token-${created.id}`)).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Meta+k');
  await expect(page.getByTestId(`token-${a.id}`)).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Meta+j');
  await expect(page.getByTestId(`token-${created.id}`)).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-char', created.id);

  await page.keyboard.press('Meta+w');
  await expect(card).toHaveCount(0);
  // closing the character itself is confirmed: Enter deletes
  await page.keyboard.press('Meta+w');
  await expect(page.getByTestId('confirm-close')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('confirm-close')).toHaveCount(0);
  await expect(page.getByTestId(`token-${created.id}`)).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

test('Cmd+W asks before deleting: Esc and Cancel keep the character, Delete removes it', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('confirm') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'kc' });
  await svall.open('map');
  const token = page.getByTestId(`token-${c.id}`);
  const dialog = page.getByTestId('confirm-close');
  await token.click();

  await page.keyboard.press('Meta+w');
  await expect(dialog).toContainText('kc');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(token).toHaveAttribute('data-selected', 'true');

  await page.keyboard.press('Meta+w');
  await page.getByTestId('confirm-close-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(token).toBeVisible();

  await page.keyboard.press('Meta+w');
  await page.getByTestId('confirm-close-delete').click();
  await expect(token).toHaveCount(0);
});

test('a second Cmd+W deletes like Enter', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('confirmw') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'kw' });
  await svall.open('map');
  const token = page.getByTestId(`token-${c.id}`);
  await token.click();

  await page.keyboard.press('Meta+w');
  await expect(page.getByTestId('confirm-close')).toBeVisible();
  await page.keyboard.press('Meta+w');
  await expect(page.getByTestId('confirm-close')).toHaveCount(0);
  await expect(token).toHaveCount(0);
});

test('Cmd+W on the board confirms with Enter and views the next character', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('confirmb') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ba' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'bb' });
  await svall.open();
  await page.getByTestId(`sb-char-${a.id}`).click();
  const surface = page.getByTestId('surface');
  await expect(surface).toHaveAttribute('data-char', a.id);

  await page.keyboard.press('Meta+w');
  await expect(page.getByTestId('confirm-close')).toContainText('ba');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`sb-char-${a.id}`)).toHaveCount(0);
  await expect(surface).toHaveAttribute('data-char', b.id);
});

test('Enter opens the selection after a button was pressed with the mouse', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('focus') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'kf' });
  await svall.open('map');

  await page.getByTestId(`token-${c.id}`).click();
  await expect(page.getByTestId(`token-${c.id}`)).toHaveAttribute('data-selected', 'true');
  // arrange survives its own press and moves no focus, so the button keeps it
  await page.getByTestId('home-arrange').click();

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-char', c.id);
});
