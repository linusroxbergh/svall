import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { frontmatter, type FleetState, type ResourceGroup, type ResourceItem, type ResourceKind, type ResourceSource } from '@svall/protocol';
import { listAgentProfiles } from '../agent-profiles.js';
import type { CodexPaths } from '../codex/install.js';
import { docsDir, fleetDir, listDocs, repoRootOf, repoSlug } from '../docs.js';
import { NotFound } from '../errors.js';
import type { ClaudePaths } from '../paths.js';
import { profileOf } from '../profile.js';
import { realOf, within } from '../workspace/paths.js';
import { hooks, mcpServers, plugins, type Parsed } from './parse.js';

export const rootIdOf = (root: string): string => `r:${root}`;

export type FleetRoot = { root: string; islandIds: string[]; characterIds: string[] };

/** The folders the fleet works in, a worktree counted as its repository, mission control left out. */
export function fleetRoots(state: FleetState): FleetRoot[] {
  const by = new Map<string, FleetRoot>();
  for (const c of Object.values(state.characters)) {
    const root = repoRootOf(c);
    if (root === undefined) continue;
    const r = by.get(root) ?? { root, islandIds: [], characterIds: [] };
    if (!r.islandIds.includes(c.islandId)) r.islandIds.push(c.islandId);
    r.characterIds.push(c.id);
    by.set(root, r);
  }
  return [...by.values()].map((r) => ({ ...r, islandIds: r.islandIds.sort(), characterIds: r.characterIds.sort() })).sort((a, b) => a.root.localeCompare(b.root));
}

// <docs>/islands/<id>, <docs>/characters/<id> or <docs>/repos/<slug>, for an entity the fleet has or a slug folder on disk;
// the folder may itself be a link out of the tree, so it is judged by where its closest existing ancestor really is
function isDocsRoot(root: string, state: FleetState, docs: string): boolean {
  // the fleet's own folder names no entity, so it is known by its place alone
  if (root === fleetDir(docs)) { const r = realOf(root), rd = realOf(docs); return r !== undefined && rd !== undefined && within(r, rd); }
  const [tree, id, ...rest] = path.relative(docs, root).split(path.sep);
  if (rest.length || !id || root !== path.join(docs, tree, id)) return false;
  const known = tree === 'islands' ? Object.hasOwn(state.islands, id)
    : tree === 'characters' ? Object.hasOwn(state.characters, id)
    : tree === 'repos' && (fleetRoots(state).some((r) => repoSlug(r.root) === id) || fs.statSync(root, { throwIfNoEntry: false })?.isDirectory() === true);
  if (!known) return false;
  const real = realOf(root), realDocs = realOf(docs);
  return real !== undefined && realDocs !== undefined && within(real, realDocs);
}

/** The folder a resource root id names, when it is the Claude dir, the Codex dir, a folder the fleet works in now, a docs folder or the agent profiles. */
export function resourceRoot(id: string, state: FleetState, claude: ClaudePaths, codex?: CodexPaths, docs?: string, agentProfiles?: string): string | undefined {
  if (!id.startsWith('r:')) return undefined;
  const root = id.slice(2);
  if (root === claude.dir || root === codex?.dir || root === agentProfiles || fleetRoots(state).some((r) => r.root === root)) return root;
  return docs !== undefined && isDocsRoot(root, state, docs) ? root : undefined;
}

/** The folder a workspace id names: a resource root when the id is one, else the character's own folder. */
export function workspaceRoot(id: string, state: FleetState, claude: ClaudePaths, codex?: CodexPaths, docs?: string, agentProfiles?: string): string {
  const res = resourceRoot(id, state, claude, codex, docs, agentProfiles);
  if (res) return res;
  if (!Object.hasOwn(state.characters, id)) throw new NotFound(`no character ${id}`);
  const c = state.characters[id];
  return c.repo?.root ?? c.cwd;
}

type Base = { rootId: string; root: string };
// the kind stamps the id, so a row is built without one
type Row = Omit<ResourceItem, 'id'>;

// a committed link can lead to a device or a huge file, so only a plain file under the cap is read
const readText = (p: string, max = 1024 * 1024): string | undefined => {
  try { const st = fs.statSync(p); return st.isFile() && st.size <= max ? fs.readFileSync(p, 'utf8') : undefined; } catch { return undefined; }
};
// a link is left out: it may lead in a circle, and what it leads to could not be opened through `inside` anyway
const entries = (dir: string, links = false): fs.Dirent[] => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => links || !d.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { return []; }
};

