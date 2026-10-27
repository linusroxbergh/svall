import { expect, nativeShell, receive, sent, test } from './fixtures.js';
import type { HostStep, ToShell } from '../src/bridge.js';

// what `svall host add --json` prints, one object per line, with a token in the line a failure carries
const ADD_STEPS = [
  { step: 'ssh', status: 'ok', detail: 'linus@studio accepted an interactive login' },
  { step: 'master', status: 'ok', detail: 'connected to linus@studio' },
  { step: 'tmux', status: 'warn', detail: 'tmux 3.4: Shift+Enter needs tmux 3.5 or newer' },
  { step: 'claude', status: 'warn', detail: '1.2.3, not logged in', action: 'ssh linus@studio, then claude auth login', run: 'claude auth login' },
  { step: 'opencode', status: 'warn', detail: 'opencode is not installed on this machine', action: 'ssh linus@studio, then install OpenCode' },
  {
    step: 'versions', status: 'warn', detail: 'claude 1.2.3 there, behind 1.2.4 on this Mac: a handover there and back needs the same release on both',
    action: 'ssh linus@studio, then claude update', run: 'claude update',
  },
  { step: 'probe', status: 'fail', detail: 'ws://127.0.0.1:47800 refused token=s3cr3t', action: 'ssh linus@studio and run svall doctor' },
] as const;

const fakeShell = (page: import('@playwright/test').Page, port: number, token: string) =>
  nativeShell(page, { port, token, info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: false } });
const handoverOn = (page: import('@playwright/test').Page) =>
  receive(page, { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true });

test('the machines panel stands without the fleet asking for handover, and reports every step', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('settings-tab-machines').click();
  // the pane reads the registry as it opens
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await page.getByTestId('machine-add').click();
  await expect(page.getByTestId('host-setup')).toBeVisible();
  // before any run, what the machine needs
  await expect(page.getByTestId('host-intro')).toContainText('An account you reach over ssh, with any home');
  // the app carries the x86-64 and arm64 companions
  await expect(page.getByTestId('host-intro')).toContainText('x86-64 or arm64');
  await expect(page.getByTestId('host-intro')).not.toContainText('--release');

  // a name the registry would refuse never reaches the shell
  await page.getByTestId('host-name').fill('Studio');
  await page.getByTestId('host-ssh').fill('linus@studio');
  await expect(page.getByTestId('host-add')).toBeDisabled();
  await page.getByTestId('host-name').fill('studio');
  await page.getByTestId('host-add').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'add', args: { name: 'studio', ssh: 'linus@studio' } });
  await expect(page.getByTestId('host-running')).toBeVisible();
  await expect(page.getByTestId('host-intro')).toHaveCount(0);

  for (const event of ADD_STEPS) await receive(page, { type: 'host.step', op: 'add', event });
  await receive(page, { type: 'host.done', op: 'add', code: 1 });

  await expect(page.getByTestId('host-phase')).toHaveText(['Reaching it', 'Svall there', 'Agents there', 'Trying it out']);
  await expect(page.getByTestId('host-step-tmux')).toHaveAttribute('data-status', 'warn');
  await expect(page.getByTestId('host-action-claude')).toHaveText('ssh linus@studio, then claude auth login');
  await expect(page.getByTestId('host-action-opencode')).toHaveText('ssh linus@studio, then install OpenCode');
  await expect(page.getByTestId('host-step-versions')).toContainText('Agent versions');
  await expect(page.getByTestId('host-action-versions')).toHaveText('ssh linus@studio, then claude update');
  await expect(page.getByTestId('host-terminal-versions')).toBeVisible();
  // what the step said is kept, without the token it carried
  await expect(page.getByTestId('host-step-probe')).toContainText('ws://127.0.0.1:47800 refused token=…');
  await expect(page.getByTestId('host-step-probe')).not.toContainText('s3cr3t');
  // steps read as plain words, and the run ends in one line counting what is left to do
  await expect(page.getByTestId('host-step-master')).toContainText('Connection');
  await expect(page.getByTestId('host-outcome')).toContainText('studio needs 4 things before robots can move there.');
  // a machine not in the registry has nothing to check again
  await expect(page.getByTestId('host-done')).toBeVisible();

  // a machine not yet in the registry is reached at the destination the add was given, and nothing checks it again
  await page.getByTestId('host-terminal-claude').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ id: 'machine:studio', machine: { ssh: 'linus@studio', type: 'claude auth login' } });
  await receive(page, { type: 'term.exited', id: 'machine:studio' });
  await expect(page.getByTestId('host-steps')).toBeVisible();
  expect((await sent(page)).filter((m) => m.type === 'host.start')).toHaveLength(1);

  // an add that stopped short is offered again as it was asked, and one that went through is ready
  await expect(page.getByTestId('host-ssh')).toHaveValue('linus@studio');
  await page.getByTestId('host-add').click();
  await receive(page, { type: 'host.step', op: 'add', event: { step: 'registry', status: 'ok', detail: "studio is in this Mac's list of machines" } });
  await receive(page, { type: 'host.done', op: 'add', code: 0 });
  await expect(page.getByTestId('host-outcome')).toContainText('studio is ready. Robots you move there keep working while this Mac sleeps.');
  await page.getByTestId('host-done').click();
  await expect(page.getByTestId('host-setup')).toHaveCount(0);
});

