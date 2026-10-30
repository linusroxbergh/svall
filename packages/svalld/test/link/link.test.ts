import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, emptyState, type FleetState, type LinkFrame, type Robot } from '@svall/protocol';
import { HEARTBEAT_MS, HomeLinks, UnknownEvent, type Transport } from '../../src/link/home.js';
import { LinkStream, MAX_LINE, PART_REPLY } from '../../src/link/stream.js';
import { HomeConnection, SILENT_MS } from '../../src/link/worker.js';
import { silentLogger, type Logger } from '../../src/log.js';
import type { MachineEntry } from '../../src/machine.js';
import { resolvePaths } from '../../src/paths.js';
import { issueToken, tokenFor } from '../../src/placement/workers.js';
import { Store } from '../../src/store.js';
import { Outbox } from '../../src/worker/outbox.js';
import { applyReport, ownedReport, type RobotSync } from '../../src/worker/snapshot.js';
import { cleanHomes, makeHome } from '../helpers.js';

const W = MachineId.parse(crypto.randomUUID());
const H = MachineId.parse(crypto.randomUUID());
const entry: MachineEntry = { id: W, record: { name: 'vault', ssh: 'vault', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.svall' } };
// in the registry, with no token of this fleet's
const SPARE = MachineId.parse(crypto.randomUUID());
const spare: MachineEntry = { id: SPARE, record: { ...entry.record, name: 'spare', ssh: 'spare' } };
const agentHomes = { claude: '/Users/ada/.claude', codex: '/Users/ada/.codex', opencode: '/Users/ada/.config/opencode' };
const via = { ssh: 'vault', controlSocket: '/tmp/svall-501/1-abc' };

const island = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
const robot = (o: Partial<Robot> = {}): Robot => ({
  id: 'r_1', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'r', note: '', portrait: 'owl', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
  machine: W, placement: { generation: 1 }, ...o,
});
const fleet = (r: Robot): FleetState => ({ ...emptyState(), islands: { i_1: island }, robots: { [r.id]: r } });
const report = (cwd: string): RobotSync => ownedReport(robot({ cwd }));

function storeWith(home: string, state: FleetState): Store {
  const store = Store.load(path.join(home, 'state.json'), () => {});
  store.update((d) => { Object.assign(d, structuredClone(state)); });
  return store;
}

// real sockets under a loaded run; with fake timers each look advances them by `interval`
const until = (check: () => void, interval = 50) => vi.waitFor(check, { timeout: 5000, interval });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanHomes();
});

// a unix socket onto the worker's link.sock, as the far `svall worker link` would be
const socketTo = (sock: string): Transport => async () => {
  const stream = net.connect(sock);
  await once(stream, 'connect');
  return { stream, via };
};

// the versions a home on this build greets a worker with
const HELLO = { release: '1.2.3', schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION };

// A home and a worker, each with a store of its own, and the worker's outbox; the home holds r_1 placed on the worker.
// `versions`: the state schema and link protocol the worker says it speaks.
function world(o: {
  handlers?: Record<string, (p: unknown) => Promise<unknown>>; log?: Logger; workerLog?: Logger; versions?: { schema: number; protocol: number }; onEvent?: (kind: string) => Promise<void>;
} = {}) {
  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  const token = issueToken(homePaths, W);
  const home = storeWith(homePaths.home, fleet(robot({ name: 'named at home' })));
  const store = storeWith(workerPaths.home, fleet(robot({ name: 'stale', cwd: '/w/now', tmux: { windowId: '@1', paneId: '%1' } })));
  const outbox = Outbox.open(workerPaths);
  const fleetId = FleetId.parse(crypto.randomUUID());
  // what the worker's onLink and the home's onNotify, onSynced and onLost were called with
  const linked: boolean[] = [];
  const notified: [string, unknown, MachineId][] = [];
  const synced: MachineId[] = [];
  const lost: MachineId[] = [];
  // the worker's daemon over `journal`, as it starts again over a journal that was wiped or lost a file
  const workerOn = (journal: Outbox) => {
    const connection = new HomeConnection({
      paths: workerPaths, worker: { homeMachineId: H, fleetId, token, homeName: 'mac' }, me: W, store, outbox: journal,
      log: o.workerLog ?? silentLogger, release: '1.2.3', bootId: 'boot-1', handlers: o.handlers ?? {}, ...(o.versions && { versions: o.versions }),
      onLink: (live) => linked.push(live),
    });
    stops.push(() => connection.stop());
    return connection;
  };
  const worker = workerOn(outbox);
  // what the home took, in the order it took it
  const seen: string[] = [];
  const reports: string[] = [];
  let version = 100;
  let snapshots = 0;
  // `hooks` in place of the ones that record
  type Hooks = Pick<ConstructorParameters<typeof HomeLinks>[0], 'onNotify' | 'onSynced' | 'onLost'>;
  const links = (connect: Transport = socketTo(workerPaths.linkSock), hooks: Hooks = {}) => {
    const l = new HomeLinks({
      paths: homePaths, store: home, log: o.log ?? silentLogger, release: '1.2.3', machines: () => [entry, spare], connect,
      onReport: (r, machine) => { seen.push(`report ${r.fields.cwd}`); reports.push(r.fields.cwd); applyReport(home, r, machine); },
      onEvent: async (kind) => { await o.onEvent?.(kind); seen.push(`event ${kind}`); },
      onInventory: async (inv, machine) => { seen.push(`inventory ${machine === W ? 'from vault' : machine} last ${inv.last} acked ${inv.acked} robots ${inv.robots.map((r) => r.fields.cwd).join(',')}`); },
      snapshot: () => { snapshots++; return { version: ++version, state: home.state, agentHomes, home: '/Users/ada' }; },
      onNotify: (kind, data, machine) => notified.push([kind, data, machine]),
      onSynced: (machine) => synced.push(machine),
      onLost: (machine) => lost.push(machine),
      ...hooks,
    });
    stops.push(() => l.stop());
    return l;
  };
  return { homePaths, workerPaths, home, store, outbox, worker, workerOn, links, seen, reports, snapshots: () => snapshots, linked, notified, synced, lost };
}

describe('workers.json', () => {
  it('holds a token per machine, readable by its owner alone', () => {
    const paths = resolvePaths(makeHome());
    expect(tokenFor(paths, W)).toBeUndefined();
    const token = issueToken(paths, W);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(tokenFor(paths, W)).toBe(token);
    expect(issueToken(paths, H)).not.toBe(token);
    expect(JSON.parse(fs.readFileSync(paths.workersFile, 'utf8'))).toEqual({ [W]: { token, addedAt: expect.any(Number) }, [H]: expect.any(Object) });
    expect(fs.statSync(paths.workersFile).mode & 0o777).toBe(0o600);
  });
});

