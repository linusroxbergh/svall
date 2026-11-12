import { expect, nativeShell, receive, rewrite, seed, sent, test, unplace, VAULT } from './fixtures.js';
import type { HostStep, ToShell } from '../src/bridge.js';

test.afterEach(async ({ svall }) => { await unplace(svall); });

// what `svall host add --json` prints, one object per line, with a token in what a tool said of the step that failed
const ADD_STEPS = [
  { step: 'ssh', status: 'ok', detail: 'logs in' },
  { step: 'master', status: 'ok', detail: 'connected' },
  { step: 'tmux', status: 'warn', detail: '3.4: Shift+Enter needs 3.5' },
  { step: 'claude', status: 'warn', detail: '1.2.3, not logged in', action: 'ssh linus@studio, then claude auth login', run: 'claude auth login' },
  { step: 'versions', status: 'warn', detail: 'Claude Code 1.2.3 there, 1.2.4 on this Mac', action: 'ssh linus@studio, then claude update', run: 'claude update' },
  { step: 'probe', status: 'fail', detail: 'does not answer', action: 'see why: svall host doctor studio', raw: 'ws://127.0.0.1:47800 refused token=s3cr3t' },
] as const;

const fakeShell = (page: import('@playwright/test').Page, port: number, token: string) =>
  nativeShell(page, { port, token, info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });

test('the machines panel reads the list as it opens, and reports every step', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('settings-tab-machines').click();
  // the pane reads the registry as it opens
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await page.getByTestId('machine-add').click();
  const panel = page.getByTestId('host-setup');
  await expect(panel).toBeVisible();
  // before any run, one line, and what the machine needs behind its Info
  await expect(panel.getByTestId('host-machine')).toHaveText('Add a machine');
  await expect(page.getByTestId('host-intro')).toContainText('Installs Svall on a Linux machine over ssh and lists what is left to do.');
  await page.getByTestId('set-info-host-needs').hover();
  await expect(page.locator('#set-tip-host-needs')).toHaveText('Ubuntu 22.04 LTS or newer with systemd, x86-64 or arm64, and an account you reach over ssh.');

  // a name the registry would refuse never reaches the shell
  await page.getByLabel('name', { exact: true }).fill('Studio');
  await page.getByLabel('ssh destination').fill('linus@studio');
  await expect(page.getByTestId('host-add')).toBeDisabled();
  await page.getByTestId('host-name').fill('studio');
  await page.getByTestId('host-add').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'add', args: { name: 'studio', ssh: 'linus@studio' } });
  await expect(page.getByTestId('host-running')).toHaveText('Adding studio…Stop');
  await expect(panel.getByTestId('host-machine')).toHaveText('Add studio');
  await expect(page.getByTestId('host-intro')).toHaveCount(0);

  for (const event of ADD_STEPS) await receive(page, { type: 'host.step', op: 'add', event });
  await receive(page, { type: 'host.done', op: 'add', code: 1 });

  // an add the machine did not take says where it stopped, once, what a tool said behind details without the token it carried
  await expect(page.locator('[data-testid^="host-step-"]')).toHaveCount(1);
  const probe = page.getByTestId('host-step-probe');
  await expect(probe).toContainText('Final checkdoes not answersee why: svall host doctor studio');
  await probe.locator('summary').click();
  await expect(probe.locator('details')).toHaveText('detailsws://127.0.0.1:47800 refused token=…');
  await expect(page.getByTestId('host-outcome')).toHaveText('Add machine did not finishTry againClose');

  // asked again, its form comes back filled
  await page.getByTestId('host-edit').click();
  await expect(page.getByTestId('host-ssh')).toHaveValue('linus@studio');
  await page.getByTestId('host-add').click();
  for (const event of [...ADD_STEPS.slice(0, -1), { step: 'probe', status: 'ok', detail: 'answers' } as const, { step: 'registry', status: 'ok', detail: 'listed' } as const]) {
    await receive(page, { type: 'host.step', op: 'add', event });
  }
  await receive(page, { type: 'host.done', op: 'add', code: 1 });
  // listed, it is the machine's sheet: what needs the person flat, a warning nobody can act on a note, the rest fine
  await expect(panel.getByTestId('host-machine')).toHaveText('studio');
  await expect(page.locator('[data-testid^="host-step-"]')).toHaveCount(2);
  await expect(page.getByTestId('host-step-claude')).toContainText('Claude Code1.2.3, not logged in');
  // an agent update waits, saying why, until this Mac's list names the machine
  await expect(page.getByTestId('host-update-versions')).toBeDisabled();
  await expect(page.getByTestId('host-update-versions')).toHaveAttribute('data-tip', 'studio is not in the list of machines yet');
  await expect(page.getByTestId('host-notes')).toHaveText('1 note');
  await expect(page.getByTestId('host-fine')).toHaveText('4 checks fine');
  await expect(page.getByTestId('host-outcome')).toHaveText('studio has 2 things to fixCheck againDone');

  // a machine not yet in the list it read is reached at the destination the add was given, and nothing checks it again
  await page.getByTestId('host-terminal-claude').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ id: 'machine:studio', machine: { ssh: 'linus@studio', type: 'claude auth login' } });
  await receive(page, { type: 'term.exited', id: 'machine:studio' });
  await expect(page.getByTestId('host-steps')).toBeVisible();
  expect((await sent(page)).filter((m) => m.type === 'host.start')).toHaveLength(2);
  await page.getByTestId('host-done').click();
  await expect(panel).toHaveCount(0);
});

