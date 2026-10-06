import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { FleetId, MachineId, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState, methods, type MethodName, type OwnerRecord, type Response, type TransactionRecord } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { Config } from '../src/config.js';
import { Fleet, type RefreshLinks } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { machineId } from '../src/machine.js';
import { startDaemon } from '../src/main.js';
import { classification } from '../src/ownership/guard.js';
import { OwnershipState } from '../src/ownership/state.js';
import { resolvePaths } from '../src/paths.js';
import { releaseVersion } from '../src/release.js';
import { Store } from '../src/store.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, ownerOf, waitFor } from './helpers.js';

const fleetId = FleetId.parse(crypto.randomUUID());
const me = MachineId.parse(crypto.randomUUID());
const other = MachineId.parse(crypto.randomUUID());

const load = (home: string, machineId: MachineId = me): OwnershipState =>
  OwnershipState.load({ paths: resolvePaths(home), fleetId, machineId, log: silentLogger });

const record = (home: string, value: unknown): void =>
  fs.writeFileSync(resolvePaths(home).owner, JSON.stringify(value));

const transaction: TransactionRecord = { id: 't1', fromMachineId: me, toMachineId: other, phase: 'preparing', startedAt: 1 };

const codeOf = (e: unknown): string => (e as { code?: string }).code ?? '';

// a context whose every service throws: an error frame carrying this code proves the guard let a call through
const REACHED = 'handler_reached';
const trap = <T>(): T => new Proxy((() => {}) as object, {
  get: () => { throw Object.assign(new Error('the handler ran'), { code: REACHED }); },
  apply: () => { throw Object.assign(new Error('the handler ran'), { code: REACHED }); },
}) as T;

const trapCtx = (ownership: OwnershipState): Ctx => ({
  store: trap(), fleet: trap(), fleets: trap(), terminals: trap(), workspace: trap(), usage: trap(), mobile: trap(), push: trap(),
  vapidPublicKey: 'k', viewer: { kind: 'app', send: () => {}, backlog: () => 0 }, claude: { dir: '/nope', json: '/nope.json' },
  handover: trap(), ownership,
});

