import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { HandoverPhase } from '@svall/protocol';
import { expect, nativeShell, receive, sent, test, type Svall } from './fixtures.js';
import type { ToShell } from '../src/bridge.js';
import type { HandoverEvent } from '../src/handover.js';

/** A stand-in for the native shell that names the gateway. */
const fakeShell = (page: Page, port: number, token: string, handoverEnabled = true, gateway: string | null = 'studio', profile?: string) =>
  nativeShell(page, { port, token, info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled, ...(gateway && { gateway }), ...(profile && { profile }) } });
// the dock has no Handover entry; a banner's click is the way to the sheet
const openSheet = (page: Page) => receive(page, { type: 'notify.open', key: 'handover' });
const say = async (page: Page, ...events: HandoverEvent[]) => { for (const event of events) await receive(page, { type: 'handover.event', event }); };
const changed = (...phases: HandoverPhase[]): HandoverEvent[] => phases.map((phase) => ({ event: 'handover.changed', data: { transactionId: 'tx1', phase } }));
const robot = (id: string, phase: HandoverPhase, more: { done?: number; total?: number; error?: string; notice?: string } = {}): HandoverEvent =>
  ({ event: 'handover.entity', data: { transactionId: 'tx1', kind: 'robot', id, phase, ...more } });
const summary = { digest: 'a'.repeat(64), roots: 1, files: 120, bytes: 40_000_000, sessions: 1 };
const lastOf = async (page: Page, type: ToShell['type']) => (await sent(page)).filter((m) => m.type === type).at(-1);
// what the shell reads back at launch when no helper is live: the events file, then the status
const readBack = async (page: Page, ...events: HandoverEvent[]) => {
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'handover.attach')).toBe(true);
  await receive(page, { type: 'handover.replay', events });
};
// what the controller's status reasons look like, and what of them the sheet never shows
const [TX, MAC, STUDIO] = ['2f6c1e9a-41b7-4c1e-9d2a-6b0e3c5d7f11', '7d3e0b52-9c4a-4f18-a6b2-0e5d8c1f3a90', 'c41a9e07-5b3d-4e62-8f1c-2a7d9b0e6f45'];
const RAW = new RegExp(`${TX}|${MAC}|${STUDIO}|generation|activation`);
const nothingOpen = (page: Page) => readBack(page, { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } });

/** A dormant robot whose resume a handover could not bring up, as the destination records it: the daemon restarts on that state. */
async function failedResume(svall: Svall, error: string, more?: (c: Record<string, unknown>) => void): Promise<string> {
  const island = await svall.api.call('island.create', { name: svall.uniq('failed') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  execFileSync('tmux', ['-S', path.join(svall.home, 'tmux.sock'), 'kill-window', '-t', a.tmux!.windowId]);
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[a.id].tmux).toBeUndefined();
  await svall.stopDaemon();
  const file = path.join(svall.home, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.robots[a.id].resumeError = error;
  more?.(state.robots[a.id]);
  fs.writeFileSync(file, JSON.stringify(state));
  await svall.startDaemon();
  return a.id;
}

const FAILED = "ada's terminal resumed codex session 01a0cd02-8ea0-75c1-89b3-89718ecbd91f, but codex exited back to its shell, so it is dormant again with that session; revive it to see";

test('a robot a handover could not resume says why and waits for its Revive, which brings it up', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await page.getByTestId(`sb-robot-${id}`).click();
  await expect(page.getByTestId('resume-error')).toHaveText(FAILED);
  await expect(page.getByTestId('side-card').getByTestId('side-resume-error')).toContainText(FAILED);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveAttribute('title', FAILED);

  await page.getByTestId('revive').click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-robot', id, { timeout: 10_000 });
  await expect(page.getByTestId('side-resume-error')).toHaveCount(0);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveCount(0);
  expect((await svall.api.call('state.get', {})).robots[id].resumeError).toBeUndefined();
});

test('a robot a handover could not resume starts afresh from a summary of its session, which stays where it was', async ({ page, svall }) => {
  const sid = '1fb0d1a7-29a9-4159-a932-5ffd2da8faba';
  const id = await failedResume(svall, FAILED, (c) => {
    c.agent = { kind: 'claude', sessionId: sid, status: 'idle', lastActivityAt: 0 };
    c.revive = { command: `claude --resume ${sid}` };
  });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await page.getByTestId(`sb-robot-${id}`).click();
  await expect(page.getByTestId('resume-error')).toHaveText(FAILED);

  await page.getByTestId('fresh').click();
  await expect(page.getByTestId('fresh-ask')).toContainText(sid);
  await page.getByTestId('fresh-go').click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-robot', id, { timeout: 10_000 });
  await expect(page.getByTestId('toast')).toContainText(`old session ${sid} kept`);
  const c = (await svall.api.call('state.get', {})).robots[id];
  expect(c.resumeError).toBeUndefined();
  expect(c.agent).toBeUndefined();
});

test('the map says why a handover could not resume a dormant robot on its token', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall.port, svall.token);
  await svall.open('map');
  await expect(page.getByTestId(`token-resume-error-${id}`)).toHaveAttribute('title', FAILED);
  await svall.api.call('robot.revive', { id });
  await expect(page.getByTestId(`token-resume-error-${id}`)).toHaveCount(0, { timeout: 10_000 });
});

