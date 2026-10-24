import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, HOME_ISLAND, HOME_SEED, cellKey, crewGrid, emptyState, homeSizeFor, isLand, landCells, type AgentKind, type Cell, type Robot, type Island } from '@svall/protocol';
import { markDormant, reviveCommand } from '../src/dormancy.js';
import { aboveHome, placeOnIsland, placementOk, trimHome } from '../src/layout.js';
import { RECOVERED_ISLAND, reconcile, snapshot, syncWindow } from '../src/reconcile.js';
import type { LiveWindow } from '../src/tmux/tmux.js';

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const OSID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
const live = (name: string, windowId = '@1', paneId = '%1'): LiveWindow =>
  ({ windowId, paneId, panePid: 100, name, command: 'zsh', path: '/repo', activity: 1000, dead: false });

const robot = (over: Partial<Robot>): Robot => ({
  id: 'c_a', islandId: 'i_1', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/old', context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...over,
});

describe('reconcile', () => {
  it('attaches a live window to its robot by name', () => {
    const s = emptyState();
    s.robots.c_a = robot({});
    const { mutate, renames } = reconcile(s, [live('c_a')], 5000);
    mutate(s);
    expect(s.robots.c_a.tmux).toEqual({ windowId: '@1', paneId: '%1' });
    expect(s.robots.c_a.cwd).toBe('/repo');
    expect(s.robots.c_a.shell.lastOutputAt).toBe(1000);
    expect(renames).toEqual([]);
  });

  it('leaves the shell activity of a robot with an agent as it was', () => {
    const s = emptyState();
    s.robots.c_a = robot({ agent: { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'working', lastActivityAt: 1 } });
    reconcile(s, [live('c_a')], 5000).mutate(s);
    expect(s.robots.c_a.shell.lastOutputAt).toBe(0);
  });

  it('keeps the cwd the hooks gave a robot while its pane has not moved, or has no path to report', () => {
    const s = emptyState();
    s.robots.c_a = robot({ cwd: '/repo/.claude/worktrees/x', panePath: '/repo' });
    s.robots.c_b = robot({ id: 'c_b', cwd: '/home' });
    reconcile(s, [live('c_a'), { ...live('c_b', '@2', '%2'), path: '' }], 0).mutate(s);
    expect(s.robots.c_a).toMatchObject({ cwd: '/repo/.claude/worktrees/x', panePath: '/repo' });
    expect(s.robots.c_b.cwd).toBe('/home');
    s.robots.c_a.panePath = '/elsewhere';
    reconcile(s, [live('c_a')], 0).mutate(s);
    expect(s.robots.c_a).toMatchObject({ cwd: '/repo', panePath: '/repo' });
  });

  it('takes a pane path for a robot still on its pane that has none on record, and keeps its cwd', () => {
    const s = emptyState();
    s.robots.c_a = robot({ cwd: '/repo/.codex/worktrees/x', tmux: { windowId: '@1', paneId: '%1' } });
    reconcile(s, [live('c_a')], 0).mutate(s);
    expect(s.robots.c_a).toMatchObject({ cwd: '/repo/.codex/worktrees/x', panePath: '/repo' });
  });

  it('marks robots without a window dormant with a revive command', () => {
    const s = emptyState();
    s.robots.c_a = robot({ tmux: { windowId: '@9', paneId: '%9' } });
    s.robots.c_b = robot({
      id: 'c_b', tmux: { windowId: '@8', paneId: '%8' },
      agent: { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'idle', lastActivityAt: 0 },
    });
    reconcile(s, [], 0).mutate(s);
    expect(s.robots.c_a.tmux).toBeUndefined();
    expect(s.robots.c_a.revive).toEqual({ command: '' });
    expect(s.robots.c_b.revive).toEqual({ command: `claude --resume ${SID}` });
  });

  it('leaves a robot already dormant with the revive it was given', () => {
    const s = emptyState();
    s.robots.c_a = robot({
      agent: { kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0 },
      revive: { command: `claude --model 'opus' --resume ${SID}` },
    });
    reconcile(s, [], 0).mutate(s);
    expect(s.robots.c_a.revive).toEqual({ command: `claude --model 'opus' --resume ${SID}` });
  });

  it('recovers unknown windows as robots on the recovered island and renames them', () => {
    const s = emptyState();
    const { mutate, renames } = reconcile(s, [live('stray', '@4', '%4')], 0);
    mutate(s);
    const [c] = Object.values(s.robots);
    expect(c.islandId).toBe(RECOVERED_ISLAND);
    expect(c.name).toBe('stray');
    expect(c.tmux).toEqual({ windowId: '@4', paneId: '%4' });
    expect(s.islands[RECOVERED_ISLAND].name).toBe('recovered');
    expect(s.islands[RECOVERED_ISLAND].size).toEqual({ w: 7, h: 5 });
    expect(isLand(s.islands[RECOVERED_ISLAND], c.cell)).toBe(true);
    expect(renames).toEqual([{ windowId: '@4', name: c.id }]);
  });

  it('adopts no window whose listing row has no name, or did not parse', () => {
    const s = emptyState();
    // a row whose separators tmux printed as text: one field, holding the whole row
    const unread = { windowId: '@0\\037ab%0\\037ab21\\037ab_keep', panePid: NaN, activity: 0, dead: false } as unknown as LiveWindow;
    const { mutate, renames } = reconcile(s, [live('', '@4', '%4'), unread], 0);
    mutate(s);
    expect(s.robots).toEqual({});
    expect(s.islands[RECOVERED_ISLAND]).toBeUndefined();
    expect(renames).toEqual([]);
  });

  it('adopts a stray named like a robot id under that id, which a second window of that name cannot share', () => {
    const s = emptyState();
    const { mutate, renames } = reconcile(s, [live('c_ab12cd', '@4', '%4'), live('c_ab12cd', '@5', '%5')], 0);
    mutate(s);
    expect(s.robots.c_ab12cd).toMatchObject({ islandId: RECOVERED_ISLAND, tmux: { windowId: '@4', paneId: '%4' } });
    const twin = Object.values(s.robots).find((c) => c.tmux?.windowId === '@5')!;
    expect(twin.id).not.toBe('c_ab12cd');
    expect(renames).toEqual([{ windowId: '@5', name: twin.id }]);
  });

  it('gives a stray kept under its own id its second window back, as its second terminal', () => {
    const s = emptyState();
    const { mutate, renames } = reconcile(s, [live('c_ab12cd', '@4', '%4'), live('c_ab12cd-2', '@5', '%5')], 0);
    mutate(s);
    expect(Object.keys(s.robots)).toEqual(['c_ab12cd']);
    expect(s.robots.c_ab12cd.second).toEqual({ cwd: '/repo', tmux: { windowId: '@5', paneId: '%5' }, unread: false });
    expect(renames).toEqual([]);
  });

  it('puts a robot whose island is gone on the recovered island, keeping all it carries', () => {
    const s = emptyState();
    s.islands.i_1 = { id: 'i_1', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: DEFAULT_SIZE, seed: 1 };
    s.robots.c_a = robot({ cell: landCells(DEFAULT_SIZE)[0] });
    s.robots.c_b = robot({ id: 'c_b', islandId: 'i_gone', note: 'halfway', agent: { kind: 'claude', sessionId: SID, transcriptPath: '/t', status: 'idle', lastActivityAt: 0 } });
    reconcile(s, [], 0).mutate(s);
    expect(s.robots.c_a.islandId).toBe('i_1');
    expect(s.robots.c_b).toMatchObject({ islandId: RECOVERED_ISLAND, note: 'halfway', revive: { command: `claude --resume ${SID}` } });
    expect(isLand(s.islands[RECOVERED_ISLAND], s.robots.c_b.cell)).toBe(true);
  });

  it('lays out again the crew of a recovered island that is gone, on ground sized for them alone', () => {
    const s = emptyState();
    s.robots.c_a = robot({ islandId: RECOVERED_ISLAND });
    s.robots.c_b = robot({ id: 'c_b', islandId: RECOVERED_ISLAND });
    reconcile(s, [], 0).mutate(s);
    const { size, cells } = crewGrid(2);
    expect(s.islands[RECOVERED_ISLAND].size).toEqual(size);
    expect([s.robots.c_a.cell, s.robots.c_b.cell]).toEqual(cells);
  });

  it('leaves a stray the recovered island has no room for unadopted, and reconciles the rest', () => {
    const s = emptyState();
    s.robots.c_a = robot({});
    // an island too large for any push to clear off the recovered island standing inside it
    s.islands.i_big = { id: 'i_big', name: 'big', description: '', instructions: '', context: [], position: { x: -100, y: -100 }, size: { w: 210, h: 210 }, seed: 1 };
    s.islands[RECOVERED_ISLAND] = { id: RECOVERED_ISLAND, name: 'recovered', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: DEFAULT_SIZE, seed: 0 };
    const { mutate, renames, unplaced } = reconcile(s, [live('c_a'), live('stray', '@4', '%4')], 0);
    mutate(s);
    expect(Object.keys(s.robots)).toEqual(['c_a']);
    expect(s.robots.c_a.tmux).toEqual({ windowId: '@1', paneId: '%1' });
    expect(unplaced[0]).toMatch(/stray window stray/);
    expect(renames).toEqual([]);
  });

  it('a window named after a robot plus -2 is its second terminal, not a stray', () => {
    const s = emptyState();
    s.robots.c_a = robot({});
    const { mutate, renames } = reconcile(s, [live('c_a'), live('c_a-2', '@2', '%2')], 1);
    expect(renames).toEqual([]);
    mutate(s);
    expect(Object.keys(s.robots)).toEqual(['c_a']);
    expect(s.robots.c_a.second).toEqual({ cwd: '/repo', tmux: { windowId: '@2', paneId: '%2' }, unread: false });
  });

  it('a live second terminal takes its pane cwd and loses the command that revived it', () => {
    const s = emptyState();
    s.robots.c_a = robot({ second: { cwd: '/old', unread: true, revive: { command: `claude --resume ${SID}` } } });
    reconcile(s, [live('c_a'), live('c_a-2', '@2', '%2')], 1).mutate(s);
    expect(s.robots.c_a.second).toEqual({ cwd: '/repo', tmux: { windowId: '@2', paneId: '%2' }, unread: true });
  });

  it('a live second terminal whose pane reports no path, as while sudo runs there, keeps the cwd it had', () => {
    const s = emptyState();
    s.robots.c_a = robot({ second: { cwd: '/side', unread: false, tmux: { windowId: '@2', paneId: '%2' } } });
    reconcile(s, [live('c_a'), { ...live('c_a-2', '@2', '%2'), path: '' }], 1).mutate(s);
    expect(s.robots.c_a.second).toEqual({ cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: false });
  });

  it('a plain second terminal whose window is gone goes with it', () => {
    const s = emptyState();
    s.robots.c_a = robot({ second: { cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: true } });
    reconcile(s, [live('c_a')], 1).mutate(s);
    expect(s.robots.c_a.second).toBeUndefined();
  });

  it('a second terminal that came in already dormant is left as it is', () => {
    const s = emptyState();
    const dormant = { cwd: '/side', unread: false, revive: { command: '' } };
    s.robots.c_a = robot({ second: { ...dormant } });
    reconcile(s, [live('c_a')], 1).mutate(s);
    expect(s.robots.c_a.second).toEqual(dormant);
  });

  it('a second terminal that ran an agent stays as a dormant record with its revive command', () => {
    const s = emptyState();
    s.robots.c_a = robot({
      second: {
        cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: true,
        agent: { kind: 'codex', sessionId: SID, status: 'idle', lastActivityAt: 0 },
      },
    });
    reconcile(s, [live('c_a')], 1).mutate(s);
    expect(s.robots.c_a.second).toEqual({
      cwd: '/side', unread: true,
      agent: { kind: 'codex', sessionId: SID, status: 'idle', lastActivityAt: 0 },
      revive: { command: `codex resume -c tui.resume_cwd=session ${SID}` },
    });
  });

  it('lets an OpenCode second terminal last seen at its shell go with its window; a Claude or Codex one, and a main terminal, stay dormant', () => {
    const agent = (kind: AgentKind) => ({ kind, sessionId: kind === 'opencode' ? OSID : SID, status: 'idle' as const, lastActivityAt: 0 });
    const gone = (kind: AgentKind) => {
      const c = robot({ tmux: { windowId: '@1', paneId: '%1' }, agent: agent(kind), second: { cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: false, agent: agent(kind) } });
      syncWindow(c, new Map(), snapshot({ ...emptyState(), robots: { c_a: c } }), { atShell: () => true });
      return c;
    };
    expect(gone('opencode').second).toBeUndefined();
    expect(gone('opencode').revive).toEqual({ command: `opencode -s ${OSID}` });
    expect(gone('claude').second?.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(gone('codex').second?.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID}` });
  });

  it('keeps the resume command of a terminal a handover has yet to start when it finds the window opened for it', () => {
    const s = emptyState();
    const agent = { kind: 'claude' as const, sessionId: SID, transcriptPath: '/t', status: 'idle' as const, lastActivityAt: 0 };
    const revive = { command: `claude --resume ${SID}` };
    s.robots.c_a = robot({ agent, revive, second: { cwd: '/s', unread: false, agent, revive } });
    s.robots.c_b = robot({ id: 'c_b', revive: { command: '' } });
    const carried = (id: string) => id === 'c_a';
    reconcile(s, [live('c_a'), live('c_a-2', '@2', '%2'), live('c_b', '@3', '%3')], 0, undefined, carried).mutate(s);
    expect(s.robots.c_a).toMatchObject({ tmux: { windowId: '@1' }, agent, revive, second: { tmux: { windowId: '@2' }, agent, revive } });
    expect(s.robots.c_b.tmux).toEqual({ windowId: '@3', paneId: '%3' });
    expect(s.robots.c_b.revive).toBeUndefined();
  });

  it('a second terminal opened since the listing was taken is left alone', () => {
    const s = emptyState();
    s.robots.c_a = robot({});
    const before = snapshot(s);
    s.robots.c_a.second = { cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    reconcile(s, [live('c_a')], 1, before).mutate(s);
    expect(s.robots.c_a.second).toEqual({ cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: false });
  });

  it('a second terminal closed since the listing was taken stays closed', () => {
    const s = emptyState();
    s.robots.c_a = robot({ second: { cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: false } });
    const before = snapshot(s);
    delete s.robots.c_a.second;
    reconcile(s, [live('c_a'), live('c_a-2', '@2', '%2')], 1, before).mutate(s);
    expect(s.robots.c_a.second).toBeUndefined();
  });

  it('leaves a main window opened or closed since the listing was taken to the store', () => {
    const s = emptyState();
    s.robots.c_a = robot({});
    s.robots.c_b = robot({ id: 'c_b', tmux: { windowId: '@2', paneId: '%2' } });
    const before = snapshot(s);
    s.robots.c_a.tmux = { windowId: '@1', paneId: '%1' };
    markDormant(s.robots.c_b);
    reconcile(s, [live('c_b', '@2', '%2')], 1, before).mutate(s);
    expect(s.robots.c_a.tmux).toEqual({ windowId: '@1', paneId: '%1' });
    expect(s.robots.c_b.tmux).toBeUndefined();
  });

  it('takes no dead window back', () => {
    const s = emptyState();
    s.robots.c_a = robot({ tmux: { windowId: '@1', paneId: '%1' }, second: { cwd: '/side', tmux: { windowId: '@2', paneId: '%2' }, unread: false } });
    reconcile(s, [{ ...live('c_a'), dead: true }, { ...live('c_a-2', '@2', '%2'), dead: true }], 1).mutate(s);
    expect(s.robots.c_a.tmux).toBeUndefined();
    expect(s.robots.c_a.second).toBeUndefined();
  });

  it('leaves the recovered island as it was when a stray cannot be placed on it', () => {
    const s = emptyState();
    s.islands[RECOVERED_ISLAND] = { id: RECOVERED_ISLAND, name: 'recovered', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: DEFAULT_SIZE, seed: 0 };
    s.robots.c_r = robot({ id: 'c_r', islandId: RECOVERED_ISLAND, cell: crewGrid(1).cells[0] });
    // an island too large for any push to clear off the recovered island as it grows
    s.islands.i_big = { id: 'i_big', name: 'big', description: '', instructions: '', context: [], position: { x: -100, y: -100 }, size: { w: 210, h: 210 }, seed: 1 };
    const { mutate, unplaced } = reconcile(s, [live('stray', '@4', '%4')], 0);
    mutate(s);
    expect(unplaced).toHaveLength(1);
    expect(s.islands[RECOVERED_ISLAND].size).toEqual(DEFAULT_SIZE);
    expect(s.robots.c_r.cell).toEqual(crewGrid(1).cells[0]);
  });

  it('placeOnIsland pushes a neighbour its growth reaches aside, never onto mission control', () => {
    const s = emptyState();
    const island = (id: string, position: Cell, size: { w: number; h: number }): Island => ({ id, name: id, description: '', instructions: '', context: [], position, size, seed: 0 });
    const three = crewGrid(3);
    s.islands.a = island('a', { x: 0, y: 0 }, three.size);
    three.cells.forEach((cell, i) => { s.robots[`c_${i}`] = robot({ id: `c_${i}`, islandId: 'a', cell }); });
    s.islands.b = island('b', { x: 0, y: 6 }, { w: 8, h: 3 });
    s.islands[HOME_ISLAND] = { ...island(HOME_ISLAND, { x: 0, y: 10 }, homeSizeFor(2)), kind: 'home', seed: HOME_SEED };
    placeOnIsland(s, 'a');
    expect(placementOk(s, s.islands.b)).toBe(true);
    expect(aboveHome(s, s.islands.b)).toBe(true);
  });

  it('placeOnIsland keeps growing while every new row touches a robot', () => {
    // every land cell taken: the first new row is all blocked, so a single grow is not enough
    const island: Island = { id: 'a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 10, h: 8 }, seed: 5 };
    const cells = landCells(island.size);
    const s = { ...emptyState(), islands: { a: island } };
    cells.forEach((cell, i) => { s.robots[`c_${i}`] = robot({ id: `c_${i}`, islandId: 'a', cell }); });
    const cell = placeOnIsland(s, 'a');
    expect(s.islands.a.size.h).toBeGreaterThan(9);
    expect(isLand(s.islands.a, cell)).toBe(true);
    const occupied = new Set(Object.values(s.robots).map((c) => cellKey(c.cell)));
    expect(occupied.has(cellKey(cell))).toBe(false);
  });

  it('placeOnIsland re-places a robot already standing there without sizing for it twice', () => {
    const island: Island = { id: 'a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 7, h: 5 }, seed: 4 };
    const s = { ...emptyState(), islands: { a: island } };
    s.robots.c_0 = robot({ id: 'c_0', islandId: 'a', cell: { x: 2, y: 2 } });
    s.robots.c_1 = robot({ id: 'c_1', islandId: 'a', cell: { x: 5, y: 2 } });
    const cell = placeOnIsland(s, 'a', 'c_1');
    expect(s.islands.a.size).toEqual(crewGrid(2).size);
    expect(isLand(s.islands.a, cell)).toBe(true);
    expect(cellKey(cell)).not.toBe(cellKey(s.robots.c_0.cell));
  });

  it('placeOnIsland grows over a folded neighbour, and a folded island comes back to take a robot, pushing it aside', () => {
    const island: Island = { id: 'a', name: 'a', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 4, h: 3 }, seed: 3 };
    const folded: Island = { ...island, id: 'o', name: 'ab', position: { x: 0, y: 4 }, size: { w: 6, h: 4 }, collapsed: true };
    const s = { ...emptyState(), islands: { a: island, o: folded } };
    landCells(island.size).forEach((cell, i) => { s.robots[`c_${i}`] = robot({ id: `c_${i}`, islandId: 'a', cell }); });
    const cell = placeOnIsland(s, 'a');
    expect(isLand(s.islands.a, cell)).toBe(true);
    expect(placementOk(s, s.islands.a)).toBe(true);
    expect(s.islands.o).toMatchObject({ position: { x: 0, y: 4 }, collapsed: true });
    placeOnIsland(s, 'o');
    expect(s.islands.o.collapsed).toBeUndefined();
    expect(s.islands.o.position).toEqual({ x: 0, y: 4 });
    expect(s.islands.a.position).not.toEqual({ x: 0, y: 0 });
    expect(placementOk(s, s.islands.a) && placementOk(s, s.islands.o)).toBe(true);
  });

  it('a robot gone dormant has no window left to be told about', () => {
    const c = robot({ hint: 'codex-silent', tmux: { windowId: '@1', paneId: '%1' } });
    markDormant(c);
    expect(c.hint).toBeUndefined();
    expect(c.tmux).toBeUndefined();
  });

  it('a robot gone dormant leaves no question open, and keeps a finished result', () => {
    const asking = robot({ tmux: { windowId: '@1', paneId: '%1' }, agent: { kind: 'claude', sessionId: SID, status: 'blocked', prompt: 'Allow?', promptId: 'p1', asking: ['a1'], lastActivityAt: 0 } });
    markDormant(asking);
    expect(asking.agent).toEqual({ kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0 });
    const done = robot({ tmux: { windowId: '@1', paneId: '%1' }, unread: true, agent: { kind: 'claude', sessionId: SID, status: 'done', prompt: 'API error', lastActivityAt: 0 } });
    markDormant(done);
    expect(done.agent).toMatchObject({ status: 'done', prompt: 'API error' });
  });

  it('reviveCommand reflects agent presence', () => {
    expect(reviveCommand(robot({}))).toBe('');
    const agent = (sessionId: string) => robot({ agent: { kind: 'claude', sessionId, transcriptPath: '/t', status: 'done', lastActivityAt: 0 } });
    expect(reviveCommand(agent(SID))).toBe(`claude --resume ${SID}`);
    // a codex robot followed into a worktree revives there, away from the directory its session began in
    expect(reviveCommand(robot({ agent: { kind: 'codex', sessionId: SID, status: 'done', lastActivityAt: 0 } }))).toBe(`codex resume -c tui.resume_cwd=session ${SID}`);
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
      s.robots[`c${n}`] = robot({ id: `c${n}`, islandId: HOME_ISLAND, cell });
    }
    expect(placed).toEqual([{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 7, y: 1 }, { x: 10, y: 1 }]);
    expect(s.islands.home.size).toEqual({ w: 14, h: 4 });
  });
  it('gives a crew member placed again its own slot back', () => {
    const s = emptyState();
    s.islands.home = home();
    s.robots.c1 = robot({ id: 'c1', islandId: HOME_ISLAND, cell: { x: 1, y: 1 } });
    s.robots.c4 = robot({ id: 'c4', islandId: HOME_ISLAND, cell: { x: 4, y: 1 } });
    expect(placeOnIsland(s, HOME_ISLAND, 'c4')).toEqual({ x: 4, y: 1 });
    expect(s.islands.home.size).toEqual(homeSizeFor(2));
  });
  it('reuses a freed slot before growing', () => {
    const s = emptyState();
    s.islands.home = home();
    s.robots.c1 = robot({ id: 'c1', islandId: HOME_ISLAND, cell: { x: 4, y: 1 } });
    expect(placeOnIsland(s, HOME_ISLAND)).toEqual({ x: 1, y: 1 });
    expect(s.islands.home.size).toEqual({ w: 8, h: 4 });
  });
});

describe('trimHome', () => {
  const home = (w: number): Island => ({ id: HOME_ISLAND, kind: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w, h: 4 }, seed: HOME_SEED });
  const crew = (xs: number[]) => {
    const s = emptyState();
    s.islands.home = home(17);
    xs.forEach((x, n) => { s.robots[`c${n}`] = robot({ id: `c${n}`, islandId: HOME_ISLAND, cell: { x, y: 1 } }); });
    return s;
  };
  it('drops the empty slots past the last crew member but one, and moves nobody', () => {
    const s = crew([1, 7]);
    // a robot on another island is no crew of home's, wherever it stands
    s.robots.far = robot({ id: 'far', islandId: 'i_1', cell: { x: 13, y: 1 } });
    trimHome(s);
    expect(s.islands.home.size).toEqual({ w: 14, h: 4 });
    expect([s.robots.c0.cell, s.robots.c1.cell]).toEqual([{ x: 1, y: 1 }, { x: 7, y: 1 }]);
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
