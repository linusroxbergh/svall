import type { Rect } from '../bridge.js';
import { clampHalf, DEFAULT_HALF_CARD, type CardSize, type HalfCard } from '../store/index.js';

type Opts = { size: CardSize; win: { w: number; h: number }; half?: HalfCard };

export function cardRect({ size, win, half = DEFAULT_HALF_CARD }: Opts): Rect {
  if (size === 'full') return { x: 0, y: 0, width: win.w, height: win.h };
  const width = Math.round(win.w * clampHalf(half.w)), height = Math.round(win.h * clampHalf(half.h));
  return { x: Math.round((win.w - width) / 2), y: Math.round((win.h - height) / 2), width, height };
}

// the grip drags the card's bottom-right corner and the card stays centred, so the card grows by
// twice what the pointer travelled; measuring the travel keeps the grip under the pointer it grabbed
export const halfCardBy = (from: HalfCard, by: { x: number; y: number }, win: { w: number; h: number }): HalfCard => ({
  w: clampHalf(from.w + (2 * by.x) / win.w),
  h: clampHalf(from.h + (2 * by.y) / win.h),
});
