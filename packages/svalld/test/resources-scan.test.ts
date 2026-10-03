import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, HOME_ISLAND, type FleetState, type ResourceSource } from '@svall/protocol';
import { docsDir, repoSlug } from '../src/docs.js';
import { claudePaths } from '../src/paths.js';
import { fleetRoots, resourceRoot, rootIdOf, scanResources } from '../src/resources/scan.js';
import { cleanHomes, makeHome } from './helpers.js';

const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (name: string, d: string) => `---\nname: ${name}\ndescription: ${d}\n---\n# ${name}\n`;

// only the fields the scan reads
const char = (id: string, islandId: string, cwd: string, mainRoot?: string) =>
  ({ id, name: id, islandId, cwd, ...(mainRoot && { repo: { root: cwd, mainRoot, branch: 'main', isWorktree: cwd !== mainRoot } }) });
const stateOf = (...chars: ReturnType<typeof char>[]): FleetState =>
  ({ ...emptyState(), characters: Object.fromEntries(chars.map((c) => [c.id, c])) }) as unknown as FleetState;
const withIslands = (s: FleetState, ...islands: { id: string; name: string }[]): FleetState =>
  ({ ...s, islands: Object.fromEntries(islands.map((i) => [i.id, i])) }) as unknown as FleetState;
const docText = (d: string, name = 'other') => `---\nname: ${name}\ndescription: ${d}\n---\n`;

const kinds = (s: ResourceSource) => Object.fromEntries(s.groups.map((g) => [g.kind, g.items.map((i) => i.name)]));

describe('claudePaths', () => {
  it('is ~/.claude and ~/.claude.json', () => {
    expect(claudePaths({}, '/h')).toEqual({ dir: '/h/.claude', json: '/h/.claude.json' });
  });
  it('follows CLAUDE_CONFIG_DIR', () => {
    expect(claudePaths({ CLAUDE_CONFIG_DIR: '/x/cfg' }, '/h')).toEqual({ dir: '/x/cfg', json: '/x/cfg/.claude.json' });
  });
});

describe('fleetRoots', () => {
  it('folds worktrees into their repository and leaves mission control out', () => {
    const s = stateOf(char('a', 'i1', '/r/app', '/r/app'), char('b', 'i2', '/r/app/.claude/worktrees/x', '/r/app'), char('c', 'i2', '/plain'), char('h', HOME_ISLAND, '/home'));
    expect(fleetRoots(s)).toEqual([
      { root: '/plain', islandIds: ['i2'], characterIds: ['c'] },
      { root: '/r/app', islandIds: ['i1', 'i2'], characterIds: ['a', 'b'] },
    ]);
  });
});

describe('resourceRoot', () => {
  const claude = { dir: '/h/.claude', json: '/h/.claude.json' };
  const state = stateOf(char('a', 'i1', '/r/app/.claude/worktrees/x', '/r/app'));
  it('answers the Claude dir and a folder the fleet works in', () => {
    expect(resourceRoot('r:/h/.claude', state, claude)).toBe('/h/.claude');
    expect(resourceRoot('r:/r/app', state, claude)).toBe('/r/app');
  });
  it('refuses any other path, and an id that is not a root id', () => {
    expect(resourceRoot('r:/etc', state, claude)).toBeUndefined();
    expect(resourceRoot('r:/h', state, claude)).toBeUndefined();
    expect(resourceRoot('a', state, claude)).toBeUndefined();
  });
});