test('a check says ready, or how many things are left, and Check again runs it once more', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await handoverOn(page);
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'studio', id: 'm1', ssh: 'linus@studio', platform: 'linux-x64', gateway: false, fleets: [] }] });
  await expect(page.getByTestId('machine-studio')).toContainText('not checked yet');
  await page.getByTestId('machine-studio').getByTestId('machine-doctor').click();
  const panel = page.getByTestId('host-setup');
  await expect(panel.getByTestId('host-machine')).toHaveText('studio');
  expect((await sent(page)).filter((m) => m.type === 'host.start').at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  // the shell turns each of the report's checks into a step
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'tmux', status: 'ok', detail: '3.5a' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'release', status: 'ok', detail: '0.5.0, protocol 4' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'skip', detail: 'not installed' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'gh', status: 'warn', detail: 'not logged in' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });
  await expect(page.getByTestId('host-step-release')).toContainText('0.5.0, protocol 4');
  await expect(page.getByTestId('host-outcome')).toContainText('studio is ready. Robots you move there keep working while this Mac sleeps.');
  await expect(panel.getByTestId('machine-enable')).toHaveCount(0);

  await panel.getByTestId('machine-doctor').click();
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'systemd', status: 'fail', detail: 'svall-svalld@private.service is inactive' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 1 });
  await expect(page.getByTestId('host-outcome')).toContainText('studio needs 1 thing before robots can move there.');
  await page.getByTestId('host-check-again').click();
  expect((await sent(page)).filter((m) => m.type === 'host.start').at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'ok', detail: 'studio answers on release 0.5.0' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is ready. Robots you move there keep working while this Mac sleeps.Done');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // an upgrade stopped in install leaves no rollback to offer
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'install', status: 'fail', detail: 'svall setup exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await expect(page.getByTestId('host-outcome')).toContainText('studio needs 1 thing before robots can move there.');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // one whose own rollback failed too offers the rollback the CLI names
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'warn', detail: 'studio did not answer' } });
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'rollback', status: 'fail', detail: 'svall setup --rollback exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await page.getByTestId('host-rollback').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'rollback', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'rollback', code: 0 });
  await expect(page.getByTestId('host-outcome')).toContainText('studio is rolled back');
});

