import { describe, expect, it } from 'vitest';
import { BrowserTab, emptyState, FleetState, HelloReply, INSTRUCTIONS_MAX, MAX_SIDE, MAX_URL, PROTOCOL_VERSION, RUN_TIMEOUT_MS, Request, Second, methods, serverWait } from '../src/index.js';

describe('serverWait', () => {
  it('extends the deadline for the calls the daemon holds open', () => {
    expect(serverWait('state.get', {})).toBe(0);
    expect(serverWait('char.wait', { id: 'c', until: ['idle'] })).toBe(600_000);
    expect(serverWait('char.wait', { id: 'c', until: ['idle'], timeoutMs: 5_000 })).toBe(5_000);
    expect(serverWait('char.create', { islandId: 'home', cwd: '/tmp' })).toBe(0);
    expect(serverWait('char.create', { islandId: 'home', cwd: '/tmp', command: 'claude', run: 'hi' })).toBe(RUN_TIMEOUT_MS);
  });
});

describe('messages', () => {
  it('parses a request envelope', () => {
    expect(Request.parse({ id: 1, method: 'state.get' })).toEqual({ id: 1, method: 'state.get' });
  });
  it('applies defaults to char.run params', () => {
    expect(methods['char.run'].params.parse({ id: 'c_1', text: 'ls' })).toEqual({ id: 'c_1', text: 'ls', enter: true });
  });
  it('rejects char.read with an unknown source', () => {
    expect(() => methods['char.read'].params.parse({ id: 'c_1', source: 'brain' })).toThrow();
  });
  it('term.attach takes an id and returns how to attach', () => {
    expect(methods['term.attach'].params.parse({ id: 'c_a' })).toEqual({ id: 'c_a' });
    expect(methods['term.attach'].result.parse({ socket: '/tmp/x/tmux.sock', session: 'v-c_a' }).session).toBe('v-c_a');
  });
  it('char.move takes an island and a cell', () => {
    expect(methods['char.move'].params.parse({ id: 'c', islandId: 'i', cell: { x: 1, y: 2 } })).toEqual({ id: 'c', islandId: 'i', cell: { x: 1, y: 2 } });
  });
  it('char.update strips unknown keys like slot rather than refusing them', () => {
    expect(methods['char.update'].params.parse({ id: 'c', slot: 1 })).toEqual({ id: 'c' });
  });
  it('island.create refuses a size below 4x3', () => {
    expect(() => methods['island.create'].params.parse({ name: 'x', size: { w: 3, h: 3 } })).toThrow();
  });
  // an island's ground is built cell by cell, so one asked for at 20000x20000 runs the daemon out of memory
  it('refuses to make or grow an island past the cap, while a state holding a larger one still loads', () => {
    for (const size of [{ w: MAX_SIDE + 1, h: 5 }, { w: 7, h: MAX_SIDE + 1 }, { w: 20000, h: 20000 }]) {
      expect(methods['island.create'].params.safeParse({ name: 'x', size }).success).toBe(false);
      expect(methods['island.update'].params.safeParse({ id: 'i', size }).success).toBe(false);
    }
    expect(methods['island.update'].params.parse({ id: 'i', size: { w: MAX_SIDE, h: MAX_SIDE } }).size).toEqual({ w: MAX_SIDE, h: MAX_SIDE });
    const island = { id: 'i', name: 'x', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 1000, h: 1000 }, seed: 1 };
    expect(FleetState.safeParse({ version: 8, islands: { i: island }, characters: {} }).success).toBe(true);
  });
  // arranging for a window of no width at all would push every island out to Infinity, which the state cannot hold
  it('arranges for the shape of a real window, and refuses one of no width or no height', () => {
    for (const aspect of [390 / 844, 16 / 9, 3440 / 1440]) expect(methods['island.arrange'].params.safeParse({ aspect }).success).toBe(true);
    for (const aspect of [5e-324, 1e-6, 1e6, Infinity]) expect(methods['island.arrange'].params.safeParse({ aspect }).success).toBe(false);
  });
  // the brief would cut them short, so the user hears of it when saving rather than the agent never seeing the rest
  it('refuses instructions past the length the brief carries, while a state holding longer ones still loads', () => {
    const long = 'x'.repeat(INSTRUCTIONS_MAX + 1);
    expect(methods['island.create'].params.safeParse({ name: 'x', instructions: long }).success).toBe(false);
    expect(methods['island.update'].params.safeParse({ id: 'i', instructions: long }).success).toBe(false);
    expect(methods['char.update'].params.safeParse({ id: 'c', instructions: long }).success).toBe(false);
    expect(methods['char.update'].params.safeParse({ id: 'c', instructions: long.slice(1) }).success).toBe(true);
    const island = { id: 'i', name: 'x', description: '', instructions: long, context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1 };
    expect(FleetState.safeParse({ version: 8, islands: { i: island }, characters: {} }).success).toBe(true);
  });
  // past 2^31-1 ms a timer fires at once, so a wait that long would answer timeout straight away
  it('waits a whole number of milliseconds a timer can hold', () => {
    const wait = (timeoutMs: number) => methods['char.wait'].params.safeParse({ id: 'c', until: ['idle'], timeoutMs }).success;
    expect([0, 5_000, 2_000_000_000].map(wait)).toEqual([true, true, true]);
    expect([-1, 1.5, 2 ** 31, Infinity].map(wait)).toEqual([false, false, false, false]);
  });
  it('reads the handshake reply a daemon admits a socket with', () => {
    expect(HelloReply.safeParse({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }).success).toBe(true);
    expect(HelloReply.safeParse({ id: 0, result: { ok: true } }).success).toBe(false);
    expect(HelloReply.safeParse({ id: 3, result: {} }).success).toBe(false);
  });
  it('takes the long urls pages keep, refuses one past the cap, and still loads a state holding a longer one', () => {
    const long = `https://a.test/#${'x'.repeat(MAX_URL)}`;
    expect(methods['browser.open'].params.safeParse({ id: 'c', url: long }).success).toBe(false);
    expect(methods['browser.update'].params.safeParse({ id: 'c', tab: 't_1', url: long }).success).toBe(false);
    expect(methods['browser.update'].params.safeParse({ id: 'c', tab: 't_1', url: long.slice(0, MAX_URL) }).success).toBe(true);
    // a playground keeps its whole source in the fragment
    const playground = `https://www.typescriptlang.org/play#code/${'A'.repeat(64 * 1024)}`;
    expect(methods['browser.open'].params.safeParse({ id: 'c', url: playground }).success).toBe(true);
    expect(methods['browser.update'].params.safeParse({ id: 'c', tab: 't_1', url: playground }).success).toBe(true);
    expect(BrowserTab.safeParse({ id: 't_1', url: long, title: '' }).success).toBe(true);
  });
  it('names the browser methods', () => {
    expect(methods['browser.open'].params.parse({ id: 'c', url: 'https://a.test' })).toEqual({ id: 'c', url: 'https://a.test' });
    expect(methods['browser.open'].params.parse({ id: 'c', url: 'https://a.test', tab: 't_12345678' }).tab).toBe('t_12345678');
    expect(() => methods['browser.open'].params.parse({ id: 'c', url: 'https://a.test', tab: '' })).toThrow();
    expect(methods['browser.update'].params.parse({ id: 'c', tab: 't_1', title: 'T' })).toEqual({ id: 'c', tab: 't_1', title: 'T' });
    expect(Object.keys(methods)).toEqual(expect.arrayContaining(['browser.open', 'browser.close', 'browser.activate', 'browser.update']));
  });

  it('fs and repo methods take a character id and a root-relative path', () => {
    expect(methods['fs.list'].params.parse({ id: 'c_1', path: '' })).toEqual({ id: 'c_1', path: '' });
    expect(methods['fs.read'].result.parse({ text: 'x', mtimeMs: 1.5, root: '/r' })).toEqual({ text: 'x', mtimeMs: 1.5, root: '/r' });
    expect(methods['fs.write'].params.parse({ id: 'c_1', path: 'a.ts', text: '', mtimeMs: 2 }).mtimeMs).toBe(2);
    expect(methods['fs.write'].result.parse({ mtimeMs: 3, conflict: true })).toEqual({ mtimeMs: 3, conflict: true });
    expect(methods['repo.status'].params.parse({ id: 'c_1' })).toEqual({ id: 'c_1', base: 'head' });
    expect(() => methods['repo.status'].params.parse({ id: 'c_1', base: 'trunk' })).toThrow();
    expect(methods['repo.status'].result.parse({ branch: 'main', files: [{ path: 'b', status: 'R', from: 'a' }] }).files[0].from).toBe('a');
    expect(methods['repo.file'].params.parse({ id: 'c_1', path: 'b', base: 'main', from: 'a' }).from).toBe('a');
    expect(methods['repo.file'].result.parse({ binary: true })).toEqual({ binary: true });
    expect(methods['repo.watch'].params.parse({ id: 'c_1' })).toEqual({ id: 'c_1' });
    expect(methods['repo.unwatch'].result.parse({})).toEqual({});
  });
  it('takes term 2 on the calls that reach a terminal, and nothing else', () => {
    expect(methods['char.run'].params.parse({ id: 'c_1', text: 'ls', term: 2 })).toEqual({ id: 'c_1', text: 'ls', enter: true, term: 2 });
    expect(methods['char.read'].params.parse({ id: 'c_1', term: 2 })).toMatchObject({ term: 2 });
    expect(methods['char.wait'].params.parse({ id: 'c_1', until: ['idle'], term: 2 })).toMatchObject({ term: 2 });
    expect(methods['term.attach'].params.parse({ id: 'c_1', term: 2 })).toEqual({ id: 'c_1', term: 2 });
    expect(() => methods['char.run'].params.parse({ id: 'c_1', text: 'ls', term: 1 })).toThrow();
    expect(() => methods['char.run'].params.parse({ id: 'c_1', text: 'ls', term: 3 })).toThrow();
  });
  it('char.second takes an id', () => {
    expect(methods['char.second'].params.parse({ id: 'c_1' })).toEqual({ id: 'c_1' });
  });
  it('a character may carry a second terminal', () => {
    const second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    expect(Second.parse(second)).toEqual(second);
    expect(() => Second.parse({ unread: false })).toThrow();
  });
});

