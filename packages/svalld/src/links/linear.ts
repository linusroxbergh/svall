import type { ContextItem } from '@svall/protocol';
import type { Config } from '../config.js';

export function linearLink(branch: string, cfg: Config['linear']): ContextItem | undefined {
  if (!cfg || cfg.teamKeys.length === 0) return undefined;
  const keys = cfg.teamKeys.map((k) => k.replace(/[^A-Za-z0-9]/g, '')).join('|');
  const m = branch.match(new RegExp(`(?:^|[^a-z0-9])(${keys})-(\\d+)(?![0-9])`, 'i'));
  if (!m) return undefined;
  const id = `${m[1].toUpperCase()}-${m[2]}`;
  return { kind: 'linear', ref: `https://linear.app/${cfg.workspace}/issue/${id}`, label: id, source: 'auto' };
}
