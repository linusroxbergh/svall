import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMeasure } from './hooks.js';
import { Hint } from './icons.js';
import { placeTip, TIP_GAP } from './settings.js';

// long enough for the pointer to cross the gap from the mark onto the tip it opened
const TIP_LINGER = 400;

type Room = { top: number; bottom: number };
// where a tip's far edge lands: on an edge of a row it would cut, covering that row whole, or short of it where the room ends first
function snap(far: number, up: boolean, room: Room, rows: Element[]): number {
  for (const r of rows) {
    const b = r.getBoundingClientRect();
    if (b.top >= far || b.bottom <= far) continue;
    const whole = up ? b.top : b.bottom;
    return (up ? whole >= room.top : whole <= room.bottom) ? whole : up ? b.bottom : b.top;
  }
  return far;
}

// the panel says what each control is; what it is for waits behind the mark, hovered or focused
export function Info({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ above: false, maxHeight: 0, height: 0 });
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
    const pane = el.closest('.side-secs, .side');
    const box = pane?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const next = row.closest('.set-group')?.nextElementSibling?.getBoundingClientRect().top ?? Infinity;
    const room = { top: box.top, bottom: Math.min(box.bottom, next) };
    const at = row.getBoundingClientRect();
    const { above, maxHeight } = placeTip(at, el.scrollHeight, room);
    const tall = Math.min(el.scrollHeight, maxHeight || Infinity);
    const rows = [...pane?.querySelectorAll('.row, .kicker') ?? []].filter((r) => r !== row);
    const far = snap(above ? at.top - TIP_GAP - tall : at.bottom + TIP_GAP + tall, above, room, rows);
    setPlace({ above, maxHeight, height: Math.max(above ? at.top - TIP_GAP - far : far - at.bottom - TIP_GAP, 0) });
  });

  return (
    <span className="set-info" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" className="ib xs" aria-label="What this does" aria-describedby={`set-tip-${id}`} data-testid={`set-info-${id}`}><Hint /></button>
      <span ref={tip} className="set-tip popover" role="tooltip" id={`set-tip-${id}`}
        data-open={open} data-place={place.above ? 'up' : 'down'}
        style={place.maxHeight || place.height ? { ...(place.maxHeight && { maxHeight: place.maxHeight }), ...(place.height && { height: place.height }) } : undefined}>{children}</span>
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
