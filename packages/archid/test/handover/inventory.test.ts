import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z, type ZodTypeAny } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Character, emptyState, FleetConfig, FleetState, MachineRecord, NodeConfig, TransferManifestV1,
  type Blocker, type FleetState as State, type GitCheckout, type GitGraph, type MachineId, type Warning,
} from '@archipelago/protocol';
import { discoverGit } from '../../src/handover/git-graph.js';
import { buildInventory, DEFAULT_EXCLUDES, excludeMatcher, expandExcludes, rootMatcher, type MachineMaps } from '../../src/handover/inventory.js';
import { exportSnapshot, NOT_PATHS, PATH_FIELDS, portablePathValues } from '../../src/handover/portable-path.js';
import { git, hasGit } from './git-fixture.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/archi-t-'); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });

// the schemas a handover reads, writes or carries: the fleet's state and configs, and the manifest itself
const CLASSIFIED: Record<string, ZodTypeAny> = { FleetState, FleetConfig, NodeConfig, MachineRecord, TransferManifestV1 };

// every free string a schema holds, named the way the registry names it: `*` a record's values, `[]` an array's items.
// a refine and a brand keep the schema they are on, so neither needs a case of its own
function stringFields(schema: z.core.$ZodType, name: string, out: string[] = []): string[] {
  const d = (schema as z.core.$ZodTypes)._zod.def;
  switch (d.type) {
    case 'string': out.push(name); break;
    case 'object':
      for (const [k, v] of Object.entries(d.shape)) {
        // a schema classified on its own is walked under its own name
        if (!Object.values(CLASSIFIED).includes(v as ZodTypeAny)) stringFields(v, `${name}.${k}`, out);
      }
      break;
    case 'record': stringFields(d.valueType, `${name}.*`, out); break;
    case 'array': stringFields(d.element, `${name}[]`, out); break;
    case 'optional': case 'nullable': case 'default': case 'prefault': stringFields(d.innerType, name, out); break;
    case 'union': for (const o of d.options) stringFields(o, name, out); break;
    case 'literal': case 'enum': case 'number': case 'boolean': break;
    default: throw new Error(`${name}: the walk does not know ${d.type}`);
  }
  return out;
}

const prefixes = (field: string): string[] => field.split('.').map((_, i, all) => all.slice(0, i + 1).join('.'));
const classified = (field: string): boolean => prefixes(field).some((p) => p in PATH_FIELDS || NOT_PATHS.includes(p));
const unclassified = (schemas: Record<string, ZodTypeAny>): string[] =>
  [...new Set(Object.entries(schemas).flatMap(([n, s]) => stringFields(s, n)))].filter((f) => !classified(f));

describe('path classification', () => {
  it('classifies every string field a handover reads, writes or carries', () => {
    expect(unclassified(CLASSIFIED)).toEqual([]);
  });

  it('fails on a path field nobody classified', () => {
    const Future = FleetState.extend({ characters: z.record(z.string(), Character.extend({ scratchDir: z.string() })) });
    expect(unclassified({ ...CLASSIFIED, FleetState: Future })).toEqual(['FleetState.characters.*.scratchDir']);
  });

  it('names no field the schemas no longer have', () => {
    const fields = Object.entries(CLASSIFIED).flatMap(([n, s]) => stringFields(s, n));
    const stale = [...Object.keys(PATH_FIELDS), ...NOT_PATHS].filter((k) => !fields.some((f) => prefixes(f).includes(k)));
    expect(stale).toEqual([]);
  });

  it('reads a context ref as a path only for a file or folder, and a browser url only when it is file:', () => {
    const state = emptyState();
    state.characters.c1 = char('c1', {
      cwd: '/Users/linus/p',
      context: [
        { kind: 'file', ref: '/Users/linus/notes.md', label: '', source: 'manual' },
        { kind: 'github', ref: 'https://github.com/a/b', label: '', source: 'auto' },
      ],
      browser: { tabs: [{ id: 't1', url: 'file:///Users/linus/p/a%20b.html', title: '' }, { id: 't2', url: 'https://x.test/', title: '' }] },
    });
    const values = portablePathValues({ FleetState: state, FleetConfig: FLEET }, '/Users/linus');
    expect(values.map((v) => [v.field, v.path]).sort()).toEqual([
      ['FleetConfig.defaultCwd', '/Users/linus'],
      ['FleetConfig.home.cwd', '/Users/linus/.archipelago/home'],
      ['FleetState.characters.*.browser.tabs[].url', '/Users/linus/p/a b.html'],
      ['FleetState.characters.*.context[].ref', '/Users/linus/notes.md'],
      ['FleetState.characters.*.cwd', '/Users/linus/p'],
      ['FleetState.defaultCwd', '/Users/linus'],
      ['FleetState.home.cwd', '/Users/linus/.archipelago/home'],
    ]);
  });

  it('strips every forbidden field from the state that leaves the machine, and nothing else', () => {
    const state = emptyState();
    const tmux = { windowId: '@1', paneId: '%1' };
    state.characters.c1 = char('c1', { tmux, panePath: '/Users/linus/p', second: { cwd: '/x', tmux, unread: false } });
    const exported = exportSnapshot(state);
    expect(exported.characters.c1.tmux).toBeUndefined();
    expect(exported.characters.c1.panePath).toBeUndefined();
    expect(exported.characters.c1.second).toEqual({ cwd: '/x', unread: false });
    expect(state.characters.c1.tmux).toEqual(tmux);
    expect(FleetState.parse(exported)).toEqual(exported);
  });
});