test('a check says ready, or how many things are left, and Check runs it once more', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'studio', id: 'm1', ssh: 'linus@studio', platform: 'linux-x64' }] });
  await expect(page.getByTestId('machine-studio')).toContainText('not checked yet');
  await page.getByTestId('machine-studio').getByTestId('machine-doctor').click();
  const panel = page.getByTestId('host-setup');
  await expect(panel.getByTestId('host-machine')).toHaveText('Check studio');
  expect((await sent(page)).filter((m) => m.type === 'host.start').at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  // the shell turns each of the report's checks into a step
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'tmux', status: 'ok', detail: '3.5a' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'release', status: 'ok', detail: '0.5.0' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'skip', detail: 'not installed' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'gh', status: 'warn', detail: 'not logged in' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });
  await expect(page.getByTestId('host-notes')).toHaveText('1 note');
  await expect(page.getByTestId('host-fine')).toHaveText('3 checks fine');
  await page.getByTestId('host-fine').click();
  await expect(page.getByTestId('host-phase')).toHaveText(['Svall on studio', 'Agents on studio']);
  await expect(page.getByTestId('host-step-release')).toContainText('0.5.0');
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is readyCheck againDone');

  await panel.getByTestId('machine-doctor').click();
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'systemd', status: 'fail', detail: 'not running', raw: 'svall-svalld@private.service is inactive' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 1 });
  await expect(page.getByTestId('host-step-systemd')).toContainText('Background servicenot running');
  await expect(page.getByTestId('host-step-systemd').locator('details')).not.toHaveAttribute('open');
  await expect(page.getByTestId('host-outcome')).toHaveText('studio has 1 thing to fixCheck againDone');
  await panel.getByTestId('machine-doctor').click();
  expect((await sent(page)).filter((m) => m.type === 'host.start').at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  await panel.getByTestId('machine-more').click();
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'ok', detail: 'answers' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 0 });
  await expect(panel.getByTestId('host-machine')).toHaveText('Upgrade studio');
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is readyCheck againDone');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // an upgrade stopped in install leaves no rollback to offer
  await panel.getByTestId('machine-more').click();
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'install', status: 'fail', detail: 'did not finish', raw: 'svall setup exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await expect(page.getByTestId('host-outcome')).toHaveText('Upgrade did not finishCheck againClose');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // one whose own rollback failed too offers the rollback the CLI names
  await panel.getByTestId('machine-more').click();
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'warn', detail: 'does not answer' } });
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'rollback', status: 'fail', detail: 'on 0.5.0; 0.4.0 could not be put back', raw: 'svall setup --rollback exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await expect(page.getByTestId('host-outcome')).toHaveText('Upgrade did not finishRoll back studioClose');
  await page.getByTestId('host-rollback').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'rollback', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'rollback', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is rolled backCheck againDone');
});

