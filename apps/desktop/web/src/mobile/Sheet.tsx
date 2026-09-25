import type { JSX, ReactNode } from 'react';

/** A panel rising from the bottom edge; a tap on the dimmed list behind it closes it. */
export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }): JSX.Element {
  return (
    <div className="sheet-back" onPointerDown={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button type="button" onClick={onClose}>close</button>
        </header>
        {children}
      </div>
    </div>
  );
}
