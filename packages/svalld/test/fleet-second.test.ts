import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind } from '@svall/protocol';
import { markSlotDormant } from '../src/dormancy.js';
import { Dormant, Invalid } from '../src/errors.js';
import { boot, OSID, SID, stopFleets } from './fleet-boot.js';
import { cleanHomes, hasTmux, waitFor, waitForPolls } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('Fleet second terminal', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('opens one second terminal beside the main one, and ends it with its shell or with the robot', async () => {
    const { fleet, store, tmux } = await boot();
    const island = fleet.createIsland({ name: 'pair' });
    const c = await fleet.createRobot({ islandId: island.id, cwd: '/tmp' });
    const [a, b] = await Promise.all([fleet.openSecond(c.id), fleet.openSecond(c.id)]);
    expect(a.second?.tmux).toEqual(b.second?.tmux);
    expect((await tmux.listWindows()).map((w) => w.name).sort()).toEqual([c.id, `${c.id}-2`]);
    const paneId = store.state.robots[c.id].second!.tmux!.paneId;
    await tmux.sendLine(paneId, 'echo term-$SVALL_TERM-$SVALL_ROBOT_ID', true);
    await waitFor(async () => (await tmux.capture(paneId, 20)).toString().includes(`term-2-${c.id}`));
    await waitForPolls(fleet, 3);
    expect(store.state.robots[c.id].second).toBeDefined();
    await tmux.sendLine(paneId, 'exit', true);
    await waitFor(() => store.state.robots[c.id].second === undefined);
    expect(store.state.robots[c.id].tmux).toBeDefined();
    await fleet.openSecond(c.id);
    await fleet.closeRobot(c.id);
    expect(await tmux.listWindows()).toEqual([]);
  });

  it('types into, reads and waits on the second terminal when a call names it', async () => {
    const { fleet, store } = await boot();
    const island = fleet.createIsland({ name: 'reach' });
    const c = await fleet.createRobot({ islandId: island.id, cwd: '/tmp' });
    await expect(fleet.run(c.id, 'echo nope', true, 2)).rejects.toThrow(`${c.name} has no second terminal`);
    expect(() => fleet.readTranscript(c.id, 1, 2)).toThrow(`${c.name} has no agent in its second terminal`);
    await fleet.openSecond(c.id);
    await fleet.run(c.id, 'echo from-second', true, 2);
    await waitFor(async () => (await fleet.readScreen(c.id, 20, 2)).includes('from-second'));
    expect(await fleet.readScreen(c.id, 20)).not.toContain('from-second');
    store.update((d) => { d.robots[c.id].second!.agent = { kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'blocked', lastActivityAt: 1 }; });
    expect(await fleet.waitFor(c.id, ['blocked'], 1000, undefined, 2)).toBe('blocked');
    expect(await fleet.waitFor(c.id, ['blocked'], 50)).toBe('timeout');
    store.update((d) => { delete d.robots[c.id].second!.tmux; });
    expect(await fleet.waitFor(c.id, ['blocked'], 1000, undefined, 2)).toBe('gone');
    await expect(fleet.run(c.id, 'echo nope', true, 2)).rejects.toThrow(Dormant);
    await expect(fleet.readScreen(c.id, 20, 2)).rejects.toThrow(/second terminal of .* is dormant/);
  });

  it('keeps a second terminal that ran an agent, and revives it in its own cwd with the command that brings its session back', async () => {
    const { fleet, store, tmux, home } = await boot();
    const island = fleet.createIsland({ name: 'again', context: [{ kind: 'folder', ref: '/tmp', label: 'tmp', source: 'manual' }] });
    const c = await fleet.createRobot({ islandId: island.id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    const paneId = store.state.robots[c.id].second!.tmux!.paneId;
    const sessionId = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
    const transcriptPath = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, '');
    store.update((d) => { d.robots[c.id].second!.agent = { kind: 'claude', sessionId, transcriptPath, status: 'idle', lastActivityAt: 1 }; });
    // typed at once: two polls of the pane at a shell would take the agent as ended before the window goes
    await tmux.run('send-keys', '-t', paneId, 'exit', 'Enter');
    await waitFor(() => store.state.robots[c.id].second?.tmux === undefined);
    expect(store.state.robots[c.id].second?.revive).toEqual({ command: `claude --resume ${sessionId}` });
    // the end its closing window sends leaves the agent the revive resumes
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', term: 2, name: 'SessionEnd', sessionId } });
    expect(store.state.robots[c.id].second?.agent?.sessionId).toBe(sessionId);
    const dir = fs.realpathSync(home);
    store.update((d) => { d.robots[c.id].second!.cwd = dir; });
    const typed = vi.spyOn(tmux, 'sendLine');
    const back = await fleet.openSecond(c.id);
    expect(back.second?.tmux).toBeDefined();
    expect(back.second?.revive).toBeUndefined();
    // the resume is typed into the new pane, carrying the island's context folders as the main revive does
    expect(typed.mock.calls).toEqual([[back.second!.tmux!.paneId, `claude --resume ${sessionId} --add-dir '/tmp'`, true]]);
    typed.mockRestore();
    expect((await tmux.listWindows()).find((w) => w.name === `${c.id}-2`)?.path).toBe(dir);
  });

  it('reopens a dormant second terminal whose folder is gone where its agent can resume, and refuses Codex', async () => {
    const { fleet, store, tmux, home } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const gone = path.join(home, 'gone', 'deeper');
    const sleepWith = (kind: AgentKind) => store.update((d) => {
      d.robots[c.id].second = { cwd: gone, unread: false, revive: { command: 'echo revived' }, agent: { kind, sessionId: SID, status: 'idle', lastActivityAt: 1 } };
    });
    sleepWith('codex');
    await expect(fleet.openSecond(c.id)).rejects.toThrow(new Invalid(`${c.name}'s second terminal's folder ${gone} is gone, and Codex resumes its session only there; recreate the folder, or close ${c.name}`));
    expect((await tmux.listWindows()).some((w) => w.name === `${c.id}-2`)).toBe(false);
    sleepWith('claude');
    await fleet.openSecond(c.id);
    expect((await tmux.listWindows()).find((w) => w.name === `${c.id}-2`)?.path).toBe(fs.realpathSync(home));
  });

  it('reopens a dormant Codex second terminal in its own folder while its rollout records one this machine lacks', async () => {
    const { fleet, store, tmux, home } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const transcriptPath = path.join(home, `${SID}.jsonl`);
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'turn_context', payload: { cwd: '/nonexistent/app' } })}\n`);
    store.update((d) => {
      d.robots[c.id].second = { cwd: '/tmp', unread: false, revive: { command: `codex resume -c tui.resume_cwd=session ${SID}` }, agent: { kind: 'codex', sessionId: SID, transcriptPath, status: 'idle', lastActivityAt: 1 } };
    });
    const typed = vi.spyOn(tmux, 'sendLine').mockImplementation(async () => {});
    await fleet.openSecond(c.id);
    expect(typed.mock.calls.map(([, text]) => text)).toEqual([`codex resume --no-daemon -c check_for_update_on_startup=false -c tui.resume_cwd=current ${SID}`]);
    typed.mockRestore();
  });

  it('lets a second terminal go with its window once a poll has seen its OpenCode, which sends no SessionEnd, quit to the shell', async () => {
    // one poll in a second, so the exit lands before a second poll would let the agent go
    const { fleet, store, tmux } = await boot({ pollMs: 1000 });
    const island = fleet.createIsland({ name: 'quit' });
    const quitThenExit = async (id: string) => {
      await fleet.openSecond(id);
      const paneId = store.state.robots[id].second!.tmux!.paneId;
      store.update((d) => { d.robots[id].second!.agent = { kind: 'opencode', sessionId: OSID, transcriptPath: '/t', status: 'idle', lastActivityAt: 1 }; });
      await waitForPolls(fleet, 1);
      await tmux.run('send-keys', '-t', paneId, 'exit', 'Enter');
      await waitFor(() => store.state.robots[id].second === undefined);
    };
    // the control client hears the window close
    await quitThenExit((await fleet.createRobot({ islandId: island.id, cwd: '/tmp' })).id);
    // the poll finds it gone
    await fleet['link'].stop();
    await quitThenExit((await fleet.createRobot({ islandId: island.id, cwd: '/tmp' })).id);
  });

  it('judges a revived second terminal by what a poll saw in its own window, not in the one closed before it', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 1000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'again' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    const first = store.state.robots[c.id].second!.tmux!.windowId;
    store.update((d) => { d.robots[c.id].second!.agent = { kind: 'opencode', sessionId: OSID, transcriptPath: '/t', status: 'idle', lastActivityAt: 1 }; });
    // a poll sees the shell in the pane, then the terminal is laid dormant the way a quit does, reading no sighting
    await waitForPolls(fleet, 1);
    store.update((d) => { markSlotDormant(d.robots[c.id].second!); });
    await tmux.killWindow(first);
    await waitForPolls(fleet, 1);
    // revived, with nothing typed, and its window killed before any poll has looked at it
    vi.spyOn(tmux, 'sendLine').mockResolvedValue();
    await fleet.openSecond(c.id);
    await tmux.killWindow(store.state.robots[c.id].second!.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].second?.tmux === undefined);
    expect(store.state.robots[c.id].second?.revive).toEqual({ command: `opencode -s ${OSID}` });
  });

  it('keeps a second terminal whose resume never brought its OpenCode up, though a poll saw only the shell there', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 1000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'resume' }).id, cwd: '/tmp' });
    // a resume that failed once, so its revive is watched until the session starts
    store.update((d) => {
      d.robots[c.id].second = {
        cwd: '/tmp', unread: false, agent: { kind: 'opencode', sessionId: OSID, transcriptPath: '/t', status: 'idle', lastActivityAt: 1 },
        revive: { command: `opencode -s ${OSID}` }, resumeError: 'opencode did not come up',
      };
    });
    vi.spyOn(tmux, 'sendLine').mockResolvedValue();
    await fleet.openSecond(c.id);
    await waitForPolls(fleet, 1);
    await tmux.killWindow(store.state.robots[c.id].second!.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].second?.tmux === undefined);
    expect(store.state.robots[c.id].second?.revive).toEqual({ command: `opencode -s ${OSID}` });
  });

  it('keeps a second terminal whose OpenCode still held its pane when the window was killed, to be revived', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'held' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    const { windowId, paneId } = store.state.robots[c.id].second!.tmux!;
    // what holds the pane in OpenCode's place
    await tmux.sendLine(paneId, 'sleep 30', true);
    await waitFor(async () => (await tmux.listWindows()).find((w) => w.paneId === paneId)?.command === 'sleep');
    store.update((d) => { d.robots[c.id].second!.agent = { kind: 'opencode', sessionId: OSID, transcriptPath: '/t', status: 'idle', lastActivityAt: 1 }; });
    await waitForPolls(fleet, 1);
    await tmux.killWindow(windowId);
    await waitFor(() => store.state.robots[c.id].second?.tmux === undefined);
    expect(store.state.robots[c.id].second?.revive).toEqual({ command: `opencode -s ${OSID}` });
  });

  it('says which terminal a session started in, once the hook has landed there', async () => {
    const { fleet, store } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    store.update((d) => { d.robots[c.id].second = { cwd: '/tmp', tmux: { windowId: '@99', paneId: '%99' }, unread: false }; });
    const seen: unknown[] = [];
    const off = fleet.onSessionStart((...a) => seen.push(a));
    const sid = '11111111-1111-4111-8111-111111111111';
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: sid, transcriptPath: '/t/a.jsonl' } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'codex', term: 2, name: 'SessionStart', sessionId: sid } });
    // no session to name, or no robot for it to land on
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart' } });
    await fleet.onSocketEvent({ hook: { robotId: 'c_nobody', backend: 'claude', name: 'SessionStart', sessionId: sid } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Stop', sessionId: sid } });
    off();
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: sid } });
    expect(seen).toEqual([[c.id, undefined, sid], [c.id, 2, sid]]);
  });

  it('routes a hook from the second terminal to the second record, and drops it when there is none', async () => {
    const { fleet, store } = await boot();
    const island = fleet.createIsland({ name: 'two' });
    const c = await fleet.createRobot({ islandId: island.id, cwd: '/tmp' });
    await fleet.stop();
    const start = { robotId: c.id, backend: 'claude' as const, term: 2 as const, name: 'SessionStart' as const, sessionId: '11111111-1111-4111-8111-111111111111', transcriptPath: '/t/b.jsonl' };
    await fleet.onSocketEvent({ hook: start });
    expect(store.state.robots[c.id].agent).toBeUndefined();
    expect(store.state.robots[c.id].second).toBeUndefined();
    store.update((d) => { d.robots[c.id].second = { cwd: '/tmp', tmux: { windowId: '@99', paneId: '%99' }, unread: false }; });
    await fleet.onSocketEvent({ hook: start });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', term: 2, name: 'Stop' } });
    expect(store.state.robots[c.id].agent).toBeUndefined();
    expect(store.state.robots[c.id].second).toMatchObject({ unread: true, agent: { status: 'done' } });
    await fleet.onSocketEvent({ status: { robotId: c.id, term: 2, contextPct: 41 } });
    expect(store.state.robots[c.id].second?.agent?.contextPct).toBe(41);
    fleet.markSeen(c.id);
    expect(store.state.robots[c.id].second).toMatchObject({ unread: true, agent: { status: 'done' } });
    fleet.markSeen(c.id, 2);
    expect(store.state.robots[c.id].second).toMatchObject({ unread: false, agent: { status: 'idle' } });
  });

  it('leaves the second terminal unread when the main one is marked seen, and the other way round', async () => {
    const { fleet, store } = await boot();
    const island = fleet.createIsland({ name: 'two' });
    const c = await fleet.createRobot({ islandId: island.id, cwd: '/tmp' });
    await fleet.stop();
    store.update((d) => {
      d.robots[c.id].unread = true;
      d.robots[c.id].second = { cwd: '/tmp', tmux: { windowId: '@99', paneId: '%99' }, unread: true };
    });
    fleet.markSeen(c.id);
    expect(store.state.robots[c.id].unread).toBe(false);
    expect(store.state.robots[c.id].second?.unread).toBe(true);
    store.update((d) => { d.robots[c.id].unread = true; });
    fleet.markSeen(c.id, 2);
    expect(store.state.robots[c.id].unread).toBe(true);
    expect(store.state.robots[c.id].second?.unread).toBe(false);
  });
});