describe('scanResources', () => {
  afterEach(cleanHomes);

  function disk() {
    const home = makeHome();
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    const repo = path.join(home, 'work/app');
    const bare = path.join(home, 'work/bare');
    fs.mkdirSync(bare, { recursive: true });
    put(path.join(claude.dir, 'CLAUDE.md'), '# me');
    put(path.join(claude.dir, 'skills/ship-it/SKILL.md'), skill('ship-it', 'Commit, PR and merge'));
    put(path.join(claude.dir, 'skills/ship-it/references/a.md'), 'a');
    fs.mkdirSync(path.join(claude.dir, 'skills/synced'), { recursive: true });
    put(path.join(claude.dir, 'agents/reviewer.md'), '---\nname: reviewer\ndescription: Reviews\n---');
    put(path.join(claude.dir, 'commands/rename-tab.md'), '---\ndescription: Rename the tab\n---');
    put(path.join(claude.dir, 'commands/git/sync.md'), 'sync');
    put(path.join(claude.dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'slack@official': true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
    put(path.join(claude.dir, 'keybindings.json'), '{}');
    put(path.join(claude.dir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'slack@official': [{ installPath: path.join(claude.dir, 'plugins/cache/slack') }] } }));
    put(claude.json, JSON.stringify({
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer top-secret' } } },
      projects: { [repo]: { mcpServers: { scoped: { command: 'npx x', env: { K: 'top-secret' } } } } },
    }));
    put(path.join(repo, 'CLAUDE.md'), '# app');
    put(path.join(repo, 'AGENTS.md'), '# agents');
    put(path.join(repo, '.claude/skills/prepush/SKILL.md'), skill('prepush', 'Before pushing'));
    put(path.join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'y' }] }] } }));
    put(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node server.js' } } }));
    put(path.join(claude.dir, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'), 'memory/MEMORY.md'), '- x');
    const state = stateOf(char('a', 'i1', repo, repo), char('b', 'i1', bare));
    return { claude, repo, bare, state };
  }

  it('lists the user scope first, with every kind it has', () => {
    const { claude, state } = disk();
    const [user] = scanResources(state, claude);
    expect(user).toMatchObject({ rootId: rootIdOf(claude.dir), root: claude.dir, name: 'Claude', tier: 'global', islandIds: [], characterIds: [] });
    expect(kinds(user)).toEqual({
      instructions: ['CLAUDE.md'], skills: ['ship-it'], agents: ['reviewer'], commands: ['git:sync', 'rename-tab'],
      plugins: ['slack'], mcp: ['linear'], hooks: ['Stop'], settings: ['settings.json', 'keybindings.json'],
    });
  });

  it('gives a skill its file, its folder and its description', () => {
    const { claude, state } = disk();
    const item = scanResources(state, claude)[0].groups.find((g) => g.kind === 'skills')!.items[0];
    expect(item).toEqual({
      id: `skills\u0000${path.join(claude.dir, 'skills/ship-it')}\u0000ship-it`,
      name: 'ship-it', detail: 'Commit, PR and merge', reveal: path.join(claude.dir, 'skills/ship-it'), target: 'folder',
      open: { rootId: rootIdOf(claude.dir), path: 'skills/ship-it/SKILL.md', folder: 'skills/ship-it' },
    });
  });

  it('tags a repository skill with the agent folder it came from, so one shipped to both is told apart', () => {
    const { claude, repo, state } = disk();
    put(path.join(repo, '.codex/skills/prepush/SKILL.md'), skill('prepush', 'Before pushing'));
    const rows = scanResources(state, claude).find((s) => s.root === repo)!.groups.find((g) => g.kind === 'skills')!.items;
    expect(rows.map((r) => [r.name, r.tag])).toEqual([['prepush', 'claude'], ['prepush', 'codex']]);
    expect(scanResources(state, claude)[0].groups.find((g) => g.kind === 'skills')!.items[0].tag).toBeUndefined();
  });

  it('opens a hook and a plugin in settings.json, and never ~/.claude.json', () => {
    const { claude, state } = disk();
    const g = (k: string) => scanResources(state, claude)[0].groups.find((x) => x.kind === k)!.items[0];
    expect(g('hooks').open).toEqual({ rootId: rootIdOf(claude.dir), path: 'settings.json', find: '"Stop"' });
    expect(g('plugins')).toMatchObject({ target: 'folder', reveal: path.join(claude.dir, 'plugins/cache/slack'), open: { path: 'settings.json', find: '"slack@official"' } });
    expect(g('mcp')).toEqual({ id: `mcp\u0000${claude.json}\u0000linear`, name: 'linear', detail: 'http · mcp.linear.app', reveal: claude.json, target: 'file' });
  });

  it('tells apart the rows of a kind that share one file', () => {
    const { claude, state } = disk();
    put(path.join(claude.dir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'slack@official': true },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'y' }] }] },
    }));
    put(path.join(claude.dir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'slack@official': [{}], 'jira@official': [{}] } }));
    put(claude.json, JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' }, figma: { command: 'npx figma' } } }));
    const user = scanResources(state, claude)[0];
    const ids = (k: string) => user.groups.find((g) => g.kind === k)!.items.map((i) => i.id);
    expect(new Set(ids('hooks')).size).toBe(2);
    expect(new Set(ids('plugins')).size).toBe(2);
    expect(new Set(ids('mcp')).size).toBe(2);
  });

  it('lists every repository the fleet works in, with what each one has', () => {
    const { claude, repo, state } = disk();
    const sources = scanResources(state, claude);
    expect(sources.map((s) => s.name)).toEqual(['Claude', 'app', 'bare']);
    const app = sources[1];
    expect(app).toMatchObject({ rootId: rootIdOf(repo), root: repo, tier: 'repo', islandIds: ['i1'], characterIds: ['a'] });
    expect(kinds(app)).toEqual({
      instructions: ['CLAUDE.md', 'AGENTS.md'], skills: ['prepush'], mcp: ['local', 'scoped'], hooks: ['PreToolUse'],
      settings: ['settings.json'], autoMemory: ['MEMORY.md'],
    });
    const mcp = app.groups.find((g) => g.kind === 'mcp')!.items;
    expect(mcp[0].open).toEqual({ rootId: rootIdOf(repo), path: '.mcp.json', find: '"local"' });
    expect(mcp[1].open).toBeUndefined();
    const memory = app.groups.find((g) => g.kind === 'autoMemory')!.items[0];
    expect(memory.open!.rootId).toBe(rootIdOf(claude.dir));
  });

  it('lets no secret out of ~/.claude.json', () => {
    const { claude, state } = disk();
    expect(JSON.stringify(scanResources(state, claude))).not.toMatch(/top-secret/);
  });

  it('never walks a symlinked folder, so a cycle ends', () => {
    const { claude, state } = disk();
    fs.symlinkSync('../commands', path.join(claude.dir, 'commands/loop'));
    expect(kinds(scanResources(state, claude)[0]).commands).toEqual(['git:sync', 'rename-tab']);
  });

  it('walks a repository commands folder only inside the repository, and the user own linked one wherever it leads', () => {
    const { claude, repo, state } = disk();
    const elsewhere = makeHome();
    put(path.join(elsewhere, 'deep/a/b.md'), 'b');
    fs.symlinkSync(elsewhere, path.join(repo, '.claude/commands'));
    expect(kinds(scanResources(state, claude).find((s) => s.root === repo)!).commands).toBeUndefined();
    fs.renameSync(path.join(claude.dir, 'commands'), path.join(elsewhere, 'mine'));
    fs.symlinkSync(path.join(elsewhere, 'mine'), path.join(claude.dir, 'commands'));
    expect(kinds(scanResources(state, claude)[0]).commands).toEqual(['git:sync', 'rename-tab']);
  });

  it('reads neither a link to a device nor a file too big to be one it lists', () => {
    const { claude, repo, state } = disk();
    fs.rmSync(path.join(repo, 'CLAUDE.md'));
    fs.symlinkSync('/dev/null', path.join(repo, 'CLAUDE.md'));
    fs.truncateSync(path.join(repo, 'AGENTS.md'), 2 * 1024 * 1024);
    const app = scanResources(state, claude).find((s) => s.root === repo)!;
    expect(kinds(app).instructions).toBeUndefined();
    // ~/.claude.json is the user's own and is read whatever its size
    put(claude.json, JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }, pad: 'x'.repeat(2 * 1024 * 1024) }));
    expect(kinds(scanResources(state, claude)[0]).mcp).toEqual(['linear']);
  });

  // it runs to megabytes, and every listing change asks for the resources again
  it('parses ~/.claude.json again only once it changes', () => {
    const { claude, state } = disk();
    // the same size and time each, so only a reread could tell them apart
    const write = (name: string, at = 1_700_000_000) => { put(claude.json, JSON.stringify({ mcpServers: { [name]: { command: 'x' } } })); fs.utimesSync(claude.json, at, at); };
    write('aaaa');
    expect(kinds(scanResources(state, claude)[0]).mcp).toEqual(['aaaa']);
    write('bbbb');
    expect(kinds(scanResources(state, claude)[0]).mcp).toEqual(['aaaa']);
    write('bbbb', 1_700_000_001);
    expect(kinds(scanResources(state, claude)[0]).mcp).toEqual(['bbbb']);
  });

  it('lists a skill installed as a link, to be shown in Finder and opened nowhere else', () => {
    const { claude, state } = disk();
    const elsewhere = makeHome();
    put(path.join(elsewhere, 'ship-out/SKILL.md'), skill('ship-out', 'From elsewhere'));
    fs.symlinkSync(path.join(elsewhere, 'ship-out'), path.join(claude.dir, 'skills/ship-out'));
    fs.symlinkSync(path.join(elsewhere, 'gone'), path.join(claude.dir, 'skills/dangling'));
    const items = scanResources(state, claude)[0].groups.find((g) => g.kind === 'skills')!.items;
    expect(items.map((i) => i.name)).toEqual(['ship-it', 'ship-out']);
    expect(items[1]).toEqual({ id: `skills\u0000${path.join(claude.dir, 'skills/ship-out')}\u0000ship-out`, name: 'ship-out', detail: 'From elsewhere', reveal: path.join(claude.dir, 'skills/ship-out'), target: 'folder' });
  });

  it('turns a file it cannot parse into a row that says so', () => {
    const { claude, state } = disk();
    fs.writeFileSync(path.join(claude.dir, 'settings.json'), '{ not json');
    const user = scanResources(state, claude)[0];
    expect(user.groups.find((g) => g.kind === 'hooks')!.items).toEqual([
      { id: `hooks\u0000${path.join(claude.dir, 'settings.json')}\u0000settings.json`, name: 'settings.json', error: 'cannot be read as JSON', reveal: path.join(claude.dir, 'settings.json'), target: 'file', open: { rootId: rootIdOf(claude.dir), path: 'settings.json' } },
    ]);
  });

  it('answers an empty user scope when there is no ~/.claude at all', () => {
    const home = makeHome();
    expect(scanResources(stateOf(), { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') })).toEqual([
      { rootId: rootIdOf(path.join(home, '.claude')), root: path.join(home, '.claude'), name: 'Claude', tier: 'global', islandIds: [], characterIds: [], groups: [] },
    ]);
  });
});

