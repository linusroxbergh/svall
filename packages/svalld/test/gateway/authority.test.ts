import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FleetId, MachineId, OwnerRecord } from '@svall/protocol';
import {
  FleetAuthority, gatewayPaths, transition,
  type AuthorityErrorCode, type OwnerOp, type OwnerParams, type OwnerParamsOf, type Transition,
} from '../../src/gateway/authority.js';

const FLEET = '3f1a0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as FleetId;
const MAC = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const OTHER = '1111ab1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

const owned: OwnerRecord = { fleetId: FLEET, generation: 3, ownerMachineId: MAC };
const TX = { id: 'tx1', fromMachineId: MAC, toMachineId: TRIFT, phase: 'preparing', startedAt: 10 } as const;
const preparing: OwnerRecord = { ...owned, transaction: { ...TX } };
const readied: OwnerRecord = { ...owned, transaction: { ...TX, phase: 'ready-to-commit', sourceFrozenAt: 11, preparedDigest: DIGEST } };
const committed: OwnerRecord = { fleetId: FLEET, generation: 4, ownerMachineId: TRIFT, transaction: { ...TX, phase: 'committed', sourceFrozenAt: 11, preparedDigest: DIGEST } };
const moved: OwnerRecord = { fleetId: FLEET, generation: 4, ownerMachineId: TRIFT };

const createParams = { fleetId: FLEET, initialOwnerMachineId: MAC };
const beginParams = { fleetId: FLEET, expectedGeneration: 3, fromMachineId: MAC, toMachineId: TRIFT };
const readyParams = { fleetId: FLEET, transactionId: 'tx1', expectedGeneration: 3, sourceFrozen: true as const, preparedDigest: DIGEST };
const commitParams = { fleetId: FLEET, transactionId: 'tx1', expectedGeneration: 3 };
const abortParams = { fleetId: FLEET, transactionId: 'tx1', expectedGeneration: 3 };
const completeParams = { fleetId: FLEET, transactionId: 'tx1', generation: 4 };

const at = (record: OwnerRecord | undefined, op: OwnerOp, params: OwnerParams, now = 100): Transition =>
  transition(record, op, params, now, () => 'tx-new');
const code = (t: Transition): string => ('error' in t ? t.error.code : 'ok');
const ok = (t: Transition): OwnerRecord => {
  if ('error' in t) throw new Error(`expected a record, got ${t.error.code}: ${t.error.message}`);
  return t.record;
};

describe('transition refusals', () => {
  const refusals: [string, OwnerRecord | undefined, OwnerOp, OwnerParams, AuthorityErrorCode][] = [
    ['get without a record', undefined, 'owner.get', { fleetId: FLEET }, 'not_found'],
    ['begin without a record', undefined, 'owner.begin', beginParams, 'not_found'],
    ['ready without a record', undefined, 'owner.ready', readyParams, 'not_found'],
    ['commit without a record', undefined, 'owner.commit', commitParams, 'not_found'],
    ['abort without a record', undefined, 'owner.abort', abortParams, 'not_found'],
    ['complete without a record', undefined, 'owner.complete', completeParams, 'not_found'],

    ['create over another owner', owned, 'owner.create', { fleetId: FLEET, initialOwnerMachineId: TRIFT }, 'already_exists'],
    ['create over a fleet that has moved', moved, 'owner.create', { fleetId: FLEET, initialOwnerMachineId: TRIFT }, 'already_exists'],

    ['begin to the machine that holds it', owned, 'owner.begin', { ...beginParams, toMachineId: MAC }, 'invalid_request'],
    ['begin at a stale generation', owned, 'owner.begin', { ...beginParams, expectedGeneration: 2 }, 'generation_mismatch'],
    ['begin from a machine that does not own it', owned, 'owner.begin', { ...beginParams, fromMachineId: OTHER }, 'not_owner'],
    ['begin beside another handover', preparing, 'owner.begin', { ...beginParams, toMachineId: OTHER }, 'transaction_mismatch'],
    ['begin over a handover already ready', readied, 'owner.begin', beginParams, 'invalid_phase'],
    ['begin after the commit', committed, 'owner.begin', { ...beginParams, expectedGeneration: 4, fromMachineId: TRIFT, toMachineId: MAC }, 'handover_committed'],

    ['ready at a stale generation', preparing, 'owner.ready', { ...readyParams, expectedGeneration: 2 }, 'generation_mismatch'],
    ['ready with no handover open', owned, 'owner.ready', readyParams, 'transaction_mismatch'],
    ['ready for another handover', preparing, 'owner.ready', { ...readyParams, transactionId: 'tx9' }, 'transaction_mismatch'],
    ['ready on a different prepared digest', readied, 'owner.ready', { ...readyParams, preparedDigest: OTHER_DIGEST }, 'invalid_phase'],
    ['ready after the commit', committed, 'owner.ready', { ...readyParams, expectedGeneration: 4 }, 'handover_committed'],

    ['commit before ready', preparing, 'owner.commit', commitParams, 'invalid_phase'],
    ['commit at a stale generation', readied, 'owner.commit', { ...commitParams, expectedGeneration: 2 }, 'generation_mismatch'],
    ['commit with no handover open', owned, 'owner.commit', commitParams, 'transaction_mismatch'],
    ['commit another handover', readied, 'owner.commit', { ...commitParams, transactionId: 'tx9' }, 'transaction_mismatch'],

    ['abort at a stale generation', preparing, 'owner.abort', { ...abortParams, expectedGeneration: 2 }, 'generation_mismatch'],
    ['abort another handover', preparing, 'owner.abort', { ...abortParams, transactionId: 'tx9' }, 'transaction_mismatch'],
    ['abort after the commit', committed, 'owner.abort', { ...abortParams, expectedGeneration: 4 }, 'handover_committed'],

    ['complete at a stale generation', committed, 'owner.complete', { ...completeParams, generation: 3 }, 'generation_mismatch'],
    ['complete another handover', committed, 'owner.complete', { ...completeParams, transactionId: 'tx9' }, 'transaction_mismatch'],
    ['complete before the commit', readied, 'owner.complete', { ...completeParams, generation: 3 }, 'invalid_phase'],
  ];

  it.each(refusals)('refuses %s', (_name, record, op, params, expected) => {
    expect(code(at(record, op, params))).toBe(expected);
  });

  it('says which generation the fleet is at', () => {
    const t = at(owned, 'owner.begin', { ...beginParams, expectedGeneration: 2 });
    expect('error' in t && t.error.data).toEqual({ expected: 2, actual: 3 });
  });

  it('names the handover a mismatched request is not', () => {
    const t = at(preparing, 'owner.ready', { ...readyParams, transactionId: 'tx9' });
    expect('error' in t && t.error.data).toEqual({ expected: 'tx9', actual: 'tx1' });
  });
});

