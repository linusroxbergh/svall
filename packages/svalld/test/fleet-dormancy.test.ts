import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Proc } from '../src/dormancy.js';
import { Dormant } from '../src/errors.js';
import { Fleet } from '../src/fleet.js';
import { resolvePaths } from '../src/paths.js';
import type { LiveProc } from '../src/load/procs.js';
import { boot, cleanup, pane, SID, stopFleets, withAgent } from './fleet-boot.js';
import { cleanHomes, hasTmux, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('Fleet dormancy', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('has every change on disk once it has stopped', async () => {
    const { fleet, home } = await boot();
    fleet.setDormancy(5);
    await fleet.stop();
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).state, 'utf8')).dormantAfterHours).toBe(5);
  });

  it('waits on and kills only a pid that still runs its agent when it stops for a quit', async () => {
    const b = await boot();
    const { c } = await withAgent(b, 'claude');
    // the pid the agent had now runs another program, which the stop leaves be
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    let signal: string | null = null;
    other.on('exit', (_code, sig) => { signal = sig; });
    b.store.update((d) => { d.robots[c.id].agent!.pid = other.pid!; });
    b.procs.push({ pid: other.pid!, ppid: 1, pgid: other.pid!, args: 'sleep 30' });
    try {
      await b.fleet.stopAll();
      await new Promise((r) => setTimeout(r, 100));
      expect(signal).toBeNull();
      expect(b.store.state.robots[c.id].revive).toEqual({ command: `claude --resume ${SID}` });
    } finally {
      other.kill();
    }
  });

  it('keeps every agent running while dormancy is off', async () => {
    const b = await boot();
    const { fleet, store } = b;
    const { c } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    fleet.setDormancy(0);
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();
    fleet.setDormancy(1);
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeUndefined();
  });

  it('leaves an agent whose pid is gone or runs another program, or whose launch a resume would change', async () => {
    const b = await boot();
    const { fleet, store, procs } = b;
    const { c, pid } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    for (const args of [undefined, 'vim notes.md', 'claude --dangerously-skip-permissions --disallowedTools Bash']) {
      procs.splice(0, procs.length, ...(args ? [{ pid, ppid: 1, pgid: pid, args }] : []));
      await fleet['endIdleAgents']();
      expect(store.state.robots[c.id].tmux).toBeDefined();
    }
    procs.splice(0, procs.length, { pid, ppid: 1, pgid: pid, args: 'claude' });
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeUndefined();
  });

  describe('sleepRobot', () => {
    // the agent's pid and args reach the fleet through the same list the sweep reads; nothing the sleep ends is signalled
    const live = (ps: Proc[]): LiveProc[] => ps.map((p) => ({ pid: p.pid, ppid: p.ppid, start: 0, cpuNs: 0, mem: 0, path: p.args.split(' ')[0], args: p.args }));
    const ended = { kills: 0, waits: 0, gate: Promise.resolve() };
    const reading = { hold: Promise.resolve() };
    const sleepBoot = (extra: { pollMs?: number } = {}) => {
      return boot({
        ...extra,
        readProcs: async () => { await reading.hold; return live(procsRef.list); },
        endOpts: { kill: () => { ended.kills++; }, wait: async () => { ended.waits++; await ended.gate; } },
      }).then((x) => { procsRef.list = x.procs; ended.kills = 0; ended.waits = 0; ended.gate = Promise.resolve(); reading.hold = Promise.resolve(); return x; });
    };
    const procsRef: { list: Proc[] } = { list: [] };
    it('puts a working robot to sleep without marking it interrupted', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      const windowId = c.tmux!.windowId;
      b.store.update((d) => { d.robots[c.id].agent!.status = 'working'; });
      await b.fleet.sleepRobot(c.id);
      const cur = b.store.state.robots[c.id];
      expect(cur.tmux).toBeUndefined();
      expect(cur.revive?.command).toBe(`claude --resume ${SID}`);
      expect(cur.revive?.interrupted).toBeUndefined();
      expect(await b.tmux.hasWindow(windowId)).toBe(false);
    });

    it('closes the second terminal with it', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      const second = (await b.fleet.openSecond(c.id)).second!.tmux!.windowId;
      await b.fleet.sleepRobot(c.id);
      expect(b.store.state.robots[c.id].second).toBeUndefined();
      expect(await b.tmux.hasWindow(second)).toBe(false);
    });

    it('closes a second terminal opened while it read the processes', async () => {
      const b = await sleepBoot({ pollMs: 60_000 });
      const { c } = await withAgent(b);
      let release!: () => void;
      reading.hold = new Promise<void>((r) => { release = r; });
      const sleeping = b.fleet.sleepRobot(c.id);
      const second = (await b.fleet.openSecond(c.id)).second!.tmux!.windowId;
      release();
      await sleeping;
      expect(b.store.state.robots[c.id].second).toBeUndefined();
      expect(await b.tmux.hasWindow(second)).toBe(false);
    });

    it('waits on no second agent whose pid now runs another program', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      await b.fleet.openSecond(c.id);
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      let signal: string | null = null;
      other.on('exit', (_code, sig) => { signal = sig; });
      b.store.update((d) => { d.robots[c.id].second!.agent = { kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0, pid: other.pid! }; });
      b.procs.push({ pid: other.pid!, ppid: 1, pgid: other.pid!, args: 'sleep 30' });
      try {
        await b.fleet.sleepRobot(c.id);
        const done = await Promise.race([Promise.resolve(b.fleet['ending'].get(c.id)).then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
        expect(done).toBe(true);
        expect(signal).toBeNull();
      } finally {
        other.kill();
      }
    });

    it('waits on no dormant second terminal whose stale pid another agent now runs', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      let signal: string | null = null;
      other.on('exit', (_code, sig) => { signal = sig; });
      b.store.update((d) => {
        d.robots[c.id].second = { cwd: '/tmp', unread: false, revive: { command: `claude --resume ${SID}` }, agent: { kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0, pid: other.pid! } };
      });
      b.procs.push({ pid: other.pid!, ppid: 1, pgid: other.pid!, args: 'claude' });
      try {
        await b.fleet.sleepRobot(c.id);
        const done = await Promise.race([Promise.resolve(b.fleet['ending'].get(c.id)).then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
        expect(done).toBe(true);
        expect(signal).toBeNull();
      } finally {
        other.kill();
      }
    });

    it('refuses a robot it could not resume', async () => {
      const b = await sleepBoot();
      const { c, transcriptPath } = await withAgent(b);
      fs.rmSync(transcriptPath);
      const before = structuredClone(b.store.state.robots[c.id]);
      await expect(b.fleet.sleepRobot(c.id)).rejects.toMatchObject({ code: 'invalid', message: `${c.name} can't be put to sleep` });
      expect(b.store.state.robots[c.id]).toEqual(before);
      expect(await b.tmux.hasWindow(c.tmux!.windowId)).toBe(true);
      fs.writeFileSync(transcriptPath, '');
      await b.fleet.sleepRobot(c.id);
      await expect(b.fleet.sleepRobot(c.id)).rejects.toMatchObject({ code: 'invalid' });
    });

    it('leaves a slept robot asleep at the next start', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      b.store.update((d) => { d.robots[c.id].agent!.status = 'working'; });
      await b.fleet.sleepRobot(c.id);
      await b.fleet.resumeInterrupted();
      expect(b.store.state.robots[c.id].tmux).toBeUndefined();
    });
  
    it('makes a revive started right after wait for the agent and what it started to end', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      let release!: () => void;
      ended.gate = new Promise<void>((r) => { release = r; });
      await b.fleet.sleepRobot(c.id);
      const revived = b.fleet.reviveRobot(c.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(b.store.state.robots[c.id].tmux).toBeUndefined();
      release();
      expect((await revived).tmux).toBeDefined();
    });

    it('lets one of two concurrent sleeps win, and ends the robot once', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      const waits = ended.waits;
      const [x, y] = await Promise.allSettled([b.fleet.sleepRobot(c.id), b.fleet.sleepRobot(c.id)]);
      expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected']);
      expect((x.status === 'rejected' ? x : y as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid' });
      await b.fleet['ending'].get(c.id);
      expect(ended.waits - waits).toBe(1);
    });

    it('leaves a second terminal that ran an agent dormant with the session it resumes and its launch flags, and closes its window', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      const { windowId: second, paneId } = (await b.fleet.openSecond(c.id)).second!.tmux!;
      const pid = Number((await b.tmux.run('display', '-p', '-t', paneId, '#{pane_pid}')).trim());
      b.procs.push({ pid, ppid: 1, pgid: pid, args: 'claude --effort xhigh' });
      const sessionId = '11111111-1111-4111-8111-111111111111';
      b.store.update((d) => { d.robots[c.id].second!.agent = { kind: 'claude', sessionId, transcriptPath: '/t', status: 'idle', lastActivityAt: 1, pid }; });
      await b.fleet.sleepRobot(c.id);
      expect(b.store.state.robots[c.id].second?.tmux).toBeUndefined();
      expect(b.store.state.robots[c.id].second?.revive).toEqual({ command: `claude --effort 'xhigh' --resume ${sessionId}` });
      expect(await b.tmux.hasWindow(second)).toBe(false);
    });

    it('gives no reconcile the windows it is closing, so a dormant second terminal is not taken back', async () => {
      const b = await sleepBoot();
      const { c } = await withAgent(b);
      await b.fleet.openSecond(c.id);
      b.store.update((d) => { d.robots[c.id].second!.agent = { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'idle', lastActivityAt: 1 }; });
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const kill = b.tmux.killWindow.bind(b.tmux);
      vi.spyOn(b.tmux, 'killWindow').mockImplementation(async (id) => { await held; await kill(id); });
      const sleeping = b.fleet.sleepRobot(c.id);
      await waitFor(() => b.store.state.robots[c.id].tmux === undefined);
      await b.fleet.reconcileNow();
      expect(b.store.state.robots[c.id].tmux).toBeUndefined();
      expect(b.store.state.robots[c.id].second?.tmux).toBeUndefined();
      release();
      await sleeping;
    });
  });

  it('leaves an agent with work in the background, or no transcript to resume from', async () => {
    const b = await boot();
    const { fleet, store, procs } = b;
    const { c, pid, transcriptPath } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    // a dev server the Bash tool started, in a process group of its own
    procs.push({ pid: 99_001, ppid: pid, pgid: 99_001, args: 'zsh -c pnpm dev' });
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();
    procs.pop();
    fs.rmSync(transcriptPath);
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();
  });

  it('leaves an agent with a second terminal open', async () => {
    const b = await boot();
    const { fleet, store } = b;
    const { c } = await withAgent(b);
    await fleet.openSecond(c.id);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();
    expect(store.state.robots[c.id].second).toBeDefined();
  });

  it('leaves an agent with a prompt held for it', async () => {
    const b = await boot();
    const { fleet, store } = b;
    const { c } = await withAgent(b);
    vi.spyOn(b.tmux, 'screen').mockResolvedValue(pane('claude-draft'));
    expect(await fleet.run(c.id, 'go', true)).toBe('queued');
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();
  });

  it('gives a robot the user has just looked at a whole rest before its agent is ended', async () => {
    const b = await boot();
    const { fleet, store } = b;
    const { c } = await withAgent(b);
    store.update((d) => { d.robots[c.id].unread = true; d.robots[c.id].agent!.status = 'done'; d.robots[c.id].agent!.lastActivityAt = 0; });
    fleet.markSeen(c.id);
    await fleet['endIdleAgents']();
    expect(store.state.robots[c.id].tmux).toBeDefined();
    // the look leaves the agent's own last activity as it was
    expect(store.state.robots[c.id].agent!.lastActivityAt).toBe(0);
  });

  it('gives every agent awake at a daemon start a whole rest before ending it', async () => {
    const b = await boot();
    const { c } = await withAgent(b);
    b.store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    await b.fleet.stop();
    const again = new Fleet({ ...b.fleet['deps'], pollMs: 60_000 });
    cleanup.push(() => again.stop());
    await again.start();
    await again['endIdleAgents']();
    expect(b.store.state.robots[c.id].tmux).toBeDefined();
  });

  it('wakes a dormant claude with a prompt run into it, as its launch prompt', async () => {
    const b = await boot();
    const { fleet, store, tmux, home } = b;
    const { c } = await withAgent(b);
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    await fleet['endIdleAgents']();
    await expect(fleet.run(c.id, 'run the tests again', false)).rejects.toThrow(Dormant);
    // what would be typed is kept, so no real claude starts
    const typed: string[] = [];
    vi.spyOn(tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
    await fleet.run(c.id, 'run the tests again', true);
    expect(store.state.robots[c.id].tmux).toBeDefined();
    const file = path.join(home, `${c.id}.prompt`);
    expect(typed).toEqual([`claude --resume ${SID} -- "$(cat '${file}'; rm -f '${file}')"`]);
    expect(fs.readFileSync(file, 'utf8')).toBe('run the tests again');
  });

  it('wakes a dormant codex with a prompt run into it, as its launch prompt', async () => {
    const b = await boot();
    const { fleet, store, tmux, home } = b;
    const { c } = await withAgent(b, 'codex', 'sleep 600', 'codex');
    store.update((d) => { d.robots[c.id].agent!.lastActivityAt = 0; });
    await fleet['endIdleAgents']();
    const typed: string[] = [];
    vi.spyOn(tmux, 'sendLine').mockImplementation(async (_pane, text) => { typed.push(text); });
    await fleet.run(c.id, 'run the tests again', true);
    const file = path.join(home, `${c.id}.prompt`);
    expect(typed).toEqual([`codex resume --no-daemon -c check_for_update_on_startup=false -c tui.resume_cwd=session ${SID} -- "$(cat '${file}'; rm -f '${file}')"`]);
  });
});
