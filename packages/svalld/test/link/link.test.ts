import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, emptyState, type FleetState, type LinkFrame, type Robot } from '@svall/protocol';
import { HEARTBEAT_MS, HomeLinks, UnknownEvent, type Transport } from '../../src/link/home.js';
import { LinkStream, MAX_LINE } from '../../src/link/stream.js';
import { HomeConnection } from '../../src/link/worker.js';
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
const entry: MachineEntry = { id: W, record: { name: 'vault', ssh: 'vault', platform: 'linux', arch: 'x64', home: '/home/ada', svallBase: '/home/ada/.svall', gateway: false } };
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
  handlers?: Record<string, (p: unknown) => Promise<unknown>>; log?: Logger; versions?: { schema: number; protocol: number }; onEvent?: (kind: string) => Promise<void>;
} = {}) {
  const homePaths = resolvePaths(makeHome());
  const workerPaths = resolvePaths(makeHome());
  const token = issueToken(homePaths, W);
  const home = storeWith(homePaths.home, fleet(robot({ name: 'named at home' })));
  const store = storeWith(workerPaths.home, fleet(robot({ name: 'stale', cwd: '/w/now', tmux: { windowId: '@1', paneId: '%1' } })));
  const outbox = Outbox.open(workerPaths);
  const worker = new HomeConnection({
    paths: workerPaths, worker: { homeMachineId: H, fleetId: FleetId.parse(crypto.randomUUID()), token, homeName: 'mac' }, me: W, store, outbox,
    log: silentLogger, release: '1.2.3', bootId: 'boot-1', handlers: o.handlers ?? {}, ...(o.versions && { versions: o.versions }),
  });
  stops.push(() => worker.stop());
  // what the home took, in the order it took it
  const seen: string[] = [];
  const reports: string[] = [];
  let version = 100;
  let snapshots = 0;
  const links = (connect: Transport = socketTo(workerPaths.linkSock)) => {
    const l = new HomeLinks({
      paths: homePaths, store: home, log: o.log ?? silentLogger, release: '1.2.3', machines: () => [entry, spare], connect,
      onReport: (r, machine) => { seen.push(`report ${r.fields.cwd}`); reports.push(r.fields.cwd); applyReport(home, r, machine); },
      onEvent: async (kind) => { await o.onEvent?.(kind); seen.push(`event ${kind}`); },
      onInventory: async (inv, machine) => { seen.push(`inventory ${machine === W ? 'from vault' : machine} last ${inv.last} acked ${inv.acked} robots ${inv.robots.map((r) => r.fields.cwd).join(',')}`); },
      snapshot: () => { snapshots++; return { version: ++version, state: home.state, agentHomes }; },
    });
    stops.push(() => l.stop());
    return l;
  };
  return { homePaths, workerPaths, home, store, outbox, worker, links, seen, reports, snapshots: () => snapshots };
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
    expect(got[1]).toEqual({ t: 'inventory', robots: [ownedReport(w.store.state.robots.r_1)], last: 2, acked: 0 });
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
    w.home.batchWritesWhile(() => true);
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

  it('keeps doubling the retry while each link fails after its hello, as one that cannot take a journaled entry does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const w = world();
    // an entry this home cannot read, as a worker on another release could journal
    w.outbox.append('robot.sync', { robotId: 'r_1' });
    await w.worker.start();
    const tries: number[] = [];
    const downs: number[] = [];
    w.home.subscribe(() => {
      const m = w.home.state.machines?.[W];
      if (m && !m.reachable && m.since !== downs.at(-1)) downs.push(m.since);
    });
    const links = w.links(async (e) => { tries.push(Date.now()); return socketTo(w.workerPaths.linkSock)(e); });
    links.start();
    for (const gap of [1000, 2000, 4000, 8000]) {
      await until(() => expect(downs).toHaveLength(tries.length), 1);
      await vi.advanceTimersByTimeAsync(gap);
      expect(tries.at(-1)! - downs.at(-1)!).toBe(gap);
    }
    expect(w.outbox.acked()).toBe(0);
  });

  it('acks no event whose change did not reach the disk, and takes it once it does', async () => {
    const w = world();
    // the home batches its writes, as the daemon's store does
    w.home.batchWritesWhile(() => true);
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
    } finally {
      fs.chmodSync(w.homePaths.home, 0o700);
    }
    await until(() => expect(w.outbox.acked()).toBe(1));
    expect(Store.load(path.join(w.homePaths.home, 'state.json'), () => {}).state.robots.r_1.cwd).toBe('/w/unwritten');
  });

  it('the worker acks no snapshot it could not write, and closes the link instead', async () => {
    const w = world();
    w.store.batchWritesWhile(() => true);
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
    expect(logged).toEqual([expect.stringMatching(new RegExp(`^the fleet's snapshot is \\d+ bytes, over the link's limit of ${MAX_LINE}; no worker gets it$`))]);
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
