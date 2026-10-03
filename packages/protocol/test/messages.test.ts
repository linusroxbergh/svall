import { describe, expect, it } from 'vitest';
import {
  ACTIVATE_TIMEOUT_MS, Blocker, CLAIM_TIMEOUT_MS, COMPLETE_TIMEOUT_MS, BrowserTab, Character, ErrorFrame, FREEZE_TIMEOUT_MS, FleetConfig, FleetState, HelloReply, HelloResult, INSTRUCTIONS_MAX, MAX_MANIFEST_BYTES, MAX_REQUEST_BYTES, MAX_SIDE, MAX_URL, MachineId, PART_BYTES,
  PREFLIGHT_TIMEOUT_MS, PREPARE_TIMEOUT_MS, PROTOCOL_VERSION, RUN_TIMEOUT_MS, Request, RequestPart, TRANSFER_SCHEMA_VERSION, TerminalSlot, emptyState, methods, serverWait, type Event,
} from '../src/index.js';

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
  it('char.update keeps a character on this machine or lets it go, and a character says which', () => {
    expect(methods['char.update'].params.parse({ id: 'c', keepHere: true })).toEqual({ id: 'c', keepHere: true });
    expect(methods['char.update'].params.parse({ id: 'c', keepHere: false })).toEqual({ id: 'c', keepHere: false });
    const c = { id: 'c_1', islandId: 'home', cell: { x: 1, y: 1 }, name: 'n', portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false };
    expect(Character.parse({ ...c, keepHere: true }).keepHere).toBe(true);
    expect(Character.parse(c).keepHere).toBeUndefined();
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
  it('a character may carry a second terminal, live or dormant', () => {
    const second = { cwd: '/tmp', tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    expect(TerminalSlot.parse(second)).toEqual(second);
    const dormant = { cwd: '/tmp', unread: false, revive: { command: 'codex resume s' } };
    expect(TerminalSlot.parse(dormant)).toEqual(dormant);
    expect(() => TerminalSlot.parse({ unread: false })).toThrow();
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
  it('is 19 with ownership and handover', () => {
    expect(PROTOCOL_VERSION).toBe(19);
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

const UUID_A = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const UUID_B = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
const DIGEST = 'b'.repeat(64);
const MACHINES = {
  source: { home: '/Users/linus' },
  destination: {
    info: {
      machineId: UUID_B, release: '0.9.0', protocol: PROTOCOL_VERSION, stateSchema: 8, transferSchema: TRANSFER_SCHEMA_VERSION,
      platform: 'linux', arch: 'x64', agentAdapters: [{ kind: 'claude', version: '2.1.280', adapter: 1, home: '/Users/linus/.claude', loggedIn: true, hooks: true }],
    },
    home: '/Users/linus',
    fleetHome: '/Users/linus/.svall',
  },
};
const MANIFEST = {
  version: TRANSFER_SCHEMA_VERSION, transactionId: 't1', generation: 4, fromMachineId: UUID_A, toMachineId: UUID_B, home: '/Users/linus',
  fleet: FleetConfig.parse({ id: UUID_A }), snapshot: emptyState(), excludes: [],
  roots: [{ id: 'r_1', kind: 'cwd', entry: 'dir', path: '/Users/linus/p', files: [] }],
  sessions: [],
};

// every event name the union carries; the compiler refuses a missing or a stray one
const EVENT_NAMES = {
  'state.patch': true, 'term.output': true, 'term.resync': true, 'repo.changed': true, 'mobile.phones': true,
  'ownership.changed': true, 'handover.changed': true, 'handover.entity': true,
} satisfies Record<Event['event'], true>;

describe('ownership and handover methods', () => {
  const HANDOVER_METHODS = [
    'system.info', 'ownership.get', 'handover.preflight', 'handover.inspect', 'handover.freeze', 'handover.claim', 'handover.prepare', 'handover.activate',
    'handover.complete', 'handover.abort', 'handover.status', 'handover.reaches',
  ] as const;

  it('takes empty params and answers every handover call', () => {
    for (const method of HANDOVER_METHODS) expect(methods[method]).toBeDefined();
    expect(methods['system.info'].params.parse({})).toEqual({});
    expect(methods['ownership.get'].params.parse({})).toEqual({});
    expect(methods['handover.status'].params.parse({})).toEqual({});
  });

  it('says what a machine is and what it can run', () => {
    const info = {
      machineId: UUID_A, release: '0.9.0', protocol: PROTOCOL_VERSION, stateSchema: 8, transferSchema: TRANSFER_SCHEMA_VERSION,
      platform: 'darwin', arch: 'arm64',
      agentAdapters: [{ kind: 'claude', version: '2.0.1', adapter: 1, home: '/Users/linus/.claude', loggedIn: true, hooks: false }, { kind: 'codex', adapter: 1 }],
    };
    expect(methods['system.info'].result.parse(info)).toEqual(info);
    expect(() => methods['system.info'].result.parse({ ...info, platform: 'windows' })).toThrow();
  });

  it('says who owns the fleet and whether it is frozen', () => {
    const owned = { fleetId: UUID_A, generation: 4, ownerMachineId: UUID_B, frozen: false };
    expect(methods['ownership.get'].result.parse(owned)).toEqual(owned);
    const transaction = { id: 't1', fromMachineId: UUID_B, toMachineId: UUID_A, phase: 'preparing', startedAt: 17 };
    expect(methods['ownership.get'].result.parse({ ...owned, frozen: true, transaction }).transaction).toEqual(transaction);
    expect(() => methods['ownership.get'].result.parse({ ...owned, generation: -1 })).toThrow();
    expect(() => methods['ownership.get'].result.parse({ ...owned, generation: 1.5 })).toThrow();
    expect(() => methods['ownership.get'].result.parse({ ...owned, ownerMachineId: 'trift' })).toThrow();
  });

  it('counts the transfer and lists what stops it, from the machines the controller describes', () => {
    expect(methods['handover.preflight'].params.parse({ toMachineId: UUID_B, ...MACHINES })).toEqual({ toMachineId: UUID_B, choices: {}, ...MACHINES });
    expect(methods['handover.preflight'].params.parse({ toMachineId: UUID_B, choices: { terminateShells: true }, ...MACHINES }).choices).toEqual({ terminateShells: true });
    expect(() => methods['handover.preflight'].params.parse({ toMachineId: 'trift', ...MACHINES })).toThrow();
    // a daemon knows neither machine's home from the registry, nor the far machine's fleet home and agents
    expect(() => methods['handover.preflight'].params.parse({ toMachineId: UUID_B })).toThrow();
    expect(() => methods['handover.preflight'].params.parse({ toMachineId: UUID_B, ...MACHINES, destination: { ...MACHINES.destination, fleetHome: 'svall' } })).toThrow();
    expect(() => methods['handover.preflight'].params.parse({ toMachineId: UUID_B, ...MACHINES, source: { home: '~' } })).toThrow();
    const result = {
      manifestSummary: { digest: DIGEST, roots: 2, files: 10, bytes: 2048, sessions: 1 },
      blockers: [{ code: 'shell_busy', message: 'vite is still running', entity: { kind: 'character', id: 'c_1' } }],
      warnings: [{ code: 'platform_heuristic', message: 'an Xcode project' }],
      manifest: { ...MANIFEST, transactionId: undefined },
    };
    const { transactionId: _t, ...preflight } = MANIFEST;
    expect(methods['handover.preflight'].result.parse({ ...result, manifest: preflight })).toEqual({ ...result, manifest: preflight });
    // the controller composes the destination's checks from the manifest preflight built
    expect(() => methods['handover.preflight'].result.parse({ ...result, manifest: undefined })).toThrow();
  });

  it('reads the destination\'s roots before a handover, claims them for one, and completes it on each side', () => {
    const roots = [{ id: 'r_1', kind: 'gitdir', entry: 'dir', path: '/Users/linus/p.git' }];
    const inspect = { roots, excludes: ['node_modules/'], folders: ['/Users/linus', '/Volumes/work'] };
    expect(methods['handover.inspect'].params.parse(inspect)).toEqual(inspect);
    const files = [{ type: 'file', path: 'HEAD', mode: 0o644, size: 23, mtimeMs: 0, sha256: DIGEST }];
    expect(methods['handover.inspect'].params.parse({ ...inspect, roots: [{ ...roots[0], files }] }).roots[0].files).toEqual(files);
    expect(() => methods['handover.inspect'].params.parse({ ...inspect, roots: [{ ...roots[0], kind: 'folder' }] })).toThrow();
    expect(() => methods['handover.inspect'].params.parse({ ...inspect, folders: ['work'] })).toThrow();
    const probe = { exists: true, writable: true, caseInsensitive: false, freeBytes: 4096 };
    const inspected = {
      roots: [
        { id: 'r_1', check: { ok: true, path: '/Users/linus/p.git', kind: 'replica' } },
        { id: 'r_2', check: { ok: false, path: '/Users/linus/q', blocker: { code: 'destination_diverged', message: 'q changed', entity: { kind: 'root', id: 'r_2' } } } },
      ],
      folders: { '/Users/linus': probe },
    };
    expect(methods['handover.inspect'].result.parse(inspected)).toEqual(inspected);

    const claim = { transactionId: 't1', generation: 5, manifest: MANIFEST, manifestDigest: DIGEST };
    expect(methods['handover.claim'].params.parse(claim)).toEqual(claim);
    expect(methods['handover.claim'].params.parse({ ...claim, archive: ['r_1'] }).archive).toEqual(['r_1']);
    expect(methods['handover.claim'].params.parse({ ...claim, landed: [{ id: 'r_1', files: [] }] }).landed).toEqual([{ id: 'r_1', files: [] }]);
    const { transactionId: _t, ...preflight } = MANIFEST;
    expect(() => methods['handover.claim'].params.parse({ ...claim, manifest: preflight })).toThrow();
    const claimed = { roots: [{ id: 'r_1', excludes: ['node_modules/'], check: { ok: true, path: '/home/linus/p', kind: 'absent' }, archivedTo: '/home/linus/p.archived-x' }] };
    expect(methods['handover.claim'].result.parse(claimed)).toEqual(claimed);
    expect(() => methods['handover.claim'].result.parse({ roots: [{ id: 'r_1', check: claimed.roots[0].check }] })).toThrow();

    const landed = [{ id: 'r_1', files: [] }];
    expect(methods['handover.complete'].params.parse({ transactionId: 't1', generation: 5 })).toEqual({ transactionId: 't1', generation: 5 });
    expect(methods['handover.complete'].params.parse({ transactionId: 't1', generation: 4, landed }).landed).toEqual(landed);
    expect(methods['handover.complete'].result.parse({})).toEqual({});
  });

  it('says which git a machine runs, when it has one', () => {
    const info = { ...MACHINES.destination.info, git: '2.43.0' };
    expect(methods['system.info'].result.parse(info).git).toBe('2.43.0');
    expect(methods['system.info'].result.parse(MACHINES.destination.info).git).toBeUndefined();
  });

  it('freezes against a transaction and a generation and returns the manifest that names it', () => {
    const params = methods['handover.freeze'].params.parse({ transactionId: 't1', generation: 4, choices: { interruptAfterMs: 30_000, terminateShells: ['c_1'] }, ...MACHINES });
    expect(params.choices.terminateShells).toEqual(['c_1']);
    expect(params.destination.info.machineId).toBe(UUID_B);
    expect(methods['handover.freeze'].params.parse({ transactionId: 't1', generation: 4, ...MACHINES }).choices).toEqual({});
    expect(() => methods['handover.freeze'].params.parse({ transactionId: 't1', generation: 4 })).toThrow();
    expect(() => methods['handover.freeze'].params.parse({ transactionId: '', generation: 4, ...MACHINES })).toThrow();
    expect(() => methods['handover.freeze'].params.parse({ transactionId: 't1', generation: -1, ...MACHINES })).toThrow();
    expect(methods['handover.freeze'].result.parse({ manifest: MANIFEST }).manifest).toEqual(MANIFEST);
    // a preflight's manifest names no transaction, and is no freeze's answer
    const { transactionId: _t, ...preflight } = MANIFEST;
    expect(() => methods['handover.freeze'].result.parse({ manifest: preflight })).toThrow();
  });

  it('prepares from the manifest its digest names and what the transfer verified in each root, and answers the proof ready takes', () => {
    const landed = [{ id: 'r_1', files: [{ type: 'file', path: 'a.txt', mode: 0o644, size: 1, mtimeMs: 0, sha256: DIGEST }] }];
    const params = { transactionId: 't1', generation: 5, manifest: MANIFEST, manifestDigest: DIGEST, landed };
    expect(methods['handover.prepare'].params.parse(params)).toEqual(params);
    // a relay secret belongs to the phone gateway of a later version, and no prepare carries one
    expect(methods['handover.prepare'].params.parse({ ...params, relaySecret: 's3cret' })).toEqual(params);
    expect(methods['handover.prepare'].result.parse({ preparedDigest: DIGEST })).toEqual({ preparedDigest: DIGEST });
    expect(() => methods['handover.prepare'].result.parse({})).toThrow();
    expect(() => methods['handover.prepare'].params.parse({ ...params, manifestDigest: 'abc' })).toThrow();
    expect(() => methods['handover.prepare'].params.parse({ ...params, manifest: { ...MANIFEST, snapshot: { version: 6, islands: {}, characters: {} } } })).toThrow();
    // a preflight's manifest names no transaction, and nothing can be prepared from it
    const { transactionId: _t, ...preflight } = MANIFEST;
    expect(() => methods['handover.prepare'].params.parse({ ...params, manifest: preflight })).toThrow();
    expect(() => methods['handover.prepare'].params.parse({ ...params, landed: undefined })).toThrow();
  });

  it('reports every character activation, failures included', () => {
    const result = { characters: [{ id: 'c_1', ok: true }, { id: 'c_2', ok: false, error: 'tmux refused' }] };
    expect(methods['handover.activate'].result.parse(result)).toEqual(result);
    expect(methods['handover.activate'].params.parse({ transactionId: 't1', generation: 5 })).toEqual({ transactionId: 't1', generation: 5 });
    expect(methods['handover.abort'].params.parse({ transactionId: 't1', generation: 4 })).toEqual({ transactionId: 't1', generation: 4 });
    expect(methods['handover.abort'].result.parse({})).toEqual({});
  });

  it('rebuilds status from the journals: the open transaction, or where a journal it could not read went', () => {
    const status = { transaction: { id: 't1', fromMachineId: UUID_B, toMachineId: UUID_A, phase: 'transfer', startedAt: 17 } };
    expect(methods['handover.status'].result.parse(status)).toEqual(status);
    expect(methods['handover.status'].result.parse({ characters: [], roots: [] })).toEqual({});
    expect(methods['handover.status'].result.parse({ quarantined: '/h/journal.json.broken-1' })).toEqual({ quarantined: '/h/journal.json.broken-1' });
    expect(() => methods['handover.status'].result.parse({ transaction: { ...status.transaction, phase: 'rsyncing' } })).toThrow();
  });

  it('gives every call that hashes, rests or starts a fleet a budget of its own, and nothing else', () => {
    expect(serverWait('handover.preflight', {})).toBe(PREFLIGHT_TIMEOUT_MS);
    expect(serverWait('handover.inspect', {})).toBe(PREFLIGHT_TIMEOUT_MS);
    expect(serverWait('handover.freeze', {})).toBe(FREEZE_TIMEOUT_MS);
    // an interrupt chosen for later than the rest would wait extends the rest, and the freeze's budget with it
    expect(serverWait('handover.freeze', { choices: { interruptAfterMs: 20 * 60_000 } })).toBe(FREEZE_TIMEOUT_MS + 20 * 60_000);
    expect(serverWait('handover.claim', {})).toBe(CLAIM_TIMEOUT_MS);
    expect(serverWait('handover.prepare', {})).toBe(PREPARE_TIMEOUT_MS);
    expect(serverWait('handover.activate', {})).toBe(ACTIVATE_TIMEOUT_MS);
    expect(serverWait('handover.complete', {})).toBe(COMPLETE_TIMEOUT_MS);
    // a freeze may wait out a three-minute rest, ask the gateway over ssh and hash the fleet twice
    expect(FREEZE_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
    for (const method of ['system.info', 'ownership.get', 'handover.abort', 'handover.status'] as const) {
      expect(serverWait(method, {})).toBe(0);
    }
  });

  it('sends a request too large for one socket message as parts of it, in order', () => {
    const part = { part: { id: 3, index: 0, count: 2, data: Buffer.from('{"id":3').toString('base64') } };
    expect(RequestPart.parse(part)).toEqual(part);
    expect(() => RequestPart.parse({ part: { ...part.part, index: -1 } })).toThrow();
    expect(() => RequestPart.parse({ part: { ...part.part, count: 0 } })).toThrow();
    expect(Request.safeParse(part).success).toBe(false);
    // a part in base64 stays under the daemon's 8 MiB message cap
    expect(Math.ceil(PART_BYTES / 3) * 4 + 200).toBeLessThan(8 * 1024 * 1024);
  });

  it('caps a manifest at half a request: prepare carries it, and its carried roots\' files again as what landed', () => {
    expect(2 * MAX_MANIFEST_BYTES).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  });
});

describe('handover events', () => {
  it('carries ids, phases and counts, never a manifest', () => {
    const events: Event[] = [
      { event: 'ownership.changed', data: { generation: 5, ownerMachineId: MachineId.parse(UUID_B) } },
      { event: 'handover.changed', data: { transactionId: 't1', phase: 'commit' } },
      { event: 'handover.entity', data: { transactionId: 't1', kind: 'root', id: 'r_1', phase: 'transfer', done: 1, total: 2 } },
    ];
    expect(events.map((e) => e.event)).toEqual(['ownership.changed', 'handover.changed', 'handover.entity']);
    expect(Object.keys(EVENT_NAMES)).toEqual(['state.patch', 'term.output', 'term.resync', 'repo.changed', 'mobile.phones', 'ownership.changed', 'handover.changed', 'handover.entity']);
  });
});

describe('handshake', () => {
  it("reads a hello reply as the daemon's protocol version", () => {
    expect(HelloResult.parse({ ok: true, protocol: PROTOCOL_VERSION })).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
    expect(HelloResult.parse({ ok: true, protocol: PROTOCOL_VERSION, capabilities: ['handover'] })).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
    expect(() => HelloResult.parse({ ok: false, protocol: PROTOCOL_VERSION })).toThrow();
    expect(() => HelloResult.parse({ ok: true, protocol: '10' })).toThrow();
  });
});

describe('error frame', () => {
  it('carries a code, a message and the structured rest', () => {
    expect(ErrorFrame.parse({ code: 'not_found', message: 'no such character' }).data).toBeUndefined();
    const blocked = ErrorFrame.parse({ code: 'blocked', message: 'one blocker', data: { blockers: [{ code: 'shell_busy', message: 'vite' }] } });
    expect(Blocker.array().parse(blocked.data?.blockers)).toHaveLength(1);
    expect(() => ErrorFrame.parse({ code: 'blocked', message: 'x', data: 'blockers' })).toThrow();
  });
});
