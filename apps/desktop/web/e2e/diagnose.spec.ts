import type { Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { expect, test } from './fixtures.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import { FAR_ANSWER_MS } from '../src/host.js';
import { theme } from '../src/theme.js';

type State = Extract<FromShell, { type: 'connection.state' }>;
// __state: what the shell says about the connection each time the page asks for it, which a test may move on
type Shell = { __sent: ToShell[]; __state?: State; __svall: { receive(json: string): void } };
type Reply = { port: number; token: string; info: Extract<FromShell, { type: 'shell.info' }>; state?: State };

// a stand-in for the native shell: it records what the page sends and answers the connection request
async function fakeShell(page: Page, reply: Reply): Promise<() => Promise<ToShell[]>> {
  await page.addInitScript((r: Reply) => {
    const w = window as unknown as Shell & { webkit: unknown };
    w.__sent = [];
    w.__state = r.state;
    w.webkit = { messageHandlers: { svall: { postMessage: (json: string) => {
      const m = JSON.parse(json) as ToShell;
      w.__sent.push(m);
      if (m.type !== 'connection') return;
      setTimeout(() => {
        w.__svall.receive(JSON.stringify(r.info));
        w.__svall.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port: r.port, token: r.token }));
        if (w.__state) w.__svall.receive(JSON.stringify(w.__state));
      }, 0);
    } } } };
  }, reply);
  return () => page.evaluate(() => (window as unknown as Shell).__sent);
}

test('the connect screen names the daemon log and shows its last lines', async ({ page }) => {
  const sent = await fakeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z error svalld failed to start: listen EADDRINUSE'], op: false },
  });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toContainText('/tmp/fleet-x/svalld.log');
  await expect(screen.getByTestId('connect-log')).toContainText('EADDRINUSE');
  await screen.getByTestId('connect-log-reveal').click();
  expect((await sent()).filter((m) => m.type === 'reveal')).toEqual([{ type: 'reveal', path: '/tmp/fleet-x/svalld.log' }]);
});

test('the connect screen asks for svall setup while the daemon has never logged', async ({ page }) => {
  await fakeShell(page, { port: 0, token: '', info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  await expect(page.getByTestId('connect-screen')).toContainText('run svall-dev setup');
});

test('a fleet on another machine that cannot be reached says so in place of the advice for this Mac', async ({ page }) => {
  await fakeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z svalld stopped'], op: false, handoverEnabled: true, gateway: 'studio' },
    state: { type: 'connection.state', state: 'error', owner: 'studio', kind: 'unreachable', message: 'ssh: connect to host studio port 22: Operation timed out' },
  });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toContainText('studio is not reachable; trying again.');
  await expect(screen.getByTestId('connection-detail')).toContainText('Operation timed out');
  await expect(screen).not.toContainText('svalld not running');
});

test('a fleet on this Mac whose gateway did not answer says so, and offers the copy here read-only when the shell has one', async ({ page }) => {
  const sent = await fakeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true, gateway: 'studio', copyHere: true },
    state: { type: 'connection.state', state: 'error', owner: 'local', kind: 'unreachable', machine: 'studio', destination: 'linus@studio',
      message: 'the gateway studio did not answer, and it has named no owner here before to go on. The gateway said: ssh could not reach linus@studio' },
  });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(theme.connectGraceMs);
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toContainText('The gateway studio did not answer, so where the fleet runs is not known; trying again.');
  await expect(screen).not.toContainText('svalld not running');
  await expect(screen).not.toContainText('setup');
  await expect(screen.getByTestId('connection-here')).toHaveText("Open this Mac's copy, read-only");
  await screen.getByTestId('connection-here').click();
  expect((await sent()).filter((m) => m.type === 'connection.here')).toEqual([{ type: 'connection.here' }]);
});

