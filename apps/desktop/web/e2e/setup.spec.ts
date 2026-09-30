import { expect, test, type Page } from '@playwright/test';

type Plan = { agents: { kind: string; path: string; version?: string }[]; writes: { what: string; path: string }[]; shimDir: string; shimOnPath: boolean; blockers: string[] };

const PLAN: Plan = { agents: [{ kind: 'claude', path: '/u/.local/bin/claude', version: '2.1.0' }, { kind: 'codex', path: '/opt/homebrew/bin/codex' }],
  writes: [{ what: 'Claude Code hooks and status line', path: '/u/.claude/settings.json' }, { what: 'Codex hooks', path: '/u/.codex/hooks.json' },
    { what: 'the background service that keeps fleets running', path: '/u/Library/LaunchAgents/x.plist' }, { what: 'the svall command', path: '/u/.local/bin/svall' },
    { what: 'your fleet', path: '/u/.svall' }], shimDir: '/u/.local/bin', shimOnPath: false, blockers: [] };

// the shell's side of the bridge: answers the page's setup asks with `plan`, and keeps what it was sent
async function fakeShell(page: Page, plan: Plan): Promise<void> {
  await page.addInitScript((p) => {
    const w = window as unknown as { __sent: { type: string; agents?: string[] }[]; webkit: unknown; __svall: { receive(j: string): void } };
    w.__sent = [];
    w.webkit = { messageHandlers: { svall: { postMessage: (text: string) => {
      const msg = JSON.parse(text);
      w.__sent.push(msg);
      const reply = (m: object) => setTimeout(() => w.__svall.receive(JSON.stringify(m)), 10);
      if (msg.type === 'setup.plan') reply({ type: 'setup.result', step: 'plan', ok: true, json: JSON.stringify(p) });
      if (msg.type === 'setup.run') reply({ type: 'setup.result', step: 'run', ok: true, json: '{"done":[],"warnings":[]}' });
    } } } };
  }, plan);
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: { type: string; agents?: string[] }[] }).__sent);

test('lists the agents and files, and sets up the agents left on', async ({ page }) => {
  await fakeShell(page, PLAN);
  await page.goto('/?setup=1');
  await expect(page.getByText('/u/.claude/settings.json')).toBeVisible();
  await expect(page.getByText('export PATH="$HOME/.local/bin:$PATH"')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await expect(page.getByText('/u/.codex/hooks.json')).toHaveCount(0);
  await page.getByRole('button', { name: 'Set up' }).click();
  expect((await sent(page)).find((m) => m.type === 'setup.run')?.agents).toEqual(['claude']);
});

test('says what to install when no agent is found, and asks again', async ({ page }) => {
  await fakeShell(page, { ...PLAN, agents: [], writes: PLAN.writes.slice(2), blockers: ['Install Claude Code or Codex first, then check again.'] });
  await page.goto('/?setup=1');
  await expect(page.getByText('Install Claude Code or Codex first')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  expect((await sent(page)).filter((m) => m.type === 'setup.plan')).toHaveLength(2);
});
