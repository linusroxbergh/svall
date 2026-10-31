import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind } from '@svall/protocol';
import { RESUME_NOTE, resumeNote } from '../src/dormancy.js';
import { Dormant, Invalid } from '../src/errors.js';
import { resolvePaths } from '../src/paths.js';
import { boot, holdListing, SID, stopFleets, withAgent } from './fleet-boot.js';
import { cleanHomes, hasTmux, waitFor, waitForPolls } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

// the prompt a launch file hands its agent: its last word, as bash, zsh and fish read it
const promptOf = (file: string): string => /(?:--|--prompt) ((?:'[^']*'|\\.)+)\n$/.exec(fs.readFileSync(file, 'utf8'))![1]
  .replace(/'([^']*)'|\\(.)/g, (_, quoted: string | undefined, escaped: string) => quoted ?? escaped);

runIf('Fleet revive', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('marks a killed window dormant and revives it', async () => {
    const { fleet, store, tmux } = await boot();
    // an agent's pane runs something other than a shell, or the poll ends the agent
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: '9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e', transcriptPath: '/nope' } });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    expect(store.state.robots[c.id].revive).toEqual({ command: 'claude --resume 9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e' });
    await expect(fleet.run(c.id, 'x', false)).rejects.toBeInstanceOf(Dormant);
    await expect(fleet.run(c.id, 'x', false)).rejects.toThrow(`${c.name} is dormant; revive it first`);
    // a wait reports a dormant robot as it does a deleted one: without a terminal, the status will not come
    expect(await fleet.waitFor(c.id, ['idle'], 100)).toBe('gone');
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionEnd' } });
    store.update((d) => { d.robots[c.id].revive = { command: 'echo revived' }; });
    const r = await fleet.reviveRobot(c.id);
    expect(r.tmux).toBeDefined();
    expect(r.revive).toBeUndefined();
    await waitFor(async () => (await fleet.readScreen(c.id, 20)).includes('revived'));
  });

  it('revives a robot whose folder is gone where its agent can resume, and refuses Codex or OpenCode', async () => {
    const { fleet, store, tmux, home } = await boot();
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, 'repo-')));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    execFileSync('git', ['init', '-q', repo]);
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(repo, '.claude', 'worktrees', 'feat');
    git('worktree', 'add', '-q', '-b', 'feat', wt);
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: wt });
    await waitFor(() => store.state.robots[c.id].repo?.isWorktree === true);
    const sleepWith = async (kind: AgentKind, cwd: string) => {
      const { tmux: t } = store.state.robots[c.id];
      if (t) await tmux.killWindow(t.windowId);
      await waitFor(() => store.state.robots[c.id].tmux === undefined);
      store.update((d) => {
        Object.assign(d.robots[c.id], { cwd, revive: { command: 'echo revived' } });
        d.robots[c.id].agent = { kind, sessionId: SID, status: 'idle', lastActivityAt: 1 };
      });
    };
    const revivedIn = async () => (await tmux.run('display', '-p', '-t', (await fleet.reviveRobot(c.id)).tmux!.paneId, '#{pane_current_path}')).trim();
    git('worktree', 'remove', wt);

    for (const kind of ['codex', 'opencode'] as const) {
      await sleepWith(kind, wt);
      await expect(fleet.reviveRobot(c.id)).rejects.toThrow(new Invalid(`${c.name}'s folder ${wt} is gone, and ${kind === 'codex' ? 'Codex' : 'OpenCode'} resumes its session only there; recreate the folder, or close ${c.name}`));
      expect((await tmux.listWindows()).some((w) => w.name === c.id)).toBe(false);
    }
    // Claude resumes from any folder: a removed worktree's robot goes back to its main checkout
    await sleepWith('claude', wt);
    expect(await revivedIn()).toBe(repo);
    // any other folder that is gone gives way to the nearest one left
    await sleepWith('claude', path.join(home, 'gone', 'deeper'));
    store.update((d) => { delete d.robots[c.id].repo; });
    expect(await revivedIn()).toBe(fs.realpathSync(home));
  });

  it('starts a Claude session that saved no transcript afresh on revive, and resumes one that did', async () => {
    const { fleet, store, tmux, home } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const transcriptPath = path.join(home, 'projects', '-tmp', `${SID}.jsonl`);
    const sleep = async () => {
      const { tmux: t } = store.state.robots[c.id];
      if (t) await tmux.killWindow(t.windowId);
      await waitFor(() => store.state.robots[c.id].tmux === undefined);
      store.update((d) => {
        d.robots[c.id].revive = { command: `claude --effort 'xhigh' --resume ${SID}` };
        d.robots[c.id].agent = { kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 1, transcriptPath };
      });
    };
    // what a revive types, kept from the pane so no real agent starts
    const typed = vi.spyOn(tmux, 'sendLine').mockResolvedValue(undefined);
    await sleep();
    await fleet.reviveRobot(c.id);
    expect(typed).toHaveBeenLastCalledWith(expect.any(String), "claude --effort 'xhigh'", true);
    // the new session reports itself as it starts
    expect(store.state.robots[c.id].agent).toBeUndefined();

    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '');
    await sleep();
    await fleet.reviveRobot(c.id);
    expect(typed).toHaveBeenLastCalledWith(expect.any(String), `claude --effort 'xhigh' --resume ${SID}`, true);
    expect(store.state.robots[c.id].agent?.sessionId).toBe(SID);

    // a dormant second terminal's, too
    const other = 'a1b2c3d4-0000-4000-8000-000000000001';
    store.update((d) => {
      d.robots[c.id].second = {
        cwd: '/tmp', unread: false, revive: { command: `claude --resume ${other}` },
        agent: { kind: 'claude', sessionId: other, status: 'idle', lastActivityAt: 1, transcriptPath: path.join(home, 'projects', '-tmp', `${other}.jsonl`) },
      };
    });
    await fleet.openSecond(c.id);
    expect(typed).toHaveBeenLastCalledWith(expect.any(String), 'claude', true);
    expect(store.state.robots[c.id].second?.agent).toBeUndefined();
  });

  it('takes away a prompt file left over when a robot starts without a prompt', async () => {
    const { fleet, store, tmux, home } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    fs.writeFileSync(path.join(home, `${c.id}.prompt`), 'stale');
    await fleet.reviveRobot(c.id);
    expect(fs.existsSync(path.join(home, `${c.id}.prompt`))).toBe(false);
  });

  const HOUR = 3_600_000;

  it('ends an agent idle past the limit and resumes it with the flags it was started with', async () => {
    const b = await boot();
    const { fleet, store, tmux } = b;
    // the stand-in lingers after the hang-up, as an agent running its SessionEnd hooks does
    const { c, pid } = await withAgent(b, 'claude --model claude-opus-5-5[1m] --effort xhigh -- fix it', "trap 'sleep 1; exit' HUP; while :; do sleep 0.1; done");
    const windowId = c.tmux!.windowId;
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();

    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = Date.now() - 13 * HOUR; });
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeUndefined();
    expect(store.state.robots[c.id].revive).toEqual({ command: `claude --effort 'xhigh' --resume ${SID}` });
    expect(await tmux.hasWindow(windowId)).toBe(false);
    // the sweep returns once the agent itself has gone, so no revive runs beside it
    expect(() => process.kill(pid, 0)).toThrow();
    // the end the closing window sends leaves the agent the revive resumes
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionEnd', sessionId: SID } });
    expect(store.state.robots[c.id].agent?.sessionId).toBe(SID);
    // as does a daemon start's reconcile
    await fleet.reconcileNow();
    expect(store.state.robots[c.id].revive).toEqual({ command: `claude --effort 'xhigh' --resume ${SID}` });

    store.update((d) => { d.robots[c.id].revive = { command: 'sleep 600' }; });
    await fleet.reviveRobot(c.id);
    expect(Date.now() - store.state.robots[c.id].agent!.lastActivityAt).toBeLessThan(HOUR);
  });

  it('stops every terminal for a quit: an agent resumes with its flags, a shell starts afresh, and the server stays down', async () => {
    const b = await boot();
    const { fleet, store, tmux } = b;
    const { c, pid } = await withAgent(b, 'claude --effort xhigh', "trap 'sleep 1; exit' HUP; while :; do sleep 0.1; done");
    const shell = await fleet.createRobot({ islandId: c.islandId, cwd: '/tmp', command: 'sleep 600' });
    await fleet.openSecond(c.id);
    const stopped = new Promise<void>((r) => fleet.once('stopped', r));
    // a poll holding a listing with the second terminal on it, let go once the quit waits on it, must not write it back
    const poll = holdListing(tmux);
    await poll.listed;
    setTimeout(poll.release, 100);
    await fleet.stopAll();
    await stopped;
    const after = store.state.robots;
    expect(after[c.id].tmux).toBeUndefined();
    expect(after[c.id].second).toBeUndefined();
    expect(after[c.id].revive).toEqual({ command: `claude --effort 'xhigh' --resume ${SID}` });
    expect(after[shell.id].tmux).toBeUndefined();
    expect(after[shell.id].revive).toEqual({ command: '' });
    // on disk too, for a daemon ended right after
    expect(JSON.parse(fs.readFileSync(resolvePaths(b.home).state, 'utf8')).robots[c.id].revive).toEqual(after[c.id].revive);
    // the stop returns once the agent itself has gone, so a resume right after runs alone
    expect(() => process.kill(pid, 0)).toThrow();
    // the end the closing window sends leaves the agent the revive resumes
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionEnd', sessionId: SID } });
    expect(store.state.robots[c.id].agent?.sessionId).toBe(SID);
    // the lost control client brings no server back, and a page still open on the robot does not wake it
    await new Promise((r) => setTimeout(r, 1500));
    await expect(tmux.run('list-sessions')).rejects.toThrow();
    await expect(fleet.reviveRobot(c.id)).rejects.toThrow('the fleet is stopping');
  });

  it('resumes an agent with the flags remembered at its start when ps fails the quit', async () => {
    let failing = false;
    const errors: string[] = [];
    const b = await boot({ processes: async () => { if (failing) throw new Error('ps timed out'); return b.procs; }, log: { info() {}, error: (m) => { errors.push(m); } } });
    const { c } = await withAgent(b, 'claude --effort xhigh --dangerously-skip-permissions');
    await waitFor(() => !!b.store.state.robots[c.id].agent?.flags);
    failing = true;
    await b.fleet.stopAll();
    expect(b.store.state.robots[c.id].revive).toEqual({ command: `claude --effort 'xhigh' --dangerously-skip-permissions --resume ${SID}` });
    expect(errors.some((m) => m.startsWith('quit: ps failed'))).toBe(true);
  });

  it('has a settle wait for the launch flags a session start reads off its process', async () => {
    // the server check on the start passes; the read of its flags waits until released
    const gate: { calls: number; held?: Promise<void> } = { calls: 0 };
    const b = await boot({ pollMs: 60_000, processes: async () => { if (gate.held && gate.calls++ > 0) await gate.held; return b.procs; } });
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    const pid = Number((await b.tmux.run('display', '-p', '-t', c.tmux!.paneId, '#{pane_pid}')).trim());
    b.procs.push({ pid, ppid: 1, pgid: pid, args: 'claude --effort xhigh' });
    let release!: () => void;
    gate.held = new Promise<void>((r) => { release = r; });
    await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, pid, transcriptPath: '/nope' } });
    let settled = false;
    const settling = b.fleet.settle().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    expect(b.store.state.robots[c.id].agent?.flags).toBeUndefined();
    release();
    await settling;
    expect(b.store.state.robots[c.id].agent?.flags).toEqual(['--effort', "'xhigh'"]);
  });

  it('revives a second terminal whose window closed, or that a quit without ps stopped, with the flags remembered at its start', async () => {
    let failing = false;
    const b = await boot({ processes: async () => { if (failing) throw new Error('ps timed out'); return b.procs; } });
    const { c } = await withAgent(b);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const revive = { command: `claude --effort 'xhigh' --resume ${sessionId}` };
    const start = async () => {
      const { windowId, paneId } = (await b.fleet.openSecond(c.id)).second!.tmux!;
      const pid = Number((await b.tmux.run('display', '-p', '-t', paneId, '#{pane_pid}')).trim());
      b.procs.push({ pid, ppid: 1, pgid: pid, args: 'claude --effort xhigh' });
      await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', term: 2, name: 'SessionStart', sessionId, pid, transcriptPath: '/t' } });
      await b.fleet.settle();
      expect(b.store.state.robots[c.id].second?.agent?.flags).toEqual(['--effort', "'xhigh'"]);
      return windowId;
    };
    await b.tmux.killWindow(await start());
    await waitFor(() => !b.store.state.robots[c.id].second?.tmux);
    expect(b.store.state.robots[c.id].second?.revive).toEqual(revive);
    await start();
    failing = true;
    await b.fleet.stopAll();
    expect(b.store.state.robots[c.id].second?.revive).toEqual(revive);
  });

  it('resumes an agent a quit stopped mid-turn as the fleet starts again, telling it what was lost', async () => {
    const b = await boot();
    const { c } = await withAgent(b);
    await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', sessionId: SID } });
    await b.fleet.stopAll();
    expect(b.store.state.robots[c.id].revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });

    const again = await boot({ opening: true, state: structuredClone(b.store.state) });
    // what would be typed is kept, so no real claude starts
    const typed: string[] = [];
    vi.spyOn(again.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
    await again.fleet.resumeInterrupted();
    expect(again.store.state.robots[c.id].tmux).toBeDefined();
    const file = path.join(again.home, `${c.id}.prompt`);
    expect(typed).toEqual([`. '${file}'`]);
    expect(promptOf(file)).toBe(RESUME_NOTE);
  });

  it("wakes an interrupted agent with another robot's message, its header first and the note after", async () => {
    const b = await boot();
    const { c } = await withAgent(b);
    const lead = await b.fleet.createRobot({ islandId: c.islandId, cwd: '/tmp', name: 'lead' });
    await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', sessionId: SID } });
    await b.fleet.stopAll();

    const again = await boot({ opening: true, state: structuredClone(b.store.state) });
    vi.spyOn(again.tmux, 'sendLine').mockResolvedValue();
    const message = again.fleet.message(c.id, lead.id, 'review it');
    expect(await again.fleet.run(c.id, message, true)).toBe('delivered');
    expect(promptOf(path.join(again.home, `${c.id}.prompt`))).toBe(`${message}\n\n${RESUME_NOTE}`);
  });

  it('records in the retro\'s file each session a hook brings, and each one a robot holds as the fleet starts', async () => {
    const sessions = (home: string) => fs.readFileSync(resolvePaths(home).retroSessions, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as object);
    const b = await boot();
    const { c } = await withAgent(b);
    expect(sessions(b.home)).toEqual([expect.objectContaining({ session: SID, robot: c.id, agent: 'claude' })]);
    const again = await boot({ opening: true, state: structuredClone(b.store.state) });
    expect(sessions(again.home)).toEqual([expect.objectContaining({ session: SID, robot: c.id, agent: 'claude' })]);
  });

  it('tells an interrupted agent whose recorded folder is not on this machine where it works now', async () => {
    const b = await boot();
    const { c, transcriptPath } = await withAgent(b);
    await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', sessionId: SID } });
    await b.fleet.stopAll();
    const note = async (cwd: string): Promise<string> => {
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', cwd })}\n`);
      const again = await boot({ opening: true, state: structuredClone(b.store.state) });
      vi.spyOn(again.tmux, 'sendLine').mockImplementation(async () => {});
      await again.fleet.resumeInterrupted();
      return promptOf(path.join(again.home, `${c.id}.prompt`));
    };
    expect(await note('/nonexistent/app')).toBe(resumeNote({ from: '/nonexistent/app', to: '/tmp' }));
    // a folder the shell went into that is still here moved nowhere
    expect(await note(path.dirname(transcriptPath))).toBe(RESUME_NOTE);
  });

  it('resumes Codex in its own folder while its rollout records one this machine lacks, and as usual once it records that folder', async () => {
    const b = await boot();
    const { c, transcriptPath } = await withAgent(b, 'codex', 'sleep 600', 'codex');
    const record = (cwd: string) => fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { cwd } } })}\n`);
    record('/nonexistent/app');
    await b.fleet.stopAll();
    const revive = async (): Promise<string[]> => {
      const again = await boot({ opening: true, state: structuredClone(b.store.state) });
      const typed: string[] = [];
      vi.spyOn(again.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
      await again.fleet.reviveRobot(c.id);
      return typed;
    };
    const [moved] = await revive();
    expect(moved).toMatch(new RegExp(`^codex resume .*-c tui\\.resume_cwd=current ${SID}$`));
    record('/tmp');
    const [plain] = await revive();
    expect(plain).toMatch(new RegExp(`^codex resume .*-c tui\\.resume_cwd=session ${SID}$`));
  });

  it('resumes an interrupted agent once the fleet starts again', async () => {
    const b = await boot();
    const { c } = await withAgent(b);
    await b.fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'PreToolUse', sessionId: SID } });
    await b.fleet.stopAll();
    const state = structuredClone(b.store.state);

    const typed: string[] = [];
    const again = await boot({ opening: true, state });
    vi.spyOn(again.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
    await again.fleet.resumeInterrupted();
    expect(again.store.state.robots[c.id].tmux).toBeDefined();
    expect(typed).toHaveLength(1);
    expect(promptOf(path.join(again.home, `${c.id}.prompt`))).toBe(RESUME_NOTE);
  });

  it("starts a dormant terminal whose resume failed afresh in its folder, told what its old session held, and leaves that session's files", async () => {
    const b = await boot();
    const { c, transcriptPath } = await withAgent(b);
    const fixture = path.join(import.meta.dirname, 'fixtures/sessions/claude/2.1.280/projects/-Users-source-work-demo/bf480ea6-5572-4554-8016-2dc5590f5bba.jsonl');
    fs.copyFileSync(fixture, transcriptPath);
    await b.tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => b.store.state.robots[c.id].tmux === undefined);
    b.store.update((d) => {
      d.robots[c.id].revive = { command: `claude --effort 'high' --resume ${SID}`, interrupted: true };
      d.robots[c.id].resumeError = 'the resume did not come up';
    });
    const typed: string[] = [];
    vi.spyOn(b.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });

    const fresh = await b.fleet.startFresh(c.id);

    const file = path.join(b.home, `${c.id}.prompt`);
    expect(typed).toEqual([`. '${file}'`]);
    const brief = promptOf(file);
    expect(brief).toMatch(/^This is a new Claude Code session\. The earlier session /);
    expect(brief).toContain(SID);
    expect(brief).toContain('MARBLE-mac');
    // the new session reports itself as any agent does; the old one's transcript stays where it was
    expect(fresh.tmux).toBeDefined();
    expect(fresh.agent).toBeUndefined();
    expect(fresh.revive).toBeUndefined();
    expect(fresh.resumeError).toBeUndefined();
    expect(fs.readFileSync(transcriptPath)).toEqual(fs.readFileSync(fixture));
    await expect(b.fleet.startFresh(c.id)).rejects.toThrow(Invalid);
  });

  it('starts afresh only a terminal whose resume failed', async () => {
    const b = await boot();
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const OLD = 'ses_0123456789abCDEFGHIJKLMNop';
    b.store.update((d) => {
      d.robots[c.id].second = { cwd: '/tmp', unread: false, agent: { kind: 'opencode', sessionId: OLD, status: 'idle', lastActivityAt: 0 }, revive: { command: `opencode -s ${OLD}` } };
    });
    await expect(b.fleet.startFresh(c.id, 2)).rejects.toThrow(`${c.name}'s second terminal has no failed resume to start afresh from; revive it`);
  });

  it('starts a dormant second terminal afresh with its own prompt file', async () => {
    const b = await boot();
    const c = await b.fleet.createRobot({ islandId: b.fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const OLD = 'ses_0123456789abCDEFGHIJKLMNop';
    b.store.update((d) => {
      d.robots[c.id].second = {
        cwd: '/tmp', unread: false, agent: { kind: 'opencode', sessionId: OLD, status: 'idle', lastActivityAt: 0 }, revive: { command: `opencode --auto -s ${OLD}` }, resumeError: 'gone',
      };
    });
    const typed: string[] = [];
    vi.spyOn(b.tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });

    const fresh = await b.fleet.startFresh(c.id, 2);

    const file = path.join(b.home, `${c.id}-2.prompt`);
    expect(typed).toEqual([`. '${file}'`]);
    expect(promptOf(file)).toMatch(/^This is a new OpenCode session. The earlier session ses_0123456789abCDEFGHIJKLMNop/);
    expect(fresh.second).toMatchObject({ tmux: expect.anything() });
    expect(fresh.second?.agent).toBeUndefined();
    expect(fresh.second?.resumeError).toBeUndefined();
    expect(fresh.tmux).toBeDefined();
  });

  it('leaves a terminal whose ordinary revive exits back to its shell at that shell, and drops its agent', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, transcriptPath: '/nope' } });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    // a resume of a session that is gone, as Claude's is once it has cleaned up the transcript
    store.update((d) => { d.robots[c.id].revive = { command: `sleep 1; : --resume ${SID}` }; });

    const { tmux: window } = await fleet.reviveRobot(c.id);
    await waitFor(() => store.state.robots[c.id].agent === undefined, 5000);
    await waitForPolls(fleet, 3);
    expect(store.state.robots[c.id].tmux).toEqual(window);
    expect(store.state.robots[c.id].revive).toBeUndefined();
    expect(store.state.robots[c.id].resumeError).toBeUndefined();
    expect((await tmux.listWindows()).some((w) => w.windowId === window!.windowId && !w.dead)).toBe(true);
  });

  it('lays a revived terminal dormant again with its session and resume when its agent leaves before that session starts, and not once it has', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, transcriptPath: '/nope' } });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    // a Retry of a terminal whose resume failed, which runs a moment and exits again, as a Claude without its login does
    const revive = { command: `sleep 1; : --resume ${SID}` };
    store.update((d) => { d.robots[c.id].revive = revive; d.robots[c.id].resumeError = 'the resume did not come up'; });

    await fleet.reviveRobot(c.id);
    await waitFor(() => store.state.robots[c.id].tmux === undefined, 5000);
    expect(store.state.robots[c.id]).toMatchObject({
      agent: { sessionId: SID }, revive,
      resumeError: `${c.name}'s terminal resumed claude session ${SID}, but claude exited back to its shell before that session started, so it is dormant again with that session; revive it to see`,
    });
    await waitFor(async () => !(await tmux.listWindows()).some((w) => w.name === c.id));

    // one whose session started is an agent that ended, and leaves its shell
    const back = await fleet.reviveRobot(c.id);
    expect(back.resumeError).toBeUndefined();
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, transcriptPath: '/nope' } });
    await waitFor(() => store.state.robots[c.id].agent === undefined, 5000);
    expect(store.state.robots[c.id].tmux).toBeDefined();
  });

  it('lays a revived terminal whose agent never comes up dormant again with its session once the wait for it runs out', async () => {
    const { fleet, store, tmux } = await boot({ resumeMs: 1000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp', command: 'sleep 600' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, transcriptPath: '/nope' } });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    // a builtin, so the pane is back at its shell at once and the resume never runs
    const revive = { command: `: --resume ${SID}` };
    store.update((d) => { d.robots[c.id].revive = revive; d.robots[c.id].resumeError = 'it did not come up'; });

    await fleet.reviveRobot(c.id);
    await waitForPolls(fleet, 3);
    expect(store.state.robots[c.id]).toMatchObject({ tmux: expect.anything(), agent: { sessionId: SID } });
    await waitFor(() => store.state.robots[c.id].tmux === undefined, 5000);
    expect(store.state.robots[c.id]).toMatchObject({
      agent: { sessionId: SID }, revive,
      resumeError: `${c.name}'s terminal resumed claude session ${SID}, but claude did not come up within 1 s before that session started, so it is dormant again with that session; revive it to see`,
    });
  });
});