test('a fix the machine leaves to the user opens a terminal there with its command typed, and the machine is checked again once it closes', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await handoverOn(page);
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'studio', id: 'm1', ssh: 'linus@studio', platform: 'linux-x64', gateway: false, fleets: [] }] });
  await page.getByTestId('machine-studio').getByTestId('machine-doctor').click();
  const panel = page.getByTestId('host-setup');
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'claude', status: 'warn', detail: '2.1.300, not signed in: claude auth login', run: 'claude auth login' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'warn', detail: 'codex-cli 0.156.1, not signed in: codex login', run: 'codex login' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'tmux', status: 'ok', detail: '3.5a' } });
  // nothing is offered while the check still runs
  await expect(panel.getByTestId('host-terminal-claude')).toHaveCount(0);
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });
  await expect(panel.getByTestId('host-terminal-tmux')).toHaveCount(0);

  await panel.getByTestId('host-terminal-claude').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('On studio, claude auth login is typed for you: press Return to run it.');
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
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'warn', detail: 'codex-cli 0.156.1, not signed in: codex login', run: 'codex login' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  // Codex's login waits for the browser on port 1455 there, which a forward from this Mac reaches
  await panel.getByTestId('host-terminal-codex').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('through port 1455 on this Mac');
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio', type: 'codex login', forward: 1455 } });
  // an ssh that quits at once says why, and can be opened again
  await receive(page, { type: 'term.failed', id: 'machine:studio', reason: 'ssh quit as soon as it started: Could not request local forwarding.' });
  await expect(panel.getByTestId('host-terminal-failed')).toContainText('Could not request local forwarding. Port 1455 on this Mac is taken');
  await panel.getByTestId('host-terminal-again').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show')).toHaveLength(3);
  // Done goes back to the checks, which look again, and the panel stays
  await panel.getByTestId('host-terminal-done').click();
  await expect.poll(async () => (await sent(page)).slice(-2)).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }, { type: 'term.close', id: 'machine:studio' }]);
  await expect(panel.getByTestId('host-terminal')).toHaveCount(0);
  await expect(panel.getByTestId('host-running')).toBeVisible();
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  // a plain terminal types nothing, and closing the panel closes it and checks the machine again
  await panel.getByTestId('machine-terminal').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio' } });
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).not.toHaveProperty('machine.type');
  await expect(panel.getByTestId('host-terminal-note')).toHaveText(/^A terminal on studio\./);
  await page.getByTestId('host-close').click();
  await expect.poll(async () => (await sent(page)).filter((m) => m.type === 'host.start' || m.type === 'term.close').slice(-2))
    .toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }, { type: 'term.close', id: 'machine:studio' }]);
});

const MACHINE = '5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const STUDIO = { name: 'studio', id: MACHINE, ssh: 'linus@studio', platform: 'linux-x64', gateway: false, fleets: [] };
const tick = (item: string, field: string, on: boolean) => ({ item, fields: [field], on, preview: [`${field} lin…90`] });
const unticked = (server: string, agent: string, field: string): HostStep => ({
  step: `mirror:${agent}:mcp:${server}`, status: 'warn', action: `copy ${server}'s keys to studio`, tick: tick(`${agent}:mcp:${server}`, field, false),
  detail: `mirrored without ${field} lin…90; or set them in ~/.svall/mirror-overrides on studio`,
});
// what a check of studio says before its report: every step there passed
const PASSED: HostStep[] = [
  { step: 'ssh', status: 'ok', detail: 'linus@studio accepted an interactive login' },
  { step: 'release', status: 'ok', detail: '0.5.0, protocol 33' },
  { step: 'claude', status: 'ok', detail: '2.1.310 (Claude Code), logged in' },
  { step: 'probe', status: 'ok', detail: 'studio answers' },
];

/** The Machines pane, with studio in the registry and its check under way. */
async function checking(page: import('@playwright/test').Page, svall: { port: number; token: string; open: () => Promise<void> }) {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await handoverOn(page);
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [STUDIO] });
  await page.getByTestId('machine-studio').getByTestId('machine-doctor').click();
  return page.getByTestId('host-setup');
}

const doctor = async (page: import('@playwright/test').Page, events: HostStep[], code = 0) => {
  for (const event of events) await receive(page, { type: 'host.step', op: 'doctor', event });
  await receive(page, { type: 'host.done', op: 'doctor', code });
};

