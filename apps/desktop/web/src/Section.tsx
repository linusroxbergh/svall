import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { app } from './boot.js';
import { commitFocused } from './Field.js';
import { useApp, useMore } from './hooks.js';
import { Caret } from './icons.js';
import type { Section as Fold } from './store/index.js';
import { useWidthGrip } from './widthGrip.js';

const OPEN: Fold = {};
const SHUT: Fold = { shut: true };
// how short a section can be squeezed; an empty one is only its title
const floor = (sec: HTMLElement) => { const m = getComputedStyle(sec).minHeight; return m === 'auto' ? (sec.firstElementChild as HTMLElement).offsetHeight : parseFloat(m) || 0; };

// the most a section can grow to at the press: the free room and what the fitted sections can give up; a pinned one keeps its height
function room(sec: HTMLElement): number {
  const secs = sec.parentElement!;
  const kids = [...secs.children] as HTMLElement[];
  const used = kids.reduce((n, k) => n + k.offsetHeight, 0) + parseFloat(getComputedStyle(secs).rowGap) * (kids.length - 1);
  const give = kids.filter((k) => k !== sec && k.dataset.fit === 'true').reduce((n, k) => n + k.offsetHeight - floor(k), 0);
  return sec.offsetHeight + Math.max(0, secs.clientHeight - used) + give;
}

// a section's rows: its children, or a list's rows inside it
const rowsOf = (el: HTMLElement): Element[] => [...el.children].flatMap((c) => (c.classList.contains('rows') ? [...c.children] : [c]));

// how far a squeezed section's rows show whole: to the top of the first row whose words its edge cuts, when a whole one stands
// above it, or all when the edge cuts no words
function wholeTo(el: HTMLElement): number | 'all' | undefined {
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return undefined;
  const box = el.getBoundingClientRect();
  const rows = rowsOf(el);
  const cut = rows.find((r) => r.getBoundingClientRect().bottom - parseFloat(getComputedStyle(r).paddingBottom || '0') > box.bottom + 0.5);
  if (!cut) return 'all';
  const at = cut.getBoundingClientRect().top - box.top;
  return at > 0 ? at : undefined;
}

/** A section's contents, which scroll inside it while more of them lie below, the row its edge cuts fading out under the whole ones. */
function Body({ opened, children }: { opened?: true; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, read] = useMore(ref, 'y');
  const [whole, setWhole] = useState<number | 'all'>();
  const measure = () => { if (ref.current) setWhole(wholeTo(ref.current)); };
  // the body and each of its rows, as a row that grows, its details opened, moves where the edge cuts
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    for (const e of [el, ...rowsOf(el)]) ro.observe(e);
    return () => ro.disconnect();
  });
  return (
    <div ref={ref} className="sec-body" data-opened={opened} data-more={more} data-whole={whole === undefined ? undefined : whole === 'all' ? 'all' : 'cut'}
      style={typeof whole === 'number' ? { '--whole': `${whole}px` } as CSSProperties : undefined} onScroll={() => { read(); measure(); }}>{children}</div>
  );
}

/**
 * A part of a side card: the title folds it, and the edge under it pins its height, which a double-click there lets go of.
 * `shut`, folded until first opened.
 */
export function Section({ name, title, head, testid, shut, children }: { name: string; title: string; head?: ReactNode; testid?: string; shut?: boolean; children: ReactNode }) {
  const fold = useApp((s) => s.sections[name]) ?? (shut ? SHUT : OPEN);
  const range = useRef({ min: 0, max: 0 });
  const set = (f: Fold, persist?: boolean) => app.store.getState().setSection(name, f, persist);
  const now = () => app.store.getState().sections[name] ?? (shut ? SHUT : OPEN);
  const grip = useWidthGrip((g) => {
    const sec = g.parentElement!;
    range.current = { min: floor(sec), max: room(sec) };
    return sec.offsetHeight;
  }, (from, dy) => {
    // a press that hardly moves leaves a fitted section fitted
    if (now().height === undefined && Math.abs(dy) < 3) return;
    const { min, max } = range.current;
    set({ ...now(), height: Math.round(Math.max(min, Math.min(max, from + dy))) }, false);
  }, () => set(now()), 'y');
  const open = !fold.shut;
  // shut at some point while mounted, so an opening drops the body in where a card appearing on it does not
  const wasShut = useRef(!open);
  if (!open) wasShut.current = true;
  return (
    <section className="sec" data-testid={testid} data-section={name} data-open={open} data-fit={open && fold.height === undefined}
      style={open && fold.height !== undefined ? { flexBasis: fold.height } : undefined}>
      <div className="kicker">
        <button type="button" className="sec-fold" data-testid={`sec-fold-${name}`} aria-expanded={open}
          onClick={() => { commitFocused(); set({ ...fold, shut: open }); }}><Caret dir={open ? 'down' : 'right'} />{title}</button>
        {head}
      </div>
      {open && <Body opened={wasShut.current || undefined}>{children}</Body>}
      {open && (
        <i className="sec-grip" data-testid={`sec-grip-${name}`} role="separator" aria-orientation="horizontal" aria-label={`Resize ${title}`}
          data-tip="Drag to resize, double-click to fit" {...grip} onDoubleClick={() => set({ ...fold, height: undefined })} />
      )}
    </section>
  );
}
