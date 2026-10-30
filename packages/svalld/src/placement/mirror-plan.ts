import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { NOT_NEEDED, type AgentKind } from '@svall/protocol';
import { VAR_NAME } from '../claude.js';
import { sha256Hex } from '../hash.js';
import { clean, holds } from '../path-tools.js';
import { realPath } from '../paths.js';
import { OTHER_SHIM, SHIM } from '../profile.js';
import { CREDENTIAL_PATTERNS, fileSha, packTar, ustarFits } from './bundle.js';
import { agentKeys, agentLeaves } from './mirror-agents.js';
import {
  configNeeds, configRedacted, configSecrets, getAt, headedEntries, isMacOnly, isOAuth, isReferenceOnly, keyedLsp, lspKeys, marketplaceBare, marketplaceList, needsOf,
  oauthLogin, parseJsonc, fileServers, namedPaths, pluginServersAt, readPluginConfigs, readPluginLsp, readPluginServers, readPlugins, readServers, readSettingsEnv, redacted,
  runtimesOf, secretsOf, setAt, withoutCredentials, type McpServer, type Place, type Scope, type Secret,
} from './mirror-config.js';
import { CONFIG_ITEMS, itemKey, pluginKey, preview, tickedFields } from './mirror-consent.js';
import {
  CODEX_MAC_ONLY, CODEX_WORKER_OWNED, isDoc, isNoFile, MANIFEST, OPENCODE_FILES, OPENCODE_WORKER_OWNED, PLUGIN_LISTS, statOf, WORKER_OWNED, type Doc, type DocName,
  type Homes, type InPlace, type MirrorHomes, type Root, type WorkerFacts, type WorkerState,
} from './mirror-state.js';

export const MIRROR_FILE_MAX = 5 * 1024 * 1024;
const MIRROR_TREE_MAX = 200 * 1024 * 1024;

/**
 * An MCP server as the mirror carries it: `entry` with each unticked secret emptied, `bare` with every one; a plugin's names no
 * `doc` but the `file` on the Mac it travels in.
 */
export type MirroredServer = {
  key: string; agent: AgentKind; name: string; scope: Scope; entry: Record<string, unknown>; bare: Record<string, unknown>; needs: string[];
  secretFields: string[]; ticked: string[]; preview: string[]; known: boolean; oauth?: { run: string; forward?: number }; runtimes: string[];
  doc?: DocName; file?: string; place: string[];
};

/** Each file by where it lands: `to` starts with its home (`claude`, `codex`, `home`, `profiles` or `opencode`) and goes on under it. */
export type MirrorPlan = {
  /** `data` stands in for `from`'s bytes where the mirror writes the file itself. */
  files: { from: string; to: string; mode: number; data?: string }[];
  servers: MirroredServer[];
  macOnly: { agent: AgentKind; name: string; scope: Scope }[];
  /** Each program ticked as one the worker does not need, by its command. */
  notNeeded: string[];
  /** Each config file with a secret field, by its consent item. */
  configs: { key: string; agent: AgentKind; file: string; fields: string[]; preview: string[]; ticked: string[] }[];
  settingsEnv: Record<string, string>;
  settings: Record<string, unknown>;
  /** What travels whole once every field is ticked: a plugin's settings and LSP configs, a marketplace list setting headers, a subagent defining a server. */
  plugins: { key: string; name: string; fields: string[]; ticked: boolean; files: string[] }[];
  codex?: Record<string, unknown>;
  /** Each OpenCode config file, and the secret fields of its own. */
  opencode: { file: (typeof OPENCODE_FILES)[number]; doc: Record<string, unknown>; fields: string[] }[];
  homes: Homes;
  vars: string[];
  unreadable: string[];
  /** Each plugin install whose marketplace list the Mac cannot read, whose files stay on the worker as the mirror last wrote them. */
  unreadInstalls: string[];
  keep: string[];
  /** Each file that holds a ticked key, by its `to`, which the worker keeps for its owner alone. */
  keyed: string[];
  /** Each of those the agent needs, whose keys an uninstall takes back where they lie, each by its place, sha and bare form. */
  inPlace: InPlace[];
  skipped: string[];
};
// OpenCode reads each folder by either name
const OPENCODE_TREES = ['agent', 'agents', 'command', 'commands', 'plugin', 'plugins', 'skills'];
// a key or a login by its name: a move's credential patterns and more
const SECRET = [
  ...CREDENTIAL_PATTERNS, '.credentials.json', 'credentials.json', 'credentials.toml', 'auth.json', 'mcp-auth.json', 'token.json', 'token.pickle', 'service-account.json',
  'client_secret_*.json', 'AuthKey_*.p8', '*.p12', '*.pfx', '.git-credentials', '.npmrc', '.pypirc', '.pgpass', '.vault-token',
].map((p) => new RegExp(`^${p.replaceAll('.', '\\.').replaceAll('*', '.*')}$`, 'i'));
const SECRET_DIRS = ['.aws', '.ssh', '.gnupg', '.kube', '.azure', '.config/gcloud'];
const SECRET_FILES = ['.docker/config.json', 'gh/hosts.yml'];
// by any case, as the Mac's disk finds a folder whatever case a link spells it in
const secret = (file: string): boolean => {
  const lower = file.toLowerCase();
  return SECRET.some((re) => re.test(path.basename(file))) || SECRET_DIRS.some((d) => lower.includes(`${path.sep}${d}${path.sep}`)) || SECRET_FILES.some((f) => lower.endsWith(`${path.sep}${f}`));
};
const without = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