test('the setup page ends in one of three lines: ready, needs N things (a warn with an action counts), or an operation stopped at a step (remove)', async ({ page, svall }) => {
  const panel = await checking(page, svall);
  await doctor(page, [...PASSED, unticked('linear', 'claude', 'env.LINEAR_API_KEY'), unticked('github', 'codex', 'env.GITHUB_TOKEN')]);
  await expect(panel.getByTestId('host-phase')).toHaveText(['Reaching it', 'Svall there', 'Agents there', 'Your agent setup', 'Trying it out']);
  // two servers whose keys are not copied are two things, each with its own sentence and tick
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio needs 2 things before robots can move there.Check again');
  await expect(panel.getByTestId('host-action-mirror:claude:mcp:linear')).toHaveText("copy linear's keys to studio");
  await expect(panel.getByTestId('host-action-mirror:codex:mcp:github')).toHaveText("copy github's keys to studio");
  for (const step of ['mirror:claude:mcp:linear', 'mirror:codex:mcp:github']) await expect(panel.getByTestId(`host-tick-${step}`)).not.toBeChecked();

  // a report long enough to scroll keeps the title and the outcome in sight
  await panel.getByTestId('host-check-again').click();
  const vars = Array.from({ length: 40 }, (_, i): HostStep => ({ step: `mirror:var:VAR_${i}`, status: 'ok', detail: `VAR_${i} is set on studio` }));
  await doctor(page, [...PASSED, ...vars]);
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio is ready. Robots you move there keep working while this Mac sleeps.Done');
  await panel.getByTestId('host-step-mirror:var:VAR_39').scrollIntoViewIfNeeded();
  await expect(panel.getByTestId('host-step-mirror:var:VAR_39')).toBeInViewport();
  await expect(panel.getByTestId('host-machine')).toBeInViewport();
  await expect(panel.getByTestId('host-outcome')).toBeInViewport();
  await expect(panel.getByTestId('host-step-ssh')).not.toBeInViewport();

  await panel.getByTestId('machine-remove').click();
  await page.getByTestId('host-confirm-yes').click();
  await receive(page, { type: 'host.step', op: 'remove', event: { step: 'uninstall', status: 'fail', detail: 'svall uninstall exited 1' } });
  await receive(page, { type: 'host.done', op: 'remove', code: 1 });
  await expect(panel.getByTestId('host-outcome')).toHaveText('Remove stopped at Uninstall: svall uninstall exited 1Check again');
});

test('a mirror row shows one sentence, a checkbox and details; ticking calls machines.consent with item and fields and the rows come back in place', async ({ page, svall }) => {
  // svalld behind the page, but for machines.consent, which answers as studio took the keys
  const asked: unknown[] = [];
  await page.routeWebSocket((url) => url.port === String(svall.port), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; method?: string; params?: unknown };
      if (m.method !== 'machines.consent') { server.send(raw); return; }
      asked.push(m.params);
      ws.send(JSON.stringify({ id: m.id, result: { rows: [
        { key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to studio: env.LINEAR_API_KEY lin…90', tick: tick('claude:mcp:linear', 'env.LINEAR_API_KEY', true) },
        { key: 'var:X', status: 'ok', detail: 'X is set on studio' },
      ] } }));
    });
  });
  const panel = await checking(page, svall);
  await doctor(page, [...PASSED, unticked('linear', 'claude', 'env.LINEAR_API_KEY'), { step: 'mirror:var:X', status: 'ok', detail: 'X is set on studio' }]);

  const row = panel.getByTestId('host-step-mirror:claude:mcp:linear');
  await expect(row).toHaveAttribute('data-status', 'warn');
  await expect(row.locator('.host-name')).toHaveText('Claude MCP linear');
  await expect(panel.getByTestId('host-action-mirror:claude:mcp:linear')).toHaveText("copy linear's keys to studio");
  // the recipe is folded away behind details
  const details = panel.getByTestId('host-details-mirror:claude:mcp:linear');
  await expect(details).toHaveJSProperty('open', false);
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);
  await expect(details).toHaveText('detailsmirrored without env.LINEAR_API_KEY lin…90; or set them in ~/.svall/mirror-overrides on studio');
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio needs 1 thing before robots can move there.Check again');

  await panel.getByTestId('host-tick-mirror:claude:mcp:linear').click();
  await expect.poll(() => asked).toEqual([{ machine: MACHINE, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true }]);
  await expect(row).toHaveAttribute('data-status', 'ok');
  await expect(row).toContainText('keys copied to studio: env.LINEAR_API_KEY lin…90');
  await expect(panel.getByTestId('host-tick-mirror:claude:mcp:linear')).toBeChecked();
  // in place: under Your agent setup, before the variable, and the steps around it untouched
  expect(await panel.locator('[data-testid^="host-step-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid'))))
    .toEqual(['host-step-ssh', 'host-step-release', 'host-step-claude', 'host-step-mirror:claude:mcp:linear', 'host-step-mirror:var:X', 'host-step-probe']);
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio is ready. Robots you move there keep working while this Mac sleeps.Done');
  // nothing ran on the machine for it
  expect((await sent(page)).filter((m) => m.type === 'host.start')).toHaveLength(1);
});