describe('transitions', () => {
  it('creates a generation-zero record for a fleet the gateway has never seen', () => {
    expect(ok(at(undefined, 'owner.create', createParams))).toEqual({ fleetId: FLEET, generation: 0, ownerMachineId: MAC });
  });

  it('opens a handover from the current owner', () => {
    expect(ok(at(owned, 'owner.begin', beginParams))).toEqual({
      ...owned,
      transaction: { id: 'tx-new', fromMachineId: MAC, toMachineId: TRIFT, phase: 'preparing', startedAt: 100 },
    });
  });

  it('records the freeze and the prepared digest', () => {
    expect(ok(at(preparing, 'owner.ready', readyParams))).toEqual({
      ...owned,
      transaction: { ...TX, phase: 'ready-to-commit', sourceFrozenAt: 100, preparedDigest: DIGEST },
    });
  });

  it('swaps the owner and raises the generation on commit', () => {
    expect(ok(at(readied, 'owner.commit', commitParams))).toEqual(committed);
  });

  it('clears a handover that has not committed', () => {
    expect(ok(at(preparing, 'owner.abort', abortParams))).toEqual(owned);
    expect(ok(at(readied, 'owner.abort', abortParams))).toEqual(owned);
  });

  it('clears the committed handover while keeping owner and generation', () => {
    expect(ok(at(committed, 'owner.complete', completeParams))).toEqual(moved);
  });

  it('returns the record as it stands', () => {
    expect(ok(at(readied, 'owner.get', { fleetId: FLEET }))).toEqual(readied);
  });
});

describe('replayed requests', () => {
  it('returns the same record for every op a caller repeats', () => {
    const created = ok(at(undefined, 'owner.create', createParams));
    expect(ok(at(created, 'owner.create', createParams))).toEqual(created);
    expect(ok(at(preparing, 'owner.begin', beginParams))).toEqual(preparing);
    expect(ok(at(readied, 'owner.ready', readyParams))).toEqual(readied);
    expect(ok(at(owned, 'owner.abort', abortParams))).toEqual(owned);
    expect(ok(at(moved, 'owner.complete', completeParams))).toEqual(moved);
  });

  it('answers a commit whose reply the caller never saw', () => {
    expect(ok(at(committed, 'owner.commit', commitParams))).toEqual(committed);
    expect(ok(at(committed, 'owner.commit', { ...commitParams, expectedGeneration: 4 }))).toEqual(committed);
  });
});

const prefix = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'svall-gateway-'));

