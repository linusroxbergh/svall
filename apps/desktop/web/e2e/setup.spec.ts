import { expect, test, type Page } from '@playwright/test';

type Plan = {
  agents: { kind: string; path: string; version?: string; folderOnly?: boolean }[]; integrations?: string[]; writes: { what: string; path: string; agent?: string }[];
  shimDir: string; shimOnPath: boolean; blockers: string[]; projects: string;
};

const PLAN: Plan = { agents: [{ kind: 'claude', path: '/u/.local/bin/claude', version: '2.1.0' }, { kind: 'codex', path: '/opt/homebrew/bin/codex' }],
  writes: [{ what: 'Claude Code hooks and status line', path: '/u/.claude/settings.json', agent: 'claude' }, { what: 'Codex hooks', path: '/u/.codex/hooks.json', agent: 'codex' },
    { what: 'Service that keeps fleets running', path: '/u/Library/LaunchAgents/x.plist' }, { what: 'The svall command', path: '/u/.local/bin/svall' },
    { what: 'Your fleet', path: '/u/.svall' }], shimDir: '/u/.local/bin', shimOnPath: false, blockers: [], projects: '~/Developer' };

// the shell's side of the bridge: answers the page's setup asks with `plan`, and keeps what it was sent
async function fakeShell(page: Page, plan: Plan, failFirst = false, warnings: string[] = []): Promise<void> {
  await page.addInitScript(([p, failFirst, warnings]) => {
    const w = window as unknown as { __sent: { type: string; agents?: string[] }[]; webkit: unknown; __svall: { receive(j: string): void } };
    w.__sent = [];
    let asks = 0;
    w.webkit = { messageHandlers: { svall: { postMessage: (text: string) => {
      const msg = JSON.parse(text);
      w.__sent.push(msg);
      const reply = (m: object) => setTimeout(() => w.__svall.receive(JSON.stringify(m)), 10);
      if (msg.type === 'setup.plan') reply(failFirst && asks++ === 0 ? { type: 'setup.result', step: 'plan', ok: false, json: 'svall: something went wrong' } : { type: 'setup.result', step: 'plan', ok: true, json: JSON.stringify(p) });
      if (msg.type === 'setup.run') reply({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ done: [], warnings }) });
      if (msg.type === 'folder.pick') reply({ type: 'folder.picked', path: '~/code' });
    } } } };
  }, [plan, failFirst, warnings] as const);
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
  expect((await sent(page)).find((m) => m.type === 'setup.run')).toMatchObject({ agents: ['claude'], found: ['claude', 'codex'], projects: '~/Developer' });
});

test('offers a projects folder, takes one picked in the native picker or typed, and needs one to set up', async ({ page }) => {
  await fakeShell(page, PLAN);
  await page.goto('/?setup=1');
  const field = page.getByRole('textbox', { name: 'Projects folder' });
  await expect(field).toHaveValue('~/Developer');
  await page.getByRole('button', { name: 'Choose…' }).click();
  await expect(field).toHaveValue('~/code');
  expect((await sent(page)).find((m) => m.type === 'folder.pick')).toMatchObject({ start: '~/Developer' });
  await field.fill('');
  await expect(page.getByRole('button', { name: 'Set up' })).toBeDisabled();
  await field.fill(' ~/work ');
  await page.getByRole('button', { name: 'Set up' }).click();
  expect((await sent(page)).find((m) => m.type === 'setup.run')).toMatchObject({ projects: '~/work' });
});

test('starts an agent turned off at an earlier setup unchecked, with its file left out until it is checked', async ({ page }) => {
  await fakeShell(page, { ...PLAN, integrations: ['claude'] });
  await page.goto('/?setup=1');
  await expect(page.getByRole('checkbox', { name: 'Codex' })).not.toBeChecked();
  await expect(page.getByText('/u/.codex/hooks.json')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await expect(page.getByText('/u/.codex/hooks.json')).toBeVisible();
});

test('gives an agent found only by its folder a toggle, but sets up only with an agent whose CLI is here', async ({ page }) => {
  await fakeShell(page, { ...PLAN, agents: [PLAN.agents[0]!, { kind: 'codex', path: '/u/.codex', folderOnly: true }] });
  await page.goto('/?setup=1');
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await expect(page.getByText('/u/.codex/hooks.json')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('checkbox', { name: 'Claude Code' }).uncheck();
  await expect(page.getByRole('button', { name: 'Set up' })).toBeDisabled();
});

test('shows what setup asks of the user before it opens the map', async ({ page }) => {
  await fakeShell(page, PLAN, false, ['Codex asks once to trust these hooks: start codex and choose "Trust all and continue", or trust them in /hooks']);
  await page.goto('/?setup=1');
  await page.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByText('Trust all and continue')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('says what to install when no agent is found, and asks again', async ({ page }) => {
  await fakeShell(page, { ...PLAN, agents: [], writes: PLAN.writes.slice(2), blockers: ['Install Claude Code (https://code.claude.com/docs/en/setup) or Codex (https://learn.chatgpt.com/docs/codex/cli) first, then check again.'] });
  await page.goto('/?setup=1');
  await expect(page.getByText('Install Claude Code (https://code.claude.com/docs/en/setup) or Codex')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  expect((await sent(page)).filter((m) => m.type === 'setup.plan')).toHaveLength(2);
});

test('shows a failed first ask inline and retries it', async ({ page }) => {
  await fakeShell(page, PLAN, true);
  await page.goto('/?setup=1');
  await expect(page.getByText('svall: something went wrong')).toBeVisible();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('/u/.claude/settings.json')).toBeVisible();
});
