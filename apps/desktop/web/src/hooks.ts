import { memo, useEffect, useState, type FunctionComponent } from 'react';
import { useStore } from 'zustand';
import type { AppActions, AppState, AppStore } from './store/index.js';

let current: AppStore | undefined;

export function setAppStore(store: AppStore): void { current = store; }

export function useApp<T>(selector: (s: AppState & AppActions) => T): T {
  if (!current) throw new Error('setAppStore() before rendering');
  return useStore(current, selector);
}

// redraws every `ms`, for a label that counts from a moment no patch restates
export function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

type Bag = Record<string, unknown>;
const handlerOrSame = (a: unknown, b: unknown): boolean => Object.is(a, b) || (typeof a === 'function' && typeof b === 'function');
const sameItems = (a: unknown, b: unknown, same: (x: unknown, y: unknown) => boolean): boolean => {
  if (handlerOrSame(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => same((a as Bag)[k], (b as Bag)[k]));
};

/** Skips a redraw when each prop, or each item of an object or array prop, is unchanged. Handlers are never compared,
 *  so every handler given to such a component must read refs or the store, not the render that made it. */
export const memoByValue = <P extends object>(component: FunctionComponent<P>) =>
  memo(component, (a, b) => sameItems(a, b, (x, y) => sameItems(x, y, handlerOrSame)));
