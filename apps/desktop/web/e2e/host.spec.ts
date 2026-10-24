import { expect, test } from './fixtures.js';
import type { FromShell, ToShell } from '../src/bridge.js';

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };

// what `svall host add --json` prints, one object per line, with a token in the line a failure carries
const ADD_STEPS = [
  { step: 'ssh', status: 'ok', detail: 'linus@studio accepted an interactive login' },
  { step: 'master', status: 'ok', detail: 'connected to linus@studio' },
  { step: 'tmux', status: 'warn', detail: 'tmux 3.4: Shift+Enter needs tmux 3.5 or newer' },
  { step: 'claude', status: 'warn', detail: '1.2.3, not logged in', action: 'ssh linus@studio, then claude auth login', run: 'claude auth login' },
  { step: 'opencode', status: 'warn', detail: 'opencode is not installed on this machine', action: 'ssh linus@studio, then install OpenCode' },
  { step: 'probe', status: 'fail', detail: 'ws://127.0.0.1:47800 refused token=s3cr3t', action: 'ssh linus@studio and run svall doctor' },
] as const;

/** A stand-in for the native shell: it answers the connection and plays a host run back to the page. */
async function fakeShell(page: import('@playwright/test').Page, port: number, token: string): Promise<void> {
  await page.addInitScript(({ port, token }) => {
    const w = window as unknown as Shell & { webkit: unknown };
    w.__sent = [];
    w.webkit = { messageHandlers: { svall: { postMessage: (json: string) => {
      const m = JSON.parse(json) as ToShell;
      w.__sent.push(m);
      if (m.type === 'connection') {
        setTimeout(() => {
          w.__svall.receive(JSON.stringify({ type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: false }));
          w.__svall.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port, token }));
        }, 0);
      }
    } } } };
  }, { port, token });
}

const sent = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Shell).__sent);
const receive = (page: import('@playwright/test').Page, msg: FromShell) =>
  page.evaluate((m) => (window as unknown as Shell).__svall.receive(JSON.stringify(m)), msg);
const handoverOn = (page: import('@playwright/test').Page) =>
  receive(page, { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true });

test('the machines panel waits for the fleet to ask for handover, then reports every step', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  // fleet.json has not asked for handover: the controls are not there, and the CLI is where setup lives
  await expect(page.getByTestId('settings-tab-machines')).toHaveCount(0);

  await handoverOn(page);
  await page.getByTestId('settings-tab-machines').click();
  // the pane reads the registry as it opens
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await page.getByTestId('machine-add').click();
  await expect(page.getByTestId('host-setup')).toBeVisible();
  // before any run, what the machine needs
  await expect(page.getByTestId('host-intro')).toContainText('same path as yours on this Mac');
  // the app carries the x86-64 companion only
  await expect(page.getByTestId('host-intro')).toContainText('Add machine installs Svall on an x86-64 machine');
  await expect(page.getByTestId('host-intro')).toContainText('add an arm64 one with svall host add … --release');

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

  await expect(page.getByTestId('host-phase')).toHaveText(['Reaching the machine', 'What the machine needs', 'Agent logins', 'Trying it out']);
  await expect(page.getByTestId('host-step-tmux')).toHaveAttribute('data-status', 'warn');
  await expect(page.getByTestId('host-action-claude')).toHaveText('ssh linus@studio, then claude auth login');
  await expect(page.getByTestId('host-action-opencode')).toHaveText('ssh linus@studio, then install OpenCode');
  // what the step said is kept, without the token it carried
  await expect(page.getByTestId('host-step-probe')).toContainText('ws://127.0.0.1:47800 refused token=…');
  await expect(page.getByTestId('host-step-probe')).not.toContainText('s3cr3t');
  // steps read as plain words, and the run ends on the step it stopped at, with what is left to do
  await expect(page.getByTestId('host-step-master')).toContainText('Connection');
  await expect(page.getByTestId('host-outcome')).toContainText('Add machine stopped at Final check: ws://127.0.0.1:47800 refused token=…');
  await expect(page.getByTestId('host-outcome')).toContainText('svall doctor');
  await expect(page.getByTestId('host-next-gateway')).toHaveCount(0);

  // a machine not yet in the registry is reached at the destination the add was given, and nothing checks it again
  await page.getByTestId('host-terminal-claude').click();
  expect((await sent(page)).at(-2)).toMatchObject({ type: 'term.show', id: 'machine:studio', machine: { ssh: 'linus@studio', type: 'claude auth login' } });
  await receive(page, { type: 'term.exited', id: 'machine:studio' });
  await expect(page.getByTestId('host-steps')).toBeVisible();
  expect((await sent(page)).filter((m) => m.type === 'host.start')).toHaveLength(1);

  // an add that stopped short is offered again as it was asked, and one that went through offers the gateway it still needs
  await expect(page.getByTestId('host-ssh')).toHaveValue('linus@studio');
  await page.getByTestId('host-add').click();
  await receive(page, { type: 'host.step', op: 'add', event: { step: 'registry', status: 'ok', detail: "studio is in this Mac's list of machines" } });
  await receive(page, { type: 'host.done', op: 'add', code: 0 });
  await expect(page.getByTestId('host-outcome')).toContainText('studio is added');
  await expect(page.getByTestId('host-outcome')).not.toContainText('ready for handover');
  await page.getByTestId('host-next-gateway').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'enable', args: { name: 'studio' } });
});

