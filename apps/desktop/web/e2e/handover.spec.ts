import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { HandoverPhase } from '@svall/protocol';
import { expect, test, type Svall } from './fixtures.js';
import type { FromShell, ToShell } from '../src/bridge.js';
import type { HandoverEvent } from '../src/handover.js';

type Shell = { __sent: ToShell[]; __svall: { receive(json: string): void } };

/** A stand-in for the native shell: it answers the connection, names the gateway, and records what the page asks for. */
async function fakeShell(page: Page, port: number, token: string, handoverEnabled = true, gateway: string | null = 'studio'): Promise<void> {
  await page.addInitScript(({ port, token, handoverEnabled, gateway }) => {
    const w = window as unknown as Shell & { webkit: unknown };
    w.__sent = [];
    w.webkit = { messageHandlers: { svall: { postMessage: (json: string) => {
      const m = JSON.parse(json) as ToShell;
      w.__sent.push(m);
      if (m.type === 'connection') {
        setTimeout(() => {
          w.__svall.receive(JSON.stringify({ type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false, handoverEnabled, ...(gateway && { gateway }) }));
          w.__svall.receive(JSON.stringify({ type: 'connection', host: '127.0.0.1', port, token }));
        }, 0);
      }
    } } } };
  }, { port, token, handoverEnabled, gateway });
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as Shell).__sent);
const receive = (page: Page, msg: FromShell) => page.evaluate((m) => (window as unknown as Shell).__svall.receive(JSON.stringify(m)), msg);
const say = async (page: Page, ...events: HandoverEvent[]) => { for (const event of events) await receive(page, { type: 'handover.event', event }); };
const changed = (...phases: HandoverPhase[]): HandoverEvent[] => phases.map((phase) => ({ event: 'handover.changed', data: { transactionId: 'tx1', phase } }));
const character = (id: string, phase: HandoverPhase, more: { done?: number; total?: number; error?: string; notice?: string } = {}): HandoverEvent =>
  ({ event: 'handover.entity', data: { transactionId: 'tx1', kind: 'character', id, phase, ...more } });
const summary = { digest: 'a'.repeat(64), roots: 1, files: 120, bytes: 40_000_000, sessions: 1 };
const lastOf = async (page: Page, type: ToShell['type']) => (await sent(page)).filter((m) => m.type === type).at(-1);
// what the shell reads back at launch when no helper is live: the events file, then the status
const readBack = async (page: Page, ...events: HandoverEvent[]) => {
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'handover.attach')).toBe(true);
  await receive(page, { type: 'handover.replay', events });
};
const nothingOpen = (page: Page) => readBack(page, { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } });

/** A dormant character whose resume a handover could not bring up, as the destination records it: the daemon restarts on that state. */
async function failedResume(svall: Svall, error: string): Promise<string> {
  const island = await svall.api.call('island.create', { name: svall.uniq('failed') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  execFileSync('tmux', ['-S', path.join(svall.home, 'tmux.sock'), 'kill-window', '-t', a.tmux!.windowId]);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[a.id].tmux).toBeUndefined();
  await svall.stopDaemon();
  const file = path.join(svall.home, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.characters[a.id].resumeError = error;
  fs.writeFileSync(file, JSON.stringify(state));
  await svall.startDaemon();
  return a.id;
}

const FAILED = "ada's terminal resumed codex session 01a0cd02-8ea0-75c1-89b3-89718ecbd91f, but codex exited back to its shell, so it is dormant again with that session; revive it to see";

test('a character a handover could not resume says why and waits for its Revive, which brings it up', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await page.getByTestId(`sb-char-${id}`).click();
  await expect(page.getByTestId('resume-error')).toHaveText(FAILED);
  await expect(page.getByTestId('side-card').getByTestId('side-resume-error')).toContainText(FAILED);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveAttribute('title', FAILED);

  await page.getByTestId('revive').click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', id, { timeout: 10_000 });
  await expect(page.getByTestId('side-resume-error')).toHaveCount(0);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveCount(0);
  expect((await svall.api.call('state.get', {})).characters[id].resumeError).toBeUndefined();
});

test('the map says why a handover could not resume a dormant character on its token', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall.port, svall.token);
  await svall.open('map');
  await expect(page.getByTestId(`token-resume-error-${id}`)).toHaveAttribute('title', FAILED);
  await svall.api.call('char.revive', { id });
  await expect(page.getByTestId(`token-resume-error-${id}`)).toHaveCount(0, { timeout: 10_000 });
});

