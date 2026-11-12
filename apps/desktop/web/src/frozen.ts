import type { MouseEvent } from 'react';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { frozenLine } from './placement.js';

/** What a try at changing this robot does when it is frozen, and why, and nothing for any other robot. */
export function useRefusal(id: string | undefined): ((() => void) & { why: string }) | undefined {
  const line = useApp((s) => (id === undefined ? undefined : frozenLine(s, id)));
  return line === undefined ? undefined : Object.assign(() => app.store.getState().showToast(line), { why: line });
}

// a field that takes no change reads as text and says why in its tip
export const fieldTry = (refuse?: { why?: string }) => (refuse ? { readOnly: true, 'data-tip': refuse.why } : {});

// disabled would swallow the press that asks why
export const buttonTry = (refuse?: () => void) => (refuse ? {
  'aria-disabled': true,
  onClickCapture: (e: MouseEvent) => { e.stopPropagation(); refuse(); },
} : {});