describe('ownership state', () => {
  afterEach(() => cleanHomes());

  it('owns a fleet no gateway holds at generation zero when there is no record yet', () => {
    const home = makeHome();
    const o = OwnershipState.load({ paths: resolvePaths(home), fleetId, machineId: me, log: silentLogger, standalone: true });
    expect(o.isOwner()).toBe(true);
    expect(o.isFrozen()).toBe(false);
    expect(o.record()).toMatchObject({ fleetId, generation: 0, ownerMachineId: me });
    const file = resolvePaths(home).owner;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ fleetId, generation: 0, ownerMachineId: me });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('owns nothing of a fleet a gateway holds when there is no record yet, until the gateway names it', () => {
    const home = makeHome();
    const o = load(home);
    expect(o.isOwner()).toBe(false);
    expect(o.writable()).toBe(false);
    expect(o.outranked({ fleetId, generation: 0, ownerMachineId: other })).toBe(true);
    // and says so on disk, so the next start owns nothing either
    expect(load(home).isOwner()).toBe(false);
  });

  it('refuses every mutation on a machine the record does not name', () => {
    const home = makeHome();
    record(home, { fleetId, generation: 4, ownerMachineId: other });
    const o = load(home);
    expect(o.isOwner()).toBe(false);
    try {
      o.assertOwner('mutation');
      expect.unreachable('assertOwner resolved');
    } catch (e) {
      expect(codeOf(e)).toBe('not_owner');
      expect((e as { data: Record<string, unknown> }).data).toEqual({ ownerMachineId: other, generation: 4 });
    }
    expect(() => o.assertOwner('terminal')).toThrow(/another machine owns/);
  });

  it('reads a corrupt record as owning nothing, and keeps it that way across starts', () => {
    const home = makeHome();
    const file = resolvePaths(home).owner;
    fs.writeFileSync(file, '{ not json');
    const o = load(home);
    expect(o.isOwner()).toBe(false);
    expect(() => o.assertOwner('mutation')).toThrow();
    const aside = fs.readdirSync(home).filter((n) => n.startsWith('owner.json.broken-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, aside[0]), 'utf8')).toBe('{ not json');
    // a repaired-looking absence must not hand ownership back: the next start reads what this one wrote
    expect(load(home).isOwner()).toBe(false);
  });

  it('takes a standalone fleet back when its record is corrupt, and leaves a gatewayed one read-only', () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).owner, '{ not json');
    const standalone = OwnershipState.load({ paths: resolvePaths(home), fleetId, machineId: me, log: silentLogger, standalone: true });
    expect(standalone.isOwner()).toBe(true);
    expect(standalone.record()).toMatchObject({ fleetId, generation: 0, ownerMachineId: me });
    expect(load(home).isOwner()).toBe(true);

    // with a gateway, another machine could be the owner, so a record we cannot read stays read-only
    const gatewayed = makeHome();
    fs.writeFileSync(resolvePaths(gatewayed).owner, '{ not json');
    expect(load(gatewayed).isOwner()).toBe(false);
  });

  it('takes a standalone fleet back from a machine no gateway can name, and leaves a gatewayed one alone', () => {
    const home = makeHome();
    record(home, { fleetId, generation: 4, ownerMachineId: other });
    const lines: string[] = [];
    const standalone = OwnershipState.load({
      paths: resolvePaths(home), fleetId, machineId: me, standalone: true,
      log: { info() {}, error: (m) => { lines.push(m); } },
    });
    expect(standalone.isOwner()).toBe(true);
    expect(standalone.record()).toEqual({ fleetId, generation: 0, ownerMachineId: me });
    expect(lines.join('\n')).toContain(other);
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).owner, 'utf8'))).toEqual({ fleetId, generation: 0, ownerMachineId: me });

    const gatewayed = makeHome();
    record(gatewayed, { fleetId, generation: 4, ownerMachineId: other });
    expect(load(gatewayed).isOwner()).toBe(false);
    expect(JSON.parse(fs.readFileSync(resolvePaths(gatewayed).owner, 'utf8'))).toMatchObject({ generation: 4, ownerMachineId: other });
  });

  it('drops the marks of a handover it takes a standalone fleet back from', () => {
    const home = makeHome();
    record(home, { fleetId, generation: 4, ownerMachineId: other, surrendered: true, transaction });
    const o = OwnershipState.load({ paths: resolvePaths(home), fleetId, machineId: me, log: silentLogger, standalone: true });
    expect(o.writable()).toBe(true);
    expect(o.record()).toEqual({ fleetId, generation: 0, ownerMachineId: me });
  });

  it('names no command that does not exist when the record cannot be read', () => {
    const lines: string[] = [];
    const log = { info() {}, error: (m: string) => { lines.push(m); } };
    const gatewayed = makeHome();
    fs.writeFileSync(resolvePaths(gatewayed).owner, '{ not json');
    OwnershipState.load({ paths: resolvePaths(gatewayed), fleetId, machineId: me, log });
    expect(lines.join('\n')).toContain('This fleet is read-only until its ownership record is repaired.');
    expect(lines.join('\n')).not.toContain('svall fleet recover');
  });

  it('holds a daemon read-only for a reason the record does not carry', () => {
    const home = makeHome();
    record(home, { fleetId, generation: 0, ownerMachineId: me });
    const o = load(home);
    o.hold('handover tx-1 has not been activated on this machine');
    expect(o.isFrozen()).toBe(true);
    expect(o.writable()).toBe(false);
    expect(() => o.assertOwner('mutation')).toThrow(/tx-1 has not been activated/);
    expect(codeOf(((): unknown => { try { o.assertOwner('mutation'); } catch (e) { return e; } return {}; })())).toBe('frozen');
    // nothing durable was written, so a start with the journal resolved is writable again
    expect(load(home).writable()).toBe(true);
  });

  it('has frozen and surrendered on disk before freeze returns', async () => {
    const home = makeHome();
    record(home, { fleetId, generation: 0, ownerMachineId: me });
    const o = load(home);
    const done = o.freeze(transaction);
    const onDisk = JSON.parse(fs.readFileSync(resolvePaths(home).owner, 'utf8'));
    expect(onDisk).toMatchObject({ frozen: true, surrendered: true, transaction: { id: 't1' } });
    await done;
    expect(o.isFrozen()).toBe(true);
    expect(codeOf(((): unknown => { try { o.assertOwner('mutation'); } catch (e) { return e; } return {}; })())).toBe('frozen');
    // a frozen source stays frozen after a restart, with or without the gateway
    expect(load(home).isFrozen()).toBe(true);
  });

  it('surrenders, unfreezes and installs a committed record', async () => {
    const home = makeHome();
    record(home, { fleetId, generation: 0, ownerMachineId: me });
    const o = load(home);
    await o.surrender();
    expect(o.isFrozen()).toBe(true);
    await o.unfreeze();
    expect(o.isFrozen()).toBe(false);
    expect(o.record().transaction).toBeUndefined();
    expect(load(home).isOwner()).toBe(true);

    await o.installCommitted({ fleetId, generation: 7, ownerMachineId: other });
    expect(o.isOwner()).toBe(false);
    expect(o.isFrozen()).toBe(false);
    expect(load(home).record()).toMatchObject({ generation: 7, ownerMachineId: other });
  });

  it('names a committed handover rather than the freeze it left behind', async () => {
    const home = makeHome();
    const o = load(home);
    await o.freeze({ ...transaction, phase: 'committed' });
    try {
      o.assertOwner('mutation');
      expect.unreachable('assertOwner resolved');
    } catch (e) {
      expect(codeOf(e)).toBe('handover_committed');
      expect((e as { data: { transactionId: string } }).data.transactionId).toBe('t1');
    }
  });

  it('tells every listener when the record changes', async () => {
    const home = makeHome();
    const o = load(home);
    const seen: boolean[] = [];
    const off = o.onChange((r) => seen.push(r.frozen === true));
    await o.freeze(transaction);
    await o.unfreeze();
    off();
    await o.surrender();
    expect(seen).toEqual([true, false]);
  });
});