test('a character a handover could not resume wakes on open like any dormant one while the fleet does not ask for handover', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall.port, svall.token, false);
  await svall.open();
  await page.getByTestId(`sb-char-${id}`).click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', id, { timeout: 10_000 });
  await expect(page.getByText(FAILED)).toHaveCount(0);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveCount(0);
});

test('the Handover control waits for the fleet to ask for handover', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token, false);
  await svall.open();
  await expect(page.getByTestId('handover-tab')).toHaveCount(0);
  expect((await sent(page)).some((m) => m.type === 'handover.attach')).toBe(false);
});

test('with no gateway the sheet says where one is set up, and offers only This Mac', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token, true, null);
  await svall.open();
  await nothingOpen(page);
  await receive(page, { type: 'connection.state', state: 'online', owner: 'local' });
  await page.getByTestId('handover-tab').click();
  await expect(page.getByTestId('handover-no-gateway')).toContainText('Settings → Machines');
  await expect(page.getByTestId('handover-to-gateway')).toHaveCount(0);
  await expect(page.getByTestId('handover-to-local')).toBeDisabled();
});

test('the sheet carries a move to the gateway through all five sections, then the page reaches the fleet where it landed', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('move') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'bo' });
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
  await page.getByTestId('handover-tab').click();
  // before anything starts, what a handover moves, with a gateway to move to
  await expect(page.getByTestId('handover-intro')).toContainText('Nothing moves until the checks pass');
  await expect(page.getByTestId('handover-no-gateway')).toHaveCount(0);
  await expect(page.getByTestId('handover-to-local')).toBeDisabled();
  await page.getByTestId('handover-to-gateway').click();
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'studio' });

  await say(page, { event: 'handover.preflight', data: { summary, blockers: [], warnings: [
    { code: 'config_difference', message: 'claude 2.0.1 runs on mac and 2.0.3 on studio' },
    { code: 'codex_trust', message: 'Codex asks whether to trust its folder the first time bo resumes on studio', entity: { kind: 'character', id: b.id } },
  ], names: { characters: { [a.id]: 'ada', [b.id]: 'bo' }, roots: { r_0a1b: '/home/ada/app' }, sessions: { s0: 'bo' } } } });
  await expect(page.getByTestId('handover-summary')).toContainText('1 folder, 120 files, 40.0 MB, 1 session');
  await expect(page.getByTestId('handover-intro')).toHaveCount(0);
  await expect(page.getByTestId('handover-warning-config_difference')).toContainText('agent CLI versions differ');
  await expect(page.getByTestId('handover-warning-config_difference')).not.toContainText(/MCP|skill/i);
  await expect(page.getByTestId('handover-warning-codex_trust')).toContainText('trust each moved folder');

  await say(page, ...changed('begin', 'freeze'), character(a.id, 'freeze'), character(b.id, 'freeze'));
  await expect(page.getByTestId(`handover-row-rest-${a.id}`)).toContainText('ada');
  await expect(page.getByTestId(`handover-row-rest-${a.id}`)).toContainText('resting…');
  // the source rests every terminal: the surfaces on them go, and none comes back while the fleet moves
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'term.close' && m.id === b.id)).toBe(true);
  await page.getByTestId('handover-close').click();
  await expect(page.getByTestId('terminal-held').first()).toBeVisible();
  await page.getByTestId('handover-tab').click();

  await say(page, character(a.id, 'freeze', { done: 1, total: 1 }), character(b.id, 'freeze', { done: 1, total: 1 }), ...changed('transfer'),
    { event: 'handover.entity', data: { transactionId: 'tx1', kind: 'root', id: 'r_0a1b', phase: 'transfer', bytes: 12_000_000, totalBytes: 40_000_000 } },
    { event: 'handover.entity', data: { transactionId: 'tx1', kind: 'session', id: 's0', phase: 'transfer', bytes: 400, totalBytes: 1000 } });
  await expect(page.getByTestId('handover-row-transfer-r_0a1b')).toContainText('12.0 MB of 40.0 MB');
  // each row is named by what preflight said it is: where a root lands, whose a session is
  await expect(page.getByTestId('handover-row-transfer-r_0a1b')).toContainText('/home/ada/app');
  await expect(page.getByTestId('handover-row-transfer-s0')).toContainText("bo's session");
  await expect(page.getByTestId('handover-section-rest')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('handover-section-transfer')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('handover-abort')).toBeVisible();

  await say(page, ...changed('verify', 'prepare', 'ready', 'commit'));
  await expect(page.getByTestId('handover-section-commit')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('handover-abort')).toHaveCount(0);

  const trust = 'codex waits at its "Trust this folder?" prompt in ada\'s terminal; answer it there';
  await say(page, ...changed('activate'), character(a.id, 'activate', { notice: trust }), character(b.id, 'activate', { error: 'bo did not start: claude exited 1' }), ...changed('complete'),
    { event: 'handover.result', data: { status: 'complete', transactionId: 'tx1', generation: 2, characters: [{ id: a.id, ok: true, notice: trust }, { id: b.id, ok: false, error: 'bo did not start: claude exited 1' }] } });
  await receive(page, { type: 'handover.exit', code: 0 });
  // the move succeeded, whatever one character did
  await expect(page.getByTestId('handover-headline')).toHaveText('The fleet runs on studio now. 1 character did not resume; retry below.');
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

  // a character that stayed dormant is retried where the fleet now runs
  const state = await svall.api.call('state.get', {});
  execFileSync('tmux', ['-S', path.join(svall.home, 'tmux.sock'), 'kill-window', '-t', state.characters[b.id].tmux!.windowId]);
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[b.id].tmux, { timeout: 10_000 }).toBeUndefined();
  await page.getByTestId('handover-tab').click();
  await page.getByTestId(`handover-retry-${b.id}`).click();
  await expect(page.getByTestId(`handover-row-resume-${b.id}`)).toContainText('resumed', { timeout: 10_000 });
});