test('a fix the machine leaves to the user opens a terminal there with its command typed, and the machine is checked again once it closes', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'studio', id: 'm1', ssh: 'linus@studio', platform: 'linux-x64' }] });
  await page.getByTestId('machine-studio').getByTestId('machine-doctor').click();
  const panel = page.getByTestId('host-setup');
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'claude', status: 'warn', detail: '2.1.300, not logged in', action: 'claude auth login', run: 'claude auth login' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'warn', detail: '0.156.1, not logged in', action: 'codex login', run: 'codex login' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'tmux', status: 'ok', detail: '3.5a' } });
  // nothing is offered while the check still runs
  await expect(panel.getByTestId('host-terminal-claude')).toHaveCount(0);
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });
  await expect(panel.getByTestId('host-terminal-tmux')).toHaveCount(0);

  await panel.getByTestId('host-terminal-claude').click();
  await expect(panel.getByTestId('host-machine')).toHaveText('Terminal on studio');
  await expect(panel.getByTestId('host-terminal-note')).toContainText('Press Return to log in to Claude Code on studio.');
  await expect(panel.getByTestId('host-steps')).toHaveCount(0);
  const shown = (await sent(page)).filter((m) => m.type === 'term.show');
  expect(shown).toEqual([{ type: 'term.show', id: 'machine:studio', rect: expect.any(Object), machine: { ssh: 'linus@studio', type: 'claude auth login' } }]);
  // the Settings window under the panel gives up no part of the terminal
  const { rect } = shown[0] as Extract<ToShell, { type: 'term.show' }>;
  const hole = async () => ((await sent(page)).filter((m) => m.type === 'shell.cutout').at(-1) as Extract<ToShell, { type: 'shell.cutout' }>).rects
    .some((r) => r.x < rect.x + rect.width && rect.x < r.x + r.width && r.y < rect.y + rect.height && rect.y < r.y + r.height);
  await expect.poll(hole).toBe(false);
  // a click into it leaves the fleet's focus where it was
  const focused = () => page.evaluate(() => localStorage.getItem('svall.focused'));
  const before = await focused();
  await receive(page, { type: 'term.focused', id: 'machine:studio' });
  expect(await focused()).toBe(before);
  // a stray press beside the panel or Escape would hang up what runs there, so only Done or × closes it
  await panel.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Escape');
  await expect(panel.getByTestId('host-terminal')).toBeVisible();
  // its shell exiting is the end of it: the machine's own checks look again
  await receive(page, { type: 'term.exited', id: 'machine:studio' });
  await expect(panel.getByTestId('host-terminal')).toHaveCount(0);
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'warn', detail: '0.156.1, not logged in', action: 'codex login', run: 'codex login' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  // Codex's login waits for the browser on port 1455 there, which a forward from this Mac reaches; an agent the fleet does not run is a note
  await panel.getByTestId('host-notes').click();
  await panel.getByTestId('host-terminal-codex').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('through port 1455 on this Mac');
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio', type: 'codex login', forward: 1455 } });
  // an ssh that quits at once says why, and can be opened again
  await receive(page, { type: 'term.failed', id: 'machine:studio', reason: 'ssh quit as soon as it started: Could not request local forwarding.' });
  // what ssh said waits behind details
  await expect(panel.getByTestId('host-terminal-failed').locator('.said > div > span')).toHaveText(['ssh quit as soon as it started', 'Port 1455 on this Mac is taken, as by a Codex login running here; close that, then try again.']);
  await expect(panel.getByTestId('host-terminal-failed').locator('details')).toHaveText('detailsCould not request local forwarding.');
  await panel.getByTestId('host-terminal-again').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show')).toHaveLength(3);
  // Done goes back to the checks, which look again, and the panel stays
  await panel.getByTestId('host-terminal-done').click();
  await expect.poll(async () => (await sent(page)).slice(-2)).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }, { type: 'term.close', id: 'machine:studio' }]);
  await expect(panel.getByTestId('host-terminal')).toHaveCount(0);
  await expect(panel.getByTestId('host-running')).toBeVisible();
  await expect(panel.getByTestId('host-steps')).toBeAttached();
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  // a plain terminal types nothing, and closing the panel closes it and checks the machine again
  await panel.getByTestId('machine-more').click();
  await panel.getByTestId('machine-terminal').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio' } });
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).not.toHaveProperty('machine.type');
  await expect(panel.getByTestId('host-terminal-note')).toHaveText(/^A shell on studio\./);
  await page.getByTestId('host-close').click();
  await expect.poll(async () => (await sent(page)).filter((m) => m.type === 'host.start' || m.type === 'term.close').slice(-2))
    .toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }, { type: 'term.close', id: 'machine:studio' }]);
});

