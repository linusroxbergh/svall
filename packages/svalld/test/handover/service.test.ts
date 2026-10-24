import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetConfig, FleetId, MachineId, PROTOCOL_VERSION, emptyState, type Event, type OwnerRecord } from '@svall/protocol';
import { Config } from '../../src/config.js';
import { HandoverService } from '../../src/handover/service.js';
import { DestinationJournal, SourceJournal, openJournal } from '../../src/handover/journal.js';
import { AuthorityFailure } from '../../src/gateway/authority.js';
import type { Authority } from '../../src/handover/source.js';
import { adoptAtStart, enterStartupMode, startupMode, watchGateway } from '../../src/handover/startup.js';
import { silentLogger, type Logger } from '../../src/log.js';
import { OwnershipState } from '../../src/ownership/state.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, idleSides, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const fleetId = FleetId.parse(crypto.randomUUID());
const me = MachineId.parse(crypto.randomUUID());
const other = MachineId.parse(crypto.randomUUID());
const third = MachineId.parse(crypto.randomUUID());
const digest = 'a'.repeat(64);
const config = Config.parse({ id: fleetId });
// a manifest these calls are refused before they read
const manifest = {
  version: 3 as const, transactionId: 'tx-1', generation: 4, fromMachineId: other, toMachineId: me,
  home: '/Users/linus', destinationHome: '/Users/linus',
  fleet: FleetConfig.parse({ id: fleetId }), snapshot: emptyState(), excludes: [], roots: [], sessions: [],
};

// the two machines a controller describes; these calls are refused before anything reads them
const machines = {
  source: { home: '/Users/linus' },
  destination: {
    info: { machineId: other, release: 'dev', protocol: PROTOCOL_VERSION, stateSchema: emptyState().version, transferSchema: 1, platform: 'linux' as const, arch: 'x64', agentAdapters: [] },
    home: '/Users/linus', fleetHome: '/Users/linus/.svall',
  },
};

const codeOf = (e: unknown): string => (e as { code?: string }).code ?? '';
const dataOf = (e: unknown): Record<string, unknown> => (e as { data?: Record<string, unknown> }).data ?? {};

const source = (over: Partial<SourceJournal> = {}): SourceJournal => SourceJournal.parse({
  role: 'source', transactionId: 'tx-1', generation: 4, fleetId, fromMachineId: me, toMachineId: other,
  phase: 'transfer', stoppedTerminals: [{ robotId: 'c_1' }, { robotId: 'c_1', term: 2 }],
  updatedAt: 10, ...over,
});

const destination = (over: Partial<DestinationJournal> = {}): DestinationJournal => DestinationJournal.parse({
  role: 'destination', transactionId: 'tx-1', generation: 5, fleetId, fromMachineId: other, toMachineId: me,
  phase: 'commit', manifestDigest: digest, updatedAt: 11, ...over,
});

function boot(opts: { record?: object; journal?: unknown; home?: string; gateway?: Authority; named?: Authority } = {}) {
  const home = opts.home ?? makeHome();
  const paths = resolvePaths(home);
  if (opts.record) fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, ...opts.record }));
  if (opts.journal !== undefined) {
    fs.mkdirSync(paths.handoverDir, { recursive: true });
    fs.writeFileSync(paths.journal, typeof opts.journal === 'string' ? opts.journal : JSON.stringify(opts.journal));
  }
  const ownership = OwnershipState.load({ paths, fleetId, machineId: me, log: silentLogger });
  const log: string[] = [];
  const fleet = {
    activate: async () => { log.push('activate'); }, reconcileNow: async () => { log.push('reconcile'); }, deactivate: async () => { log.push('deactivate'); },
    resumeInterrupted: async () => { log.push('resume'); },
  };
  const asked: MachineId[] = [];
  const sides = idleSides(paths, { config });
  const handover = new HandoverService({
    ownership, journal: openJournal(paths), fleet, setGateway: (id) => { log.push(`gateway ${id ?? 'none'}`); }, ...sides,
    ...(opts.named && { source: { ...sides.source, authority: () => opts.named } }),
    ...(opts.gateway && { authorityFor: (id: MachineId) => { asked.push(id); return opts.gateway!; } }),
  });
  return { home, paths, ownership, handover, log, asked };
}

const modeOf = (b: ReturnType<typeof boot>) => startupMode({ ownership: b.ownership, journal: b.handover.journalState(), config });
const enter = (b: ReturnType<typeof boot>, standalone = false) =>
  enterStartupMode(modeOf(b), { ownership: b.ownership, journal: b.handover.journalState(), log: silentLogger, standalone });