test('a robot a handover could not resume wakes on open like any dormant one while the fleet does not ask for handover', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall.port, svall.token, false);
  await svall.open();
  await page.getByTestId(`sb-robot-${id}`).click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-robot', id, { timeout: 10_000 });
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveCount(0);
});

test('a fleet that does not ask for handover never looks one up', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token, false);
  await svall.open();
  await expect(page.getByTestId('load-tab')).toBeVisible();
  expect((await sent(page)).some((m) => m.type === 'handover.attach')).toBe(false);
});

test("the dock shows the machine's name whole beside the utilities of a fleet on another machine, and no Handover entry", async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  const owner = page.getByTestId('owner-badge');
  await expect(owner).toBeVisible();
  expect(await owner.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await expect(page.getByTestId('load-tab')).toBeVisible();
  await expect(page.getByTestId('handover-tab')).toHaveCount(0);
});

test('with no gateway the sheet offers to add a machine, which opens the panel in its place', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token, true, null);
  await svall.open();
  await nothingOpen(page);
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await openSheet(page);
  await expect(page.getByTestId('handover-to-gateway')).toHaveCount(0);
  await expect(page.getByTestId('handover-to-local')).toHaveCount(0);
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'host.list')).toBe(true);
  await receive(page, { type: 'host.machines', machines: [] });
  await page.getByTestId('handover-add-machine').click();
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);
  await expect(page.getByTestId('host-name')).toBeVisible();
});

