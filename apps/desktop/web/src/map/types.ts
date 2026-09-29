import type React from 'react';
import type { Cell, Size } from '@svall/protocol';

export type Target =
  | { kind: 'figure'; id: string }
  | { kind: 'label'; islandId: string }
  | { kind: 'handle'; islandId: string }
  | { kind: 'water' };

export type PointerEv = { type: 'down' | 'move' | 'up' | 'cancel'; screen: { x: number; y: number }; target?: Target; time: number };

export type Drag =
  | { kind: 'figure'; id: string; cell: Cell; over?: { islandId: string; local: Cell; free: boolean } }
  | { kind: 'island'; id: string; position: Cell; offset?: { x: number; y: number } }
  | { kind: 'resize'; id: string; size: Size; offset?: { x: number; y: number } };

// the handlers a DOM element spreads to feed the map's pointer pipeline
// a pointer source only opens the sequence; the map host captures the pointer and sees it through
export type PointerHandlers = {
  onPointerDown(e: React.PointerEvent<Element>): void;
};

export type HoldHandlers = { onPointerEnter(): void; onPointerLeave(): void };

// the world the map draws: home and its crew are in screen space and stay out of it
export type MapDump = {
  scale: number;
  islands: { id: string; x: number; y: number; w: number; h: number }[];
  tokens: { id: string; cell: Cell; status: string }[];
};
