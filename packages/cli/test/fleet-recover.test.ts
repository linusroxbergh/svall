import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetId, MachineId, type MachineRecord, type OwnerRecord, type OwnershipInfo } from '@svall/protocol';
import { FleetAuthority, gatewayPaths, type OwnerOp, type OwnerParams } from '@svall/svalld/gateway/authority';
import { resolvePaths } from '@svall/svalld/paths';
import { recoverFleet, render, type DaemonPort, type GatewayPort, type RecoverEvent, type RecoverOptions } from '../src/commands/fleet-recover.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { readRoute, writeRoute } from '../src/controller/route.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-recover-'));
  made.push(dir);
  return dir;
};

const fleetId = FleetId.parse(crypto.randomUUID());
const TRIFT = MachineId.parse(crypto.randomUUID());
const VAULT = MachineId.parse(crypto.randomUUID());

const linux = (name: string): MachineRecord => ({
  name, ssh: name, platform: 'linux', arch: 'x64', home: '/home/linus', svallBase: '/home/linus/.local/share/svall', gateway: true,
});

type Daemon = { ownership: OwnershipInfo; adopted: unknown[]; fails?: string; declines?: boolean };

/** A Mac controller, trift the fleet's gateway and vault a third machine, each gateway a real authority under a temp prefix. */
function world() {
  const registry = MachineRegistry.load(tmp(), { hostname: 'mac' });
  const mac = registry.localId;
  registry.add(linux('trift'), TRIFT);
  registry.add(linux('vault'), VAULT);
  registry.save();
  const fleetHome = tmp();
  const paths = resolvePaths(fleetHome);
  fs.writeFileSync(paths.fleetConfig, JSON.stringify({ id: fleetId, gatewayMachineId: TRIFT }));

  const prefixes = new Map<MachineId, string>([[TRIFT, tmp()], [VAULT, tmp()]]);
  const authority = (id: MachineId): FleetAuthority => new FleetAuthority(prefixes.get(id)!);
  const hold = (id: MachineId, record: OwnerRecord): void => {
    const dir = gatewayPaths(prefixes.get(id)!).fleets;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${fleetId}.json`), JSON.stringify(record));
  };
  const held = async (id: MachineId): Promise<OwnerRecord | string> => {
    const t = await authority(id).apply('owner.get', { fleetId });
    return 'record' in t ? t.record : t.error.code;
  };
  const audit = (id: MachineId): unknown[] => {
    const file = gatewayPaths(prefixes.get(id)!).recoveries;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const localAudit = path.join(fleetHome, 'controller', 'recoveries.ndjson');

  const down = new Set<MachineId>();
  // machines that answer while the authority on them does not
  const silent = new Set<MachineId>();
  const refusing = new Map<MachineId, string>();
  const daemons = new Map<MachineId, Daemon>();
  const gateway = (entry: { id: MachineId; record: MachineRecord }): GatewayPort => async (op, id, params) => {
    if (down.has(entry.id) || !prefixes.has(entry.id)) throw new Error(`ssh: connect to host ${entry.record.name} port 22: Operation timed out`);
    if (silent.has(entry.id)) return { error: { code: 'disconnected', message: 'the gateway authority did not answer on its socket' } };
    const refusal = refusing.get(entry.id);
    if (refusal) return { error: { code: 'internal', message: refusal } };
    const t = await authority(entry.id).apply(`owner.${op}` as OwnerOp, { fleetId: id, ...params } as OwnerParams);
    return 'record' in t ? { record: t.record } : { error: t.error };
  };
  const daemon = async (entry: { id: MachineId; record: MachineRecord }): Promise<DaemonPort> => {
    const d = daemons.get(entry.id);
    if (!d) throw new Error(`${entry.record.name}: svalld is not running`);
    const call = async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'ownership.get') return d.ownership;
      if (d.fails) throw new Error(d.fails);
      d.adopted.push(params);
      const { record } = params as { record: OwnerRecord };
      return d.declines ? { adopted: false, ownership: d.ownership } : { adopted: true, ownership: { ...record, frozen: false } };
    };
    return { call: call as DaemonPort['call'], close: () => {} };
  };
  const events: RecoverEvent[] = [];
  const asked: string[] = [];
  let answer: () => Promise<string> = async () => '';
  let interactive = false;
  const run = (o: Partial<RecoverOptions> = {}) => recoverFleet({ forceOwner: 'local', ...o }, {
    fleetHome, registry, gateway, daemon, interactive,
    ask: async (q) => { asked.push(q); return answer(); },
    emit: (e) => { events.push(e); },
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  });
  type DataOf<E> = Extract<RecoverEvent, { event: E }>['data'];
  const of = <E extends RecoverEvent['event']>(event: E): DataOf<E>[] => events.filter((e) => e.event === event).map((e) => e.data as DataOf<E>);
  return {
    registry, mac, fleetHome, paths, prefixes, hold, held, audit, localAudit, down, silent, refusing, daemons, events, asked, run, of,
    answerWith: (fn: () => Promise<string>) => { answer = fn; interactive = true; },
  };
}

type World = ReturnType<typeof world>;

/** Nothing the command could write has been written. */
async function untouched(w: World, record: OwnerRecord | string): Promise<void> {
  expect(await w.held(TRIFT)).toEqual(record);
  expect(w.audit(TRIFT)).toEqual([]);
  expect(w.audit(VAULT)).toEqual([]);
  expect(fs.existsSync(w.localAudit)).toBe(false);
  expect(JSON.parse(fs.readFileSync(w.paths.fleetConfig, 'utf8'))).toEqual({ id: fleetId, gatewayMachineId: TRIFT });
  expect(readRoute(w.fleetHome)).toBeUndefined();
  for (const d of w.daemons.values()) expect(d.adopted).toEqual([]);
}

const ownerAt = (ownerMachineId: MachineId, generation: number, more: Partial<OwnershipInfo> = {}): OwnershipInfo =>
  ({ fleetId, generation, ownerMachineId, frozen: false, ...more });

describe('fleet recover --force-owner', () => {
  it('shows every generation, an unreachable machine\'s last known ones included, and writes the record above all of them', async () => {
    const w = world();
    const before: OwnerRecord = { fleetId, generation: 4, ownerMachineId: w.mac, transaction: { id: 'tx1', fromMachineId: w.mac, toMachineId: VAULT, phase: 'preparing', startedAt: 1 } };
    w.hold(TRIFT, before);
    w.daemons.set(w.mac, {
      ownership: ownerAt(w.mac, 4, { frozen: true, surrendered: true, journal: { role: 'source', transactionId: 'tx1', generation: 5, phase: 'transfer' } }), adopted: [],
    });
    fs.mkdirSync(path.join(w.fleetHome, 'controller'), { recursive: true });
    fs.writeFileSync(path.join(w.fleetHome, 'controller', 'handover.json'), JSON.stringify({
      version: 1, fleetId, transactionId: 'tx1', generation: 4, source: { machineId: w.mac, name: 'mac' }, destination: { machineId: VAULT, name: 'vault', ssh: 'vault' },
      choices: {}, phase: 'transfer', startedAt: 1, updatedAt: 2,
    }));
    writeRoute(w.fleetHome, { ownerMachineId: VAULT, generation: 6, at: '2026-09-20T08:00:00.000Z' });

    expect(await w.run({ confirm: fleetId })).toBe(true);

    const [seen] = w.of('recover.observed');
    expect(seen.gateway).toMatchObject({ machineId: TRIFT, name: 'trift', state: 'record', record: before });
    const vault = seen.machines.find((m) => m.machineId === VAULT)!;
    expect(vault.unreachable).toContain('svalld is not running');
    expect(vault.lastKnown).toEqual([
      'owner at generation 6 (route cache, 2026-09-20T08:00:00.000Z)',
      'destination of handover tx1, taking generation 5 at transfer (controller journal)',
    ]);
    expect(seen.shown).toEqual(expect.arrayContaining([
      { source: 'gateway trift', generation: 4 },
      { source: 'gateway trift handover tx1', generation: 5 },
      { source: 'mac owner.json', generation: 4 },
      { source: 'mac source journal tx1', generation: 5 },
      { source: 'controller journal tx1', generation: 5 },
      { source: 'route cache', generation: 6 },
    ]));
    expect(seen.plan).toEqual({ ownerMachineId: w.mac, owner: 'mac', generation: 7, gatewayMachineId: TRIFT, gateway: 'trift' });
    expect(seen.risks.join(' ')).toMatch(/This machine and trift ask trift who owns this fleet when their daemons next start; any other machine not reached here never asks on its own/);
    expect(seen.risks.join(' ')).toMatch(/stays on that machine's disk only/);

    const forced: OwnerRecord = { fleetId, generation: 7, ownerMachineId: w.mac };
    expect(await w.held(TRIFT)).toEqual(forced);
    // both audits: the gateway's, and the controller's beside its journal
    expect(w.audit(TRIFT)).toEqual([expect.objectContaining({ before, after: forced, requestingMachineId: w.mac, shown: seen.shown })]);
    expect(fs.statSync(w.localAudit).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(w.localAudit, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ at: '2026-09-23T12:00:00.000Z', fleetId, gatewayMachineId: TRIFT, before, after: forced, shown: seen.shown }),
    ]);
    expect(w.daemons.get(w.mac)!.adopted).toEqual([{ record: forced, gatewayMachineId: TRIFT }]);
    expect(readRoute(w.fleetHome)).toMatchObject({ ownerMachineId: w.mac, generation: 7 });
    const [result] = w.of('recover.result');
    expect(result).toMatchObject({ result: 'recovered' });
    expect(result.actions).toEqual([
      expect.stringMatching(/^trift takes this record when its daemon next starts and reaches trift/),
      'vault does not ask trift on its own: once it answers, run `svall fleet recover --force-owner local` again, before it runs this fleet',
    ]);
  });

  it('counts a handover the gateway holds open at the generation it would commit', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: VAULT, transaction: { id: 'tx1', fromMachineId: VAULT, toMachineId: w.mac, phase: 'ready-to-commit', startedAt: 1 } });
    w.daemons.set(w.mac, { ownership: ownerAt(VAULT, 3), adopted: [] });
    expect(await w.run({ confirm: fleetId })).toBe(true);
    expect(w.of('recover.observed')[0].plan?.generation).toBe(6);
    expect(await w.held(TRIFT)).toEqual({ fleetId, generation: 6, ownerMachineId: w.mac });
  });

  it('tells every machine the record does not name before the one it names, and not that one while a machine that ran the fleet is untold', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: VAULT });
    for (const id of [w.mac, TRIFT, VAULT]) w.daemons.set(id, { ownership: ownerAt(VAULT, 4), adopted: [] });
    expect(await w.run({ confirm: fleetId })).toBe(true);
    expect(w.of('recover.adopted').map((a) => a.name)).toEqual(['trift', 'vault', 'mac']);

    const stuck = world();
    stuck.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: VAULT });
    stuck.daemons.set(stuck.mac, { ownership: ownerAt(VAULT, 4), adopted: [] });
    stuck.daemons.set(VAULT, { ownership: ownerAt(VAULT, 4), adopted: [], fails: 'svalld closed the connection (1006)' });
    expect(await stuck.run({ confirm: fleetId })).toBe(false);
    expect(stuck.of('recover.adopted')).toEqual([expect.objectContaining({ machineId: VAULT, error: 'svalld closed the connection (1006)' })]);
    expect(stuck.daemons.get(stuck.mac)!.adopted).toEqual([]);
    const [result] = stuck.of('recover.result');
    expect(result).toMatchObject({ result: 'incomplete' });
    expect(result.message).toMatch(/vault ran this fleet and could not be told/);
    // this machine takes the record at its next start whatever vault does, so vault has to stop first
    expect(result.actions).toContainEqual(expect.stringMatching(/^mac takes this record when its daemon next starts, whether or not vault still runs this fleet: stop it on vault first/));
    expect(await stuck.held(TRIFT)).toEqual({ fleetId, generation: 5, ownerMachineId: stuck.mac });
  });

  it('ends incomplete, not recovered, when the machine the record names does not take it', async () => {
    const cases: [string, (w: World) => void][] = [
      ['declines', (w) => { w.daemons.set(VAULT, { ownership: ownerAt(w.mac, 4), adopted: [], declines: true }); }],
      ['fails', (w) => { w.daemons.set(VAULT, { ownership: ownerAt(w.mac, 4), adopted: [], fails: 'svalld closed the connection (1006)' }); }],
      ['cannot be reached', () => {}],
    ];
    for (const [what, set] of cases) {
      const w = world();
      w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: w.mac });
      set(w);
      expect(await w.run({ forceOwner: 'vault', confirm: fleetId }), what).toBe(false);
      const [result] = w.of('recover.result');
      expect(result.result, what).toBe('incomplete');
      expect(result.message, what).toMatch(/written on trift, and vault has not taken it/);
      expect(await w.held(TRIFT), what).toEqual({ fleetId, generation: 5, ownerMachineId: VAULT });
    }
  });

  it('writes nothing when the fleet id typed is not exactly this fleet\'s, or nothing is typed', async () => {
    const record: OwnerRecord = { fleetId, generation: 2, ownerMachineId: VAULT };
    for (const typed of ['nope', '', ` ${fleetId}`, fleetId.toUpperCase()]) {
      const w = world();
      w.hold(TRIFT, record);
      w.daemons.set(w.mac, { ownership: ownerAt(VAULT, 2), adopted: [] });
      w.answerWith(async () => typed);
      expect(await w.run(), JSON.stringify(typed)).toBe(false);
      expect(w.asked).toHaveLength(1);
      expect(w.of('recover.result')[0].message).toMatch(/nothing was written/);
      await untouched(w, record);
    }
    const w = world();
    w.hold(TRIFT, record);
    expect(await w.run({ confirm: crypto.randomUUID() })).toBe(false);
    await untouched(w, record);
  });

  it('refuses a run with no terminal to ask in unless --confirm names the fleet', async () => {
    const w = world();
    const record: OwnerRecord = { fleetId, generation: 2, ownerMachineId: VAULT };
    w.hold(TRIFT, record);
    expect(await w.run()).toBe(false);
    expect(w.asked).toEqual([]);
    expect(w.of('recover.result')[0].message).toMatch(/--confirm <fleet id>/);
    await untouched(w, record);
  });

  it('writes nothing when the gateway\'s record changes while the user reads it', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: w.mac });
    w.daemons.set(w.mac, { ownership: ownerAt(w.mac, 4), adopted: [] });
    let begun: OwnerRecord | undefined;
    w.answerWith(async () => {
      const t = await new FleetAuthority(w.prefixes.get(TRIFT)!).apply('owner.begin', { fleetId, expectedGeneration: 4, fromMachineId: w.mac, toMachineId: VAULT });
      begun = 'record' in t ? t.record : undefined;
      return fleetId;
    });
    expect(await w.run({ forceOwner: 'vault' })).toBe(false);
    expect(begun?.transaction).toBeDefined();
    expect(w.of('recover.result')[0].message).toMatch(/changed while this ran/);
    await untouched(w, begun!);
  });

  it('refuses when the gateway does not answer, and names the replacement-gateway step', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 2, ownerMachineId: w.mac });
    w.down.add(TRIFT);
    w.daemons.set(w.mac, { ownership: ownerAt(w.mac, 2), adopted: [] });
    expect(await w.run({ confirm: fleetId })).toBe(false);
    expect(w.of('recover.observed')[0].gateway).toMatchObject({ state: 'unreachable', message: expect.stringContaining('Operation timed out') });
    const [result] = w.of('recover.result');
    expect(result.message).toMatch(/trift did not answer/);
    expect(result.actions).toEqual([expect.stringContaining('svall fleet recover --force-owner local --gateway <machine>')]);
    w.down.delete(TRIFT);
    await untouched(w, { fleetId, generation: 2, ownerMachineId: w.mac });
  });

  it('names a replacement gateway in fleet.json through a link, keeping its mode', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 2, ownerMachineId: w.mac });
    w.down.add(TRIFT);
    w.daemons.set(w.mac, { ownership: ownerAt(w.mac, 2), adopted: [] });
    const real = path.join(tmp(), 'fleet.json');
    fs.writeFileSync(real, JSON.stringify({ id: fleetId, gatewayMachineId: TRIFT, custom: 1 }), { mode: 0o640 });
    fs.rmSync(w.paths.fleetConfig);
    fs.symlinkSync(real, w.paths.fleetConfig);
    await w.run({ gateway: 'vault', confirm: fleetId });
    expect(fs.lstatSync(w.paths.fleetConfig).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ id: fleetId, gatewayMachineId: VAULT, custom: 1 });
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });

  it('writes the record into a replacement gateway that holds none, and names it the gateway everywhere it reaches', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 2, ownerMachineId: w.mac });
    w.down.add(TRIFT);
    w.daemons.set(w.mac, { ownership: ownerAt(w.mac, 2), adopted: [] });
    w.daemons.set(VAULT, { ownership: ownerAt(w.mac, 1), adopted: [] });

    expect(await w.run({ gateway: 'vault', confirm: fleetId })).toBe(true);

    const forced: OwnerRecord = { fleetId, generation: 3, ownerMachineId: w.mac };
    expect(await w.held(VAULT)).toEqual(forced);
    expect(w.audit(VAULT)).toEqual([expect.objectContaining({ before: null, after: forced })]);
    expect(JSON.parse(fs.readFileSync(w.paths.fleetConfig, 'utf8'))).toEqual({ id: fleetId, gatewayMachineId: VAULT });
    for (const id of [w.mac, VAULT]) expect(w.daemons.get(id)!.adopted).toEqual([{ record: forced, gatewayMachineId: VAULT }]);
    expect(w.of('recover.result')[0]).toMatchObject({
      result: 'recovered',
      actions: ["trift's daemon still names trift as the gateway: once it answers, run `svall fleet recover --force-owner local` again before it starts this fleet"],
    });

    // this machine's daemon, down now, reads the fleet.json written here when it next starts
    const quiet = world();
    quiet.down.add(TRIFT);
    expect(await quiet.run({ gateway: 'vault', confirm: fleetId, profile: 'work' })).toBe(false);
    expect(quiet.of('recover.result')[0].result).toBe('incomplete');
    expect(quiet.of('recover.result')[0].actions).toEqual([
      expect.stringMatching(/^mac takes this record when its daemon next starts and reaches vault/),
      "trift's daemon still names trift as the gateway: once it answers, run `svall -p work fleet recover --force-owner local` again before it starts this fleet",
      "vault's daemon still names trift as the gateway: once it answers, run `svall -p work fleet recover --force-owner local` again before it starts this fleet",
    ]);
  });

  it('refuses a replacement for a gateway that answers or refuses, one that holds a record, and one that is the gateway already', async () => {
    const record: OwnerRecord = { fleetId, generation: 2, ownerMachineId: VAULT };
    const answering = world();
    answering.hold(TRIFT, record);
    expect(await answering.run({ gateway: 'vault', confirm: fleetId })).toBe(false);
    expect(answering.of('recover.result')[0].message).toMatch(/trift is not lost/);
    await untouched(answering, record);

    const refusing = world();
    refusing.hold(TRIFT, record);
    refusing.refusing.set(TRIFT, 'EIO: the disk under the records failed');
    expect(await refusing.run({ gateway: 'vault', confirm: fleetId })).toBe(false);
    expect(refusing.of('recover.result')[0].message).toMatch(/trift is not lost/);
    refusing.refusing.delete(TRIFT);
    await untouched(refusing, record);

    // a machine that answers while its authority does not is not lost either: a replacement would make two authorities once it starts again
    const quiet = world();
    quiet.hold(TRIFT, record);
    quiet.silent.add(TRIFT);
    expect(await quiet.run({ gateway: 'vault', confirm: fleetId })).toBe(false);
    expect(quiet.of('recover.result')[0].message).toMatch(/trift is not lost/);
    expect(quiet.audit(VAULT)).toEqual([]);

    const holding = world();
    holding.hold(TRIFT, record);
    holding.down.add(TRIFT);
    holding.hold(VAULT, record);
    expect(await holding.run({ gateway: 'vault', confirm: fleetId })).toBe(false);
    expect(holding.of('recover.result')[0].message).toMatch(/vault already holds a record of this fleet/);
    expect(holding.audit(VAULT)).toEqual([]);

    const same = world();
    expect(await same.run({ gateway: 'trift', confirm: fleetId })).toBe(false);
    expect(same.of('recover.result')[0].message).toMatch(/already this fleet's gateway/);
  });

  it('replaces a gateway that cannot read its record of this fleet', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 2, ownerMachineId: w.mac });
    fs.writeFileSync(path.join(gatewayPaths(w.prefixes.get(TRIFT)!).fleets, `${fleetId}.json`), '{ "fleetId": ');
    w.daemons.set(w.mac, { ownership: ownerAt(w.mac, 2), adopted: [] });
    expect(await w.run({ gateway: 'vault', confirm: fleetId })).toBe(true);
    expect(w.of('recover.observed')[0].gateway.state).toBe('corrupt');
    expect(await w.held(VAULT)).toEqual({ fleetId, generation: 3, ownerMachineId: w.mac });
  });

  it('reads this machine\'s own owner.json and journal when its daemon does not answer, and changes neither', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: w.mac });
    fs.writeFileSync(w.paths.owner, JSON.stringify({ fleetId, generation: 4, ownerMachineId: w.mac, frozen: true, surrendered: true }));
    fs.mkdirSync(w.paths.handoverDir, { recursive: true });
    fs.writeFileSync(w.paths.journal, JSON.stringify({
      role: 'destination', transactionId: 'tx9', generation: 8, fleetId, fromMachineId: VAULT, toMachineId: w.mac, phase: 'prepare', manifestDigest: 'a'.repeat(64), updatedAt: 1,
    }));
    const files = [w.paths.owner, w.paths.journal].map((f) => fs.readFileSync(f, 'utf8'));

    // the owner it names takes the record only when its daemon next starts
    expect(await w.run({ confirm: fleetId })).toBe(false);
    expect(w.of('recover.result')[0].result).toBe('incomplete');

    const mine = w.of('recover.observed')[0].machines.find((m) => m.machineId === w.mac)!;
    expect(mine).toMatchObject({ from: 'disk', unreachable: expect.stringContaining('svalld is not running') });
    expect(mine.ownership).toEqual({
      fleetId, generation: 4, ownerMachineId: w.mac, frozen: true, surrendered: true, journal: { role: 'destination', transactionId: 'tx9', generation: 8, phase: 'prepare' },
    });
    expect(await w.held(TRIFT)).toEqual({ fleetId, generation: 9, ownerMachineId: w.mac });
    expect([w.paths.owner, w.paths.journal].map((f) => fs.readFileSync(f, 'utf8'))).toEqual(files);
    expect(w.of('recover.result')[0].actions).toEqual(expect.arrayContaining([expect.stringMatching(/^mac takes this record when its daemon next starts/)]));
  });

  it('names a replica that could not take the record as one still to be told, and tells the owner all the same', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: w.mac });
    w.daemons.set(w.mac, { ownership: ownerAt(w.mac, 4, { frozen: true }), adopted: [] });
    w.daemons.set(VAULT, { ownership: ownerAt(w.mac, 4), adopted: [], fails: 'svalld closed the connection (1006)' });
    expect(await w.run({ confirm: fleetId })).toBe(true);
    expect(w.of('recover.adopted')).toEqual([
      expect.objectContaining({ machineId: VAULT, error: 'svalld closed the connection (1006)' }),
      expect.objectContaining({ machineId: w.mac, adopted: true }),
    ]);
    expect(w.of('recover.result')[0].actions).toEqual([
      expect.stringMatching(/^trift takes this record/),
      'vault does not ask trift on its own: once it answers, run `svall fleet recover --force-owner local` again, before it runs this fleet',
    ]);
  });

  it('prints the generations, the risks and each machine for a person to read', async () => {
    const w = world();
    w.hold(TRIFT, { fleetId, generation: 4, ownerMachineId: VAULT });
    w.daemons.set(w.mac, { ownership: ownerAt(VAULT, 4), adopted: [] });
    await w.run({ confirm: fleetId });
    const text = w.events.map((e) => render(e, (id) => w.registry.get(id)?.record.name ?? id)).join('\n');
    expect(text).toContain(`fleet ${fleetId}`);
    expect(text).toMatch(/gateway trift: vault owns this fleet at generation 4/);
    expect(text).toMatch(/vault: unreachable/);
    expect(text).toMatch(/mac owns this fleet at generation 5, as trift now records/);
    expect(text).toMatch(/risks:/);
  });
});