describe('startupMode', () => {
  it('starts an unfrozen owner with no journal as the owner', () => {
    const b = boot({ record: { generation: 0, ownerMachineId: me } });
    expect(modeOf(b)).toBe('owner');
  });

  it('starts a machine the record does not name as an inactive replica', async () => {
    const b = boot({ record: { generation: 3, ownerMachineId: other } });
    expect(modeOf(b)).toBe('replica');
    await enter(b);
    expect(b.ownership.writable()).toBe(false);
  });

  it('starts a source journal frozen, and surrenders when the cached record disagrees', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    expect(modeOf(b)).toBe('frozen-source');
    expect(b.ownership.isFrozen()).toBe(false);
    await enter(b);
    expect(b.ownership.isFrozen()).toBe(true);
    expect(b.ownership.writable()).toBe(false);
    // the surrender is on disk, so the next start is read-only with or without the journal
    expect(JSON.parse(fs.readFileSync(b.paths.owner, 'utf8'))).toMatchObject({ surrendered: true });
  });

  it('starts a committed destination read-only until activation', async () => {
    const b = boot({ record: { generation: 5, ownerMachineId: me }, journal: destination() });
    expect(modeOf(b)).toBe('receiving-destination');
    await enter(b);
    expect(b.ownership.writable()).toBe(false);
    expect(() => b.ownership.assertOwner('mutation')).toThrow(/activated/);
    // nothing durable was written: the journal alone holds this daemon back
    expect(JSON.parse(fs.readFileSync(b.paths.owner, 'utf8')).surrendered).toBeUndefined();
  });

  it('keeps a destination that has only prepared read-only too', () => {
    const b = boot({ record: { generation: 5, ownerMachineId: me }, journal: destination({ phase: 'prepare' }) });
    expect(modeOf(b)).toBe('receiving-destination');
  });

  it('starts read-only on a journal it cannot read, and names the file it moved aside', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me }, journal: '{ not json' });
    expect(modeOf(b)).toBe('quarantined');
    const moved = fs.readdirSync(b.paths.handoverDir).filter((n) => n.startsWith('journal.json.broken-'));
    expect(moved).toHaveLength(1);
    await enter(b);
    expect(b.ownership.writable()).toBe(false);
  });

  it('says in its status where a journal it could not read was moved, so no one takes it for a finished handover', () => {
    const b = boot({ record: { generation: 5, ownerMachineId: me }, journal: '{ not json' });
    const [moved] = fs.readdirSync(b.paths.handoverDir).filter((n) => n.startsWith('journal.json.broken-'));
    expect(b.handover.status()).toEqual({ quarantined: path.join(b.paths.handoverDir, moved) });
    expect(boot({ record: { generation: 5, ownerMachineId: me } }).handover.status()).toEqual({});
  });

  it('keeps a gatewayed fleet read-only across restarts when its journal is unreadable', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me }, journal: '{ not json' });
    await enter(b);
    expect(JSON.parse(fs.readFileSync(b.paths.owner, 'utf8'))).toMatchObject({ surrendered: true });
    expect(boot({ home: b.home }).ownership.writable()).toBe(false);
  });

  it('holds a standalone fleet read-only for this start only when its journal is unreadable', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me }, journal: '{ not json' });
    await enter(b, true);
    expect(b.ownership.writable()).toBe(false);
    expect(() => b.ownership.assertOwner('mutation')).toThrow(/journal unreadable/);
    // nothing durable was written, so the next start, which finds no journal, may write again
    expect(JSON.parse(fs.readFileSync(b.paths.owner, 'utf8')).surrendered).toBeUndefined();
    const next = boot({ home: b.home });
    expect(startupMode({ ownership: next.ownership, journal: next.handover.journalState(), config })).toBe('owner');
    expect(next.ownership.writable()).toBe(true);
    expect(fs.readdirSync(b.paths.handoverDir).filter((n) => n.startsWith('journal.json.broken-'))).toHaveLength(1);
  });

  it('ignores a journal that belongs to another fleet', () => {
    const b = boot({ record: { generation: 0, ownerMachineId: me }, journal: source({ fleetId: FleetId.parse(crypto.randomUUID()) }) });
    expect(modeOf(b)).toBe('owner');
  });
});

