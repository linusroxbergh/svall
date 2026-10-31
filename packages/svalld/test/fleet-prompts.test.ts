import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind, Robot } from '@svall/protocol';
import { readComposer } from '../src/agent/composer.js';
import { markDormant, RESUME_NOTE } from '../src/dormancy.js';
import { Dormant, Invalid } from '../src/errors.js';
import type { Fleet } from '../src/fleet.js';
import type { HookEvent } from '../src/hooks/receiver.js';
import type { Tmux } from '../src/tmux/tmux.js';
import { boot, cleanup, OSID, pane, stopFleets } from './fleet-boot.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

// a window svalld kills once its robot is dormant is ending until it closes, so no poll takes it back meanwhile
async function endWindow({ fleet, tmux }: { fleet: Fleet; tmux: Tmux }, id: string, windowId: string): Promise<void> {
  const ended = tmux.killWindow(windowId);
  fleet['ending'].set(id, ended);
  await ended;
  fleet['ending'].delete(id);
}

runIf('Fleet prompts', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('marks the agent working when a prompt is submitted', async () => {
    // no poll runs: the pane sits at a shell prompt, where a poll drops the agent
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    vi.spyOn(tmux, 'screen').mockResolvedValue(pane('claude-empty'));
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Stop' } });
    await fleet.run(c.id, 'x', true);
    expect(store.state.robots[c.id].agent?.status).toBe('working');
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Stop' } });
    await fleet.run(c.id, 'y', false);
    expect(store.state.robots[c.id].agent?.status).toBe('done');
  });

  it("tags a robot's message with its sender, refuses one to itself, and never types one into a plain shell", async () => {
    const { fleet, tmux } = await boot({ pollMs: 60_000 });
    const island = fleet.createIsland({ name: 'x' }).id;
    const lead = await fleet.createRobot({ islandId: island, cwd: '/tmp', name: 'lead' });
    const c = await fleet.createRobot({ islandId: island, cwd: '/tmp' });
    const message = fleet.message(c.id, lead.id, 'hi\nrm -rf build');
    expect(message).toBe(`[from robot lead (${lead.id}); reply with svall robot send ${lead.id}]\nhi\nrm -rf build`);
    expect(() => fleet.message(c.id, c.id, 'hi')).toThrow('a robot cannot message itself');
    const typed = vi.spyOn(tmux, 'sendLine');
    await expect(fleet.run(c.id, message, true)).rejects.toThrow(`${c.name} runs no agent; svall robot run types into its terminal`);
    expect(typed).not.toHaveBeenCalled();
    // an agent that has not reported in yet, as a Codex or OpenCode before its first prompt, takes it
    vi.spyOn(tmux, 'screen').mockResolvedValue(pane('codex-empty'));
    expect(await fleet.run(c.id, message, true)).toBe('delivered');
    expect(typed).toHaveBeenCalledWith(c.tmux!.paneId, message, true);
  });

  it("reads the agent's last answer in full, or says why there is none", async () => {
    const { fleet, store, home } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    expect(() => fleet.readLast(c.id)).toThrow(`${c.name} has no agent`);
    const line = (o: unknown) => JSON.stringify(o) + '\n';
    const transcriptPath = path.join(home, 'session.jsonl');
    const answer = 'x'.repeat(3000);
    fs.writeFileSync(transcriptPath, line({ type: 'user', origin: { kind: 'human' }, message: { content: 'go' } }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }));
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath } });
    const agent = (patch: (a: NonNullable<Robot['agent']>) => void) => store.update((d) => { patch(d.robots[c.id].agent!); });
    expect(fleet.readLast(c.id)).toBe(answer);
    agent((a) => { a.status = 'working'; });
    expect(fleet.readLast(c.id)).toBe(`[${c.name} is still working]`);
    agent((a) => { a.background = true; });
    expect(fleet.readLast(c.id)).toBe(answer);
    agent((a) => { a.status = 'blocked'; delete a.background; a.prompt = 'Bash: rm -rf build'; });
    expect(fleet.readLast(c.id)).toBe(`[${c.name} is waiting on an answer: Bash: rm -rf build]`);
    // an error ends the turn past what it said on its way, which OpenCode's log holds without the error
    agent((a) => { a.status = 'done'; a.prompt = 'API Error: 500'; });
    expect(fleet.readLast(c.id)).toBe('[its last turn ended on an error: API Error: 500]');
    fs.appendFileSync(transcriptPath, line({ type: 'user', origin: { kind: 'human' }, message: { content: 'again' } }));
    agent((a) => { a.status = 'idle'; delete a.prompt; });
    expect(fleet.readLast(c.id)).toBe('[no final message: its last turn was interrupted or ended after a tool call, or it has not had one]');
    expect(() => fleet.readLast(c.id, 2)).toThrow(`${c.name} has no agent in its second terminal`);
  });

  it('keeps a hook-driven status over the optimistic working', async () => {
    // no poll runs: the pane sits at a shell prompt, where a poll drops the agent
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    vi.spyOn(tmux, 'screen').mockResolvedValue(pane('claude-empty'));
    tmux.sendLine = async () => {
      store.update((d) => { d.robots[c.id].agent!.status = 'blocked'; });
    };
    await fleet.run(c.id, 'block', true);
    expect(store.state.robots[c.id].agent?.status).toBe('blocked');
    expect(store.state.robots[c.id].unread).toBe(false);
  });

  it('keeps the unread a Stop set while the prompt was still being sent', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    vi.spyOn(tmux, 'screen').mockResolvedValue(pane('claude-empty'));
    let sent!: () => void;
    let sending!: () => void;
    const typing = new Promise<void>((r) => { sending = r; });
    vi.spyOn(tmux, 'sendLine').mockImplementation(() => { sending(); return new Promise((r) => { sent = r; }); });
    const run = fleet.run(c.id, 'go', true);
    await typing;
    // the agent takes the prompt and finishes the turn before the send returns
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'UserPromptSubmit' } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Stop' } });
    sent();
    await run;
    expect(store.state.robots[c.id]).toMatchObject({ agent: { status: 'done' }, unread: true });
  });

  it('keeps the end of a turn that began and ended while the prompt was still being sent', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const hook = (name: HookEvent['name']) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name, sessionId: 'sess', transcriptPath: '/nope' } });
    await hook('SessionStart');
    await hook('Stop');
    vi.spyOn(tmux, 'screen').mockResolvedValue(pane('claude-empty'));
    // a fast agent: the turn ends before the Enter's paste returns, leaving the status it had before
    vi.spyOn(tmux, 'sendLine').mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); hook('UserPromptSubmit'); hook('Stop'); });
    await fleet.run(c.id, 'quick', true);
    expect(store.state.robots[c.id].agent?.status).toBe('done');
  });

  it('leaves a question that came up while the line was sent', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Notification', sessionId: 'sess', ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    vi.spyOn(tmux, 'screen').mockResolvedValue(pane('claude-empty'));
    tmux.sendLine = async () => { hook({ notificationType: 'permission_prompt', message: 'and may I' }); };
    await fleet.run(c.id, 'no', true);
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', prompt: 'and may I' });
  });

  describe('a prompt run into an agent', () => {
    // the fixtures each CLI's panes were captured into
    const SCREENS = { claude: 'claude', codex: 'codex', opencode: 'oc' } as const;
    const DIALOG = { claude: 'claude-permission', codex: 'codex-approval', opencode: 'oc-permission' } as const;
    const kinds = Object.keys(SCREENS) as AgentKind[];

    // an agent of `kind` on a pane whose screen the test sets, and what reaches the pane
    async function agentPane(kind: AgentKind) {
      const b = await boot({ pollMs: 60_000 });
      const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
      const hook = (h: Partial<HookEvent>) => b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: kind, name: 'Notification', sessionId: 'sess', ...h } });
      await hook({ name: 'SessionStart', transcriptPath: '/nope' });
      const screen = vi.spyOn(b.tmux, 'screen').mockResolvedValue(pane(`${SCREENS[kind]}-empty${kind === 'opencode' ? '-session' : ''}`));
      const typed: string[] = [];
      vi.spyOn(b.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
      return { ...b, c, hook, screen, typed };
    }

    it.each(kinds)('is refused while %s waits on an answer', async (kind) => {
      const { fleet, c, hook, screen, typed } = await agentPane(kind);
      screen.mockResolvedValue(pane(DIALOG[kind]));
      if (kind === 'claude') await hook({ notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
      else await hook({ name: 'PermissionRequest', toolName: 'shell' });
      await expect(fleet.run(c.id, '1', true)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining(`${c.name} is waiting on an answer`) });
      expect(typed).toEqual([]);
    });

    it('is refused in the seconds Claude Code shows its dialog before it notifies of it', async () => {
      const { fleet, c, hook, screen, typed } = await agentPane('claude');
      await hook({ name: 'PermissionRequest', toolName: 'Bash' });
      screen.mockResolvedValue(pane('claude-permission'));
      // Svall has no question to answer yet, so the terminal is where it is answered
      await expect(fleet.run(c.id, 'go', true)).rejects.toMatchObject({ code: 'blocked', message: `${c.name} is waiting on an answer (Bash); answer it in its terminal, then send again` });
      // approved, the tool runs on with its prompt line back in view
      screen.mockResolvedValue(pane('claude-working'));
      expect(await fleet.run(c.id, 'go', true)).toBe('delivered');
      expect(typed).toEqual(['go']);
    });

    it.each(kinds)("is held while %s's prompt line has a draft, and goes in once it is cleared", async (kind) => {
      const { fleet, c, hook, screen, typed } = await agentPane(kind);
      screen.mockResolvedValue(pane(`${SCREENS[kind]}-draft`));
      expect(await fleet.run(c.id, 'first', true)).toBe('queued');
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual([]);
      screen.mockResolvedValue(pane(`${SCREENS[kind]}-empty${kind === 'opencode' ? '-session' : ''}`));
      // one sent while another is held goes in after it, once the turn of the one before is over
      expect(await fleet.run(c.id, 'second', true)).toBe('queued');
      await waitFor(() => typed.length === 1);
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual(['first']);
      await hook({ name: 'Stop' });
      await waitFor(() => typed.length === 2);
      expect(typed).toEqual(['first', 'second']);
    });

    it.each(kinds)('goes in at once while %s works, as the agent queues it itself', async (kind) => {
      const { fleet, store, c, hook, screen, typed } = await agentPane(kind);
      await hook({ name: 'UserPromptSubmit' });
      screen.mockResolvedValue(pane(`${SCREENS[kind]}-working`));
      expect(store.state.robots[c.id].agent?.status).toBe('working');
      expect(await fleet.run(c.id, 'also this', true)).toBe('delivered');
      expect(typed).toEqual(['also this']);
    });

    it('keeps a wait from taking the end of the turn before a held prompt for its own', async () => {
      const { fleet, c, hook, screen, typed } = await agentPane('claude');
      await hook({ name: 'Stop' });
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      let status: string | undefined;
      const waited = fleet.waitFor(c.id, ['done', 'blocked'], 10_000).then((s) => { status = s; });
      screen.mockResolvedValue(pane('claude-empty'));
      await waitFor(() => typed.length === 1);
      expect(status).toBeUndefined();
      await hook({ name: 'Stop' });
      await waited;
      expect(status).toBe('done');
    });

    it('lets a wait see a question asked while a prompt is held', async () => {
      const { fleet, c, hook, screen } = await agentPane('claude');
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      await hook({ notificationType: 'permission_prompt' });
      expect(await fleet.waitFor(c.id, ['done', 'blocked'], 1000)).toBe('blocked');
    });

    it('is held under a dialog the agent did not report, as a Codex question', async () => {
      const { fleet, c, screen, typed } = await agentPane('codex');
      screen.mockResolvedValue(pane('codex-question'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      screen.mockResolvedValue(pane('codex-empty'));
      await waitFor(() => typed.length === 1);
    });

    it("is held while a shell has the pane, as before the agent is up, though the shell's prompt looks like the agent's", async () => {
      const { fleet, tmux, c, screen, typed } = await agentPane('claude');
      screen.mockRestore();
      await tmux.run('send-keys', '-t', c.tmux!.paneId, "PS1='❯ '", 'Enter');
      await waitFor(async () => readComposer('claude', await tmux.screen(c.tmux!.paneId)) === 'empty');
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      expect(typed).toEqual([]);
    });

    it('is dropped with its robot', async () => {
      const { fleet, c, screen, typed } = await agentPane('claude');
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      await fleet.closeRobot(c.id);
      screen.mockResolvedValue(pane('claude-empty'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual([]);
    });

    it('is dropped when the fleet stops', async () => {
      const { fleet, c, screen, typed } = await agentPane('claude');
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      await fleet.stop();
      screen.mockResolvedValue(pane('claude-empty'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual([]);
    });

    it("is dropped when the agent's session ends, not typed into the next one", async () => {
      const { fleet, c, hook, screen, typed } = await agentPane('claude');
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      await hook({ name: 'SessionEnd' });
      await hook({ name: 'SessionStart', sessionId: 'other', transcriptPath: '/nope' });
      screen.mockResolvedValue(pane('claude-empty'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual([]);
    });

    it('is dropped when the second terminal it waits on closes, not typed into the next one', async () => {
      const { fleet, store, tmux, c, screen, typed } = await agentPane('claude');
      const second = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', term: 2, name: 'SessionStart', sessionId: 's2', transcriptPath: '/nope', ...h } });
      await fleet.openSecond(c.id);
      await second({});
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true, 2)).toBe('queued');
      await tmux.killWindow(store.state.robots[c.id].second!.tmux!.windowId);
      await waitFor(() => !store.state.robots[c.id].second?.tmux);
      await fleet.openSecond(c.id);
      await second({ backend: 'codex', sessionId: 's3' });
      screen.mockResolvedValue(pane('codex-empty'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual([]);
    });

    it("waits out the user's own turn, so a wait takes the end of the held prompt's turn", async () => {
      const { fleet, c, hook, screen, typed } = await agentPane('codex');
      await hook({ name: 'Stop' });
      screen.mockResolvedValue(pane('codex-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      let status: string | undefined;
      const waited = fleet.waitFor(c.id, ['done'], 10_000).then((s) => { status = s; });
      // the user sends their draft, and the agent works on it with its prompt line empty
      await hook({ name: 'UserPromptSubmit' });
      screen.mockResolvedValue(pane('codex-working'));
      await new Promise((r) => setTimeout(r, 1200));
      expect(typed).toEqual([]);
      await hook({ name: 'Stop' });
      screen.mockResolvedValue(pane('codex-empty'));
      await waitFor(() => typed.length === 1);
      expect(status).toBeUndefined();
      await hook({ name: 'Stop' });
      await waited;
      expect(status).toBe('done');
    });

    it('wakes a wait once the held prompts are in, though the agent did not change', async () => {
      const { fleet, c, hook, screen, typed } = await agentPane('claude');
      await hook({ name: 'Stop' });
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'note', false)).toBe('queued');
      const waited = fleet.waitFor(c.id, ['done'], 3000);
      screen.mockResolvedValue(pane('claude-empty'));
      await waitFor(() => typed.length === 1);
      expect(await waited).toBe('done');
    });

    it('is refused when the agent asks while its screen is read', async () => {
      const { fleet, c, hook, screen, typed } = await agentPane('claude');
      let shown: (() => void) | undefined;
      screen.mockImplementation(() => new Promise((r) => { shown = () => r(pane('claude-empty')); }));
      const run = fleet.run(c.id, 'go', true);
      await waitFor(() => shown !== undefined);
      await hook({ notificationType: 'permission_prompt', message: 'may I' });
      shown!();
      await expect(run).rejects.toMatchObject({ code: 'blocked' });
      expect(typed).toEqual([]);
    });

    it('says queued when a dormant agent wakes onto its window with a draft there', async () => {
      const { fleet, store, c, screen, typed } = await agentPane('claude');
      screen.mockResolvedValue(pane('claude-draft'));
      store.update((d) => { delete d.robots[c.id].tmux; d.robots[c.id].revive = { command: 'claude --resume sess' }; });
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      expect(typed).toEqual([]);
    });

    it('holds what follows text typed with no Enter until that text is sent or cleared', async () => {
      const { fleet, c, screen, typed } = await agentPane('claude');
      expect(await fleet.run(c.id, 'staged', false)).toBe('delivered');
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'next', true)).toBe('queued');
      expect(typed).toEqual(['staged']);
    });
  });

  describe('a prompt run into an agent that has not reported in', () => {
    // a pane with no agent on record, whose screen the test sets, and what reaches the pane
    async function silentPane() {
      const b = await boot({ pollMs: 60_000 });
      const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
      const hook = (h: Partial<HookEvent>) => b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope', ...h } });
      const screen = vi.spyOn(b.tmux, 'screen');
      const typed: string[] = [];
      vi.spyOn(b.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
      return { ...b, c, hook, screen, typed };
    }

    it.each([['claude', 'claude-trust', 'claude-empty'], ['codex', 'codex-hooks-review', 'codex-empty']])(
      'is held while %s starts on a dialog, and goes in once its prompt line is free', async (_kind, dialog, empty) => {
        const { fleet, c, screen, typed } = await silentPane();
        screen.mockResolvedValue(pane(dialog));
        expect(await fleet.run(c.id, 'go', true)).toBe('queued');
        await new Promise((r) => setTimeout(r, 1200));
        expect(typed).toEqual([]);
        screen.mockResolvedValue(pane(empty));
        await waitFor(() => typed.length === 1);
        expect(typed).toEqual(['go']);
      });

    it('is held behind a draft, and goes to the session that reports in', async () => {
      const { fleet, store, c, hook, screen, typed } = await silentPane();
      screen.mockResolvedValue(pane('claude-draft'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      await hook({});
      screen.mockResolvedValue(pane('claude-empty'));
      await waitFor(() => typed.length === 1);
      expect(store.state.robots[c.id].agent).toMatchObject({ sessionId: 'sess', status: 'working' });
    });

    it('is dropped, not typed into the shell, when the agent exits before it is free', async () => {
      const { fleet, c, screen, typed } = await silentPane();
      screen.mockResolvedValue(pane('claude-trust'));
      expect(await fleet.run(c.id, 'go', true)).toBe('queued');
      screen.mockRestore();
      await new Promise((r) => setTimeout(r, 1200));
      expect(fleet['prompts'].holds(c.id)).toBe(false);
      expect(typed).toEqual([]);
    });

    it('goes in at once to a shell, or to a program other than an agent', async () => {
      const { fleet, c, screen, typed } = await silentPane();
      expect(await fleet.run(c.id, 'ls', true)).toBe('delivered');
      screen.mockResolvedValue({ ...pane('claude-trust'), command: 'vim' });
      expect(await fleet.run(c.id, ':q', true)).toBe('delivered');
      expect(typed).toEqual(['ls', ':q']);
    });
  });

  it('answers a blocked agent with Enter to approve and Escape to deny', async () => {
    const { fleet, store, tmux } = await boot();
    // an agent's pane runs something other than a shell, or the poll ends the agent
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    const sent = vi.spyOn(tmux, 'sendBytes');
    const block = () => store.update((d) => { d.robots[c.id].agent!.status = 'blocked'; });
    block();
    await fleet.answerPrompt(c.id, 'approve');
    expect(store.state.robots[c.id].agent!.status).toBe('working');
    await expect(fleet.answerPrompt(c.id, 'approve')).rejects.toThrow('not waiting');
    block();
    await fleet.answerPrompt(c.id, 'deny');
    // Esc ends the turn, and no hook says so
    expect(store.state.robots[c.id].agent!.status).toBe('idle');
    expect(sent.mock.calls.map(([paneId, bytes]) => [paneId, bytes.toString('utf8')]))
      .toEqual([[c.tmux!.paneId, '\r'], [c.tmux!.paneId, '\x1b']]);
  });

  it('answers only the question the answer was shown with, and leaves the agent blocked when the key does not reach it', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Notification', sessionId: 'sess', ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    await hook({ notificationType: 'permission_prompt', message: 'may I' });
    const first = store.state.robots[c.id].agent!.promptId!;
    await hook({ notificationType: 'permission_prompt', message: 'and may I' });
    const second = store.state.robots[c.id].agent!.promptId!;
    expect(second).not.toBe(first);
    const sent = vi.spyOn(tmux, 'sendBytes');
    await expect(fleet.answerPrompt(c.id, 'approve', first)).rejects.toThrow('moved on');
    expect(sent).not.toHaveBeenCalled();

    sent.mockRejectedValueOnce(new Error('pane gone'));
    await expect(fleet.answerPrompt(c.id, 'approve', second)).rejects.toThrow('pane gone');
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', prompt: 'and may I', promptId: second });

    // a second answer while the first is still being typed is refused rather than typed too
    let typed = () => {};
    sent.mockImplementationOnce(() => new Promise((r) => { typed = r; }));
    const answering = fleet.answerPrompt(c.id, 'approve', second);
    await expect(fleet.answerPrompt(c.id, 'deny', second)).rejects.toThrow('already in');
    typed();
    await answering;
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'working' });
    expect(store.state.robots[c.id].agent?.promptId).toBeUndefined();
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('keeps a Claude question dialog blocked across its steps: Enter moves it to a question of its own id, until its tool runs', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    const hook = (h: Partial<HookEvent> & Pick<HookEvent, 'name'>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', sessionId: 'sess', ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    await hook({ name: 'PermissionRequest', toolName: 'AskUserQuestion' });
    await hook({ name: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission' });
    const first = store.state.robots[c.id].agent!.promptId!;
    const sent = vi.spyOn(tmux, 'sendBytes');
    // question 1 of 2 answered: the dialog shows question 2, and no hook says so
    await fleet.answerPrompt(c.id, 'approve', first);
    const next = store.state.robots[c.id].agent!;
    expect(next).toMatchObject({ status: 'blocked', askedTool: 'AskUserQuestion' });
    expect(next.promptId).toBeDefined();
    expect(next.promptId).not.toBe(first);
    // the submit step, then the tool's run ends the dialog
    await fleet.answerPrompt(c.id, 'approve', next.promptId);
    expect(store.state.robots[c.id].agent!.status).toBe('blocked');
    await hook({ name: 'PostToolUse', toolName: 'AskUserQuestion' });
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'working' });
    expect(store.state.robots[c.id].agent?.promptId).toBeUndefined();
    expect(sent).toHaveBeenCalledTimes(2);
    // Esc cancels the whole dialog
    await hook({ name: 'PermissionRequest', toolName: 'AskUserQuestion' });
    await hook({ name: 'Notification', notificationType: 'permission_prompt' });
    await fleet.answerPrompt(c.id, 'deny');
    expect(store.state.robots[c.id].agent!.status).toBe('idle');
  });

  it('lets a hook that moved the agent on while the answer was typed stand', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Notification', sessionId: 'sess', ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    await hook({ notificationType: 'permission_prompt' });
    let typed = () => {};
    vi.spyOn(tmux, 'sendBytes').mockImplementationOnce(() => new Promise((r) => { typed = r; }));
    const answering = fleet.answerPrompt(c.id, 'approve');
    await hook({ notificationType: 'permission_prompt', message: 'the next one' });
    typed();
    await answering;
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', prompt: 'the next one' });
  });

  it('leaves an OpenCode card blocked until its plugin reports the answer, and takes one answer per question', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'opencode', name: 'PermissionRequest', sessionId: OSID, ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    await hook({ message: 'rm -rf build' });
    const sent = vi.spyOn(tmux, 'sendBytes');
    // Esc on a subagent's question asks for a reason before it turns the question down
    await fleet.answerPrompt(c.id, 'deny');
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'blocked', prompt: 'rm -rf build' });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(fleet.answerPrompt(c.id, 'deny')).rejects.toThrow('already in');
    await hook({ message: 'which file?' });
    await fleet.answerPrompt(c.id, 'approve');
    await expect(fleet.answerPrompt(c.id, 'approve')).rejects.toThrow('already in');
    // Enter on a question of several parts moves on to the next, which takes an answer of its own
    await new Promise((r) => setTimeout(r, 1100));
    await fleet.answerPrompt(c.id, 'approve');
    await hook({ name: 'PreToolUse' });
    expect(store.state.robots[c.id].agent!.status).toBe('working');
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it('keeps an agent with background agents out working when its question is denied', async () => {
    const { fleet, store } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    const hook = (h: Partial<HookEvent>) => fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Notification', sessionId: 'sess', ...h } });
    await hook({ name: 'SessionStart', transcriptPath: '/nope' });
    await hook({ name: 'Stop', backgroundTasks: 1, backgroundAgents: 1 });
    await hook({ notificationType: 'worker_permission_prompt' });
    await fleet.answerPrompt(c.id, 'deny');
    expect(store.state.robots[c.id].agent).toMatchObject({ status: 'working', background: true });
  });

  it('reports the prompt unsent when the window dies while the run waits', async () => {
    const { fleet, store, tmux, home } = await boot({ runTimeoutMs: 5000 });
    const ran = `${home}/ran`;
    const created = fleet.createRobot({ islandId: 'home', cwd: '/tmp', command: `touch ${ran}`, run: 'hello' });
    // the marker appears only once the start command has run, so the window is idle when it dies
    await waitFor(() => fs.existsSync(ran));
    const id = Object.keys(store.state.robots)[0];
    await tmux.killWindow(store.state.robots[id].tmux!.windowId);
    const c = await created;
    expect(c.runSent).toBe(false);
    expect(c.tmux).toBeUndefined();
  });

  it('reports the prompt unsent when the send fails after the agent attached', async () => {
    // no poll runs: the pane sits at a shell prompt, where a poll drops the agent
    const { fleet, store, home } = await boot({ runTimeoutMs: 5000, pollMs: 60_000 });
    const transcriptPath = `${home}/t.jsonl`;
    fs.writeFileSync(transcriptPath, '');
    const created = fleet.createRobot({ islandId: 'home', cwd: '/tmp', command: 'true', run: 'hello' });
    await waitFor(() => Object.keys(store.state.robots).length === 1);
    const id = Object.keys(store.state.robots)[0];
    vi.spyOn(fleet, 'run').mockRejectedValue(new Dormant(`robot ${id} has no window`));
    await fleet.onSocketEvent({ hook: { robotId: id, backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath } });
    const c = await created;
    expect(c.runSent).toBe(false);
    expect(c.agent).toBeDefined();
  });

  it('run needs a command, and reports in the log when no agent ever attached', async () => {
    const logged: string[] = [];
    const { fleet } = await boot({ runTimeoutMs: 300, log: { info() {}, error: (m) => logged.push(m) } });
    await expect(fleet.createRobot({ islandId: 'home', cwd: '/tmp', run: 'hello' })).rejects.toBeInstanceOf(Invalid);
    const c = await fleet.createRobot({ islandId: 'home', cwd: '/tmp', command: 'echo started', run: 'hello' });
    expect(c.runSent).toBe(false);
    expect(c.tmux).toBeDefined();
    expect(logged).toContain(`robot ${c.id}: no agent reported in within 300ms, prompt not sent`);
    await waitFor(async () => (await fleet.readScreen(c.id, 20)).includes('started'));
    expect(await fleet.readScreen(c.id, 20)).not.toContain('hello');
  });

  it('hands claude its prompt as an argument rather than typing it into a booting composer', async () => {
    const bin = makeHome();
    // a stand-in claude that keeps its arguments and never reports in; the prompt is renamed into `got`, so it appears whole
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s " "$1" "$2" "$3" > "$SVALL_HOME/argv"\nfor a; do last=$a; done\nprintf "%s" "$last" > "$SVALL_HOME/got.part"\nmv "$SVALL_HOME/got.part" "$SVALL_HOME/got"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const { fleet, home } = await boot({ runTimeoutMs: 300 });
    const run = vi.spyOn(fleet, 'run');
    // past the 1024 bytes a line typed before the shell reads it may hold, and a shell and an option in its way
    const prompt = `-it's "$HOME" \`x\`\n${'y'.repeat(3000)}`;
    const c = await fleet.createRobot({ islandId: 'home', cwd: '/tmp', command: 'claude --model sonnet', run: prompt });
    expect(c.runSent).toBe(true);
    await waitFor(() => fs.existsSync(`${home}/got`));
    expect(fs.readFileSync(`${home}/argv`, 'utf8')).toBe('--model sonnet -- ');
    expect(fs.readFileSync(`${home}/got`, 'utf8')).toBe(prompt);
    expect(fs.existsSync(`${home}/${c.id}.prompt`)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('hands codex its first prompt as an argument and follows its hooks', async () => {
    // the fake codex, for this test's own tmux server and the shell in its pane
    vi.stubEnv('PATH', `${path.join(import.meta.dirname, 'fixtures/bin')}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const b = await boot();
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'codex' }).id, cwd: '/tmp', command: 'codex', run: 'fix the flaky test' });
    expect(c.runSent).toBe(true);
    await waitFor(() => b.store.state.robots[c.id].agent?.status === 'done');
    expect(b.store.state.robots[c.id].agent).toMatchObject({ kind: 'codex', model: 'gpt-fake' });
    expect(b.fleet.readPrompts(c.id, 5)).toEqual(['fix the flaky test']);
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'fake-codex', `${c.id}.argv`), 'utf8'))).toEqual(['--no-daemon', '-c', 'check_for_update_on_startup=false', '--', 'fix the flaky test']);
  });

  it('hands opencode its first prompt with --prompt and follows its plugin', async () => {
    vi.stubEnv('PATH', `${path.join(import.meta.dirname, 'fixtures/bin')}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const b = await boot();
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'opencode' }).id, cwd: '/tmp', command: 'opencode', run: 'fix the flaky test' });
    expect(c.runSent).toBe(true);
    await waitFor(() => b.store.state.robots[c.id].agent?.status === 'done');
    const agent = b.store.state.robots[c.id].agent!;
    expect(agent).toMatchObject({ kind: 'opencode', sessionId: OSID, contextPct: 10, model: 'big-pickle' });
    expect(b.fleet.readPrompts(c.id, 5)).toEqual(['fix the flaky test']);
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'fake-opencode', `${c.id}.argv`), 'utf8'))).toEqual(['--standalone', '--prompt', 'fix the flaky test']);
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'fake-opencode', `${c.id}.system`), 'utf8'))).toEqual([agent.brief]);
  });

  it('drops an opencode agent once its pane is back at a shell', async () => {
    vi.stubEnv('PATH', `${path.join(import.meta.dirname, 'fixtures/bin')}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const b = await boot({ pollMs: 100 });
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'opencode' }).id, cwd: '/tmp', command: 'opencode', run: 'first' });
    await waitFor(() => b.store.state.robots[c.id].agent?.status === 'done');
    await b.tmux.run('send-keys', '-t', c.tmux!.paneId, 'C-d');
    await waitFor(() => b.store.state.robots[c.id].agent === undefined, 10_000);
  });

  it('wakes a dormant opencode robot with a prompt its plugin submits', async () => {
    vi.stubEnv('PATH', `${path.join(import.meta.dirname, 'fixtures/bin')}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const b = await boot();
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'opencode' }).id, cwd: '/tmp', command: 'opencode', run: 'first' });
    await waitFor(() => b.store.state.robots[c.id].agent?.status === 'done');
    // dormant before the kill, as svalld ends an agent, so its revive is set at once
    b.store.update((d) => { markDormant(d.robots[c.id]); });
    await endWindow(b, c.id, c.tmux!.windowId);
    expect(b.store.state.robots[c.id].revive?.command).toBe(`opencode -s ${OSID}`);
    await b.fleet.run(c.id, 'second', true);
    await waitFor(() => b.fleet.readPrompts(c.id, 5).length === 2);
    expect(b.fleet.readPrompts(c.id, 5)).toEqual(['second', 'first']);
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'fake-opencode', `${c.id}.argv`), 'utf8'))).toEqual(['--standalone', '-s', OSID]);
    expect(fs.existsSync(path.join(b.home, `${c.id}.prompt`))).toBe(false);
  });

  it('resumes an opencode robot a restart cut off mid-turn, its plugin submitting what was lost', async () => {
    vi.stubEnv('PATH', `${path.join(import.meta.dirname, 'fixtures/bin')}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const b = await boot();
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'opencode' }).id, cwd: '/tmp', command: 'opencode', run: 'first' });
    await waitFor(() => b.store.state.robots[c.id].agent?.status === 'done');
    b.store.update((d) => { d.robots[c.id].agent!.status = 'working'; markDormant(d.robots[c.id]); });
    await endWindow(b, c.id, c.tmux!.windowId);
    expect(b.store.state.robots[c.id].revive).toEqual({ command: `opencode -s ${OSID}`, interrupted: true });
    await b.fleet.resumeInterrupted();
    await waitFor(() => b.fleet.readPrompts(c.id, 5).length === 2);
    expect(b.fleet.readPrompts(c.id, 5)[0]).toBe(RESUME_NOTE);
  });
});
