import type { Robot, ContextItem, FleetState } from '@svall/protocol';
import type { DisplayStatus } from '../selectors.js';

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
export const hintText = (c: Robot): string | undefined =>
  c.hint && c.codexDaemon ? "This codex runs on Codex's shared background server, whose hooks can't tell terminals apart. Quit it and run codex --no-daemon."
  : c.hint === 'codex-silent' ? 'No updates from Codex. Run svall doctor and check /hooks in Codex.' : undefined;

export const hintLabel = (c: Robot): string => (c.codexDaemon ? '--no-daemon' : '/hooks');

export function retroText(retro: FleetState['retro'], id: string): string | undefined {
  if (retro?.robot !== id) return undefined;
  return retro.stage === 'reading' ? `retro reading ${retro.done}/${retro.total}` : `retro ${retro.stage}`;
}

// idle and a bare shell read from the ring; every other status is spelled out
export function statusWord(status: DisplayStatus): string | undefined {
  return status === 'idle' || status === 'shell' ? undefined : status;
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
