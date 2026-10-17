import type { HandoverEvent, HandoverPhase, Names, TransferManifestV1 } from '@svall/protocol';
import type { EntryProgress } from './progress.js';

/** What a blocker or a row points at, for a person: each character's name, where each root lands, and whose each session row `s<i>` is. */
export function namesOf(m: TransferManifestV1): Names {
  const characters: Record<string, string> = Object.fromEntries(Object.values(m.snapshot.characters).map((c) => [c.id, c.name]));
  return {
    characters,
    roots: Object.fromEntries(m.roots.map((r) => [r.id, r.path])),
    sessions: Object.fromEntries(m.sessions.map((s, i) => [`s${i}`, characters[s.characterId] ?? s.characterId])),
  };
}

/** A transfer entry's progress as an entity row: a root, and where its claim archived what it held, or a session by its place `s<i>` in the manifest. */
export function entryEvent(transactionId: string, p: EntryProgress, archivedTo?: string): HandoverEvent {
  const phase: HandoverPhase = p.state === 'verifying' || p.state === 'verified' ? 'verify' : 'transfer';
  return {
    event: 'handover.entity',
    data: {
      transactionId, kind: p.kind === 'root' ? 'root' : 'session', id: p.id, phase,
      done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes, ...(p.error && { error: p.error }), ...(archivedTo && { archivedTo }),
    },
  };
}

/**
 * Hands events to whoever watches until they let go; after that the transaction goes on without an audience.
 * A watcher that throws is let go too, so a closed pipe never stops a move. The record gets every event, and
 * one that throws is skipped.
 */
export class Observer {
  private detached = false;

  constructor(private emit?: (e: HandoverEvent) => void, private record?: (e: HandoverEvent) => void) {}

  send(e: HandoverEvent): void {
    try { this.record?.(e); } catch { /* a record that fails never stops a move */ }
    if (this.detached || !this.emit) return;
    try { this.emit(e); } catch { this.detached = true; }
  }

  detach(): void {
    this.detached = true;
  }
}
