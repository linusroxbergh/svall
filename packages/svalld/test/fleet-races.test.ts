import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markDormant, markSlotDormant } from '../src/dormancy.js';
import { NotFound } from '../src/errors.js';
import { ControlClient } from '../src/tmux/control.js';
import { SESSION } from '../src/tmux/tmux.js';
import { boot, holdListing, SID, stopFleets, withAgent } from './fleet-boot.js';
import { cleanHomes, hasTmux, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('Fleet races', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('takes back no window still closing for idleness, from a poll, a reconcile or a revive', async () => {
    const b = await boot();
    const { fleet, store, tmux } = b;
    const { c } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    const windowId = c.tmux!.windowId;
    // the window outlives its dormancy until released
    const real = tmux.killWindow.bind(tmux);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.spyOn(tmux, 'killWindow').mockImplementation(async (id) => { await held; return real(id); });
    const ending = fleet['endIdleAgents']();
    await waitFor(() => !store.state.robots[c.id].tmux);
    await fleet['poll']['tick']();
    await fleet.reconcileNow();
    expect(store.state.robots[c.id].tmux).toBeUndefined();
    store.update((d) => { d.robots[c.id].revive = { command: 'sleep 600' }; });
    const revived = fleet.reviveRobot(c.id);
    release();
    await ending;
    expect((await revived).tmux?.windowId).not.toBe(windowId);
  });

  it('goes back to a window whose kill failed, rather than start a second agent', async () => {
    const b = await boot();
    const { fleet, store, tmux } = b;
    const { c } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    const windowId = c.tmux!.windowId;
    vi.spyOn(tmux, 'killWindow').mockRejectedValueOnce(new Error('tmux went away'));
    await fleet['endIdleAgents']();
    expect((await fleet.reviveRobot(c.id)).tmux?.windowId).toBe(windowId);
  });

  it('ends no further idle agent once the fleet has stopped', async () => {
    const b = await boot();
    const { fleet, store, tmux } = b;
    const agents = [await withAgent(b), await withAgent(b)];
    store.update((d) => { for (const { c } of agents) d.robots[c.id].agent!.lastActivityAt = 0; });
    const real = tmux.killWindow.bind(tmux);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.spyOn(tmux, 'killWindow').mockImplementation(async (id) => { await held; return real(id); });
    const ending = fleet['endIdleAgents']();
    await waitFor(() => agents.some(({ c }) => !store.state.robots[c.id].tmux));
    await fleet.stop();
    release();
    await ending;
    expect(agents.filter(({ c }) => store.state.robots[c.id].tmux)).toHaveLength(1);
  });

  it('does not take back a window a poll listed before its agent was ended', async () => {
    const b = await boot({ pollMs: 60_000 });
    const { fleet, store, tmux } = b;
    const { c } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    // the listing, taken with the window alive, is handed back only after the agent has been ended
    const poll = holdListing(tmux);
    const tick = fleet['poll']['tick']();
    await poll.listed;
    await fleet['endIdleAgents']();
    poll.release();
    await tick;
    expect(store.state.robots[c.id].tmux).toBeUndefined();
    expect(store.state.robots[c.id].revive).toEqual({ command: `claude --resume ${SID}` });
  });

  it('does not mark a robot created during a poll snapshot dormant', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    // the listing is handed back only after the create has landed
    const poll = holdListing(tmux);
    const tick = fleet['poll']['tick']();
    await poll.listed;
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    poll.release();
    await tick;
    expect(store.state.robots[c.id].tmux).toEqual(c.tmux);
  });

  it('does not mark a robot revived during a poll snapshot dormant', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    // the listing is handed back only after the revive has landed
    const poll = holdListing(tmux);
    const tick = fleet['poll']['tick']();
    await poll.listed;
    const revived = await fleet.reviveRobot(c.id);
    poll.release();
    await tick;
    expect(store.state.robots[c.id].tmux).toEqual(revived.tmux);
  });

  it('does not mark a robot revived during a reconcile listing dormant', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    // the listing a recovery reconciles against is handed back only after the revive has landed
    const real = tmux.listWindows.bind(tmux);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.spyOn(tmux, 'listWindows').mockImplementationOnce(async () => { const r = await real(); await held; return r; });
    const reconciling = fleet.reconcileNow();
    const revived = await fleet.reviveRobot(c.id);
    release();
    await reconciling;
    expect(store.state.robots[c.id].tmux).toEqual(revived.tmux);
  });

  it('does not drop a second terminal opened during a poll snapshot', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    // the listing is handed back only after the second terminal has opened
    const poll = holdListing(tmux);
    const tick = fleet['poll']['tick']();
    await poll.listed;
    await fleet.openSecond(c.id);
    poll.release();
    await tick;
    expect(store.state.robots[c.id].second).toBeDefined();
  });

  it('does not bring back a second terminal closed during a poll snapshot', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    // the listing, taken with the second terminal open, is handed back only after it has closed
    const poll = holdListing(tmux);
    const tick = fleet['poll']['tick']();
    await poll.listed;
    store.update((d) => { delete d.robots[c.id].second; });
    poll.release();
    await tick;
    expect(store.state.robots[c.id].second).toBeUndefined();
  });

  it('does not adopt the windows of a robot closed during a reconcile listing', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const crew = Object.keys(store.state.robots).length;
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    // the listing a recovery reconciles against is handed back only after the close has landed
    const poll = holdListing(tmux);
    const reconciling = fleet.reconcileNow();
    await poll.listed;
    await fleet.closeRobot(c.id);
    poll.release();
    await reconciling;
    expect(Object.keys(store.state.robots)).toHaveLength(crew);
  });

  it('does not adopt the windows of a robot whose close is reading the processes', async () => {
    const reading = { hold: Promise.resolve() };
    const { fleet, store } = await boot({ pollMs: 60_000, readProcs: async () => { await reading.hold; return []; } });
    const crew = Object.keys(store.state.robots).length;
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    // the close holds its windows until it has read what runs in them; a recovery reconciles meanwhile
    let release!: () => void;
    reading.hold = new Promise<void>((r) => { release = r; });
    const closing = fleet.closeRobot(c.id);
    await waitFor(() => !store.state.robots[c.id]);
    await fleet.reconcileNow();
    expect(Object.keys(store.state.robots)).toHaveLength(crew);
    release();
    await closing;
    expect(Object.keys(store.state.robots)).toHaveLength(crew);
  });

  it('keeps an agent that reported in while a poll listed its pane at a shell', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const pid = Number((await tmux.run('display', '-p', '-t', c.tmux!.paneId, '#{pane_pid}')).trim());
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, pid } });
    // the last poll found the agent at a shell prompt too; this one would let it go
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    fleet['poll']['shellStreak'].set(c.id, 1);
    const poll = holdListing(tmux);
    const tick = fleet['poll']['tick']();
    await poll.listed;
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: SID, pid } });
    poll.release();
    await tick;
    expect(store.state.robots[c.id].agent?.sessionId).toBe(SID);
    expect(fleet['poll']['shellStreak'].has(c.id)).toBe(false);
  });

  it('keeps the revive of a robot whose resume could not be started', async () => {
    const b = await boot({ pollMs: 60_000 });
    const { fleet, store, tmux, home } = b;
    const { c } = await withAgent(b);
    store.update((d) => { markDormant(d.robots[c.id]); });
    await tmux.killWindow(c.tmux!.windowId);
    // the prompt file the resume takes its first prompt from cannot be written
    fs.mkdirSync(path.join(home, `${c.id}.prompt`));
    await expect(fleet.reviveRobot(c.id, 'go on')).rejects.toThrow('EISDIR');
    expect(store.state.robots[c.id].tmux).toBeUndefined();
    expect(store.state.robots[c.id].revive).toEqual({ command: `claude --resume ${SID}` });
    expect((await tmux.listWindows()).filter((w) => w.name === c.id)).toEqual([]);
  });

  it('takes back no window a failed revive is closing, from a poll or a reconcile', async () => {
    const b = await boot({ pollMs: 60_000 });
    const { fleet, store, tmux, home } = b;
    const { c } = await withAgent(b);
    store.update((d) => { markDormant(d.robots[c.id]); });
    await tmux.killWindow(c.tmux!.windowId);
    fs.mkdirSync(path.join(home, `${c.id}.prompt`));
    // a poll and a reconcile list the windows before tmux has closed the revive's
    const kill = tmux.killWindow.bind(tmux);
    vi.spyOn(tmux, 'killWindow').mockImplementationOnce(async (id) => { await fleet['poll']['tick'](); await fleet.reconcileNow(); return kill(id); });
    await expect(fleet.reviveRobot(c.id, 'go on')).rejects.toThrow('EISDIR');
    expect(store.state.robots[c.id].tmux).toBeUndefined();
    expect(store.state.robots[c.id].revive).toEqual({ command: `claude --resume ${SID}` });
  });

  it('takes back no window that began closing while a poll listed it, as a failed revive\'s may', async () => {
    const b = await boot({ pollMs: 60_000 });
    const { fleet, store } = b;
    const { c } = await withAgent(b);
    store.update((d) => { markDormant(d.robots[c.id]); });
    const list = fleet['poll']['deps'].listWindows;
    vi.spyOn(fleet['poll']['deps'], 'listWindows').mockImplementationOnce(async () => {
      const live = await list();
      fleet['ending'].set(c.id, Promise.resolve());
      return live;
    });
    await fleet['poll']['tick']();
    expect(store.state.robots[c.id].tmux).toBeUndefined();
  });

  it('takes back no window a failed revive closed while a poll still had it listed', async () => {
    const b = await boot({ pollMs: 50 });
    const { fleet, store } = b;
    const { c } = await withAgent(b);
    store.update((d) => { markDormant(d.robots[c.id]); });
    // the next poll lists the window, which then closes as a failed revive's does, before the poll applies the listing
    const list = fleet['poll']['deps'].listWindows;
    let closed!: () => void;
    const done = new Promise<void>((r) => { closed = r; });
    vi.spyOn(fleet['poll']['deps'], 'listWindows').mockImplementationOnce(async () => {
      const live = await list();
      await fleet['closeFailed'](c.id, c.tmux!.windowId, `revive ${c.id}`);
      closed();
      return live;
    });
    await done;
    await fleet['poll'].settled();
    expect(store.state.robots[c.id].tmux).toBeUndefined();
  });

  it('takes back no window a failed second terminal is closing, from a poll or a reconcile', async () => {
    const b = await boot({ pollMs: 60_000 });
    const { fleet, store, tmux } = b;
    const { c } = await withAgent(b);
    const first = (await fleet.openSecond(c.id)).second!.tmux!.windowId;
    store.update((d) => {
      const second = d.robots[c.id].second!;
      second.agent = { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'idle', lastActivityAt: 1 };
      markSlotDormant(second);
    });
    await tmux.killWindow(first);
    const revive = store.state.robots[c.id].second!.revive;
    vi.spyOn(tmux, 'sendLine').mockRejectedValueOnce(new Error('the pane went'));
    const kill = tmux.killWindow.bind(tmux);
    vi.spyOn(tmux, 'killWindow').mockImplementationOnce(async (id) => { await fleet['poll']['tick'](); await fleet.reconcileNow(); return kill(id); });
    await expect(fleet.openSecond(c.id)).rejects.toThrow('the pane went');
    expect(store.state.robots[c.id].second?.tmux).toBeUndefined();
    expect(store.state.robots[c.id].second?.revive).toEqual(revive);
  });

  it('keeps the failed resume and its session of a terminal whose fresh start could not be started, to start afresh again', async () => {
    const b = await boot({ pollMs: 60_000 });
    const { fleet, store, tmux } = b;
    const { c } = await withAgent(b);
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    const revive = { command: `claude --resume ${SID}`, interrupted: true as const };
    store.update((d) => { d.robots[c.id].revive = revive; d.robots[c.id].resumeError = 'it did not come up'; });
    // the new session's command never reaches the pane
    vi.spyOn(tmux, 'sendLine').mockRejectedValueOnce(new Error('pane gone')).mockResolvedValue();
    await expect(fleet.startFresh(c.id)).rejects.toThrow('pane gone');
    expect(store.state.robots[c.id]).toMatchObject({ revive, resumeError: 'it did not come up', agent: { sessionId: SID } });
    expect(store.state.robots[c.id].tmux).toBeUndefined();
    expect((await tmux.listWindows()).filter((w) => w.name === c.id)).toEqual([]);
    expect((await fleet.startFresh(c.id)).tmux).toBeDefined();
  });

  it('keeps the failed resume and its session of a second terminal whose fresh start could not be started, to start afresh again', async () => {
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    const OLD = 'ses_0123456789abCDEFGHIJKLMNop';
    const revive = { command: `opencode -s ${OLD}` };
    store.update((d) => {
      d.robots[c.id].second = { cwd: '/tmp', unread: false, agent: { kind: 'opencode', sessionId: OLD, status: 'idle', lastActivityAt: 0 }, revive, resumeError: 'it did not come up' };
    });
    // the new session's command never reaches the pane
    vi.spyOn(tmux, 'sendLine').mockRejectedValueOnce(new Error('pane gone')).mockResolvedValue();
    await expect(fleet.startFresh(c.id, 2)).rejects.toThrow('pane gone');
    expect(store.state.robots[c.id].second).toMatchObject({ revive, resumeError: 'it did not come up', agent: { sessionId: OLD } });
    expect(store.state.robots[c.id].second?.tmux).toBeUndefined();
    expect((await tmux.listWindows()).filter((w) => w.name === `${c.id}-2`)).toEqual([]);
    expect((await fleet.startFresh(c.id, 2)).second?.tmux).toBeDefined();
  });

  it('kills the window of a revive whose robot was closed meanwhile', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    const real = tmux.newWindow.bind(tmux);
    vi.spyOn(tmux, 'newWindow').mockImplementationOnce(async (...a) => {
      const w = await real(...a);
      await fleet.closeRobot(c.id);
      return w;
    });
    await expect(fleet.reviveRobot(c.id)).rejects.toBeInstanceOf(NotFound);
    expect((await tmux.listWindows()).filter((w) => w.name === c.id)).toEqual([]);
  });

  it('kills the window of a revive that opens while the robot is being closed', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    // the revive's window opens while the close is still killing the second terminal
    const open = tmux.newWindow.bind(tmux);
    let opened!: () => void;
    const held = new Promise<void>((r) => { opened = r; });
    vi.spyOn(tmux, 'newWindow').mockImplementationOnce(async (...a) => { const w = await open(...a); await held; return w; });
    const revive = fleet.reviveRobot(c.id);
    revive.catch(() => {});
    const kill = tmux.killWindow.bind(tmux);
    vi.spyOn(tmux, 'killWindow').mockImplementationOnce(async (id) => { opened(); await revive.catch(() => {}); await kill(id); });
    await fleet.closeRobot(c.id);
    await expect(revive).rejects.toBeInstanceOf(NotFound);
    expect((await tmux.listWindows()).filter((w) => w.name === c.id)).toEqual([]);
  });

  it('keeps one recovery going while the control client keeps failing to attach', async () => {
    const { fleet, tmux } = await boot();
    // a tmux -C that exits before it is ready, as when the server goes away between ensureServer and attach
    const connect = vi.spyOn(tmux, 'connect').mockImplementation(() => new ControlClient({ binary: '/usr/bin/false', socket: tmux.socket, conf: '', session: SESSION }));
    fleet['link']['control']!['proc']!.kill();
    // the retries back off 1s, 2s, 4s: the second one lands alone
    await waitFor(() => connect.mock.calls.length >= 2, 5000);
    await new Promise((r) => setTimeout(r, 300));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('ends a recovery under way at a stop, and takes it no further', async () => {
    const { fleet, tmux } = await boot();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // the server comes up only once released, after the quit has begun
    const real = tmux.ensureServer.bind(tmux);
    const ensure = vi.spyOn(tmux, 'ensureServer').mockImplementationOnce(async () => { await held; await real(); });
    const recover = vi.spyOn(fleet['link'] as unknown as { recover: () => Promise<void> }, 'recover');
    const reconcile = vi.spyOn(fleet, 'reconcileNow');
    fleet['link']['control']!['proc']!.kill();
    await waitFor(() => ensure.mock.calls.length === 1);
    setTimeout(release, 100);
    await fleet.stopAll();
    await recover.mock.results[0].value;
    expect(reconcile).not.toHaveBeenCalled();
    await expect(tmux.run('list-sessions')).rejects.toThrow();
  });

  it('spawns one window for concurrent revives', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    const [a, b] = await Promise.all([fleet.reviveRobot(c.id), fleet.reviveRobot(c.id)]);
    expect(a.tmux).toEqual(b.tmux);
    expect((await tmux.listWindows()).filter((w) => w.name === c.id)).toHaveLength(1);
  });

  it('revives a robot marked dormant while its window lived onto that window, without a second one', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    store.update((d) => { delete d.robots[c.id].tmux; d.robots[c.id].revive = { command: 'echo resumed-twice' }; });
    const r = await fleet.reviveRobot(c.id);
    expect(r.tmux).toEqual(c.tmux);
    expect((await tmux.listWindows()).filter((w) => w.name === c.id)).toHaveLength(1);
  });

  it('stops waiting when the robot goes dormant', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope.jsonl' } });
    const wait = fleet.waitFor(c.id, ['done'], 30_000);
    await tmux.killWindow(c.tmux!.windowId);
    expect(await wait).toBe('gone');
    expect(store.state.robots[c.id].tmux).toBeUndefined();
  });

  it('keeps why a resume failed on a terminal while it lies dormant, and lets it go once that terminal comes up', async () => {
    const { fleet, store, tmux } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await fleet.openSecond(c.id);
    const agent = { kind: 'claude' as const, sessionId: '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d', transcriptPath: '/t', status: 'idle' as const, lastActivityAt: 1 };
    store.update((d) => { d.robots[c.id].second!.agent = agent; });
    for (const w of [c.tmux!.windowId, store.state.robots[c.id].second!.tmux!.windowId]) await tmux.killWindow(w);
    await waitFor(() => !store.state.robots[c.id].tmux && !store.state.robots[c.id].second?.tmux);
    const failed = "x's terminal resumed claude session 3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d, which did not report its SessionStart within 60 s";
    store.update((d) => { d.robots[c.id].resumeError = failed; d.robots[c.id].second!.resumeError = failed; });
    // polls that find no window leave it
    await new Promise((r) => setTimeout(r, 450));
    expect([store.state.robots[c.id].resumeError, store.state.robots[c.id].second!.resumeError]).toEqual([failed, failed]);

    await fleet.reviveRobot(c.id);
    expect([store.state.robots[c.id].resumeError, store.state.robots[c.id].second!.resumeError]).toEqual([undefined, failed]);
    await fleet.openSecond(c.id);
    expect(store.state.robots[c.id].second!.resumeError).toBeUndefined();
    // a window found still running for a terminal marked dormant is that terminal come up
    store.update((d) => { delete d.robots[c.id].tmux; d.robots[c.id].revive = { command: '' }; d.robots[c.id].resumeError = failed; });
    await waitFor(() => store.state.robots[c.id].tmux !== undefined);
    expect(store.state.robots[c.id].resumeError).toBeUndefined();
  });

  it('re-attaches a robot whose window is still alive', async () => {
    const { fleet, store } = await boot();
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    store.update((d) => { delete d.robots[c.id].tmux; d.robots[c.id].revive = { command: '' }; });
    await waitFor(() => store.state.robots[c.id].tmux !== undefined);
    expect(store.state.robots[c.id].revive).toBeUndefined();
  });

  it('clears a stale agent status on revive', async () => {
    // no poll runs: the pane sits at a shell prompt, where a poll drops the agent
    const { fleet, store, tmux } = await boot({ pollMs: 60_000 });
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.robots[c.id].tmux === undefined);
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 'sess', transcriptPath: '/nope' } });
    await fleet.onSocketEvent({ hook: { robotId: c.id, backend: 'claude', name: 'Stop' } });
    expect(store.state.robots[c.id].agent?.status).toBe('done');
    store.update((d) => { d.robots[c.id].revive = { command: 'echo revived' }; });
    const r = await fleet.reviveRobot(c.id);
    expect(r.agent?.status).toBe('idle');
    expect(r.unread).toBe(false);
  });
});