test('a pull the page already reconnected for still gives the terminals back once the move completes', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('home') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await page.getByTestId('handover-tab').click();
  await page.getByTestId('handover-to-local').click();
  await say(page, ...changed('begin', 'freeze', 'transfer', 'verify', 'prepare', 'ready', 'commit', 'activate'), character(a.id, 'activate'), ...changed('complete'),
    { event: 'handover.result', data: { status: 'complete', transactionId: 'tx1', generation: 2, characters: [{ id: a.id, ok: true }] } });
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

test('a decision waits for its answer, which goes as one choose, and the sheet stays until it is given', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('decide') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'bo' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  await page.getByTestId('handover-tab').click();
  await page.getByTestId('handover-to-gateway').click();

  await say(page, ...changed('begin', 'freeze'), character(a.id, 'freeze'), character(b.id, 'freeze'));
  // Interrupt and carry while Freeze still waits is a choose, never an abort
  await page.getByTestId('handover-interrupt').click();
  expect(await lastOf(page, 'handover.choose')).toEqual({ type: 'handover.choose', choices: { interruptAfterMs: 0 } });
  expect(await lastOf(page, 'handover.cancel')).toBeUndefined();

  await say(page, { event: 'handover.blocked', data: { transactionId: 'tx1', phase: 'freeze', blockers: [
    { code: 'agent_unsettled', message: "ada's terminal did not come to rest after it was interrupted", entity: { kind: 'character', id: a.id } },
    { code: 'shell_busy', message: "bo's terminal is running npm test", entity: { kind: 'character', id: b.id } },
  ] } });
  await expect(page.getByTestId('handover-section-rest')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('handover-blocker-agent_unsettled')).toContainText('ada');
  await expect(page.getByTestId('handover-blocker-agent_unsettled')).toContainText('a hook of your own');
  await expect(page.getByTestId('handover-blocker-shell_busy')).toContainText('npm test');
  // nothing dismisses the sheet while the helper waits on it
  await expect(page.getByTestId('handover-close')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
  await page.getByTestId('handover-tab').click({ force: true });
  await expect(page.getByTestId('handover-sheet')).toBeVisible();

  await page.getByTestId('handover-blocker-shell_busy').getByTestId('handover-choice-terminate').click();
  await expect(page.getByTestId('handover-blocker-agent_unsettled').getByTestId('handover-choice-terminate')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('handover-go').click();
  expect(await lastOf(page, 'handover.choose')).toEqual({ type: 'handover.choose', choices: { interruptAfterMs: 0, terminateShells: true } });
  await expect(page.getByTestId('handover-close')).toBeEnabled();

  await say(page, { event: 'handover.blocked', data: { transactionId: 'tx1', phase: 'freeze', blockers: [
    { code: 'agent_working', message: "ada's terminal is still working", entity: { kind: 'character', id: a.id } },
  ] } });
  await page.getByTestId('handover-abort').click();
  expect(await lastOf(page, 'handover.cancel')).toEqual({ type: 'handover.cancel' });
});

test('a relaunch rebuilds a stopped handover, with Resume and Abort before the commit and only Retry after it', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  // the events file of the run the app was closed during, then what the journals say now
  await readBack(page, { event: 'handover.preflight', data: { summary, blockers: [], warnings: [] } }, ...changed('begin', 'freeze', 'transfer'),
    { event: 'handover.result', data: { status: 'interrupted', transactionId: 'tx1', phase: 'transfer', error: 'ssh to studio closed', safe: ['resume', 'abort'] } },
    { event: 'handover.status', data: { standing: 'open', journals: {}, action: 'none', transactionId: 'tx1', phase: 'transfer', safe: ['resume', 'abort'], reason: 'handover tx1 stopped at transfer; resume or abort it' } });
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
  await expect(page.getByTestId('handover-headline')).toHaveText('handover tx1 stopped at transfer; resume or abort it');
  await expect(page.getByTestId('handover-section-transfer')).toHaveAttribute('data-state', 'stopped');
  await expect(page.getByTestId('handover-resume')).toHaveText('Resume');
  await expect(page.getByTestId('handover-abort')).toBeVisible();
  await page.getByTestId('handover-abort').click();
  expect(await lastOf(page, 'handover.abort')).toEqual({ type: 'handover.abort' });
  expect(await lastOf(page, 'handover.cancel')).toBeUndefined();

  await receive(page, { type: 'handover.replay', events: [
    { event: 'handover.status', data: { standing: 'committed', journals: {}, action: 'none', transactionId: 'tx1', phase: 'activate', safe: ['resume'], reason: 'studio holds tx1 committed; resume finishes it there' } }] });
  await expect(page.getByTestId('handover-resume')).toHaveText('Retry');
  await expect(page.getByTestId('handover-abort')).toHaveCount(0);
  await expect(page.getByTestId('handover-sheet')).not.toContainText(/abort|roll ?back|undo|revert/i);
  await page.getByTestId('handover-resume').click();
  expect(await lastOf(page, 'handover.resume')).toEqual({ type: 'handover.resume' });
});

test('a launch after a finished move that once asked leaves an open terminal alone and the sheet shut', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('after') });
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await page.getByTestId(`tab-${a.id}`).click();
  await expect.poll(async () => (await sent(page)).some((m) => m.type === 'term.show' && m.id === a.id)).toBe(true);
  await readBack(page, ...changed('begin', 'freeze'),
    { event: 'handover.blocked', data: { transactionId: 'tx1', phase: 'freeze', blockers: [{ code: 'agent_working', message: "ada's terminal is still working", entity: { kind: 'character', id: a.id } }] } },
    ...changed('transfer', 'verify', 'prepare', 'ready', 'commit', 'activate', 'complete'),
    { event: 'handover.result', data: { status: 'complete', transactionId: 'tx1', generation: 2, characters: [{ id: a.id, ok: true }] } },
    { event: 'handover.status', data: { standing: 'none', journals: {}, action: 'none', safe: [], reason: 'no handover is open' } });
  await expect(page.getByTestId('handover-tab')).toBeVisible();
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);
  await expect(page.getByTestId('surface')).toHaveAttribute('data-char', a.id);
  expect((await sent(page)).some((m) => m.type === 'term.close')).toBe(false);
});