describe('doc sources', () => {
  afterEach(cleanHomes);

  it('lists islands and characters even with no docs, and a repository carries its docs beside its other kinds', () => {
    const home = makeHome(), docs = path.join(home, 'docs');
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    put(path.join(home, 'app/CLAUDE.md'), '# app');
    put(path.join(docsDir(docs, 'repo', repoSlug(path.join(home, 'app'))), 'conventions.md'), docText('House style.'));
    put(path.join(docsDir(docs, 'island', 'i1'), 'architecture.md'), docText('How it fits.', 'Renamed In Frontmatter'));
    const state = withIslands(stateOf(char('c1', 'i1', path.join(home, 'app'), path.join(home, 'app'))), { id: 'i1', name: 'SVALL' });

    const sources = scanResources(state, claude, undefined, docs);
    expect(sources.map((s) => [s.tier, s.name])).toEqual([['global', 'Claude'], ['fleet', path.basename(home)], ['repo', 'app'], ['island', 'SVALL'], ['character', 'c1']]);

    const repo = sources[2];
    expect(repo.root).toBe(path.join(home, 'app'));
    expect(repo.docs).toBe(rootIdOf(docsDir(docs, 'repo', repoSlug(path.join(home, 'app')))));
    expect(kinds(repo)).toMatchObject({ docs: ['conventions'], instructions: ['CLAUDE.md'] });
    expect(repo.groups[0].items[0].open).toEqual({ rootId: repo.docs, path: 'conventions.md' });

    const island = sources[3];
    expect(island).toMatchObject({ rootId: rootIdOf(docsDir(docs, 'island', 'i1')), docs: rootIdOf(docsDir(docs, 'island', 'i1')), islandIds: ['i1'], characterIds: ['c1'] });
    expect(island.groups[0].items[0]).toMatchObject({ name: 'architecture', detail: 'How it fits.' });

    expect(sources[4]).toMatchObject({ tier: 'character', islandIds: ['i1'], characterIds: ['c1'], groups: [] });
  });

  it('carries the fleet’s own docs as a tier of their own, named for the fleet', () => {
    const home = makeHome(), docs = path.join(home, '.svall-work', 'docs');
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    put(path.join(docs, 'fleet', 'tone.md'), docText('How we talk to each other.'));
    const sources = scanResources(stateOf(), claude, undefined, docs);
    const fleet = sources.find((s) => s.tier === 'fleet')!;
    expect(fleet).toMatchObject({ name: 'work', root: path.join(docs, 'fleet'), islandIds: [], characterIds: [] });
    expect(fleet.docs).toBe(rootIdOf(path.join(docs, 'fleet')));
    expect(kinds(fleet)).toEqual({ docs: ['tone'] });
    expect(sources.filter((s) => s.tier === 'global').map((s) => s.name)).toEqual(['Claude']);
    expect(scanResources({ ...stateOf(), name: 'office' }, claude, undefined, docs).find((s) => s.tier === 'fleet')?.name).toBe('office');
    // a new doc has somewhere to go before anything is written there
    expect(scanResources(stateOf(), claude, undefined, path.join(home, 'empty')).find((s) => s.tier === 'fleet')).toMatchObject({ groups: [] });
    // with nowhere to keep docs there is no such source at all
    expect(scanResources(stateOf(), claude).some((s) => s.tier === 'fleet')).toBe(false);
  });

  it('gives the fleet’s source its agent profiles, and their folder as the place a new one goes', () => {
    const home = makeHome(), docs = path.join(home, 'docs'), profiles = path.join(home, 'agent-profiles');
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    put(path.join(profiles, 'reviewer.md'), '---\ndescription: Reviews code\n---\n\nYou are a reviewer.');
    put(path.join(profiles, 'blank.md'), '');
    const fleet = scanResources(stateOf(), claude, undefined, docs, profiles).find((s) => s.tier === 'fleet')!;
    expect(fleet.agentProfiles).toBe(rootIdOf(profiles));
    expect(fleet.groups.find((g) => g.kind === 'agentProfiles')!.items).toMatchObject([
      { name: 'blank', error: 'has no text', open: { rootId: rootIdOf(profiles), path: 'blank.md' } },
      { name: 'reviewer', detail: 'Reviews code', open: { rootId: rootIdOf(profiles), path: 'reviewer.md' } },
    ]);
    expect(resourceRoot(rootIdOf(profiles), stateOf(), claude, undefined, docs, profiles)).toBe(profiles);
    expect(resourceRoot(rootIdOf(profiles), stateOf(), claude, undefined, docs)).toBeUndefined();
  });

  it('lists a repository the fleet works in even when it holds nothing yet', () => {
    const home = makeHome();
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    const sources = scanResources(stateOf(char('c1', 'i1', '/empty/repo', '/empty/repo')), claude, undefined, path.join(home, 'docs'));
    expect(sources.filter((s) => s.tier === 'repo').map((s) => s.name)).toEqual(['repo']);
  });

  it('lists a slug with docs and no character under its slug, and leaves an empty slug folder out', () => {
    const home = makeHome(), docs = path.join(home, 'docs');
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    put(path.join(docs, 'repos/gone-0a1b2c3d/notes.md'), docText('Left behind.'));
    fs.mkdirSync(path.join(docs, 'repos/empty-00000000'), { recursive: true });
    const orphans = scanResources(stateOf(), claude, undefined, docs).filter((s) => s.tier === 'repo');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ name: 'gone-0a1b2c3d', root: path.join(docs, 'repos/gone-0a1b2c3d'), characterIds: [] });
    expect(kinds(orphans[0])).toEqual({ docs: ['notes'] });
  });

  it('shows an unreadable doc with its error', () => {
    const home = makeHome(), docs = path.join(home, 'docs');
    const claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
    put(path.join(docsDir(docs, 'island', 'i1'), 'blob.md'), 'a\u0000b');
    const island = scanResources(withIslands(stateOf(), { id: 'i1', name: 'one' }), claude, undefined, docs).find((s) => s.tier === 'island')!;
    expect(island.groups[0].items[0]).toMatchObject({ name: 'blob', error: 'is not text' });
  });
});