const MACHINE = '5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const STUDIO = { name: 'studio', id: MACHINE, ssh: 'linus@studio', platform: 'linux-x64' };
const tick = (item: string, field: string, on: boolean) => ({ item, name: item.split(':').at(-1)!, fields: [field], on, preview: [`${field} lin…90`], ticked: on ? [field] : [] });
const unticked = (server: string, agent: string, field: string): HostStep => ({
  step: `mirror:${agent}:mcp:${server}`, status: 'warn', action: `Tick to copy, or set ${field.slice('env.'.length)} on studio: svall worker env ${field.slice('env.'.length)}`,
  tick: tick(`${agent}:mcp:${server}`, field, false), detail: 'not copied', gap: { name: server, what: `keys not copied (${field})` },
});
// what a check of studio says before its report: every step there passed
const PASSED: HostStep[] = [
  { step: 'ssh', status: 'ok', detail: 'logs in' },
  { step: 'release', status: 'ok', detail: '0.5.0' },
  { step: 'claude', status: 'ok', detail: '2.1.310, logged in' },
  { step: 'probe', status: 'ok', detail: 'answers' },
];

/** The Machines pane, with studio in the registry and its check under way. */
async function checking(page: import('@playwright/test').Page, svall: { port: number; token: string; open: () => Promise<void> }) {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [STUDIO] });
  await page.getByTestId('machine-studio').getByTestId('machine-doctor').click();
  return page.getByTestId('host-setup');
}

const doctor = async (page: import('@playwright/test').Page, events: HostStep[], code = 0) => {
  for (const event of events) await receive(page, { type: 'host.step', op: 'doctor', event });
  await receive(page, { type: 'host.done', op: 'doctor', code });
};

test('the setup page ends in one line, the agent setup counted on its fold; a long report keeps its title and verdict in sight; a remove that stopped says so once (remove)', async ({ page, svall }) => {
  const panel = await checking(page, svall);
  await doctor(page, [...PASSED, unticked('linear', 'claude', 'env.LINEAR_API_KEY'), unticked('github', 'codex', 'env.GITHUB_TOKEN')]);
  // nothing needs the user but the agent setup, folded until opened
  await expect(panel.getByTestId('host-phase')).toHaveCount(0);
  await expect(panel.getByTestId('host-fine')).toHaveText('4 checks fine');
  await expect(panel.getByTestId('host-step-mirror:claude:mcp:linear')).toHaveCount(0);
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio is readyCheck againDone');
  // two servers whose keys are not copied are two parts, each with its own row and box
  await expect(panel.getByTestId('host-setup-fold')).toHaveText('Your agent setup · 2 not on studio yet');
  await panel.getByTestId('host-setup-fold').click();
  await expect(panel.getByTestId('host-step-mirror:claude:mcp:linear').locator('.host-name')).toHaveText("linear's LINEAR_API_KEY");
  await expect(panel.getByTestId('host-step-mirror:codex:mcp:github').locator('.host-name')).toHaveText("github's GITHUB_TOKEN");
  for (const step of ['mirror:claude:mcp:linear', 'mirror:codex:mcp:github']) await expect(panel.getByTestId(`host-tick-${step}`)).not.toBeChecked();

  // a report long enough to scroll keeps the title and the outcome in sight
  await panel.getByTestId('machine-doctor').click();
  const vars = Array.from({ length: 40 }, (_, i): HostStep => ({ step: `mirror:var:VAR_${i}`, status: 'ok', detail: 'set' }));
  await doctor(page, [...PASSED, ...vars]);
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio is readyCheck againDone');
  await expect(panel.getByTestId('host-setup-fold')).toHaveText('Your agent setup · all there');
  // all there, the fold, open since the check before, holds the rows themselves
  await expect(panel.getByTestId('host-setup-there')).toHaveCount(0);
  await panel.getByTestId('host-step-mirror:var:VAR_39').scrollIntoViewIfNeeded();
  await expect(panel.getByTestId('host-step-mirror:var:VAR_39')).toBeInViewport();
  await expect(panel.getByTestId('host-machine')).toBeInViewport();
  await expect(panel.getByTestId('host-outcome')).toBeInViewport();
  await expect(panel.getByTestId('host-setup-fold')).not.toBeInViewport();

  await panel.getByTestId('machine-more').click();
  await panel.getByTestId('machine-remove').click();
  await page.getByTestId('host-confirm-yes').click();
  await receive(page, { type: 'host.step', op: 'remove', event: { step: 'uninstall', status: 'fail', detail: 'stopped with an error', raw: 'svall uninstall exited 1' } });
  await receive(page, { type: 'host.done', op: 'remove', code: 1 });
  await expect(panel.getByTestId('host-machine')).toHaveText('Remove studio');
  await expect(panel.getByTestId('host-outcome')).toHaveText('Remove did not finishTry againClose');
});

