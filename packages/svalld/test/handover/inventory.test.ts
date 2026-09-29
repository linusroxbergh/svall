import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z, type ZodTypeAny } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Character, emptyState, FleetConfig, FleetState, MachineRecord, NodeConfig, TransferManifestV1,
  type Blocker, type FleetState as State, type GitCheckout, type GitGraph, type MachineId, type Warning,
} from '@svall/protocol';
import { discoverGit } from '../../src/handover/git-graph.js';
import { buildInventory, DEFAULT_EXCLUDES, excludeMatcher, expandExcludes, homeCommands, rootMatcher, type MachineMaps } from '../../src/handover/inventory.js';
import { exportSnapshot, NOT_BOUND, NOT_PATHS, PATH_FIELDS, portablePathValues } from '../../src/handover/portable-path.js';
import { git, hasGit } from './git-fixture.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync('/tmp/svall-t-')); made.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });

// the schemas a handover reads, writes or carries: the fleet's state and configs, and the manifest itself
const CLASSIFIED: Record<string, ZodTypeAny> = { FleetState, FleetConfig, NodeConfig, MachineRecord, TransferManifestV1 };

// the records whose values travel: every number, flag and choice in them is bound to its machine or not
const TRAVELLING: Record<string, ZodTypeAny> = { FleetState, FleetConfig };

// every leaf a schema holds, named the way the registry names it: `*` a record's values, `[]` an array's items, and
// whether it is a free string. A refine and a brand keep the schema they are on, so neither needs a case of its own
function leaves(schema: z.core.$ZodType, name: string, out: [string, boolean][] = []): [string, boolean][] {
  const d = (schema as z.core.$ZodTypes)._zod.def;
  switch (d.type) {
    case 'string': out.push([name, true]); break;
    case 'object':
      for (const [k, v] of Object.entries(d.shape)) {
        // a schema classified on its own is walked under its own name
        if (!Object.values(CLASSIFIED).includes(v as ZodTypeAny)) leaves(v, `${name}.${k}`, out);
      }
      break;
    case 'record': leaves(d.valueType, `${name}.*`, out); break;
    case 'array': leaves(d.element, `${name}[]`, out); break;
    case 'optional': case 'nullable': case 'default': case 'prefault': leaves(d.innerType, name, out); break;
    case 'union': for (const o of d.options) leaves(o, name, out); break;
    case 'literal': case 'enum': case 'number': case 'boolean': out.push([name, false]); break;
    default: throw new Error(`${name}: the walk does not know ${d.type}`);
  }
  return out;
}
const stringFields = (schema: ZodTypeAny, name: string): string[] => leaves(schema, name).filter(([, s]) => s).map(([f]) => f);
const valueFields = (schema: ZodTypeAny, name: string): string[] => leaves(schema, name).filter(([, s]) => !s).map(([f]) => f);

// a name and every name above it; an array's items lie under the array
const prefixes = (field: string): string[] => field.split('.').flatMap((s, i, all) => {
  const p = all.slice(0, i + 1).join('.');
  return s.endsWith('[]') ? [p.slice(0, -2), p] : [p];
});
const classified = (field: string): boolean => prefixes(field).some((p) => p in PATH_FIELDS || NOT_PATHS.includes(p));
const unclassified = (schemas: Record<string, ZodTypeAny>): string[] =>
  [...new Set(Object.entries(schemas).flatMap(([n, s]) => stringFields(s, n)))].filter((f) => !classified(f));
const valueClassified = (field: string): boolean => prefixes(field).some((p) => p in PATH_FIELDS || NOT_BOUND.includes(p));
const unclassifiedValues = (schemas: Record<string, ZodTypeAny>): string[] =>
  [...new Set(Object.entries(schemas).flatMap(([n, s]) => valueFields(s, n)))].filter((f) => !valueClassified(f));

