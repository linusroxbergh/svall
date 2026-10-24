import type { HandoverEvent, HandoverPhase, Names, TransferManifestV1 } from '@svall/protocol';
import { destinationView } from '@svall/svalld/handover/relocate';
import type { EntryProgress } from './progress.js';

/** What a blocker or a row points at, for a person, as `Names` says. */
export function namesOf(m: TransferManifestV1): Names {
  const robots: Record<string, string> = Object.fromEntries(Object.values(m.snapshot.robots).map((c) => [c.id, c.name]));
  const landing = destinationView(m).roots.filter((r, i) => r.path !== m.roots[i].path);
  return {
    robots,
    roots: Object.fromEntries(m.roots.map((r) => [r.id, r.path])),
    ...(landing.length && { landing: Object.fromEntries(landing.map((r) => [r.id, r.path])) }),
    sessions: Object.fromEntries(m.sessions.map((s, i) => [`s${i}`, robots[s.robotId] ?? s.robotId])),
  };
}

// the most kept files a row names: every event of the row repeats it, and a watcher takes no line over 1 MiB
const NAMED = 20;

/** What a root's copy moved aside after its first pass, for its row. */
function overwrittenNotice({ keptAt, paths }: NonNullable<EntryProgress['overwritten']>): string {
  const one = paths.length === 1;
  const named = `${paths.slice(0, NAMED).join(', ')}${paths.length > NAMED ? `, and ${paths.length - NAMED} more` : ''}`;
  return `${paths.length} ${one ? 'file' : 'files'} the copy replaced or deleted after its first pass ${one ? 'is' : 'are'} kept at ${keptAt}: ${named}`;
}

/**
 * A transfer entry's progress as an entity row: a root, where its claim archived what it held and what its copy kept
 * aside, or a session by its place `s<i>` in the manifest.
 */
export function entryEvent(transactionId: string, p: EntryProgress, archivedTo?: string): HandoverEvent {
  const phase: HandoverPhase = p.state === 'verifying' || p.state === 'verified' ? 'verify' : 'transfer';
  return {
    event: 'handover.entity',
    data: {
      transactionId, kind: p.kind === 'root' ? 'root' : 'session', id: p.id, phase,
      done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes, ...(p.error && { error: p.error }), ...(archivedTo && { archivedTo }),
      ...(p.overwritten && { notice: overwrittenNotice(p.overwritten) }),
      ...(p.state === 'verified' && { verified: true }),
    },
  };
}

/** Hands every event to the record; one that throws is skipped. */
export class Observer {
  constructor(private record?: (e: HandoverEvent) => void) {}

  send(e: HandoverEvent): void {
    try { this.record?.(e); } catch { /* a record that fails never stops a move */ }
  }
}
