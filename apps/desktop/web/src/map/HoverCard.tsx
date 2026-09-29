import type { Character } from '@svall/protocol';
import { contextPctOf, isUnread, statusOf } from '../selectors.js';
import { theme } from '../theme.js';
import { ago, linkText } from './tokenText.js';

// the accent for a status is the CSS token of the same name
const accent = (status: string): string => `var(--${status})`;

type Props = { c: Character; x: number; y: number; flip: boolean };

export function HoverCard({ c, x, y, flip }: Props) {
  const status = statusOf(c);
  const pct = contextPctOf(c);
  const at = c.agent?.lastActivityAt ?? c.shell.lastOutputAt;
  return (
    <div className="hover-card panel" data-testid="hover-card" data-status={status} data-flip={flip}
      style={{ left: x, top: y, width: theme.hoverCardWidth }}>
      <div className="top">
        <span className="hname">{c.name}</span>
        <span className="hst" style={{ color: accent(status) }}>{status}{isUnread(c) ? ' · unread' : ''}</span>
      </div>
      {c.note && <div className="task">{c.note}</div>}
      {pct !== undefined && (
        <div className="meter"><i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: accent(status) }} /></div>
      )}
      <div className="rows">
        <div className="row">context<b className="tnum">{pct === undefined ? '—' : `${Math.round(pct)}%`}</b></div>
        <div className="row">branch<b>{c.repo ? <><span className="mono">{c.repo.branch}</span>{c.repo.isWorktree && <span className="badge">wt</span>}</> : '—'}</b></div>
        <div className="row">last activity<b className="tnum">{ago(at)} ago</b></div>
      </div>
      {c.context.length > 0 && <div className="pills">{c.context.map((l, i) => <span key={`${l.ref}-${i}`} className="lp"><span className="clip-head">{linkText(l)}</span></span>)}</div>}
      <div className="hint">Double-click to open</div>
    </div>
  );
}
