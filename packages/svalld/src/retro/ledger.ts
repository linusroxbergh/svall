import fs from 'node:fs';
import { z } from 'zod';
import { LedgerEntry, type DismissReason, type Finding, type LedgerStatus } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { sha256Hex } from '../hash.js';

export type Ledger = Record<string, LedgerEntry>;

/** The id a finding keeps in every run: the same category, file and skill or rule are the same issue. */
export const findingId = (category: string, realPath: string, subject: string): string =>
  sha256Hex([category, realPath, subject].join('\n')).slice(0, 10);

/** The ledger on disk; a missing or unreadable one is empty, and an entry of another shape is dropped. */
export function readLedger(file: string): Ledger {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const entries = z.record(z.string(), z.unknown()).safeParse(raw).data ?? {};
  return Object.fromEntries(Object.entries(entries).flatMap(([id, e]) => {
    const entry = LedgerEntry.safeParse(e).data;
    return entry ? [[id, entry]] : [];
  }));
}

export const writeLedger = (file: string, ledger: Ledger): void => writeDurable(file, Buffer.from(JSON.stringify(ledger, null, 2)), { mode: 0o600 });

/** Adds a run's findings: a new one opens, one seen before is seen again and keeps its status. */
export function recordFindings(ledger: Ledger, findings: Finding[], now: number): Ledger {
  const next = { ...ledger };
  for (const f of findings) {
    const had = next[f.id];
    next[f.id] = had
      ? { ...had, title: f.title, lastSeen: now }
      : { id: f.id, category: f.category, title: f.title, status: 'open', firstSeen: now, lastSeen: now, measure: f.measure };
  }
  return next;
}

/** Sets a finding's status as the user decided; a fix records its date, a dismissal its reason. */
export function mark(ledger: Ledger, id: string, status: LedgerStatus, o: { at: number; reason?: DismissReason }): Ledger {
  const had = ledger[id];
  if (!had) return ledger;
  const { reason: _r, fixedAt: _f, ...rest } = had;
  return {
    ...ledger,
    [id]: { ...rest, status, ...(status === 'dismissed' && o.reason && { reason: o.reason }), ...(status === 'fixed' && { fixedAt: o.at }) },
  };
}

/** The kinds of finding the user turned down, which the next synthesis is told this user rejects. */
export const dismissedCategories = (ledger: Ledger): { category: string; reason: DismissReason }[] => {
  const seen = new Map<string, { category: string; reason: DismissReason }>();
  for (const e of Object.values(ledger)) if (e.status === 'dismissed' && e.reason) seen.set(e.category, { category: e.category, reason: e.reason });
  return [...seen.values()];
};
