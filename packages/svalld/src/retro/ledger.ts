import fs from 'node:fs';
import { z } from 'zod';
import { LedgerEntry, type DismissReason, type Finding, type Focus, type LedgerStatus, type Measure, type Rate } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { sha256Hex } from '../hash.js';
import { inSpan, type Outline, type Span } from './outline.js';

export type Ledger = Record<string, LedgerEntry>;

/** The id a finding keeps in every run: the same focus, category, file and skill or rule are the same issue. */
export const findingId = (focus: Focus, category: string, realPath: string, subject: string): string =>
  sha256Hex([focus, category, realPath, subject].join('\n')).slice(0, 10);

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
      : { id: f.id, focus: f.focus, category: f.category, title: f.title, status: 'open', firstSeen: now, lastSeen: now, measure: f.measure };
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

/** The kinds of finding the user turned down, which the next judge is told this user rejects. */
export const dismissedCategories = (ledger: Ledger): { focus: Focus; category: string; reason: DismissReason }[] => {
  const seen = new Map<string, { focus: Focus; category: string; reason: DismissReason }>();
  for (const e of Object.values(ledger)) if (e.status === 'dismissed' && e.reason) seen.set(`${e.focus}\n${e.category}`, { focus: e.focus, category: e.category, reason: e.reason });
  return [...seen.values()];
};

/** What code counts for a measure over the sessions in `span`, as a rate; none when the kind has no count or nothing it could occur in. */
export function measure(
  m: Pick<Measure, 'kind' | 'subject'>,
  o: { outlines: Outline[]; span: Span; prOf?: Map<string, string>; comments?: Map<string, { at: number }[]> },
): Rate | null {
  if (m.kind === 'none' || !m.subject) return null;
  const runs = o.outlines.flatMap((s) => s.skills.filter((r) => r.name === m.subject && inSpan(r.at, o.span)).map((r) => ({ s, r })));
  let rate: Rate;
  if (m.kind === 'followups-after-skill') rate = { count: runs.filter(({ r }) => r.next).length, of: runs.length };
  else if (m.kind === 'runs-of-skill') {
    const sessions = o.outlines.filter((s) => s.end && s.start <= o.span.to && s.end >= o.span.from);
    rate = { count: new Set(runs.map(({ s }) => s.session)).size, of: sessions.length };
  } else {
    // a review run counts once it has a PR, and again when that PR took a comment after the run
    const reviewed = runs.flatMap(({ s, r }) => {
      const pr = o.prOf?.get(s.session);
      return pr ? [{ r, pr }] : [];
    });
    rate = { count: reviewed.filter(({ r, pr }) => (o.comments?.get(pr) ?? []).some((c) => c.at > r.end)).length, of: reviewed.length };
  }
  return rate.of ? rate : null;
}