describe('the mutation fence', () => {
  afterEach(() => cleanHomes());

  const inactive = (): OwnershipState => {
    const home = makeHome();
    record(home, { fleetId, generation: 2, ownerMachineId: other });
    return load(home);
  };

  const frozen = async (): Promise<OwnershipState> => {
    const home = makeHome();
    record(home, { fleetId, generation: 0, ownerMachineId: me });
    const o = load(home);
    await o.freeze(transaction);
    return o;
  };

  const call = (ownership: OwnershipState, method: MethodName): Promise<Response> =>
    dispatch({ id: 1, method, params: {} }, trapCtx(ownership));

  const named = (kind: string): MethodName[] =>
    (Object.entries(classification) as [MethodName, string][]).filter(([, k]) => k === kind).map(([m]) => m);

  it('classifies every method the protocol names', () => {
    expect(Object.keys(classification).sort()).toEqual(Object.keys(methods).sort());
    for (const kind of ['read', 'mutation', 'terminal', 'transaction']) expect(named(kind).length).toBeGreaterThan(0);
  });

  it('refuses every mutation and terminal method on an inactive replica', async () => {
    const o = inactive();
    for (const method of [...named('mutation'), ...named('terminal')]) {
      const res = await call(o, method);
      expect('error' in res && res.error.code, method).toBe('not_owner');
    }
  });

  it('refuses every mutation and terminal method while frozen', async () => {
    const o = await frozen();
    for (const method of [...named('mutation'), ...named('terminal')]) {
      const res = await call(o, method);
      expect('error' in res && res.error.code, method).toBe('frozen');
    }
  });

  it('takes a forced record only from a client that said the token, on a replica and a frozen fleet alike', async () => {
    const phone = { kind: 'phone' as const, login: 'me@example.com', send: () => {}, backlog: () => 0 };
    for (const o of [inactive(), await frozen()]) {
      const refused = await dispatch({ id: 1, method: 'ownership.adopt', params: {} }, { ...trapCtx(o), viewer: phone });
      expect('error' in refused && refused.error.code).toBe('unauthorized');
      // a caller it cannot place is not taken for one that said the token
      const unplaced = await dispatch({ id: 1, method: 'ownership.adopt', params: {} }, { ...trapCtx(o), viewer: undefined } as unknown as Ctx);
      expect('error' in unplaced && unplaced.error.code).toBe('unauthorized');
      // past the fence, and on to the parameters
      const app = await call(o, 'ownership.adopt');
      expect('error' in app && app.error.code).toBe('invalid_params');
    }
  });

  it('answers the handover itself and its inspection only to a client that said the token', async () => {
    const phone = { kind: 'phone' as const, login: 'me@example.com', send: () => {}, backlog: () => 0 };
    const o = inactive();
    for (const method of [...named('transaction'), 'handover.inspect' as const]) {
      const refused = await dispatch({ id: 1, method, params: {} }, { ...trapCtx(o), viewer: phone });
      expect('error' in refused && refused.error.code, method).toBe('unauthorized');
      const app = await call(o, method);
      expect('error' in app && app.error.code, method).not.toBe('unauthorized');
    }
    // a phone still sees where a handover stands
    const status = await dispatch({ id: 1, method: 'handover.status', params: {} }, { ...trapCtx(o), viewer: phone });
    expect('error' in status && status.error.code).not.toBe('unauthorized');
  });

  it('lets read and transaction methods past the fence', async () => {
    for (const o of [inactive(), await frozen()]) {
      for (const method of [...named('read'), ...named('transaction')]) {
        const res = await call(o, method);
        const code = 'error' in res ? res.error.code : '';
        expect(['not_owner', 'frozen'].includes(code), `${method} answered ${code}`).toBe(false);
      }
    }
  });
});