function readToml(p: string): Record<string, unknown> | Error | undefined {
  const text = readText(p);
  if (text === undefined) return undefined;
  try { return parseToml(text) as Record<string, unknown>; } catch { return new Error('cannot be read as TOML'); }
}

// undefined when the file is not there, an Error when it is there and is not JSON
function readJson(p: string, max?: number): Record<string, unknown> | Error | undefined {
  const text = readText(p, max);
  if (text === undefined) return undefined;
  try { const v: unknown = JSON.parse(text); return v && typeof v === 'object' ? (v as Record<string, unknown>) : new Error('not an object'); }
  catch (e) { return e as Error; }
}

const fileItem = (b: Base, rel: string, p: Partial<Parsed> = {}): Row => ({
  name: p.name ?? path.basename(rel), ...(p.detail && { detail: p.detail }), ...(p.off && { off: true as const }),
  reveal: path.join(b.root, rel), target: 'file', open: { rootId: b.rootId, path: rel, ...(p.find && { find: p.find }) },
});
const broken = (b: Base, rel: string): Row => ({ ...fileItem(b, rel), error: 'cannot be read as JSON' });

// ~/.claude.json keeps every project's history and outgrows the cap, so it is parsed again only once it changes
let claudeJsonRead: { file: string; mtimeMs: number; size: number; json: ReturnType<typeof readJson> } | undefined;
function readClaudeJson(file: string): ReturnType<typeof readJson> {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return undefined; }
  const last = claudeJsonRead;
  if (last?.file === file && last.mtimeMs === st.mtimeMs && last.size === st.size) return last.json;
  const json = readJson(file, Infinity);
  claudeJsonRead = { file, mtimeMs: st.mtimeMs, size: st.size, json };
  return json;
}

const files = (b: Base, rels: string[]): Row[] => rels.filter((rel) => readText(path.join(b.root, rel)) !== undefined).map((rel) => fileItem(b, rel));

// a skill installed as a link reaches the agents like any other, and is read through the link;
// its files lie outside the root, so the row shows it in Finder and opens nothing here
function skills(b: Base, dir: string, tag?: string): Row[] {
  return entries(path.join(b.root, dir), true).flatMap((d) => {
    const folder = `${dir}/${d.name}`;
    const text = readText(path.join(b.root, folder, 'SKILL.md'));
    if (text === undefined) return [];
    const fm = frontmatter(text);
    return [{ name: fm.name ?? d.name, ...(fm.description && { detail: fm.description }), ...(tag && { tag }), reveal: path.join(b.root, folder), target: 'folder' as const,
      ...(!d.isSymbolicLink() && { open: { rootId: b.rootId, path: `${folder}/SKILL.md`, folder } }) }];
  });
}

// a repository's commands are walked to any depth, so a committed link out of the repository is not followed
const own = (b: Base, dir: string): boolean => {
  const real = realOf(path.join(b.root, dir)), root = realOf(b.root);
  return real !== undefined && root !== undefined && within(real, root);
};

// commands nest: git/sync.md is the command git:sync
function markdown(b: Base, dir: string, nested: boolean, prefix = ''): Row[] {
  return entries(path.join(b.root, dir)).flatMap((d): Row[] => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return nested ? markdown(b, rel, true, `${prefix}${d.name}:`) : [];
    if (!d.name.endsWith('.md')) return [];
    const fm = frontmatter(readText(path.join(b.root, rel)) ?? '');
    const bare = d.name.slice(0, -3);
    return [fileItem(b, rel, { name: nested ? `${prefix}${bare}` : fm.name ?? bare, detail: fm.description })];
  }).sort((x, y) => x.name.localeCompare(y.name));
}

// a doc is named for its file, never its frontmatter, and one that cannot be read says so
function docRows(dir: string): Row[] {
  const b: Base = { rootId: rootIdOf(dir), root: dir };
  return listDocs(dir).map((d) => ({ ...fileItem(b, path.basename(d.path), { name: d.name, detail: d.description }), ...(d.error && { error: d.error }) }));
}

