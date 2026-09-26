import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

  // the row at the foot of the panel has no room under it, so the tip is placed against the panel it lives in,
  // and placed again whenever the panel scrolls or the window resizes under an open tip
  useLayoutEffect(() => {
    const el = tip.current;
    const row = el?.offsetParent as HTMLElement | null;
    if (!open || !el || !row) return;
    const measure = () => {
      const panel = el.closest('.side')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      setPlace(placeTip(row.getBoundingClientRect(), el.scrollHeight, panel));
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [open]);

  return (
    <span className="set-info" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" aria-label="What this does" aria-describedby={`set-tip-${id}`} data-testid={`set-info-${id}`}>ⓘ</button>
      <span ref={tip} className="set-tip" role="tooltip" id={`set-tip-${id}`}
        data-open={open} data-place={place.above ? 'up' : 'down'}
        style={place.maxHeight ? { maxHeight: place.maxHeight } : undefined}>{children}</span>
    </span>
  );
}