describe('HandoverService', () => {
  it('reports no transaction when there is no journal', () => {
    const { handover } = boot();
    expect(handover.status()).toEqual({});
  });

  it('reports the source journal it holds', () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    const status = handover.status();
    expect(status).toEqual({ transaction: expect.objectContaining({ id: 'tx-1', fromMachineId: me, toMachineId: other, phase: 'transfer' }) });
  });

  it('reports the destination journal it holds', () => {
    const { handover } = boot({
      record: { generation: 5, ownerMachineId: me },
      journal: destination({ phase: 'activate', activation: [{ robotId: 'c_1', ok: false, error: 'no tmux' }] }),
    });
    const status = handover.status();
    expect(status).toEqual({ transaction: expect.objectContaining({ id: 'tx-1', phase: 'activate' }) });
  });

  it('sends a replica and a frozen source away before it looks at the transaction', async () => {
    const replica = boot({ record: { generation: 4, ownerMachineId: other } });
    await replica.handover.freeze({ transactionId: 'tx-1', generation: 4, choices: {}, ...machines }).then(
      () => expect.unreachable('freeze resolved'),
      (e) => { expect(codeOf(e)).toBe('not_owner'); expect(dataOf(e)).toEqual({ ownerMachineId: other, generation: 4 }); },
    );
    await expect(replica.handover.preflight({ toMachineId: other, choices: {}, ...machines })).rejects.toMatchObject({ code: 'not_owner' });

    const frozen = boot({ record: { generation: 4, ownerMachineId: me } });
    await frozen.ownership.surrender();
    await expect(frozen.handover.freeze({ transactionId: 'tx-1', generation: 4, choices: {}, ...machines })).rejects.toMatchObject({ code: 'frozen' });
  });

  it('refuses to receive a fleet this machine is still running', async () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me } });
    for (const call of [
      handover.prepare({ transactionId: 'tx-1', generation: 5, manifest, manifestDigest: digest, landed: [] }),
      handover.claim({ transactionId: 'tx-1', generation: 5, manifest, manifestDigest: digest }),
      handover.inspect({ roots: [], excludes: [], folders: ['/Users/linus'] }),
      handover.activate({ transactionId: 'tx-1', generation: 4 }),
    ]) await expect(call).rejects.toMatchObject({ code: 'not_owner' });
  });

  it('completes the journal it holds, answers a complete with none as done, and refuses one for another handover', async () => {
    const none = boot({ record: { generation: 5, ownerMachineId: other } });
    expect(await none.handover.complete({ transactionId: 'tx-1', generation: 4 })).toEqual({});
    const held = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    await expect(held.handover.complete({ transactionId: 'tx-2', generation: 4 })).rejects.toMatchObject({ code: 'transaction_mismatch' });
    await expect(held.handover.complete({ transactionId: 'tx-1', generation: 5 })).rejects.toMatchObject({ code: 'generation_mismatch' });
    // a source finishes its own journal, which asks the gateway it has none of here
    await expect(held.handover.complete({ transactionId: 'tx-1', generation: 4 })).rejects.toMatchObject({ code: 'transaction_mismatch', message: expect.stringContaining('names no gateway') });
    const receiving = boot({ record: { generation: 4, ownerMachineId: other }, journal: destination({ phase: 'activate' }) });
    expect(await receiving.handover.complete({ transactionId: 'tx-1', generation: 5 })).toEqual({});
    expect(receiving.handover.journalState()).toEqual({ kind: 'none' });
  });

  it('lets a committed destination retry its activation', async () => {
    const b = boot({ record: { generation: 5, ownerMachineId: me }, journal: destination() });
    await enter(b);
    await expect(b.handover.activate({ transactionId: 'tx-1', generation: 5 })).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('answers which commits its repository\'s refs do not reach, frozen or not, for a destination that cannot tell', async () => {
    const repo = path.join(makeHome(), 'app');
    const g = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@e', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
    fs.mkdirSync(repo);
    g('init', '-q');
    g('commit', '-q', '--allow-empty', '-m', 'one');
    const one = g('rev-parse', 'HEAD');
    g('commit', '-q', '--allow-empty', '-m', 'two');
    // a commit nothing names
    const loose = g('commit-tree', '-m', 'loose', 'HEAD^{tree}');
    const never = 'b'.repeat(40);
    const commonDir = path.join(repo, '.git');
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me, frozen: true } });
    expect(await handover.reaches({ commits: [one, loose, never].map((commit) => ({ commonDir, commit })) }))
      .toEqual({ unreached: [loose, never].map((commit) => ({ commonDir, commit })) });
  });

  it('refuses to abort a handover of a fleet another machine owns', async () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: other }, journal: source() });
    await expect(handover.abort({ transactionId: 'tx-1', generation: 4 })).rejects.toMatchObject({ code: 'not_owner' });
  });

  it('refuses an abort from a machine the record does not name, with or without a journal', async () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: other } });
    await handover.abort({ transactionId: 'tx-1', generation: 4 }).then(
      () => expect.unreachable('abort resolved'),
      (e) => { expect(codeOf(e)).toBe('not_owner'); expect(dataOf(e)).toEqual({ ownerMachineId: other, generation: 4 }); },
    );
  });

  it('refuses a generation the record does not hold', async () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me } });
    await handover.freeze({ transactionId: 'tx-1', generation: 9, choices: {}, ...machines }).then(
      () => expect.unreachable('freeze resolved'),
      (e) => { expect(codeOf(e)).toBe('generation_mismatch'); expect(dataOf(e)).toEqual({ expected: 9, actual: 4 }); },
    );
  });

  it('refuses a transaction the journal does not name', async () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    await handover.abort({ transactionId: 'tx-2', generation: 4 }).then(
      () => expect.unreachable('abort resolved'),
      (e) => { expect(codeOf(e)).toBe('transaction_mismatch'); expect(dataOf(e)).toEqual({ expected: 'tx-2', actual: 'tx-1' }); },
    );
  });

  it('refuses to abort a committed handover', async () => {
    const { handover } = boot({ record: { generation: 5, ownerMachineId: me }, journal: destination() });
    await handover.abort({ transactionId: 'tx-1', generation: 5 }).then(
      () => expect.unreachable('abort resolved'),
      (e) => { expect(codeOf(e)).toBe('handover_committed'); expect(dataOf(e)).toMatchObject({ transactionId: 'tx-1' }); },
    );
  });

  it('lets an abort run again on a handover that is already aborted', async () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me }, journal: source({ phase: 'aborted' }) });
    // it reaches the source, which reopens the terminals the handover stopped
    await expect(handover.abort({ transactionId: 'tx-1', generation: 4 })).rejects.toThrow('this test runs no handover phase');
  });

  it('tells its listeners about every journal write, close and entity report', () => {
    const { handover } = boot({ record: { generation: 4, ownerMachineId: me } });
    const seen: Event[] = [];
    const off = handover.onEvent((e) => seen.push(e));
    handover.write(source({ phase: 'freeze' }));
    expect(handover.status().transaction).toMatchObject({ phase: 'freeze' });
    handover.emitEntity({ transactionId: 'tx-1', kind: 'root', id: 'repo', phase: 'transfer', done: 1, total: 2 });
    handover.close();
    off();
    handover.write(source());
    expect(seen).toEqual([
      { event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'freeze' } },
      { event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'root', id: 'repo', phase: 'transfer', done: 1, total: 2 } },
      { event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'freeze' } },
    ]);
  });
});