describe('resourceRoot for docs', () => {
  afterEach(cleanHomes);
  const claude = { dir: '/h/.claude', json: '/h/.claude.json' };

  it('admits an island’s, a character’s and a repository’s folder, made or not', () => {
    const docs = path.join(makeHome(), 'docs');
    const state = withIslands(stateOf(char('c1', 'i1', '/r/app', '/r/app')), { id: 'i1', name: 'one' });
    for (const dir of [docsDir(docs, 'island', 'i1'), docsDir(docs, 'character', 'c1'), docsDir(docs, 'repo', repoSlug('/r/app'))])
      expect(resourceRoot(rootIdOf(dir), state, claude, undefined, docs)).toBe(dir);
  });

  it('admits the fleet’s own folder, made or not, and nothing beside it', () => {
    const docs = path.join(makeHome(), 'docs');
    const dir = path.join(docs, 'fleet');
    expect(resourceRoot(rootIdOf(dir), stateOf(), claude, undefined, docs)).toBe(dir);
    fs.mkdirSync(dir, { recursive: true });
    expect(resourceRoot(rootIdOf(dir), stateOf(), claude, undefined, docs)).toBe(dir);
    for (const other of [path.join(docs, 'fleets'), path.join(dir, 'sub'), docs])
      expect(resourceRoot(rootIdOf(other), stateOf(), claude, undefined, docs)).toBeUndefined();
  });

  it('admits a slug the fleet has left when its folder is on disk', () => {
    const docs = path.join(makeHome(), 'docs');
    fs.mkdirSync(path.join(docs, 'repos/gone-0a1b2c3d'), { recursive: true });
    expect(resourceRoot(rootIdOf(path.join(docs, 'repos/gone-0a1b2c3d')), stateOf(), claude, undefined, docs)).toBe(path.join(docs, 'repos/gone-0a1b2c3d'));
    expect(resourceRoot(rootIdOf(path.join(docs, 'repos/never-00000000')), stateOf(), claude, undefined, docs)).toBeUndefined();
  });

  it('refuses an unknown entity, the tree itself, a deeper path and a climb out', () => {
    const docs = path.join(makeHome(), 'docs');
    const state = withIslands(stateOf(), { id: 'i1', name: 'one' });
    for (const dir of [docsDir(docs, 'island', 'nope'), docs, path.join(docs, 'islands'), path.join(docs, 'islands/i1/sub'), path.join(docs, 'islands/i1/../../..'), path.join(docs, 'elsewhere/i1')])
      expect(resourceRoot(rootIdOf(dir), state, claude, undefined, docs)).toBeUndefined();
  });

  it('refuses an id that climbs out and back in as a literal string, before path.join would normalise it', () => {
    const docs = path.join(makeHome(), 'docs');
    const state = { ...withIslands(stateOf(char('c1', 'i1', '/cwd')), { id: 'i1', name: 'one' }) };
    expect(resourceRoot(`r:${docs}/islands/i1/../../characters/c1`, state, claude, undefined, docs)).toBeUndefined();
  });

  it('refuses a plain file standing where a slug folder would be', () => {
    const docs = path.join(makeHome(), 'docs');
    fs.mkdirSync(path.join(docs, 'repos'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'repos/notes.md'), '# notes');
    expect(resourceRoot(rootIdOf(path.join(docs, 'repos/notes.md')), stateOf(), claude, undefined, docs)).toBeUndefined();
  });

  it('refuses a folder that is a link out of the tree', () => {
    const home = makeHome(), docs = path.join(home, 'docs');
    fs.mkdirSync(path.join(home, 'outside'));
    fs.mkdirSync(path.join(docs, 'islands'), { recursive: true });
    fs.symlinkSync(path.join(home, 'outside'), path.join(docs, 'islands/i1'));
    expect(resourceRoot(rootIdOf(path.join(docs, 'islands/i1')), withIslands(stateOf(), { id: 'i1', name: 'one' }), claude, undefined, docs)).toBeUndefined();
  });

  it('admits no docs root when no docs path is given', () => {
    expect(resourceRoot(rootIdOf('/d/islands/i1'), withIslands(stateOf(), { id: 'i1', name: 'one' }), claude)).toBeUndefined();
  });
});
