import { useStore } from 'zustand';
import type { AppActions, AppState, AppStore } from './store/index.js';

let current: AppStore | undefined;

export function setAppStore(store: AppStore): void { current = store; }

export function useApp<T>(selector: (s: AppState & AppActions) => T): T {
  if (!current) throw new Error('setAppStore() before rendering');
  return useStore(current, selector);
}