describe('a gateway record newer than the one held', () => {
  const ownerFile = (b: ReturnType<typeof boot>): unknown => JSON.parse(fs.readFileSync(b.paths.owner, 'utf8'));

  it('runs the fleet when it names this machine, frozen before or not', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: other } });
    expect(await b.handover.adopt({ fleetId, generation: 6, ownerMachineId: me })).toEqual({
      adopted: true, ownership: { fleetId, generation: 6, ownerMachineId: me, frozen: false },
    });
    expect(ownerFile(b)).toEqual({ fleetId, generation: 6, ownerMachineId: me });
    expect(b.ownership.writable()).toBe(true);
    // and resumes what a crash cut off mid-turn, as a start does
    expect(b.log).toEqual(['activate', 'reconcile', 'resume']);

    const surrendered = boot({ record: { generation: 4, ownerMachineId: me, frozen: true, surrendered: true } });
    await surrendered.handover.adopt({ fleetId, generation: 5, ownerMachineId: me });
    expect(surrendered.ownership.writable()).toBe(true);
    expect(ownerFile(surrendered)).toEqual({ fleetId, generation: 5, ownerMachineId: me });
  });

  it('stops the fleet it ran when it names another machine, and leaves a replica as it was', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    expect(await b.handover.adopt({ fleetId, generation: 6, ownerMachineId: other })).toMatchObject({ adopted: true, ownership: { generation: 6, ownerMachineId: other } });
    expect(ownerFile(b)).toEqual({ fleetId, generation: 6, ownerMachineId: other });
    expect(b.ownership.writable()).toBe(false);
    expect(b.log).toEqual(['deactivate']);

    const replica = boot({ record: { generation: 4, ownerMachineId: other } });
    await replica.handover.adopt({ fleetId, generation: 6, ownerMachineId: third });
    expect(replica.ownership.record()).toMatchObject({ generation: 6, ownerMachineId: third });
    expect(replica.log).toEqual([]);
  });

  it('ignores a lower record, and an equal one naming the owner it holds', async () => {
    for (const [generation, ownerMachineId] of [[3, other], [4, me]] as const) {
      const b = boot({ record: { generation: 4, ownerMachineId: me } });
      const before = fs.readFileSync(b.paths.owner, 'utf8');
      expect(await b.handover.adopt({ fleetId, generation, ownerMachineId })).toMatchObject({ adopted: false, ownership: { generation: 4, ownerMachineId: me } });
      expect(fs.readFileSync(b.paths.owner, 'utf8')).toBe(before);
      expect(b.ownership.writable()).toBe(true);
      expect(b.log).toEqual([]);
    }
  });

  it('takes an equal record naming another machine, unless a handover is open here', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    expect(await b.handover.adopt({ fleetId, generation: 4, ownerMachineId: other })).toMatchObject({ adopted: true, ownership: { generation: 4, ownerMachineId: other } });
    expect(b.ownership.writable()).toBe(false);
    expect(b.log).toEqual(['deactivate']);

    const held = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    await enter(held);
    expect(await held.handover.adopt({ fleetId, generation: 4, ownerMachineId: other })).toMatchObject({ adopted: false });
    expect(held.handover.journalState().kind).toBe('open');
  });

  it('never takes a record carrying a handover while its journal is quarantined, and takes a forced one', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me }, journal: '{ not json' });
    await enter(b);
    const committed = { id: 'tx-1', fromMachineId: other, toMachineId: me, phase: 'committed' as const, startedAt: 1 };
    expect(await b.handover.adopt({ fleetId, generation: 5, ownerMachineId: me, transaction: committed })).toMatchObject({ adopted: false });
    expect(await b.handover.adopt({ fleetId, generation: 5, ownerMachineId: other, transaction: { ...committed, fromMachineId: me, toMachineId: other, phase: 'preparing' } }))
      .toMatchObject({ adopted: false });
    expect(b.ownership.writable()).toBe(false);
    expect(b.log).toEqual([]);

    expect(await b.handover.adopt({ fleetId, generation: 6, ownerMachineId: me })).toMatchObject({ adopted: true });
    expect(b.ownership.writable()).toBe(true);
  });

  it('never runs a handover committed to this machine without the journal that prepared it', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: other } });
    const transaction = { id: 'tx-1', fromMachineId: other, toMachineId: me, phase: 'committed' as const, startedAt: 1 };
    expect(await b.handover.adopt({ fleetId, generation: 5, ownerMachineId: me, transaction })).toMatchObject({ adopted: false, ownership: { generation: 4, ownerMachineId: other } });
    expect(b.ownership.writable()).toBe(false);
    expect(b.log).toEqual([]);
  });

  it('heals an owner.json it could not read with whatever record the gateway holds', async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).owner, '{ not json');
    const b = boot({ home });
    expect(b.ownership.writable()).toBe(false);
    expect(await b.handover.adopt({ fleetId, generation: 0, ownerMachineId: me })).toMatchObject({ adopted: true });
    expect(b.ownership.writable()).toBe(true);
    expect(ownerFile(b)).toEqual({ fleetId, generation: 0, ownerMachineId: me });
  });

  it('leaves a handover the record does not supersede to the controller that runs it', async () => {
    // the commit of the source's own handover, which the controller's Complete finishes
    const src = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    await enter(src);
    expect(await src.handover.adopt({ fleetId, generation: 5, ownerMachineId: other })).toMatchObject({ adopted: false });
    expect(src.handover.journalState().kind).toBe('open');
    expect(src.ownership.isFrozen()).toBe(true);
    // the commit a destination waits on to activate
    const dst = boot({ record: { generation: 4, ownerMachineId: other }, journal: destination() });
    await enter(dst);
    expect(await dst.handover.adopt({ fleetId, generation: 5, ownerMachineId: me })).toMatchObject({ adopted: false });
    expect(dst.ownership.writable()).toBe(false);
    expect([...src.log, ...dst.log]).toEqual([]);
  });

  it('refuses a record of another fleet', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    await expect(b.handover.adopt({ fleetId: FleetId.parse(crypto.randomUUID()), generation: 9, ownerMachineId: me })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
  });

  it('reports the journal it holds, at the generation its role takes the fleet to, and a surrender', () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me, frozen: true, surrendered: true }, journal: source() });
    expect(b.handover.ownershipInfo()).toEqual({
      fleetId, generation: 4, ownerMachineId: me, frozen: true, surrendered: true,
      journal: { role: 'source', transactionId: 'tx-1', generation: 5, phase: 'transfer' },
    });
    expect(boot({ record: { generation: 4, ownerMachineId: other }, journal: destination() }).handover.ownershipInfo().journal)
      .toEqual({ role: 'destination', transactionId: 'tx-1', generation: 5, phase: 'commit' });
  });
});

