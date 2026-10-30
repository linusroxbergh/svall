import type { Page } from '@playwright/test';
import type { SetupRow } from '@svall/protocol';
import { expect, nativeShell, receive, rewrite, sent, seed, test, unplace, VAULT, type Svall } from './fixtures.js';

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
  await expect(card.locator('.kicker').first()).toContainText('unreachable');
  await expect(card.getByTestId('side-machine')).toHaveText('Runs on linus-vault');
  await expect(card.getByTestId('side-away')).toHaveText('linus-vault is not reachableCheck linus-vault');
  await expect(card.getByTestId('side-move-home')).toHaveText('Move to this Mac');
  // one size of button in two columns: the folder pair, the move alone on its row across both, then open and delete
  const box = async (t: string) => (await card.getByTestId(t).boundingBox())!;
  const [there, res, home, open, close] = await Promise.all(['side-finder', 'side-resources', 'side-move-home', 'side-open', 'side-close'].map(box));
  expect(new Set([there, res, home, open, close].map((b) => b.height)).size).toBe(1);
  expect([there.y, open.y]).toEqual([res.y, close.y]);
  expect(there.y < home.y && home.y < open.y).toBe(true);
  expect(home.width).toBeCloseTo(close.x + close.width - open.x, 0);
  await expect(card.getByTestId('side-cwd')).toHaveAttribute('data-tip', 'Copy linus-vault:/tmp');
  await expect(card.getByTestId('side-finder')).toHaveText('Terminal there');

  // the machine terminal, in the robot's folder, once the registry names the way there
  await card.getByTestId('side-finder').click();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux' }] });
  await expect(page.getByTestId('host-terminal-note')).toContainText("cd '/tmp'");
  await expect.poll(async () => (await sent(page)).find((m) => m.type === 'term.show' && m.id === 'machine:linus-vault'))
    .toMatchObject({ machine: { ssh: 'linus@vault', type: "cd '/tmp'" } });

  // a neighbour here, to hold the placed robot's card up against
  const here = await svall.api.call('robot.create', { islandId: (await svall.api.call('state.get', {})).robots[id].islandId, cwd: '/tmp', name: 'bo' });
  await svall.open('map');
  await expect(page.getByTestId(`token-${id}`)).toHaveAttribute('data-status', 'unknown');
  await expect(page.getByTestId(`token-machine-${id}`)).toHaveText('on linus-vault');
  // the band tops the card and takes nothing from it: the figure, the foot and the printed frame sit as on its neighbour
  // read from layout, which a hover's or a selection's transform leaves alone
  const paper = (c: string) => page.getByTestId(`token-${c}`).locator('.card').evaluate((el) => {
    const px = (v: string) => parseFloat(v);
    const card = getComputedStyle(el);
    return { stage: px(getComputedStyle(el.querySelector('.stage')!).height), bottom: px(card.marginTop) + px(card.height), frame: px(getComputedStyle(el, '::before').top) };
  });
  const [placed, plain] = [await paper(id), await paper(here.id)];
  const band = await page.getByTestId(`token-machine-${id}`).evaluate((el) => parseFloat(getComputedStyle(el).height));
  expect(placed.stage).toBeCloseTo(plain.stage, 1);
  expect(placed.bottom).toBeCloseTo(plain.bottom, 1);
  expect(placed.frame).toBeCloseTo(plain.frame + band, 1);
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

test('a robot sharing a main checkout gets its own worktree in the one sheet, and moves with it', async ({ page, svall }) => {
  const id = await seed(svall, true);
  // svalld behind the page, but for the move's check and start, which answer as for a robot sharing svall's main checkout
  const asked: { method: string; params: { ownWorktree?: boolean } }[] = [];
  await page.routeWebSocket((url) => url.port === String(svall.port), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; method?: string; params: { ownWorktree?: boolean } };
      if (m.method !== 'robot.moveCheck' && m.method !== 'robot.moveTo') { server.send(raw); return; }
      asked.push({ method: m.method, params: m.params });
      const sheet = {
        sessionBytes: 0, branch: 'ada', commits: 0, changedFiles: 0, untrackedFiles: 0, clone: 'warm', credentialFiles: [], stays: [], interrupts: false, question: false,
        converts: { main: '/Users/ada/svall', branch: 'ada', changed: 3, keep: true }, notInRepo: false,
      };
      const result = m.method === 'robot.moveTo' ? { moveId: 'mv_0123456789' } : m.params.ownWorktree
        ? { ok: true, sheet } : { ok: false, refusal: { reason: "two robots share svall's main checkout", action: 'give it its own worktree', details: [] } };
      ws.send(JSON.stringify({ id: m.id, result }));
    });
  });
  await svall.open();
  await page.getByTestId(`sb-robot-${id}`).click();
  await page.getByTestId('side-card').getByTestId(`side-move-${VAULT}`).click();
  const sheet = page.getByTestId('move-sheet');
  await expect(sheet.getByTestId('move-converts')).toHaveText("it leaves svall's main checkout for a new branch ada; the checkout keeps its 3 changed files");
  await expect(sheet.getByTestId('move-refusal')).toHaveCount(0);
  await expect(sheet.getByLabel(/^Give it its own worktree/)).toBeChecked();
  await sheet.getByTestId('move-go').click();
  await expect(sheet.getByTestId('move-through')).toHaveText('ada runs on linus-vault.');
  expect(asked.at(-1)).toEqual({ method: 'robot.moveTo', params: { id, machine: VAULT, ownWorktree: true } });
});