test('a row with a run opens the terminal with its forward', async ({ page, svall }) => {
  const logins: HostStep[] = [
    { step: 'mirror:oauth:claude:mcp:linear', status: 'warn', action: 'log in once on studio', run: 'claude', forward: 3334, detail: 'then /mcp and sign in to linear' },
    { step: 'mirror:oauth:claude:mcp:notion', status: 'warn', action: 'log in once on studio', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', detail: 'then /mcp and sign in to notion' },
  ];
  const panel = await checking(page, svall);
  await doctor(page, [...PASSED, ...logins]);
  // one claude logs in to both, as the CLI counts it
  await expect(panel.getByTestId('host-outcome')).toHaveText('studio needs 1 thing before robots can move there.Check again');
  await expect(panel.getByTestId('host-step-mirror:oauth:claude:mcp:linear').locator('.host-name')).toHaveText('linear login');

  // mcp-remote's sign-in comes back on the port its args name
  await panel.getByTestId('host-terminal-mirror:oauth:claude:mcp:linear').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('On studio, claude is typed for you');
  await expect(panel.getByTestId('host-terminal-note')).toContainText('through port 3334 on this Mac');
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio', type: 'claude', forward: 3334 } });
  await receive(page, { type: 'term.exited', id: 'machine:studio' });
  expect((await sent(page)).filter((m) => m.type === 'host.start').at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  await doctor(page, [...PASSED, ...logins]);

  // Claude Code's own sign-in, on the port its run fixes
  await panel.getByTestId('host-terminal-mirror:oauth:claude:mcp:notion').click();
  await expect(panel.getByTestId('host-terminal-note')).toContainText('through port 3118 on this Mac');
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1))
    .toMatchObject({ machine: { ssh: 'linus@studio', type: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118 } });
});

