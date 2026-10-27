import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { FAKE_CLAUDE, expect, nativeShell, test, type Svall } from './fixtures.js';

test('opens a terminal in the card over the board, switches with Cmd+J, marks seen, and revives', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('term') });
  const a = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'a' });
  const b = await svall.api.call('robot.create', { islandId: island.id, cwd: '/tmp', name: 'b', command: FAKE_CLAUDE });
  await svall.open();
  await expect(page.getByTestId(`sb-robot-${b.id}`)).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
  await svall.api.call('robot.run', { id: b.id, text: 'block', enter: true });
  await expect(page.getByTestId(`sb-robot-${b.id}`)).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await expect(page.getByTestId(`sb-robot-${b.id}`)).toHaveAttribute('data-attention', 'true');
  await svall.api.call('robot.answer', { id: b.id, answer: 'approve' });
  await expect(page.getByTestId(`sb-robot-${b.id}`)).toHaveAttribute('data-unread', 'true', { timeout: 15_000 });

  await page.getByTestId(`kc-${a.id}`).dblclick();
  const surface = page.getByTestId('surface');
  await expect(surface).toHaveAttribute('data-robot', a.id);
  await expect(surface).toContainText('terminal · a');
  // the card goes along to the map, and back
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('terminal-card')).toHaveAttribute('data-robot', a.id);
  await page.keyboard.press('Meta+m');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(surface).toHaveAttribute('data-robot', a.id);

  await page.keyboard.press('Meta+j');
  await expect(surface).toHaveAttribute('data-robot', b.id);
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[b.id].unread).toBe(false);
  await expect.poll(async () => (await svall.api.call('state.get', {})).robots[b.id].agent?.status).toBe('idle');

  const state = await svall.api.call('state.get', {});
  execFileSync('tmux', ['-S', path.join(svall.home, 'tmux.sock'), 'kill-window', '-t', state.robots[b.id].tmux!.windowId]);
  await expect(page.getByTestId('revive')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('revive').click();
  await expect(surface).toHaveAttribute('data-robot', b.id, { timeout: 10_000 });
});

const fakeShell = (page: Page, svall: Svall) =>
  nativeShell(page, { port: svall.port, token: svall.token, info: { type: 'shell.info', home: '/tmp/fleet-x', log: [], op: false } });

/** A dormant robot whose resume failed, as svalld records it: the daemon restarts on that state. */
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

test('a robot whose resume failed says why and waits for its Revive, which brings it up', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall);
  await svall.open();
  await page.getByTestId(`sb-robot-${id}`).dblclick();
  await expect(page.getByTestId('resume-error')).toHaveText(FAILED);
  await expect(page.getByTestId('side-card').getByTestId('side-resume-error')).toContainText(FAILED);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveAttribute('title', FAILED);

  await page.getByTestId('revive').click();
  await expect(page.getByTestId('surface')).toHaveAttribute('data-robot', id, { timeout: 10_000 });
  await expect(page.getByTestId('side-resume-error')).toHaveCount(0);
  await expect(page.getByTestId(`sb-resume-error-${id}`)).toHaveCount(0);
  expect((await svall.api.call('state.get', {})).robots[id].resumeError).toBeUndefined();
});

test('a robot whose resume failed starts afresh from a summary of its session, which stays where it was', async ({ page, svall }) => {
  const sid = '1fb0d1a7-29a9-4159-a932-5ffd2da8faba';
  const id = await failedResume(svall, FAILED, (c) => {
    c.agent = { kind: 'claude', sessionId: sid, status: 'idle', lastActivityAt: 0 };
    c.revive = { command: `claude --resume ${sid}` };
  });
  await fakeShell(page, svall);
  await svall.open();
  await page.getByTestId(`sb-robot-${id}`).dblclick();
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

test('the map says on its token why a dormant robot could not resume', async ({ page, svall }) => {
  const id = await failedResume(svall, FAILED);
  await fakeShell(page, svall);
  await svall.open('map');
  await expect(page.getByTestId(`token-resume-error-${id}`)).toHaveAttribute('title', FAILED);
  await svall.api.call('robot.revive', { id });
  await expect(page.getByTestId(`token-resume-error-${id}`)).toHaveCount(0, { timeout: 10_000 });
});