function agentProfileRows(dir: string): Row[] {
  const b: Base = { rootId: rootIdOf(dir), root: dir };
  return listAgentProfiles(dir).map((p) => ({ ...fileItem(b, `${p.name}.md`, { name: p.name, detail: 'description' in p ? p.description : undefined }), ...('error' in p && { error: p.error }) }));
}

function hookItems(b: Base, rels: string[]): Row[] {
  return rels.flatMap((rel) => {
    const json = readJson(path.join(b.root, rel));
    if (json === undefined) return [];
    if (json instanceof Error) return [broken(b, rel)];
    const local = rel.endsWith('settings.local.json');
    return hooks(json.hooks).map((p) => fileItem(b, rel, { ...p, detail: local ? `${p.detail} · local` : p.detail }));
  });
}

function pluginItems(b: Base): Row[] {
  const installed = readJson(path.join(b.root, 'plugins/installed_plugins.json'));
  if (installed === undefined) return [];
  if (installed instanceof Error) return [{ ...broken(b, 'plugins/installed_plugins.json') }];
  const settings = readJson(path.join(b.root, 'settings.json'));
  const enabled = settings && !(settings instanceof Error) ? settings.enabledPlugins : undefined;
  return plugins(installed.plugins, enabled).map((p) => ({
    ...fileItem(b, 'settings.json', p),
    ...(p.path && { reveal: p.path, target: 'folder' as const }),
  }));
}

// what ~/.claude.json declares is shown and never opened
const claudeJsonServers = (claude: ClaudePaths, servers: unknown): Row[] =>
  mcpServers(servers).map((p) => ({ name: p.name, ...(p.detail && { detail: p.detail }), reveal: claude.json, target: 'file' as const }));

function mcpFile(b: Base, rel: string): Row[] {
  const json = readJson(path.join(b.root, rel));
  if (json === undefined) return [];
  if (json instanceof Error) return [broken(b, rel)];
  return mcpServers(json.mcpServers).map((p) => fileItem(b, rel, p));
}

/** What Codex reads everywhere: ~/.codex, or CODEX_HOME. Its auth.json is never listed. */
export function codexSource(codex: CodexPaths): ResourceSource | undefined {
  if (!fs.existsSync(codex.dir)) return undefined;
  const b: Base = { rootId: rootIdOf(codex.dir), root: codex.dir };
  const config = readToml(codex.config);
  const groups = groupsOf([
    ['instructions', files(b, ['AGENTS.md'])],
    ['skills', skills(b, 'skills')],
    ['commands', markdown(b, 'prompts', true)],
    ['mcp', config && !(config instanceof Error) ? mcpServers(config.mcp_servers).map((p) => fileItem(b, 'config.toml', { ...p, find: `[mcp_servers.${p.name}` })) : []],
    ['hooks', hookItems(b, ['hooks.json'])],
    ['settings', config instanceof Error ? [{ ...fileItem(b, 'config.toml'), error: config.message }, ...files(b, ['hooks.json'])] : files(b, ['config.toml', 'hooks.json'])],
  ]);
  return groups.length ? { ...b, name: 'Codex', tier: 'global' as const, islandIds: [], characterIds: [], groups } : undefined;
}

// what it reveals, and then the place it opens at or its own name, tell two rows of a kind apart even when they share a file
const idOf = (kind: ResourceKind, r: Row): string => `${kind}\u0000${r.reveal}\u0000${r.open?.find ?? r.name}`;

const groupsOf = (pairs: [ResourceKind, Row[]][]): ResourceGroup[] =>
  pairs.filter(([, items]) => items.length > 0)
    .map(([kind, items]) => ({ kind, items: items.map((r) => ({ id: idOf(kind, r), ...r })) }));

const slugOf = (root: string): string => root.replace(/[^A-Za-z0-9]/g, '-');

