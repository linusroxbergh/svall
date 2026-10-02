import { useEffect, type RefObject } from 'react';
import type { Cell } from '@svall/protocol';
import { app } from '../boot.js';
import { charactersOf, mapIslandsSorted, statusOf } from '../selectors.js';
import { worldCell, worldToScreen, type Layout } from './layout.js';
import type { MapDump } from './types.js';

declare global { interface Window { __map?: { layout(): Layout; screenOf(cell: Cell): { x: number; y: number }; dump(): MapDump; refits(): number } } }

/** In a dev build, what the e2e specs read the map through. */
export function useDevHook(layoutRef: RefObject<Layout>, refits: RefObject<number>): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__map = {
      layout: () => layoutRef.current,
      screenOf: (c) => worldToScreen(layoutRef.current, c),
      // how often the camera has been sent somewhere new
      refits: () => refits.current,
      dump: () => {
        const f = app.store.getState().fleet;
        return {
          scale: layoutRef.current.scale,
          islands: mapIslandsSorted(f).map((i) => ({ id: i.id, x: i.position.x, y: i.position.y, w: i.size.w, h: i.size.h })),
          tokens: mapIslandsSorted(f).flatMap((i) => charactersOf(f, i.id).map((c) => ({
            id: c.id,
            cell: worldCell(i.position, c.cell),
            status: statusOf(c) as string,
          }))),
        };
      },
    };
    return () => { delete window.__map; };
  }, []);
}
