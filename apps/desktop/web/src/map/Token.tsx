import type { Cell, Character, ContextItem } from '@svall/protocol';
import { memoByValue } from '../hooks.js';
import { BotGlyph, EyeGlyph, PrGlyph, reviewText, subagentsText } from '../indicators.js';
import { contextPctOf, inReview, isMonitoring, isUnread, mainPr, subagentCount, type DisplayStatus } from '../selectors.js';
import { LinkIcon } from './LinkIcon.js';
import { Robot } from './Robot.js';
import { robotOf } from '../portraits.js';
import { theme, tokenPx } from '../theme.js';
import { seedNum } from './coast.js';
import { hintLabel, hintText, statusWord } from './tokenText.js';
import type { PointerHandlers } from './types.js';

const RAIL_MAX = 3;

function footInner(c: Character, status: DisplayStatus, word: string | undefined, failed: string | undefined) {
  return (
    <>
      {word && <span className="sw" data-status={status} style={{ backgroundColor: `var(--${status})`, color: `var(--ink-on-${status})` }}>{word}</span>}
      {failed && <span className="sw" data-testid={`token-resume-error-${c.id}`} title={failed} style={{ background: 'var(--blocked)', color: 'var(--ink-on-blocked)' }}>resume failed</span>}
      {c.hint && <span className="sw" data-testid={`token-hint-${c.id}`} title={hintText(c)} style={{ background: 'var(--blocked)', color: 'var(--ink-on-blocked)' }}>{hintLabel(c)}</span>}
    </>
  );
}

export const Token = memoByValue(function Token({
  c, status, world, links, selected, dragging, settling, hover, offset, failed, pointer, onHoverStart, onHoverEnd, onOpen, onLink, onMenu,
}: {
  c: Character;
  status: DisplayStatus;
  // the link chips on the card's right edge
  links?: boolean;
  world: Cell;
  selected: boolean;
  dragging: boolean;
  settling?: boolean;
  hover: boolean;
  offset?: { x: number; y: number };
  // why a handover could not resume this character, from the app's store; the landing page has none
  failed?: string;
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
  const cls = ['tok', 'bot', `s-${status}`, selected ? 'sel' : '', dragging ? 'drag' : ''].filter(Boolean).join(' ');
  const review = inReview(c) ? mainPr(c) : undefined;
  const monitor = isMonitoring(c);
  const subs = subagentCount(c);
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
        <div className="edge">{pct !== undefined && <i style={{ width: `${pct}%` }} />}</div>
        <div className="nm"><span>{c.name}</span></div>
        <Robot n={robotOf(c)} />
        <button
          type="button"
          className="foot"
          data-testid={`token-term-${c.id}`}
          title="Open terminal"
          aria-label={`Open ${c.name}'s terminal`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
        >
          {footInner(c, status, word, failed)}
          <svg className="tg" viewBox="0 0 10 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.4 1.6 4 4.4 1.4 7.2" />
            <path d="M5.8 7.2h2.8" />
          </svg>
        </button>
      </div>
      {(review || monitor || subs > 0) && (
        <span className="corner">
          <span className="marks">
            {review && (
              <button
                type="button"
                className="mark review"
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
            {monitor && <span className="mark monitor" title="Monitoring" data-testid={`token-monitor-${c.id}`}><EyeGlyph /></span>}
          </span>
          {subs > 0 && (
            <span className="marks left">
              <span className="mark subs" role="img" title={subagentsText(subs)} aria-label={subagentsText(subs)} data-testid={`token-subs-${c.id}`}>
                <BotGlyph /><b>{subs}</b>
              </span>
            </span>
          )}
        </span>
      )}
      {links && c.context.length > 0 && (
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
});
