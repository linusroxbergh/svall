import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { holdCutout } from './cutout.js';

// a tip opens after this pause, and at once while another is open or has just closed
const DELAY = 300;
const WARM = 500;
const GAP = 6;
const EDGE = 8;
const TIPPED = '[data-tip]:not([data-tip=""])';

// one tip for the window, said by whatever the pointer rests on with a data-tip; a line starting `• ` is a bullet
export function Tips() {
  const [tip, setTip] = useState<{ el: Element; text: string; cold: boolean }>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let under: Element | undefined, open = false, closed = -Infinity;
    const show = (el: Element, cold: boolean) => { open = true; setTip({ el, text: el.getAttribute('data-tip')!, cold }); };
    const hide = () => {
      clearTimeout(timer);
      if (open) closed = performance.now();
      open = false;
      setTip(undefined);
    };
    const over = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target.closest(TIPPED) ?? undefined : undefined;
      if (el === under) return;
      under = el;
      const warm = open || performance.now() - closed < WARM;
      hide();
      if (el) { if (warm) show(el, false); else timer = setTimeout(() => show(el, true), DELAY); }
    };
    const out = (e: PointerEvent) => { if (!e.relatedTarget) { under = undefined; hide(); } };
    // a press, a key or a scroll puts it away, and it waits for the pointer to come onto something else
    const events = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const;
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    for (const t of events) document.addEventListener(t, hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      for (const t of events) document.removeEventListener(t, hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // under its element, or over it when the window's floor is too near, and never past a side
  useLayoutEffect(() => {
    const box = ref.current;
    if (!tip || !box) return;
    const a = tip.el.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
    const below = a.bottom + GAP + h <= window.innerHeight - EDGE;
    box.style.top = `${below ? a.bottom + GAP : Math.max(EDGE, a.top - GAP - h)}px`;
    box.style.left = `${Math.max(EDGE, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - EDGE - w))}px`;
  }, [tip]);
  // a tip over a terminal or a browser tab is seen only through a hole in them; the presses there stay theirs
  useEffect(() => (tip && ref.current ? holdCutout(app.bridge, ref.current, false) : undefined), [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className="tip popover" role="tooltip" data-testid="tip" data-cold={tip.cold || undefined}>
      {tip.text.split('\n').map((line, i) => (line.startsWith('• ')
        ? <div key={i} className="tip-li"><span>•</span><span>{line.slice(2)}</span></div>
        : <div key={i}>{line}</div>))}
    </div>
  );
}