class TestClient {
  private next = 1;
  private pending = new Map<number, (r: Response) => void>();
  constructor(public ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!('event' in msg)) this.pending.get(msg.id)?.(msg);
    });
  }
  static async connect(port: number, token: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => ws.once('open', r));
    const c = new TestClient(ws);
    ws.send(JSON.stringify({ token }));
    return c;
  }
  call(method: string, params?: unknown): Promise<Response> {
    const id = this.next++;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

const runIf = hasTmux() ? describe : describe.skip;

runIf('an inactive replica', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  it('answers reads and refuses every write, without reconciling', async () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    // a gateway holds this fleet, so the record naming another machine stands
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ id: fleetId, shell: '/bin/sh', gatewayMachineId: other }));
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'imported\n');
    const transcript = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'imported turn' } })}\n`);
    fs.writeFileSync(paths.state, JSON.stringify({
      version: 9, islands: { i1: { id: 'i1', name: 'isle', description: 'an imported isle', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 6 }, seed: 1 } },
      characters: {
        c1: {
          id: 'c1', islandId: 'i1', cell: { x: 1, y: 1 }, name: 'ada', note: '', portrait: 'owl', instructions: '', cwd: repo, context: [],
          shell: { lastOutputAt: 1 }, unread: false,
          agent: { kind: 'claude', sessionId: '9d1e4c2a-7b3f-4a6e-8c5d-2f1a0b9c8d7e', status: 'idle', transcriptPath: transcript, lastActivityAt: 1 },
        },
      },
      home: {}, defaultCwd: '~',
    }));
    record(home, { fleetId, generation: 9, ownerMachineId: other });
    const before = fs.statSync(paths.state).mtimeMs;

    const d = await startDaemon({ home, port: 0, log: silentLogger });
    homes.push(home);
    const client = await TestClient.connect(d.port, d.token);
    try {
      const snap = await client.call('state.get') as { result: { characters: Record<string, unknown> } };
      expect(Object.keys(snap.result.characters)).toEqual(['c1']);
      expect((await client.call('char.show', { id: 'c1' }) as { result: { text: string } }).result.text).toContain('ada');
      expect((await client.call('char.read', { id: 'c1', source: 'transcript' }) as { result: { text: string } }).result.text).toContain('imported turn');
      const status = await client.call('repo.status', { id: 'c1' });
      expect('result' in status).toBe(true);

      for (const [method, params] of [
        ['island.create', { name: 'no' }],
        ['char.create', { islandId: 'i1', cwd: '/tmp' }],
        ['term.attach', { id: 'c1' }],
        ['fs.write', { id: 'c1', path: 'x.txt', text: 'no', mtimeMs: 0 }],
        ['browser.open', { id: 'c1', url: 'https://example.com' }],
      ] as const) {
        const res = await client.call(method, params);
        expect('error' in res && res.error.code, method).toBe('not_owner');
      }

      expect(fs.statSync(paths.state).mtimeMs).toBe(before);
      // no window, because a replica starts no tmux server to hold one
      expect(fs.existsSync(paths.tmuxSock)).toBe(false);
      await expect(new Tmux(paths.tmuxSock, paths.tmuxConf).run('list-windows')).rejects.toThrow();
    } finally {
      client.ws.close();
      await d.stop();
    }
  });
});

runIf('a daemon starting with a gateway', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  function gated(owner: MachineId): string {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ id: fleetId, shell: '/bin/sh', gatewayMachineId: other }));
    record(home, { fleetId, generation: 2, ownerMachineId: owner });
    return home;
  }

  it('starts as the replica the gateway names, and runs the fleet once the gateway a recovery names says so', async () => {
    const here = machineId();
    const home = gated(here);
    let held: OwnerRecord = { fleetId, generation: 5, ownerMachineId: other };
    const d = await startDaemon({ home, port: 0, log: silentLogger, authority: { get: async () => held } });
    const client = await TestClient.connect(d.port, d.token);
    try {
      expect(await client.call('ownership.get')).toMatchObject({ result: { generation: 5, ownerMachineId: other, frozen: false } });
      expect(await client.call('island.create', { name: 'no' })).toMatchObject({ error: { code: 'not_owner' } });

      // the relay asks the gateway it names, whose word is what is taken
      const third = MachineId.parse(crypto.randomUUID());
      const record = { fleetId, generation: 6, ownerMachineId: here };
      const refused = await client.call('ownership.adopt', { record, gatewayMachineId: third });
      expect(refused).toMatchObject({ result: { adopted: false, ownership: { generation: 5, ownerMachineId: other } } });
      expect(JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).gatewayMachineId).toBe(other);
      held = record;
      const adopted = await client.call('ownership.adopt', { record, gatewayMachineId: third });
      expect(adopted).toMatchObject({ result: { adopted: true, ownership: { generation: 6, ownerMachineId: here, frozen: false } } });
      expect(await client.call('island.create', { name: 'yes' })).toMatchObject({ result: { name: 'yes' } });
      expect(JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).gatewayMachineId).toBe(third);
    } finally {
      client.ws.close();
      await d.stop();
    }
  });

  it('learns a gateway fleet.json names after it started, as `svall host enable` writes it, without a restart', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ id: fleetId, shell: '/bin/sh' }));
    const d = await startDaemon({ home, port: 0, log: silentLogger, authority: { get: async () => ({ fleetId, generation: 0, ownerMachineId: machineId() }) } });
    const client = await TestClient.connect(d.port, d.token);
    const destination = {
      info: {
        machineId: other, release: releaseVersion(), protocol: PROTOCOL_VERSION, stateSchema: emptyState().version, transferSchema: TRANSFER_SCHEMA_VERSION,
        platform: 'linux', arch: 'x64', agentAdapters: [], git: '2.43.0',
      },
      home, fleetHome: path.join(home, '.svall'),
    };
    const unnamed = async (): Promise<boolean> => {
      const r = await client.call('handover.preflight', { toMachineId: other, choices: {}, source: { home }, destination }) as { result: { blockers: { message: string }[] } };
      return r.result.blockers.some((b) => b.message.includes('names no gateway'));
    };
    try {
      expect(await unnamed()).toBe(true);
      const file = resolvePaths(home).fleetConfig;
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), gatewayMachineId: other }));
      expect(await unnamed()).toBe(false);
    } finally {
      client.ws.close();
      await d.stop();
    }
  });

  it('starts on the record it holds when the gateway does not answer', async () => {
    const home = gated(machineId());
    const d = await startDaemon({ home, port: 0, log: silentLogger, authority: { get: async () => { throw new Error('connect ECONNREFUSED'); } } });
    const client = await TestClient.connect(d.port, d.token);
    try {
      expect(await client.call('ownership.get')).toMatchObject({ result: { generation: 2, ownerMachineId: machineId() } });
      expect(await client.call('island.create', { name: 'yes' })).toMatchObject({ result: { name: 'yes' } });
    } finally {
      client.ws.close();
      await d.stop();
    }
  });
});

runIf('a frozen fleet', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot(deps: { refreshLinks?: RefreshLinks } = {}) {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh', home: { cwd: path.join(home, 'mc') } });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const ownership = ownerOf(home, config.id);
    const fleet = new Fleet({ store, tmux, paths, config, ownership, log: silentLogger, pollMs: 100, ...deps });
    await fleet.start();
    cleanup.push(async () => { fleet.stop(); await tmux.killServer(); });
    return { fleet, store, tmux, ownership, paths };
  }

  it('leaves a window that closes under it alone', async () => {
    const { fleet, store, tmux, ownership, paths } = await boot();
    const island = fleet.createIsland({ name: 'held' });
    const c = await fleet.createCharacter({ islandId: island.id, cwd: '/tmp' });
    await ownership.freeze(transaction);
    await fleet.settle();
    const written = fs.statSync(paths.state).mtimeMs;
    const snapshot = JSON.stringify(store.state);

    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(async () => (await tmux.listWindows()).length === 0);
    await new Promise((r) => setTimeout(r, 400));

    expect(store.state.characters[c.id].tmux).toEqual(c.tmux);
    expect(JSON.stringify(store.state)).toBe(snapshot);
    expect(fs.statSync(paths.state).mtimeMs).toBe(written);
  });

  it('settles the background writes that were already running when it froze', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const refreshLinks: RefreshLinks = async (store, _config, charId) => {
      await gate;
      store.update((d) => { const c = d.characters[charId]; if (c) c.note = 'refreshed'; });
    };
    const { fleet, store, ownership } = await boot({ refreshLinks });
    const island = fleet.createIsland({ name: 'busy' });
    const c = await fleet.createCharacter({ islandId: island.id, cwd: '/tmp' });

    await ownership.freeze(transaction);
    let settled = false;
    const done = fleet.settle().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 200));
    // the refresh started before the freeze is still in flight, so settle is still waiting on it
    expect(settled).toBe(false);
    expect(store.state.characters[c.id].note).toBe('');

    release();
    await done;
    expect(store.state.characters[c.id].note).toBe('refreshed');
    const after = JSON.stringify(store.state);
    await new Promise((r) => setTimeout(r, 400));
    expect(JSON.stringify(store.state)).toBe(after);
  });
});

runIf('a replica that becomes the owner', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  it('reconciles and polls only once activate is called, however often it is called', async () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh', home: { cwd: path.join(home, 'mc') } });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    record(home, { fleetId: config.id, generation: 3, ownerMachineId: other });
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const ownership = OwnershipState.load({ paths, fleetId: config.id, machineId: me, log: silentLogger });
    const fleet = new Fleet({ store, tmux, paths, config, ownership, log: silentLogger, pollMs: 100 });
    cleanup.push(async () => { fleet.stop(); await tmux.killServer(); });
    const connect = vi.spyOn(tmux, 'connect');

    await fleet.start();
    expect(store.state.islands).toEqual({});
    await new Promise((r) => setTimeout(r, 300));
    expect(store.state.islands).toEqual({});

    await ownership.installCommitted({ fleetId: config.id, generation: 4, ownerMachineId: me });
    await fleet.activate();
    // mission control is the poll's first write, and a live pane proves the control client attached
    expect(store.state.islands.home.kind).toBe('home');
    const island = fleet.createIsland({ name: 'woken' });
    const c = await fleet.createCharacter({ islandId: island.id, cwd: '/tmp' });
    await fleet.run(c.id, 'echo awake', true);
    await waitFor(async () => (await fleet.readScreen(c.id, 20)).includes('awake'));

    const before = store.state.characters[c.id];
    await fleet.activate();
    await new Promise((r) => setTimeout(r, 300));
    // a second activate leaves no second control client behind, and so no second poll either
    expect(connect).toHaveBeenCalledTimes(1);
    expect(store.state.characters[c.id].tmux).toEqual(before.tmux);
    expect((await tmux.listWindows()).length).toBe(1);
  });
});
