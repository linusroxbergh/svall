import type { Page } from '@playwright/test';
import { expect, nativeShell, receive, sent, seed, test, unplace, VAULT, type Svall } from './fixtures.js';

test.afterEach(async ({ svall }) => { await unplace(svall); });

const fakeShell = (page: Page, svall: Svall) =>
  nativeShell(page, { port: svall.port, token: svall.token, info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });

test('a placed robot names its machine on its card, row, panes and token, offers Move to this Mac, and a not-reachable terminal when the link is down', async ({ page, svall }) => {
  const id = await seed(svall, false, (c) => { c.machine = VAULT; });
  await fakeShell(page, svall);
  await svall.open();
  await expect(page.getByTestId(`kc-${id}`)).toHaveAttribute('data-status', 'unknown');
  await expect(page.getByTestId(`kc-machine-${id}`)).toHaveText('on linus-vault');
  await expect(page.getByTestId(`sb-machine-${id}`)).toHaveText('on linus-vault');
  await page.getByTestId(`kc-${id}`).dblclick();
  await expect(page.getByTestId('terminal-unreachable')).toHaveText('linus-vault is not reachable');
  await expect(page.getByTestId('pane-left-machine')).toHaveText('Runs on linus-vault');
  expect((await sent(page)).some((m) => m.type === 'term.show' && m.id === id)).toBe(false);

  const card = page.getByTestId('side-card');
  await expect(card.locator('.kicker').first()).toContainText('unknown');
  await expect(card.getByTestId('side-machine')).toHaveText('Runs on linus-vault');
  await expect(card.getByTestId('side-move-home')).toHaveText('Move to this Mac');
  // one size of button in two columns: the folder pair, the move alone on its row across both, then open and delete
  const box = async (t: string) => (await card.getByTestId(t).boundingBox())!;
  const [there, res, home, open, close] = await Promise.all(['side-finder', 'side-resources', 'side-move-home', 'side-open', 'side-close'].map(box));
  expect(new Set([there, res, home, open, close].map((b) => b.height)).size).toBe(1);
  expect([there.y, open.y]).toEqual([res.y, close.y]);
  expect(there.y < home.y && home.y < open.y).toBe(true);
  expect(home.width).toBeCloseTo(close.x + close.width - open.x, 0);
  await expect(card.getByTestId('side-cwd')).toHaveAttribute('title', 'Copy linus-vault:/tmp');
  await expect(card.getByTestId('side-finder')).toHaveText('Terminal there');

  // the machine terminal, in the robot's folder, once the registry names the way there
  await card.getByTestId('side-finder').click();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux' }] });
  await expect(page.getByTestId('host-terminal-note')).toContainText("cd '/tmp'");
  await expect.poll(async () => (await sent(page)).find((m) => m.type === 'term.show' && m.id === 'machine:linus-vault'))
    .toMatchObject({ machine: { ssh: 'linus@vault', type: "cd '/tmp'" } });

  await svall.open('map');
  await expect(page.getByTestId(`token-${id}`)).toHaveAttribute('data-status', 'unknown');
  await expect(page.getByTestId(`token-machine-${id}`)).toHaveText('on linus-vault');
});

test('a placed robot\'s Files and Changes say its machine is not reachable while the link is down', async ({ page, svall }) => {
  const id = await seed(svall, false, (c) => { c.machine = VAULT; });
  await svall.open();
  await page.getByTestId(`kc-${id}`).dblclick();
  for (const kind of ['files', 'changes']) {
    await page.getByTestId(`pane-left-${kind}`).click();
    await expect(page.getByTestId('pane-elsewhere')).toHaveText('linus-vault is not reachable');
  }
});

test('the card greys while moving and shows Retry on an activate error', async ({ page, svall }) => {
  const id = await seed(svall, true, (c) => {
    c.machine = VAULT;
    c.moving = { id: 'mv_0123456789', to: VAULT, phase: 'activate', error: 'claude exited back to its shell' };
  });
  await fakeShell(page, svall);
  await svall.open('map');
  await expect(page.getByTestId(`token-${id}`)).toHaveAttribute('data-status', 'moving');
  await expect(page.getByTestId(`token-${id}`).locator('.card')).toHaveCSS('filter', /grayscale/);

  await svall.open();
  await expect(page.getByTestId(`kc-${id}`)).toHaveAttribute('data-status', 'moving');
  await page.getByTestId(`kc-${id}`).dblclick();
  const moving = page.getByTestId('terminal-moving');
  await expect(moving).toContainText('moving to linus-vault…');
  await expect(moving.getByTestId('move-error')).toHaveText('claude exited back to its shell');
  await expect(moving.getByTestId('move-retry')).toHaveText('Retry');
  await expect(page.getByTestId('side-card').locator('[data-testid^="side-move"]')).toHaveCount(0);
});

test('mission control has no move button; a refusal shows one sentence and one button', async ({ page, svall }) => {
  const id = await seed(svall, true);
  const crew = await svall.api.call('robot.create', { islandId: 'home', cwd: '/tmp', name: 'crew' });
  await fakeShell(page, svall);
  await svall.open();
  await page.getByTestId(`sb-robot-${crew.id}`).click();
  await expect(page.getByTestId('side-card').getByTestId('side-name')).toHaveValue('crew');
  await expect(page.getByTestId('side-card').locator('[data-testid^="side-move"]')).toHaveCount(0);

  await page.getByTestId(`sb-robot-${id}`).click();
  await expect(page.getByTestId('side-card').getByTestId('side-machine')).toHaveCount(0);
  await page.getByTestId('side-card').getByTestId(`side-move-${VAULT}`).click();
  const sheet = page.getByTestId('move-sheet');
  await expect(sheet.getByTestId('move-title')).toHaveText('Move ada to linus-vault');
  // the daemon's own first check: no link to the machine
  await expect(sheet.getByTestId('move-reason')).toHaveText('linus-vault is not reachable');
  await expect(sheet.locator('.acts button')).toHaveCount(1);
  await expect(sheet.getByTestId('move-go')).toHaveCount(0);
});

test('a placed robot keeps its Resources button', async ({ page, svall }) => {
  const id = await seed(svall, true, (c) => { c.machine = VAULT; });
  await svall.open();
  await page.getByTestId(`sb-robot-${id}`).click();
  await expect(page.getByTestId('side-resources')).toBeVisible();
});
