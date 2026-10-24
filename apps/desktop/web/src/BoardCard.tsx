import type { Robot } from '@svall/protocol';
import { memoByValue } from './hooks.js';
import { EyeGlyph, HandGlyph, PrGlyph, reviewText } from './indicators.js';
import { figureOf, figureUrl } from './portraits.js';
import { contextPctOf, inReview, isMonitoring, isUnread, mainPr, statusOf } from './selectors.js';

// the context ring's circumference, at the radius its SVG draws
const RING = 2 * Math.PI * 5;

/** A robot on the board: every card one size, with two lines kept for the name and two for the note. */
export const BoardCard = memoByValue(function BoardCard({ c, selected, arrived, dragging, lifted, fileHover, on }: {
  c: Robot;
  selected: boolean;
  arrived: boolean;
  // the card's place in its column while it is dragged, and the copy that follows the pointer
  dragging?: boolean;
  lifted?: boolean;
  // a file from Finder over it
  fileHover?: boolean;
  on?: Pick<React.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onClick' | 'onDoubleClick' | 'onContextMenu' | 'onPointerEnter' | 'onPointerLeave'>;
}) {
  const status = statusOf(c);
  const pct = contextPctOf(c);
  const pr = inReview(c) ? mainPr(c) : undefined;
  const unread = isUnread(c);
  return (
    <article className="kc" aria-label={c.name} data-testid={lifted ? 'kc-lifted' : `kc-${c.id}`} data-status={status}
      data-selected={selected} data-need={status === 'blocked'} data-unread={unread} data-arrived={arrived}
      data-dragging={dragging} data-lifted={lifted} data-hand={c.columnSource === 'manual'}
      {...(!lifted && { 'data-drop': `robot:${c.id}`, 'data-drop-hover': fileHover })} {...on}>
      <span className="kc-av"><img src={figureUrl(figureOf(c))} alt="" draggable={false} /></span>
      <span className="kc-nm">{c.name}</span>
      <span className="kc-note">{c.note}</span>
      <span className="kc-ft">
        <span className="kc-st"><i />{status}</span>
        {unread && <span className="kc-un">unread</span>}
        <span className="kc-sp" />
        {pr && <span className="kc-mk" data-kind="review" title={reviewText(pr)} data-testid={`kc-review-${c.id}`}><PrGlyph /></span>}
        {isMonitoring(c) && <span className="kc-mk" data-kind="monitor" title="Monitoring" data-testid={`kc-monitor-${c.id}`}><EyeGlyph /></span>}
        {c.columnSource === 'manual' && <span className="kc-hand" title="Placed by hand" data-testid={`kc-hand-${c.id}`}><HandGlyph /></span>}
        {pct !== undefined && (
          <span className="kc-ring tnum">
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <circle className="kc-track" cx="7" cy="7" r="5" />
              <circle className="kc-fill" cx="7" cy="7" r="5" strokeDasharray={`${(RING * Math.min(100, Math.max(pct, 2))) / 100} ${RING}`} transform="rotate(-90 7 7)" />
            </svg>
            {Math.round(pct)}%
          </span>
        )}
      </span>
    </article>
  );
});
