import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetConfig, FleetId, MachineId, TRANSFER_SCHEMA_VERSION, emptyState, type HandoverPhase, type OwnerRecord, type Result, type Verdict } from '@svall/protocol';
import { manifestDigest } from '@svall/svalld/handover/manifest';
import { transactionDir } from '../../src/controller/progress.js';
import { assess, fileStore, forgettable, type ControllerJournal, type FrozenManifest, type Observation } from '../../src/controller/recovery.js';

const fleetId = FleetId.parse(crypto.randomUUID());
const mac = MachineId.parse(crypto.randomUUID());
const trift = MachineId.parse(crypto.randomUUID());
const TX = 'tx-1';

const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-recovery-')); temps.push(d); return d; };

const journal = (over: Partial<ControllerJournal> = {}): ControllerJournal => ({
  version: 1, fleetId, transactionId: TX, generation: 4,
  source: { machineId: mac, name: 'mac' }, destination: { machineId: trift, name: 'trift', ssh: 'trift' },
  choices: {}, phase: 'transfer', startedAt: 1, updatedAt: 2, ...over,
});

const tx = (phase: 'preparing' | 'ready-to-commit' | 'committed', id = TX) => ({ id, fromMachineId: mac, toMachineId: trift, phase, startedAt: 1 });
const at = (generation: number, owner: MachineId, transaction?: OwnerRecord['transaction']): OwnerRecord =>
  ({ fleetId, generation, ownerMachineId: owner, ...(transaction && { transaction }) });

const status = (phase?: HandoverPhase, id = TX): Result<'handover.status'> =>
  (phase ? { transaction: { ...tx('preparing', id), phase } } : {});

type Case = { name: string; o: Observation; want: Partial<Verdict> };

const cases: Case[] = [
  {
    name: 'nothing anywhere',
    o: { gateway: { ok: true, value: at(4, mac) } },
    want: { standing: 'none', action: 'none', safe: [] },
  },
  {
    name: 'an open transaction before the commit can go on or be aborted',
    o: { controller: journal(), gateway: { ok: true, value: at(4, mac, tx('ready-to-commit')) } },
    want: { standing: 'open', action: 'continue', safe: ['resume', 'abort'], transactionId: TX, generation: 4, phase: 'transfer' },
  },
  {
    name: 'a committed transaction only goes forward, whatever the controller last wrote',
    o: { controller: journal({ phase: 'commit' }), gateway: { ok: true, value: at(5, trift, tx('committed')) } },
    want: { standing: 'committed', action: 'continue', safe: ['resume'] },
  },
  {
    name: 'a transaction the gateway cleared after its commit is only finished',
    o: { controller: journal({ phase: 'complete' }), gateway: { ok: true, value: at(5, trift) } },
    want: { standing: 'moved', action: 'finish', safe: ['resume'] },
  },
  {
    name: 'a transaction the gateway aborted leaves only the abort to finish',
    o: { controller: journal({ phase: 'prepare' }), gateway: { ok: true, value: at(4, mac) } },
    want: { standing: 'returned', action: 'finish-abort', safe: ['abort'] },
  },
  {
    name: 'no word from the gateway makes nothing safe, not even an abort',
    o: { controller: journal({ phase: 'commit' }), gateway: { ok: false, error: 'ssh: connect to host trift: timed out' } },
    want: { standing: 'unknown', action: 'none', safe: [] },
  },
  {
    name: 'a Begin whose answer was lost is the gateway\'s preparing handover between the same machines',
    o: { controller: journal({ transactionId: undefined, phase: 'begin' }), gateway: { ok: true, value: at(4, mac, tx('preparing', 'tx-9')) } },
    want: { standing: 'open', action: 'continue', transactionId: 'tx-9' },
  },
  {
    name: 'a Begin the gateway never made moved nothing',
    o: { controller: journal({ transactionId: undefined, phase: 'begin' }), gateway: { ok: true, value: at(4, mac) } },
    want: { standing: 'none', action: 'finish-abort', safe: ['abort'] },
  },
  {
    name: 'another transaction holding the fleet is none of this controller\'s to touch',
    o: { controller: journal(), gateway: { ok: true, value: at(4, mac, tx('preparing', 'tx-2')) } },
    want: { standing: 'returned', action: 'finish-abort' },
  },
  {
    name: 'a fleet moved on past this transaction by another is not this one\'s to finish',
    o: { controller: journal(), gateway: { ok: true, value: at(6, mac) } },
    want: { standing: 'superseded', action: 'none', safe: [] },
  },
  {
    name: 'without the controller\'s journal, the gateway\'s open transaction is the one',
    o: {
      gateway: { ok: true, value: at(5, trift, tx('committed')) },
      destination: { ok: true, value: { status: status('commit') } },
      source: { ok: true, value: { status: status('freeze'), ownership: { fleetId, generation: 4, ownerMachineId: mac, frozen: true } } },
    },
    want: { standing: 'committed', action: 'continue', transactionId: TX, generation: 4, journals: { source: 'freeze', destination: 'commit' }, phase: 'commit' },
  },
  {
    name: 'without the controller\'s journal, a source still frozen for a transaction the gateway aborted is let go',
    o: {
      gateway: { ok: true, value: at(4, mac) },
      source: { ok: true, value: { status: status('freeze'), ownership: { fleetId, generation: 4, ownerMachineId: mac, frozen: true } } },
      destination: { ok: false, error: 'trift did not answer' },
    },
    want: { standing: 'returned', action: 'finish-abort', transactionId: TX, generation: 4 },
  },
  {
    name: 'without the controller\'s journal, a source left open by a moved fleet is finished',
    o: {
      gateway: { ok: true, value: at(5, trift) },
      source: { ok: true, value: { status: status('freeze'), ownership: { fleetId, generation: 4, ownerMachineId: mac, frozen: true } } },
      destination: { ok: true, value: { status: status() } },
    },
    want: { standing: 'moved', action: 'finish' },
  },
];