test('a move runs in its sheet, one line per step as it gets there, and a failure names its step with one button', async ({ page, svall }) => {
  const id = await seed(svall, true);
  // the daemon answers all but the move, which this page's link to it fakes: its check passes, its phases come as
  // patches of the robot's mark, and its answer comes once asked
  const fake: { page?: (m: unknown) => void; moveTo?: number } = {};
  await page.routeWebSocket((url) => url.port === String(svall.port), (ws) => {
    const daemon = ws.connectToServer();
    fake.page = (m) => ws.send(JSON.stringify(m));
    ws.onMessage((m) => {
      const req = JSON.parse(String(m)) as { id?: number; method?: string };
      if (req.method === 'robot.moveCheck') {
        return fake.page!({ id: req.id, result: { ok: true, sheet: { sessionBytes: 0, branch: '', commits: 0, changedFiles: 0, untrackedFiles: 0, clone: 'warm', credentialFiles: [], stays: [], interrupts: false, question: false, notInRepo: true } } });
      }
      if (req.method === 'robot.moveTo') { fake.moveTo = req.id; return; }
      daemon.send(m);
    });
  });
  await svall.open();
  const mark = (phase: string) => fake.page!({ event: 'state.patch', data: { ops: [{ op: 'add', path: `/robots/${id}/moving`, value: { id: 'mv_0123456789', to: VAULT, phase } }] } });
  await page.getByTestId(`sb-robot-${id}`).click();
  await page.getByTestId('side-card').getByTestId(`side-move-${VAULT}`).click();
  const sheet = page.getByTestId('move-sheet');
  await sheet.getByTestId('move-go').click();
  await expect(sheet.getByTestId('move-step-check')).toHaveText('Checking…');
  await expect.poll(() => fake.moveTo).toBeDefined();

  mark('rest');
  mark('bundle');
  await expect(sheet.getByTestId('move-step-pack')).toHaveText('Packing session…');
  await expect(sheet.getByTestId('move-step-rest')).toHaveText('✓Rested ada');
  await expect(sheet.getByTestId('move-bar').locator('i')).toHaveCount(6);

  mark('prepare');
  fake.page!({ event: 'state.patch', data: { ops: [{ op: 'remove', path: `/robots/${id}/moving` }] } });
  fake.page!({ id: fake.moveTo, error: { code: 'not_reachable', message: 'linus-vault is not reachable', data: { phase: 'prepare', moveId: 'mv_0123456789' } } });
  await expect(sheet.getByTestId('move-step-carry')).toHaveText('✕Carry failed: linus-vault is not reachable; ada is back on this Mac.');
  await expect(sheet.getByTestId('move-step-land')).toHaveCount(0);
  await expect(sheet.locator('.acts button')).toHaveText(['Try again']);
  await sheet.getByTestId('move-run-details').locator('summary').click();
  await expect(sheet.getByTestId('move-run-details')).toContainText('move mv_0123456789');
});

test('a robot that lands on a machine says what of its agent setup will not work there, and its card lists each with its way on', async ({ page, svall }) => {
  const rows: SetupRow[] = [
    {
      key: 'claude:mcp:linear', status: 'warn', detail: 'copied without its keys (env.LINEAR_API_KEY lin…90)', action: "copy linear's keys to linus-vault",
      tick: { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: false, preview: ['env.LINEAR_API_KEY lin…90'] }, gap: { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' },
    },
    {
      key: 'oauth:claude:mcp:notion', status: 'warn', detail: 'then /mcp and sign in to notion', action: 'log in once on linus-vault', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118,
      gap: { name: 'notion', what: 'not logged in' },
    },
  ];
  // svalld behind the page, but for machines.setup, which answers as linus-vault's mirror would for this robot
  const asked: unknown[] = [];
  await page.routeWebSocket((url) => url.port === String(svall.port), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; method?: string; params?: unknown };
      if (m.method !== 'machines.setup') { server.send(raw); return; }
      asked.push(m.params);
      ws.send(JSON.stringify({ id: m.id, result: { rows } }));
    });
  });
  const id = await seed(svall, true, (c) => { c.moving = { id: 'mv_0123456789', to: VAULT, phase: 'activate' }; });
  await fakeShell(page, svall);
  await svall.open();
  await expect(page.getByTestId(`kc-${id}`)).toHaveAttribute('data-status', 'moving');
  await rewrite(svall, (s) => { delete s.robots[id].moving; s.robots[id].machine = VAULT; });

  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('ada is on linus-vault. 2 parts of its agent setup will not work there.', { timeout: 15_000 });
  expect(asked).toContainEqual({ machine: VAULT, robot: id });
  await toast.getByTestId('toast-action').click();
  const card = page.getByTestId('side-card');
  await expect(card.getByTestId('sec-fold-robot.machine')).toHaveText('On linus-vault');
  // folded until opened
  await expect(card.getByTestId('side-gap-claude:mcp:linear')).toHaveCount(0);
  await card.getByTestId('sec-fold-robot.machine').click();
  await expect(card.getByTestId('side-gap-claude:mcp:linear')).toHaveText('linear keys not copied (env.LINEAR_API_KEY)Copy keys');
  await card.getByTestId('side-gap-terminal-oauth:claude:mcp:notion').click();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux' }] });
  await expect.poll(async () => (await sent(page)).find((m) => m.type === 'term.show' && m.id === 'machine:linus-vault'))
    .toMatchObject({ machine: { ssh: 'linus@vault', type: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118 } });
});

test('a placed robot keeps its Resources button', async ({ page, svall }) => {
  const id = await seed(svall, true, (c) => { c.machine = VAULT; });
  await svall.open();
  await page.getByTestId(`sb-robot-${id}`).click();
  await expect(page.getByTestId('side-resources')).toBeVisible();
});