type Walk = { found: { file: string; rel: string; mode: number }[]; bytes: number; seen: Set<string> };

// gathers the files under `dir` into `w`, links followed and .git left out; false once past the tree's limit
function walk(dir: string, rel: string, w: Walk, keep: (file: string) => boolean, skipped: string[]): boolean {
  let names: string[];
  try {
    const real = fs.realpathSync(dir);
    if (w.seen.has(real)) return true;
    w.seen.add(real);
    names = fs.readdirSync(dir).sort();
  } catch {
    return true;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const st = name === '.git' ? undefined : statOf(file);
    if (st?.isDirectory()) {
      if (!walk(file, path.posix.join(rel, name), w, keep, skipped)) return false;
    } else if (st?.isFile() && keep(file)) {
      if (st.size > MIRROR_FILE_MAX) {
        skipped.push(`${file} is over ${MIRROR_FILE_MAX / 2 ** 20} MB`);
        continue;
      }
      w.bytes += st.size;
      if (w.bytes > MIRROR_TREE_MAX) return false;
      w.found.push({ file, rel: path.posix.join(rel, name), mode: st.mode & 0o777 });
    }
  }
  return true;
}

// Claude's settings less what the worker owns; settings that cannot be read carry none and are named in `unreadable`
function claudeSettings(dir: string, skipped: string[], unreadable: string[]): Doc {
  const file = path.join(dir, 'settings.json');
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (isNoFile(e)) return {};
  }
  if (!isDoc(parsed)) {
    skipped.push(`${file} cannot be read as a settings object`);
    unreadable.push(file);
    return {};
  }
  // a marketplace's git login never travels
  for (const m of Object.values(isDoc(parsed.extraKnownMarketplaces) ? parsed.extraKnownMarketplaces : {})) {
    if (isDoc(m) && isDoc(m.source) && typeof m.source.url === 'string') m.source.url = withoutCredentials(m.source.url);
  }
  return without(parsed, WORKER_OWNED);
}

// a config file's object, or undefined for none; one that cannot be read is named in `unreadable`, once
function configDoc(file: string, parse: (source: string) => unknown, unreadable: string[]): Doc | undefined {
  if (unreadable.includes(file)) return undefined;
  let doc: unknown;
  try { doc = parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (isNoFile(e)) return undefined;
  }
  if (isDoc(doc)) return doc;
  unreadable.push(file);
  return undefined;
}

const withoutLogins = (v: unknown): unknown =>
  typeof v === 'string' ? withoutCredentials(v) : Array.isArray(v) ? v.map(withoutLogins) : isDoc(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutLogins(x)])) : v;

