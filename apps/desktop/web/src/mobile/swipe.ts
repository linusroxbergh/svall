/** How far a row slides to show its close action, in px; the action is exactly this wide. */
export const REVEAL = 88;

/** Where the row sits mid-drag: where it rested plus the finger's travel, kept between shut and revealed. */
export const dragOffset = (from: number, dx: number): number => Math.max(-REVEAL, Math.min(0, from + dx));

/** Where a released row comes to rest. */
export const settle = (offset: number): number => (offset < -REVEAL / 2 ? -REVEAL : 0);

// a drag that is mostly vertical belongs to the list's own scrolling
export const isSwipe = (dx: number, dy: number): boolean => Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.5;