test('the sheet carries a move to the gateway through all six sections, then the page reaches the fleet where it landed', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('move') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  const b = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'bo' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);

  // the layout this Mac keeps for itself: bo, split with its files
  await page.getByTestId(`tab-${b.id}`).click();
  await page.getByTestId('pane-split').click();
  await expect(page.getByTestId('pane-right')).toBeVisible();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'term.show' && m.id === b.id)).toBe(true);

  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await openSheet(page);
  // before anything starts, what a handover moves, with a gateway to move to
  await expect(page.getByTestId('handover-intro')).toContainText('nothing moves until you choose Move again');
  await expect(page.getByTestId('handover-no-gateway')).toHaveCount(0);
  await expect(page.getByTestId('handover-to-local')).toHaveCount(0);
  await page.getByTestId('handover-to-gateway').click();
  // the checks run alone first, and the sheet shows what moves and who stops before anything is rested
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'studio', check: true });
  const checks: HandoverEvent = { event: 'handover.preflight', data: { summary, blockers: [], warnings: [
    { code: 'config_difference', message: 'claude 2.0.1 runs on mac and 2.0.3 on studio' },
    { code: 'codex_trust', message: 'Codex asks whether to trust its folder the first time bo resumes on studio', entity: { kind: 'robot', id: b.id } },
  ], names: { robots: { [a.id]: 'ada', [b.id]: 'bo' }, roots: { r_0a1b: '/home/ada/app' }, sessions: { s0: 'bo' } } } };
  await say(page, checks, { event: 'handover.result', data: { status: 'ready' } });
  await receive(page, { type: 'handover.exit', code: 0 });
  await expect(page.getByTestId('handover-summary')).toContainText('1 folder, 120 files, 40.0 MB, 1 session');
  await expect(page.getByTestId('handover-rest-shell')).toContainText('close; each reopens in its folder on studio');
  await expect(page.getByTestId('handover-rest-shell')).toContainText('ada');
  await expect(page.getByTestId('handover-section-rest')).toHaveAttribute('data-state', 'pending');
  expect((await sent(page)).some((m) => m.type === 'term.close')).toBe(false);
  await page.getByTestId('handover-try-again').click();
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'studio' });

  await say(page, checks);
  await expect(page.getByTestId('handover-summary')).toContainText('1 folder, 120 files, 40.0 MB, 1 session');
  await expect(page.getByTestId('handover-intro')).toHaveCount(0);
  await expect(page.getByTestId('handover-warning-config_difference')).toBeVisible();
  await expect(page.getByTestId('handover-warning-config_difference')).toContainText('agent CLI versions differ');
  await expect(page.getByTestId('handover-warning-config_difference')).not.toContainText(/MCP|skill/i);
  await expect(page.getByTestId('handover-warning-codex_trust')).toBeVisible();
  await expect(page.getByTestId('handover-warning-codex_trust')).toContainText('trust each moved folder');

  await say(page, ...changed('begin', 'freeze'), robot(a.id, 'freeze'), robot(b.id, 'freeze'));
  await expect(page.getByTestId(`handover-row-rest-${a.id}`)).toContainText('ada');
  await expect(page.getByTestId(`handover-row-rest-${a.id}`)).toContainText('resting…');
  // the source rests every terminal: the surfaces on them go, and none comes back while the fleet moves
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'term.close' && m.id === b.id)).toBe(true);
  await page.getByTestId('handover-close').click();
  // a rested terminal says the step the handover is at, and opens the sheet
  await expect(page.getByTestId('terminal-held').first()).toHaveText('Resting for the handover: Resting robots…');
  await page.getByTestId('terminal-held').first().click();
  await expect(page.getByTestId('handover-sheet')).toBeVisible();

  await say(page, robot(a.id, 'freeze', { done: 1, total: 1 }), robot(b.id, 'freeze', { done: 1, total: 1 }), ...changed('transfer'),
    { event: 'handover.entity', data: { transactionId: 'tx1', kind: 'root', id: 'r_0a1b', phase: 'transfer', bytes: 12_000_000, totalBytes: 40_000_000 } },
    { event: 'handover.entity', data: { transactionId: 'tx1', kind: 'session', id: 's0', phase: 'transfer', bytes: 400, totalBytes: 1000 } });
  await expect(page.getByTestId('handover-row-transfer-r_0a1b')).toContainText('12.0 MB of 40.0 MB');
  // each row is named by what preflight said it is: where a root lands, as the user would say it, whose a session is
  await expect(page.getByTestId('handover-row-transfer-r_0a1b')).toContainText('/home/ada/app');
  await expect(page.getByTestId('handover-row-transfer-r_0a1b').locator('.ho-who')).toHaveAttribute('title', '/home/ada/app');
  await expect(page.getByTestId('handover-row-transfer-s0')).toContainText("bo's session");
  await expect(page.getByTestId('handover-section-rest')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('handover-section-transfer')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('handover-abort')).toBeVisible();

  await say(page, ...changed('verify', 'prepare', 'ready'));
  await expect(page.getByTestId('handover-section-verify')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('handover-abort')).toBeVisible();
  await say(page, ...changed('commit'));
  await expect(page.getByTestId('handover-section-commit')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('handover-abort')).toHaveCount(0);
  await expect(page.getByTestId('handover-no-way-back')).toBeVisible();

  const trust = 'codex waits at its "Trust this folder?" prompt in ada\'s terminal; answer it there';
  await say(page, ...changed('activate'), robot(a.id, 'activate', { notice: trust }), robot(b.id, 'activate', { error: 'bo did not start: claude exited 1' }), ...changed('complete'),
    { event: 'handover.result', data: { status: 'complete', transactionId: 'tx1', generation: 2, robots: [{ id: a.id, ok: true, notice: trust }, { id: b.id, ok: false, error: 'bo did not start: claude exited 1' }] } });
  await receive(page, { type: 'handover.exit', code: 0 });
  // the move succeeded, whatever one robot did
  await expect(page.getByTestId('handover-headline')).toHaveText('The fleet runs on studio now. 1 robot did not resume.');
  await expect(page.getByTestId(`handover-row-resume-${b.id}`)).toContainText('claude exited 1');
  await expect(page.getByTestId(`handover-row-resume-${a.id}`)).toContainText(`resumed; ${trust}`);
  await expect(page.getByTestId(`handover-row-resume-${a.id}`)).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('handover-sheet')).not.toContainText(/abort|roll ?back|undo|revert/i);

  // the shell's connect helper finds the new owner and hands the page its forward
  const before = (await sent(page)).length;
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await receive(page, { type: 'connection', host: 'localhost', port: svall.port, token: svall.token });
  await expect(page.getByTestId('owner-badge')).toHaveText('studio');
  await page.getByTestId('handover-close').click();
  await expect.poll(async () => (await sent(page)).slice(before).some((m) => m.type === 'term.show' && m.id === b.id), { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId(`tab-${b.id}`)).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('pane-right')).toBeVisible();
  await expect(page.getByTestId('terminal-held')).toHaveCount(0);

  // a robot that stayed dormant is retried where the fleet now runs
  const state = await svall.api.call('state.get', {});
  execFileSync('tmux', ['-S', path.join(svall.home, 'tmux.sock'), 'kill-window', '-t', state.robots[b.id].tmux!.windowId]);
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[b.id].tmux, { timeout: 10_000 }).toBeUndefined();
  await openSheet(page);
  await page.getByTestId(`handover-retry-${b.id}`).click();
  await expect(page.getByTestId(`handover-row-resume-${b.id}`)).toContainText('resumed', { timeout: 10_000 });
});