describe('a record a recovery relays', () => {
  const relayed = { fleetId, generation: 9, ownerMachineId: me };

  it('takes what the gateway it is told of answers, not what was relayed, and names that gateway once the record is taken', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me }, gateway: { get: async () => ({ fleetId, generation: 6, ownerMachineId: other }) } });
    expect(await b.handover.relay({ record: relayed, gatewayMachineId: third })).toMatchObject({ adopted: true, ownership: { generation: 6, ownerMachineId: other } });
    expect(b.asked).toEqual([third]);
    expect(b.log).toEqual(['deactivate', `gateway ${third}`]);

    const same = boot({ record: { generation: 4, ownerMachineId: me }, gateway: { get: async () => ({ fleetId, generation: 4, ownerMachineId: me }) } });
    expect(await same.handover.relay({ record: relayed, gatewayMachineId: third })).toMatchObject({ adopted: false, ownership: { generation: 4, ownerMachineId: me } });
    expect(same.log).toEqual([]);
  });

  const unasked: (Authority | undefined)[] = [
    { get: async () => { throw new AuthorityFailure('disconnected', 'machines.json names no ssh route to the gateway'); } },
    { get: async () => { throw new AuthorityFailure('timeout', 'the gateway authority did not answer owner.get within 10000ms'); } },
    { get: async () => { throw Object.assign(new Error('connect ENOENT /home/linus/.local/share/svall/gateway/authority.sock'), { code: 'ENOENT' }); } },
    undefined,
  ];

  it('lets the fleet go on a relayed record naming another owner when the gateway cannot be asked', async () => {
    for (const gateway of unasked) {
      const b = boot({ record: { generation: 4, ownerMachineId: me }, ...(gateway && { gateway }) });
      expect(await b.handover.relay({ record: { ...relayed, ownerMachineId: other }, gatewayMachineId: third })).toMatchObject({ adopted: true, ownership: { generation: 9, ownerMachineId: other } });
      expect(b.log).toEqual(['deactivate', `gateway ${third}`]);
    }
  });

  it('refuses a relayed record naming this machine when the gateway cannot be asked, and changes nothing', async () => {
    for (const gateway of unasked) {
      const b = boot({ record: { generation: 4, ownerMachineId: other }, ...(gateway && { gateway }) });
      await expect(b.handover.relay({ record: relayed, gatewayMachineId: third })).rejects.toMatchObject({
        code: 'invalid_params', message: `the gateway ${third} did not answer, so this machine does not take a record that makes it the owner; run the recovery again once the gateway answers`,
      });
      expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: other });
      expect(b.log).toEqual([]);
    }
  });

  // the line `svall fleet recover` writes in the fleet home before it tells this daemon to run the fleet alone
  const audit = (home: string, after: object, at = new Date()): void => {
    fs.mkdirSync(path.join(home, 'controller'), { recursive: true });
    fs.appendFileSync(path.join(home, 'controller', 'recoveries.ndjson'), `${JSON.stringify({ at: at.toISOString(), fleetId, gatewayMachineId: null, before: null, after })}\n`);
  };

  it('runs the fleet alone only on the audit fleet recover wrote of that very record in the last ten minutes, and changes nothing without one', async () => {
    const named: Authority = { get: async () => { throw new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer'); } };
    const wrong: [string, (home: string) => void][] = [
      ['none', () => {}],
      ['another generation', (home) => audit(home, { ...relayed, generation: 8 })],
      ['another owner', (home) => audit(home, { ...relayed, ownerMachineId: other })],
      ['through a gateway', (home) => fs.appendFileSync(path.join(home, 'controller', 'recoveries.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), fleetId, gatewayMachineId: third, before: null, after: relayed })}\n`)],
      ['stale', (home) => audit(home, relayed, new Date(Date.now() - 11 * 60_000))],
    ];
    for (const [what, arrange] of wrong) {
      const b = boot({ record: { generation: 4, ownerMachineId: other }, named });
      fs.mkdirSync(path.join(b.home, 'controller'), { recursive: true });
      arrange(b.home);
      await expect(b.handover.relay({ record: relayed }), what).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('svall fleet recover') });
      expect(b.ownership.record(), what).toMatchObject({ generation: 4, ownerMachineId: other });
      expect(b.log, what).toEqual([]);
    }
    const b = boot({ record: { generation: 4, ownerMachineId: other }, named });
    audit(b.home, relayed, new Date(Date.now() - 9 * 60_000));
    expect(await b.handover.relay({ record: relayed })).toMatchObject({ adopted: true, ownership: { generation: 9, ownerMachineId: me } });
  });

  it('runs the fleet alone on a record that names no gateway once the gateway fleet.json names does not answer, letting go the handover it supersedes and dropping that gateway', async () => {
    const unanswered = [
      new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer'),
      new AuthorityFailure('timeout', 'the gateway authority did not answer owner.get within 10000ms'),
      // a registry with no route to the gateway leaves it as unasked as one that does not answer
      new AuthorityFailure('invalid_request', 'machines.json names no ssh route to the gateway', { unrouted: true }),
    ];
    for (const failure of unanswered) {
      const named: Authority = { get: async () => { throw failure; } };
      const b = boot({ record: { generation: 4, ownerMachineId: other }, journal: destination(), named, gateway: { get: async () => { throw new Error('another gateway was asked'); } } });
      await enter(b);
      audit(b.home, relayed);
      expect(await b.handover.relay({ record: relayed })).toMatchObject({ adopted: true, superseded: 'tx-1', ownership: { generation: 9, ownerMachineId: me, frozen: false } });
      expect(b.asked).toEqual([]);
      expect(b.handover.journalState()).toEqual({ kind: 'none' });
      expect(b.ownership.writable()).toBe(true);
      expect(b.log).toEqual(['activate', 'reconcile', 'resume', 'gateway none']);
    }
  });

  it('refuses to run the fleet alone while the gateway fleet.json names answers, with a record or a refusal, and changes nothing', async () => {
    const answers: Authority[] = [
      { get: async () => ({ fleetId, generation: 4, ownerMachineId: other }) },
      { get: async () => { throw new AuthorityFailure('authority_corrupt', 'the record of this fleet cannot be read'); } },
      { get: async () => { throw new AuthorityFailure('invalid_request', 'ssh trift answered with what is no authority\'s frame'); } },
      { get: async () => { throw new Error('spawn ssh ENOENT'); } },
    ];
    for (const named of answers) {
      const b = boot({ record: { generation: 4, ownerMachineId: other }, journal: destination(), named });
      await enter(b);
      await expect(b.handover.relay({ record: relayed })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringMatching(/the gateway this fleet names/) });
      expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: other });
      expect(b.handover.journalState()).toMatchObject({ kind: 'open' });
      expect(b.log).toEqual([]);
    }
  });

  it('refuses a record that names no gateway and another machine as the owner, and changes nothing', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: other } });
    await expect(b.handover.relay({ record: { ...relayed, ownerMachineId: other } })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: other });
    expect(b.log).toEqual([]);
  });

  it('refuses a relayed record the gateway says it does not hold, and changes nothing', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: other }, gateway: { get: async () => { throw new AuthorityFailure('not_found', 'the gateway holds no record for this fleet'); } } });
    await expect(b.handover.relay({ record: relayed, gatewayMachineId: third })).rejects.toMatchObject({ code: 'not_found' });
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: other });
    expect(b.log).toEqual([]);
  });
});