test("a check's rows line up: names in one column, each details toggle at one x under its sentence, each control at the right edge", async ({ page, svall }) => {
  const panel = await checking(page, svall);
  await doctor(page, [
    { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out', action: 'ssh linus@studio, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus' },
    { step: 'systemd', status: 'fail', detail: 'not running', raw: 'svall-svalld@private.service is inactive' },
    { step: 'claude', status: 'warn', detail: '2.1.310, not logged in a long while on a machine whose name runs on and on', action: 'claude auth login', run: 'claude auth login' },
  ], 1);
  const box = (testid: string, sel: string) => panel.getByTestId(testid).locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right) }; });
  const rows = ['host-step-linger', 'host-step-systemd', 'host-step-claude'];
  const names = await Promise.all(rows.map((r) => box(r, '.host-name')));
  const toggles = await Promise.all(rows.map((r) => box(r, 'summary')));
  const sentences = await Promise.all(rows.map((r) => box(r, '.host-said > span')));
  expect(new Set(names.map((n) => n.x)).size).toBe(1);
  expect(new Set(toggles.map((t) => t.x)).size).toBe(1);
  // a toggle stands under its sentence, never beside it
  for (const [i, t] of toggles.entries()) expect(t.y).toBeGreaterThan(sentences[i].y);
  expect(await panel.getByTestId('host-step-linger').locator('.host-name').evaluate((e) => getComputedStyle(e).fontFamily)).not.toMatch(/mono/i);
  const [a, b] = await Promise.all([box('host-step-linger', '.btn'), box('host-step-claude', '.btn')]);
  expect(a.right).toBe(b.right);
});

