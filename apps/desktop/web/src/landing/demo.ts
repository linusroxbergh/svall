import type { Cell, Character, ContextItem, Island, Portrait } from '@svall/protocol';

// what the landing page's two scenes share: a made-up crew member, and the islands and cards the app's components take

export type Status = 'working' | 'idle' | 'blocked' | 'done';
export type Member = { id: string; name: string; portrait: Portrait; status: Status; ctx: number; links: ContextItem[] };

export const none = (): void => {};
export const pointer = { onPointerDown: none };
export const hold = { onPointerEnter: none, onPointerLeave: none };

export const islandModel = (i: { id: string; name: string; seed: number }, at: Cell, size: Island['size']): Island =>
  ({ id: i.id, name: i.name, description: '', instructions: '', context: [], position: at, size, seed: i.seed });

export const character = (m: Member, islandId: string, cell: Cell = { x: 0, y: 0 }): Character => ({
  id: m.id, islandId, cell, name: m.name, note: '', portrait: m.portrait, instructions: '', cwd: '~',
  context: m.links, shell: { lastOutputAt: 0 }, unread: m.status === 'done',
  agent: { kind: 'claude', sessionId: '', status: m.status, contextPct: m.ctx, lastActivityAt: 0 },
});