describe('a start with a gateway', () => {
  it('takes the record the gateway answers with', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    await adoptAtStart({ handover: b.handover, authority: { get: async () => ({ fleetId, generation: 7, ownerMachineId: other }) }, fleetId, log: silentLogger });
    expect(b.ownership.record()).toMatchObject({ generation: 7, ownerMachineId: other });
    expect(b.log).toEqual(['deactivate']);
  });

  it('runs the fleet a record naming this machine gives it, and leaves what a crash cut off to the resume after the hook receiver starts', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: other } });
    await adoptAtStart({ handover: b.handover, authority: { get: async () => ({ fleetId, generation: 7, ownerMachineId: me }) }, fleetId, log: silentLogger });
    expect(b.ownership.writable()).toBe(true);
    expect(b.log).toEqual(['activate', 'reconcile']);
  });

  it('starts on the record it holds when the gateway cannot say, holds none, or does not answer in time', async () => {
    const answers: (() => Promise<never>)[] = [
      async () => { throw new Error('connect ECONNREFUSED'); },
      async () => { throw new AuthorityFailure('not_found', 'the gateway holds no record for this fleet'); },
      () => new Promise<never>(() => {}),
    ];
    for (const get of answers) {
      const b = boot({ record: { generation: 4, ownerMachineId: me } });
      await adoptAtStart({ handover: b.handover, authority: { get }, fleetId, log: silentLogger, timeoutMs: 20 });
      expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
      expect(b.log).toEqual([]);
    }
  });

  // what connecting to the gateway's own socket throws while that gateway, on this machine, has yet to listen
  const unlistened = (code: 'ENOENT' | 'ECONNREFUSED') =>
    Object.assign(new Error(`connect ${code} /home/linus/.local/share/svall/gateway/authority.sock`), { code, syscall: 'connect' });

  it('asks the gateway on this machine again until it listens, and takes its record', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    let calls = 0;
    const get = async () => {
      calls++;
      if (calls === 1) throw unlistened('ENOENT');
      if (calls === 2) throw unlistened('ECONNREFUSED');
      return { fleetId, generation: 7, ownerMachineId: other };
    };
    await adoptAtStart({ handover: b.handover, authority: { get }, fleetId, log: silentLogger, timeoutMs: 5000 });
    expect(calls).toBe(3);
    expect(b.ownership.record()).toMatchObject({ generation: 7, ownerMachineId: other });
  });

  it('starts on the record it holds once the gateway on this machine has not listened in time, and asks no more', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    let calls = 0;
    await adoptAtStart({ handover: b.handover, authority: { get: async () => { calls++; throw unlistened('ECONNREFUSED'); } }, fleetId, log: silentLogger, timeoutMs: 600 });
    expect(calls).toBeGreaterThan(1);
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
    const asked = calls;
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toBe(asked);
  });

  it('asks a far gateway, or one that fails any other way, once', async () => {
    const failures = [
      new Error('connect ECONNREFUSED'),
      new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer: Connection refused'),
      Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT', syscall: 'spawn ssh' }),
    ];
    for (const failure of failures) {
      const b = boot({ record: { generation: 4, ownerMachineId: me } });
      let calls = 0;
      await adoptAtStart({ handover: b.handover, authority: { get: async () => { calls++; throw failure; } }, fleetId, log: silentLogger, timeoutMs: 5000 });
      expect(calls, failure.message).toBe(1);
      expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
    }
  });

  it('asks nothing for a fleet no gateway holds', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    await adoptAtStart({ handover: b.handover, fleetId, log: silentLogger });
    expect(b.ownership.writable()).toBe(true);
  });
});