test('a pull the page already reconnected for still gives the terminals back once the move completes', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('home') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await openSheet(page);
  await page.getByTestId('handover-to-local').click();
  await say(page, ...changed('begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate'), robot(a.id, 'activate'), ...changed('complete'),
    { event: 'handover.result', data: { status: 'complete', transactionId: 'tx1', generation: 2, robots: [{ id: a.id, ok: true }] } });
  await receive(page, { type: 'handover.exit', code: 0 });
  await page.getByTestId('handover-close').click();
  await expect(page.getByTestId('terminal-held')).toBeVisible();
  // the connect helper's own tick found this Mac first, so the new one names the daemon the page already reaches
  const before = (await sent(page)).length;
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await receive(page, { type: 'connection', host: '127.0.0.1', port: svall.port, token: svall.token });
  await expect(page.getByTestId('terminal-held')).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await sent(page)).slice(before).some((m) => m.type === 'term.show' && m.id === a.id), { timeout: 10_000 }).toBe(true);
});

test('a decision waits for its answer, which goes as one choose, while the sheet closes and opens again', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('decide') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  const b = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'bo' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await openSheet(page);
  await page.getByTestId('handover-to-gateway').click();

  await say(page, ...changed('begin', 'freeze'), robot(a.id, 'freeze'), robot(b.id, 'freeze'));
  // Interrupt and carry while Freeze still waits is a choose, never an abort
  await page.getByTestId('handover-interrupt').click();
  expect(await lastOf(page, 'handover.choose')).toEqual({ type: 'handover.choose', choices: { interruptAfterMs: 0 } });
  expect(await lastOf(page, 'handover.cancel')).toBeUndefined();

  await say(page, { event: 'handover.blocked', data: { transactionId: 'tx1', phase: 'freeze', blockers: [
    { code: 'agent_unsettled', message: "ada's terminal did not come to rest after it was interrupted", entity: { kind: 'robot', id: a.id } },
    { code: 'shell_busy', message: "bo's terminal is running npm test", entity: { kind: 'robot', id: b.id } },
  ] } });
  await expect(page.getByTestId('handover-section-rest')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('handover-blocker-agent_unsettled')).toContainText('ada');
  await expect(page.getByTestId('handover-blocker-agent_unsettled')).toContainText('a hook of your own');
  await expect(page.getByTestId('handover-blocker-shell_busy')).toContainText('npm test');
  // closing leaves the decision waiting, and the banner opens it again
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);
  await openSheet(page);
  await expect(page.getByTestId('handover-section-rest')).toHaveAttribute('data-state', 'waiting');
  await page.mouse.click(5, 5);
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);
  await openSheet(page);
  await expect(page.getByTestId('handover-blocker-shell_busy')).toBeVisible();

  await page.getByTestId('handover-blocker-shell_busy').getByTestId('handover-choice-terminate').click();
  await expect(page.getByTestId('handover-blocker-agent_unsettled').getByTestId('handover-choice-terminate')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('handover-go').click();
  expect(await lastOf(page, 'handover.choose')).toEqual({ type: 'handover.choose', choices: { interruptAfterMs: 0, terminateShells: [a.id, b.id] } });

  await say(page, { event: 'handover.blocked', data: { transactionId: 'tx1', phase: 'freeze', blockers: [
    { code: 'agent_working', message: "ada's terminal is still working", entity: { kind: 'robot', id: a.id } },
  ] } });
  await page.getByTestId('handover-abort').click();
  expect(await lastOf(page, 'handover.cancel')).toEqual({ type: 'handover.cancel' });
});

