import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMeasure } from './hooks.js';
import { Hint } from './icons.js';
import { placeTip } from './settings.js';

// long enough for the pointer to cross the gap from the mark onto the tip it opened
const TIP_LINGER = 400;

// the panel says what each control is; what it is for waits behind the mark, hovered or focused
export function Info({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ above: false, maxHeight: 0 });
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), TIP_LINGER); };
  useEffect(() => () => clearTimeout(timer.current), []);

  // the row at the foot of the panel has no room under it, so the tip is placed against the panel it lives in, and
  // above the next group's heading, which it would read as one of; placed again whenever the panel scrolls or the window resizes
  useMeasure(open, () => {
    const el = tip.current;
    const row = el?.offsetParent as HTMLElement | null;
    if (!el || !row) return;
    const box = el.closest('.side-secs, .side')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const next = row.closest('.set-group')?.nextElementSibling?.getBoundingClientRect().top ?? Infinity;
    setPlace(placeTip(row.getBoundingClientRect(), el.scrollHeight, { top: box.top, bottom: Math.min(box.bottom, next) }));
  });

  return (
    <span className="set-info" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" className="ib xs" aria-label="What this does" aria-describedby={`set-tip-${id}`} data-testid={`set-info-${id}`}><Hint /></button>
      <span ref={tip} className="set-tip popover" role="tooltip" id={`set-tip-${id}`}
        data-open={open} data-place={place.above ? 'up' : 'down'}
        style={place.maxHeight ? { maxHeight: place.maxHeight } : undefined}>{children}</span>
    </span>
  );
}

/** A settings pane's group: its name, what it is for behind an Info, a button at its right, then its rows. `testid` names the heading. */
export function Group({ name, info, end, testid, children }: { name: ReactNode; info?: ReactNode; end?: ReactNode; testid?: string; children: ReactNode }) {
  return (
    <section className="set-group">
      <div className="kicker" data-testid={testid}>{name}{info}{end}</div>
      <div className="rows">{children}</div>
    </section>
  );
}
