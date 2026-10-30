import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markDormant, markSlotDormant } from '../src/dormancy.js';
import type { HookEvent } from '../src/hooks/receiver.js';
import { resolvePaths } from '../src/paths.js';
import { boot, cleanup, pane, stopFleets } from './fleet-boot.js';
import { cleanHomes, hasTmux, makeHome, waitFor, waitForPolls } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('Fleet agents', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('runs text and streams output only when the pane is on', async () => {
    const { fleet } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const got: string[] = [];
    fleet.on('output', (id, data) => { if (id === c.id) got.push(data.toString()); });
    await fleet.run(c.id, 'echo silent', true);
    await waitFor(async () => (await fleet.readScreen(c.id, 20)).includes('silent'));
    expect(got.join('')).not.toMatch(/silent/);
    fleet.setPaneOutput(c.id, true);
    await fleet.run(c.id, 'echo loud', true);
    await waitFor(() => got.join('').includes('loud'));
  });

  it('applies hooks, resolves waits, and marks seen', async () => {
    const { fleet, store } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const wait = fleet.waitFor(c.id, ['done'], 5000);
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    expect(store.state.robots[c.id].agent?.status).toBe('idle');
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit' } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Stop' } });
    expect(await wait).toBe('done');
    expect(store.state.robots[c.id].unread).toBe(true);
    expect(fleet.markSeen(c.id).agent?.status).toBe('idle');
    expect(await fleet.waitFor(c.id, ['idle'], 100)).toBe('idle');
    expect(await fleet.waitFor(c.id, ['blocked'], 100)).toBe('timeout');
    await fleet.closeRobot(c.id);
    expect(await fleet.waitFor(c.id, ['idle'], 100)).toBe('gone');
  });

  it('records shell activity only for a robot without an agent, and again as soon as its agent ends', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    // a stand-in agent: the pane is away from its shell prompt
    await tmux.sendLine(c.tmux!.paneId, 'sleep 30', true);
    await waitFor(async () => (await tmux.listWindows()).some((w) => w.name === c.id && w.command === 'sleep'));
    store.update((d) => {
      d.robots[c.id].agent = { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'working', lastActivityAt: 1 };
      d.robots[c.id].shell.lastOutputAt = 0;
    });
    await waitForPolls(fleet, 3);
    expect(store.state.robots[c.id].shell.lastOutputAt).toBe(0);
    // back at the prompt for two polls, the agent has ended
    await tmux.run('send-keys', '-t', c.tmux!.paneId, 'C-c');
    await waitFor(() => !store.state.robots[c.id].agent);
    expect(store.state.robots[c.id].shell.lastOutputAt).toBeGreaterThan(0);
  });

  it('keeps an agent ctrl+z stopped, whose shell is in front until fg, and lets it go once it is killed', async () => {
    const { fleet, store, tmux, home } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const pidFile = path.join(home, 'agent.pid');
    // whether the stand-in agent is in front of its shell
    const inFront = (yes: boolean) => waitFor(async () => (await tmux.listWindows()).some((w) => w.name === c.id && (w.command === 'sleep') === yes));
    await tmux.sendLine(c.tmux!.paneId, `sh -c 'echo $$ > ${pidFile}; exec sleep 600'`, true);
    await inFront(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    store.update((d) => { d.robots[c.id].agent = { kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 1, pid }; });
    const twice = async () => { await fleet['poll']['tick'](); await fleet['poll']['tick'](); };
    await tmux.run('send-keys', '-t', c.tmux!.paneId, 'C-z');
    await inFront(false);
    await twice();
    expect(store.state.robots[c.id].agent?.pid).toBe(pid);
    await tmux.sendLine(c.tmux!.paneId, 'fg', true);
    await inFront(true);
    await twice();
    expect(store.state.robots[c.id].agent?.pid).toBe(pid);
    await tmux.run('send-keys', '-t', c.tmux!.paneId, 'C-z');
    await inFront(false);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await twice();
    expect(store.state.robots[c.id].agent).toBeUndefined();
  });

  it('takes a pane at the shell config.json names for its prompt, which its agent has left', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await waitFor(async () => (await tmux.listWindows()).some((w) => w.name === c.id && w.command === 'sleep'));
    store.update((d) => { d.robots[c.id].agent = { kind: 'claude', sessionId: 's', status: 'idle', lastActivityAt: 1 }; });
    const twice = async () => { await fleet['poll']['tick'](); await fleet['poll']['tick'](); };
    await twice();
    expect(store.state.robots[c.id].agent).toBeDefined();
    fleet['deps'].config.shell = '/opt/homebrew/bin/sleep';
    await twice();
    expect(store.state.robots[c.id].agent).toBeUndefined();
  });

  it('lets a Claude agent go once its transcript shows an Esc or a "No" ended the turn, which no hook reports', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await waitFor(async () => (await tmux.listWindows()).some((w) => w.name === c.id && w.command === 'sleep'));
    const transcript = path.join(makeHome(), 't.jsonl');
    const entry = (at: number, content: unknown) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content } }) + '\n';
    const esc = (at: number) => entry(at, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
    const asked = Date.now() - 10_000;
    fs.writeFileSync(transcript, entry(asked - 1000, 'ask me'));
    store.update((d) => { d.robots[c.id].agent = { kind: 'claude', sessionId: 's', transcriptPath: transcript, status: 'blocked', promptId: 'q', asking: ['a1'], lastActivityAt: asked }; });
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('blocked');
    fs.appendFileSync(transcript, entry(asked + 2000, [{ type: 'tool_result', is_error: true, content: 'rejected' }]) + esc(asked + 2001));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'idle' });
    expect(store.state.robots[c.id].agent).not.toHaveProperty('asking');
    // an Esc from before the agent's last hook was answered by it, as a prompt typed straight after
    store.update((d) => { d.robots[c.id].agent!.status = 'working'; d.robots[c.id].agent!.lastActivityAt = Date.now(); });
    fs.appendFileSync(transcript, esc(Date.now() - 1000));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('working');
  });

  it("takes a Claude agent's question for answered once its empty prompt line is back, as while an approved command runs", async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await waitFor(async () => (await tmux.listWindows()).some((w) => w.name === c.id && w.command === 'sleep'));
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Notification', sessionId: 'sess', ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    await hook({ name: 'PreToolUse', toolName: 'Bash' });
    await hook({ name: 'PermissionRequest', toolName: 'Bash' });
    await hook({ notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    const screen = vi.spyOn(tmux, 'screen').mockResolvedValue(pane('claude-permission'));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('blocked');
    // a field of the dialog's own shows the cursor as the prompt line does
    screen.mockResolvedValue(pane('claude-question-field'));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('blocked');
    screen.mockResolvedValue(pane('claude-working'));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'working', askedTool: 'Bash' });
    expect(store.state.robots[c.id].agent).not.toHaveProperty('prompt');
    // a subagent's question may be out of view, as may one asked about no tool
    await hook({ name: 'PermissionRequest', agentId: 'a1', toolName: 'Bash' });
    await hook({ notificationType: 'permission_prompt', message: 'may I' });
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('blocked');
    await hook({ name: 'Stop' });
    await hook({ notificationType: 'elicitation_dialog', message: 'fill this in' });
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('blocked');
  });

  it("takes a Codex agent's question for answered once its empty prompt line is back, a subagent's too", async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await waitFor(async () => (await tmux.listWindows()).some((w) => w.name === c.id && w.command === 'sleep'));
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'PreToolUse', sessionId: 'sess', toolName: 'Bash', ...h } });
    await hook({ name: 'SessionStart' });
    await hook({ name: 'PermissionRequest', agentId: 'a1', message: 'mkdir probe' });
    // the hook lands before the dialog is drawn, so one empty read is not yet the dialog gone
    const screen = vi.spyOn(tmux, 'screen').mockResolvedValue(pane('codex-working'));
    await fleet['poll']['tick']();
    screen.mockResolvedValue(pane('codex-approval'));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', asking: ['a1'] });
    // an Esc dismisses a subagent's dialog with no hook
    screen.mockResolvedValue(pane('codex-working'));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', asking: ['a1'] });
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent?.status).toBe('working');
    expect(store.state.robots[c.id].agent).not.toHaveProperty('asking');
    expect(store.state.robots[c.id].agent).not.toHaveProperty('prompt');
    await hook({ name: 'PermissionRequest', message: 'rm -rf build' });
    screen.mockResolvedValue(pane('codex-approval'));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', askedTool: 'Bash' });
    screen.mockResolvedValue(pane('codex-working'));
    await fleet['poll']['tick']();
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'working', askedTool: 'Bash' });
  });

  it('records shell activity when a SessionEnd hook ends the agent, without waiting for a poll', async () => {
    const { fleet, store } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    store.update((d) => {
      d.robots[c.id].agent = { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'working', lastActivityAt: 1 };
      d.robots[c.id].shell.lastOutputAt = 0;
    });
    // a late end from another session leaves the agent, and the shell, as they were
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionEnd', sessionId: 'old' } });
    expect(store.state.robots[c.id].shell.lastOutputAt).toBe(0);
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionEnd', sessionId: 's' } });
    expect(store.state.robots[c.id].agent).toBeUndefined();
    expect(store.state.robots[c.id].shell.lastOutputAt).toBeGreaterThan(0);
  });

  it('follows an agent that cds into another checkout, and the poll leaves it there', async () => {
    const { fleet, store, home } = await boot();
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, 'repo-')));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    fs.mkdirSync(path.join(repo, 'src'));
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await waitFor(() => store.state.robots[c.id].panePath !== undefined);
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', cwd: path.join(repo, 'src') } });
    await waitFor(() => store.state.robots[c.id].cwd === repo);
    await waitForPolls(fleet, 2);
    expect(store.state.robots[c.id].cwd).toBe(repo);
    // a move within the same checkout keeps the path it has
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', cwd: repo } });
    await new Promise((r) => setTimeout(r, 300));
    expect(store.state.robots[c.id].cwd).toBe(repo);
  });

  it('follows a cd made before the first poll, and keeps /tmp as it was asked for', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const islandId = fleet.createIsland({ name: 'x' }).id;
    const stays = await fleet.createRobot({ islandId, cwd: '/tmp', command: 'sleep 600' });
    const moves = await fleet.createRobot({ islandId, cwd: '/tmp', command: 'cd /usr && sleep 600' });
    await waitFor(async () => (await tmux.listWindows()).filter((w) => w.command === 'sleep').length === 2);
    await fleet['poll']['tick']();
    expect(store.state.robots[stays.id].cwd).toBe('/tmp');
    expect(store.state.robots[moves.id].cwd).toBe('/usr');
  });

  it('keeps a robot where it is while tmux reports no path for its pane, as under sudo', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet['poll']['tick']();
    const cwd = store.state.robots[c.id].cwd;
    expect(cwd).toBeTruthy();
    const list = tmux.listWindows.bind(tmux);
    vi.spyOn(tmux, 'listWindows').mockImplementation(async () => (await list()).map((w) => ({ ...w, path: '' })));
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].cwd).toBe(cwd);
  });

  it('follows a codex agent into the worktree its commands run in, and back once that worktree is gone', async () => {
    const { fleet, store, home } = await boot();
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, 'repo-')));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    execFileSync('git', ['init', '-q', repo]);
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(repo, '.codex', 'worktrees', 'feat');
    git('worktree', 'add', '-q', '-b', 'feat', wt);
    fs.mkdirSync(path.join(wt, 'web'));
    // a pane at a shell prompt loses its agent after two polls; this one must keep it
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: repo, command: 'sleep 600' });
    await waitFor(() => store.state.robots[c.id].panePath !== undefined && store.state.robots[c.id].repo?.root === repo);
    // codex tells its hooks where the session began; only the rollout says where each command ran
    const rollout = path.join(home, 'rollout.jsonl');
    const ran = (cwd: string) => fs.appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', cwd: `file://${cwd}` } } }) + '\n');
    const hook = () => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'PostToolUse', sessionId: '33333333-3333-4333-8333-333333333333', transcriptPath: rollout, cwd: repo } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: '33333333-3333-4333-8333-333333333333', transcriptPath: rollout, cwd: repo } });
    ran(repo);
    ran(path.join(wt, 'web'));
    await hook();
    await waitFor(() => store.state.robots[c.id].repo?.root === wt);
    expect(store.state.robots[c.id]).toMatchObject({ cwd: wt, repo: { branch: 'feat', isWorktree: true, mainRoot: repo } });
    // a command run where the session began, as codex does when a call names no directory, does not take it back
    ran(repo);
    await hook();
    await new Promise((r) => setTimeout(r, 500));
    expect(store.state.robots[c.id].cwd).toBe(wt);
    git('worktree', 'remove', wt);
    await hook();
    await waitFor(() => store.state.robots[c.id].cwd === repo);
  });

  it('stays where its agent is when a claude -p run inside it reports from another checkout', async () => {
    const { fleet, home } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const follow = vi.spyOn(fleet['agentEvents'] as unknown as { followCwd: () => Promise<void> }, 'followCwd').mockResolvedValue();
    const outer = '11111111-1111-4111-8111-111111111111';
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: outer, pid: process.pid } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', sessionId: '22222222-2222-4222-8222-222222222222', pid: process.ppid, cwd: home } });
    expect(follow).not.toHaveBeenCalled();
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', sessionId: outer, pid: process.pid, cwd: home } });
    expect(follow).toHaveBeenCalledWith(c.id, home);
  });

  it('stays where its agent is when a subagent reports from its own worktree', async () => {
    const { fleet, home } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const follow = vi.spyOn(fleet['agentEvents'] as unknown as { followCwd: () => Promise<void> }, 'followCwd').mockResolvedValue();
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', agentId: 'a95af83797c89a762', cwd: home } });
    expect(follow).not.toHaveBeenCalled();
  });

  it('keeps one link sweep in flight, and leaves the robots that moved meanwhile to the next one', async () => {
    const asked: string[] = [];
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const lookupPr = async (cwd: string) => { asked.push(cwd); if (asked.length === 1) await held; return undefined; };
    // the ticks this test drives are the only ones
    const { fleet, store, home } = await boot({ pollMs: 60_000, linkDeps: { lookupPr, originUrl: async () => undefined } });
    const repo = (name: string) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(home, `${name}-`)));
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      return dir;
    };
    const [one, two] = [repo('one'), repo('two')];
    const islandId = fleet.createIsland({ name: 'x' }).id;
    await fleet.createRobot({ islandId, cwd: one });
    const b = await fleet.createRobot({ islandId, cwd: two });

    fleet['poll']['ticks'] = 9;
    await fleet['poll']['tick']();
    await waitFor(() => asked.length === 1);
    expect(asked).toEqual([one]);

    // b moves while that sweep is still out
    store.update((d) => { d.robots[b.id].cwd = '/nope'; d.robots[b.id].panePath = '/nope'; });
    await fleet['poll']['tick']();
    expect(asked).toEqual([one]);

    release();
    await waitFor(() => fleet['poll']['sweeping'] === false);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([one]);

    await fleet['poll']['tick']();
    await waitFor(() => asked.includes(two));
  });

  it('recovers from a tmux server death', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killServer();
    await waitFor(() => store.state.robots[c.id].tmux === undefined && store.state.robots[c.id].revive !== undefined, 10_000);
    store.update((d) => { d.robots[c.id].revive = { command: 'echo alive-again' }; });
    await fleet.reviveRobot(c.id);
    await waitFor(async () => (await fleet.readScreen(c.id, 20)).includes('alive-again'));
  });

  it('drops an agent whose pane returned to a shell without a SessionEnd', async () => {
    const { fleet, store } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    await waitFor(() => store.state.robots[c.id].agent === undefined, 3000);
  });

  it('answers SessionStart with the brief and UserPromptSubmit with a diff once context changed', async () => {
    const { fleet } = await boot();
    const island = fleet.createIsland({ name: 'x', instructions: 'ship small' });
    const c = await fleet.createRobot({ islandId: island.id, cwd: '/tmp' });
    const start = await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath: '/t.jsonl' } });
    expect(start).toContain('Island instructions: ship small');
    expect(fleet.robot(c.id).agent?.brief).toBe(start);
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit' } })).toBeUndefined();
    fleet.updateRobot(c.id, { instructions: 'in Spanish' });
    const diff = await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit' } });
    expect(diff).toContain('+ Robot instructions: in Spanish');
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit' } })).toBeUndefined();
  });

  it('gives a robot its agent profile from its first SessionStart, and the whole new one when it changes', async () => {
    const { fleet, home } = await boot();
    const profiles = resolvePaths(home).agentProfiles;
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', agentProfile: 'reviewer' });
    const start = await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: 's' } });
    expect(start).toContain('Agent profile: reviewer — follow this role.\nYou are an independent code reviewer.');
    fleet.updateRobot(c.id, { agentProfile: 'verifier' });
    const switched = await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'UserPromptSubmit' } });
    expect(switched).toContain('Your agent profile changed; follow this one instead of any before:\nAgent profile: verifier');
    expect(switched).toContain('Report:');
    // an edit to the file reaches the session with its next prompt
    fs.appendFileSync(path.join(profiles, 'verifier.md'), '\nNever trust a green check alone.\n');
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'UserPromptSubmit' } })).toContain('Never trust a green check alone.\n(end of agent profile)');
    // gone from disk, it leaves the brief, and the robot keeps its name for the side card to say so
    fs.rmSync(path.join(profiles, 'verifier.md'));
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'UserPromptSubmit' } })).toContain('Your agent profile was removed');
    expect(fleet.robot(c.id).agentProfile).toBe('verifier');
    expect(() => fleet.updateRobot(c.id, { agentProfile: 'verifier' })).toThrow(/no agent profile verifier/);
    expect(fleet.updateRobot(c.id, { agentProfile: '' }).agentProfile).toBeUndefined();
    await expect(fleet.createRobot({ islandId: 'home', cwd: '/tmp', agentProfile: '../x' })).rejects.toThrow(/no agent profile/);
  });

  it('keeps the brief and its changes for the agent, not for a claude -p run inside it', async () => {
    const { fleet } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x', instructions: 'ship small' }).id, cwd: '/tmp' });
    const outer = '11111111-1111-4111-8111-111111111111';
    const nested = '22222222-2222-4222-8222-222222222222';
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: outer, pid: process.pid } });
    fleet.updateRobot(c.id, { instructions: 'in Spanish' });
    // two live processes: the agent is this test, the nested claude its parent
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: nested, pid: process.ppid } })).toBeUndefined();
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit', sessionId: nested, pid: process.ppid } })).toBeUndefined();
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit', sessionId: outer, pid: process.pid } }))
      .toContain('+ Robot instructions: in Spanish');
  });

  it('says so when a window runs codex and no hook comes from it, until one does', async () => {
    const { fleet, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    // tmux names a pane's command after the binary itself, so the listing is what says this one runs codex
    const list = tmux.listWindows.bind(tmux);
    let running = 'codex';
    tmux.listWindows = async () => (await list()).map((w) => (w.name === c.id ? { ...w, command: running } : w));
    expect(fleet.robot(c.id).hint).toBeUndefined();
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent');
    // back at the shell, there is nothing left to say
    running = 'sh';
    await waitFor(() => fleet.robot(c.id).hint === undefined);
    running = 'codex';
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent');
    // an agent that comes and goes between two polls leaves the silence as it was
    await waitForPolls(fleet, 2);
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: '019eefb3-0000-7b00-ad02-80c4930f7426' } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionEnd', sessionId: '019eefb3-0000-7b00-ad02-80c4930f7426' } });
    expect(fleet.robot(c.id).hint).toBeUndefined();
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent');
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: '019eefb3-8d5c-7b00-ad02-80c4930f7426' } });
    expect(fleet.robot(c.id).hint).toBeUndefined();
    // with an agent on record the silence is over, however long the window keeps running codex
    await waitForPolls(fleet, 4);
    expect(fleet.robot(c.id).hint).toBeUndefined();
  });

  it('does not warn on a fresh Codex welcome screen, but warns once a prompt was submitted', async () => {
    const { fleet, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const list = tmux.listWindows.bind(tmux);
    tmux.listWindows = async () => (await list()).map((w) => w.name === c.id ? { ...w, command: 'codex' } : w);
    let submitted = false;
    tmux.screen = async () => ({ command: 'codex', shown: true, cursor: submitted ? 2 : 1,
      rows: submitted ? ['  >_ OpenAI Codex (v0.166.0)', '› Hello', '› '] : ['  >_ OpenAI Codex (v0.166.0)', '› Ask Codex to do anything'] });
    await waitForPolls(fleet, 5);
    expect(fleet.robot(c.id).hint).toBeUndefined();
    // A warning raised while Codex was still drawing its welcome screen clears once it appears.
    fleet['deps'].store.update((d) => { d.robots[c.id].hint = 'codex-silent'; });
    await waitFor(() => fleet.robot(c.id).hint === undefined);
    submitted = true;
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent');
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: '019eefb3-8d5c-7b00-ad02-80c4930f7426' } });
    expect(fleet.robot(c.id).hint).toBeUndefined();
  });

  it('runs ps for a silent codex once, not while it sits on its welcome screen or once it is hinted', async () => {
    let listed = 0;
    const { fleet, tmux } = await boot({ processes: async () => { listed++; return []; } });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const list = tmux.listWindows.bind(tmux);
    tmux.listWindows = async () => (await list()).map((w) => w.name === c.id ? { ...w, command: 'codex' } : w);
    let submitted = false;
    tmux.screen = async () => ({ command: 'codex', shown: true, cursor: submitted ? 2 : 1,
      rows: submitted ? ['  >_ OpenAI Codex (v0.166.0)', '› Hello', '› '] : ['  >_ OpenAI Codex (v0.166.0)', '› Ask Codex to do anything'] });
    await waitForPolls(fleet, 5);
    expect(listed).toBe(0);
    submitted = true;
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent');
    await waitForPolls(fleet, 5);
    expect(listed).toBe(1);
  });

  it('says when a silent codex runs on the shared server, and not when it runs its own', async () => {
    const { fleet, tmux, procs } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const list = tmux.listWindows.bind(tmux);
    tmux.listWindows = async () => (await list()).map((w) => (w.name === c.id ? { ...w, command: 'codex' } : w));
    const shell = (await list()).find((w) => w.name === c.id)!.panePid;
    procs.push({ pid: 900_001, ppid: shell, pgid: 900_001, args: 'codex' }, { pid: 900_002, ppid: 1, pgid: 900_002, args: '/u/.codex/bin/codex app-server --listen unix:// --managed-daemon' });
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent' && fleet.robot(c.id).codexDaemon === true);
    // quit and started again with its own server: what is left to suspect is the hook
    tmux.listWindows = async () => (await list()).map((w) => (w.name === c.id ? { ...w, command: 'sh' } : w));
    await waitFor(() => fleet.robot(c.id).hint === undefined && fleet.robot(c.id).codexDaemon === undefined);
    procs[0].args = 'codex --no-daemon';
    tmux.listWindows = async () => (await list()).map((w) => (w.name === c.id ? { ...w, command: 'codex' } : w));
    await waitFor(() => fleet.robot(c.id).hint === 'codex-silent');
    expect(fleet.robot(c.id).codexDaemon).toBeUndefined();
  });

  it('drops hooks from codex\'s shared server and the runs its sessions start, whose terminal they do not name', async () => {
    const { fleet, procs } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    // the server and a claude -p run under it, as ps lists them
    const server = 900_001;
    const nested = 900_002;
    procs.push({ pid: server, ppid: 1, pgid: server, args: '/u/.codex/bin/codex app-server --listen unix:// --managed-daemon' }, { pid: nested, ppid: server, pgid: nested, args: 'claude -p' });
    // the server started from this terminal, so the sessions of every terminal on it report as this one
    for (const sessionId of ['019eefb3-8d5c-7b00-ad02-80c4930f7426', '019eefb3-9999-7b00-ad02-80c4930f7426']) {
      for (const name of ['SessionStart', 'UserPromptSubmit'] as const) {
        expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name, sessionId, pid: server } })).toBeUndefined();
      }
    }
    // as does a claude -p one of those sessions runs
    expect(await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d', pid: nested } })).toBeUndefined();
    expect(fleet.robot(c.id).agent).toBeUndefined();
    // a codex that runs its own server is heard
    const own = '019eefb3-1111-7b00-ad02-80c4930f7426';
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: own, pid: process.pid } });
    expect(fleet.robot(c.id).agent).toMatchObject({ kind: 'codex', sessionId: own, pid: process.pid });
  });

  it('lets go of an agent the shared server held, whose end would be dropped', async () => {
    const { fleet, store, procs } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const server = 900_001;
    procs.push({ pid: server, ppid: 1, pgid: server, args: '/u/.codex/bin/codex app-server --listen unix:// --managed-daemon' });
    // what a build that took the server's events left on record
    store.update((d) => { d.robots[c.id].agent = { kind: 'codex', sessionId: '019eefb3-8d5c-7b00-ad02-80c4930f7426', status: 'working', lastActivityAt: Date.now(), pid: server }; });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'Stop', sessionId: '019eefb3-8d5c-7b00-ad02-80c4930f7426', pid: server } });
    expect(fleet.robot(c.id).agent).toBeUndefined();
  });

  it('keeps the agent a dormant terminal resumes when an event from the shared server names it', async () => {
    const { fleet, store } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const server = spawn('sleep', ['60'], { argv0: '/u/.codex/bin/codex app-server --listen unix:// --managed-daemon', stdio: 'ignore' });
    cleanup.push(async () => { server.kill(); });
    await waitFor(() => /codex app-server/.test(execFileSync('ps', ['-o', 'args=', '-p', String(server.pid)], { encoding: 'utf8' })));
    const sessionId = '019eefb3-8d5c-7b00-ad02-80c4930f7426';
    const agent = () => ({ kind: 'codex' as const, sessionId, status: 'idle' as const, lastActivityAt: Date.now(), pid: server.pid });
    store.update((d) => {
      const held = d.robots[c.id];
      held.agent = agent();
      held.second = { cwd: '/tmp', unread: false, agent: agent() };
      markDormant(held);
      markSlotDormant(held.second);
    });
    const stop = (term?: 2) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'Stop', sessionId, pid: server.pid, ...(term && { term }) } });
    stop();
    stop(2);
    expect(fleet.robot(c.id).agent?.sessionId).toBe(sessionId);
    expect(fleet.robot(c.id).second?.agent?.sessionId).toBe(sessionId);
  });

  it('keeps a codex agent, and says nothing of silence, through a claude -p run inside it', async () => {
    const { fleet, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const list = tmux.listWindows.bind(tmux);
    tmux.listWindows = async () => (await list()).map((w) => (w.name === c.id ? { ...w, command: 'codex' } : w));
    const outer = '019eefb3-8d5c-7b00-ad02-80c4930f7426';
    const nested = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
    // two live processes: codex is this test, the nested claude its parent
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: outer, pid: process.pid } });
    for (const name of ['SessionStart', 'Stop', 'SessionEnd'] as const) {
      await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name, sessionId: nested, pid: process.ppid } });
    }
    await waitForPolls(fleet, 4);
    expect(fleet.robot(c.id)).toMatchObject({ agent: { kind: 'codex', sessionId: outer, status: 'idle' }, unread: false });
    expect(fleet.robot(c.id).hint).toBeUndefined();
  });

  it('reads a codex robot context gauge and its turns off the rollout', async () => {
    const { fleet, home } = await boot();
    const rollout = path.join(home, 'rollout.jsonl');
    fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/rollout.jsonl'), rollout);
    const SID = '019eefb3-8d5c-7b00-ad02-80c4930f7426';
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'SessionStart', sessionId: SID } });
    expect(fleet.robot(c.id).agent?.contextPct).toBeUndefined();
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', name: 'Stop', sessionId: SID, transcriptPath: rollout } });
    expect(fleet.robot(c.id).agent).toMatchObject({ kind: 'codex', contextPct: 19, status: 'done' });
    expect(fleet.readTranscript(c.id, 5)).toContain('AGENT: [tool: shell] Here are the ideas.');
    expect(fleet.readPrompts(c.id, 5)).toEqual(['recommend me any features to add']);
  });

  it('leads the prompts with the one just submitted, before the transcript catches up', async () => {
    const { fleet, home } = await boot();
    const transcriptPath = `${home}/prompts.jsonl`;
    const entry = (promptId: string, content: string) =>
      JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptId, timestamp: new Date().toISOString(), message: { content } }) + '\n';
    fs.writeFileSync(transcriptPath, entry('p1', 'plant the flag'));
    const c = await fleet.createRobot({ islandId: 'home', cwd: '/tmp' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath } });
    expect(fleet.readPrompts(c.id, 10)).toEqual(['plant the flag']);

    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit', prompt: { id: 'p2', text: 'raise the sail' } } });
    expect(fleet.readPrompts(c.id, 10)).toEqual(['raise the sail', 'plant the flag']);
    fs.appendFileSync(transcriptPath, entry('p2', 'raise the sail'));
    expect(fleet.readPrompts(c.id, 10)).toEqual(['raise the sail', 'plant the flag']);
  });
});
