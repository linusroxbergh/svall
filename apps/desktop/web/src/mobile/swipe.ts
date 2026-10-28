/** How far a row slides to show its close action, in px; the action is exactly this wide. */
export const REVEAL = 88;

export const dragOffset = (from: number, dx: number): number => Math.max(-REVEAL, Math.min(0, from + dx));

export const settle = (offset: number): number => (offset < -REVEAL / 2 ? -REVEAL : 0);

// a drag that is mostly vertical belongs to the list's own scrolling
export const isSwipe = (dx: number, dy: number): boolean => Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.5;