describe('a gateway asked while the daemon runs', () => {
  afterEach(() => { vi.useRealTimers(); });
  const MINUTE = 60_000;
  // how often a running daemon asks
  const EVERY = 5 * MINUTE;
  const record = (generation: number, ownerMachineId: MachineId) => ({ fleetId, generation, ownerMachineId });

  // looks for a minute's passing every quarter of one, by the wall clock
  function watch(b: ReturnType<typeof boot>, get: Authority['get'], log: Logger = silentLogger) {
    vi.useFakeTimers();
    return watchGateway({ handover: b.handover, authority: () => ({ get }), fleetId, machineId: me, log });
  }

  it('lets the fleet go at the next ask once the gateway names another machine at a higher generation', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    let held = record(4, me);
    const stop = watch(b, async () => held);
    await vi.advanceTimersByTimeAsync(EVERY);
    expect(b.ownership.writable()).toBe(true);
    held = record(5, other);
    await vi.advanceTimersByTimeAsync(EVERY);
    stop();
    expect(b.ownership.record()).toMatchObject({ generation: 5, ownerMachineId: other });
    expect(b.ownership.writable()).toBe(false);
    expect(() => b.ownership.assertOwner('mutation')).toThrow(expect.objectContaining({ code: 'not_owner' }));
    expect(b.log).toEqual(['deactivate']);
  });

  it('changes nothing on a record that does not outrank the one held, and leaves an open handover to its journal', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    const stop = watch(b, async () => record(3, other));
    await vi.advanceTimersByTimeAsync(2 * EVERY);
    stop();
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
    expect(b.ownership.writable()).toBe(true);

    // the commit of the source's own handover, which the controller's Complete finishes
    const src = boot({ record: { generation: 4, ownerMachineId: me }, journal: source() });
    await enter(src);
    const stopped = watch(src, async () => record(5, other));
    await vi.advanceTimersByTimeAsync(2 * EVERY);
    stopped();
    expect(src.handover.journalState().kind).toBe('open');
    expect(src.ownership.isFrozen()).toBe(true);
    expect([...b.log, ...src.log]).toEqual([]);
  });

  it('leaves a record naming this machine to the next start, so a machine still running the fleet is not run beside', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: other } });
    const stop = watch(b, async () => record(5, me));
    await vi.advanceTimersByTimeAsync(2 * EVERY);
    stop();
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: other });
    expect(b.ownership.writable()).toBe(false);
    expect(b.log).toEqual([]);
  });

  it('asks every five minutes and at its first look after a sleep, never twice at once, and not once stopped', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    let calls = 0;
    const stop = watch(b, async () => { calls++; return record(4, me); });
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 15_000);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(1);
    // a sleep stops the timers and not the wall clock, however short it was
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(calls).toBe(2);
    stop();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(calls).toBe(2);

    let hung = 0;
    let answer = (_: OwnerRecord) => {};
    const stopHung = watch(b, () => { hung++; return new Promise((r) => { answer = r; }); });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(hung).toBe(1);
    // an answer that comes once the daemon is stopping is not taken
    stopHung();
    answer(record(5, other));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
    expect(b.log).toEqual([]);
  });

  it('asks again 15 s, 30 s, then a minute after asks that fail, up to five minutes apart, and every five minutes once one is answered', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    const at: number[] = [];
    let answers = false;
    const start = Date.now();
    const stop = watch(b, async () => {
      at.push((Date.now() - start) / 1000);
      if (!answers) throw new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer');
      return record(4, me);
    });
    await vi.advanceTimersByTimeAsync(EVERY + 15_000 + 30_000 + 60_000 + 120_000 + 240_000 + 2 * EVERY);
    expect(at).toEqual([300, 315, 345, 405, 525, 765, 1065, 1365]);
    answers = true;
    at.length = 0;
    await vi.advanceTimersByTimeAsync(EVERY + 2 * EVERY);
    stop();
    expect(at).toEqual([1665, 1965, 2265]);
  });

  it('counts an ask at start that went unanswered as the first that failed, so a daemon up before the network asks 15 s later', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    const at: number[] = [];
    const lines: string[] = [];
    let answers = false;
    vi.useFakeTimers();
    const start = Date.now();
    const get = async () => {
      at.push((Date.now() - start) / 1000);
      if (!answers) throw new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer');
      return record(4, me);
    };
    const log = { info: (l: string) => lines.push(l), error: (l: string) => lines.push(`error: ${l}`) };
    const answered = await adoptAtStart({ handover: b.handover, authority: { get }, fleetId, log, timeoutMs: 20 });
    expect(answered).toBe(false);
    const stop = watchGateway({ handover: b.handover, authority: () => ({ get }), fleetId, machineId: me, log, answered });
    await vi.advanceTimersByTimeAsync(15_000 + 30_000 + 60_000);
    expect(at).toEqual([0, 15, 45, 105]);
    answers = true;
    await vi.advanceTimersByTimeAsync(120_000 + EVERY);
    stop();
    expect(at).toEqual([0, 15, 45, 105, 225, 525]);
    expect(lines).toEqual([
      'the gateway did not say who owns this fleet (ssh trift exited 255 without an answer); starting on the record this machine holds',
      'the gateway answers again',
    ]);
  });

  it('asks at once after a wake that comes while an older ask is still out, and keeps asking soon while that one fails', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    let calls = 0;
    let answer = (_: OwnerRecord) => {};
    let fail = (_: Error) => {};
    const stop = watch(b, () => { calls++; return calls === 1 ? new Promise((r) => { answer = r; }) : new Promise((_, j) => { fail = j; }); });
    await vi.advanceTimersByTimeAsync(EVERY);
    expect(calls).toBe(1);
    // the machine sleeps while the first ask is out, and it is answered once it wakes
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    await vi.advanceTimersByTimeAsync(15_000);
    answer(record(4, me));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(2);
    // Wi-Fi not back yet: the ask after the wake fails, and the next goes 15 s later
    fail(new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer'));
    await vi.advanceTimersByTimeAsync(15_000);
    stop();
    expect(calls).toBe(3);
  });

  it('says once that the gateway does not answer and once that it answers again, and asks on after a record it could not take', async () => {
    const b = boot({ record: { generation: 4, ownerMachineId: me } });
    const lines: string[] = [];
    let calls = 0;
    const get = async () => {
      calls++;
      if (calls <= 3) throw new AuthorityFailure('disconnected', 'ssh trift exited 255 without an answer');
      // a record of another fleet, which the daemon refuses
      if (calls === 5) return { ...record(9, other), fleetId: FleetId.parse(crypto.randomUUID()) };
      return record(4, me);
    };
    const stop = watch(b, get, { info: (l) => lines.push(l), error: (l) => lines.push(`error: ${l}`) });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    stop();
    expect(calls).toBe(8);
    expect(lines).toEqual([
      'the gateway did not say who owns this fleet (ssh trift exited 255 without an answer); this machine keeps the record it holds and asks again, at most five minutes apart',
      'the gateway answers again',
      expect.stringMatching(/^error: the gateway's record at generation 9 could not be taken: the record is for fleet /),
    ]);
    expect(b.ownership.record()).toMatchObject({ generation: 4, ownerMachineId: me });
  });
});