describe('path classification', () => {
  it('classifies every string field a handover reads, writes or carries', () => {
    expect(unclassified(CLASSIFIED)).toEqual([]);
  });

  it('fails on a path field nobody classified', () => {
    const Future = FleetState.extend({ characters: z.record(z.string(), Character.extend({ scratchDir: z.string() })) });
    expect(unclassified({ ...CLASSIFIED, FleetState: Future })).toEqual(['FleetState.characters.*.scratchDir']);
  });

  it('classifies every number, flag and choice the state and fleet.json carry as bound to a machine or process, or not', () => {
    expect(unclassifiedValues(TRAVELLING)).toEqual([]);
  });

  it('fails on a pid or any other value nobody classified', () => {
    const Future = FleetState.extend({ characters: z.record(z.string(), Character.extend({ shellPid: z.number().int().optional() })) });
    expect(unclassifiedValues({ ...TRAVELLING, FleetState: Future })).toEqual(['FleetState.characters.*.shellPid']);
  });

  it('names no field the schemas no longer have', () => {
    const fields = Object.entries(CLASSIFIED).flatMap(([n, s]) => leaves(s, n).map(([f]) => f));
    const stale = [...Object.keys(PATH_FIELDS), ...NOT_PATHS, ...NOT_BOUND].filter((k) => !fields.some((f) => prefixes(f).includes(k)));
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
      ['FleetConfig.home.cwd', '/Users/linus/.svall/home'],
      ['FleetState.characters.*.browser.tabs[].url', '/Users/linus/p/a b.html'],
      ['FleetState.characters.*.context[].ref', '/Users/linus/notes.md'],
      ['FleetState.characters.*.cwd', '/Users/linus/p'],
      ['FleetState.defaultCwd', '/Users/linus'],
      ['FleetState.home.cwd', '/Users/linus/.svall/home'],
    ]);
  });

  it('strips every field bound to this machine or its processes from the state that leaves it, and nothing else', () => {
    const state = emptyState();
    state.agentsFound = ['claude', 'codex'];
    const tmux = { windowId: '@1', paneId: '%1' };
    const agent = { kind: 'claude' as const, sessionId: 's', transcriptPath: '/t.jsonl', status: 'idle' as const, lastActivityAt: 1 };
    state.characters.c1 = char('c1', {
      tmux, panePath: '/Users/linus/p', hint: 'codex-silent', agent: { ...agent, pid: 41 }, second: { cwd: '/x', tmux, unread: false, agent: { ...agent, pid: 42 } },
    });
    const exported = exportSnapshot(state);
    expect(exported.characters.c1.tmux).toBeUndefined();
    expect(exported.characters.c1.panePath).toBeUndefined();
    expect(exported.characters.c1.hint).toBeUndefined();
    // a pid names a process on this machine only, and the destination finds its own agents
    expect(exported.characters.c1.agent).toEqual(agent);
    expect(exported.characters.c1.second).toEqual({ cwd: '/x', unread: false, agent });
    expect(exported.agentsFound).toBeUndefined();
    const { tmux: _t, panePath: _p, hint: _h, agent: _a, second: _s, ...rest } = state.characters.c1;
    expect(exported.characters.c1).toEqual({ ...rest, agent, second: { cwd: '/x', unread: false, agent } });
    expect(state.characters.c1.tmux).toEqual(tmux);
    expect(state.characters.c1.agent?.pid).toBe(41);
    expect(state.agentsFound).toEqual(['claude', 'codex']);
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
  for (const d of [nested, sibling, plain, path.join(mac, '.svall/home'), path.join(base, 'outside')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(notes, 'notes');
  const maps: MachineMaps = {
    source: { machineId: MAC, home: mac, fleetHome: path.join(mac, '.svall') },
    destination: { machineId: TRIFT, home: mac, fleetHome: path.join(mac, '.svall') },
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
  it('carries every working root once, at the path it has on both machines', () => {
    const s = seed();
    const inv = buildInventory(s.state, { fleet: { ...FLEET, home: { ...FLEET.home, cwd: '~/.svall/home' } } }, s.maps);
    expect(inv.blockers).toEqual([]);
    const rel = (p: string): string => path.relative(s.mac, p);
    expect(inv.roots.map((r) => [r.kind, rel(r.path), r.foldedInto && rel(inv.roots.find((o) => o.id === r.foldedInto)!.path)])).toEqual([
      ['home', '.svall/home', undefined],
      ['repo', 'code/app', undefined],
      ['worktree', 'code/app-w2', undefined],
      ['worktree', 'code/app/.claude/worktrees/w1', 'code/app'],
      ['context', 'notes.md', undefined],
      ['cwd', 'scratch', undefined],
    ]);
    expect(new Set(inv.roots.map((r) => r.id)).size).toBe(inv.roots.length);
    expect(inv.excludes).toEqual([...DEFAULT_EXCLUDES]);
    expect(inv.fromMachineId).toBe(MAC);
    expect(inv.toMachineId).toBe(TRIFT);
    expect(inv.home).toBe(s.mac);
    // nothing it records is rewritten
    expect(inv.snapshot.characters).toEqual(exportSnapshot(s.state).characters);
  });

  it('lists the transcript each agent recorded, in either terminal, and blocks an agent that recorded none', () => {
    const s = seed();
    s.state.characters.w2.agent = { kind: 'codex', sessionId: '22222222-2222-4222-8222-222222222222', status: 'idle', lastActivityAt: 0 };
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.sessions).toEqual([
      { characterId: 'w1', agent: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', sourcePath: s.state.characters.w1.agent!.transcriptPath },
      { characterId: 'w1', term: 2, agent: 'codex', sessionId: '11111111-1111-4111-8111-111111111111', sourcePath: path.join(s.mac, '.codex/sessions/r.jsonl') },
    ]);
    expect(inv.blockers).toEqual([expect.objectContaining({ code: 'transcript_missing', entity: { kind: 'character', id: 'w2' } })]);
  });

  it('blocks a destination whose home is not this machine\'s, naming the commands that make one that is', () => {
    const s = seed();
    s.maps.destination.home = '/home/linus';
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps).blockers).toEqual([{
      code: 'home_mismatch',
      message: `the destination's home is /home/linus and this machine's ${s.mac}; a fleet moves only between accounts with the same home path. On the destination, ${homeCommands(s.mac)}; then svall host remove <name>, svall host add at that account, and svall host enable <name> --fleet <fleet>`,
    }]);
    expect(homeCommands("/Users/Linus's")).toBe("sudo mkdir -p /Users, then sudo useradd -m -d '/Users/Linus'\\''s' <user> for a new account, or sudo usermod -d '/Users/Linus'\\''s' -m <user> for an existing one you are not logged in as");
  });

  it('carries a root outside the home at its own path, leaving the destination to say whether the folder it lands in is there', () => {
    const s = seed();
    const outside = path.join(s.base, 'outside');
    s.state.characters.w2.context.push({ kind: 'folder', ref: outside, label: '', source: 'manual' });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([]);
    expect(inv.roots.find((r) => r.path === outside)).toMatchObject({ kind: 'context', entry: 'dir' });
  });

  it('blocks a working directory holding a control character', () => {
    const s = seed();
    s.state.characters.main.second = { cwd: path.join(s.mac, 'a\tb'), unread: false };
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps).blockers).toEqual([
      { code: 'path_unsupported', message: `${JSON.stringify(path.join(s.mac, 'a\tb'))} holds a control character`, entity: { kind: 'character', id: 'main' } },
    ]);
  });

  it('blocks a working directory, mission control\'s folder and a context ref reached through a link, naming where each leads', () => {
    const s = seed();
    const linked = path.join(s.mac, 'linked');
    fs.symlinkSync(s.plain, linked);
    fs.writeFileSync(path.join(s.plain, 'todo.md'), 'todo');
    s.state.characters.idle.cwd = linked;
    s.state.characters.w2.context.push({ kind: 'file', ref: path.join(linked, 'todo.md'), label: '', source: 'manual' });
    const inv = buildInventory(s.state, { fleet: { ...FLEET, home: { ...FLEET.home, cwd: '~/linked' } } }, s.maps);
    const said = (p: string, real: string) =>
      `${p} leads to ${real} through a symbolic link; a handover carries each folder at its real path, the one Git and the agents record, so use ${real} instead`;
    expect(inv.blockers).toEqual([
      { code: 'path_symlinked', message: said(linked, s.plain), entity: { kind: 'character', id: 'idle' } },
      { code: 'path_symlinked', message: said(path.join(linked, 'todo.md'), path.join(s.plain, 'todo.md')), entity: { kind: 'character', id: 'w2' } },
      { code: 'path_symlinked', message: said(linked, s.plain) },
    ]);
    expect(inv.roots.some((r) => r.path.startsWith(linked))).toBe(false);
  });

  it('blocks a folder named in another case than the disk spells it, before any other check reads the name', () => {
    const s = seed();
    const ssh = path.join(s.mac, '.ssh');
    fs.mkdirSync(ssh);
    // a Mac's disk: a name in any case finds the entry, and the real path spells it as stored
    const native = fs.realpathSync.native;
    const stored = (p: string): string => p.split('/').slice(1)
      .reduce((at, name) => path.join(at, fs.readdirSync(at).find((n) => n.toLowerCase() === name.toLowerCase()) ?? name), '/');
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: string) => native(stored(p))) as typeof native);
    s.state.characters.idle.cwd = path.join(s.mac, 'SCRATCH');
    s.state.characters.keys = char('keys', { cwd: path.join(s.mac, '.SSH') });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    const said = (p: string, real: string) =>
      `${p} is spelled ${real} on disk; a handover carries each folder at its real path, the one Git and the agents record, so use ${real} instead`;
    expect(inv.blockers).toEqual([
      { code: 'path_symlinked', message: said(path.join(s.mac, 'SCRATCH'), s.plain), entity: { kind: 'character', id: 'idle' } },
      { code: 'path_symlinked', message: said(path.join(s.mac, '.SSH'), ssh), entity: { kind: 'character', id: 'keys' } },
    ]);
    expect(inv.roots.filter((r) => r.path.toLowerCase() === s.plain.toLowerCase()).map((r) => r.path)).toEqual([s.plain]);
    expect(inv.roots.some((r) => r.path.toLowerCase() === ssh.toLowerCase())).toBe(false);
  });

  it('carries a root on its own when the root around it excludes it', () => {
    const s = seed();
    const built = path.join(s.plain, 'build/site');
    fs.mkdirSync(built, { recursive: true });
    s.state.characters.site = char('site', { cwd: built });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([]);
    const root = inv.roots.find((r) => r.path === built);
    expect(root).toMatchObject({ kind: 'cwd' });
    expect(root!.foldedInto).toBeUndefined();
  });

  it('carries the fleet .env only when fleet.json says so, and only to the same path in the destination fleet home', () => {
    const s = seed();
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps).roots.some((r) => r.kind === 'env')).toBe(false);
    const fleet = { ...FLEET, handover: { ...FLEET.handover, transferFleetEnv: true } };
    expect(buildInventory(s.state, { fleet }, s.maps).roots.find((r) => r.kind === 'env')).toMatchObject({ path: path.join(s.mac, '.svall/.env') });
    s.maps.destination.fleetHome = path.join(s.mac, '.svall-work');
    const elsewhere = buildInventory(s.state, { fleet }, s.maps);
    expect(elsewhere.roots.some((r) => r.kind === 'env')).toBe(false);
    expect(elsewhere.blockers).toEqual([{
      code: 'path_unsupported', message: `the destination keeps this fleet's .env at ${path.join(s.mac, '.svall-work/.env')}, not ${path.join(s.mac, '.svall/.env')}, so it cannot arrive at the same path`,
    }]);
  });

  it('carries the fleet\'s docs and agent profiles from its fleet home, only to the same path in the destination\'s', () => {
    const s = seed();
    const fleetHome = path.join(s.mac, '.svall');
    const doc = path.join(fleetHome, 'docs/fleet/conventions.md');
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, 'conventions\n');
    fs.mkdirSync(path.join(fleetHome, 'agent-profiles'));
    fs.writeFileSync(path.join(fleetHome, 'agent-profiles/reviewer.md'), 'Review.\n');
    // a doc a character keeps as context rides in the docs, as no overlap of the fleet home
    s.state.characters.w2.context.push({ kind: 'file', ref: doc, label: '', source: 'manual' });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([]);
    expect(inv.roots.filter((r) => r.path.startsWith(`${fleetHome}/`)).map((r) => [r.kind, path.relative(fleetHome, r.path), r.entry])).toEqual([
      ['profiles', 'agent-profiles', 'dir'], ['docs', 'docs', 'dir'], ['home', 'home', 'dir'],
    ]);

    s.maps.destination.fleetHome = path.join(s.mac, '.svall-work');
    const elsewhere = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(elsewhere.roots.filter((r) => r.kind === 'docs' || r.kind === 'profiles')).toEqual([]);
    const there = path.join(s.mac, '.svall-work');
    expect(elsewhere.blockers.map((b) => b.message)).toEqual(expect.arrayContaining([
      `the destination keeps this fleet's docs at ${there}/docs, not ${fleetHome}/docs, so they cannot arrive at the same path`,
      `the destination keeps this fleet's agent profiles at ${there}/agent-profiles, not ${fleetHome}/agent-profiles, so they cannot arrive at the same path`,
    ]));
  });

  it('carries no docs or agent profiles a fleet home does not hold', () => {
    const s = seed();
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps).roots.filter((r) => r.kind === 'docs' || r.kind === 'profiles')).toEqual([]);
  });

  it('comes out the same whatever order the characters were added in', () => {
    const s = seed();
    const reversed: State = { ...s.state, characters: Object.fromEntries(Object.entries(s.state.characters).reverse()) };
    expect(buildInventory(reversed, { fleet: FLEET }, s.maps)).toEqual(buildInventory(s.state, { fleet: FLEET }, s.maps));
  });

  it('blocks a root that holds or lies in either fleet home, but not mission control', () => {
    const s = seed();
    const fleetHome = path.join(s.mac, '.svall');
    fs.mkdirSync(path.join(fleetHome, 'hooks'));
    fs.mkdirSync(path.join(s.mac, '.svall-dest'));
    s.state.characters.inside = char('inside', { cwd: fleetHome });
    s.state.characters.hooks = char('hooks', { cwd: path.join(fleetHome, 'hooks') });
    // lands on the destination's fleet home, though it is not this machine's
    s.maps.destination.fleetHome = path.join(s.mac, '.svall-dest');
    s.state.characters.lands = char('lands', { cwd: path.join(s.mac, '.svall-dest') });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    const blocked = [fleetHome, path.join(fleetHome, 'hooks'), path.join(s.mac, '.svall-dest')];
    expect(inv.blockers.map((b) => [b.code, b.entity?.kind])).toEqual(blocked.map(() => ['path_unsupported', 'root']));
    expect(inv.blockers.map((b) => b.message).join('\n')).toContain(fleetHome);
    expect(inv.roots.filter((r) => blocked.includes(r.path))).toEqual([]);
    expect(inv.roots.map((r) => r.kind)).toContain('home');
  });

  it('blocks a root that holds an agent\'s credentials or config, or holds or lies in the ssh folder, on either machine', () => {
    const s = seed();
    const claude = path.join(s.mac, '.claude');
    const codex = path.join(s.mac, 'codex-home');
    const ssh = path.join(s.mac, '.ssh');
    for (const d of [claude, codex, ssh, path.join(claude, 'skills')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(claude, '.credentials.json'), '{}');
    fs.writeFileSync(path.join(s.mac, '.claude.json'), '{}');
    fs.writeFileSync(path.join(codex, 'auth.json'), '{}');
    fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'key');
    s.maps.source.agentHomes = { claude, codex: path.join(s.mac, '.codex') };
    // the destination keeps Codex's login elsewhere, which a root here would land on
    s.maps.destination.agentHomes = { codex };
    s.state.characters.dotclaude = char('dotclaude', { cwd: claude });
    s.state.characters.codex = char('codex', { cwd: codex });
    s.state.characters.keys = char('keys', { cwd: ssh });
    s.state.characters.key = char('key', { cwd: s.plain, context: [{ kind: 'file', ref: path.join(ssh, 'id_ed25519'), label: '', source: 'manual' }] });
    s.state.characters.config = char('config', { cwd: s.plain, context: [{ kind: 'file', ref: path.join(s.mac, '.claude.json'), label: '', source: 'manual' }] });
    // a folder inside an agent's home holds neither
    s.state.characters.skills = char('skills', { cwd: path.join(claude, 'skills') });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    const blocked = [claude, codex, ssh, path.join(ssh, 'id_ed25519'), path.join(s.mac, '.claude.json')];
    expect(inv.blockers.filter((b) => b.code === 'path_unsupported').map((b) => b.message).sort()).toEqual([
      `${claude} holds ${path.join(claude, '.credentials.json')}, which stays on its machine`,
      `${codex} holds ${path.join(codex, 'auth.json')}, which stays on its machine`,
      `${ssh} stays on its machine`,
      `${path.join(ssh, 'id_ed25519')} lies in ${ssh}, which stays on its machine`,
      `${path.join(s.mac, '.claude.json')} stays on its machine`,
    ].sort());
    expect(inv.roots.filter((r) => blocked.includes(r.path))).toEqual([]);
    expect(inv.roots.some((r) => r.path === path.join(claude, 'skills'))).toBe(true);
  });

  it('blocks the default agent homes beside the configured ones, and Svall\'s own install, on either machine', () => {
    const s = seed();
    const configured = path.join(s.mac, 'claude-config');
    const fallback = path.join(s.mac, '.claude');
    for (const d of [configured, fallback, path.join(s.mac, '.local/share/svall/gateway'), path.join(s.mac, '.config/svall')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(fallback, '.credentials.json'), '{}');
    // the daemon runs with CLAUDE_CONFIG_DIR set, and a shell without it logs in to ~/.claude
    s.maps.source.agentHomes = { claude: configured };
    s.state.characters.fallback = char('fallback', { cwd: fallback });
    s.state.characters.share = char('share', { cwd: path.join(s.mac, '.local/share') });
    s.state.characters.config = char('config', { cwd: path.join(s.mac, '.config') });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers.filter((b) => b.code === 'path_unsupported').map((b) => b.message).sort()).toEqual([
      `${fallback} holds ${path.join(fallback, '.credentials.json')}, which stays on its machine`,
      `${path.join(s.mac, '.local/share')} holds ${path.join(s.mac, '.local/share/svall')}, which stays on its machine`,
      `${path.join(s.mac, '.config')} holds ${path.join(s.mac, '.config/svall')}, which stays on its machine`,
    ].sort());
  });

  it('follows the fleet home to its real path before deciding a root is clear of it', () => {
    const s = seed();
    const fleetHome = path.join(s.mac, '.svall');
    fs.mkdirSync(path.join(fleetHome, 'hooks'));
    fs.symlinkSync(fleetHome, path.join(s.mac, 'svall-link'));
    s.maps.source.fleetHome = path.join(s.mac, 'svall-link');
    s.state.characters.idle.cwd = path.join(fleetHome, 'hooks');
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining(`overlaps the fleet home ${path.join(s.mac, 'svall-link')}`) })]);
    expect(inv.roots.some((r) => r.path === path.join(fleetHome, 'hooks'))).toBe(false);
  });

  it('carries a path inside mission control with mission control, not as an overlap of the fleet home', () => {
    const s = seed();
    const notes = path.join(s.mac, '.svall/home/notes.md');
    fs.writeFileSync(notes, 'notes');
    s.state.characters.w2.context.push({ kind: 'file', ref: notes, label: '', source: 'manual' });
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps);
    expect(inv.blockers).toEqual([]);
    expect(inv.roots.some((r) => r.path === notes)).toBe(false);
    expect(inv.roots.find((r) => r.kind === 'home')?.path).toBe(path.join(s.mac, '.svall/home'));
    // mission control set to the fleet home itself exempts nothing, itself included
    const whole = buildInventory(s.state, { fleet: { ...FLEET, home: { ...FLEET.home, cwd: '~/.svall' } } }, s.maps);
    expect(whole.blockers.map((b) => b.message).sort()).toEqual([
      `${path.join(s.mac, '.svall')} overlaps the fleet home ${path.join(s.mac, '.svall')}, whose token, keys and node.json stay on their machine`,
      `${notes} overlaps the fleet home ${path.join(s.mac, '.svall')}, whose token, keys and node.json stay on their machine`,
    ].sort());
    expect(whole.roots.some((r) => r.kind === 'home' || r.path === notes)).toBe(false);
  });

  it('blocks mission control\'s folder when another fleet on this machine keeps its mission control there too', () => {
    const s = seed();
    const [own, work] = [path.join(s.mac, '.svall'), path.join(s.mac, '.svall-work')];
    const mission = path.join(own, 'home');
    fs.mkdirSync(work);
    const fleetJson = (home: string, o: object) => fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET.id, ...o }));
    fleetJson(own, {});
    // both fleets on the default
    fleetJson(work, {});
    const said = (other: string) => `${mission} is mission control's folder for this fleet and for the fleet in ${other}, and a handover would move it away from that fleet; give one of them its own folder with home.cwd in its fleet.json`;
    const blocked = (maps: MachineMaps) => {
      const inv = buildInventory(s.state, { fleet: FLEET }, maps);
      return inv.blockers.map((b) => ({ ...b, entity: b.entity?.id === inv.roots.find((r) => r.kind === 'home')?.id ? 'mission' : b.entity }));
    };
    expect(blocked(s.maps)).toEqual([{ code: 'mission_control_shared', message: said(work), entity: 'mission' }]);
    // the named fleet is refused the same, though the folder lies in the other's fleet home
    const named = { source: { ...s.maps.source, fleetHome: work }, destination: { ...s.maps.destination, fleetHome: work } };
    expect(blocked(named)).toEqual([{ code: 'mission_control_shared', message: said(own), entity: 'mission' }]);
    fleetJson(work, { home: { cwd: '~/.svall-work/home' } });
    expect(blocked(s.maps)).toEqual([]);
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
    expect(inv.roots.some((r) => r.path === path.join(s.plain, 'build'))).toBe(false);
    expect(inv.roots.find((r) => r.path === site)).toMatchObject({ kind: 'context', entry: 'dir' });
    expect(inv.roots.find((r) => r.path === site)!.foldedInto).toBeUndefined();
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
    return { bare, bw, discovery: { graphs, blockers: [] as Blocker[], warnings } };
  }

  it('carries each graph: its main checkout, a common directory outside any checkout, and each used worktree, each once', () => {
    const s = seed();
    const d = discovered(s);
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery);
    expect(inv.blockers).toEqual([]);
    const rel = (p: string): string => path.relative(s.mac, p);
    const git = inv.roots.filter((r) => ['repo', 'worktree', 'gitdir'].includes(r.kind));
    expect(git.map((r) => [r.kind, rel(r.path), r.foldedInto && rel(inv.roots.find((o) => o.id === r.foldedInto)!.path)])).toEqual([
      ['repo', 'code/app', undefined],
      ['worktree', 'code/app-w2', undefined],
      ['worktree', 'code/app/.claude/worktrees/w1', 'code/app'],
      ['gitdir', 'code/app/.git/modules/sub', 'code/app'],
      ['repo', 'code/app/sub', 'code/app'],
      ['worktree', 'code/tool-wt', undefined],
      ['gitdir', 'code/tool.git', undefined],
    ]);
    // the parent a recorded bare repository names is no root: the graph says where its common directory is
    expect(inv.roots.some((r) => r.path === path.join(s.mac, 'code'))).toBe(false);
    expect(inv.git).toEqual(d.discovery.graphs);
    expect(inv.warnings).toEqual(d.discovery.warnings);
  });

  it('blocks a graph root reached through a link, as the graph\'s, and keeps what discovery blocked', () => {
    const s = seed();
    const d = discovered(s);
    const linked = path.join(s.base, 'tool-link');
    fs.symlinkSync(d.bw, linked);
    d.discovery.graphs[2].worktrees[0].path = linked;
    const found: Blocker = { code: 'worktree_unresolved', message: 'git refused', entity: { kind: 'character', id: 'w1' } };
    d.discovery.blockers.push(found);
    const inv = buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery);
    expect(inv.blockers).toEqual([
      { code: 'path_symlinked', message: expect.stringMatching(`^${linked} leads to ${d.bw} through a symbolic link`), entity: { kind: 'git', id: 'g_tool' } },
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
    expect(inv.roots.some((r) => r.path === kept)).toBe(false);
    expect(inv.roots.find((r) => r.path === cached)).toMatchObject({ kind: 'context' });
    expect(inv.roots.find((r) => r.path === cached)!.foldedInto).toBeUndefined();
    const inGitDir = rootMatcher('gitdir', DEFAULT_EXCLUDES);
    expect(['refs/heads/build', 'logs/refs/heads/dist', 'worktrees/node_modules', 'modules/target'].some((p) => inGitDir(p, true))).toBe(false);
    // a checkout kept inside it is read like any other
    expect(inGitDir('main/node_modules', true)).toBe(true);
    expect(inGitDir('build', true)).toBe(true);
    expect(rootMatcher('repo', DEFAULT_EXCLUDES)('refs/heads/build', true)).toBe(true);
  });

  it('blocks a Git directory folded into a folder whose excludes would leave some of Git\'s own entries behind, and folds one they leave whole', () => {
    const s = seed();
    const d = discovered(s);
    const code = path.join(s.mac, 'code');
    s.state.characters.plain = char('plain', { cwd: code });
    const write = (...files: string[]) => files.forEach((f) => {
      fs.mkdirSync(path.dirname(path.join(d.bare, f)), { recursive: true });
      fs.writeFileSync(path.join(d.bare, f), 'x\n');
    });
    // a ref named build is a file, which the build/ exclude leaves alone, and a build folder beside Git's entries is a cache
    write('HEAD', 'refs/heads/main', 'refs/heads/build', 'worktrees/tool-wt/HEAD', 'build/out.js');
    const clean = buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery);
    expect(clean.blockers).toEqual([]);
    const outer = clean.roots.find((r) => r.path === code)!;
    const gitdir = clean.roots.find((r) => r.path === d.bare)!;
    expect(gitdir).toMatchObject({ kind: 'gitdir', foldedInto: outer.id });
    // a branch under build/ and a worktree named dist, whose folders the default excludes match
    fs.rmSync(path.join(d.bare, 'refs/heads/build'));
    write('refs/heads/build/fix', 'worktrees/dist/HEAD');
    expect(buildInventory(s.state, { fleet: FLEET }, s.maps, d.discovery).blockers).toEqual([{
      code: 'path_unsupported', entity: { kind: 'root', id: gitdir.id },
      message: `${d.bare}: ${code} carries this Git directory under the fleet's excludes, which would leave behind refs/heads/build, worktrees/dist; move the repository out of ${code}, or take the pattern that matches out of handover.exclude in fleet.json (with excludeDefaults: false for a default one)`,
    }]);
  });

  // git names each checkout by its real path, as ~/code to /Volumes/work/code resolves
  it.skipIf(!hasGit)('carries a repository by the real path git names it by, and blocks the character that reached it through a link (needs git)', async () => {
    const base = tmp();
    fs.writeFileSync(path.join(base, 'gitconfig'), '');
    const home = path.join(base, 'home');
    const disk = path.join(base, 'disk/code');
    const declared = path.join(home, 'code');
    const outside = path.join(base, 'elsewhere/lone');
    for (const repo of [path.join(disk, 'app'), outside]) {
      fs.mkdirSync(repo, { recursive: true });
      git(base, repo, 'init', '-q');
      git(base, repo, 'commit', '-q', '--allow-empty', '-m', 'first');
    }
    fs.mkdirSync(home);
    fs.symlinkSync(disk, declared);
    const state = emptyState();
    state.characters = { app: char('app', { cwd: path.join(declared, 'app') }), lone: char('lone', { cwd: outside }) };
    const maps: MachineMaps = {
      source: { machineId: MAC, home, fleetHome: path.join(home, '.svall') },
      destination: { machineId: TRIFT, home, fleetHome: path.join(home, '.svall') },
    };
    const discovery = await discoverGit(state, { excludes: DEFAULT_EXCLUDES });
    expect(discovery.blockers).toEqual([]);
    const inv = buildInventory(state, { fleet: FLEET }, maps, discovery);
    expect(inv.roots.map((r) => [r.kind, r.path])).toEqual([
      ['repo', path.join(disk, 'app')],
      ['repo', outside],
      ['home', path.join(home, '.svall/home')],
    ]);
    expect(inv.blockers).toEqual([expect.objectContaining({ code: 'path_symlinked', entity: { kind: 'character', id: 'app' } })]);
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
