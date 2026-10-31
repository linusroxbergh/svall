import type { Ref } from 'react';

/** A dialog's way out, at the right of its kicker; Escape does the same. */
export function CloseX({ onClose, testid, ref }: { onClose(): void; testid: string; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} className="ib side-x" data-testid={testid} data-tip="Close" aria-label="Close" onClick={onClose}>×</button>;
}