test('a relaunch rebuilds a stopped handover, with Resume and Abort before the commit, and past it resumes by itself with Retry only after that fails', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  // the events file of the run the app was closed during, then what the journals say now
  await readBack(page, { event: 'handover.preflight', data: { summary, blockers: [], warnings: [] } }, ...changed('begin', 'freeze', 'transfer'),
    { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx1', phase: 'transfer', error: 'ssh to studio closed', safe: ['resume', 'abort'] } },
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: `${TX} is preparing and has not committed; it can go on, or be aborted back to ${MAC}` } });
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
  await expect(page.getByTestId('handover-headline')).toHaveText('Stopped at Transferring files and sessions, before the commit: the fleet has not moved.');
  await expect(page.getByTestId('handover-sheet')).not.toContainText(RAW);
  await expect(page.getByTestId('handover-route')).toHaveText('This Mac→studio');
  await expect(page.getByTestId('handover-footnote').locator('.ho-line')).toHaveText(['Resume goes on from where it stopped.', 'Abort gives the fleet back to This Mac.']);
  await expect(page.getByTestId('handover-section-transfer')).toHaveAttribute('data-state', 'stopped');
  await expect(page.getByTestId('handover-resume')).toHaveText('Resume');
  await expect(page.getByTestId('handover-abort')).toBeVisible();
  await page.getByTestId('handover-abort').click();
  expect(await lastOf(page, 'handover.abort')).toEqual({ type: 'handover.abort' });
  expect(await lastOf(page, 'handover.cancel')).toBeUndefined();

  // past the commit the page reaches the fleet where it went
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await receive(page, { type: 'handover.replay', events: [
    { event: 'handover.status', data: { standing: 'committed', journals: {}, action: 'continue', transactionId: TX, phase: 'activate', safe: ['resume'], reason: `${TX} is committed: the fleet belongs to ${STUDIO} at generation 4, and only its activation can go on` } }] });
  await expect(page.getByTestId('handover-headline')).toHaveText("The fleet is studio's now, so the sheet resumes it there by itself…");
  await expect(page.getByTestId('handover-route').locator('[data-here]')).toHaveText('studio');
  const resumes = async () => (await sent(page)).filter((m) => m.type === 'handover.resume').length;
  await expect.poll(resumes).toBe(1);
  await expect(page.getByTestId('handover-resume')).toHaveCount(0);
  await expect(page.getByTestId('handover-abort')).toHaveCount(0);
  await expect(page.getByTestId('handover-sheet')).not.toContainText(/abort|roll ?back|undo|revert/i);
  await expect(page.getByTestId('handover-sheet')).not.toContainText(RAW);

  await say(page, { event: 'handover.result', data: { status: 'interrupted', transactionId: TX, phase: 'activate', error: 'ssh to studio closed', safe: ['resume'] } });
  await receive(page, { type: 'handover.exit', code: 1 });
  await expect(page.getByTestId('handover-resume')).toHaveText('Retry');
  await expect(page.getByTestId('handover-abort')).toHaveCount(0);
  await page.getByTestId('handover-resume').click();
  expect(await resumes()).toBe(2);
});

