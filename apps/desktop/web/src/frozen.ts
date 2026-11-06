import type { KeyboardEvent, MouseEvent } from 'react';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { frozenLine } from './placement.js';

/** What a try at changing this robot does when it is frozen, and nothing for any other robot. */
export function useRefusal(id: string | undefined): (() => void) | undefined {
  const line = useApp((s) => (id === undefined ? undefined : frozenLine(s, id)));
  return line === undefined ? undefined : () => app.store.getState().showToast(line);
}

const types = (e: KeyboardEvent): boolean => !e.repeat && !e.metaKey && !e.ctrlKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter');

export const fieldTry = (refuse?: () => void) => (refuse ? {
  readOnly: true,
  onClickCapture: () => refuse(),
  onKeyDownCapture: (e: KeyboardEvent) => { if (types(e)) refuse(); },
} : {});

// disabled would swallow the press that asks why
export const buttonTry = (refuse?: () => void) => (refuse ? {
  'aria-disabled': true,
  onClickCapture: (e: MouseEvent) => { e.stopPropagation(); refuse(); },
} : {});
