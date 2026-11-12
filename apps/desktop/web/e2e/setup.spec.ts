import { expect, test, type Page } from '@playwright/test';
import type { SetupPlan as Plan } from '@svall/protocol';

const PLAN: Plan = { agents: [{ kind: 'claude', path: '/u/.local/bin/claude', version: '2.1.0', signedIn: true }, { kind: 'codex', path: '/opt/homebrew/bin/codex', signedIn: false }],
  writes: [{ what: 'Claude Code hooks and status line', path: '/u/.claude/settings.json', agent: 'claude' }, { what: 'Codex hooks', path: '/u/.codex/hooks.json', agent: 'codex' },
    { what: 'Service that keeps fleets running', path: '/u/Library/LaunchAgents/x.plist' }, { what: 'The svall command', path: '/u/.local/bin/svall' },
    { what: 'Your fleet', path: '/u/.svall' }], pathFile: '/u/.zshrc', shimDir: '/u/.local/bin', shimOnPath: false, blockers: [], projects: '~/Developer' };

// the shell's side of the bridge: answers the page's setup asks with `plan`, and keeps what it was sent; a machine run plays `steps`
async function fakeShell(page: Page, plan: Plan, failFirst = false, warnings: string[] = [], steps: { op: string; event: object; code?: number }[] = []): Promise<void> {
  await page.addInitScript(([p, failFirst, warnings, steps]) => {
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
      if (msg.type === 'setup.join') reply({ type: 'setup.result', step: 'run', ok: true, json: JSON.stringify({ done: [], warnings: [] }) });
      if (msg.type === 'host.start') {
        // each step a beat apart, so a page caught between two shows the run under way; a step with a code ends the run there
        steps.filter((s) => s.op === msg.op).forEach((s, i) => setTimeout(() => w.__svall.receive(JSON.stringify(s.code === undefined
          ? { type: 'host.step', op: s.op, event: s.event } : { type: 'host.done', op: s.op, code: s.code })), 100 * (i + 1)));
      }
    } } } };
  }, [plan, failFirst, warnings, steps] as const);
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: { type: string; agents?: string[]; text?: string; url?: string }[] }).__sent);