describe('the link', () => {
  it('the worker refuses a hello whose token is wrong and closes', async () => {
    const w = world();
    await w.worker.start();
    const open = async (first: LinkFrame) => {
      const sock = net.connect(w.workerPaths.linkSock);
      await once(sock, 'connect');
      const got: LinkFrame[] = [];
      let closed!: () => void;
      const gone = new Promise<void>((r) => { closed = r; });
      const stream = new LinkStream(sock, { onFrame: (f) => got.push(f), onClose: () => closed() });
      stream.send(first);
      return { got, gone, stream };
    };
    for (const first of [{ t: 'hello', token: 'b'.repeat(48) }, { t: 'hello' }, { t: 'ping' }] as LinkFrame[]) {
      const { got, gone } = await open(first);
      await gone;
      expect(got).toEqual([]);
      expect(w.worker.connected()).toBe(false);
    }
    // the token worker.json holds is answered
    const { got, stream } = await open({ t: 'hello', token: tokenFor(w.homePaths, W)!, ...HELLO });
    await until(() => expect(got.map((f) => f.t)).toEqual(['hello', 'inventory']));
    stream.close();
  });

  it('the worker sends nothing past its inventory until the home acks, then the outbox after that seq, each entry once', async () => {
    const w = world();
    w.outbox.append('robot.sync', report('/w/1'));
    w.outbox.append('robot.sync', report('/w/2'));
    await w.worker.start();
    const sock = net.connect(w.workerPaths.linkSock);
    await once(sock, 'connect');
    const got: LinkFrame[] = [];
    const stream = new LinkStream(sock, { onFrame: (f) => got.push(f), onClose: () => {} });
    stream.send({ t: 'hello', token: tokenFor(w.homePaths, W)!, ...HELLO });
    await until(() => expect(got).toHaveLength(2));
    expect(got[1]).toEqual({ t: 'inventory', robots: [ownedReport(w.store.state.robots.r_1)], last: 2, acked: 0, epoch: w.outbox.epoch() });
    // a report while the home has not said where to start is journaled, and sent with the rest
    w.worker.report(report('/w/3'));
    expect(w.worker.connected()).toBe(false);
    stream.send({ t: 'ack', seq: 1 });
    await until(() => expect(got).toHaveLength(4));
    w.worker.report(report('/w/4'));
    await until(() => expect(got).toHaveLength(5));
    expect(got.slice(2).map((f) => (f.t === 'event' ? `${f.seq} ${(f.data as RobotSync).fields.cwd}` : f.t))).toEqual(['2 /w/2', '3 /w/3', '4 /w/4']);
    expect(w.outbox.acked()).toBe(1);
    stream.close();
  });

  it('on connect the home gets inventory, then the events after its last ack, then pushes a snapshot', async () => {
    const w = world();
    w.outbox.append('robot.sync', report('/w/1'));
    w.outbox.append('robot.sync', report('/w/2'));
    w.outbox.append('robot.sync', report('/w/3'));
    w.outbox.ack(1);
    w.store.subscribe(() => { w.seen.push(`snapshot taken: ${w.store.state.robots.r_1.name}`); });
    // the home batches its writes, as the daemon's store does; each ack finds its event's change, or a later one's, on disk
    w.home.batchWrites();
    const onDisk: string[] = [];
    const ack = w.outbox.ack.bind(w.outbox);
    w.outbox.ack = (seq) => { onDisk.push(`${seq} ${Store.load(path.join(w.homePaths.home, 'state.json'), () => {}).state.robots.r_1.cwd}`); ack(seq); };
    await w.worker.start();
    // a worker account whose home holds a space and a letter outside ASCII
    vi.stubEnv('HOME', '/home/ada lovelace/Åsa');
    const links = w.links();
    links.start();

    await until(() => expect(w.seen).toContain('snapshot taken: named at home'));
    expect(w.seen).toEqual([
      'report /w/2',
      'report /w/3',
      'inventory from vault last 3 acked 1 robots /w/now',
      'snapshot taken: named at home',
    ]);
    const link = links.for(W)!;
    expect(link.hello()).toEqual({
      t: 'hello', workerMachineId: W, bootId: 'boot-1', release: '1.2.3', schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION, home: '/home/ada lovelace/Åsa',
      agentHomes: { claude: '/home/ada lovelace/Åsa/.claude', codex: '/home/ada lovelace/Åsa/.codex', opencode: '/home/ada lovelace/Åsa/.config/opencode' },
    });
    expect(link.via()).toEqual(via);
    // every event the home took was acknowledged, and the worker trimmed its outbox to match
    await until(() => expect(w.outbox.acked()).toBe(3));
    expect(onDisk).toEqual(['1 /tmp', expect.stringMatching(/^2 \/w\/[23]$/), '3 /w/3']);
    expect(link.outboxDrained()).toBe(true);
    expect(Outbox.open(w.workerPaths).after(0)).toEqual([]);
    expect(w.home.state.robots.r_1).toMatchObject({ name: 'named at home', cwd: '/w/3' });
    // the snapshot kept what the worker owns of a robot placed here
    expect(w.store.state.robots.r_1).toMatchObject({ name: 'named at home', cwd: '/w/now', tmux: { windowId: '@1', paneId: '%1' } });
    expect(Store.load(path.join(w.workerPaths.home, 'state.json'), () => {}).state.robots.r_1.name).toBe('named at home');
  });

  it('pushSnapshot sends one snapshot for every call within 250 ms and resolves once the worker has taken it', async () => {
    const w = world();
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.store.state.robots.r_1.name).toBe('named at home'));
    const before = w.snapshots();

    w.home.update((d) => { d.robots.r_1.name = 'renamed'; });
    const pushes = [links.pushSnapshot(), links.pushSnapshot(), links.pushSnapshot()];
    const version = await pushes[0];
    expect(await Promise.all(pushes)).toEqual([version, version, version]);
    expect(w.store.state.robots.r_1.name).toBe('renamed');
    // the store's own change and the three calls went out as one
    expect(w.snapshots()).toBe(before + 1);
  });

  it('reports made while the home is away arrive after reconnect as the newest of each robot, in sequence with the rest', async () => {
    const w = world();
    await w.worker.start();
    const first = w.links();
    first.start();
    await until(() => expect(first.for(W)?.outboxDrained()).toBe(true));
    w.worker.report(report('/w/live'));
    await until(() => expect(w.outbox.acked()).toBe(1));

    let writes = 0;
    const counting = w.home.subscribe(() => { writes++; });
    first.stop();
    await until(() => expect(w.worker.connected()).toBe(false));
    // a home that stops leaves the fleet as it was
    expect(writes).toBe(0);
    counting();
    w.worker.report(report('/w/away-1'));
    w.worker.journal('docs.write', {});
    w.worker.report(report('/w/away-2'));
    expect(Outbox.open(w.workerPaths).after(1).map((e) => `${e.seq} ${e.kind}`)).toEqual(['3 docs.write', '4 robot.sync']);

    const second = w.links();
    second.start();
    await until(() => expect(second.for(W)?.outboxDrained()).toBe(true));
    await until(() => expect(w.outbox.acked()).toBe(4));
    expect(w.reports).toEqual(['/w/live', '/w/away-2']);
    expect(w.seen.slice(-3, -1)).toEqual(['event docs.write', 'report /w/away-2']);
    expect(w.home.state.robots.r_1.cwd).toBe('/w/away-2');
  });

  it('a report that replaced one sent and never acked is all that replays after the stream drops', async () => {
    const w = world();
    await w.worker.start();
    const connect = async () => {
      const sock = net.connect(w.workerPaths.linkSock);
      await once(sock, 'connect');
      const got: LinkFrame[] = [];
      const stream = new LinkStream(sock, { onFrame: (f) => got.push(f), onClose: () => {} });
      stream.send({ t: 'hello', token: tokenFor(w.homePaths, W)!, ...HELLO });
      await until(() => expect(got).toHaveLength(2));
      stream.send({ t: 'ack', seq: 0 });
      await until(() => expect(w.worker.connected()).toBe(true));
      return { got, stream };
    };
    const events = (got: LinkFrame[]) => got.flatMap((f) => (f.t === 'event' ? [`${f.seq} ${(f.data as RobotSync).fields.cwd}`] : []));
    const first = await connect();
    w.worker.report(report('/w/1'));
    w.worker.report(report('/w/2'));
    await until(() => expect(events(first.got)).toEqual(['1 /w/1', '2 /w/2']));
    first.stream.close();
    await until(() => expect(w.worker.connected()).toBe(false));
    w.worker.report(report('/w/3'));

    const second = await connect();
    expect(second.got[1]).toMatchObject({ t: 'inventory', last: 3, acked: 0 });
    await until(() => expect(events(second.got)).toEqual(['3 /w/3']));
    second.stream.send({ t: 'ack', seq: 3 });
    await until(() => expect(w.outbox.acked()).toBe(3));
    expect(Outbox.open(w.workerPaths).after(0)).toEqual([]);
    second.stream.close();
  });

  it('machines[id].reachable flips to false within a heartbeat when the stream dies and back on reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const w = world();
    await w.worker.start();
    // a link that can go silent without closing, as one whose network went away does
    let cut = () => {};
    const links = w.links(async () => {
      const sock = net.connect(w.workerPaths.linkSock);
      await once(sock, 'connect');
      const incoming = new PassThrough();
      sock.pipe(incoming);
      cut = () => sock.unpipe(incoming);
      return { stream: Duplex.from({ readable: incoming, writable: sock }), via };
    });
    const machine = () => w.home.state.machines?.[W];
    links.start();
    await until(() => expect(machine()).toMatchObject({ name: 'vault', reachable: true, release: '1.2.3' }), 1);
    const linkedAt = machine()!.since;

    cut();
    // a ping goes out and is not answered; the next beat finds it so
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(machine()?.reachable).toBe(true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(machine()).toMatchObject({ name: 'vault', reachable: false, release: '1.2.3' });
    expect(machine()!.since).toBeGreaterThan(linkedAt);
    expect(links.for(W)?.connected()).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => expect(machine()?.reachable).toBe(true), 1);
    await until(() => expect(w.worker.connected()).toBe(true), 1);
  });

  it('the worker closes a linked stream that brings nothing for three heartbeats, as a Mac asleep leaves it, and forwards no call after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const logged: string[] = [];
    const w = world({ workerLog: { info() {}, error: (m) => logged.push(m) } });
    await w.worker.start();
    const sock = net.connect(w.workerPaths.linkSock);
    await once(sock, 'connect');
    let pongs = 0;
    let closed = false;
    const stream = new LinkStream(sock, { onFrame: (f) => { if (f.t === 'pong') pongs++; }, onClose: () => { closed = true; } });
    stream.send({ t: 'hello', token: tokenFor(w.homePaths, W)!, ...HELLO });
    stream.send({ t: 'ack', seq: 0 });
    await until(() => expect(w.worker.connected()).toBe(true), 1);
    // a home that pings stays linked
    for (let beat = 1; beat <= 6; beat++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      stream.send({ t: 'ping' });
      await until(() => expect(pongs).toBe(beat), 1);
    }
    expect(w.worker.connected()).toBe(true);

    await vi.advanceTimersByTimeAsync(SILENT_MS - 5000);
    expect(w.worker.connected()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.worker.connected()).toBe(false);
    expect(w.linked).toEqual([true, false]);
    expect(logged).toEqual(["link: mac's stream closed: nothing arrived for 45 s"]);
    await until(() => expect(closed).toBe(true), 1);
    await expect(w.worker.call('robot.update', {})).rejects.toMatchObject({ code: 'not_reachable', message: 'mac is not reachable' });
  });

  it('retries a worker it cannot reach after 1 s, doubling to 60 s, and from 1 s again once it has linked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const w = world();
    const tries: number[] = [];
    const sockets: net.Socket[] = [];
    let refuse = true;
    const links = w.links(async (e) => {
      tries.push(Date.now());
      if (refuse) throw new Error('ssh: connect to host vault port 22: Connection refused');
      const r = await socketTo(w.workerPaths.linkSock)(e);
      sockets.push(r.stream as net.Socket);
      return r;
    });
    const start = Date.now();
    links.start();
    await vi.advanceTimersByTimeAsync(183_000);
    expect(tries.map((t) => (t - start) / 1000)).toEqual([0, 1, 3, 7, 15, 31, 63, 123, 183]);
    expect(w.home.state.machines?.[W]).toMatchObject({ name: 'vault', reachable: false });

    refuse = false;
    await w.worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => expect(links.for(W)?.outboxDrained()).toBe(true), 1);
    const pushed = links.pushSnapshot();
    await vi.advanceTimersByTimeAsync(250);
    await pushed;

    sockets.at(-1)!.destroy();
    await until(() => expect(w.home.state.machines?.[W]?.reachable).toBe(false), 1);
    const lostAt = w.home.state.machines![W]!.since;
    const before = tries.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries.slice(before).map((t) => t - lostAt)).toEqual([1000]);
  });

  it("skips a report this svalld cannot read, saying so in its robot's note when that robot runs there, and the link goes on", async () => {
    const logged: string[] = [];
    const w = world({ log: { info() {}, error: (m) => logged.push(m) } });
    w.home.update((d) => { d.robots.r_2 = robot({ id: 'r_2', name: 'at home', machine: H }); });
    // a report this home can read, then two it cannot, as a worker on another build could journal
    w.outbox.append('robot.sync', report('/w/before'));
    w.outbox.append('robot.sync', { robotId: 'r_2' });
    w.outbox.append('robot.sync', { robotId: 'r_1' });
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.outbox.acked()).toBe(3));
    expect([links.for(W)?.connected(), w.home.state.machines?.[W]?.replayed?.seq]).toEqual([true, 3]);
    expect(w.reports).toEqual(['/w/before']);
    const why = '✖ Invalid input: expected number, received undefined → at generation ✖ Invalid input: expected object, received undefined → at fields';
    expect(w.home.state.robots.r_1).toMatchObject({ note: `vault sent a report on this robot that this Mac cannot read; it was skipped: ${why}`, noteSource: 'manual' });
    expect(w.home.state.robots.r_2.note).toBe('');
    expect(logged).toEqual([2, 3].map((seq) => `vault: event ${seq} (robot.sync) is a report this svalld cannot read; skipped: ${why}`));
  });

  it('an event that fails to apply the same way on every link, as on a full disk, is never skipped, its retry doubling, and is taken once it passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let tried = 0;
    const w = world({ onEvent: async (kind) => { if (kind === 'docs.write' && ++tried <= 3) throw new Error('ENOSPC: no space left on device, write'); } });
    w.outbox.append('docs.write', {});
    await w.worker.start();
    const tries: number[] = [];
    const downs: number[] = [];
    w.home.subscribe(() => {
      const m = w.home.state.machines?.[W];
      if (m && !m.reachable && m.since !== downs.at(-1)) downs.push(m.since);
    });
    const links = w.links(async (e) => { tries.push(Date.now()); return socketTo(w.workerPaths.linkSock)(e); });
    links.start();
    // each link fails after its hello, so its backoff keeps growing
    for (const gap of [1000, 2000, 4000]) {
      await until(() => expect(downs).toHaveLength(tries.length), 1);
      expect(w.outbox.acked()).toBe(0);
      await vi.advanceTimersByTimeAsync(gap);
      expect(tries.at(-1)! - downs.at(-1)!).toBe(gap);
    }
    await until(() => expect(w.outbox.acked()).toBe(1), 1);
    expect([tried, w.seen]).toEqual([4, ['event docs.write', 'inventory from vault last 1 acked 0 robots /w/now']]);
  });

  it("the worker refuses a call to the home past the link's line limit, and the link stays up", async () => {
    const w = world();
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.worker.connected()).toBe(true));
    await expect(w.worker.call('robot.update', { id: 'r_1', note: 'x'.repeat(MAX_LINE) })).rejects.toMatchObject({
      code: 'too_large', message: expect.stringMatching(/^this change is \d+ bytes, over the 2097152 the link to mac carries$/),
    });
    expect([w.worker.connected(), links.for(W)?.connected()]).toEqual([true, true]);
  });

  it("the worker journals an event up to the link's line limit, which the home takes, and refuses one past it; a report past it is logged", async () => {
    const logged: string[] = [];
    const w = world({ workerLog: { info() {}, error: (m) => logged.push(m) } });
    const frame = (text: string) => Buffer.byteLength(JSON.stringify({ t: 'event', seq: Number.MAX_SAFE_INTEGER, kind: 'big', data: { text } }));
    const fits = 'x'.repeat(MAX_LINE - frame(''));
    const caught = (run: () => void): unknown => { try { run(); } catch (e) { return e; } };
    expect(caught(() => w.worker.journal('big', { text: `${fits}x` }))).toMatchObject({ code: 'too_large', message: `this change is ${MAX_LINE + 1} bytes, over the ${MAX_LINE} the link to mac carries` });
    expect(w.outbox.last()).toBe(0);
    const over = report('/w/1');
    w.worker.report({ ...over, fields: { ...over.fields, cwd: fits } });
    expect(logged).toEqual([expect.stringMatching(/^link: r_1's report was not journaled: this change is \d+ bytes, over the 2097152 the link to mac carries$/)]);
    expect(w.outbox.last()).toBe(0);

    expect(w.worker.journal('big', { text: fits })).toBe(1);
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.outbox.acked()).toBe(1));
    expect(w.seen).toContain('event big');
  });

  it('acks no event whose change did not reach the disk, and takes it once it does', async () => {
    const logged: string[] = [];
    const w = world({ log: { info() {}, error: (m) => logged.push(m) } });
    // the home batches its writes, as the daemon's store does
    w.home.batchWrites();
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(links.for(W)?.outboxDrained()).toBe(true));
    // stands in for a full disk
    fs.chmodSync(w.homePaths.home, 0o500);
    try {
      w.worker.report(report('/w/unwritten'));
      await until(() => expect(w.worker.connected()).toBe(false));
      expect(w.outbox.acked()).toBe(0);
      expect(Outbox.open(w.workerPaths).after(0)).toHaveLength(1);
      // the next stream finds the event taken but not on disk, and acks it only once it is
      await until(() => expect(logged).toContain('vault: the inventory not taken, closing the link: state.json was not written'));
      expect(w.outbox.acked()).toBe(0);
    } finally {
      fs.chmodSync(w.homePaths.home, 0o700);
    }
    await until(() => expect(w.outbox.acked()).toBe(1));
    expect(Store.load(path.join(w.homePaths.home, 'state.json'), () => {}).state.robots.r_1.cwd).toBe('/w/unwritten');
  });

  it('an event the home took whose ack was lost is acked and not applied again', async () => {
    const w = world();
    w.worker.journal('x', {});
    w.worker.journal('x', {});
    await w.worker.start();
    let first = true;
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      if (!first) return r;
      first = false;
      const sock = r.stream as net.Socket;
      // the home's ack of seq 2 is lost with the stream
      const out = new Writable({
        write(chunk: Buffer, _enc, done) {
          if (String(chunk).includes('{"t":"ack","seq":2}')) { sock.destroy(); done(); return; }
          sock.write(chunk, done);
        },
      });
      return { stream: Duplex.from({ readable: sock, writable: out }), via };
    });
    links.start();
    await until(() => expect(w.outbox.acked()).toBe(2));
    await until(() => expect(links.for(W)?.outboxDrained()).toBe(true));
    expect(first).toBe(false);
    expect(w.seen.filter((s) => s === 'event x')).toHaveLength(2);
    expect(w.home.state.machines?.[W]?.replayed).toEqual({ epoch: w.outbox.epoch(), seq: 2 });
  });

  it('a journal restored behind what the home replayed of its epoch has its next seqs applied', async () => {
    const w = world();
    w.outbox.append('x', {});
    w.outbox.append('x', {});
    w.outbox.ack(2);
    // the home took seqs 3 to 5 of this epoch before the worker's journal went back to a copy of it at seq 2
    w.home.update((d) => { d.machines = { [W]: { name: 'vault', reachable: false, since: 1, replayed: { epoch: w.outbox.epoch(), seq: 5 } } }; });
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(links.for(W)?.outboxDrained()).toBe(true));
    for (let n = 0; n < 3; n++) w.worker.journal('restored', {});
    await until(() => expect(w.outbox.acked()).toBe(5));
    expect(w.seen.filter((s) => s === 'event restored')).toHaveLength(3);
    expect(links.for(W)?.outboxDrained()).toBe(true);
    expect(w.home.state.machines?.[W]?.replayed).toEqual({ epoch: w.outbox.epoch(), seq: 5 });
  });

  it('a link drop keeps replayed and home on the machine entry, and a matching hello after a mismatch clears mismatch', async () => {
    const versions = { schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION };
    const w = world({ versions });
    w.worker.journal('x', {});
    await w.worker.start();
    vi.stubEnv('HOME', '/home/ada');
    const sockets: net.Socket[] = [];
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      sockets.push(r.stream as net.Socket);
      return r;
    });
    const machine = () => w.home.state.machines?.[W];
    links.start();
    await until(() => expect(links.for(W)?.outboxDrained()).toBe(true));
    const replayed = { epoch: w.outbox.epoch(), seq: 1 };
    expect(machine()).toMatchObject({ reachable: true, release: '1.2.3', home: '/home/ada', replayed });
    // and the worker's entry for the home
    const mac = () => w.store.state.machines?.[H];
    await until(() => expect(w.worker.snapshotVersion()).toBeGreaterThan(100));
    expect(mac()).toMatchObject({ name: 'mac', reachable: true, home: '/Users/ada', snapshot: { version: w.worker.snapshotVersion() } });

    versions.schema = STATE_SCHEMA_VERSION + 1;
    sockets.at(-1)!.destroy();
    await until(() => expect(machine()?.reachable).toBe(false));
    expect(machine()).toMatchObject({ release: '1.2.3', home: '/home/ada', replayed });
    await until(() => expect(mac()?.reachable).toBe(false));
    expect(mac()).toMatchObject({ name: 'mac', home: '/Users/ada', snapshot: { version: w.worker.snapshotVersion() } });
    await until(() => expect(machine()?.mismatch).toBe(true));
    expect(machine()).toMatchObject({ reachable: false, home: '/home/ada', replayed });

    versions.schema = STATE_SCHEMA_VERSION;
    links.refresh();
    await until(() => expect(machine()?.reachable).toBe(true));
    expect(machine()?.mismatch).toBeUndefined();
    expect(machine()).toMatchObject({ home: '/home/ada', replayed });
    expect(Store.load(path.join(w.homePaths.home, 'state.json'), () => {}).state.machines?.[W]).toEqual(machine());
  });

  it('a worker in mismatch whose link drops is marked not reachable, its mismatch gone', async () => {
    const w = world({ versions: { schema: STATE_SCHEMA_VERSION + 1, protocol: PROTOCOL_VERSION } });
    await w.worker.start();
    const sockets: net.Socket[] = [];
    const links = w.links(async (e) => {
      // the worker is off once its link drops
      if (sockets.length) throw new Error('connection refused');
      const r = await socketTo(w.workerPaths.linkSock)(e);
      sockets.push(r.stream as net.Socket);
      return r;
    });
    const machine = () => w.home.state.machines?.[W];
    links.start();
    await until(() => expect(machine()).toMatchObject({ reachable: false, mismatch: true }));
    sockets[0].destroy();
    await until(() => expect(machine()?.mismatch).toBeUndefined());
    expect(machine()?.reachable).toBe(false);
  });

  it("a new epoch starts the home over from the worker's acked seq, whether the journal was wiped or lost its outbox or acked", async () => {
    const w = world();
    const count = (kind: string) => w.seen.filter((s) => s === `event ${kind}`).length;
    const replayed = () => w.home.state.machines?.[W]?.replayed;
    // two events on `journal`, the home linked until it has taken them, then both daemons stopped
    const round = async (connection: HomeConnection, journal: Outbox, kind: string) => {
      connection.journal(kind, {});
      connection.journal(kind, {});
      await connection.start();
      const links = w.links();
      links.start();
      await until(() => expect(journal.acked()).toBe(2));
      links.stop();
      await connection.stop();
      expect([count(kind), replayed()]).toEqual([2, { epoch: journal.epoch(), seq: 2 }]);
    };
    await round(w.worker, w.outbox, 'before');
    // the worker starts again over its journal with `files` gone
    const afresh = async (before: Outbox, files: string[], kind: string) => {
      for (const f of files) fs.rmSync(f, { recursive: true });
      const journal = Outbox.open(w.workerPaths);
      expect(journal.epoch()).not.toBe(before.epoch());
      await round(w.workerOn(journal), journal, kind);
      return journal;
    };
    const wiped = await afresh(w.outbox, [path.dirname(w.workerPaths.outbox)], 'wiped');
    const lost = await afresh(wiped, [w.workerPaths.outbox, w.workerPaths.acked], 'lost');
    const noAcked = await afresh(lost, [w.workerPaths.acked], 'noAcked');
    await afresh(noAcked, [w.workerPaths.outbox], 'noOutbox');
  });

  it('the worker acks no snapshot it could not write, and closes the link instead', async () => {
    const w = world();
    w.store.batchWrites();
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.store.state.robots.r_1.name).toBe('named at home'));
    // a push resolves with the link up once the worker acks it, and as the link drops otherwise
    let acked = false;
    // stands in for a full disk
    fs.chmodSync(w.workerPaths.home, 0o500);
    try {
      w.home.update((d) => { d.robots.r_1.name = 'renamed'; });
      void links.pushSnapshot().then(() => { acked = links.for(W)?.connected() ?? false; });
      await until(() => expect(links.for(W)?.connected()).toBe(false));
      expect(acked).toBe(false);
    } finally {
      fs.chmodSync(w.workerPaths.home, 0o700);
    }
    await until(() => expect(Store.load(path.join(w.workerPaths.home, 'state.json'), () => {}).state.robots.r_1.name).toBe('renamed'));
  });

  it("the worker's entry for its home says unreachable from the worker's start until a snapshot comes", async () => {
    const w = world();
    w.store.update((d) => { d.machines = { [H]: { name: 'mac', reachable: true, since: 1, home: '/Users/ada', snapshot: { version: 7, at: 1 } } }; });
    await w.worker.start();
    expect(w.store.state.machines?.[H]).toMatchObject({ name: 'mac', reachable: false, home: '/Users/ada', snapshot: { version: 7 } });
    expect(w.store.state.machines![H]!.since).toBeGreaterThan(1);
    w.links().start();
    await until(() => expect(w.store.state.machines?.[H]?.reachable).toBe(true));
  });

  it('sends no snapshot over the line limit: the push fails, says so once, and the link stays up', async () => {
    const logged: string[] = [];
    const w = world({ log: { info() {}, error: (m) => logged.push(m) } });
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.store.state.robots.r_1.name).toBe('named at home'));

    w.home.update((d) => { d.robots.r_1.note = 'x'.repeat(MAX_LINE); });
    await expect(links.pushSnapshot()).rejects.toMatchObject({ code: 'too_large' });
    await expect(links.pushSnapshot()).rejects.toMatchObject({ code: 'too_large' });
    expect(logged).toEqual([expect.stringMatching(new RegExp(`^the fleet's snapshot is \\d+ bytes, over the link's limit of ${MAX_LINE}; no worker gets it; the longest notes are named at home \\(${MAX_LINE}\\)$`))]);
    expect(links.for(W)?.connected()).toBe(true);
    expect(w.store.state.robots.r_1.note).toBe('');

    w.home.update((d) => { d.robots.r_1.note = 'short'; });
    await links.pushSnapshot();
    expect(w.store.state.robots.r_1.note).toBe('short');
  });

  it('a worker on another state schema or link protocol stays linked as a mismatch, its stream open and nothing but pings passing, until a refresh finds it matching', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const versions = { schema: STATE_SCHEMA_VERSION + 1, protocol: PROTOCOL_VERSION };
    const w = world({ versions });
    w.outbox.append('robot.sync', report('/w/1'));
    await w.worker.start();
    // the stream the far `svall worker link` runs over, whose end would take the ssh master and every terminal on it along
    const tap = { connects: 0, closes: 0, pongs: 0 };
    const links = w.links(async (e) => {
      tap.connects++;
      const r = await socketTo(w.workerPaths.linkSock)(e);
      r.stream.on('data', (c: Buffer) => { tap.pongs += String(c).split('"t":"pong"').length - 1; });
      r.stream.once('close', () => { tap.closes++; });
      return r;
    });
    const machine = () => w.home.state.machines?.[W];
    links.start();
    await until(() => expect(machine()).toMatchObject({ name: 'vault', reachable: false, mismatch: true, release: '1.2.3' }), 1);
    const link = links.for(W)!;
    expect(link.mismatch()).toMatchObject({ release: '1.2.3', schema: STATE_SCHEMA_VERSION + 1, protocol: PROTOCOL_VERSION });
    for (let beat = 1; beat <= 4; beat++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await until(() => expect(tap.pongs).toBe(beat), 1);
    }
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(tap).toMatchObject({ connects: 1, closes: 0 });
    expect(link.connected()).toBe(false);
    await expect(links.call(W, 'echo', {})).rejects.toMatchObject({ code: 'not_reachable', message: 'vault is not reachable' });
    expect(w.seen).toEqual([]);
    expect(w.outbox.acked()).toBe(0);
    expect(w.store.state.robots.r_1.name).toBe('stale');
    expect(w.worker.connected()).toBe(false);

    // upgraded, as far as its hello says, and greeted again on the same stream
    versions.schema = STATE_SCHEMA_VERSION;
    links.refresh();
    await until(() => expect(w.store.state.robots.r_1.name).toBe('named at home'), 50);
    expect(machine()).toMatchObject({ reachable: true, release: '1.2.3' });
    expect(machine()?.mismatch).toBeUndefined();
    expect(link.mismatch()).toBeUndefined();
    expect(w.reports).toEqual(['/w/1']);
    expect(tap).toMatchObject({ connects: 1, closes: 0 });
  });

  it('greets a worker in mismatch again every 5 minutes, and links it once it matches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const versions = { schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION + 1 };
    const w = world({ versions });
    await w.worker.start();
    let pongs = 0;
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      r.stream.on('data', (c: Buffer) => { pongs += String(c).split('"t":"pong"').length - 1; });
      return r;
    });
    const machine = () => w.home.state.machines?.[W];
    links.start();
    await until(() => expect(machine()?.mismatch).toBe(true), 1);
    versions.protocol = PROTOCOL_VERSION;
    for (let beat = 1; beat < 20; beat++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await until(() => expect(pongs).toBe(beat), 1);
      expect(machine()?.mismatch).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await until(() => expect(machine()).toMatchObject({ reachable: true }), 50);
    expect(machine()?.mismatch).toBeUndefined();
  });

  it('linked answers true once the worker is synced, and false at its timeout, once the worker greets in mismatch or once the link stops', async () => {
    const w = world();
    await w.worker.start();
    const up = w.links();
    up.start();
    expect(await up.for(W)!.linked(5_000)).toBe(true);
    expect(await up.for(W)!.linked(0)).toBe(true);
    up.stop();

    const down = w.links(async () => { throw new Error('connection refused'); });
    down.start();
    const started = Date.now();
    expect(await down.for(W)!.linked(300)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    const waiting = down.for(W)!.linked(5_000);
    down.stop();
    expect(await waiting).toBe(false);
    expect(await down.for(W)!.linked(5_000)).toBe(false);

    const odd = world({ versions: { schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION + 1 } });
    await odd.worker.start();
    const mismatched = odd.links();
    mismatched.start();
    const asked = Date.now();
    expect(await mismatched.for(W)!.linked(5_000)).toBe(false);
    expect(Date.now() - asked).toBeLessThan(4_000);
    expect(mismatched.for(W)!.mismatch()).toBeDefined();
  });

  it('the worker answers a home on another state schema or link protocol with its hello alone and takes nothing but pings, until it greets it matching', async () => {
    const w = world();
    await w.worker.start();
    const sock = net.connect(w.workerPaths.linkSock);
    await once(sock, 'connect');
    const got: LinkFrame[] = [];
    let closed = false;
    const stream = new LinkStream(sock, { onFrame: (f) => got.push(f), onClose: () => { closed = true; } });
    const token = tokenFor(w.homePaths, W)!;
    stream.send({ t: 'hello', token, ...HELLO, schema: STATE_SCHEMA_VERSION + 1 });
    await until(() => expect(got.map((f) => f.t)).toEqual(['hello']));
    expect(got[0]).toMatchObject({ release: '1.2.3', schema: STATE_SCHEMA_VERSION, protocol: PROTOCOL_VERSION });
    stream.send({ t: 'snapshot', version: 1, data: { unread: 'by this build' } });
    stream.send({ t: 'ack', seq: 0 });
    stream.send({ t: 'ping' });
    await until(() => expect(got.map((f) => f.t)).toEqual(['hello', 'pong']));
    expect(closed).toBe(false);
    expect(w.worker.connected()).toBe(false);
    expect(w.store.state.robots.r_1.name).toBe('stale');

    stream.send({ t: 'hello', token, ...HELLO });
    await until(() => expect(got.map((f) => f.t)).toEqual(['hello', 'pong', 'hello', 'inventory']));
    stream.send({ t: 'ack', seq: 0 });
    await until(() => expect(w.worker.connected()).toBe(true));
    stream.close();
  });

  it('skips an event of a kind this svalld does not take, saying so, and the link goes on with the next', async () => {
    const logged: string[] = [];
    const w = world({ log: { info() {}, error: (m) => logged.push(m) }, onEvent: async (kind) => { if (kind === 'future.kind') throw new UnknownEvent(); } });
    w.outbox.append('future.kind', { from: 'a newer worker' });
    w.outbox.append('robot.sync', report('/w/after'));
    await w.worker.start();
    const links = w.links();
    links.start();
    await until(() => expect(w.outbox.acked()).toBe(2));
    expect(links.for(W)?.connected()).toBe(true);
    expect(w.reports).toEqual(['/w/after']);
    expect(logged).toEqual(['vault: event 1 (future.kind) is not one this svalld takes; skipped']);
  });

  it('a notify frame reaches onNotify with its machine and is never acked', async () => {
    const w = world();
    await w.worker.start();
    // dropped: the home is not linked
    w.worker.notify('screen', { early: true });
    const acks: string[] = [];
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      const sock = r.stream as net.Socket;
      const out = new Writable({
        write(chunk: Buffer, _enc, done) {
          if (String(chunk).startsWith('{"t":"ack"')) acks.push(String(chunk));
          sock.write(chunk, done);
        },
      });
      return { stream: Duplex.from({ readable: sock, writable: out }), via };
    });
    links.start();
    await until(() => expect(w.worker.connected()).toBe(true));
    const before = acks.length;
    w.worker.notify('screen', { id: 'r_1', text: 'hi', at: 1 });
    // an event after it is the one acked
    w.worker.journal('x', {});
    await until(() => expect(w.outbox.acked()).toBe(1));
    expect(w.notified).toEqual([['screen', { id: 'r_1', text: 'hi', at: 1 }, W]]);
    expect(acks.slice(before)).toEqual(['{"t":"ack","seq":1}\n']);
  });

  it('a notify frame over PART_REPLY arrives cut to its tail, and the cut is logged once until one of its kind fits', async () => {
    const logged: string[] = [];
    const w = world({ workerLog: { info() {}, error: (m) => logged.push(m) } });
    await w.worker.start();
    w.links().start();
    await until(() => expect(w.worker.connected()).toBe(true));
    const big = { id: 'c_1', text: 'a'.repeat(PART_REPLY) + 'END', at: 1 };
    w.worker.notify('screen', big);
    await until(() => expect(w.notified).toHaveLength(1));
    const [kind, data] = w.notified[0]!;
    const { text } = data as { text: string };
    expect(text.endsWith('END')).toBe(true);
    expect(data).toMatchObject({ id: 'c_1', at: 1 });
    // cut no further than it must
    expect(Buffer.byteLength(JSON.stringify({ t: 'notify', kind, data }))).toBe(PART_REPLY);
    expect(logged).toEqual([expect.stringContaining('screen')]);

    w.worker.notify('screen', big);
    await until(() => expect(w.notified).toHaveLength(2));
    expect(logged).toHaveLength(1);
    // one that fits, and the next cut is said again
    w.worker.notify('screen', { id: 'c_1', text: 'small', at: 2 });
    w.worker.notify('screen', big);
    await until(() => expect(w.notified).toHaveLength(4));
    expect(logged).toEqual([expect.stringContaining('screen'), expect.stringContaining('screen')]);
  });

  it('onSynced fires once the inventory is taken and onLost when the stream dies; onLink on the worker mirrors them', async () => {
    const w = world();
    await w.worker.start();
    const sockets: net.Socket[] = [];
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      sockets.push(r.stream as net.Socket);
      return r;
    });
    links.start();
    await until(() => expect(w.synced).toEqual([W]));
    expect(w.seen).toEqual(['inventory from vault last 0 acked 0 robots /w/now']);
    await until(() => expect(w.linked).toEqual([true]));
    expect(w.lost).toEqual([]);

    sockets[0]!.destroy();
    await until(() => expect(w.lost).toEqual([W]));
    await until(() => expect(w.linked).toEqual([true, false]));
    // and the link the home makes again a second later
    await until(() => expect(w.synced).toEqual([W, W]));
    await until(() => expect(w.linked).toEqual([true, false, true]));
    expect(w.lost).toEqual([W]);
  });

  it("the worker's backlog is 0 until the home is linked, and the bytes waiting once it is", async () => {
    let called!: () => void;
    const answering = new Promise<void>((r) => { called = r; });
    const w = world({ handlers: { big: async () => { called(); return 'x'.repeat(900_000); } } });
    await w.worker.start();
    // a home that greets and calls, and never reads
    const sock = net.connect(w.workerPaths.linkSock);
    await once(sock, 'connect');
    const send = (f: LinkFrame) => sock.write(`${JSON.stringify(f)}\n`);
    send({ t: 'hello', token: tokenFor(w.homePaths, W)!, ...HELLO });
    send({ t: 'call', id: 1, method: 'big', params: {} });
    await answering;
    await new Promise((r) => setImmediate(r));
    expect(w.worker.backlog()).toBe(0);
    send({ t: 'ack', seq: 0 });
    await until(() => expect(w.worker.connected()).toBe(true));
    expect(w.worker.backlog()).toBeGreaterThan(0);
    sock.destroy();
  });

  it('a hook that throws is logged and the link goes on', async () => {
    const logged: string[] = [];
    const w = world({ log: { info() {}, error: (m) => logged.push(m) } });
    await w.worker.start();
    const sockets: net.Socket[] = [];
    const boom = () => { throw new Error('boom'); };
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      sockets.push(r.stream as net.Socket);
      return r;
    }, { onNotify: boom, onSynced: boom, onLost: boom });
    links.start();
    await until(() => expect(w.worker.connected()).toBe(true));
    w.worker.notify('screen', {});
    w.worker.journal('x', {});
    await until(() => expect(w.outbox.acked()).toBe(1));
    expect(logged).toEqual(['vault: onSynced failed: boom', 'vault: a screen notification not taken: boom']);
    expect([sockets.length, links.for(W)?.connected()]).toEqual([1, true]);

    sockets[0]!.destroy();
    await until(() => expect(logged).toContain('vault: onLost failed: boom'));
    await until(() => expect(sockets).toHaveLength(2));
    await until(() => expect(links.for(W)?.outboxDrained()).toBe(true));
  });

  it('refresh links a machine that has a token now, and leaves the links it holds as they are', async () => {
    const w = world();
    const l = w.links(async () => { throw new Error('ssh: connect to host vault port 22: Connection refused'); });
    l.start();
    const held = l.for(W);
    expect(held).toBeDefined();
    l.refresh();
    expect(l.for(SPARE)).toBeUndefined();
    issueToken(w.homePaths, SPARE);
    l.refresh();
    expect(l.for(SPARE)).toBeDefined();
    expect(l.for(W)).toBe(held);
  });

  it('refresh tries a link that is down again at once, its backoff from 1 s, starts no second try beside one under way, and leaves a linked one as it is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const w = world();
    const tries: number[] = [];
    let refuse = true;
    let hold: Promise<void> | undefined;
    const links = w.links(async (e) => {
      tries.push(Date.now());
      await hold;
      if (refuse) throw new Error('ssh: connect to host vault port 22: Connection refused');
      return socketTo(w.workerPaths.linkSock)(e);
    });
    const start = Date.now();
    const at = () => tries.map((t) => (t - start) / 1000);
    links.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(at()).toEqual([0, 1, 3, 7, 15]);
    links.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(at()).toEqual([0, 1, 3, 7, 15, 20, 21]);

    // a refresh while a try waits on ssh starts no second one
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(at()).toEqual([0, 1, 3, 7, 15, 20, 21, 23]);
    links.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toHaveLength(8);
    hold = undefined;
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(at()).toEqual([0, 1, 3, 7, 15, 20, 21, 23, 24]);

    refuse = false;
    await w.worker.start();
    links.refresh();
    await until(() => expect(links.for(W)?.connected()).toBe(true), 1);
    const linkedTries = tries.length;
    links.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tries).toHaveLength(linkedTries);
    expect(links.for(W)?.connected()).toBe(true);
  });

  it('refresh restarts the backoff of a link whose stream is open but not linked yet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const w = world();
    const tries: number[] = [];
    // a far `svall worker link` that has yet to answer, as one whose svalld is starting
    const silent = Duplex.from({ readable: new PassThrough(), writable: new PassThrough() });
    const links = w.links(async () => {
      tries.push(Date.now());
      if (tries.length < 5) throw new Error('ssh: connect to host vault port 22: Connection refused');
      return { stream: silent, via };
    });
    const start = Date.now();
    links.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tries.map((t) => (t - start) / 1000)).toEqual([0, 1, 3, 7, 15]);
    links.refresh();
    silent.destroy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries.map((t) => (t - start) / 1000)).toEqual([0, 1, 3, 7, 15, 16]);
  });

  it('refresh links again a machine whose link stopped for want of a token, once it holds one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const w = world();
    await w.worker.start();
    const sockets: net.Socket[] = [];
    const links = w.links(async (e) => {
      const r = await socketTo(w.workerPaths.linkSock)(e);
      sockets.push(r.stream as net.Socket);
      return r;
    });
    links.start();
    await until(() => expect(links.for(W)?.connected()).toBe(true), 1);
    const tokens = fs.readFileSync(w.homePaths.workersFile);
    fs.writeFileSync(w.homePaths.workersFile, '{}');
    sockets[0]!.destroy();
    await until(() => expect(links.for(W)?.connected()).toBe(false), 1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);

    fs.writeFileSync(w.homePaths.workersFile, tokens);
    links.refresh();
    await until(() => expect(links.for(W)?.connected()).toBe(true), 1);
    expect(sockets).toHaveLength(2);
  });

  it('call() answers not_reachable with the machine name while the link is down', async () => {
    const w = world({ handlers: { echo: async (p) => ({ echoed: p }) } });
    const down = w.links(async () => { throw new Error('ssh: connect to host vault port 22: Connection refused'); });
    down.start();
    await expect(down.call(W, 'echo', { a: 1 })).rejects.toMatchObject({ code: 'not_reachable', message: 'vault is not reachable' });
    expect(() => down.for(W)!.via()).toThrow('vault is not reachable');
    await expect(w.worker.call('robot.update', {})).rejects.toMatchObject({ code: 'not_reachable', message: 'mac is not reachable' });
    await expect(down.call(SPARE, 'echo', {})).rejects.toMatchObject({ code: 'not_reachable', message: 'spare is not reachable' });
    await expect(down.call(H, 'echo', {})).rejects.toMatchObject({ code: 'not_reachable', message: `${H} is not reachable` });
    down.stop();

    await w.worker.start();
    const up = w.links();
    up.start();
    await until(() => expect(up.for(W)?.connected()).toBe(true));
    expect(await up.call(W, 'echo', { a: 1 })).toEqual({ echoed: { a: 1 } });
    await expect(up.call(W, 'nothing', {})).rejects.toMatchObject({ code: 'unknown_method' });
    await until(() => expect(w.worker.connected()).toBe(true));
    await expect(w.worker.call('robot.update', {})).rejects.toMatchObject({ code: 'unknown_method' });

    await w.worker.stop();
    await until(() => expect(up.for(W)?.connected()).toBe(false));
    await expect(up.call(W, 'echo', { a: 1 })).rejects.toMatchObject({ code: 'not_reachable', message: 'vault is not reachable' });
    expect(fs.existsSync(w.workerPaths.linkSock)).toBe(false);
  });
});
