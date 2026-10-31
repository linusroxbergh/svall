import type { Cell, Robot, ContextItem, Island } from '@svall/protocol';

// what the landing page's two scenes share: a made-up crew member, and the islands and cards the app's components take

export type Status = 'working' | 'idle' | 'blocked' | 'done';
export type Member = { id: string; name: string; figure: number; status: Status; ctx: number; links: ContextItem[]; monitor?: boolean; subs?: number; machine?: string };

export const none = (): void => {};
export const pointer = { onPointerDown: none };
export const hold = { onPointerEnter: none, onPointerLeave: none };

export const islandModel = (i: { id: string; name: string; seed: number }, at: Cell, size: Island['size']): Island =>
  ({ id: i.id, name: i.name, description: '', instructions: '', context: [], position: at, size, seed: i.seed });

export const robot = (m: Member, islandId: string, cell: Cell = { x: 0, y: 0 }): Robot => ({
  id: m.id, islandId, cell, name: m.name, note: '', portrait: 'fox', figure: m.figure, instructions: '', cwd: '~',
  context: m.links, shell: { lastOutputAt: 0 }, unread: m.status === 'done',
  agent: {
    kind: 'claude', sessionId: '', status: m.status, contextPct: m.ctx, lastActivityAt: 0,
    monitors: m.monitor ? ['monitor'] : undefined, subagents: Array.from({ length: m.subs ?? 0 }, (_, i) => `sub${i}`),
  },
});
