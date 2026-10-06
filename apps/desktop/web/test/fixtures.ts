import { DEFAULT_CWD, defaultHome, type Character, type FleetState, type Island } from '@svall/protocol';

export const isl = (id: string, name: string, x: number, extra: Partial<Island> = {}): Island =>
  ({ id, name, description: '', instructions: '', context: [], position: { x, y: 0 }, size: { w: 6, h: 4 }, seed: 1, ...extra });

export const chr = (id: string, islandId: string, cell: { x: number; y: number }, extra: Partial<Character> = {}): Character => ({
  id, islandId, cell, name: id, portrait: 'fox', note: '', instructions: '', cwd: '/tmp', context: [],
  tmux: { windowId: '@1', paneId: '%1' }, shell: { lastOutputAt: 0 }, unread: false, ...extra,
});

// islands deliberately out of name order; strip order must be c2 (alpha), c0, c1 (beta)
export const fleet = (): FleetState => ({
  version: 9,
  islands: {
    i_b: isl('i_b', 'beta', 0), i_a: isl('i_a', 'alpha', 8), i_e: isl('i_e', 'empty', 16),
    home: isl('home', 'mission control', 30, { kind: 'home', size: { w: 8, h: 4 }, seed: 7 }),
  },
  characters: { c1: chr('c1', 'i_b', { x: 4, y: 1 }), c0: chr('c0', 'i_b', { x: 1, y: 1 }), c2: chr('c2', 'i_a', { x: 1, y: 1 }) },
  home: { ...defaultHome(), cwd: '/mc' },
  defaultCwd: DEFAULT_CWD,
});