describe('excludes', () => {
  it('adds the fleet own patterns to the defaults, once each and in order', () => {
    const r = expandExcludes({ enabled: true, exclude: ['*.log', 'dist/', '/scratch/'], excludeDefaults: true, transferFleetEnv: false });
    expect(r.excludes).toEqual([...DEFAULT_EXCLUDES, '*.log', '/scratch/']);
    expect(r.blockers).toEqual([]);
  });

  it('replaces the defaults only when they are explicitly off', () => {
    expect(expandExcludes({ enabled: true, exclude: ['*.log'], excludeDefaults: false, transferFleetEnv: false }).excludes).toEqual(['*.log']);
  });

  it('refuses a pattern rsync would read as a rule or a comment', () => {
    const r = expandExcludes({ enabled: true, exclude: ['+ keep', '- drop', '!', '# note', '', 'a\tb', 'ok'], excludeDefaults: false, transferFleetEnv: false });
    expect(r.excludes).toEqual(['ok']);
    expect(r.blockers).toHaveLength(6);
    expect(new Set(r.blockers.map((b) => b.code))).toEqual(new Set(['path_unsupported']));
  });

  it('matches the way rsync reads each pattern', () => {
    const is = excludeMatcher([...DEFAULT_EXCLUDES, '/docs/', 'gen/out', 'cache/**/tmp', 'v?.[ab]']);
    expect(is('node_modules', true)).toBe(true);
    expect(is('packages/web/node_modules', true)).toBe(true);
    expect(is('node_modules', false)).toBe(false);
    expect(is('packages/tsconfig.tsbuildinfo', false)).toBe(true);
    expect(is('docs', true)).toBe(true);
    expect(is('packages/docs', true)).toBe(false);
    expect(is('gen/out', false)).toBe(true);
    expect(is('src/gen/out', true)).toBe(true);
    expect(is('src/xgen/out', true)).toBe(false);
    expect(is('cache/a/b/tmp', true)).toBe(true);
    expect(is('lib/v1.a', false)).toBe(true);
    expect(is('lib/v1.c', false)).toBe(false);
    expect(is('src/index.ts', false)).toBe(false);
  });

  it('never excludes a .git entry or anything under it, whatever the patterns say', () => {
    const is = excludeMatcher([...DEFAULT_EXCLUDES, '.*', '*']);
    expect(is('.git/refs/heads/build', true)).toBe(false);
    expect(is('.git/worktrees/build/index', false)).toBe(false);
    expect(is('lib/sub/.git/modules/dist', true)).toBe(false);
    expect(is('.git', true)).toBe(false);
    expect(is('wt/.git', false)).toBe(false);
    expect(is('build', true)).toBe(true);
    expect(is('.cache', true)).toBe(true);
    expect(is('x.git/build', true)).toBe(true);
  });
});

