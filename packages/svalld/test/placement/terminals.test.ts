import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Event, type Robot } from '@svall/protocol';
import { dispatch } from '../../src/api/methods.js';
import type { Fleet } from '../../src/fleet.js';
import { HEARTBEAT_MS } from '../../src/link/home.js';
import { silentLogger, type Logger } from '../../src/log.js';
import { REMOTE_SCREEN_BYTES } from '../../src/placement/far-viewers.js';
import type { Store } from '../../src/store.js';
import type { Viewer } from '../../src/terminals.js';
import type { Tmux } from '../../src/tmux/tmux.js';
import { ScreenTails } from '../../src/worker/screens.js';
import { H, W, placed, stopWorlds, until, world } from './world.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await stopWorlds();
});

const b64 = (s: string) => Buffer.from(s).toString('base64');
const output = (data: string): Event => ({ event: 'term.output', data: { id: 'c_1', data: b64(data) } });
const resync = (screen: string): Event => ({ event: 'term.resync', data: { id: 'c_1', screen: b64(screen) } });

// w1's tmux: c_1's pane shows `$ `, its last lines `$ make test\nok`, and what is done to it is kept
function paneTmux() {
  const resized: { windowId: string; cols: number; rows: number }[] = [];
  const keys: { paneId: string; text: string }[] = [];
  const screens: [string, number][] = [];
  const sessions: { name: string; attached: number; created: number }[] = [];
  const pane = { screen: Buffer.from('$ \n') };
  // while held, a screen waits to be read
  let gate: Promise<void> | undefined;
  const hold = () => { let release!: () => void; gate = new Promise((r) => { release = r; }); return () => { gate = undefined; release(); }; };
  const tmux: Partial<Tmux> = {
    viewerScreen: async (paneId, lines) => { screens.push([paneId, lines]); await gate; return pane.screen; },
    resize: async (windowId, cols, rows) => { resized.push({ windowId, cols, rows }); },
    sendBytes: async (paneId, bytes) => { keys.push({ paneId, text: bytes.toString() }); },
    listSessions: async () => sessions,
    autoSize: async () => {},
    capture: async () => Buffer.from('$ make test\nok'),
  };
  return { tmux, resized, keys, screens, sessions, hold, pane };
}

type Seen = Viewer & { got: Event[]; full: boolean };
function viewer(kind: Viewer['kind']): Seen {
  const v: Seen = { kind, got: [], full: false, send: (ev) => { v.got.push(ev); }, backlog: () => (v.full ? 2 * 1024 * 1024 : 0) };
  return v;
}

// the home and w1 linked over sockets the test can cut, newest last, both holding c_1 in its window on w1
async function linked(more: Partial<Robot> = {}, homeLog?: Logger) {
  const pane = paneTmux();
  const c_1 = placed({ id: 'c_1', tmux: { windowId: '@1', paneId: '%1' }, ...more });
  const sockets: net.Socket[] = [];
  const w = world({
    home: { robots: { c_1 } }, worker: { robots: { c_1 } }, tmux: pane.tmux, homeLog,
    connect: async () => {
      const s = net.connect(w.worker.paths.linkSock);
      await once(s, 'connect');
      sockets.push(s);
      return { stream: s, via: { ssh: 'w1', controlSocket: '/tmp/svall-501/1-abc' } };
    },
  });
  await w.link();
  await until(() => { if (!w.worker.connection.connected()) throw new Error('w1 is not linked yet'); });
  return { w, ...pane, sockets, phone: viewer('phone'), other: viewer('app') };
}

const hook = (name: 'PreToolUse' | 'PostToolUse' | 'Stop') => ({ hook: { robotId: 'c_1', backend: 'claude' as const, name } });