describe('char.create run', () => {
  it('accepts run and reports runSent', () => {
    const p = methods['char.create'].params.parse({ islandId: 'home', cwd: '/tmp', command: 'claude', run: '/svall-organise' });
    expect(p.run).toBe('/svall-organise');
    const c = { id: 'c_1', islandId: 'home', cell: { x: 1, y: 1 }, name: 'organise', portrait: 'owl', description: '', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false };
    expect(methods['char.create'].result.parse({ ...c, runSent: false }).runSent).toBe(false);
    expect(methods['char.create'].result.parse(c).runSent).toBeUndefined();
  });
});

describe('term.input', () => {
  it('takes the bytes base64-encoded, not as raw text', () => {
    expect(methods['term.input'].params.parse({ id: 'c_1', data: 'ZWNobyBoaQo=' }).data).toBe('ZWNobyBoaQo=');
    expect(() => methods['term.input'].params.parse({ id: 'c_1', data: 'echo hi\n' })).toThrow();
  });
});

describe('protocol version', () => {
  it('is 20 with characters starred', () => {
    expect(PROTOCOL_VERSION).toBe(20);
    expect(methods['char.star'].params.safeParse({ id: 'c_a' }).success).toBe(true);
    expect(methods['char.star'].params.safeParse({ id: 'c_a', targetId: 'c_b', after: true }).success).toBe(true);
    expect(methods['char.unstar'].params.safeParse({ id: 'c_a' }).success).toBe(true);
    const c = { id: 'c_1', islandId: 'home', cell: { x: 1, y: 1 }, name: 'n', portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false };
    expect(methods['char.star'].result.parse({ ...c, star: 0 }).star).toBe(0);
  });

  it('was 19 with OpenCode as an agent kind', () => {
    expect(methods['mainAgent.set'].params.safeParse({ agent: 'opencode' }).success).toBe(true);
  });

  it('was 18 with shelf rows set aside and put back', () => {
    expect(methods['resources.delete'].params.safeParse({ id: 'r:/u/.claude', path: 'skills/tidy' }).success).toBe(true);
    expect(methods['resources.delete'].result.safeParse({ token: 't' }).success).toBe(true);
    expect(methods['resources.restore'].params.safeParse({ token: 't' }).success).toBe(true);
  });

  it('was 17 with fleets listed, started and named from the app', () => {
    expect(methods['fleets.list'].result.safeParse({ fleets: [{ home: '/u/.svall', name: 'private', current: true, running: true, windowOpen: true }] }).success).toBe(true);
    expect(methods['fleets.create'].params.safeParse({ name: 'work' }).success).toBe(true);
    expect(methods['fleets.start'].params.safeParse({ home: '/u/.svall-work' }).success).toBe(true);
    expect(methods['fleet.rename'].params.safeParse({ name: 'home' }).success).toBe(true);
    expect(FleetState.parse({ ...emptyState(), name: 'home' }).name).toBe('home');
    expect(serverWait('fleets.create', { name: 'work' })).toBeGreaterThan(15_000);
    expect(serverWait('fleets.start', { home: '/u/.svall-work' })).toBeGreaterThan(15_000);
  });

  it('was 16 with islands reordered from the sidebar', () => {
    expect(methods['island.reorder'].params.safeParse({ id: 'i_a', targetId: 'i_b', after: true }).success).toBe(true);
    expect(methods['island.reorder'].params.safeParse({ id: 'i_a', targetId: 'i_b' }).success).toBe(false);
    expect(methods['mainAgent.set'].params.safeParse({ agent: 'codex' }).success).toBe(true);
    expect(methods['mainAgent.set'].params.safeParse({ agent: 'gemini' }).success).toBe(false);
  });
});
