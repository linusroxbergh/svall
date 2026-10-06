import { useRef, type ReactNode } from 'react';
import { app } from './boot.js';
import { commitFocused } from './Field.js';
import { useApp } from './hooks.js';
import { Caret } from './Sidebar.js';
import type { Section as Fold } from './store/index.js';
import { useWidthGrip } from './widthGrip.js';

const OPEN: Fold = {};
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

/** A part of a side card: the title folds it, and the edge under it pins its height, which a double-click there lets go of. */
export function Section({ name, title, head, testid, children }: { name: string; title: string; head?: ReactNode; testid?: string; children: ReactNode }) {
  const fold = useApp((s) => s.sections[name]) ?? OPEN;
  const range = useRef({ min: 0, max: 0 });
  const set = (f: Fold, persist?: boolean) => app.store.getState().setSection(name, f, persist);
  const now = () => app.store.getState().sections[name] ?? OPEN;
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
  return (
    <section className="sec" data-testid={testid} data-open={open} data-fit={open && fold.height === undefined}
      style={open && fold.height !== undefined ? { flexBasis: fold.height } : undefined}>
      <div className="kicker">
        <button type="button" className="sec-fold" data-testid={`sec-fold-${name}`} aria-expanded={open}
          onClick={() => { commitFocused(); set({ ...fold, shut: open }); }}><Caret open={open} />{title}</button>
        {head}
      </div>
      {open && <div className="sec-body">{children}</div>}
      {open && (
        <i className="sec-grip" data-testid={`sec-grip-${name}`} role="separator" aria-orientation="horizontal" aria-label={`Resize ${title}`}
          title="Drag to resize, double-click to fit" {...grip} onDoubleClick={() => set({ ...fold, height: undefined })} />
      )}
    </section>
  );
}