const NOTHING: Plan = { ...PLAN, agents: [], writes: PLAN.writes.slice(2),
  blockers: ["Svall runs Claude Code, Codex or OpenCode in its terminals, so it needs the claude, codex or opencode command. The desktop apps don't install it. Install one in Terminal, then check again."],
  install: [{ kind: 'claude', command: 'curl -fsSL https://claude.ai/install.sh | bash', url: 'https://code.claude.com/docs/en/setup' },
    { kind: 'codex', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', url: 'https://learn.chatgpt.com/docs/codex/cli' },
    { kind: 'opencode', command: 'curl -fsSL https://opencode.ai/v2/install | bash', url: 'https://opencode.ai/v2/docs/' }] };

const next = (page: Page) => page.getByRole('button', { name: 'Continue', exact: true }).click();
const here = (page: Page) => page.getByTestId('fork-here').click();

test('collects choices over three screens and writes only at the end', async ({ page }) => {
  await fakeShell(page, PLAN, false, ['Trust the Codex hooks once.']);
  await page.goto('/?setup=1');
  await here(page);
  await expect(page.getByRole('heading', { name: 'Connect your agents' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('setup-agents.png') });
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck();
  await next(page);
  await page.screenshot({ path: test.info().outputPath('setup-where.png') });
  const field = page.getByRole('textbox', { name: 'Projects folder' });
  await expect(field).toHaveValue('~/Developer');
  await page.getByRole('button', { name: 'Choose a project…' }).click();
  await expect(page.getByRole('button', { name: 'Clear first project' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear first project' }).click();
  await field.fill('');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await field.fill(' ~/work ');
  await next(page);
  await expect(page.getByRole('checkbox', { name: 'Automatically update robot notes', exact: true })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath('setup-preferences.png'), fullPage: true });
  await page.getByText('Review changes').click();
  await expect(page.getByText('/u/.claude/settings.json')).toBeVisible();
  await expect(page.getByText('/u/.codex/hooks.json')).toHaveCount(0);
  expect((await sent(page)).filter((m) => m.type === 'setup.run')).toHaveLength(0);
  await page.getByRole('button', { name: 'Set up Svall' }).click();
  expect((await sent(page)).find((m) => m.type === 'setup.run')).toMatchObject({ agents: ['claude'], found: ['claude', 'codex'], projects: '~/work', mainAgent: 'claude', scribe: true, svallPermissions: true, newRobotStart: 'agent' });
  await expect(page.getByText('Trust the Codex hooks once.')).toBeVisible();
});

test('skips a single signed-in agent, but shows uncertain sign-in and the login action', async ({ page }) => {
  await fakeShell(page, { ...PLAN, agents: [{ ...PLAN.agents[0]!, signedIn: true }] });
  await page.goto('/?setup=1');
  await here(page);
  await expect(page.getByRole('heading', { name: 'Choose where you work' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('Logged in')).toBeVisible();
});

test('says what to install when no agent is found, and asks again', async ({ page }) => {
  await fakeShell(page, NOTHING);
  await page.goto('/?setup=1');
  await here(page);
  await expect(page.getByText('needs the claude, codex or opencode command')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  expect((await sent(page)).filter((m) => m.type === 'setup.plan')).toHaveLength(2);
});

test('gives each agent\'s install command to select or copy, and its other ways in the browser', async ({ page }) => {
  await fakeShell(page, NOTHING);
  await page.goto('/?setup=1');
  await here(page);
  for (const [label, i] of [['Claude Code', NOTHING.install![0]!], ['Codex', NOTHING.install![1]!]] as const) {
    await page.getByRole('radio', { name: label }).check();
    const command = page.getByText(i.command);
    await expect(command).toHaveCSS('user-select', 'text');
    const box = page.locator('.setup-code', { has: command });
    await box.getByRole('button', { name: 'Copy' }).click();
    await expect(box.getByRole('button', { name: 'Copied' })).toBeVisible();
    await page.getByRole('link', { name: `Other ways to install ${label}` }).click();
    const msgs = await sent(page);
    expect(msgs.filter((m) => m.type === 'copy').at(-1)).toMatchObject({ text: i.command });
    expect(msgs.filter((m) => m.type === 'openUrl').at(-1)).toMatchObject({ url: i.url });
  }
});

test('gives the PATH line with the installers when their folder is not on PATH, and only there', async ({ page }) => {
  await fakeShell(page, NOTHING);
  await page.goto('/?setup=1');
  await here(page);
  await expect(page.getByText('The installer puts the command in /u/.local/bin, which is not on your PATH')).toBeVisible();
  await expect(page.getByText('export PATH="$HOME/.local/bin:$PATH"')).toHaveCount(1);
  await page.getByRole('radio', { name: 'OpenCode' }).check();
  await expect(page.getByText("Svall's command goes in /u/.local/bin, which is not on your PATH")).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The svall command' })).toHaveCount(0);
});

test('says an agent found only by its folder has no command, as a desktop app leaves one', async ({ page }) => {
  await fakeShell(page, { ...NOTHING, agents: [{ kind: 'claude', path: '/u/.claude', folderOnly: true }] });
  await page.goto('/?setup=1');
  await here(page);
  await expect(page.getByText('CLI not found')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
});

test('shows a failed first ask inline and retries it', async ({ page }) => {
  await fakeShell(page, PLAN, true);
  await page.goto('/?setup=1');
  await expect(page.getByText('svall: something went wrong')).toBeVisible();
  await page.getByRole('button', { name: 'Check again' }).click();
  await here(page);
  await next(page); await next(page);
  await page.getByText('Review changes').click();
  await expect(page.getByText('/u/.claude/settings.json')).toBeVisible();
});

test('forks three ways before anything is written', async ({ page }) => {
  await fakeShell(page, { agents: [{ kind: 'claude', path: '/usr/local/bin/claude', version: '2.0' }], projects: '~/Developer', blockers: [], shimDir: '/Users/test/.local/bin', shimOnPath: true, writes: [] } as Plan);
  await page.goto('/?setup=1');
  await expect(page.getByTestId('setup-fork').getByRole('button')).toHaveText([/^This Mac/, /^A server, set up nowrecommended/, /^A server that already runs your fleet/]);
  // each choice reads from the row's left edge, its caret at the right end
  const lefts = await page.locator('[data-testid="setup-fork"] .setup-agent-name').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  await page.screenshot({ path: test.info().outputPath('setup-fork.png') });
  await page.getByTestId('fork-join').click();
  await expect(page.getByRole('heading', { name: 'Connect to your server' })).toBeVisible();
  await expect(page.getByTestId('fork-go')).toBeDisabled();
  await page.getByTestId('fork-ssh').fill('ada@studio');
  await expect(page.getByTestId('fork-go')).toBeEnabled();
  await page.getByTestId('fork-back').click();
  await expect(page.getByTestId('setup-fork')).toBeVisible();
});

test('a server path shows only its run while it runs, and after a failed step its row, Try again and the form back filled', async ({ page }) => {
  const SERVER: Plan = { agents: [{ kind: 'claude', path: '/usr/local/bin/claude', version: '2.0' }], projects: '~/Developer', blockers: [], shimDir: '/Users/test/.local/bin', shimOnPath: true, writes: [] };
  const add = (event: object) => ({ op: 'add', event });
  await fakeShell(page, SERVER, false, [], [
    add({ step: 'ssh', status: 'start' }), add({ step: 'ssh', status: 'ok', detail: 'logs in' }),
    add({ step: 'os', status: 'start' }), add({ step: 'os', status: 'ok', detail: 'Ubuntu 24.04 LTS, x86-64' }),
    add({ step: 'tmux', status: 'warn', detail: '3.4: Shift+Enter needs 3.5' }),
    add({ step: 'install', status: 'start' }), add({ step: 'install', status: 'ok', detail: '0.9.4 installed' }),
    add({ step: 'master', status: 'start' }),
    // the run waits here a beat, for the capture of a run under way
    ...Array.from({ length: 30 }, () => add({ step: 'master', status: 'start' })),
    add({ step: 'master', status: 'fail', detail: 'studio has no Tailscale', action: 'ssh ada@studio, install Tailscale and run tailscale up, then try again', raw: 'tailscale status --json exited 1: tailscale: command not found' }),
    { op: 'add', event: {}, code: 1 },
  ]);
  await page.goto('/?setup=1');
  await page.getByTestId('fork-server').click();
  await expect(page.getByRole('heading', { name: 'Set up a server' })).toBeVisible();
  await page.getByTestId('fork-ssh').fill('ada@studio');
  await page.screenshot({ path: test.info().outputPath('setup-server-form.png') });
  await page.getByTestId('fork-go').click();
  await expect(page.getByTestId('fork-now')).toBeVisible();
  await expect(page.getByTestId('fork-ssh')).toHaveCount(0);
  await expect(page.getByText('Review changes')).toHaveCount(0);
  await expect(page.locator('.setup-intro p')).toHaveText('ada@studio');
  await expect(page.getByTestId('fork-done')).toHaveText('3 steps done');
  await expect(page.getByTestId('fork-now')).toHaveText('Connection…');
  await page.screenshot({ path: test.info().outputPath('setup-server-running.png') });
  await expect(page.getByTestId('fork-stop')).toBeVisible();
  const failed = page.locator('[data-testid="fork-steps"] li[data-status="fail"]');
  await expect(failed).toContainText('studio has no Tailscale');
  await expect(failed.locator('.modal-sub')).toHaveText('ssh ada@studio, install Tailscale and run tailscale up, then try again');
  await expect(failed.getByText('tailscale: command not found')).toBeHidden();
  await expect(page.getByTestId('fork-notes')).toHaveText('1 note');
  await expect(page.getByTestId('fork-now')).toHaveCount(0);
  await expect(page.locator('.setup-acts .btn')).toHaveText(['Try again', 'Back']);
  await failed.getByText('details').click();
  await expect(failed.getByText('tailscale: command not found')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('setup-server-failed.png') });
  await page.getByTestId('fork-back').click();
  await expect(page.getByTestId('fork-ssh')).toHaveValue('ada@studio');
});
