import { useEffect, useState } from 'react';
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
