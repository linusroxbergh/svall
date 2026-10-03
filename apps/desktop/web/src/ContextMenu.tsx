import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { refocusSurface } from './keyboard.js';
import type { MenuEntry } from './store/ui.js';
import { theme } from './theme.js';

const RELOAD: MenuEntry = { title: 'Reload', run: () => window.location.reload() };

/** A right-click's menu by the pointer, with the page's Reload under the caller's entries. */
export function ContextMenu() {
  const menu = useApp((s) => s.menu);
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const items = menu ? [...menu.items, RELOAD] : [];

  const close = () => app.store.getState().closeMenu();
  const pick = (it: MenuEntry) => { if (!it.run) return; close(); it.run(); };
  const step = (from: number, by: number) => {
    for (let i = from + by; i >= 0 && i < items.length; i += by) if (items[i]!.run) return i;
    return from;
  };

  // the menu opens down and right of the pointer, and flips where the window has no room; placed before the cutout measures it
  useLayoutEffect(() => {
    const el = box.current;
    if (!menu || !el) return;
    const m = theme.menu.margin, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(m, Math.min(menu.x, window.innerWidth - w - m))}px`;
    el.style.top = `${Math.max(m, menu.y + h + m > window.innerHeight ? menu.y - h : menu.y)}px`;
    setActive(-1);
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
    const key = (e: KeyboardEvent) => {
      const act = {
        ArrowDown: () => setActive((a) => step(a, 1)),
        ArrowUp: () => setActive((a) => step(a < 0 ? items.length : a, -1)),
        Enter: () => { if (items[active]) pick(items[active]); },
        ' ': () => { if (items[active]) pick(items[active]); },
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
  return (
    <div ref={box} className="ctx-menu" role="menu" data-testid="context-menu"
      onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <Fragment key={i}>
          {it === RELOAD && <div className="ctx-sep" role="separator" />}
          <div role="menuitem" className="ctx-item" aria-disabled={!it.run || undefined} data-active={i === active}
            data-danger={it.danger || undefined} data-testid={`menu-${it.title.toLowerCase()}`}
            onPointerEnter={() => setActive(it.run ? i : -1)} onPointerLeave={() => setActive(-1)} onClick={() => pick(it)}>
            {it.title}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
