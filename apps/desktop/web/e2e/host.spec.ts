import { expect, test } from './fixtures.js';
import type { FromShell, ToShell } from '../src/bridge.js';

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };

// what `svall host add --json` prints, one object per line, with a token in the line a failure carries
const ADD_STEPS = [
  { step: 'ssh', status: 'ok', detail: 'linus@studio accepted an interactive login' },
  { step: 'master', status: 'ok', detail: 'connected to linus@studio' },
  { step: 'tmux', status: 'warn', detail: 'tmux 3.4: Shift+Enter needs tmux 3.5 or newer' },
  { step: 'claude', status: 'warn', detail: '1.2.3, not logged in', action: 'ssh linus@studio, then claude auth status and log in' },
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
  await page.getByTestId('settings-hosts').click();
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

  await expect(page.getByTestId('host-phase')).toHaveText(['Connect', 'Prerequisites', 'Agent logins', 'Final probe']);
  await expect(page.getByTestId('host-step-tmux')).toHaveAttribute('data-status', 'warn');
  await expect(page.getByTestId('host-action-claude')).toHaveText('ssh linus@studio, then claude auth status and log in');
  await expect(page.getByTestId('host-action-opencode')).toHaveText('ssh linus@studio, then install OpenCode');
  // what the step said is kept, without the token it carried
  await expect(page.getByTestId('host-step-probe')).toContainText('ws://127.0.0.1:47800 refused token=…');
  await expect(page.getByTestId('host-step-probe')).not.toContainText('s3cr3t');
  // steps read as plain words, and the run ends on the step it stopped at, with what is left to do
  await expect(page.getByTestId('host-step-master')).toContainText('Connection');
  await expect(page.getByTestId('host-outcome')).toContainText('Add machine stopped at Final check: ws://127.0.0.1:47800 refused token=…');
  await expect(page.getByTestId('host-outcome')).toContainText('svall doctor');
  await expect(page.getByTestId('host-next-gateway')).toHaveCount(0);

  // an add that went through is added, and the panel offers the gateway it still needs
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
  await page.getByTestId('settings-hosts').click();
  await page.getByTestId('host-name').fill('studio');

  await page.getByTestId('host-doctor').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'doctor', args: { name: 'studio' } });
  // the shell turns each of the report's checks into a step
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'tmux', status: 'ok', detail: '3.5a' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'release', status: 'ok', detail: '0.5.0, protocol 4' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'codex', status: 'skip', detail: 'not installed' } });
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'gh', status: 'warn', detail: 'not logged in' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 0 });
  await expect(page.getByTestId('host-step-release')).toContainText('0.5.0, protocol 4');
  await expect(page.getByTestId('host-outcome')).toContainText("ready to be this fleet's gateway; 1 warning");

  await page.getByTestId('host-doctor').click();
  await receive(page, { type: 'host.step', op: 'doctor', event: { step: 'systemd', status: 'fail', detail: 'svall-svalld@private.service is inactive' } });
  await receive(page, { type: 'host.done', op: 'doctor', code: 1 });
  await expect(page.getByTestId('host-outcome')).toContainText('1 check blocks a handover:systemd: svall-svalld@private.service is inactive');

  await page.getByTestId('host-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'ok', detail: 'studio answers on release 0.5.0' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is upgraded');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // an upgrade stopped in install leaves no rollback to offer
  await page.getByTestId('host-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'install', status: 'fail', detail: 'svall setup exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await expect(page.getByTestId('host-outcome')).toContainText('Upgrade stopped at Install');
  await expect(page.getByTestId('host-rollback')).toHaveCount(0);

  // one whose own rollback failed too offers the rollback the CLI names
  await page.getByTestId('host-upgrade').click();
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'probe', status: 'warn', detail: 'studio did not answer' } });
  await receive(page, { type: 'host.step', op: 'upgrade', event: { step: 'rollback', status: 'fail', detail: 'svall setup --rollback exited 1' } });
  await receive(page, { type: 'host.done', op: 'upgrade', code: 1 });
  await page.getByTestId('host-rollback').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'rollback', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'rollback', code: 0 });

  // the gateway is this window's own fleet, which the shell names; the page sends only the machine
  await expect(page.getByTestId('host-enable')).toHaveText("Make it this fleet's gateway");
  await page.getByTestId('host-enable').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'enable', args: { name: 'studio' } });
  await receive(page, { type: 'host.done', op: 'enable', code: 0 });
  await receive(page, { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true, gateway: 'studio' });
  await expect(page.getByTestId('host-outcome')).toContainText("studio is this fleet's gateway: ready for handover");
  await page.getByTestId('host-next-handover').click();
  await expect(page.getByTestId('host-setup')).toHaveCount(0);
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
});

test('a machine is only removed or forgotten once the page has asked', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId('settings-open').click();
  await handoverOn(page);
  await page.getByTestId('settings-tab-machines').click();
  await page.getByTestId('settings-hosts').click();
  await page.getByTestId('host-name').fill('studio');
  const starts = async () => (await sent(page)).filter((m) => m.type === 'host.start');

  await page.getByTestId('host-remove').click();
  await expect(page.getByTestId('host-confirm')).toHaveAttribute('data-op', 'remove');
  await expect(page.getByTestId('host-confirm')).toContainText('uninstalls Svall there');
  expect(await starts()).toEqual([]);
  await page.getByTestId('host-confirm-no').click();
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  expect(await starts()).toEqual([]);

  await page.getByTestId('host-remove').click();
  await page.getByTestId('host-confirm-yes').click();
  expect((await sent(page)).at(-1)).toEqual({ type: 'host.start', op: 'remove', args: { name: 'studio' } });
  await expect(page.getByTestId('host-confirm')).toHaveCount(0);
  await receive(page, { type: 'host.done', op: 'remove', code: 0 });
  await expect(page.getByTestId('host-outcome')).toHaveText('studio is removed');

  await page.getByTestId('host-forget').click();
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

  await receive(page, { type: 'connection.state', state: 'error', owner: 'studio', kind: 'unreachable', message: 'ssh closed' });
  await expect(page.getByTestId('connection-banner')).toHaveText('studio is not reachable: ssh closed');
  await expect(page.getByTestId('owner-badge')).toHaveAttribute('data-state', 'error');
  // the fleet the page already holds is still there, characters and all
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId(`tab-${c.id}`)).toBeVisible();

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
  await expect(page.getByTestId('connection-banner')).toContainText('studio is on another version: studio answered with protocol 3, not 4');
  await expect(page.getByTestId('connection-upgrade')).toHaveCount(0);
  await handoverOn(page);
  await page.getByTestId('connection-upgrade').click();
  await expect(page.getByTestId('host-setup')).toBeVisible();
  await expect(page.getByTestId('host-name')).toHaveValue('studio');
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
  await expect(page.getByTestId('connection-banner')).toHaveText('studio is not reachable: ssh closed');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);

  await handoverOn(page);
  await receive(page, localDown);
  await expect(page.getByTestId('connection-banner')).toHaveText('this machine is not reachable: svalld is not running');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);

  await svall.startDaemon();
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await expect(page.getByTestId('offline-banner')).toBeHidden({ timeout: 15_000 });
});