describe('the terminal of a robot on a worker', () => {
  it('a phone opening a placed robot\'s terminal gets the worker\'s screen sized to the phone, its keys land in the worker\'s pane, and output streams back to that viewer alone', async () => {
    const { w, resized, keys, screens, phone, other } = await linked();
    expect(await w.home.terminals.open('c_1', 40, 12, 2000, phone)).toBe(b64('$ \n'));
    expect(resized).toEqual([{ windowId: '@1', cols: 40, rows: 12 }]);
    // the link carries no more scrollback than a phone reads
    expect(screens).toEqual([['%1', 500]]);
    await w.home.terminals.input('c_1', Buffer.from('ls\r'));
    expect(keys).toEqual([{ paneId: '%1', text: 'ls\r' }]);
    w.worker.fleet.emit('output', 'c_1', Buffer.from('a.txt\n'));
    await until(() => expect(phone.got).toEqual([output('a.txt\n')]));
    expect(other.got).toEqual([]);
  });

  it('closing one viewer leaves the other\'s terminal open on the worker', async () => {
    const { w, resized, sessions, phone, other } = await linked();
    // a desktop terminal attached on w1 keeps its size from an app viewer, and the phone's size stands anyway
    sessions.push({ name: 'v-c_1', attached: 1, created: 0 });
    await w.home.terminals.open('c_1', 40, 12, 2000, phone);
    await w.home.terminals.open('c_1', 120, 40, 2000, other);
    await w.home.terminals.resize('c_1', 100, 30, other);
    expect(resized).toEqual([{ windowId: '@1', cols: 40, rows: 12 }]);
    expect(w.worker.terminals.viewerCount('c_1')).toBe(2);
    w.home.terminals.close('c_1', other);
    await until(() => expect(w.worker.terminals.viewerCount('c_1')).toBe(1));
    w.worker.fleet.emit('output', 'c_1', Buffer.from('still\n'));
    await until(() => expect(phone.got).toEqual([output('still\n')]));
    expect(other.got).toEqual([]);
    // a viewer gone lets go of all it held there
    w.home.terminals.closeAll(phone);
    await until(() => expect(w.worker.terminals.viewerCount('c_1')).toBe(0));
  });

  it('a close that reaches the worker while that viewer\'s open is under way there lets go of it once the open ends', async () => {
    const { w, screens, hold, phone, other } = await linked();
    await w.home.terminals.open('c_1', 120, 40, 2000, other);
    const release = hold();
    const opening = w.home.terminals.open('c_1', 40, 12, 2000, phone);
    await until(() => expect(screens).toHaveLength(2));
    let closed = 0;
    const far = w.worker.handlers['far.term.close'];
    w.worker.handlers['far.term.close'] = async (p) => { const r = await far(p); closed++; return r; };
    w.home.terminals.close('c_1', phone);
    await until(() => expect(closed).toBe(1));
    release();
    await expect(opening).rejects.toMatchObject({ code: 'gone' });
    expect(w.worker.terminals.viewerCount('c_1')).toBe(1);
    w.worker.fleet.emit('output', 'c_1', Buffer.from('x\n'));
    await until(() => expect(other.got).toEqual([output('x\n')]));
    expect(phone.got).toEqual([]);
  });

  it('a viewer whose socket is full misses output and is resynced once it drains, and the link\'s heartbeat is answered meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const { w, phone, other } = await linked();
    await w.home.terminals.open('c_1', 40, 12, 2000, phone);
    await w.home.terminals.open('c_1', 120, 40, 2000, other);
    // the worker's end of the link is behind: nothing more goes on it
    const behind = vi.spyOn(w.worker.connection, 'backlog').mockReturnValue(2 * 1024 * 1024);
    w.worker.fleet.emit('output', 'c_1', Buffer.from('a\n'));
    w.worker.fleet.emit('output', 'c_1', Buffer.from('b\n'));
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(w.home.links.for(W)?.connected()).toBe(true);
    expect([...phone.got, ...other.got]).toEqual([]);
    behind.mockRestore();
    await until(() => expect(phone.got).toEqual([resync('$ \n')]));
    await until(() => expect(other.got).toEqual([resync('$ \n')]));
  });

  it('a screen afresh too long for a notification reaches the viewer as its last lines, cut whole', async () => {
    const { w, pane, phone } = await linked();
    await w.home.terminals.open('c_1', 40, 12, 2000, phone);
    const rows = Array.from({ length: 12_000 }, (_, i) => `row ${i} ${'x'.repeat(100)}`);
    pane.screen = Buffer.from(`${rows.join('\r\n')}\x1b[12;1H`);
    expect(pane.screen.length).toBeGreaterThan(1.2 * 1024 * 1024);
    w.worker.fleet.emit('continue', 'c_1');
    await until(() => expect(phone.got).toHaveLength(1));
    const got = Buffer.from((phone.got[0] as Extract<Event, { event: 'term.resync' }>).data.screen, 'base64');
    expect(got.length).toBeLessThanOrEqual(REMOTE_SCREEN_BYTES);
    expect(got.length).toBeGreaterThan(REMOTE_SCREEN_BYTES - 200);
    expect(pane.screen.subarray(pane.screen.length - got.length)).toEqual(got);
    expect(got.toString().startsWith('row ')).toBe(true);
  });

  it('a home viewer that falls behind misses a placed robot\'s output and gets its screen afresh from the worker once it drains', async () => {
    const { w, phone, other } = await linked();
    await w.home.terminals.open('c_1', 40, 12, 2000, phone);
    await w.home.terminals.open('c_1', 120, 40, 2000, other);
    phone.full = true;
    w.worker.fleet.emit('output', 'c_1', Buffer.from('a\n'));
    w.worker.fleet.emit('output', 'c_1', Buffer.from('b\n'));
    await until(() => expect(other.got).toEqual([output('a\n'), output('b\n')]));
    expect(phone.got).toEqual([]);
    phone.full = false;
    await until(() => expect(phone.got).toEqual([resync('$ \n')]));
    expect(w.worker.terminals.viewerCount('c_1')).toBe(2);
  });

  it('robot.prompts and robot.answer for a placed robot run on the worker', async () => {
    const { w, keys } = await linked({ agent: { kind: 'claude', sessionId: 's', status: 'blocked', promptId: 'q1', lastActivityAt: 0 } });
    const read = vi.spyOn(w.worker.fleet, 'readPrompts').mockReturnValue(['fix the failing test']);
    expect(await dispatch({ id: 1, method: 'robot.prompts', params: { id: 'c_1' } }, w.home.ctx)).toEqual({ id: 1, result: { prompts: ['fix the failing test'] } });
    expect(read).toHaveBeenCalledWith('c_1', 20);
    expect(await dispatch({ id: 2, method: 'robot.answer', params: { id: 'c_1', answer: 'approve', promptId: 'q1' } }, w.home.ctx)).toEqual({ id: 2, result: {} });
    expect(keys).toEqual([{ paneId: '%1', text: '\r' }]);
  });

  it('the home keeps the screen a worker sent after each hook, at most one in five seconds, and term.lastScreen answers it while robot.read still answers not_reachable', async () => {
    const { w } = await linked();
    const notify = vi.spyOn(w.worker.connection, 'notify');
    const at = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(at);
    await w.worker.fleet.onSocketEvent(hook('PreToolUse'));
    now.mockReturnValue(at + 1000);
    await w.worker.fleet.onSocketEvent(hook('PostToolUse'));
    now.mockRestore();
    await until(() => expect(w.home.terminals.lastScreen('c_1')).toEqual({ text: '$ make test\nok', at }));
    expect(notify.mock.calls.filter(([kind]) => kind === 'screen')).toEqual([['screen', { id: 'c_1', text: '$ make test\nok', at }]]);
    w.home.links.stop();
    expect(await dispatch({ id: 1, method: 'term.lastScreen', params: { id: 'c_1' } }, w.home.ctx)).toEqual({ id: 1, result: { text: '$ make test\nok', at } });
    expect(await dispatch({ id: 2, method: 'robot.read', params: { id: 'c_1' } }, w.home.ctx)).toEqual({ id: 2, error: { code: 'not_reachable', message: 'w1 is not reachable' } });
    expect(await dispatch({ id: 3, method: 'term.lastScreen', params: { id: 'c_2' } }, w.home.ctx)).toEqual({ id: 3, result: { text: '' } });
  });

  it('the home lets go of a robot\'s last screen once its placement changes or it is closed', () => {
    const w = world({ home: { robots: { c_1: placed({ id: 'c_1' }) } } });
    const { terminals, store } = w.home;
    terminals.sawScreen('c_1', 'first stint', 1, W);
    expect(terminals.lastScreen('c_1')).toEqual({ text: 'first stint', at: 1 });
    // a screen from before a move home and out again is not this stint's, even once the generation reads as it did
    store.update((d) => { d.robots.c_1.placement = { generation: 2 }; });
    store.update((d) => { d.robots.c_1.placement = { generation: 1 }; });
    expect(terminals.lastScreen('c_1')).toBeUndefined();
    terminals.sawScreen('c_1', 'on w1', 2, W);
    store.update((d) => { delete d.robots.c_1.machine; });
    store.update((d) => { d.robots.c_1.machine = W; });
    expect(terminals.lastScreen('c_1')).toBeUndefined();
    terminals.sawScreen('c_1', 'on w1', 3, W);
    store.update((d) => { delete d.robots.c_1; });
    store.update((d) => { d.robots.c_1 = placed({ id: 'c_1' }); });
    expect(terminals.lastScreen('c_1')).toBeUndefined();
  });

  it('the link going down resyncs each viewer of that worker\'s robots with the last screen, and coming back reopens their terminals', async () => {
    const { w, phone, sockets } = await linked();
    let opens = 0;
    const far = w.worker.handlers['far.term.open'];
    w.worker.handlers['far.term.open'] = (p) => { opens++; return far(p); };
    await w.home.terminals.open('c_1', 40, 12, 2000, phone);
    await w.worker.fleet.onSocketEvent(hook('Stop'));
    await until(() => expect(w.home.terminals.lastScreen('c_1')?.text).toBe('$ make test\nok'));
    sockets.at(-1)!.destroy();
    await until(() => expect(opens).toBe(2));
    await until(() => expect(phone.got).toEqual([resync('$ make test\nok'), resync('$ \n')]));
    expect(opens).toBe(2);
    expect(w.worker.terminals.viewerCount('c_1')).toBe(1);
  });

  it('a terminal the worker does not open again after the link comes back says why to its viewer and in the log, and is let go of', async () => {
    const errors: string[] = [];
    const { w, phone, sockets } = await linked({}, { ...silentLogger, error: (m) => { errors.push(m); } });
    await w.home.terminals.open('c_1', 40, 12, 2000, phone);
    let closes = 0;
    const close = w.worker.handlers['far.term.close'];
    w.worker.handlers['far.term.close'] = (p) => { closes++; return close(p); };
    w.worker.handlers['far.term.open'] = async () => { throw new ApiError('dormant', 'c_1 is dormant; revive it first'); };
    sockets.at(-1)!.destroy();
    await until(() => expect(phone.got).toEqual([output('\r\nthis terminal did not reopen: c_1 is dormant; revive it first\r\n')]));
    expect(errors).toEqual([`${W}: terminal c_1 did not reopen: c_1 is dormant; revive it first`]);
    await until(() => expect(closes).toBe(1));
    w.worker.fleet.emit('output', 'c_1', Buffer.from('x\n'));
    await new Promise((r) => setTimeout(r, 200));
    expect(phone.got).toHaveLength(1);
  });
});