/** A server as the mirror carries it, by what `consent` ticks: one whose fields it does not know whole or not at all. */
function mirrored(s: McpServer, consent: ReadonlySet<string>): MirroredServer {
  const key = itemKey(s);
  const secrets = s.known ? secretsOf(s) : [];
  const secretFields = [...new Set(secrets.map((f) => f.field))];
  const ticked = tickedFields(consent, key, s.known ? secretFields : Object.keys(s.raw));
  const entry = s.known ? redacted(s, new Set(ticked)) : ticked.length === Object.keys(s.raw).length ? structuredClone(s.raw) : {};
  const plugin = typeof s.scope === 'object' && 'plugin' in s.scope;
  const doc: DocName | undefined = plugin ? undefined : s.agent === 'claude' ? '.claude.json' : s.agent === 'codex' ? 'config.toml' : (path.basename(s.file ?? '') as DocName);
  return {
    key, agent: s.agent, name: s.name, scope: s.scope, entry, bare: s.known ? redacted(s, new Set()) : entry, needs: needsOf(s), secretFields, ticked,
    preview: s.known ? preview(secrets) : Object.keys(s.raw), known: s.known, ...(isOAuth(s) && { oauth: oauthLogin(s) }), runtimes: runtimesOf(s),
    ...(doc ? { doc } : s.file && { file: s.file }), place: s.place ?? [],
  };
}

// a plugin's server file as the worker gets it, Mac-only and uncarried servers left out; undefined when it cannot be read
function pluginFile(file: string, servers: McpServer[], consent: ReadonlySet<string>): string | undefined {
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* below */ }
  if (!isDoc(doc)) return undefined;
  for (const s of servers) {
    const entry = isMacOnly(s) ? {} : mirrored(s, consent).entry;
    setAt(doc, s.place ?? [], Object.keys(entry).length ? entry : undefined);
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// a server that may travel raw
const plain = (s: McpServer): boolean => s.known && !secretsOf(s).length;
const manifestOf = (root: string): string => path.join(root, '.claude-plugin/plugin.json');
// the folders among `files` that hold a .claude-plugin folder, a plugin's or a marketplace's
const pluginRoots = (files: string[]): string[] => [...new Set(files.filter((f) => path.basename(path.dirname(f)) === '.claude-plugin').map((f) => path.dirname(path.dirname(f))))];

// the files a plugin's manifest names as its servers', wherever they lie
function namedServerFiles(root: string): string[] {
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(manifestOf(root), 'utf8')); } catch { return []; }
  const named = isDoc(doc) ? doc.mcpServers : undefined;
  return namedPaths(named).map((n) => path.resolve(root, n));
}

const readJson = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

// each string of `v` that `bare` holds otherwise at its place, with its sha and what `bare` holds there
function keysIn(v: unknown, bare: unknown, place: Place = []): InPlace['places'] {
  if (typeof v === 'string') return typeof bare === 'string' && bare !== v ? [{ place, sha: sha256Hex(v), bare }] : [];
  if (typeof v !== 'object' || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => {
    const key = Array.isArray(v) ? Number(k) : k;
    return keysIn(x, getAt(bare, [key]), [...place, key]);
  });
}

/**
 * Of a marketplace's files: `keyed` those holding a key or an unknown server, `broken` the unreadable, `hidden` those withheld
 * silently since an unreadable manifest or list may name them, `headed` the other lists whose entries set headers.
 */