test('a mirror row shows its key, how it stands, a labelled box and details; ticking calls machines.consent with item and fields and the rows come back in place', async ({ page, svall }) => {
  // svalld behind the page, but for machines.consent, which answers as studio took the keys
  const asked: unknown[] = [];
  await page.routeWebSocket((url) => url.port === String(svall.port), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; method?: string; params?: unknown };
      if (m.method !== 'machines.consent') { server.send(raw); return; }
      asked.push(m.params);
      ws.send(JSON.stringify({ id: m.id, result: { rows: [
        { key: 'claude:mcp:linear', status: 'ok', detail: 'copied', tick: tick('claude:mcp:linear', 'env.LINEAR_API_KEY', true) },
        { key: 'var:X', status: 'ok', detail: 'set' },
      ] } }));
    });
  });
  const panel = await checking(page, svall);
  await doctor(page, [...PASSED, unticked('linear', 'claude', 'env.LINEAR_API_KEY'), { step: 'mirror:var:X', status: 'ok', detail: 'set' }]);
  await panel.getByTestId('host-setup-fold').click();

  const row = panel.getByTestId('host-step-mirror:claude:mcp:linear');
  await expect(row).toHaveAttribute('data-status', 'warn');
  await expect(row.locator('.host-name')).toHaveText("linear's LINEAR_API_KEY");
  await expect(row.locator('.host-said > span')).toHaveText('not copied');
  await expect(row.locator('label')).toHaveText('copy');
  // what to do is folded away behind details
  const details = panel.getByTestId('host-details-mirror:claude:mcp:linear');
  await expect(details).toHaveJSProperty('open', false);
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);
  await expect(details).toHaveText('detailsSet LINEAR_API_KEY on studio instead:svall worker env LINEAR_API_KEY');
  // the command whole on a line of its own
  const command = panel.getByTestId('host-command-mirror:claude:mcp:linear');
  expect(await command.evaluate((e) => [getComputedStyle(e).whiteSpace, getComputedStyle(e).display])).toEqual(['pre', 'block']);

  await panel.getByTestId('host-tick-mirror:claude:mcp:linear').click();
  await expect.poll(() => asked).toEqual([{ machine: MACHINE, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true }]);
  await expect(row).toHaveAttribute('data-status', 'ok');
  await expect(row.locator('.host-said > span')).toHaveText('copied');
  await expect(panel.getByTestId('host-tick-mirror:claude:mcp:linear')).toBeChecked();
  await expect(panel.getByTestId('host-tick-mirror:claude:mcp:linear')).toBeFocused();
  // in place: under Your agent setup, before the variable already there
  await panel.getByTestId('host-setup-there').click();
  expect(await panel.locator('[data-testid^="host-step-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid'))))
    .toEqual(['host-step-mirror:claude:mcp:linear', 'host-step-mirror:var:X']);
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio is readyCheck againDone');
  // nothing ran on the machine for it
  expect((await sent(page)).filter((m) => m.type === 'host.start')).toHaveLength(1);
});

test('a row with a run opens the terminal with its forward', async ({ page, svall }) => {
  const logins: HostStep[] = [
    { step: 'mirror:oauth:claude:mcp:linear', status: 'warn', action: 'Start claude there, then /mcp and log in to linear', run: 'claude', forward: 3334, detail: 'not logged in', gap: { name: 'linear', what: 'not logged in' } },
    {
      step: 'mirror:oauth:claude:mcp:notion', status: 'warn', action: 'Start claude there, then /mcp and log in to notion', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118, detail: 'not logged in',
      gap: { name: 'notion', what: 'not logged in' },
    },
  ];
  const panel = await checking(page, svall);
  await doctor(page, [...PASSED, ...logins]);
  // each login is its own part, as the CLI lists them: one terminal forwards one sign-in's port
  await expect(panel.getByTestId('host-setup-fold')).toHaveText('Your agent setup · 2 not on studio yet');
  await panel.getByTestId('host-setup-fold').click();
  await expect(panel.getByTestId('host-step-mirror:oauth:claude:mcp:linear').locator('.host-name')).toHaveText('linear');

  // mcp-remote's sign-in comes back on the port its args name
  await panel.getByTestId('host-terminal-mirror:oauth:claude:mcp:linear').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('Press Return to run claude on studio.');
  await expect(panel.getByTestId('host-terminal-note')).toContainText('through port 3334 on this Mac');
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio', type: 'claude', forward: 3334 } });
  await receive(page, { type: 'term.exited', id: 'machine:studio' });
  expect((await sent(page)).filter((m) => m.type === 'host.start').at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  await doctor(page, [...PASSED, ...logins]);

  // Claude Code's own sign-in, on the port its run fixes and its row names
  await panel.getByTestId('host-terminal-mirror:oauth:claude:mcp:notion').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('through port 3118 on this Mac');
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1))
    .toMatchObject({ machine: { ssh: 'linus@studio', type: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118 } });
  // a port taken here names no Codex login but on Codex's own port
  await receive(page, { type: 'term.failed', id: 'machine:studio', reason: 'ssh quit as soon as it started: Could not request local forwarding.' });
  await expect(panel.getByTestId('host-terminal-failed')).toContainText('Port 3118 on this Mac is taken; close what uses it, then try again.');
  await expect(panel.getByTestId('host-terminal-failed').locator('details')).toHaveText('detailsCould not request local forwarding.');
});

