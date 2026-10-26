import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, nativeShell, receive, sent, test, type Svall } from './fixtures.js';

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a';
const fakeShell = (page: Page, svall: Svall) =>
  nativeShell(page, { port: svall.port, token: svall.token, info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });

// the state the daemon restarts on, edited by hand
async function rewrite(svall: Svall, edit: (state: { machines?: unknown; robots: Record<string, Record<string, unknown>> }) => void): Promise<void> {
  await svall.stopDaemon();
  const file = path.join(svall.home, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(state);
  fs.writeFileSync(file, JSON.stringify(state));
  await svall.startDaemon();
}

/** ada on an island of her own, with linus-vault as the home last saw it; `ada` edits her record. */
async function seed(svall: Svall, reachable: boolean, ada?: (c: Record<string, unknown>) => void): Promise<string> {
  const island = await svall.api.call('island.create', { name: svall.uniq('vault') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  await rewrite(svall, (state) => {
    state.machines = { [VAULT]: { name: 'linus-vault', reachable, since: Date.now() } };
    ada?.(state.robots[a.id]);
  });
  return a.id;
}

// a robot placed on a machine that is gone cannot be closed, so the next spec's fixture finds every robot back home
test.afterEach(async ({ svall }) => {
  const state = await svall.api.call('state.get', {});
  if (!state.machines) return;
  await rewrite(svall, (s) => {
    delete s.machines;
    for (const c of Object.values(s.robots)) { delete c.machine; delete c.moving; }
  });
});

test('a placed robot shows its machine badge, Move to this Mac, and a not-reachable terminal when the link is down', async ({ page, svall }) => {
  const id = await seed(svall, false, (c) => { c.machine = VAULT; });
  await fakeShell(page, svall);
  await svall.open();
  await expect(page.getByTestId(`kc-${id}`)).toHaveAttribute('data-status', 'unknown');
  await expect(page.getByTestId(`kc-machine-${id}`)).toHaveText('linus-vault');
  await page.getByTestId(`kc-${id}`).dblclick();
  await expect(page.getByTestId('terminal-unreachable')).toHaveText('linus-vault is not reachable');
  expect((await sent(page)).some((m) => m.type === 'term.show' && m.id === id)).toBe(false);

  const card = page.getByTestId('side-card');
  await expect(card.locator('.kicker').first()).toContainText('unknown');
  await expect(card.getByTestId('side-machine')).toHaveText('linus-vault');
  await expect(card.getByTestId('side-move-home')).toHaveText('Move to this Mac');
  await expect(card.getByTestId('side-cwd')).toHaveAttribute('title', 'Copy linus-vault:/tmp');
  await expect(card.getByTestId('side-finder')).toHaveText('Terminal there');

  // the machine terminal, in the robot's folder, once the registry names the way there
  await card.getByTestId('side-finder').click();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux', gateway: false, fleets: [] }] });
  await expect(page.getByTestId('host-terminal-note')).toContainText("cd '/tmp'");
  await expect.poll(async () => (await sent(page)).find((m) => m.type === 'term.show' && m.id === 'machine:linus-vault'))
    .toMatchObject({ machine: { ssh: 'linus@vault', type: "cd '/tmp'" } });

  await svall.open('map');
  await expect(page.getByTestId(`token-${id}`)).toHaveAttribute('data-status', 'unknown');
  await expect(page.getByTestId(`token-machine-${id}`)).toHaveText('linus-vault');
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
