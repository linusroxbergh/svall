import type { Cell, Character, ContextItem } from '@svall/protocol';
import { EyeGlyph, PrGlyph, reviewText } from '../indicators.js';
import { contextPctOf, inReview, isMonitoring, isUnread, mainPr, slotStatus, type DisplayStatus } from '../selectors.js';
import { LinkIcon } from './LinkIcon.js';
import { Robot } from './Robot.js';
import { portraitTint, portraitUrl, robotOf } from '../portraits.js';
import { theme, tokenPx } from '../theme.js';
import { seedNum } from './coast.js';
import { GAUGE_R, gaugeDash, hintText, statusWord } from './tokenText.js';
import type { PointerHandlers } from './types.js';

const RAIL_MAX = 3;

function footInner(c: Character, status: DisplayStatus, word: string | undefined) {
  return (
    <>
      {c.second && (
        <span className="pips" data-testid={`token-pips-${c.id}`}>
          <i className="pip" data-status={slotStatus(c, 1)} /><i className="pip" data-status={slotStatus(c, 2)} />
        </span>
      )}
      {status === 'working' && <span className="dots" aria-hidden="true"><i /><i /><i /></span>}
      {word &&<span className="sw" style={{ background: `var(--${status})`, color: `var(--ink-on-${status})` }}>{word}</span>}
      {c.hint && <span className="sw" data-testid={`token-hint-${c.id}`} title={hintText(c)} style={{ background: 'var(--blocked)', color: 'var(--ink-on-blocked)' }}>/hooks</span>}
    </>
  );
}

function gem(status: DisplayStatus, unread: boolean) {
  if (status === 'blocked') return <span className="gem blocked">!</span>;
  if (status === 'done' && unread) return <span className="gem done">✓</span>;
  if (status === 'working') return <span className="gem working" />;
  return null;
}

export function Token({
  c, status, world, robots, selected, dragging, settling, hover, offset, pointer, onHoverStart, onHoverEnd, onOpen, onLink, onMenu,
}: {
  c: Character;
  status: DisplayStatus;
  // the robot stands under the name, the top edge fills with the context used and the gem moves to the card's corner
  robots?: boolean;
  world: Cell;
  selected: boolean;
  dragging: boolean;
  settling?: boolean;
  hover: boolean;
  offset?: { x: number; y: number };
  pointer: PointerHandlers;
  onHoverStart(): void;
  onHoverEnd(): void;
  onOpen(): void;
  onLink(item: ContextItem, charId: string, at: { x: number; y: number }): void;
  onMenu(e: React.MouseEvent): void;
}) {
  const word = statusWord(status);
  // the rail holds RAIL_MAX chips; past that the last one counts the rest
  const shown = c.context.length > RAIL_MAX ? c.context.slice(0, RAIL_MAX - 1) : c.context;
  const hidden = c.context.slice(shown.length);
  const cls = ['tok', `s-${status}`, robots ? 'bot' : '', selected ? 'sel' : '', dragging ? 'drag' : ''].filter(Boolean).join(' ');
  const review = inReview(c) ? mainPr(c) : undefined;
  const monitor = isMonitoring(c);
  const pct = contextPctOf(c);
  return (
    <div
      className={cls}
      data-testid={`token-${c.id}`}
      data-status={status}
      data-selected={selected}
      data-unread={isUnread(c)}
      data-drop={`char:${c.id}`}
      data-drop-hover={hover}
      data-settling={settling}
      style={{
        left: `calc(${(world.x + 0.5) * theme.cell}px * var(--ms))`,
        top: `calc(${(world.y + 0.5) * theme.cell}px * var(--ms))`,
        ['--ox' as string]: offset && `${offset.x}px`,
        ['--oy' as string]: offset && `${offset.y}px`,
        ['--tok' as string]: `${theme.token.unit}px`,
        ['--card-w' as string]: `${tokenPx.w}px`,
        ['--card-h' as string]: `${tokenPx.h}px`,
        ['--grain' as string]: `${Math.round(seedNum(c.id) * 96)}px ${Math.round(seedNum(c.id + '~') * 96)}px`,
      }}
      {...pointer}
      onPointerEnter={onHoverStart}
      onPointerLeave={onHoverEnd}
      onContextMenu={onMenu}
    >
      <div className="card">
        <div className="edge">{robots && pct !== undefined && <i style={{ width: `${pct}%` }} />}</div>
        {robots ? (
          <>
            <div className="nm"><span>{c.name}</span></div>
            <Robot n={robotOf(c)} />
          </>
        ) : (
          <>
            <div className="pf">
              <div className="disc-wrap">
                <svg className="gauge" viewBox="0 0 72 72" aria-hidden="true">
                  <circle className="track" cx="36" cy="36" r={GAUGE_R} />
                  <circle className="arc" cx="36" cy="36" r={GAUGE_R} strokeDasharray={gaugeDash(pct)} />
                </svg>
                <div className="disc" data-tint={portraitTint(c.portrait)}>
                  <img className="portrait portrait-img" src={portraitUrl(c.portrait)} alt="" draggable={false} />
                </div>
                {gem(status, isUnread(c))}
              </div>
            </div>
            <div className="nm"><span>{c.name}</span></div>
          </>
        )}
        <button
          type="button"
          className="foot"
          data-testid={`token-term-${c.id}`}
          title="Open terminal"
          aria-label={`Open ${c.name}'s terminal`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
        >
          {footInner(c, status, word)}
          <svg className="tg" viewBox="0 0 10 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.4 1.6 4 4.4 1.4 7.2" />
            <path d="M5.8 7.2h2.8" />
          </svg>
        </button>
      </div>
      {robots && <span className="corner">{gem(status, isUnread(c))}</span>}
      {(review || monitor) && (
        <div className="rail left">
          {review && (
            <button
              type="button"
              className="chip review"
              data-testid={`token-review-${c.id}`}
              title={reviewText(review)}
              aria-label={reviewText(review)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onLink(review, c.id, { x: e.clientX, y: e.clientY });
              }}
            >
              <PrGlyph />
            </button>
          )}
          {monitor && <span className="chip monitor" title="Monitoring" data-testid={`token-monitor-${c.id}`}><EyeGlyph /></span>}
        </div>
      )}
      {c.context.length > 0 && (
        <div className="rail">
          {shown.map((l, i) => (
            <button
              key={`${l.ref}-${i}`}
              type="button"
              className="chip lk"
              title={l.ref}
              aria-label={l.label || l.ref}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onLink(l, c.id, { x: e.clientX, y: e.clientY });
              }}
            >
              <LinkIcon item={l} />
            </button>
          ))}
          {hidden.length > 0 && (
            <span className="chip more" title={hidden.map((l) => l.label || l.ref).join('\n')} data-testid={`token-more-${c.id}`}>
              +{hidden.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
