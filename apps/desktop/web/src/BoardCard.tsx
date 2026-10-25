import { useEffect, useRef } from 'react';
import type { Robot } from '@svall/protocol';
import { memoByValue, stop } from './hooks.js';
import { EyeGlyph, HandGlyph, PrGlyph, reviewText } from './indicators.js';
import { figureOf, figureUrl } from './portraits.js';
import { contextPctOf, inReview, isMonitoring, isUnread, mainPr, statusOf } from './selectors.js';

// the context ring's circumference, at the radius its SVG draws
const RING = 2 * Math.PI * 5;

// Return or a click away saves a changed name, Escape keeps the old one
export function NameInput({ name, className, testid, onSave, onDone }: { name: string; className: string; testid: string; onSave(name: string): void; onDone(): void }) {
  return (
    <input className={className} autoFocus defaultValue={name} aria-label={`Rename ${name}`} data-testid={testid}
      onFocus={(e) => e.currentTarget.select()} onClick={stop} onDoubleClick={stop} onPointerDown={stop}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next && next !== name) onSave(next);
        onDone();
      }} />
  );
}

/** A robot on the board: every card one size, with two lines kept for the name and two for the note. */
export const BoardCard = memoByValue(function BoardCard({ c, selected, arrived, dragging, lifted, fileHover, renaming, onRename, onRenamed, on }: {
  c: Robot;
  selected: boolean;
  arrived: boolean;
  // the card's place in its column while it is dragged, and the copy that follows the pointer
  dragging?: boolean;
  lifted?: boolean;
  // a file from Finder over it
  fileHover?: boolean;
  // the name is a field while the menu's Rename edits it
  renaming?: boolean;
  onRename?(name: string): void;
  onRenamed?(): void;
  on?: Pick<React.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onClick' | 'onDoubleClick' | 'onContextMenu' | 'onPointerEnter' | 'onPointerLeave'>;
}) {
  const status = statusOf(c);
  const pct = contextPctOf(c);
  const pr = inReview(c) ? mainPr(c) : undefined;
  const unread = isUnread(c);
  const ref = useRef<HTMLElement>(null);
  // a card the keys or the sidebar select comes into its column's view; one under the pointer stays put, so a double click lands twice
  useEffect(() => { if (selected && !ref.current?.matches(':hover')) ref.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  return (
    <article ref={ref} className="kc" aria-label={c.name} data-testid={lifted ? 'kc-lifted' : `kc-${c.id}`} data-status={status}
      data-selected={selected} data-need={status === 'blocked'} data-unread={unread} data-arrived={arrived}
      data-dragging={dragging} data-lifted={lifted}
      {...(!lifted && { 'data-drop': `robot:${c.id}`, 'data-drop-hover': fileHover })} {...on}>
      <span className="kc-av"><img src={figureUrl(figureOf(c))} alt="" draggable={false} /></span>
      {renaming
        ? <NameInput name={c.name} className="kb-ren kc-ren" testid={`kc-name-input-${c.id}`} onSave={(name) => onRename?.(name)} onDone={() => onRenamed?.()} />
        : <span className="kc-nm">{c.name}</span>}
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