describe('the record store', () => {
  it('keeps the record for the next process to read', async () => {
    const dir = prefix();
    const first = new FleetAuthority(dir);
    ok(await first.apply('owner.create', createParams));
    ok(await first.apply('owner.begin', { ...beginParams, expectedGeneration: 0 }));
    const record = ok(await new FleetAuthority(dir).apply('owner.get', { fleetId: FLEET }));
    expect(record.transaction?.phase).toBe('preparing');
  });

  it('writes the record where only its owner can read it', async () => {
    const dir = prefix();
    ok(await new FleetAuthority(dir).apply('owner.create', createParams));
    const paths = gatewayPaths(dir);
    expect(fs.statSync(path.join(paths.fleets, `${FLEET}.json`)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.fleets).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.dir).mode & 0o777).toBe(0o700);
  });

  it('withholds the answer until the record is on disk', async () => {
    const dir = prefix();
    const failAfterRename = { fsyncDir: () => { throw Object.assign(new Error('fsync refused'), { code: 'EIO' }); } };
    const authority = new FleetAuthority(dir, { durable: { stages: failAfterRename } });
    await expect(authority.apply('owner.create', createParams)).rejects.toThrow('fsync refused');
    expect(ok(await new FleetAuthority(dir).apply('owner.get', { fleetId: FLEET })).generation).toBe(0);
  });

  it('quarantines a record it cannot read and refuses the fleet until it is repaired', async () => {
    const dir = prefix();
    const authority = new FleetAuthority(dir, {});
    ok(await authority.apply('owner.create', createParams));
    const file = path.join(gatewayPaths(dir).fleets, `${FLEET}.json`);
    fs.writeFileSync(file, '{ "fleetId": ');

    expect(code(await authority.apply('owner.get', { fleetId: FLEET }))).toBe('authority_corrupt');
    expect(fs.readdirSync(gatewayPaths(dir).fleets).some((n) => n.includes('.broken-'))).toBe(true);
    expect(code(await authority.apply('owner.create', createParams))).toBe('authority_corrupt');
    expect(code(await authority.apply('owner.begin', beginParams))).toBe('authority_corrupt');
    expect(fs.existsSync(file)).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ fleetId: FLEET, generation: 0, ownerMachineId: MAC }));
    expect(ok(await authority.apply('owner.get', { fleetId: FLEET })).ownerMachineId).toBe(MAC);
  });

  it('refuses a quarantined fleet to a gateway that starts after the quarantine', async () => {
    const dir = prefix();
    const first = new FleetAuthority(dir, {});
    ok(await first.apply('owner.create', createParams));
    const file = path.join(gatewayPaths(dir).fleets, `${FLEET}.json`);
    fs.writeFileSync(file, '{ "fleetId": ');
    expect(code(await first.apply('owner.get', { fleetId: FLEET }))).toBe('authority_corrupt');

    const restarted = new FleetAuthority(dir, {});
    expect(code(await restarted.apply('owner.get', { fleetId: FLEET }))).toBe('authority_corrupt');
    expect(code(await restarted.apply('owner.create', { fleetId: FLEET, initialOwnerMachineId: OTHER }))).toBe('authority_corrupt');
    expect(code(await restarted.apply('owner.begin', { ...beginParams, expectedGeneration: 0 }))).toBe('authority_corrupt');

    fs.writeFileSync(file, JSON.stringify({ fleetId: FLEET, generation: 0, ownerMachineId: MAC }));
    expect(ok(await restarted.apply('owner.get', { fleetId: FLEET })).ownerMachineId).toBe(MAC);
    expect(fs.existsSync(`${file}.quarantined`)).toBe(false);
  });

  it('leaves a record it cannot read where it is', async () => {
    const dir = prefix();
    ok(await new FleetAuthority(dir).apply('owner.create', createParams));
    const file = path.join(gatewayPaths(dir).fleets, `${FLEET}.json`);
    fs.chmodSync(file, 0o000);

    expect(code(await new FleetAuthority(dir).apply('owner.get', { fleetId: FLEET }))).toBe('authority_corrupt');
    expect(fs.readdirSync(gatewayPaths(dir).fleets)).toEqual([`${FLEET}.json`]);

    fs.chmodSync(file, 0o600);
    expect(ok(await new FleetAuthority(dir).apply('owner.get', { fleetId: FLEET })).generation).toBe(0);
  });

  it('lets exactly one of two handovers open on a fleet', async () => {
    const authority = new FleetAuthority(prefix());
    ok(await authority.apply('owner.create', createParams));
    const both = await Promise.all([
      authority.apply('owner.begin', { ...beginParams, expectedGeneration: 0 }),
      authority.apply('owner.begin', { ...beginParams, expectedGeneration: 0, toMachineId: OTHER }),
    ]);
    expect(both.map(code).filter((c) => c === 'ok')).toHaveLength(1);
    expect(both.map(code)).toContain('transaction_mismatch');
  });
});

