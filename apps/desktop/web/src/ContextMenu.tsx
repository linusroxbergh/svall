import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { refocusSurface } from './keyboard.js';
import type { MenuEntry } from './store/ui.js';
import { theme } from './theme.js';

const RELOAD: MenuEntry = { title: 'Reload', sep: true, run: () => window.location.reload() };

const live = (it: MenuEntry): boolean => Boolean(it.run || it.items?.some((x) => x.run));

// the next entry from `from` that can be picked, or `from` when there is none
export const step = <T,>(items: T[], from: number, by: number, ok: (it: T) => boolean): number => {
  for (let i = from + by; i >= 0 && i < items.length; i += by) if (ok(items[i]!)) return i;
  return from;
};

function Item({ it, active, onEnter, onLeave, onPick, rowRef }: {
  it: MenuEntry; active: boolean; onEnter(): void; onLeave(): void; onPick(): void; rowRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={rowRef} role="menuitem" className="ctx-item" aria-disabled={!live(it) || undefined} aria-haspopup={it.items ? 'menu' : undefined}
      data-active={active} data-danger={it.danger || undefined} data-testid={`menu-${it.title.toLowerCase()}`}
      onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onPick}>
      {it.title}
      {it.items && <span className="ctx-mark">›</span>}
      {it.note && <small className="ctx-mark ctx-note">{it.note}</small>}
      {it.checked && <span className="ctx-mark ctx-check" data-testid="menu-checked">✓</span>}
    </div>
  );
}

/** An entry's items, beside it and flipped to its left where the window has no room. */
function SubMenu({ items, anchor, active, setActive, pick }: {
  items: MenuEntry[]; anchor: HTMLElement; active: number; setActive(i: number): void; pick(it: MenuEntry): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect(), m = theme.menu.margin, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${r.right + w + m <= window.innerWidth ? r.right : Math.max(m, r.left - w)}px`;
    el.style.top = `${Math.max(m, Math.min(r.top, window.innerHeight - h - m))}px`;
  }, [anchor]);
  useEffect(() => (box.current ? holdCutout(app.bridge, box.current) : undefined), []);
  return (
    <div ref={box} className="ctx-menu popover" role="menu" data-testid="context-submenu">
      {items.map((it, i) => (
        <Item key={i} it={it} active={i === active} onEnter={() => setActive(live(it) ? i : -1)} onLeave={() => setActive(-1)} onPick={() => pick(it)} />
      ))}
    </div>
  );
}

/** A right-click's menu by the pointer, with the page's Reload under the caller's entries unless the menu is bare. */
export function ContextMenu() {
  const menu = useApp((s) => s.menu);
  const box = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [active, setActive] = useState(-1);
  // the entry whose items stand open beside it, and the one among them the keys are on
  const [sub, setSub] = useState(-1);
  const [subActive, setSubActive] = useState(-1);
  const items = menu ? (menu.bare ? menu.items : [...menu.items, RELOAD]) : [];
  const subItems = items[sub]?.items ?? [];

  const close = () => app.store.getState().closeMenu();
  const pick = (it: MenuEntry) => { if (!it.run) return; close(); it.run(); };
  const open = (i: number, keys: boolean) => { setSub(i); setSubActive(keys ? step(items[i]?.items ?? [], -1, 1, live) : -1); };
  const press = (i: number, keys = false) => { const it = items[i]; if (it?.items) open(i, keys); else if (it) pick(it); };

  // the menu opens down and right of the pointer, and flips where the window has no room; placed before the cutout measures it
  useLayoutEffect(() => {
    const el = box.current;
    if (!menu || !el) return;
    const m = theme.menu.margin, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(m, Math.min(menu.x, window.innerWidth - w - m))}px`;
    el.style.top = `${Math.max(m, menu.y + h + m > window.innerHeight ? menu.y - h : menu.y)}px`;
    setActive(-1);
    setSub(-1);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) close(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('wheel', away, true);
    // a press on a terminal never reaches the page; the shell answers for those
    const off = app.bridge.onMessage((m) => { if (m.type === 'shell.pressedAway') close(); });
    // a right-click leaves the keys where they were, a terminal perhaps, where Escape would reach its agent
    app.bridge.send({ type: 'term.focus' });
    const release = box.current ? holdCutout(app.bridge, box.current) : undefined;
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('wheel', away, true);
      off();
      release?.();
    };
  }, [menu]);

  // the card and the map read these keys too, so the menu takes them first
  useEffect(() => {
    if (!menu) return;
    const inSub = subActive >= 0;
    const enter = () => (inSub ? subItems[subActive] && pick(subItems[subActive]) : press(active, true));
    const key = (e: KeyboardEvent) => {
      const act = {
        ArrowDown: () => (inSub ? setSubActive(step(subItems, subActive, 1, live)) : (setSub(-1), setActive(step(items, active, 1, live)))),
        ArrowUp: () => (inSub ? setSubActive(step(subItems, subActive, -1, live)) : (setSub(-1), setActive(step(items, active < 0 ? items.length : active, -1, live)))),
        ArrowRight: () => { if (!inSub && items[active]?.items) open(active, true); },
        ArrowLeft: () => { if (inSub) { setSub(-1); setSubActive(-1); } },
        Enter: enter,
        ' ': enter,
        Escape: () => { close(); refocusSurface(app); },
      }[e.key];
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  if (!menu) return null;
  const anchor = rows.current[sub];
  return (
    <div ref={box} className="ctx-menu popover" role="menu" data-testid="context-menu"
      onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <Fragment key={i}>
          {it.sep && <div className="ctx-sep" role="separator" />}
          <Item it={it} active={i === active} rowRef={(el) => { rows.current[i] = el; }}
            onEnter={() => { setActive(live(it) ? i : -1); if (it.items && live(it)) open(i, false); else setSub(-1); }}
            onLeave={() => setActive(-1)} onPick={() => press(i)} />
        </Fragment>
      ))}
      {sub >= 0 && anchor && <SubMenu items={subItems} anchor={anchor} active={subActive} setActive={setSubActive} pick={pick} />}
    </div>
  );
}