function marketplaceKeys(found: string[]): { keyed: string[]; broken: string[]; hidden: string[]; headed: { file: string; fields: string[] }[] } {
  const broken: string[] = [];
  const keyed: string[] = [];
  const hidden: string[] = [];
  const headed: { file: string; fields: string[] }[] = [];
  const base = (f: string, name: string): boolean => path.basename(f) === name;
  const roots = new Set(found.flatMap((f) => (base(f, '.mcp.json') || base(f, '.lsp.json') ? [path.dirname(f)]
    : base(f, 'plugin.json') && base(path.dirname(f), '.claude-plugin') ? [path.dirname(path.dirname(f))] : [])));
  for (const root of roots) {
    keyed.push(...readPluginServers({ name: '', installPath: root }, broken).filter((s) => !plain(s)).map((s) => s.file ?? ''));
    keyed.push(...lspKeys(root, broken).map((c) => c.file));
    hidden.push(...namedServerFiles(root));
    if (broken.includes(manifestOf(root))) hidden.push(...found.filter((f) => holds(root, f)));
  }
  for (const f of found) {
    if (base(f, 'settings.json')) {
      const doc = readJson(f);
      if (!isDoc(doc)) broken.push(f);
      else if (Object.values(isDoc(doc.env) ? doc.env : {}).some((v) => typeof v === 'string' && !isReferenceOnly(v)) || configSecrets('claude', doc).length) keyed.push(f);
    } else if (base(f, 'marketplace.json') && base(path.dirname(f), '.claude-plugin')) {
      // a plugin a marketplace defines in place may hold its servers there too, or in a file under it the entry names
      const doc = readJson(f);
      if (!isDoc(doc) || (doc.plugins !== undefined && !Array.isArray(doc.plugins))) {
        // its entries may name a server file anywhere in it, so nothing of the marketplace travels
        broken.push(f);
        hidden.push(...found.filter((x) => holds(path.dirname(path.dirname(f)), x)));
      } else {
        const list = doc.plugins as unknown[] ?? [];
        const keys = (p: unknown, i: number): boolean => isDoc(p) && (!pluginServersAt('', f, ['plugins', String(i), 'mcpServers'], p.mcpServers).every(plain) || keyedLsp(p.lspServers).length > 0);
        const fields = headedEntries(doc);
        if (list.some(keys)) keyed.push(f);
        else if (fields.length) headed.push({ file: f, fields });
        for (const p of list) {
          if (!isDoc(p) || typeof p.source !== 'string') continue;
          for (const n of namedPaths(p.mcpServers)) {
            const named = path.resolve(path.dirname(path.dirname(f)), p.source, n);
            if (found.includes(named) && !fileServers('', named, broken).every(plain)) keyed.push(named);
          }
          for (const n of namedPaths(p.lspServers)) {
            const named = path.resolve(path.dirname(path.dirname(f)), p.source, n);
            const lsp = found.includes(named) ? readJson(named) : undefined;
            if (found.includes(named) && !isDoc(lsp)) broken.push(named);
            else if (keyedLsp(lsp).length) keyed.push(named);
          }
        }
      }
    }
  }
  return { keyed: [...new Set(keyed)], broken: [...new Set(broken)], hidden, headed };
}

/**
 * What the agent configuration mirror carries to a worker: every agent's instructions, skills, plugins, settings and MCP servers
 * but the Mac-only ones, a project's only where the worker has it. A key travels only where ticked; logins never do.
 */
