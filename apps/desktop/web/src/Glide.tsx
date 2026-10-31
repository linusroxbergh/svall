import { useEffect, useLayoutEffect, useRef } from 'react';

const PRESSED = ':scope > :is([aria-pressed="true"], [data-active="true"])';

function move(el: HTMLElement, to: Element | null, ease: boolean) {
  if (!(to instanceof HTMLElement)) return;
  el.dataset.still = String(!ease);
  el.style.translate = `${to.offsetLeft}px 0`;
  el.style.width = `${to.offsetWidth}px`;
}

/** The pill behind a segmented control's pressed button, easing to the next one pressed. `at` names the pressed button;
 * `from` selects the button it starts behind when the control mounts in the middle of a switch. */
export function Glide({ at, from }: { at: string; from?: string | undefined }) {
  const ref = useRef<HTMLElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current!, seg = el.parentElement!;
    if (!placed.current) {
      placed.current = true;
      move(el, (from && seg.querySelector(from)) || seg.querySelector(PRESSED), false);
      void el.offsetWidth;
    }
    move(el, seg.querySelector(PRESSED), true);
  }, [at]);
  // a label changing or a font landing resizes the buttons; easing, so the first report leaves a glide under way alone
  useEffect(() => {
    const el = ref.current!, seg = el.parentElement!;
    const ro = new ResizeObserver(() => move(el, seg.querySelector(PRESSED), true));
    for (const b of seg.children) if (b !== el) ro.observe(b);
    return () => ro.disconnect();
  }, []);
  return <i ref={ref} className="glide" aria-hidden="true" />;
}