describe('a forced record', () => {
  const shown = [{ source: 'gateway record', generation: 3 }, { source: 'trift journal tx1', generation: 4 }];
  const forceParams = (over: Partial<OwnerParamsOf<'owner.force'>> = {}): OwnerParamsOf<'owner.force'> => ({
    fleetId: FLEET, expected: preparing, ownerMachineId: TRIFT, generation: 5, requestingMachineId: MAC, reason: 'the gateway lost its disk', shown, ...over,
  });
  const forced: OwnerRecord = { fleetId: FLEET, generation: 5, ownerMachineId: TRIFT };

  it('names the chosen owner at the generation asked for and clears any handover', () => {
    expect(ok(at(preparing, 'owner.force', forceParams()))).toEqual(forced);
    expect(ok(at(committed, 'owner.force', forceParams({ expected: committed, ownerMachineId: MAC })))).toEqual({ ...forced, ownerMachineId: MAC });
  });

  it('writes into a gateway that holds no record only when it was read holding none', () => {
    expect(ok(at(undefined, 'owner.force', forceParams({ expected: null })))).toEqual(forced);
    expect(code(at(owned, 'owner.force', forceParams({ expected: null })))).toBe('record_changed');
    expect(code(at(undefined, 'owner.force', forceParams()))).toBe('record_changed');
  });

  it('refuses a record that changed since it was read, and says what it holds now', () => {
    const t = at(readied, 'owner.force', forceParams());
    expect(code(t)).toBe('record_changed');
    expect('error' in t && t.error.data).toEqual({ actual: readied });
  });

  it('refuses a generation that is not above the record, a handover it holds open, and every generation shown', () => {
    expect(code(at(preparing, 'owner.force', forceParams({ generation: 4 })))).toBe('invalid_request');
    // an open handover would commit at the generation after the record's
    expect(code(at(preparing, 'owner.force', forceParams({ generation: 4, shown: [] })))).toBe('invalid_request');
    expect(code(at(readied, 'owner.force', forceParams({ expected: readied, generation: 4, shown: [] })))).toBe('invalid_request');
    expect(ok(at(preparing, 'owner.force', forceParams({ generation: 5, shown: [] })))).toEqual(forced);
    expect(code(at(owned, 'owner.force', forceParams({ expected: owned, generation: 3, shown: [] })))).toBe('invalid_request');
    expect(ok(at(owned, 'owner.force', forceParams({ expected: owned, generation: 4, shown: [] })))).toEqual({ ...forced, generation: 4 });
    expect(ok(at(committed, 'owner.force', forceParams({ expected: committed, generation: 5, shown: [] })))).toEqual(forced);
  });

  it('answers a force whose reply the caller never saw with the record it left', () => {
    expect(ok(at(forced, 'owner.force', forceParams()))).toEqual(forced);
  });
});

describe('the recovery audit', () => {
  const params = { fleetId: FLEET, expected: null, ownerMachineId: TRIFT, generation: 2, requestingMachineId: MAC, reason: 'a new gateway', shown: [{ source: 'route cache', generation: 1 }] };

  it('appends one line per forced record before the record is written, readable only by its owner', async () => {
    const dir = prefix();
    const authority = new FleetAuthority(dir, { now: () => 1_700_000_000_000 });
    ok(await authority.apply('owner.force', params));
    ok(await authority.apply('owner.force', params));
    ok(await authority.apply('owner.force', { ...params, expected: { fleetId: FLEET, generation: 2, ownerMachineId: TRIFT }, ownerMachineId: MAC, generation: 3 }));
    expect(code(await authority.apply('owner.force', params))).toBe('record_changed');

    const file = gatewayPaths(dir).recoveries;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        at: new Date(1_700_000_000_000).toISOString(), fleetId: FLEET, before: null, after: { fleetId: FLEET, generation: 2, ownerMachineId: TRIFT },
        requestingMachineId: MAC, reason: 'a new gateway', shown: [{ source: 'route cache', generation: 1 }],
      },
      expect.objectContaining({ before: { fleetId: FLEET, generation: 2, ownerMachineId: TRIFT }, after: { fleetId: FLEET, generation: 3, ownerMachineId: MAC } }),
    ]);
  });

  it('writes no record when its audit line cannot be written', async () => {
    const dir = prefix();
    fs.mkdirSync(gatewayPaths(dir).recoveries, { recursive: true });
    const authority = new FleetAuthority(dir);
    await expect(authority.apply('owner.force', params)).rejects.toThrow();
    expect(code(await authority.apply('owner.get', { fleetId: FLEET }))).toBe('not_found');
  });
});