describe('a worker\'s screen tails', () => {
  it('sends a robot\'s last lines on a hook, and a hook within five seconds of that once they have passed', async () => {
    vi.useFakeTimers({ now: 0 });
    const fleet = new EventEmitter();
    const robots = { c_1: placed({ id: 'c_1', tmux: { windowId: '@1', paneId: '%1' } }), c_2: placed({ id: 'c_2', tmux: { windowId: '@2', paneId: '%2' }, machine: H }) };
    let text = 'one';
    const sent: unknown[] = [];
    const tails = new ScreenTails({
      fleet: fleet as unknown as Fleet, store: { state: { robots } } as unknown as Store, me: W,
      tmux: { capture: async (paneId, lines) => Buffer.from(`${text} ${paneId} ${lines}`) }, connection: { notify: (kind, data) => { sent.push([kind, data]); } },
    });
    tails.start();
    fleet.emit('hook', 'c_1', 'PreToolUse');
    fleet.emit('hook', 'c_2', 'PreToolUse');
    await vi.advanceTimersByTimeAsync(1000);
    text = 'two';
    fleet.emit('hook', 'c_1', 'PostToolUse');
    await vi.advanceTimersByTimeAsync(1000);
    fleet.emit('hook', 'c_1', 'Stop');
    await vi.advanceTimersByTimeAsync(2999);
    expect(sent).toEqual([['screen', { id: 'c_1', text: 'one %1 40', at: 0 }]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([['screen', { id: 'c_1', text: 'one %1 40', at: 0 }], ['screen', { id: 'c_1', text: 'two %1 40', at: 5000 }]]);
    tails.stop();
    fleet.emit('hook', 'c_1', 'Stop');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(2);
  });
});