describe('assess', () => {
  it.each(cases)('$name', ({ o, want }) => {
    expect(assess(o)).toMatchObject(want);
  });

  it('never offers an abort once the gateway has moved the fleet', () => {
    for (const record of [at(5, trift, tx('committed')), at(5, trift)]) {
      for (const phase of ['freeze', 'transfer', 'prepare', 'ready', 'commit', 'activate', 'complete'] as const) {
        expect(assess({ controller: journal({ phase }), gateway: { ok: true, value: record } }).safe, `${phase} ${JSON.stringify(record)}`).not.toContain('abort');
      }
    }
  });
});

describe('forgettable', () => {
  const ownership = (generation: number, owner: MachineId) => ({ fleetId, generation, ownerMachineId: owner, frozen: false });
  const daemons = (source = status(), destination = status()): Pick<Observation, 'source' | 'destination'> => ({
    source: { ok: true, value: { status: source, ownership: ownership(5, trift) } },
    destination: { ok: true, value: { status: destination } },
  });
  const judge = (o: Observation) => forgettable(o, assess(o)).ok;

  it('lets go of a journal the gateway has moved past, and of one nothing anywhere still holds', () => {
    expect(judge({ controller: journal(), gateway: { ok: true, value: at(7, trift, tx('preparing', 'tx-9')) }, ...daemons() })).toBe(true);
    expect(judge({ controller: journal({ phase: 'complete' }), gateway: { ok: true, value: at(6, mac) }, ...daemons() })).toBe(true);
  });

  it('keeps a journal while anything it could drive is still open, while the gateway cannot say, or when there is none', () => {
    expect(judge({ controller: journal(), gateway: { ok: true, value: at(4, mac, tx('ready-to-commit')) }, ...daemons() })).toBe(false);
    expect(judge({ controller: journal({ phase: 'complete' }), gateway: { ok: true, value: at(5, trift) }, ...daemons(status('complete')) })).toBe(false);
    expect(judge({ controller: journal({ phase: 'prepare' }), gateway: { ok: true, value: at(4, mac) }, ...daemons(status(), status('prepare')) })).toBe(false);
    expect(judge({ controller: journal(), gateway: { ok: false, error: 'ssh: connect to host gate port 22: Connection refused' }, ...daemons() })).toBe(false);
    expect(judge({ controller: journal({ phase: 'complete' }), gateway: { ok: true, value: at(5, trift) }, source: { ok: false, error: 'unreachable' }, destination: { ok: true, value: { status: status() } } })).toBe(false);
    expect(judge({ gateway: { ok: true, value: at(4, mac) } })).toBe(false);
  });
});

describe('fileStore', () => {
  const manifest: FrozenManifest = {
    version: TRANSFER_SCHEMA_VERSION, transactionId: TX, generation: 4, fromMachineId: mac, toMachineId: trift,
    home: '/Users/linus', fleet: FleetConfig.parse({ id: fleetId }),
    snapshot: emptyState(), excludes: [], roots: [], sessions: [],
  };

  it('keeps the journal and each transaction\'s files mode 0600, and forgets them together', () => {
    const dir = tmp();
    const store = fileStore(dir);
    expect(store.read()).toBeUndefined();
    store.write(journal());
    store.saveManifest(TX, manifest);
    store.saveLanded(TX, [{ id: 'r_1', files: [] }]);
    expect(store.read()).toEqual(journal());
    expect(store.manifest(TX, manifestDigest(manifest))).toEqual(manifest);
    // a manifest that is not the one the digest names is no manifest at all
    expect(store.manifest(TX, 'f'.repeat(64))).toBeUndefined();
    for (const f of [path.join(dir, 'handover.json'), path.join(dir, 'handover', TX, 'manifest.json'), path.join(dir, 'handover', TX, 'landed.json')]) {
      expect(fs.statSync(f).mode & 0o777, f).toBe(0o600);
    }
    // no token or secret has a field to be written into
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'handover.json'), 'utf8'))).some((k) => /token|secret/i.test(k))).toBe(false);
    store.clear(TX);
    expect(store.read()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'handover', TX))).toBe(false);
  });

  it('keeps each transaction\'s folder one name under its own, so clearing a transaction named . or .. removes nothing else', () => {
    const dir = tmp();
    for (const tx of ['.', '..', '../x', 'a/b']) expect(path.dirname(transactionDir(tx, dir))).toBe(path.join(dir, 'handover'));
    const store = fileStore(dir);
    store.saveManifest(TX, manifest);
    fs.writeFileSync(path.join(dir, 'route.json'), '{}');
    for (const tx of ['.', '..']) {
      store.write(journal());
      store.clear(tx);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['handover', 'route.json']);
    expect(store.manifest(TX, manifestDigest(manifest))).toEqual(manifest);
  });

  it('reads a journal it cannot parse as none and leaves it where it is, and sets it aside only for a run that writes one', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'handover.json'), '{ "version": 1, "fleet');
    expect(fileStore(dir).read()).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual(['handover.json']);
    expect(fileStore(dir).read(true)).toBeUndefined();
    expect(fs.readdirSync(dir).some((f) => f.startsWith('handover.json.broken-'))).toBe(true);
  });
});