test('a machine is only removed or forgotten once the page has asked', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'studio', id: 'm1', ssh: 'linus@studio', platform: 'linux-x64' }] });
  const starts = async () => (await sent(page)).filter((m) => m.type === 'host.start');
  const row = page.getByTestId('machine-studio');
  const panel = page.getByTestId('host-setup');

  await row.getByTestId('machine-more').click();
  await row.getByTestId('machine-remove').click();
  await expect(page.getByTestId('host-confirm')).toHaveAttribute('data-op', 'remove');
  await expect(page.getByTestId('host-confirm')).toHaveText('Remove uninstalls Svall on studio. Its fleets and files stay there.');
  await expect(page.getByTestId('host-confirm-yes')).toHaveText('Remove studio');
  expect(await starts()).toEqual([]);
  await page.getByTestId('host-confirm-no').click();
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  expect(await starts()).toEqual([]);

  await panel.getByTestId('machine-more').click();
  await panel.getByTestId('machine-remove').click();
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio' } });
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  await expect(page.getByTestId('host-running')).toHaveText('Removing studio…Stop');
  await receive(page, { type: 'host.done', op: 'remove', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is removedDone');
  // a machine that is gone is offered nothing more
  await expect(panel.getByTestId('machine-more')).toHaveCount(0);

  await page.getByTestId('host-close').click();
  await row.getByTestId('machine-more').click();
  await row.getByTestId('machine-forget').click();
  await expect(page.getByTestId('host-confirm')).toHaveAttribute('data-op', 'forget');
  await expect(page.getByTestId('host-confirm')).toHaveText('Forget drops studio from this list. Nothing on it changes.');
  expect(await starts()).toHaveLength(1);
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio', forget: true } });
  await expect(page.getByTestId('host-running')).toHaveText('Forgetting studio…Stop');
  await page.getByTestId('host-cancel').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.cancel' });
});

test('an empty Machines tab says what a machine can do; a machine has Check and a ⋯ menu; Forget is offered for one that is not reachable; Remove waits for its robots', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [] });
  await expect(page.getByTestId('machines-empty')).toHaveText("No other machine yet. A Linux machine can run this fleet's robots while this Mac sleeps, or run the whole fleet.");

  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux-x64' }] });
  const row = page.getByTestId('machine-linus-vault');
  await expect(page.getByTestId('machines-empty')).toHaveCount(0);
  await expect(row.getByTestId('machine-doctor')).toBeVisible();
  await expect(row.getByTestId('machine-upgrade')).toHaveCount(0);
  await row.getByTestId('machine-more').click();
  await expect(row.getByTestId('machine-upgrade')).toHaveText("Upgrade to this Mac's release");
  await expect(row.getByTestId('machine-terminal')).toHaveText('Open terminal');
  await expect(row.getByTestId('machine-remove')).toBeEnabled();
  await expect(row.getByTestId('machine-forget')).toBeVisible();
  await expect(row.getByTestId('machine-upgrade')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row.getByTestId('machine-upgrade')).toHaveCount(0);
  await expect(row.getByTestId('machine-more')).toBeFocused();
  await expect(row).toBeVisible();

  // a robot placed there holds Remove back; one only moving there does too
  const id = await seed(svall, true, (c) => { c.machine = VAULT; });
  await page.reload();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux-x64' }] });
  await row.getByTestId('machine-more').click();
  await expect(row.getByTestId('machine-forget')).toHaveCount(0);
  await expect(row.getByTestId('machine-remove')).toBeDisabled();
  await expect(row.getByTestId('machine-remove')).toHaveAttribute('data-tip', '1 robot is placed there; move it back first');

  await rewrite(svall, (s) => { delete s.robots[id].machine; s.robots[id].moving = { id: 'mv_0123456789', to: VAULT, phase: 'prepare' }; });
  await page.reload();
  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'linus-vault', id: VAULT, ssh: 'linus@vault', platform: 'linux-x64' }] });
  await row.getByTestId('machine-more').click();
  await expect(row.getByTestId('machine-remove')).toHaveAttribute('data-tip', '1 robot is placed there; move it back first');
});
