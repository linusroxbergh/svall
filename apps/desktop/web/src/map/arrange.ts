import { useEffect, useRef, type RefObject } from 'react';
import type { FleetState } from '@svall/protocol';
import { arrangeIslands } from '../actions.js';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import type { CardSize } from '../store/index.js';
import { theme } from '../theme.js';
import { DBL_CLICK_MS } from './interactions.js';
import { homeRoom } from './resources.js';

// A map squeezed between the side panels is too narrow to choose a lasting fleet arrangement.
const MIN_ARRANGE_ASPECT = 0.5;

type Opts = {
  host: RefObject<HTMLDivElement | null>;
  islands: FleetState['islands'];
  card: string | undefined;
  cardSize: CardSize;
  lastPressAt: RefObject<number>;
  reserveAt(w: number): number;
};

/** Arranging the fleet to the map's shape: when asked, and on its own as the map gets room back. */
export function useAutoArrange({ host, islands, card, cardSize, lastPressAt, reserveAt }: Opts) {
  const autoArrange = useApp((s) => s.settings.autoArrange);
  const arrangeAsk = useApp((s) => s.arrangeAsk);

  // the shape the arranged fleet should fill: the map minus the fit insets and the ground mission control keeps
  const arrange = (automatic = false) => {
    const el = host.current;
    if (!el || (automatic && app.store.getState().status !== 'online')) return;
    const room = { w: el.clientWidth, h: el.clientHeight - reserveAt(el.clientWidth) };
    const w = room.w - 2 * theme.fit.x, h = room.h - theme.fit.top - theme.fit.bottom;
    if (w <= 0 || h <= 0) return;
    // the map's own shape says whether it is squeezed, whatever margins the fit keeps inside it
    if (automatic && room.w / room.h < MIN_ARRANGE_ASPECT) return;
    arrangeIslands(deps(), w / h, homeRoom(el.clientWidth));
  };
  const arrangeRef = useRef(() => arrange(true));
  arrangeRef.current = () => arrange(true);
  useEffect(() => {
    if (!arrangeAsk) return;
    app.store.getState().arranged();
    // behind a full card the card's closing arranges
    if (arrangeAsk === 'auto' && coveredRef.current) return;
    arrange(arrangeAsk === 'auto');
  }, [arrangeAsk]);

  // a hidden island comes back to the stale spot it left, so whichever client unfolded it, the fleet is arranged round it
  const folded = useRef<Set<string>>(undefined);
  useEffect(() => {
    const now = new Set(Object.values(islands).filter((i) => i.collapsed && i.kind !== 'home').map((i) => i.id));
    const back = [...(folded.current ?? [])].some((id) => islands[id] && !now.has(id));
    folded.current = now;
    // behind a full card the card's closing arranges
    if (back && autoArrange && !coveredRef.current) arrange(true);
  }, [islands]);

  // the fleet is arranged to the room the map finds each time its card shrinks from full or closes
  const covered = Boolean(card) && cardSize === 'full';
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const cover = card ? (covered ? 2 : 1) : 0;
  const lastCover = useRef(cover);
  // a click on the sea closes the card, so the fleet holds still until that click sequence is over
  const arrangeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const arrangeAfterClicks = () => {
    const wait = lastPressAt.current + DBL_CLICK_MS - performance.now();
    clearTimeout(arrangeTimer.current);
    if (wait > 0) arrangeTimer.current = setTimeout(arrangeAfterClicks, wait); else arrangeRef.current();
  };
  useEffect(() => () => clearTimeout(arrangeTimer.current), []);
  useEffect(() => {
    const uncovered = cover < lastCover.current;
    lastCover.current = cover;
    if (uncovered && autoArrange) arrangeAfterClicks();
  }, [cover]);

  // a drag-resize arranges once, after the window stands still. a page zoom resizes the view without moving the
  // window, so the size is measured in pixels the zoom cannot change; behind a full card the uncovering arranges
  useEffect(() => {
    if (!autoArrange) return;
    const windowSize = () => {
      const zoom = app.store.getState().settings.zoom;
      return { w: window.innerWidth * zoom, h: window.innerHeight * zoom };
    };
    let timer: ReturnType<typeof setTimeout>;
    let last = windowSize();
    const onResize = () => {
      const now = windowSize();
      if (Math.abs(now.w - last.w) <= 2 && Math.abs(now.h - last.h) <= 2) return;
      last = now;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!coveredRef.current) arrangeRef.current(); }, theme.autoArrangeMs);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(timer); };
  }, [autoArrange]);

  return { arrange, covered };
}
