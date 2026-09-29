import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DestinationJournal, HandoverJournal, SourceJournal, openJournal } from '../../src/handover/journal.js';
import { realStages, type DurableStages } from '../../src/handover/durable.js';
import { resolvePaths } from '../../src/paths.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const digest = 'a'.repeat(64);

const source = (over: Partial<SourceJournal> = {}): SourceJournal => SourceJournal.parse({
  role: 'source',
  transactionId: 'tx-1',
  generation: 4,
  fleetId: crypto.randomUUID(),
  fromMachineId: crypto.randomUUID(),
  toMachineId: crypto.randomUUID(),
  phase: 'freeze',
  manifestDigest: digest,
  stoppedTerminals: [{ characterId: 'c_1', term: 2 }],
  updatedAt: 1,
  ...over,
});

const destination = (over: Partial<DestinationJournal> = {}): DestinationJournal => DestinationJournal.parse({
  role: 'destination',
  transactionId: 'tx-1',
  generation: 5,
  fleetId: crypto.randomUUID(),
  fromMachineId: crypto.randomUUID(),
  toMachineId: crypto.randomUUID(),
  phase: 'prepare',
  manifestDigest: digest,
  preparedPath: '/x/handover/prepared-tx-1.json',
  activation: [{ characterId: 'c_1', ok: false, error: 'no tmux' }],
  updatedAt: 2,
  ...over,
});

describe('journal schemas', () => {
  it('discriminates on role', () => {
    expect(HandoverJournal.parse(source()).role).toBe('source');
    expect(HandoverJournal.parse(destination()).role).toBe('destination');
    expect(() => HandoverJournal.parse({ ...source(), role: 'gateway' })).toThrow();
  });

  it('requires a manifest digest on the destination and allows none on the source', () => {
    expect(SourceJournal.parse({ ...source(), manifestDigest: undefined }).manifestDigest).toBeUndefined();
    expect(() => DestinationJournal.parse({ ...destination(), manifestDigest: undefined })).toThrow();
  });

  it('names a stopped terminal the way every other call does: absent is the main one', () => {
    expect(SourceJournal.parse({ ...source(), stoppedTerminals: [{ characterId: 'c_1' }] }).stoppedTerminals)
      .toEqual([{ characterId: 'c_1' }]);
    expect(() => SourceJournal.parse({ ...source(), stoppedTerminals: [{ characterId: 'c_1', term: 1 }] })).toThrow();
  });

  it('keeps stopped terminals on the source', () => {
    const j = source({ error: 'rsync died' });
    expect(j.stoppedTerminals).toEqual([{ characterId: 'c_1', term: 2 }]);
    expect(j.error).toBe('rsync died');
  });
});

describe('openJournal', () => {
  it('reports none when nothing has been written', () => {
    expect(openJournal(resolvePaths(makeHome())).load()).toEqual({ kind: 'none' });
  });

  it('writes under handover/ and loads the phase back', () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    openJournal(paths).write(source({ phase: 'transfer' }));
    expect(paths.journal).toBe(path.join(home, 'handover', 'journal.json'));
    expect(fs.statSync(paths.journal).mode & 0o777).toBe(0o600);
    const loaded = openJournal(paths).load();
    expect(loaded).toMatchObject({ kind: 'open', journal: { role: 'source', phase: 'transfer' } });
  });

  it('survives a crash between the rename and the directory fsync', () => {
    const paths = resolvePaths(makeHome());
    const stages: Partial<DurableStages> = {
      fsyncDir: (dir: string) => { realStages.fsyncDir(dir); throw new Error('crash'); },
    };
    expect(() => openJournal(paths, { stages }).write(destination({ phase: 'commit' }))).toThrow('crash');
    expect(openJournal(paths).load()).toMatchObject({ kind: 'open', journal: { role: 'destination', phase: 'commit' } });
  });

  it('quarantines a malformed journal instead of leaving it in place', () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    fs.mkdirSync(paths.handoverDir, { recursive: true });
    fs.writeFileSync(paths.journal, '{not json');
    const loaded = openJournal(paths).load();
    expect(loaded.kind).toBe('quarantined');
    if (loaded.kind !== 'quarantined') throw new Error('unreachable');
    expect(path.basename(loaded.file)).toMatch(/^journal\.json\.broken-\d+$/);
    expect(fs.existsSync(paths.journal)).toBe(false);
    expect(fs.readFileSync(loaded.file, 'utf8')).toBe('{not json');
  });

  it('quarantines a journal the schema rejects', () => {
    const paths = resolvePaths(makeHome());
    fs.mkdirSync(paths.handoverDir, { recursive: true });
    fs.writeFileSync(paths.journal, JSON.stringify({ role: 'source', phase: 'nowhere' }));
    expect(openJournal(paths).load().kind).toBe('quarantined');
  });

  it('refuses a journal it cannot read rather than reporting none', () => {
    const paths = resolvePaths(makeHome());
    fs.mkdirSync(paths.journal, { recursive: true });
    expect(openJournal(paths).load().kind).toBe('quarantined');
  });

  it('refuses an unreadable journal file rather than reporting none', () => {
    if (process.getuid?.() === 0) return;
    const paths = resolvePaths(makeHome());
    fs.mkdirSync(paths.handoverDir, { recursive: true });
    fs.writeFileSync(paths.journal, JSON.stringify(source()), { mode: 0o000 });
    expect(openJournal(paths).load().kind).toBe('quarantined');
    expect(fs.existsSync(paths.journal)).toBe(false);
  });

  it('closes an open journal so the next load finds none', () => {
    const paths = resolvePaths(makeHome());
    const j = openJournal(paths);
    j.write(source());
    j.close();
    expect(fs.existsSync(paths.journal)).toBe(false);
    expect(j.load()).toEqual({ kind: 'none' });
    expect(() => j.close()).not.toThrow();
  });
});