test('a check says ready and how many warnings, or what blocks; ready for handover waits for the gateway', async ({ page, svall }) => {
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
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  // the shell turns each of the report's checks into a step
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'tmux', status: 'ok', detail: '3.5a' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'release', status: 'ok', detail: '0.5.0, protocol 4' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'skip', detail: 'not installed' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'gh', status: 'warn', detail: 'not logged in' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });
  await expect(page.getByTestId('host-step-release')).toContainText('0.5.0, protocol 4');
  await expect(page.getByTestId('host-outcome')).toContainText("ready to be this fleet's gateway; 1 warning");

  await panel.getByTestId('machine-doctor').click();
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'systemd', status: 'fail', detail: 'svall-svalld@private.service is inactive' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 1 });
  await expect(page.getByTestId('host-outcome')).toContainText('1 check blocks a handover:Fleet service: svall-svalld@private.service is inactive');

  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'ok', detail: 'studio answers on release 0.5.0' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is upgraded');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // an upgrade stopped in install leaves no rollback to offer
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'install', status: 'fail', detail: 'svall setup exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await expect(page.getByTestId('host-outcome')).toContainText('Upgrade stopped at Install');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // one whose own rollback failed too offers the rollback the CLI names
  await panel.getByTestId('machine-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'warn', detail: 'studio did not answer' } });
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'rollback', status: 'fail', detail: 'svall setup --rollback exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await page.getByTestId('host-rollback').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'rollback', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'rollback', code: 0 });

  // the gateway is this window's own fleet, which the shell names; the page sends only the machine
  await expect(panel.getByTestId('machine-enable')).toHaveText('Make gateway');
  await panel.getByTestId('machine-enable').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'enable', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'enable', code: 0 });
  await receive(page, { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true, gateway: 'studio' });
  await expect(panel.getByTestId('machine-enable')).toHaveCount(0);
  await expect(page.getByTestId('host-outcome')).toContainText("studio is this fleet's gateway: ready for handover");
  await page.getByTestId('host-next-handover').click();
  await expect(page.getByTestId('host-setup')).toHaveCount(0);
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
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
  await panel.getByTestId('host-terminal-done').click();
  await expect.poll(async () => (await sent(page)).slice(-2)).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }, { type: 'term.close', id: 'machine:studio' }]);
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });

  // a plain terminal types nothing, and closing the panel closes it
  await panel.getByTestId('machine-terminal').click();
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).toMatchObject({ machine: { ssh: 'linus@studio' } });
  expect((await sent(page)).filter((m) => m.type === 'term.show').at(-1)).not.toHaveProperty('machine.type');
  await expect(panel.getByTestId('host-terminal-note')).toHaveText(/^A terminal on studio\./);
  await page.getByTestId('host-close').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'term.close', id: 'machine:studio' });
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
  await expect(page.getByTestId('host-confirm')).toContainText('uninstalls Svall there');
  expect(await starts()).toEqual([]);
  await page.getByTestId('host-confirm-no').click();
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  expect(await starts()).toEqual([]);

  await panel.getByTestId('machine-remove').click();
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio' } });
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  await receive(page, { type: 'host.done', op: 'remove', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is removed');
  // a machine that is gone is offered nothing more
  await expect(panel.getByTestId('machine-forget')).toHaveCount(0);

  await page.getByTestId('host-close').click();
  await row.getByTestId('machine-forget').click();
  await expect(page.getByTestId('host-confirm')).toHaveAttribute('data-op', 'forget');
  expect(await starts()).toHaveLength(1);
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio', forget: true } });
  await page.getByTestId('host-cancel').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.cancel' });
});

test('the corner names the machine the fleet runs on, and the fleet stays on the screen while it is away', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  const island = await svall.api.call('island.create', { name: svall.uniq('host') });
  const c = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
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
  // the fleet the page already holds is still there, characters and all
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId(`tab-${c.id}`)).toBeVisible();

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