test('a fleet on this Mac that asks for handover keeps the advice for its own daemon', async ({ page }) => {
  await fakeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true, gateway: 'studio' },
    state: { type: 'connection.state', state: 'error', owner: 'local', kind: 'daemon_down', message: 'svalld is not running' },
  });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('connect-screen')).toHaveText('Starting the fleet…');
  await page.clock.fastForward(theme.connectGraceMs);
  await expect(page.getByTestId('connect-screen')).toContainText('svalld not running');
  await expect(page.getByTestId('connect-screen')).toContainText('run svall-dev setup');
});

test('a fleet on a machine on another version opens the machines panel on it, and nothing runs until asked', async ({ page }) => {
  const sent = await fakeShell(page, {
    port: 0, token: '',
    info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled: true, gateway: 'studio' },
    state: { type: 'connection.state', state: 'error', owner: 'studio', kind: 'version', message: 'studio answered with protocol 3, not 4' },
  });
  await page.goto('/');
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toContainText('studio is on another version of Svall.');
  await screen.getByTestId('connection-upgrade').click();
  await expect(page.getByTestId('host-name')).toHaveValue('studio');
  const starts = async () => (await sent()).filter((m) => m.type === 'host.start');
  expect(await starts()).toEqual([]);
  await page.getByTestId('host-upgrade').click();
  expect(await starts()).toEqual([{ type: 'host.start', op: 'upgrade', args: { name: 'studio' } }]);

  // the upgrade went through and the shell asked again: the panel stays while the fleet comes back
  for (const state of ['connecting', 'online'] as const) {
    await page.evaluate((m) => { const w = window as unknown as Shell; w.__state = m; w.__svall.receive(JSON.stringify(m)); },
      { type: 'connection.state', state, owner: 'studio' } as State);
    await expect(page.getByTestId('host-name')).toHaveValue('studio');
  }
});

test('a fleet on another machine that is online but not loaded yet is still starting, until a minute says its daemon has not answered', async ({ page }) => {
  // the forward is open, and the daemon behind it has not answered yet
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  try {
    const sent = await fakeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z svalld stopped'], op: false, handoverEnabled: true, gateway: 'studio' },
      state: { type: 'connection.state', state: 'online', owner: 'studio' },
    });
    await page.clock.install();
    await page.goto('/');
    await page.clock.fastForward(theme.connectGraceMs);
    const screen = page.getByTestId('connect-screen');
    await expect(screen).toHaveText('Starting the fleet…');
    await page.clock.fastForward(FAR_ANSWER_MS);
    await expect(screen).toContainText("studio's svalld has not answered.");
    await screen.getByTestId('connection-check').click();
    expect((await sent()).filter((m) => m.type === 'host.start')).toEqual([{ type: 'host.start', op: 'doctor', args: { name: 'studio' } }]);
    await expect(page.getByTestId('host-setup')).toBeVisible();
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});

test('the connect screen says the fleet is starting at first, and shows the log once svalld is slow to answer', async ({ page }) => {
  // a daemon that took the socket and does not answer, as every launch sees for a moment
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  try {
    await fakeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: ['2026-09-14T10:00:00Z error svalld failed to start: listen EADDRINUSE'], op: false },
    });
    await page.clock.install();
    await page.goto('/');
    const screen = page.getByTestId('connect-screen');
    await expect(screen).toHaveText('Starting the fleet…');
    await page.clock.fastForward(theme.connectGraceMs);
    await expect(screen.getByTestId('connect-log')).toContainText('EADDRINUSE');
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});

test('a daemon on another protocol asks for a reinstall', async ({ page }) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => ws.once('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION + 1 } }))));
  await new Promise((r) => wss.once('listening', r));
  try {
    await fakeShell(page, {
      port: (wss.address() as { port: number }).port, token: 't',
      info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false },
    });
    await page.goto('/');
    // a daemon that answered needs no grace to say so: this is well inside the 10 s the connect screen waits
    await expect(page.getByTestId('connect-screen')).toContainText('pnpm desktop:install', { timeout: 1500 });
    await expect(page.getByTestId('connect-screen')).not.toContainText('svall-dev setup');
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