test('a journal the gateway has moved on from offers Forget, and a standing with nothing to decide stays shut', async ({ page, svall }) => {
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await readBack(page, { event: 'handover.status', data: { standing: 'unknown', journals: {}, action: 'none', safe: [], reason: 'the gateway did not answer' } });
  await expect(page.getByTestId('handover-tab')).toBeVisible();
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);

  await receive(page, { type: 'handover.replay', events: [{ event: 'handover.status', data: { standing: 'superseded', journals: {}, action: 'none', transactionId: 'tx1', safe: [], reason: 'the gateway holds another handover than tx1; forget this journal' } }] });
  await expect(page.getByTestId('handover-sheet')).toBeVisible();
  await expect(page.getByTestId('handover-headline')).toHaveText('the gateway holds another handover than tx1; forget this journal');
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
  const a = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'ada' });
  const b = await svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name: 'bo' });
  await fakeShell(page, svall.port, svall.token);
  await svall.open();
  await nothingOpen(page);
  // the fleet runs on the gateway: this is a pull
  await receive(page, { type: 'connection.state', state: 'online', owner: 'studio' });
  await page.getByTestId('handover-tab').click();
  await expect(page.getByTestId('handover-to-gateway')).toBeDisabled();
  await page.getByTestId('handover-to-local').click();
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'local' });

  await say(page, { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
    { code: 'character_pinned', message: 'ada is kept on this machine', entity: { kind: 'character', id: a.id } },
    { code: 'shell_busy', message: "bo's terminal is running npm test", entity: { kind: 'character', id: b.id } },
    { code: 'destination_occupied', message: '/Users/l/w/app already exists and no handover left it there', entity: { kind: 'root', id: 'r_0a1b' } },
    { code: 'external_writer', message: 'the source /home/l/w/app kept changing through 3 passes; close whatever writes there, then resume', entity: { kind: 'root', id: 'r_0a1b' } },
  ] } });
  await receive(page, { type: 'handover.exit', code: 1 });
  await expect(page.getByTestId('handover-headline')).toHaveText('Nothing moved. Settle what is listed, then try again.');
  await expect(page.getByTestId('handover-blocker-external_writer')).toContainText('on studio or in its copy on This Mac');
  await expect(page.getByTestId('handover-blocker-destination_occupied')).toContainText('folder r_0a1b');
  await expect(page.getByTestId('handover-blocker-destination_occupied')).toContainText('nothing is deleted');
  await expect(page.getByTestId('handover-blocker-character_pinned')).toContainText('Keep on this machine');

  await page.getByTestId('handover-choice-terminate').click();
  await page.getByTestId('handover-choice-archive').click();
  await page.getByTestId('handover-try-again').click();
  expect(await lastOf(page, 'handover.start')).toEqual({ type: 'handover.start', to: 'local', choices: { terminateShells: true, archiveRoots: ['r_0a1b'] } });

  await say(page, { event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [
    { code: 'character_pinned', message: 'ada is kept on this machine', entity: { kind: 'character', id: a.id } },
  ] } });
  await receive(page, { type: 'handover.exit', code: 1 });
  // the blocker points at the toggle, on the character it names
  await page.getByTestId('handover-open-card').click();
  await expect(page.getByTestId('handover-sheet')).toHaveCount(0);
  await expect(page.getByTestId('side-name')).toHaveValue('ada');
  await svall.api.call('char.update', { id: a.id, keepHere: true });
  await expect(page.getByTestId('side-keep-here')).toBeChecked();
  await page.getByTestId('side-keep-here').click();
  await expect.poll(async () => (await svall.api.call('state.get', {})).characters[a.id].keepHere).toBeUndefined();
});