// a source machine with a main checkout and a worktree nested in it, a sibling worktree, a plain
// folder, mission control's cwd and a notes file no working directory covers
function seed() {
  const base = tmp();
  const mac = path.join(base, 'mac');
  const repo = path.join(mac, 'code/app');
  const nested = path.join(repo, '.claude/worktrees/w1');
  const sibling = path.join(mac, 'code/app-w2');
  const plain = path.join(mac, 'scratch');
  const notes = path.join(mac, 'notes.md');
  for (const d of [nested, sibling, plain, path.join(mac, '.archipelago/home'), path.join(base, 'outside')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(notes, 'notes');
  const maps: MachineMaps = {
    source: { machineId: MAC, pathRoots: { home: mac }, fleetHome: path.join(mac, '.archipelago') },
    destination: { machineId: TRIFT, pathRoots: { home: '/home/linus' }, fleetHome: '/home/linus/.archipelago' },
  };
  const state = emptyState();
  state.characters = {
    main: char('main', { cwd: path.join(repo, 'src'), repo: { root: repo, mainRoot: repo, branch: 'main', isWorktree: false } }),
    w1: char('w1', {
      cwd: nested, repo: { root: nested, mainRoot: repo, branch: 'w1', isWorktree: true },
      agent: agent('claude', path.join(mac, '.claude/projects/w1/11111111-1111-4111-8111-111111111111.jsonl')),
      second: { cwd: plain, unread: false, agent: agent('codex', path.join(mac, '.codex/sessions/r.jsonl')) },
    }),
    w2: char('w2', {
      cwd: sibling, repo: { root: sibling, mainRoot: repo, branch: 'w2', isWorktree: true },
      context: [
        { kind: 'file', ref: notes, label: '', source: 'manual' },
        { kind: 'folder', ref: path.join(repo, 'docs'), label: '', source: 'manual' },
      ],
    }),
    // a shell parked at the home root: it reopens there, and home itself is never copied
    idle: char('idle', { cwd: mac }),
  };
  return { base, mac, repo, nested, sibling, plain, notes, maps, state };
}

describe('buildInventory', () => {
  it('carries every working root once, mapped through the destination path roots', () => {
    const s = seed();
    const inv = buildInventory(s.state, { fleet: { ...FLEET, home: { ...FLEET.home, cwd: '~/.archipelago/home' } } }, s.maps);
    expect(inv.blockers).toEqual([]);
    const rel = (p: string): string => path.relative(s.mac, p);
    expect(inv.roots.map((r) => [r.kind, rel(r.sourcePath), r.destinationPath, r.foldedInto && rel(inv.roots.find((o) => o.id === r.foldedInto)!.sourcePath)])).toEqual([
      ['home', '.archipelago/home', '/home/linus/.archipelago/home', undefined],
      ['repo', 'code/app', '/home/linus/code/app', undefined],
      ['worktree', 'code/app-w2', '/home/linus/code/app-w2', undefined],
      ['worktree', 'code/app/.claude/worktrees/w1', '/home/linus/code/app/.claude/worktrees/w1', 'code/app'],
      ['context', 'notes.md', '/home/linus/notes.md', undefined],
      ['cwd', 'scratch', '/home/linus/scratch', undefined],
    ]);
    expect(new Set(inv.roots.map((r) => r.id)).size).toBe(inv.roots.length);
    expect(inv.excludes).toEqual([...DEFAULT_EXCLUDES]);
    expect(inv.fromMachineId).toBe(MAC);
    expect(inv.toMachineId).toBe(TRIFT);
    expect(inv.sourceRoots).toEqual({ home: s.mac });
    expect(inv.destinationRoots).toEqual({ home: '/home/linus' });
  });

  it('lists the transcript each agent recorded, in either terminal, and blocks an agent that recorded none', () => {
    const s = seed();
    s.state.characters.w2.agent = { kind: 'codex', sessionId: '22222222-2222-4222-8222-222222222222', status: 'idle', lastActivityAt: 0 };
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.sessions).toEqual([
      { characterId: 'w1', agent: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', sourcePath: s.state.characters.w1.agent!.transcriptPath, destinationCwd: '/home/linus/code/app/.claude/worktrees/w1' },
      { characterId: 'w1', term: 2, agent: 'codex', sessionId: '11111111-1111-4111-8111-111111111111', sourcePath: path.join(s.mac, '.codex/sessions/r.jsonl'), destinationCwd: '/home/linus/scratch' },
    ]);
    expect(inv.blockers).toEqual([expect.objectContaining({ code: 'transcript_missing', entity: { kind: 'character', id: 'w2' } })]);
  });

  it('blocks a path no declared root holds, and one whose root the destination lacks', () => {
    const s = seed();
    s.state.characters.w2.context.push({ kind: 'file', ref: path.join(s.base, 'outside'), label: '', source: 'manual' });
    s.maps.source.pathRoots.work = path.join(s.mac, 'code');
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    // one blocker per character and missing root, however many of its paths live there
    const missing = (id: string, message: string) => ({ code: 'path_root_missing', message, entity: { kind: 'character', id } });
    expect(inv.blockers).toEqual([
      missing('main', 'the destination has no path root work'),
      missing('w1', 'the destination has no path root work'),
      missing('w2', `no path root holds ${path.join(s.base, 'outside')}`),
      missing('w2', 'the destination has no path root work'),
    ]);
    // nothing lands anywhere from a root the destination cannot map
    expect(inv.roots.some((r) => r.sourcePath.startsWith(path.join(s.mac, 'code')))).toBe(false);
  });

  it('blocks a working directory whose real path leaves its root, and one holding a control character', () => {
    const s = seed();
    fs.symlinkSync(path.join(s.base, 'outside'), path.join(s.mac, 'escape'));
    s.state.characters.idle.cwd = path.join(s.mac, 'escape');
    s.state.characters.main.second = { cwd: path.join(s.mac, 'a\tb'), unread: false };
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([
      { code: 'path_root_missing', message: `${path.join(s.mac, 'escape')} leaves the path root home`, entity: { kind: 'character', id: 'idle' } },
      { code: 'path_unsupported', message: `${JSON.stringify(path.join(s.mac, 'a\tb'))} holds a control character`, entity: { kind: 'character', id: 'main' } },
    ]);
  });

  it('carries a root on its own when the root around it excludes it or maps it elsewhere', () => {
    const s = seed();
    const built = path.join(s.plain, 'build/site');
    const disk = path.join(s.plain, 'disk');
    fs.mkdirSync(built, { recursive: true });
    fs.mkdirSync(disk);
    s.maps.source.pathRoots.work = disk;
    s.maps.destination.pathRoots.work = '/srv/work';
    s.state.characters.site = char('site', { cwd: built });
    s.state.characters.disk = char('disk', { cwd: path.join(disk, 'x') });
    fs.mkdirSync(path.join(disk, 'x'));
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([]);
    const byPath = new Map(inv.roots.map((r) => [r.sourcePath, r]));
    expect(byPath.get(built)).toMatchObject({ kind: 'cwd', destinationPath: '/home/linus/scratch/build/site' });
    expect(byPath.get(built)!.foldedInto).toBeUndefined();
    expect(byPath.get(path.join(disk, 'x'))).toMatchObject({ kind: 'cwd', destinationPath: '/srv/work/x' });
    expect(byPath.get(path.join(disk, 'x'))!.foldedInto).toBeUndefined();
  });

  it('carries the fleet .env only when fleet.json says so, into the destination fleet home', () => {
    const s = seed();
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps).roots.some((r) => r.kind === 'env')).toBe(false);
    const fleet = { ...FLEET, handover: { ...FLEET.handover, transferFleetEnv: true } };
    expect(buildInventory(s.state, { fleet }, s.maps).roots.find((r) => r.kind === 'env')).toMatchObject({
      sourcePath: path.join(s.mac, '.archipelago/.env'), destinationPath: '/home/linus/.archipelago/.env',
    });
  });

  it('comes out the same whatever order the characters were added in', () => {
    const s = seed();
    const reversed: State = { ...s.state, characters: Object.fromEntries(Object.entries(s.state.characters).reverse()) };
    expect(buildInventory(reversed, { fleet: FLEET }, s.maps)).toEqual(buildInventory(s.state, { fleet: FLEET }, s.maps));
  });

  it('blocks a root that holds or lies in either fleet home, but not mission control or the fleet .env', () => {
    const s = seed();
    const fleetHome = path.join(s.mac, '.archipelago');
    fs.mkdirSync(path.join(fleetHome, 'hooks'));
    fs.mkdirSync(path.join(s.mac, '.archipelago-dest'));
    s.state.characters.inside = char('inside', { cwd: fleetHome });
    s.state.characters.hooks = char('hooks', { cwd: path.join(fleetHome, 'hooks') });
    // lands on the destination's fleet home, though it is not this machine's
    s.maps.destination.fleetHome = '/home/linus/.archipelago-dest';
    s.state.characters.lands = char('lands', { cwd: path.join(s.mac, '.archipelago-dest') });
    const fleet = { ...FLEET, handover: { ...FLEET.handover, transferFleetEnv: true } };
    const inv = buildInventory(s.state, { fleet }, s.maps);
    const blocked = [fleetHome, path.join(fleetHome, 'hooks'), path.join(s.mac, '.archipelago-dest')];
    expect(inv.blockers.map((b) => [b.code, b.entity?.kind])).toEqual(blocked.map(() => ['path_unsupported', 'root']));
    expect(inv.blockers.map((b) => b.message).join('\n')).toContain(fleetHome);
    expect(inv.roots.filter((r) => blocked.includes(r.sourcePath))).toEqual([]);
    expect(inv.roots.map((r) => r.kind)).toEqual(expect.arrayContaining(['home', 'env']));
  });

  it('follows a working directory to its real path before deciding it is clear of the fleet home', () => {
    const s = seed();
    const fleetHome = path.join(s.mac, '.archipelago');
    fs.writeFileSync(path.join(fleetHome, 'token'), 'secret');
    fs.symlinkSync(fleetHome, path.join(s.mac, 'archi-link'));
    s.state.characters.idle.cwd = path.join(s.mac, 'archi-link');
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining(`overlaps the fleet home ${fleetHome}`) })]);
    expect(inv.roots.some((r) => r.sourcePath === path.join(s.mac, 'archi-link'))).toBe(false);
  });

  it('carries a path inside mission control with mission control, not as an overlap of the fleet home', () => {
    const s = seed();
    const notes = path.join(s.mac, '.archipelago/home/notes.md');
    fs.writeFileSync(notes, 'notes');
    s.state.characters.w2.context.push({ kind: 'file', ref: notes, label: '', source: 'manual' });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([]);
    expect(inv.roots.some((r) => r.sourcePath === notes)).toBe(false);
    expect(inv.roots.find((r) => r.kind === 'home')?.sourcePath).toBe(path.join(s.mac, '.archipelago/home'));
    // mission control set to the fleet home itself exempts nothing, itself included
    const whole = buildInventory(s.state, { fleet: { ...FLEET, home: { ...FLEET.home, cwd: '~/.archipelago' } } }, s.maps);
    expect(whole.blockers.map((b) => b.message).sort()).toEqual([
      `${path.join(s.mac, '.archipelago')} overlaps the fleet home ${path.join(s.mac, '.archipelago')}, whose token, keys and node.json stay on their machine`,
      `${notes} overlaps the fleet home ${path.join(s.mac, '.archipelago')}, whose token, keys and node.json stay on their machine`,
    ].sort());
    expect(whole.roots.some((r) => r.kind === 'home' || r.sourcePath === notes)).toBe(false);
  });

  it('folds a root by what is on disk, whatever its ref calls it', () => {
    const s = seed();
    // a file named like an excluded folder rides in the folder around it
    fs.writeFileSync(path.join(s.plain, 'build'), 'a file, not the build folder');
    s.state.characters.w2.context.push({ kind: 'file', ref: path.join(s.plain, 'build'), label: '', source: 'manual' });
    // a folder named build that a tab opens is carried on its own, since the folder around it excludes it
    const site = path.join(s.sibling, 'build');
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, 'index.html'), '<p>');
    s.state.characters.w2.browser = { tabs: [{ id: 't1', url: pathToFileURL(site).href, title: '' }] };
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.roots.some((r) => r.sourcePath === path.join(s.plain, 'build'))).toBe(false);
    expect(inv.roots.find((r) => r.sourcePath === site)).toMatchObject({ kind: 'context', entry: 'dir' });
    expect(inv.roots.find((r) => r.sourcePath === site)!.foldedInto).toBeUndefined();
  });

  it('keeps a snapshot with no tmux ids', () => {
    const s = seed();
    s.state.characters.main.tmux = { windowId: '@1', paneId: '%1' };
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps).snapshot.characters.main.tmux).toBeUndefined();
  });
});

