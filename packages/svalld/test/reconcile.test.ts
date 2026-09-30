import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, HOME_ISLAND, HOME_SEED, cellKey, emptyState, homeSizeFor, isLand, landCells, type Cell, type Character, type Island } from '@svall/protocol';
import { crewGrid, placementOk, trimHome } from '../src/layout.js';
import { RECOVERED_ISLAND, markDormant, placeOnIsland, reconcile, reviveCommand } from '../src/reconcile.js';
import type { LiveWindow } from '../src/tmux/tmux.js';

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const live = (name: string, windowId = '@1', paneId = '%1'): LiveWindow =>
  ({ windowId, paneId, name, command: 'zsh', path: '/repo', activity: 1000, dead: false });

const char = (over: Partial<Character>): Character => ({
  id: 'c_a', islandId: 'i_1', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/old', context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

describe('reconcile', () => {
  it('attaches a live window to its character by name', () => {
    const s = emptyState();
    s.characters.c_a = char({});
    const { mutate, renames } = reconcile(s, [live('c_a')], 5000);
    mutate(s);
    expect(s.characters.c_a.tmux).toEqual({ windowId: '@1', paneId: '%1' });
    expect(s.characters.c_a.cwd).toBe('/repo');
    expect(s.characters.c_a.shell.lastOutputAt).toBe(1000);
    expect(renames).toEqual([]);
  });

  it('leaves the shell activity of a character with an agent as it was', () => {
    const s = emptyState();
    s.characters.c_a = char({ agent: { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'working', lastActivityAt: 1 } });
    reconcile(s, [live('c_a')], 5000).mutate(s);
    expect(s.characters.c_a.shell.lastOutputAt).toBe(0);
  });

  it('keeps the cwd the hooks gave a character while its pane has not moved, or has no path to report', () => {
    const s = emptyState();
    s.characters.c_a = char({ cwd: '/repo/.claude/worktrees/x', panePath: '/repo' });
    s.characters.c_b = char({ id: 'c_b', cwd: '/home' });
    reconcile(s, [live('c_a'), { ...live('c_b', '@2', '%2'), path: '' }], 0).mutate(s);
    expect(s.characters.c_a).toMatchObject({ cwd: '/repo/.claude/worktrees/x', panePath: '/repo' });
    expect(s.characters.c_b.cwd).toBe('/home');
    s.characters.c_a.panePath = '/elsewhere';
    reconcile(s, [live('c_a')], 0).mutate(s);
    expect(s.characters.c_a).toMatchObject({ cwd: '/repo', panePath: '/repo' });
  });

  it('takes a pane path for a character still on its pane that has none on record, and keeps its cwd', () => {
    const s = emptyState();
    s.characters.c_a = char({ cwd: '/repo/.codex/worktrees/x', tmux: { windowId: '@1', paneId: '%1' } });
    reconcile(s, [live('c_a')], 0).mutate(s);
    expect(s.characters.c_a).toMatchObject({ cwd: '/repo/.codex/worktrees/x', panePath: '/repo' });
  });

  it('marks characters without a window dormant with a revive command', () => {
    const s = emptyState();
    s.characters.c_a = char({ tmux: { windowId: '@9', paneId: '%9' } });
    s.characters.c_b = char({
      id: 'c_b', tmux: { windowId: '@8', paneId: '%8' },
      agent: { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'idle', lastActivityAt: 0 },
    });
    reconcile(s, [], 0).mutate(s);
    expect(s.characters.c_a.tmux).toBeUndefined();
    expect(s.characters.c_a.revive).toEqual({ command: '' });
    expect(s.characters.c_b.revive).toEqual({ command: `claude --resume ${SID}` });
  });

  it('leaves a character already dormant with the revive it was given', () => {
    const s = emptyState();
    s.characters.c_a = char({
      agent: { kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0 },
      revive: { command: `claude --model 'opus' --resume ${SID}` },
    });
    reconcile(s, [], 0).mutate(s);
    expect(s.characters.c_a.revive).toEqual({ command: `claude --model 'opus' --resume ${SID}` });
  });

  it('recovers unknown windows as characters on the recovered island and renames them', () => {
    const s = emptyState();
    const { mutate, renames } = reconcile(s, [live('stray', '@4', '%4')], 0);
    mutate(s);
    const [c] = Object.values(s.characters);
    expect(c.islandId).toBe(RECOVERED_ISLAND);
    expect(c.name).toBe('stray');
    expect(c.tmux).toEqual({ windowId: '@4', paneId: '%4' });
    expect(s.islands[RECOVERED_ISLAND].name).toBe('recovered');
    expect(s.islands[RECOVERED_ISLAND].size).toEqual({ w: 7, h: 5 });
    expect(isLand(s.islands[RECOVERED_ISLAND], c.cell)).toBe(true);
    expect(renames).toEqual([{ windowId: '@4', name: c.id }]);
  });

  it('adopts a stray named like a character id under that id, which a second window of that name cannot share', () => {
    const s = emptyState();
    const { mutate, renames } = reconcile(s, [live('c_ab12cd', '@4', '%4'), live('c_ab12cd', '@5', '%5')], 0);
    mutate(s);
    expect(s.characters.c_ab12cd).toMatchObject({ islandId: RECOVERED_ISLAND, tmux: { windowId: '@4', paneId: '%4' } });
    const twin = Object.values(s.characters).find((c) => c.tmux?.windowId === '@5')!;
    expect(twin.id).not.toBe('c_ab12cd');
    expect(renames).toEqual([{ windowId: '@5', name: twin.id }]);
  });

  it('gives a stray kept under its own id its second window back, as its second terminal', () => {
    const s = emptyState();
    const { mutate, renames } = reconcile(s, [live('c_ab12cd', '@4', '%4'), live('c_ab12cd-2', '@5', '%5')], 0);
    mutate(s);
    expect(Object.keys(s.characters)).toEqual(['c_ab12cd']);
    expect(s.characters.c_ab12cd.second).toEqual({ tmux: { windowId: '@5', paneId: '%5' }, unread: false });
    expect(renames).toEqual([]);
  });

  it('puts a character whose island is gone on the recovered island, keeping all it carries', () => {
    const s = emptyState();
    s.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: DEFAULT_SIZE, seed: 1 };
    s.characters.c_a = char({ cell: landCells(DEFAULT_SIZE, 1)[0] });
    s.characters.c_b = char({ id: 'c_b', islandId: 'i_gone', note: 'halfway', agent: { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'idle', lastActivityAt: 0 } });
    reconcile(s, [], 0).mutate(s);
    expect(s.characters.c_a.islandId).toBe('i_1');
    expect(s.characters.c_b).toMatchObject({ islandId: RECOVERED_ISLAND, note: 'halfway', revive: { command: `claude --resume ${SID}` } });
    expect(isLand(s.islands[RECOVERED_ISLAND], s.characters.c_b.cell)).toBe(true);
  });

  it('lays out again the crew of a recovered island that is gone, on ground sized for them alone', () => {
    const s = emptyState();
    s.characters.c_a = char({ islandId: RECOVERED_ISLAND });
    s.characters.c_b = char({ id: 'c_b', islandId: RECOVERED_ISLAND });
    reconcile(s, [], 0).mutate(s);
    const { size, cells } = crewGrid(2, s.islands[RECOVERED_ISLAND].seed);
    expect(s.islands[RECOVERED_ISLAND].size).toEqual(size);
    expect([s.characters.c_a.cell, s.characters.c_b.cell]).toEqual(cells);
  });

  it('leaves a stray the recovered island has no room for unadopted, and reconciles the rest', () => {
    const s = emptyState();
    s.characters.c_a = char({});
    // an island too large for any push to clear off the recovered island standing inside it
    s.islands.i_big = { id: 'i_big', name: 'big', description: '', instructions: '', context: [], position: { x: -100, y: -100 }, size: { w: 210, h: 210 }, seed: 1 };
    s.islands[RECOVERED_ISLAND] = { id: RECOVERED_ISLAND, name: 'recovered', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: DEFAULT_SIZE, seed: 0 };
    const { mutate, renames, unplaced } = reconcile(s, [live('c_a'), live('stray', '@4', '%4')], 0);
    mutate(s);
    expect(Object.keys(s.characters)).toEqual(['c_a']);
    expect(s.characters.c_a.tmux).toEqual({ windowId: '@1', paneId: '%1' });
    expect(unplaced[0]).toMatch(/stray window stray/);
    expect(renames).toEqual([]);
  });

  it('a window named after a character plus -2 is its second terminal, not a stray', () => {
    const s = emptyState();
    s.characters.c_a = char({});
    const { mutate, renames } = reconcile(s, [live('c_a'), live('c_a-2', '@2', '%2')], 1);
    expect(renames).toEqual([]);
    mutate(s);
    expect(Object.keys(s.characters)).toEqual(['c_a']);
    expect(s.characters.c_a.second).toEqual({ tmux: { windowId: '@2', paneId: '%2' }, unread: false });
  });

  it('a second terminal whose window is gone is dropped, keeping nothing to revive', () => {
    const s = emptyState();
    s.characters.c_a = char({ second: { tmux: { windowId: '@2', paneId: '%2' }, unread: true } });
    reconcile(s, [live('c_a')], 1).mutate(s);
    expect(s.characters.c_a.second).toBeUndefined();
  });

  it('a second terminal opened since the listing was taken is left alone', () => {
    const s = emptyState();
    s.characters.c_a = char({});
    const { mutate } = reconcile(s, [live('c_a')], 1, new Set(['c_a']), new Set());
    s.characters.c_a.second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    mutate(s);
    expect(s.characters.c_a.second).toEqual({ tmux: { windowId: '@2', paneId: '%2' }, unread: false });
  });

  it('placeOnIsland keeps growing while every new row touches a character', () => {
    // every land cell taken: the first new row is all blocked, so a single grow is not enough
    const island: Island = { id: 'a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 10, h: 8 }, seed: 5 };
    const cells = landCells(island.size, island.seed);
    const s = { ...emptyState(), islands: { a: island } };
    cells.forEach((cell, i) => { s.characters[`c_${i}`] = char({ id: `c_${i}`, islandId: 'a', cell }); });
    const cell = placeOnIsland(s, 'a');
    expect(s.islands.a.size.h).toBeGreaterThan(9);
    expect(isLand(s.islands.a, cell)).toBe(true);
    const occupied = new Set(Object.values(s.characters).map((c) => cellKey(c.cell)));
    expect(occupied.has(cellKey(cell))).toBe(false);
  });

  it('placeOnIsland re-places a character already standing there without sizing for it twice', () => {
    const island: Island = { id: 'a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 7, h: 5 }, seed: 4 };
    const s = { ...emptyState(), islands: { a: island } };
    s.characters.c_0 = char({ id: 'c_0', islandId: 'a', cell: { x: 2, y: 2 } });
    s.characters.c_1 = char({ id: 'c_1', islandId: 'a', cell: { x: 5, y: 2 } });
    const cell = placeOnIsland(s, 'a', 'c_1');
    expect(s.islands.a.size).toEqual(crewGrid(2, 4).size);
    expect(isLand(s.islands.a, cell)).toBe(true);
    expect(cellKey(cell)).not.toBe(cellKey(s.characters.c_0.cell));
  });

  it('placeOnIsland pushes a folded neighbour aside as it grows', () => {
    // a folded island is held by its label pill, two rows above its footprint: the push clears the pill
    const island: Island = { id: 'a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 4, h: 3 }, seed: 3 };
    const folded: Island = { ...island, id: 'o', name: 'ab', position: { x: 0, y: 5 }, size: { w: 6, h: 4 }, collapsed: true };
    const s = { ...emptyState(), islands: { a: island, o: folded } };
    landCells(island.size, island.seed).forEach((cell, i) => { s.characters[`c_${i}`] = char({ id: `c_${i}`, islandId: 'a', cell }); });
    expect(placementOk(s, s.islands.o)).toBe(true);
    const cell = placeOnIsland(s, 'a');
    expect(isLand(s.islands.a, cell)).toBe(true);
    expect(placementOk(s, s.islands.a)).toBe(true);
    expect(placementOk(s, s.islands.o)).toBe(true);
  });

  it('a character gone dormant has no window left to be told about', () => {
    const c = char({ hint: 'codex-silent', tmux: { windowId: '@1', paneId: '%1' } });
    markDormant(c);
    expect(c.hint).toBeUndefined();
    expect(c.tmux).toBeUndefined();
  });

  it('a character gone dormant leaves no question open, and keeps a finished result', () => {
    const asking = char({ tmux: { windowId: '@1', paneId: '%1' }, agent: { kind: 'claude', sessionId: SID, status: 'blocked', prompt: 'Allow?', promptId: 'p1', asking: ['a1'], lastActivityAt: 0 } });
    markDormant(asking);
    expect(asking.agent).toEqual({ kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0 });
    const done = char({ tmux: { windowId: '@1', paneId: '%1' }, unread: true, agent: { kind: 'claude', sessionId: SID, status: 'done', prompt: 'API error', lastActivityAt: 0 } });
    markDormant(done);
    expect(done.agent).toMatchObject({ status: 'done', prompt: 'API error' });
  });

  it('reviveCommand reflects agent presence', () => {
    expect(reviveCommand(char({}))).toBe('');
    const agent = (sessionId: string) => char({ agent: { kind: 'claude', sessionId, transcriptPath: '/t', status: 'done', lastActivityAt: 0 } });
    expect(reviveCommand(agent(SID))).toBe(`claude --resume ${SID}`);
    // a codex character followed into a worktree revives there, away from the directory its session began in
    expect(reviveCommand(char({ agent: { kind: 'codex', sessionId: SID, status: 'done', lastActivityAt: 0 } }))).toBe(`codex resume -c tui.resume_cwd=session ${SID}`);
    expect(reviveCommand(agent('x; rm -rf ~'))).toBe('');
  });
});

describe('placeOnIsland on home', () => {
  const home = (): Island => ({ id: HOME_ISLAND, kind: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: homeSizeFor(2), seed: HOME_SEED });
  it('fills the crew row slot by slot, then widens the island by one slot', () => {
    const s = emptyState();
    s.islands.home = home();
    const placed: Cell[] = [];
    for (let n = 0; n < 4; n++) {
      const cell = placeOnIsland(s, HOME_ISLAND);
      placed.push(cell);
      s.characters[`c${n}`] = char({ id: `c${n}`, islandId: HOME_ISLAND, cell });
    }
    expect(placed).toEqual([{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 7, y: 1 }, { x: 10, y: 1 }]);
    expect(s.islands.home.size).toEqual({ w: 14, h: 4 });
  });
  it('reuses a freed slot before growing', () => {
    const s = emptyState();
    s.islands.home = home();
    s.characters.c1 = char({ id: 'c1', islandId: HOME_ISLAND, cell: { x: 4, y: 1 } });
    expect(placeOnIsland(s, HOME_ISLAND)).toEqual({ x: 1, y: 1 });
    expect(s.islands.home.size).toEqual({ w: 8, h: 4 });
  });
});

describe('trimHome', () => {
  const home = (w: number): Island => ({ id: HOME_ISLAND, kind: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w, h: 4 }, seed: HOME_SEED });
  const crew = (xs: number[]) => {
    const s = emptyState();
    s.islands.home = home(17);
    xs.forEach((x, n) => { s.characters[`c${n}`] = char({ id: `c${n}`, islandId: HOME_ISLAND, cell: { x, y: 1 } }); });
    return s;
  };
  it('drops the empty slots past the last crew member and moves nobody', () => {
    const s = crew([1, 7]);
    // a character on another island is no crew of home's, wherever it stands
    s.characters.far = char({ id: 'far', islandId: 'i_1', cell: { x: 13, y: 1 } });
    trimHome(s);
    expect(s.islands.home.size).toEqual({ w: 11, h: 4 });
    expect([s.characters.c0.cell, s.characters.c1.cell]).toEqual([{ x: 1, y: 1 }, { x: 7, y: 1 }]);
  });
  it('never goes below two slots', () => {
    for (const xs of [[1], []]) {
      const s = crew(xs);
      trimHome(s);
      expect(s.islands.home.size).toEqual(homeSizeFor(2));
    }
  });
  it('leaves a full row, and a narrower home, as they are', () => {
    const full = crew([1, 4, 7, 10, 13]);
    trimHome(full);
    expect(full.islands.home.size).toEqual({ w: 17, h: 4 });
    const narrow = crew([]);
    narrow.islands.home = home(6);
    trimHome(narrow);
    expect(narrow.islands.home.size).toEqual({ w: 6, h: 4 });
  });
});
