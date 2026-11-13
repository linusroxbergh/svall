import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { MachineId } from '@svall/protocol';
import { Config } from '../src/config.js';
import { HomeLinks } from '../src/link/home.js';
import { silentLogger } from '../src/log.js';
import { startDaemon, type Daemon } from '../src/main.js';
import { resolvePaths } from '../src/paths.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

// each memory watch a daemon starts, its hit callback and whether it was stopped
const watches = vi.hoisted(() => [] as { onHit?: (hits: number) => void; stopped: boolean }[]);
vi.mock(import('../src/linux/limits.js'), async (real) => {
  const m = await real();
  return {
    ...m,
    watchMemoryHits: (o: Parameters<typeof m.watchMemoryHits>[0]) => {
      const w = m.watchMemoryHits(o);
      const seen = { onHit: o.onHit, stopped: false };
      watches.push(seen);
      return { ...w, stop: () => { seen.stopped = true; w.stop(); } };
    },
  };
});

const STUDIO = '22222222-3333-4444-8555-666666666666' as MachineId;

/** A window on the daemon: its calls answered by id, and the events it has heard. */
async function window(d: Daemon): Promise<{ call(method: string, params?: unknown): Promise<{ result?: { me?: string } }>; events: { event: string; data: unknown }[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
  const events: { event: string; data: unknown }[] = [];
  const replies = new Map<number, (m: unknown) => void>();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { id?: number; event?: string; data?: unknown };
    if (m.event) events.push({ event: m.event, data: m.data });
    else replies.get(m.id!)?.(m);
  });
  await new Promise((r) => ws.once('open', r));
  const hello = new Promise((r) => replies.set(0, r));
  ws.send(JSON.stringify({ token: d.token }));
  await hello;
  let next = 1;
  return {
    call: (method, params) => new Promise((resolve) => { const id = next++; replies.set(id, resolve as never); ws.send(JSON.stringify({ id, method, params })); }),
    events,
    close: () => ws.close(),
  };
}

const adj = (pid: number): string => fs.readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim();

runIf('the daemon and the memory limit', () => {
  const homes: string[] = [];
  const daemons: Daemon[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of daemons.splice(0)) await d.stop();
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    watches.length = 0;
    cleanHomes();
  });

  const fleetHome = () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(Config.parse({ shell: '/bin/sh' })));
    return { home, tmux: new Tmux(paths.tmuxSock, paths.tmuxConf) };
  };
  const start = async (home: string) => { const d = await startDaemon({ home, port: 0, log: silentLogger }); daemons.push(d); return d; };

  // a pane running sh, with a sleep under it whose pid the pane writes down
  const pane = async (tmux: Tmux, at: string[]): Promise<number[]> => {
    const child = path.join(makeHome(), 'child');
    const pid = Number((await tmux.run(...at, '-P', '-F', '#{pane_pid}', `sleep 600 & echo $! > ${child}; wait`)).trim());
    await waitFor(() => fs.existsSync(child) && fs.readFileSync(child, 'utf8').endsWith('\n'));
    return [pid, Number(fs.readFileSync(child, 'utf8'))];
  };

  it.runIf(process.platform === 'linux')('marks the panes an earlier daemon left running, and what runs in them, as it starts, and those running as a limit is set', async () => {
    const { home, tmux } = fleetHome();
    const kept = await pane(tmux, ['new-session', '-d', '-s', 'kept']);
    expect(kept.map(adj)).toEqual(['0', '0']);
    const d = await start(home);
    expect(kept.map(adj)).toEqual(['500', '500']);
    expect(adj(Number(await tmux.serverPid()))).toBe('0');
    expect(adj(process.pid)).toBe('0');

    const later = await pane(tmux, ['new-window', '-d', '-t', 'kept:']);
    expect(later.map(adj)).toEqual(['0', '0']);
    const w = await window(d);
    const { result } = await w.call('fleet.home');
    // whatever this machine's systemd answers, the panes are marked first
    await w.call('machines.setLimits', { machine: result!.me, cpus: null, memoryMb: 1024 });
    w.close();
    expect(later.map(adj)).toEqual(['500', '500']);
  }, 60_000);

  it.runIf(process.platform === 'linux')('stops its memory watch as it stops, and as a start fails', async () => {
    const { home } = fleetHome();
    const d = await start(home);
    expect(watches.map((w) => w.stopped)).toEqual([false]);
    await d.stop();
    daemons.splice(0);
    expect(watches.map((w) => w.stopped)).toEqual([true]);

    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    try {
      await expect(startDaemon({ home, port: (taken.address() as net.AddressInfo).port, host: '127.0.0.1', log: silentLogger })).rejects.toThrow(/EADDRINUSE/);
    } finally { await new Promise((r) => taken.close(r)); }
    expect(watches.map((w) => w.stopped)).toEqual([true, true]);
  }, 60_000);

  it('tells its windows of a worker\'s hit as the machine its link reaches, whatever the notification says', async () => {
    let links: HomeLinks | undefined;
    const real = HomeLinks.prototype.start;
    vi.spyOn(HomeLinks.prototype, 'start').mockImplementation(function (this: HomeLinks) { links = this; real.call(this); });
    const { home } = fleetHome();
    const d = await start(home);
    d.store.update((s) => { s.machines = { ...s.machines, [STUDIO]: { name: 'studio', reachable: true, since: 0 } }; });
    const w = await window(d);
    const notify = (links as unknown as { o: { onNotify(kind: string, data: unknown, machine: MachineId): void } }).o.onNotify;
    notify('limit.hit', { hits: 3, at: 1_700_000_000_000, machine: '99999999-9999-4999-8999-999999999999', name: 'forged' }, STUDIO);
    await waitFor(() => w.events.some((e) => e.event === 'machines.limitHit'));
    w.close();
    expect(w.events.filter((e) => e.event === 'machines.limitHit').map((e) => e.data)).toEqual([{ machine: STUDIO, name: 'studio', hits: 3, at: 1_700_000_000_000 }]);
  }, 60_000);
});