export function scanResources(state: FleetState, claude: ClaudePaths, codex?: CodexPaths, docs?: string, agentProfiles?: string): ResourceSource[] {
  const user: Base = { rootId: rootIdOf(claude.dir), root: claude.dir };
  const cj = readClaudeJson(claude.json);
  const claudeJson = cj && !(cj instanceof Error) ? cj : {};
  const projects = (claudeJson.projects && typeof claudeJson.projects === 'object' ? claudeJson.projects : {}) as Record<string, { mcpServers?: unknown } | undefined>;

  const everywhere: ResourceSource = {
    ...user, name: 'Claude', tier: 'global', islandIds: [], characterIds: [],
    groups: groupsOf([
      ['instructions', files(user, ['CLAUDE.md'])],
      ['skills', skills(user, 'skills')],
      ['agents', markdown(user, 'agents', false)],
      ['commands', markdown(user, 'commands', true)],
      ['plugins', pluginItems(user)],
      ['mcp', claudeJsonServers(claude, claudeJson.mcpServers)],
      ['hooks', hookItems(user, ['settings.json', 'settings.local.json'])],
      ['settings', files(user, ['settings.json', 'settings.local.json', 'keybindings.json'])],
    ]),
  };

  const roots = fleetRoots(state);
  const repos = roots.map((r): ResourceSource => {
    const b: Base = { rootId: rootIdOf(r.root), root: r.root };
    const memory = `projects/${slugOf(r.root)}/memory`;
    const folder = docs && docsDir(docs, 'repo', repoSlug(r.root));
    const groups = groupsOf([
      ['docs', folder ? docRows(folder) : []],
      ['instructions', files(b, ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'])],
      ['skills', [...skills(b, '.claude/skills', 'claude'), ...skills(b, '.codex/skills', 'codex')]],
      ['agents', markdown(b, '.claude/agents', false)],
      ['commands', own(b, '.claude/commands') ? markdown(b, '.claude/commands', true) : []],
      ['mcp', [...mcpFile(b, '.mcp.json'), ...claudeJsonServers(claude, projects[r.root]?.mcpServers)]],
      ['hooks', hookItems(b, ['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json'])],
      ['settings', files(b, ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.codex/hooks.json'])],
      ['autoMemory', entries(path.join(claude.dir, memory)).filter((d) => d.name.endsWith('.md')).map((d) => fileItem(user, `${memory}/${d.name}`))],
    ]);
    return { ...b, name: path.basename(r.root), tier: 'repo', ...(folder && { docs: rootIdOf(folder) }), islandIds: r.islandIds, characterIds: r.characterIds, groups };
  });

  // the fleet's own docs, read by every character in this fleet and by no other, and the agent profiles its characters pick from;
  // both sit in the fleet's home
  const fleet = docs === undefined ? [] : [((): ResourceSource => {
    const dir = fleetDir(docs);
    const profiles = agentProfiles === undefined ? {} : { agentProfiles: rootIdOf(agentProfiles) };
    const groups = groupsOf([['docs', docRows(dir)], ['agentProfiles', agentProfiles === undefined ? [] : agentProfileRows(agentProfiles)]]);
    return { rootId: rootIdOf(dir), root: dir, name: state.name ?? profileOf(path.dirname(docs)), tier: 'fleet', docs: rootIdOf(dir), ...profiles, islandIds: [], characterIds: [], groups };
  })()];

  const entity = (tier: 'island' | 'character', id: string, name: string, islandIds: string[], characterIds: string[]): ResourceSource[] => {
    if (!docs) return [];
    const dir = docsDir(docs, tier, id);
    return [{ rootId: rootIdOf(dir), root: dir, name, tier, docs: rootIdOf(dir), islandIds, characterIds, groups: groupsOf([['docs', docRows(dir)]]) }];
  };
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const crew = Object.values(state.characters);
  const islands = Object.values(state.islands).sort(byName)
    .flatMap((i) => entity('island', i.id, i.name, [i.id], crew.filter((c) => c.islandId === i.id).map((c) => c.id).sort()));
  const characters = [...crew].sort(byName).flatMap((c) => entity('character', c.id, c.name, [c.islandId], [c.id]));

  // a slug nobody stands in any more cannot be traced to a checkout, so its source is its docs folder
  const slugs = new Set(roots.map((r) => repoSlug(r.root)));
  const orphans = docs === undefined ? [] : entries(path.join(docs, 'repos')).filter((d) => d.isDirectory() && !slugs.has(d.name)).flatMap((d): ResourceSource[] => {
    const dir = path.join(docs, 'repos', d.name);
    const groups = groupsOf([['docs', docRows(dir)]]);
    return groups.length ? [{ rootId: rootIdOf(dir), root: dir, name: d.name, tier: 'repo', docs: rootIdOf(dir), islandIds: [], characterIds: [], groups }] : [];
  });

  const everywhereCodex = codex && codexSource(codex);
  return [everywhere, ...(everywhereCodex ? [everywhereCodex] : []), ...fleet, ...repos, ...orphans, ...islands, ...characters];
}