describe('buildInventory with the discovered Git graphs', () => {
  const checkout = (p: string, gitDir: string, characters: string[]): GitCheckout =>
    ({ path: p, gitDir, head: 'a'.repeat(40), branch: 'refs/heads/main', status: [], index: 'b'.repeat(64), characters });

  // the seed's repository, a bare one with a worktree beside it, and a submodule a character works in
  function discovered(s: ReturnType<typeof seed>) {
    const bare = path.join(s.mac, 'code/tool.git');
    const bw = path.join(s.mac, 'code/tool-wt');
    const sub = path.join(s.repo, 'sub');
    const modules = path.join(s.repo, '.git/modules/sub');
    for (const d of [bare, bw, sub, modules]) fs.mkdirSync(d, { recursive: true });
    // what a bare repository's worktree records: its parent as the main root
    s.state.characters.tool = char('tool', { cwd: bw, repo: { root: bw, mainRoot: path.join(s.mac, 'code'), branch: 'x', isWorktree: true } });
    s.state.characters.sub = char('sub', { cwd: sub });
    const graphs: GitGraph[] = [
      {
        id: 'g_app', commonDir: path.join(s.repo, '.git'), main: checkout(s.repo, path.join(s.repo, '.git'), ['main']),
        worktrees: [checkout(s.nested, path.join(s.repo, '.git/worktrees/w1'), ['w1']), checkout(s.sibling, path.join(s.repo, '.git/worktrees/app-w2'), ['w2'])],
        unused: [], stash: [],
      },
      { id: 'g_sub', commonDir: modules, main: checkout(sub, modules, ['sub']), worktrees: [], unused: [], stash: [] },
      { id: 'g_tool', commonDir: bare, worktrees: [checkout(bw, path.join(bare, 'worktrees/tool-wt'), ['tool'])], unused: [], stash: [] },
    ];
    const warnings: Warning[] = [{ code: 'worktree_unused', message: 'an unused worktree', entity: { kind: 'git', id: 'g_app' } }];
    return { bare, discovery: { graphs, blockers: [] as Blocker[], warnings } };
  }

  it('carries each graph: its main checkout, a common directory outside any checkout, and each used worktree, each once', () => {
    const s = seed();
    const d = discovered(s);
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery);
    expect(inv.blockers).toEqual([]);
    const rel = (p: string): string => path.relative(s.mac, p);
    const git = inv.roots.filter((r) => ['repo', 'worktree', 'gitdir'].includes(r.kind));
    expect(git.map((r) => [r.kind, rel(r.sourcePath), r.destinationPath, r.foldedInto && rel(inv.roots.find((o) => o.id === r.foldedInto)!.sourcePath)])).toEqual([
      ['repo', 'code/app', '/home/linus/code/app', undefined],
      ['worktree', 'code/app-w2', '/home/linus/code/app-w2', undefined],
      ['worktree', 'code/app/.claude/worktrees/w1', '/home/linus/code/app/.claude/worktrees/w1', 'code/app'],
      ['gitdir', 'code/app/.git/modules/sub', '/home/linus/code/app/.git/modules/sub', 'code/app'],
      ['repo', 'code/app/sub', '/home/linus/code/app/sub', 'code/app'],
      ['worktree', 'code/tool-wt', '/home/linus/code/tool-wt', undefined],
      ['gitdir', 'code/tool.git', '/home/linus/code/tool.git', undefined],
    ]);
    // the parent a recorded bare repository names is no root: the graph says where its common directory is
    expect(inv.roots.some((r) => r.sourcePath === path.join(s.mac, 'code'))).toBe(false);
    expect(inv.git).toEqual(d.discovery.graphs);
    expect(inv.warnings).toEqual(d.discovery.warnings);
  });

  it('blocks a graph root no declared root holds, as the graph\'s, and keeps what discovery blocked', () => {
    const s = seed();
    const d = discovered(s);
    const outside = path.join(s.base, 'outside');
    d.discovery.graphs[2].worktrees[0].path = outside;
    const found: Blocker = { code: 'worktree_unresolved', message: 'git refused', entity: { kind: 'character', id: 'w1' } };
    d.discovery.blockers.push(found);
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery);
    expect(inv.blockers).toEqual([
      { code: 'path_root_missing', message: `no path root holds ${outside}`, entity: { kind: 'git', id: 'g_tool' } },
      found,
    ]);
  });

  it('keeps Git\'s own entries in a Git directory carried on its own, and reads the excludes everywhere else in it', () => {
    const s = seed();
    const d = discovered(s);
    // a note under a branch named like an exclude rides inside the bare repository; one under a cache folder beside it cannot
    const kept = path.join(d.bare, 'refs/heads/build/notes.md');
    const cached = path.join(d.bare, 'build/notes.md');
    for (const note of [kept, cached]) {
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(note, 'notes');
      s.state.characters.w2.context.push({ kind: 'file', ref: note, label: '', source: 'manual' });
    }
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery);
    expect(inv.roots.some((r) => r.sourcePath === kept)).toBe(false);
    expect(inv.roots.find((r) => r.sourcePath === cached)).toMatchObject({ kind: 'context' });
    expect(inv.roots.find((r) => r.sourcePath === cached)!.foldedInto).toBeUndefined();
    const inGitDir = rootMatcher('gitdir', DEFAULT_EXCLUDES);
    expect(['refs/heads/build', 'logs/refs/heads/dist', 'worktrees/node_modules', 'modules/target'].some((p) => inGitDir(p, true))).toBe(false);
    // a checkout kept inside it is read like any other
    expect(inGitDir('main/node_modules', true)).toBe(true);
    expect(inGitDir('build', true)).toBe(true);
    expect(rootMatcher('repo', DEFAULT_EXCLUDES)('refs/heads/build', true)).toBe(true);
  });

  // a tmux pane reports its cwd by its real path; the path root here is declared through a link, as ~/code to /Volumes/work/code
  it('spells a path given by its real path under the declared root that holds it, in the snapshot as in the roots it carries', () => {
    const base = tmp();
    const disk = path.join(base, 'disk/code');
    const declared = path.join(base, 'code');
    for (const d of [path.join(disk, 'app/sub'), path.join(base, 'home')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(disk, 'app/notes.md'), 'notes');
    fs.symlinkSync(disk, declared);
    const state = emptyState();
    state.characters = {
      app: char('app', {
        cwd: path.join(disk, 'app'),
        second: { cwd: path.join(disk, 'app/sub'), unread: false },
        context: [{ kind: 'file', ref: path.join(disk, 'app/notes.md'), label: '', source: 'manual' }],
        browser: { tabs: [{ id: 't1', url: `${pathToFileURL(path.join(disk, 'app/notes.md')).href}#top`, title: '' }] },
      }),
    };
    const maps: MachineMaps = {
      source: { machineId: MAC, pathRoots: { home: path.join(base, 'home'), work: declared }, fleetHome: path.join(base, 'home/.archipelago') },
      destination: { machineId: TRIFT, pathRoots: { home: '/home/linus', work: '/srv/work' }, fleetHome: '/home/linus/.archipelago' },
    };
    const inv = buildInventory(state, { fleet: FLEET }, maps);
    expect(inv.blockers).toEqual([]);
    expect(inv.roots.filter((r) => r.kind === 'cwd').map((r) => [r.sourcePath, r.destinationPath])).toEqual([[path.join(declared, 'app'), '/srv/work/app']]);
    const app = inv.snapshot.characters.app;
    expect([app.cwd, app.second?.cwd, app.context[0].ref]).toEqual([path.join(declared, 'app'), path.join(declared, 'app/sub'), path.join(declared, 'app/notes.md')]);
    expect(app.browser?.tabs[0].url).toBe(`${pathToFileURL(path.join(declared, 'app/notes.md')).href}#top`);
    // the state this machine runs keeps what it had
    expect(state.characters.app.cwd).toBe(path.join(disk, 'app'));
  });

  it('places a path reached through a link into another declared root under that root, as it places a repository', () => {
    const base = tmp();
    const home = path.join(base, 'home');
    const data = path.join(base, 'data');
    fs.mkdirSync(path.join(data, 'proj'), { recursive: true });
    fs.mkdirSync(home);
    fs.symlinkSync(data, path.join(home, 'data'));
    const state = emptyState();
    state.characters = { p: char('p', { cwd: path.join(home, 'data/proj') }) };
    const maps: MachineMaps = {
      source: { machineId: MAC, pathRoots: { home, data }, fleetHome: path.join(home, '.archipelago') },
      destination: { machineId: TRIFT, pathRoots: { home: '/home/linus', data: '/srv/data' }, fleetHome: '/home/linus/.archipelago' },
    };
    const inv = buildInventory(state, { fleet: FLEET }, maps);
    expect(inv.blockers).toEqual([]);
    expect(inv.roots.filter((r) => r.kind === 'cwd').map((r) => [r.sourcePath, r.destinationPath])).toEqual([[path.join(data, 'proj'), '/srv/data/proj']]);
    expect(inv.snapshot.characters.p.cwd).toBe(path.join(data, 'proj'));
  });

  // git names each checkout by its real path; the path root here is declared through a link, as ~/code to /Volumes/work/code
  it.skipIf(!hasGit)('places a repository under the root whose real path holds it, and names it through that root (needs git)', async () => {
    const base = tmp();
    fs.writeFileSync(path.join(base, 'gitconfig'), '');
    const disk = path.join(base, 'disk/code');
    const declared = path.join(base, 'code');
    const outside = path.join(base, 'elsewhere/lone');
    for (const repo of [path.join(disk, 'app'), outside]) {
      fs.mkdirSync(repo, { recursive: true });
      git(base, repo, 'init', '-q');
      git(base, repo, 'commit', '-q', '--allow-empty', '-m', 'first');
    }
    fs.mkdirSync(path.join(base, 'home'));
    fs.symlinkSync(disk, declared);
    const state = emptyState();
    state.characters = { app: char('app', { cwd: path.join(declared, 'app') }), lone: char('lone', { cwd: outside }) };
    const maps: MachineMaps = {
      source: { machineId: MAC, pathRoots: { home: path.join(base, 'home'), work: declared }, fleetHome: path.join(base, 'home/.archipelago') },
      destination: { machineId: TRIFT, pathRoots: { home: '/home/linus', work: '/srv/work' }, fleetHome: '/home/linus/.archipelago' },
    };
    const discovery = await discoverGit(state, { excludes: DEFAULT_EXCLUDES });
    expect(discovery.blockers).toEqual([]);
    const lone = discovery.graphs.find((g) => g.main?.path === fs.realpathSync(outside))!;

    const inv = buildInventory(state, { fleet: FLEET }, maps, discovery);
    expect(inv.roots.map((r) => [r.kind, r.sourcePath, r.destinationPath])).toEqual([
      ['repo', path.join(declared, 'app'), '/srv/work/app'],
      ['home', path.join(base, 'home/.archipelago/home'), '/home/linus/.archipelago/home'],
    ]);
    const app = inv.git.find((g) => g.id !== lone.id)!;
    expect([app.commonDir, app.main?.path, app.main?.gitDir]).toEqual([path.join(declared, 'app/.git'), path.join(declared, 'app'), path.join(declared, 'app/.git')]);
    // a repository no root holds by its real path still blocks, named as git names it
    expect(inv.blockers).toEqual([
      { code: 'path_root_missing', message: `no path root holds ${fs.realpathSync(outside)}`, entity: { kind: 'git', id: lone.id } },
      { code: 'path_root_missing', message: `no path root holds ${outside}`, entity: { kind: 'character', id: 'lone' } },
    ]);
  });
});

function char(id: string, o: Partial<Character>): Character {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}

function agent(kind: 'claude' | 'codex', transcriptPath: string): NonNullable<Character['agent']> {
  return { kind, sessionId: '11111111-1111-4111-8111-111111111111', transcriptPath, status: 'idle', lastActivityAt: 0 };
}