test('a machine is only removed or forgotten once the page has asked', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await handoverOn(page);
  await page.getByTestId('settings-tab-machines').click();
  await receive(page, { type: 'host.machines', machines: [{ name: 'studio', id: 'm1', ssh: 'linus@studio', platform: 'linux-x64', gateway: false, fleets: [] }] });
  const starts = async () => (await sent(page)).filter((m) => m.type === 'host.start');
  const row = page.getByTestId('machine-studio');
  const panel = page.getByTestId('host-setup');

  await row.getByTestId('machine-remove').click();
  await expect(page.getByTestId('host-confirm')).toHaveAttribute('data-op', 'remove');
  await expect(page.getByTestId('host-confirm')).toContainText('uninstalls Svall on studio');
  expect(await starts()).toEqual([]);
  await page.getByTestId('host-confirm-no').click();
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  expect(await starts()).toEqual([]);

  await panel.getByTestId('machine-remove').click();
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio' } });
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  await receive(page, { type: 'host.done', op: 'remove', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is removedDone');
  // a machine that is gone is offered nothing more
  await expect(panel.getByTestId('machine-forget')).toHaveCount(0);

  await page.getByTestId('host-close').click();
  await row.getByTestId('machine-forget').click();
  await expect(page.getByTestId('host-confirm')).toHaveAttribute('data-op', 'forget');
  await expect(page.getByTestId('host-confirm')).toContainText('Svall stays installed there');
  expect(await starts()).toHaveLength(1);
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio', forget: true } });
  await page.getByTestId('host-cancel').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.cancel' });
});

test('the corner names the machine the fleet runs on, and the fleet stays on the screen while it is away', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  const island = await svall.api.call('island.create', { name: svall.uniq('host') });
  const c = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  await svall.open();
  await expect(page.getByTestId('board')).toBeVisible();

  // a fleet on this Mac wears no badge
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await expect(page.getByTestId('owner-badge')).toHaveCount(0);
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);

  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await expect(page.getByTestId('owner-badge')).toHaveText('studio');

  await receive(page, { type: 'connection.state', state: 'error', owner: 'studio', kind: 'unreachable', message: 'ssh closed', machine: 'studio', destination: 'linus@studio' });
  // one plain sentence, what the helper said folded away, and a fresh helper on asking
  await expect(page.getByTestId('connection-banner')).toContainText('studio is not reachable; trying again.');
  await expect(page.getByTestId('connection-detail')).toContainText('ssh closed');
  await expect(page.getByTestId('connection-detail')).not.toHaveAttribute('open');
  await page.getByTestId('connection-reconnect').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'connection.retry' });
  await expect(page.getByTestId('owner-badge')).toHaveAttribute('data-state', 'error');
  // the fleet the page already holds is still there, robots and all
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId(`kc-${c.id}`)).toBeVisible();

  // a login ssh was refused names the one ssh to run in Terminal
  await receive(page, { type: 'connection.state', state: 'error', owner: 'studio', kind: 'auth', message: 'Permission denied (publickey)', machine: 'studio', destination: 'linus@studio' });
  await expect(page.getByTestId('connection-banner')).toContainText('studio did not let ssh log in. Run ssh linus@studio once in Terminal, then Reconnect.');
  await expect(page.getByTestId('connection-reconnect')).toBeVisible();

  await receive(page, { type: 'connection.state', state: 'connecting', owner: 'studio' });
  await expect(page.getByTestId('connection-banner')).toHaveText('connecting to studio…');
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);

  // a path on that machine is not this Mac's to open, and the shell says so
  await receive(page, { type: 'notice', text: '/w/isle is on studio; open it there' });
  await expect(page.getByTestId('toast')).toHaveText('/w/isle is on studio; open it there');
});

test('a machine on another version opens the machines panel on it from the banner, and nothing runs until asked', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  const version = { type: 'connection.state', state: 'error', owner: 'studio', kind: 'version', message: 'studio answered with protocol 3, not 4' } as const;
  // the machines panel waits for the fleet to ask for handover, and so does the way to it
  await receive(page, version);
  await expect(page.getByTestId('connection-banner')).toContainText('studio is on another version of Svall.');
  await expect(page.getByTestId('connection-detail')).toContainText('studio answered with protocol 3, not 4');
  await expect(page.getByTestId('connection-upgrade')).toHaveCount(0);
  await handoverOn(page);
  await page.getByTestId('connection-upgrade').click();
  await expect(page.getByTestId('host-setup')).toBeVisible();
  await expect(page.getByTestId('host-machine')).toHaveText('studio');
  await expect(page.getByTestId('host-name')).toHaveCount(0);
  expect((await sent(page)).filter((m) => m.type === 'host.start')).toEqual([]);
});

test('a fleet on this Mac keeps its one offline banner until it asks for handover', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  const localDown = { type: 'connection.state', state: 'error', owner: 'local', kind: 'daemon_down', message: 'svalld is not running' } as const;

  await receive(page, localDown);
  await svall.stopDaemon();
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);

  // a fleet on another machine names it, in place of the offline banner rather than beside it
  await receive(page, { type: 'connection.state', state: 'error', owner: 'studio', kind: 'unreachable', message: 'ssh closed' });
  await expect(page.getByTestId('connection-banner')).toContainText('studio is not reachable; trying again.');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);

  await handoverOn(page);
  await receive(page, localDown);
  await expect(page.getByTestId('connection-banner')).toContainText('svalld is not running on this Mac; trying again.');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);

  await svall.startDaemon();
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 15_000 });
});