export function mirrorPlan(o: MirrorHomes, consent: ReadonlySet<string> = new Set(), facts?: WorkerFacts): MirrorPlan {
  const files: MirrorPlan['files'] = [];
  const skipped: string[] = [];
  const unreadable: string[] = [];
  const plugins = readPlugins(o.claudeDir, unreadable);
  const read = readServers(o, plugins);
  unreadable.push(...read.unreadable);

  const servers: MirroredServer[] = [];
  const macOnly: MirrorPlan['macOnly'] = [];
  for (const s of read.servers) {
    const project = typeof s.scope === 'object' && 'project' in s.scope ? s.scope.project : undefined;
    if (isMacOnly(s)) macOnly.push({ agent: s.agent, name: s.name, scope: s.scope });
    else if (project === undefined || !facts || facts.projects[project]) servers.push(mirrored(s, consent));
  }

  const configs: MirrorPlan['configs'] = [];
  // the fields of `key`'s secrets that are not ticked, its row listed when it has any
  const unticked = (key: string, agent: AgentKind, file: string, secrets: Secret[]): string[] => {
    const fields = [...new Set(secrets.map((f) => f.field))];
    const ticked = tickedFields(consent, key, fields);
    if (fields.length) configs.push({ key, agent, file, fields, preview: preview(secrets), ticked });
    return fields.filter((f) => !ticked.includes(f));
  };
  const settingsDoc = claudeSettings(o.claudeDir, skipped, unreadable);
  const env = readSettingsEnv(o.claudeDir);
  const settingsOff = unticked(CONFIG_ITEMS.settings, 'claude', 'settings.json', [
    ...configSecrets('claude', settingsDoc), ...Object.entries(env).map(([k, value]) => ({ field: `env.${k}`, value })),
  ]);
  const tomlFile = path.join(o.codexDir, 'config.toml');
  const tomlDoc = configDoc(tomlFile, parseToml, unreadable);
  const codexDoc = tomlDoc && without(tomlDoc, [...CODEX_WORKER_OWNED, ...CODEX_MAC_ONLY]);
  const codexOff = codexDoc ? unticked(CONFIG_ITEMS.codex, 'codex', 'config.toml', configSecrets('codex', codexDoc)) : [];
  const ocDocs = OPENCODE_FILES.flatMap((file) => {
    const doc = configDoc(path.join(o.opencodeDir, file), parseJsonc, unreadable);
    const secrets = doc ? configSecrets('opencode', without(doc, OPENCODE_WORKER_OWNED)) : [];
    return doc ? [{ file, doc: without(doc, OPENCODE_WORKER_OWNED), secrets, fields: [...new Set(secrets.map((f) => f.field))] }] : [];
  });
  const ocOff = unticked(CONFIG_ITEMS.opencode, 'opencode', ocDocs.filter((d) => d.secrets.length).map((d) => d.file).join(' and '), ocDocs.flatMap((d) => d.secrets));

  const pluginConfigs = [...readPluginConfigs(plugins, unreadable), ...readPluginLsp(plugins, unreadable)];
  // what never travels as a file, links to it included; the config and plugin server files travel redacted instead
  const withheld = new Set<string>();
  const hold = (file: string): void => { withheld.add(realPath(file)); };
  for (const f of [
    o.claudeJson, path.join(o.homedir, '.claude.json'), path.join(o.claudeDir, '.claude.json'), path.join(o.codexDir, 'auth.json'), path.join(o.claudeDir, 'settings.json'),
    tomlFile, ...OPENCODE_FILES.map((n) => path.join(o.opencodeDir, n)), ...unreadable,
    ...['plugin', 'plugins'].flatMap((d) => [SHIM, OTHER_SHIM].map((n) => path.join(o.opencodeDir, d, `${n}.js`))),
  ]) hold(f);
  const byFile = new Map<string, McpServer[]>();
  for (const p of plugins) for (const s of readPluginServers(p, [])) if (s.file) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  for (const f of byFile.keys()) hold(f);
  for (const f of plugins.flatMap((p) => namedServerFiles(p.installPath))) hold(f);
  const pluginRows: MirrorPlan['plugins'] = [];
  // files whose item is not ticked, which stay here with a line
  const waiting = new Set<string>();
  // an item carried whole once each of its fields is ticked
  const whole = (key: string, name: string, fields: string[], files: string[]): void => {
    const ticked = fields.length > 0 && tickedFields(consent, key, fields).length === fields.length;
    pluginRows.push({ key, name, fields, ticked, files });
    if (ticked) return;
    for (const f of files) {
      hold(f);
      waiting.add(f);
      skipped.push(`${f} is not ticked`);
    }
  };
  // a plugin's settings and LSP configs, of every install, are one item
  const byPlugin = new Map<string, { fields: string[]; files: string[] }>();
  for (const c of pluginConfigs) {
    const row = byPlugin.get(c.name) ?? { fields: [], files: [] };
    byPlugin.set(c.name, { fields: [...new Set([...row.fields, ...c.fields])], files: [...new Set([...row.files, c.file])] });
  }
  for (const [name, c] of byPlugin) whole(pluginKey(name), `${name}'s config`, c.fields, c.files);
  // the home's credential folders where they really lie, a link into a dotfiles tree followed
  const secretRoots = SECRET_DIRS.map((d) => realPath(path.join(o.homedir, d)));
  const keep = (file: string): boolean => {
    const real = realPath(file);
    return !withheld.has(real) && ![file, real].some(secret) && !secretRoots.some((r) => holds(r, real));
  };
  // `vet` may hold what it has seen, so `keep` is asked again after it
  const tree = (root: Root, top: string, under: string, also: (file: string) => boolean = () => true, vet: (found: string[]) => void = () => {}): void => {
    const w: Walk = { found: [], bytes: 0, seen: new Set() };
    if (!walk(top, '', w, (f) => keep(f) && also(f), skipped)) {
      skipped.push(`${top} is over ${MIRROR_TREE_MAX / 2 ** 20} MB`);
      return;
    }
    vet(w.found.map((f) => f.file));
    for (const f of w.found) if (keep(f.file)) files.push({ from: f.file, to: path.posix.join(root, under, f.rel), mode: f.mode });
  };
  const one = (root: Root, dir: string, name: string): void => {
    const from = path.join(dir, name);
    const st = statOf(from);
    if (!st?.isFile() || !keep(from)) return;
    if (st.size > MIRROR_FILE_MAX) skipped.push(`${from} is over ${MIRROR_FILE_MAX / 2 ** 20} MB`);
    else files.push({ from, to: path.posix.join(root, name), mode: st.mode & 0o777 });
  };

  const pluginsDir = path.join(o.claudeDir, 'plugins');
  const installs = plugins.map((p) => clean(p.installPath));
  // a file the mirror writes itself, as the Mac's `from` would land; one holding a ticked key for its owner alone
  const withKeys = new Set<string>();
  const inPlace: InPlace[] = [];
  const landing = (from: string): string => path.posix.join('claude', path.posix.relative(o.claudeDir, from));
  const made = (from: string, data: string, keyed = false): void => {
    const to = landing(from);
    if (Buffer.byteLength(data) > MIRROR_FILE_MAX) skipped.push(`${from} is over ${MIRROR_FILE_MAX / 2 ** 20} MB`);
    else files.push({ from, to, mode: keyed ? 0o600 : (statOf(from)?.mode ?? 0o644) & 0o777, data });
    if (keyed) withKeys.add(to);
  };
  // one that cannot be read now stays as the worker has it
  const unread = (file: string): void => {
    skipped.push(`${file} cannot be read`);
    unreadable.push(file);
  };
  // a subagent defining a server the mirror must ask for travels whole once ticked; a plugin's, found by its agents folder or
  // an `agents` path its manifest, marketplace entry or `plugin.also` names, is keyed by its path under Claude's folder
  const agentsDir = path.join(o.claudeDir, 'agents');
  const vetAgents = (found: string[], plugin?: { roots: string[]; also?: string[] }): void => {
    const named = [...plugin?.also ?? [], ...(plugin?.roots ?? []).flatMap((root) => {
      const [manifest, market] = [readJson(manifestOf(root)), readJson(path.join(root, '.claude-plugin/marketplace.json'))];
      const entries = isDoc(market) && Array.isArray(market.plugins) ? market.plugins as unknown[] : [];
      return [
        ...(isDoc(manifest) ? namedPaths(manifest.agents).map((n) => path.resolve(root, n)) : []),
        ...entries.flatMap((p) => (isDoc(p) && typeof p.source === 'string' ? namedPaths(p.agents).map((n) => path.resolve(root, p.source as string, n)) : [])),
      ];
    })];
    const isAgent = (x: string): boolean => path.relative(o.claudeDir, x).split(path.sep).includes('agents') || named.some((n) => x === n || holds(n, x));
    for (const f of found.filter((x) => x.endsWith('.md') && (!plugin || isAgent(x)))) {
      let source: string;
      try { source = fs.readFileSync(f, 'utf8'); } catch {
        unread(f);
        hold(f);
        continue;
      }
      const fields = agentKeys(source);
      const rel = path.relative(plugin ? o.claudeDir : agentsDir, f).split(path.sep).join('/');
      if (fields.length) whole(`claude:agent:${rel}`, plugin ? rel : `agents/${rel}`, fields, [f]);
    }
  };
  tree('claude', path.join(pluginsDir, 'marketplaces'), 'plugins/marketplaces', (f) => !installs.some((i) => holds(i, f)), (found) => {
    const { keyed, broken, hidden, headed } = marketplaceKeys(found);
    for (const f of keyed) skipped.push(`${f} holds a key`);
    for (const f of broken) unread(f);
    const held = [...keyed, ...broken, ...hidden];
    for (const f of held) hold(f);
    for (const h of headed.filter((x) => !held.includes(x.file))) {
      const m = path.relative(path.join(pluginsDir, 'marketplaces'), h.file).split(path.sep)[0];
      whole(`claude:marketplace:${m}`, `${m}'s marketplace.json`, h.fields, [h.file]);
    }
    vetAgents(found.filter((f) => !held.includes(f)), { roots: pluginRoots(found) });
  });
  const unreadInstalls: string[] = [];
  for (const p of plugins) {
    if (!holds(pluginsDir, clean(p.installPath)) || clean(p.installPath) === pluginsDir) {
      skipped.push(`${p.installPath} lies outside ${pluginsDir}`);
      continue;
    }
    // a manifest that cannot be read, or the marketplace list its entry is in, may name a server file, so nothing of its plugin travels
    if (unreadable.includes(manifestOf(p.installPath)) || p.unreadMarket) {
      skipped.push(`${p.unreadMarket ?? manifestOf(p.installPath)} cannot be read`);
      if (p.unreadMarket) unreadInstalls.push(p.installPath);
      continue;
    }
    const also = (p.namedAgents ?? []).map((n) => path.resolve(p.installPath, n));
    tree('claude', p.installPath, path.posix.relative(o.claudeDir, p.installPath), undefined, (found) => vetAgents(found, { roots: [p.installPath, ...pluginRoots(found)], also }));
    for (const [file, ss] of byFile) {
      if (!holds(p.installPath, file) || unreadable.includes(file) || waiting.has(file)) continue;
      const data = pluginFile(file, ss, consent);
      if (data === undefined) unread(file);
      else made(file, data, ss.some((s) => !isMacOnly(s) && mirrored(s, consent).ticked.length > 0));
    }
  }
  // a marketplace's headers travel in the list only where its settings.json field is ticked
  const settingsTicked = new Set(configs.find((c) => c.key === CONFIG_ITEMS.settings)?.ticked ?? []);
  for (const name of PLUGIN_LISTS) {
    const from = path.join(o.claudeDir, 'plugins', name);
    if (unreadable.includes(from) || !fs.existsSync(from)) continue;
    const doc = readJson(from);
    if (doc === undefined) {
      unread(from);
      continue;
    }
    const list = name === 'known_marketplaces.json' && isDoc(doc) ? marketplaceList(withoutLogins(doc) as Doc, settingsTicked) : { doc: withoutLogins(doc), kept: false };
    made(from, `${JSON.stringify(list.doc, null, 2)}\n`, list.kept);
    if (list.kept) inPlace.push({ to: landing(from), places: keysIn(list.doc, marketplaceList(withoutLogins(doc) as Doc, new Set()).doc) });
  }
  one('claude', o.claudeDir, 'CLAUDE.md');
  one('claude', o.claudeDir, 'keybindings.json');
  for (const t of ['skills', 'rules', 'agents', 'commands']) tree('claude', path.join(o.claudeDir, t), t, undefined, t === 'agents' ? vetAgents : undefined);
  one('codex', o.codexDir, 'AGENTS.md');
  tree('home', path.join(o.homedir, '.agents/skills'), '.agents/skills');
  for (const t of OPENCODE_TREES) tree('opencode', path.join(o.opencodeDir, t), t);
  one('opencode', o.opencodeDir, 'AGENTS.md');
  if (o.agentProfiles) tree('profiles', o.agentProfiles, '');
  // a file ticked whole holds its keys; a subagent's and a marketplace list's, which the agent needs, lie where an
  // uninstall takes them back, and a marketplace list that only runs a headersHelper holds none
  const tickedWhole = new Set(pluginRows.filter((r) => r.ticked).flatMap((r) => r.files));
  for (const f of files) {
    if (!tickedWhole.has(f.from)) continue;
    const row = pluginRows.find((r) => r.ticked && r.files.includes(f.from))!;
    const doc = row.key.startsWith('claude:marketplace:') ? readJson(f.from) : undefined;
    let leaves: InPlace['places'] | undefined;
    if (isDoc(doc)) leaves = keysIn(doc, marketplaceBare(doc));
    else if (row.key.startsWith('claude:agent:')) {
      try { leaves = agentLeaves(fs.readFileSync(f.from, 'utf8'))?.map((l) => ({ place: l.place, sha: sha256Hex(l.value), bare: l.bare })); } catch { /* removed whole */ }
    }
    if (isDoc(doc) && !leaves?.length) continue;
    f.mode = 0o600;
    withKeys.add(f.to);
    if (leaves?.length) inPlace.push({ to: f.to, places: leaves });
  }

  const carried = files.filter((f) => {
    if (ustarFits(Buffer.from(`./${f.to}`))) return true;
    skipped.push(`${f.from} has a path too long for the mirror to carry`);
    return false;
  });
  // a server's env key not ticked is the worker's own variable, as the agent's reference left in its place reads it; a
  // server withheld until ticked whole, or in a file the plan does not carry, names none
  const going = servers.filter((s) => Object.keys(s.entry).length > 0 && (s.doc !== undefined || carried.some((f) => f.from === s.file)));
  const envKeys = going.flatMap((s) => s.secretFields.filter((f) => f.startsWith('env.') && !s.ticked.includes(f)).map((f) => f.slice('env.'.length)));
  const vars = [...going.flatMap((s) => s.needs), ...envKeys, ...(codexDoc ? configNeeds('codex', codexDoc) : []), ...ocDocs.flatMap((d) => configNeeds('opencode', d.doc))]
    .filter((v) => VAR_NAME.test(v));
  return {
    files: carried, servers, macOnly, configs, notNeeded: [...consent].flatMap((k) => (k.startsWith('runtime:') && k.endsWith(`#${NOT_NEEDED}`) ? [k.slice('runtime:'.length, -NOT_NEEDED.length - 1)] : [])),
    settingsEnv: Object.fromEntries(Object.entries(env).filter(([k]) => !settingsOff.includes(`env.${k}`))),
    settings: configRedacted(settingsDoc, settingsOff), plugins: pluginRows,
    ...(codexDoc && { codex: configRedacted(codexDoc, codexOff) }),
    opencode: ocDocs.map((d) => ({ file: d.file, doc: configRedacted(d.doc, ocOff.filter((f) => d.fields.includes(f))), fields: d.fields })),
    homes: { homedir: o.homedir, claudeDir: o.claudeDir, claudeJson: o.claudeJson, codexDir: o.codexDir, opencodeDir: o.opencodeDir },
    vars: [...new Set(vars)].sort(), unreadable: [...new Set(unreadable)], unreadInstalls, keep: carried.map((f) => f.to), keyed: carried.filter((f) => withKeys.has(f.to)).map((f) => f.to),
    inPlace: inPlace.filter((f) => carried.some((c) => c.to === f.to)), skipped,
  };
}

/** Packs each planned file `state` does not record the worker holding, and the manifest without previews or skipped lines. */
export async function packMirror(plan: MirrorPlan, file: string, state?: WorkerState): Promise<{ sent: number }> {
  const stage = `${file}.d`;
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    fs.mkdirSync(stage, { recursive: true });
    const sent: string[] = [];
    for (const f of plan.files) {
      if (state?.files[f.to] === (f.data !== undefined ? sha256Hex(f.data) : await fileSha(f.from))) continue;
      const to = path.join(stage, f.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (f.data !== undefined) fs.writeFileSync(to, f.data);
      else fs.copyFileSync(f.from, to);
      fs.chmodSync(to, f.mode);
      sent.push(f.to);
    }
    const { files: _files, skipped: _skipped, ...rest } = plan;
    const manifest = { ...rest, servers: rest.servers.map(({ preview: _p, ...s }) => s), configs: rest.configs.map(({ preview: _p, ...c }) => c) };
    fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify(manifest));
    await packTar(stage, [MANIFEST, ...sent], file);
    return { sent: sent.length };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