test('a handover the checks find already open is looked up, and the sheet offers its Resume and Abort in place of a new start', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await openSheet(page);
  await page.getByTestId('handover-to-gateway').click();
  const open: HandoverEvent = { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
    { code: 'transaction_open', message: `this fleet is already in handover ${TX} (preparing); resume or abort it first` },
  ] } };
  await say(page, open);
  await receive(page, { type: 'handover.exit', code: 1 });
  const attaches = async () => (await sent(page)).filter((m) => m.type === 'handover.attach').length;
  await expect.poll(attaches).toBe(2);
  await expect(page.getByTestId('handover-try-again')).toHaveCount(0);
  await receive(page, { type: 'handover.replay', events: [open,
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: `${TX} is preparing and has not committed; it can go on, or be aborted back to ${MAC}` } }] });
  await expect(page.getByTestId('handover-blocker-transaction_open')).toBeVisible();
  await expect(page.getByTestId('handover-sheet')).not.toContainText(RAW);
  await expect(page.getByTestId('handover-resume')).toHaveText('Resume');
  await expect(page.getByTestId('handover-abort')).toBeVisible();
  await expect(page.getByTestId('handover-try-again')).toHaveCount(0);
  await page.getByTestId('handover-resume').click();
  expect(await lastOf(page, 'handover.resume')).toEqual({ type: 'handover.resume' });
  expect(await attaches()).toBe(2);
});

test('a helper that dies part way is looked up, and the sheet offers Resume and Abort where it stopped', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await openSheet(page);
  await page.getByTestId('handover-to-gateway').click();
  const checks: HandoverEvent = { event: 'handover.preflight', data: { summary, blockers: [], warnings: [] } };
  await say(page, checks, { event: 'handover.result', data: { status: 'ready' } });
  await receive(page, { type: 'handover.exit', code: 0 });
  await page.getByTestId('handover-try-again').click();
  await say(page, checks, ...changed('begin', 'freeze', 'transfer'));
  // the attach ends with 0 when the helper it follows dies
  await receive(page, { type: 'handover.exit', code: 0 });
  const attaches = async () => (await sent(page)).filter((m) => m.type === 'handover.attach').length;
  await expect.poll(attaches).toBe(2);
  await receive(page, { type: 'handover.replay', events: [checks, ...changed('begin', 'freeze', 'transfer'),
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'continue', transactionId: TX, phase: 'transfer', safe: ['resume', 'abort'], reason: `${TX} is preparing and has not committed; it can go on, or be aborted back to ${MAC}` } }] });
  await expect(page.getByTestId('handover-headline')).toHaveText('Stopped at Transferring files and sessions, before the commit: the fleet has not moved.');
  await expect(page.getByTestId('handover-resume')).toHaveText('Resume');
  await expect(page.getByTestId('handover-abort')).toBeVisible();
  expect(await attaches()).toBe(2);
});

test('a launch after a finished move that once asked leaves an open terminal alone and the sheet shut', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('after') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId(`tab-${a.id}`).click();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'term.show' && m.id === a.id)).toBe(true);
  await readBack(page, ...changed('begin', 'freeze'),
    { event: 'handover.blocked', data: { transactionId: 'tx1', phase: 'freeze', blockers: [{ code: 'agent_working', message: "ada's terminal is still working", entity: { kind: 'robot', id: a.id } }] } },
    ...changed('transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete'),
    { event: 'handover.result', data: { status: 'complete', transactionId: 'tx1', generation: 2, robots: [{ id: a.id, ok: true }] } },
    { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } });
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);
  await expect(page.getByTestId('surface')).toHaveAttribute('data-robot', a.id);
  expect((await sent(page)).some((m) => m.type === 'term.close')).toBe(false);
});

