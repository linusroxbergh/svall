import type { Character, ContextItem } from '@svall/protocol';
import type { DisplayStatus } from '../selectors.js';

export const GAUGE_R = 32.5;
export const GAUGE_C = 2 * Math.PI * GAUGE_R;

// the gauge arc: a 3% minimum sliver so a fresh session still reads as a ring
export function gaugeDash(pct: number | undefined): string {
  const len = pct == null ? '0' : ((GAUGE_C * Math.max(pct, 3)) / 100).toFixed(2);
  return `${len} ${GAUGE_C.toFixed(2)}`;
}

// a github PR or issue reads as `repo #number`, so the pill says which repository it belongs to
const GH_ITEM = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/i;
const ghItemText = (ref: string): string | undefined => {
  const m = GH_ITEM.exec(ref.trim());
  return m ? `${m[1]} #${m[2]}` : undefined;
};

// the ref without its protocol, trimmed to host and last segment once it stops fitting a pill
export function linkText(l: ContextItem): string {
  if (l.kind === 'file' || l.kind === 'folder') return l.ref.replace(/\/+$/, '').split('/').pop() || l.ref;
  // a bare number is the label an auto lookup or the scribe writes; it is the one worth spelling out
  if (l.kind === 'pr' || l.kind === 'issue') {
    const named = !l.label || l.label === l.ref || /^#?\d+$/.test(l.label) ? ghItemText(l.ref) : undefined;
    if (named) return named;
  }
  if (l.label && l.label !== l.ref) return l.label;
  const bare = l.ref.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  if (bare.length <= 34) return bare;
  const [host, ...rest] = bare.split('/');
  return rest.length ? `${host}/…/${rest[rest.length - 1]}` : host;
}

// Silence can mean an untrusted hook, a missing receiver, or another delivery failure.
export const hintText = (c: Character): string | undefined =>
  c.hint === 'codex-silent' ? 'No updates from Codex. Run svall doctor and check /hooks in Codex.' : undefined;

// only blocked and done spell the status out; working and idle read from the ring
export function statusWord(status: DisplayStatus): string | undefined {
  return status === 'blocked' || status === 'done' ? status : undefined;
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