test('a journal the gateway has moved on from offers Forget, and a standing with nothing to decide stays shut', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token, true, 'studio', 'work');
  await svall.open();
  await readBack(page, { event: 'handover.status', data: { standing: 'unknown', journals: {}, action: 'none', transactionId: TX, safe: [], reason: `the gateway cannot say whether ${TX} committed (ssh: connect to host studio port 22: Operation timed out); nothing is safe until it answers` } });
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);

  await receive(page, { type: 'handover.replay', events: [{ event: 'handover.status', data: {
    standing: 'superseded', journals: {}, action: 'none', transactionId: TX, safe: [], reason: `the gateway holds this fleet for ${STUDIO} at generation 5 in handover 9b1d0c3e-7f2a-4d6b-8e5c-1a0f9d3b7c24, past ${TX}`,
  } }] });
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
  await expect(page.getByTestId('handover-headline')).toHaveText("The gateway has moved on past this handover. Forget drops this Mac's record of it.");
  await expect(page.getByTestId('handover-way-out').locator('code')).toHaveText(['svall -p work handover status', 'svall -p work fleet recover --force-owner local']);
  await expect(page.getByTestId('handover-sheet')).not.toContainText(RAW);
  await expect(page.getByTestId('handover-resume')).toHaveCount(0);
  await expect(page.getByTestId('handover-abort')).toHaveCount(0);
  await page.getByTestId('handover-forget').click();
  expect(await lastOf(page, 'handover.forget')).toEqual({ type: 'handover.forget' });
  await receive(page, { type: 'handover.replay', events: [{ event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } }] });
  await expect(page.getByTestId('handover-forget')).toHaveCount(0);
  await expect(page.getByTestId('handover-to-gateway')).toBeVisible();
});

test('preflight blockers name what they are about, and a new start carries the choices made', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('pull') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  const b = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'bo' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  // the fleet runs on the gateway: this is a pull
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await openSheet(page);
  await expect(page.getByTestId('handover-to-gateway')).toHaveCount(0);
  await page.getByTestId('handover-to-local').click();
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'local', check: true });

  await say(page, { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
    { code: 'robot_pinned', message: 'ada is kept on this machine', entity: { kind: 'robot', id: a.id } },
    { code: 'shell_busy', message: "bo's terminal is running npm test", entity: { kind: 'robot', id: b.id } },
    { code: 'destination_occupied', message: '/Users/l/w/app already exists and no handover left it there', entity: { kind: 'root', id: 'r_0a1b' } },
    { code: 'external_writer', message: 'the source /home/l/w/app kept changing through 3 passes; close whatever writes there, then resume', entity: { kind: 'root', id: 'r_0a1b' } },
  ] } });
  await receive(page, { type: 'handover.exit', code: 1 });
  await expect(page.getByTestId('handover-headline')).toHaveText('4 things to settle before the fleet moves to This Mac. Nothing has moved.');
  await expect(page.getByTestId('handover-try-again')).toHaveText('Move to This Mac');
  await expect(page.getByTestId('handover-blocker-external_writer')).toContainText('on studio or in its copy on This Mac');
  await expect(page.getByTestId('handover-blocker-destination_occupied')).toContainText('folder r_0a1b');
  await expect(page.getByTestId('handover-blocker-destination_occupied')).toContainText('nothing is deleted');
  await expect(page.getByTestId('handover-blocker-robot_pinned')).toContainText('Keep on this machine');

  await page.getByTestId('handover-choice-terminate').click();
  await page.getByTestId('handover-choice-archive').click();
  await page.getByTestId('handover-try-again').click();
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'local', choices: { terminateShells: [b.id], archiveRoots: ['r_0a1b'] } });
});
