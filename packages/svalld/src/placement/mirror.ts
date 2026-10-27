import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { AgentKind, ApiError, REPORT_MS, Sha256, type MachineId, type SetupRow } from '@svall/protocol';
import { VAR_NAME } from '../claude.js';
import { writeDurable } from '../handover/durable.js';
import { canonicalJson, sha256Hex } from '../handover/hash.js';
import { clean, holds } from '../handover/portable-path.js';
import { relocate } from '../handover/relocate.js';
import { tryLock } from '../kernel-lock.js';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { realPath } from '../paths.js';
import { OTHER_SHIM, SHIM } from '../profile.js';
import { CREDENTIAL_PATTERNS, packTar, ustarFits } from './bundle.js';
import { filesIn } from './docs-sync.js';
import {
  configNeeds, configPlace, configRedacted, configSecrets, fieldPlace, getAt, isMacOnly, isOAuth, isReferenceOnly, needsOf, oauthLogin, parseJsonc,
  fileServers, namedPaths, pluginServersAt, readPluginConfigs, readPluginServers, readPlugins, readServers, readSettingsEnv, redacted, relocatedServer, runtimesOf,
  secretsOf, setAt, withoutCredentials, type McpServer, type Place, type Scope, type Secret,
} from './mirror-config.js';
import { CONFIG_ITEMS, itemKey, pluginKey, preview, readConsent, setConsent, tickedFields } from './mirror-consent.js';
import { ConfigReport, configReport, ReportAsk, reportAsk, setupRows } from './mirror-report.js';
import { fileSha, unpack } from './move.js';

export const MIRROR_FILE_MAX = 5 * 1024 * 1024;
const MIRROR_TREE_MAX = 200 * 1024 * 1024;
// unpacking and applying a mirror of several trees at their limit
const APPLY_MS = 2 * 60_000;

/** Where a machine keeps what the mirror carries; `agentProfiles` is the fleet home's. */
export type MirrorHomes = { claudeDir: string; codexDir: string; homedir: string; claudeJson: string; opencodeDir: string; agentProfiles?: string };
type Homes = Pick<MirrorHomes, 'homedir' | 'claudeDir' | 'claudeJson' | 'codexDir' | 'opencodeDir'>;

/** The agent config files the mirror merges by key rather than carries whole. */
export const DOC_NAMES = ['settings.json', '.claude.json', 'config.toml', 'opencode.json', 'opencode.jsonc'] as const;
export type DocName = (typeof DOC_NAMES)[number];
const OPENCODE_FILES = ['opencode.json', 'opencode.jsonc'] as const;

/**
 * An MCP server as the mirror carries it: `entry` with each secret not ticked emptied, `bare` with every one emptied;
 * `preview` each secret masked, or the field names of one whose fields the mirror does not know; `doc` and `place` where
 * it lies, a plugin's naming no doc but the `file` on the Mac it travels in.
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
  macOnly: { agent: AgentKind; name: string }[];
  /** Each config file with a secret field, by its consent item. */
  configs: { key: string; agent: AgentKind; file: string; fields: string[]; preview: string[]; ticked: string[] }[];
  settingsEnv: Record<string, string>;
  settings: Record<string, unknown>;
  /** Each plugin config whose fields the mirror does not know, by its consent item, with its settings files. */
  plugins: { key: string; name: string; fields: string[]; ticked: boolean; files: string[] }[];
  codex?: Record<string, unknown>;
  /** Each OpenCode config file, and the secret fields of its own. */
  opencode: { file: (typeof OPENCODE_FILES)[number]; doc: Record<string, unknown>; fields: string[] }[];
  homes: Homes;
  vars: string[];
  unreadable: string[];
  keep: string[];
  /** Each file that holds a ticked key, by its `to`, which the worker keeps for its owner alone. */
  keyed: string[];
  skipped: string[];
};

const Shas = z.record(z.string(), Sha256);
const Copies = z.record(z.string(), z.union([Sha256, z.array(Sha256)]));
/**
 * What the mirror last wrote on a worker, by sha256: each file by its `to`, each doc's keys, each server and each copied
 * value by the JSON of its doc and the keys that lead to it there; each server copied whole, by its keys in any order,
 * and each file holding a ticked key. A value an apply cut short may have left as either of two.
 */
export const WorkerState = z.object({
  files: Shas, docs: z.record(z.string(), Shas), servers: Shas, secrets: Copies, whole: Copies.optional(), keyed: Copies.optional(),
});
export type WorkerState = z.infer<typeof WorkerState>;
type Copied = WorkerState['secrets'][string];
const isCopyOf = (recorded: Copied | undefined, h: string | undefined): boolean => recorded !== undefined && h !== undefined && [recorded].flat().includes(h);
// a server's sha whatever order its keys lie in, as TOML writes a table's plain keys first; none for a value JSON cannot hold
const serverSha = (v: unknown): string | undefined => {
  try { return sha256Hex(canonicalJson(v)); } catch { return undefined; }
};

/** Whether `v` is a value the record holds as copied. */
export const isCopy = (recorded: Copied | undefined, v: unknown): boolean => typeof v === 'string' && isCopyOf(recorded, sha256Hex(v));

// matches no file and no value, so a push writes again what an apply cut short may have left half done
const UNSURE = '0'.repeat(64);

// the record while an apply writes: every key either record holds, a changed one as unsure, a copied value as either
function provisional(state: WorkerState, next: WorkerState): WorkerState {
  const keys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const shas = (a: Record<string, string>, b: Record<string, string>) => Object.fromEntries(keys(a, b).map((k) => [k, b[k] === undefined || a[k] === b[k] ? a[k] : UNSURE]));
  const either = (a: Record<string, Copied>, b: Record<string, Copied>) => Object.fromEntries(keys(a, b).map((k) => {
    const both = [...new Set([a[k], b[k]].flat().filter((h): h is string => h !== undefined))];
    return [k, both.length === 1 ? both[0] : both];
  }));
  return {
    files: shas(state.files, next.files), servers: shas(state.servers, next.servers),
    docs: Object.fromEntries(keys(state.docs, next.docs).map((d) => [d, shas(state.docs[d] ?? {}, next.docs[d] ?? {})])),
    secrets: either(state.secrets, next.secrets), whole: either(state.whole ?? {}, next.whole ?? {}), keyed: either(state.keyed ?? {}, next.keyed ?? {}),
  };
}
/** The Mac's home and its project folders, which the worker answers for. */
export const StateAsk = z.object({ homedir: z.string(), projects: z.array(z.string()) });
export const WorkerFacts = z.object({ state: WorkerState, projects: z.record(z.string(), z.boolean()) });
/** The worker's record, and whether it has each project folder of the Mac's, by the Mac's path. */
export type WorkerFacts = z.infer<typeof WorkerFacts>;

const ROOTS = { claude: 'claudeDir', codex: 'codexDir', home: 'homedir', profiles: 'agentProfiles', opencode: 'opencodeDir' } as const;
type Root = keyof typeof ROOTS;
// the worker's own: its `svall setup` writes hooks and statusLine, which on the Mac name the app bundle, and the rest hold
// secrets or run what fetches them
const WORKER_OWNED = ['hooks', 'statusLine', 'env', 'apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'otelHeadersHelper'];
export const CODEX_WORKER_OWNED = ['projects', 'hooks', 'mcp_servers'];
export const CODEX_MAC_ONLY = ['notify', 'desktop', 'marketplaces', 'plugins'];
export const OPENCODE_WORKER_OWNED = ['mcp'];
// OpenCode reads each folder by either name
const OPENCODE_TREES = ['agent', 'agents', 'command', 'commands', 'plugin', 'plugins', 'skills'];
// Claude's plugin lists, whose paths land by home
const PLUGIN_LISTS = ['installed_plugins.json', 'known_marketplaces.json'];
// a key or a login by its name: a move's credential patterns and more
const SECRET = [...CREDENTIAL_PATTERNS, '.credentials.json', 'credentials.json', 'auth.json', 'mcp-auth.json', 'id_ed25519*', '*.p12', '.git-credentials', '.npmrc', '.pypirc']
  .map((p) => new RegExp(`^${p.replaceAll('.', '\\.').replaceAll('*', '.*')}$`));
// keys and logins by where they lie: anything in these folders, and these files
const SECRET_DIRS = ['.aws', '.ssh', '.gnupg'];
const SECRET_FILES = ['.docker/config.json', 'gh/hosts.yml'];
const secret = (file: string): boolean => {
  const parts = file.split(path.sep);
  return SECRET.some((re) => re.test(path.basename(file))) || parts.some((p) => SECRET_DIRS.includes(p)) || SECRET_FILES.some((f) => file.endsWith(`${path.sep}${f}`));
};
// a settings value under a key named so is a path, which lands by home
const PATH_KEY = /(Path|Dir|Location|cwd)$/;
const MANIFEST = 'mirror.json';
const Doc = z.record(z.string(), z.unknown());
type Doc = z.infer<typeof Doc>;
const Manifest = z.object({
  homes: z.object({ homedir: z.string(), claudeDir: z.string(), claudeJson: z.string(), codexDir: z.string(), opencodeDir: z.string() }),
  servers: z.array(z.object({
    agent: AgentKind, entry: Doc, bare: Doc, secretFields: z.array(z.string()), ticked: z.array(z.string()),
    doc: z.enum(DOC_NAMES).optional(), place: z.array(z.string()),
  })),
  configs: z.array(z.object({ key: z.string(), fields: z.array(z.string()), ticked: z.array(z.string()) })),
  settings: Doc,
  settingsEnv: z.record(z.string(), z.string()),
  codex: Doc.optional(),
  opencode: z.array(z.object({ file: z.enum(OPENCODE_FILES), doc: Doc, fields: z.array(z.string()) })),
  vars: z.array(z.string()),
  unreadable: z.array(z.string()),
  keep: z.array(z.string()),
  keyed: z.array(z.string()).default([]),
});
type Manifest = z.infer<typeof Manifest>;
const Offer = z.object({ id: z.string(), sha256: Sha256 });
const ById = z.object({ id: z.string() });

const statOf = (file: string): fs.Stats | undefined => {
  try { return fs.statSync(file); } catch { return undefined; }
};
const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha = (v: unknown): string => sha256Hex(JSON.stringify(v));
const without = (doc: Doc, keys: readonly string[]): Doc => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));
const isNoFile = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

type Walk = { found: { file: string; rel: string; mode: number }[]; bytes: number; seen: Set<string> };

// the plain files under `dir` that `keep` lets go, links followed and version control left out, gathered into `w`; false
// once they pass the tree's limit. A file over the file limit is named in `skipped`
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

// every string in `v` with its URLs' logins gone
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

// a plugin's server file as the worker gets it: each server as `mirrored` carries it, one Mac-only or not carried left
// out; undefined when it cannot be read now
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

// a server that may travel raw: one whose fields the mirror knows, holding no key
const plain = (s: McpServer): boolean => s.known && !secretsOf(s).length;
const manifestOf = (root: string): string => path.join(root, '.claude-plugin/plugin.json');

// the files a plugin's manifest names as its servers', wherever they lie
function namedServerFiles(root: string): string[] {
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(manifestOf(root), 'utf8')); } catch { return []; }
  const named = isDoc(doc) ? doc.mcpServers : undefined;
  return (Array.isArray(named) ? named : [named]).filter((n): n is string => typeof n === 'string').map((n) => path.resolve(root, n));
}

const readJson = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

/**
 * Of a marketplace's files: the plugin server files, settings and marketplace lists that hold a key or a server the
 * mirror does not know; those that cannot be read; and, silently, every file of a plugin whose manifest cannot be read, and
 * of a marketplace whose list cannot be read.
 */
function marketplaceKeys(found: string[]): { keyed: string[]; broken: string[]; hidden: string[] } {
  const broken: string[] = [];
  const keyed: string[] = [];
  const hidden: string[] = [];
  const base = (f: string, name: string): boolean => path.basename(f) === name;
  const roots = new Set(found.flatMap((f) => (base(f, '.mcp.json') ? [path.dirname(f)]
    : base(f, 'plugin.json') && base(path.dirname(f), '.claude-plugin') ? [path.dirname(path.dirname(f))] : [])));
  for (const root of roots) {
    keyed.push(...readPluginServers({ name: '', installPath: root }, broken).filter((s) => !plain(s)).map((s) => s.file ?? ''));
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
        if (list.some((p, i) => isDoc(p) && !pluginServersAt('', f, ['plugins', String(i), 'mcpServers'], p.mcpServers).every(plain))) keyed.push(f);
        for (const p of list) {
          if (!isDoc(p) || typeof p.source !== 'string') continue;
          for (const n of namedPaths(p.mcpServers)) {
            const named = path.resolve(path.dirname(path.dirname(f)), p.source, n);
            if (found.includes(named) && !fileServers('', named, broken).every(plain)) keyed.push(named);
          }
        }
      }
    }
  }
  return { keyed: [...new Set(keyed)], broken: [...new Set(broken)], hidden };
}

/**
 * What the home's agent configuration mirror carries to a worker whose consent is `consent` and whose `facts` are known:
 * Claude's CLAUDE.md, skills, rules, agents, commands, keybindings, settings by key and installed plugins with their
 * marketplaces; Codex's AGENTS.md and config.toml by key; OpenCode's folders, AGENTS.md and config by key; ~/.agents/skills,
 * the fleet's agent profiles and every agent's MCP servers but the Mac-only ones, a project's only where the worker has
 * it. A key travels only where its field is ticked; logins never do; a file over 5 MB, a tree over 200 MB or a path ustar
 * cannot hold is skipped with a line in `skipped`.
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
    if (isMacOnly(s)) macOnly.push({ agent: s.agent, name: s.name });
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

  const pluginConfigs = readPluginConfigs(plugins, unreadable);
  // what never travels as a file, links to it included: logins, the agents' config files, plugin server files, which
  // travel redacted, files that cannot be read, Svall's own OpenCode plugin, and a plugin's settings not ticked
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
  for (const c of pluginConfigs) {
    const key = pluginKey(c.name);
    const ticked = c.fields.length > 0 && tickedFields(consent, key, c.fields).length === c.fields.length;
    if (!ticked) hold(c.file);
    const row = pluginRows.find((r) => r.key === key);
    if (!row) pluginRows.push({ key, name: c.name, fields: c.fields, ticked, files: [c.file] });
    else Object.assign(row, { fields: [...new Set([...row.fields, ...c.fields])], ticked: row.ticked && ticked, files: [...row.files, c.file] });
  }
  const keep = (file: string): boolean => {
    const real = realPath(file);
    return !withheld.has(real) && ![file, real].some(secret);
  };
  // the files under `top` that `keep` and `also` let go, once `vet` has seen them
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

  // a marketplace's plugin server file or settings that holds a key stays here, as one that cannot be read does
  const pluginsDir = path.join(o.claudeDir, 'plugins');
  const installs = plugins.map((p) => clean(p.installPath));
  // a file the mirror writes itself, as the Mac's `from` would land; one holding a ticked key for its owner alone
  const withKeys = new Set<string>();
  const made = (from: string, data: string, keyed = false): void => {
    const to = path.posix.join('claude', path.posix.relative(o.claudeDir, from));
    if (Buffer.byteLength(data) > MIRROR_FILE_MAX) skipped.push(`${from} is over ${MIRROR_FILE_MAX / 2 ** 20} MB`);
    else files.push({ from, to, mode: keyed ? 0o600 : (statOf(from)?.mode ?? 0o644) & 0o777, data });
    if (keyed) withKeys.add(to);
  };
  // one that cannot be read now stays as the worker has it
  const unread = (file: string): void => {
    skipped.push(`${file} cannot be read`);
    unreadable.push(file);
  };
  tree('claude', path.join(pluginsDir, 'marketplaces'), 'plugins/marketplaces', (f) => !installs.some((i) => holds(i, f)), (found) => {
    const { keyed, broken, hidden } = marketplaceKeys(found);
    for (const f of keyed) skipped.push(`${f} holds a key`);
    for (const f of broken) unread(f);
    for (const f of [...keyed, ...broken, ...hidden]) hold(f);
  });
  for (const p of plugins) {
    if (!holds(pluginsDir, clean(p.installPath)) || clean(p.installPath) === pluginsDir) {
      skipped.push(`${p.installPath} lies outside ${pluginsDir}`);
      continue;
    }
    // a manifest that cannot be read, or the marketplace list its entry is in, may name a server file, so nothing of its plugin travels
    if (unreadable.includes(manifestOf(p.installPath)) || p.unreadMarket) {
      skipped.push(`${p.unreadMarket ?? manifestOf(p.installPath)} cannot be read`);
      continue;
    }
    tree('claude', p.installPath, path.posix.relative(o.claudeDir, p.installPath));
    for (const [file, ss] of byFile) {
      if (!holds(p.installPath, file) || unreadable.includes(file)) continue;
      const data = pluginFile(file, ss, consent);
      if (data === undefined) unread(file);
      else made(file, data, ss.some((s) => !isMacOnly(s) && mirrored(s, consent).ticked.length > 0));
    }
  }
  // a plugin's settings ticked whole hold its keys
  const tickedSettings = new Set(pluginRows.filter((r) => r.ticked).flatMap((r) => r.files));
  for (const f of files) {
    if (!tickedSettings.has(f.from)) continue;
    f.mode = 0o600;
    withKeys.add(f.to);
  }
  for (const name of PLUGIN_LISTS) {
    const from = path.join(o.claudeDir, 'plugins', name);
    if (unreadable.includes(from) || !fs.existsSync(from)) continue;
    const doc = readJson(from);
    if (doc === undefined) unread(from);
    else made(from, `${JSON.stringify(withoutLogins(doc), null, 2)}\n`);
  }
  one('claude', o.claudeDir, 'CLAUDE.md');
  one('claude', o.claudeDir, 'keybindings.json');
  for (const t of ['skills', 'rules', 'agents', 'commands']) tree('claude', path.join(o.claudeDir, t), t);
  one('codex', o.codexDir, 'AGENTS.md');
  tree('home', path.join(o.homedir, '.agents/skills'), '.agents/skills');
  for (const t of OPENCODE_TREES) tree('opencode', path.join(o.opencodeDir, t), t);
  one('opencode', o.opencodeDir, 'AGENTS.md');
  if (o.agentProfiles) tree('profiles', o.agentProfiles, '');

  const carried = files.filter((f) => {
    if (ustarFits(Buffer.from(`./${f.to}`))) return true;
    skipped.push(`${f.from} has a path too long for the mirror to carry`);
    return false;
  });
  // a server's env key not ticked is the worker's own variable, as the agent's reference left in its place reads it
  const envKeys = servers.flatMap((s) => s.secretFields.filter((f) => f.startsWith('env.') && !s.ticked.includes(f)).map((f) => f.slice('env.'.length)));
  const vars = [...servers.flatMap((s) => s.needs), ...envKeys, ...(codexDoc ? configNeeds('codex', codexDoc) : []), ...ocDocs.flatMap((d) => configNeeds('opencode', d.doc))]
    .filter((v) => VAR_NAME.test(v));
  return {
    files: carried, servers, macOnly, configs,
    settingsEnv: Object.fromEntries(Object.entries(env).filter(([k]) => !settingsOff.includes(`env.${k}`))),
    settings: configRedacted(settingsDoc, settingsOff), plugins: pluginRows,
    ...(codexDoc && { codex: configRedacted(codexDoc, codexOff) }),
    opencode: ocDocs.map((d) => ({ file: d.file, doc: configRedacted(d.doc, ocOff.filter((f) => d.fields.includes(f))), fields: d.fields })),
    homes: { homedir: o.homedir, claudeDir: o.claudeDir, claudeJson: o.claudeJson, codexDir: o.codexDir, opencodeDir: o.opencodeDir },
    vars: [...new Set(vars)].sort(), unreadable: [...new Set(unreadable)], keep: carried.map((f) => f.to), keyed: carried.filter((f) => withKeys.has(f.to)).map((f) => f.to), skipped,
  };
}

/**
 * Packs into the tar `file` each planned file `state` does not record as the worker holds it, and the plan as the worker
 * applies it, which leaves out the files, the previews and the lines skipped.
 */
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

// every string under a path key moved by `move`
export function relocated(v: unknown, move: (p: string) => string, under = false): unknown {
  if (typeof v === 'string') return under && path.posix.isAbsolute(v) ? move(v) : v;
  if (Array.isArray(v)) return v.map((x) => relocated(x, move, under));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relocated(x, move, under || PATH_KEY.test(k))]));
  return v;
}

// `file`, through a link, readable and writable by its owner alone
function ownerOnly(file: string): void {
  const at = realPath(file);
  const mode = statOf(at)?.mode;
  if (mode !== undefined && (mode & 0o777) !== 0o600) fs.chmodSync(at, 0o600);
}

// `data` at `file`, through a link, unless it holds those bytes already
function put(file: string, data: Buffer, mode: number): boolean {
  const at = realPath(file);
  if (fs.existsSync(at) && fs.readFileSync(at).equals(data)) return false;
  fs.mkdirSync(path.dirname(at), { recursive: true });
  writeDurable(at, data, { mode });
  return true;
}

/** The mirror's record on this machine; an empty one where there is none. */
export function readState(file: string): WorkerState {
  try {
    const p = WorkerState.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (p.success) return p.data;
  } catch { /* none yet */ }
  return { files: {}, docs: {}, servers: {}, secrets: {} };
}

/** What a worker tells the home before a mirror: its record, and which of the Mac's project folders it has under its home. */
export function configState(ask: z.infer<typeof StateAsk>, o: { stateFile: string; homedir: string }): WorkerFacts {
  const r = { from: ask.homedir, to: o.homedir };
  return { state: readState(o.stateFile), projects: Object.fromEntries(ask.projects.map((p) => [p, fs.existsSync(relocate(p, r))])) };
}

/** How the mirror moves a path from the Mac's homes into this machine's: one under Claude's folder into this one's, else by home. */
export function mover(mac: { homedir: string; claudeDir: string }, here: { homedir: string; claudeDir: string }): (p: string) => string {
  const claude = { from: mac.claudeDir, to: here.claudeDir };
  return (p) => relocate(p, holds(clean(claude.from), clean(p)) ? claude : { from: mac.homedir, to: here.homedir });
}

/** Where `place` in doc `name` lies on this machine: a Claude project's under this machine's own path of it. */
export const placedIn = (name: DocName, place: Place, move: (p: string) => string): Place =>
  (name === '.claude.json' && place[0] === 'projects' ? ['projects', realPath(move(String(place[1]))).normalize('NFC'), ...place.slice(2)] : place);

/** The record's key for what lies at `place` in doc `name`, `place` as the Mac holds it. */
export const recordKey = (name: DocName, place: Place): string => JSON.stringify([name, ...place]);

const asJson = (doc: Doc): string => `${JSON.stringify(doc, null, 2)}\n`;
type DocSpec = {
  name: DocName; at: (h: Homes) => string; parse: (text: string) => unknown; format: (doc: Doc) => string;
  /** Keys its merge never writes, and the consent item of its key fields. */
  owned: readonly string[]; item?: string;
  /** Its override, in the overrides' layout; `servers` the key whose servers an override merges into by name, taking no other when `serversOnly`. */
  override: string; servers?: string; serversOnly?: boolean; empty?: Doc;
};
const DOCS: DocSpec[] = [
  { name: 'settings.json', at: (h) => path.join(h.claudeDir, 'settings.json'), parse: JSON.parse, format: asJson, owned: WORKER_OWNED, item: CONFIG_ITEMS.settings, override: 'claude/settings.json' },
  {
    name: '.claude.json', at: (h) => h.claudeJson, parse: JSON.parse, format: asJson, owned: [], override: 'claude/.claude.json', servers: 'mcpServers', serversOnly: true,
    empty: { mcpServers: {} },
  },
  {
    name: 'config.toml', at: (h) => path.join(h.codexDir, 'config.toml'), parse: parseToml, format: (d) => stringifyToml(d), owned: [...CODEX_WORKER_OWNED, ...CODEX_MAC_ONLY],
    item: CONFIG_ITEMS.codex, override: 'codex/config.toml', servers: 'mcp_servers',
  },
  ...OPENCODE_FILES.map((name): DocSpec => ({
    name, at: (h) => path.join(h.opencodeDir, name), parse: (t) => parseJsonc(t), format: asJson, owned: OPENCODE_WORKER_OWNED, item: CONFIG_ITEMS.opencode,
    override: `opencode/${name}`, servers: 'mcp',
  })),
];

// a config file's object, or undefined for none; one that holds no object stops the mirror, named without what it holds
function readDocFile(file: string, parse: (text: string) => unknown): Doc | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (isNoFile(e)) return undefined;
    throw e;
  }
  let doc: unknown;
  try { doc = parse(text); } catch { /* named below */ }
  if (!isDoc(doc)) throw new Error(`${file} cannot be parsed, so the mirror left this machine's agent configuration as it was`);
  return doc;
}

// `b` over `a`, objects merged key by key all the way down
const overlay = (a: unknown, b: unknown): unknown =>
  isDoc(a) && isDoc(b) ? { ...a, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, overlay(a[k], v)])) } : b;

// `override` merged over `doc`: its servers by name, and its other keys whole unless it takes servers only
function overrideOver(d: DocSpec, doc: Doc, override: Doc | undefined): void {
  for (const [k, v] of Object.entries(override ?? {})) {
    if (k === d.servers) doc[k] = overlay(doc[k], v);
    else if (!d.serversOnly) doc[k] = v;
  }
}

/** Config file `name` of this machine with its override merged over it; undefined where either cannot be parsed. */
export function docWithOverride(name: DocName, o: Homes & { overrides: string }): Doc | undefined {
  const d = DOCS.find((x) => x.name === name);
  if (!d) return undefined;
  try {
    const doc = readDocFile(d.at(o), d.parse) ?? {};
    overrideOver(d, doc, readDocFile(path.join(o.overrides, d.override), d.parse));
    return doc;
  } catch {
    return undefined;
  }
}

/**
 * A secret value's place in a doc: `want` the Mac's when its field is ticked, `bare` what stands there when not, none for
 * nothing; `named` when the place names the value itself rather than a url or arg holding it, `remerged` when the doc
 * merge wrote over it now, `overOwn` when a ticked value goes over one the worker set itself, `server` a Codex server
 * whose env it lies in.
 */
type Leaf = { record: string; place: Place; want?: string; bare?: string; named: boolean; remerged: boolean; overOwn: boolean; server?: Place };

// `v` at the leaf; a Codex env value not set is named in its server's env_vars instead, and only then
function setLeaf(doc: Doc, l: Leaf, v: string | undefined): void {
  setAt(doc, l.place, v);
  if (!l.server) return;
  const name = String(l.place[l.place.length - 1]);
  const names = getAt(doc, [...l.server, 'env_vars']);
  const rest = (Array.isArray(names) ? names : []).filter((n: unknown) => n !== name && !(isDoc(n) && n.name === name));
  setAt(doc, [...l.server, 'env_vars'], v === undefined ? [...rest, name] : rest.length ? rest : undefined);
}

// one secret value, `was` the doc before this apply: a ticked one is the Mac's unless it would go over the worker's own
// and may not; a copied one is emptied once unticked; the worker's own goes back where the merge wrote over it
function settle(doc: Doc, was: Doc, l: Leaf, recorded: Copied | undefined, secrets: WorkerState['secrets']): void {
  const pre = getAt(was, l.place);
  const copied = isCopy(recorded, pre);
  const own = typeof pre === 'string' && pre !== '' && pre !== l.bare && !copied && (l.named || !l.remerged);
  const now = getAt(doc, l.place);
  if (l.want !== undefined && (l.overOwn || !own)) {
    if (now !== l.want) setLeaf(doc, l, l.want);
    secrets[l.record] = sha256Hex(l.want);
    return;
  }
  if (recorded !== undefined) secrets[l.record] = recorded;
  if (copied && now !== l.bare) setLeaf(doc, l, l.bare);
  else if (own && now !== pre) setLeaf(doc, l, pre as string);
}

// the leaves of `fields` of a doc or entry, grouped by the place each lies at
function leavesOf(fields: string[], placeOf: (field: string) => Place | undefined): { place: Place; fields: string[] }[] {
  const groups = new Map<string, { place: Place; fields: string[] }>();
  for (const f of fields) {
    const place = placeOf(f);
    if (!place) continue;
    const k = JSON.stringify(place);
    groups.set(k, { place, fields: [...(groups.get(k)?.fields ?? []), f] });
  }
  return [...groups.values()];
}

/**
 * Puts the mirror unpacked at `blobDir` into this machine's homes, reading and writing each file of theirs at once:
 * each config file merged by key, its servers in place and its secrets as ticked, then each file the record says changed,
 * each the home no longer carries removed, and the overrides last. A record of everything this apply may write goes
 * first, so an apply cut short still knows each copy it left; the record of what it wrote goes last.
 */
export function applyMirror(blobDir: string, o: MirrorHomes & { overrides: string; stateFile: string; varsFile: string }): { written: string[]; removed: string[] } {
  const m = Manifest.parse(JSON.parse(fs.readFileSync(path.join(blobDir, MANIFEST), 'utf8')));
  const state = readState(o.stateFile);
  const next: WorkerState = { files: {}, docs: {}, servers: {}, secrets: {} };
  const written: string[] = [];
  const removed: string[] = [];
  const move = mover(m.homes, o);
  // read before anything is written: a config file or override that cannot be parsed stops the mirror rather than be replaced
  const current = DOCS.map((d) => ({ doc: readDocFile(d.at(o), d.parse), override: readDocFile(path.join(o.overrides, d.override), d.parse) }));
  const docs = DOCS.map((d, i) => applyDoc(d, current[i].doc, current[i].override, { m, state, next, move }));
  const carried = (Object.keys(ROOTS) as Root[]).flatMap((root) => {
    const home = o[ROOTS[root]];
    return home ? filesIn(path.join(blobDir, root)).map((rel) => ({ root, home, rel, to: path.posix.join(root, rel), from: path.join(blobDir, root, rel) })) : [];
  });
  for (const f of carried) next.files[f.to] = sha256Hex(fs.readFileSync(f.from));
  for (const to of m.keyed) {
    const h = next.files[to] ?? state.files[to];
    if (h) (next.keyed ??= {})[to] = h;
  }
  put(o.stateFile, Buffer.from(asJson(provisional(state, next))), 0o600);
  // where `to` lies in this machine's homes
  const fileOf = (to: string): string | undefined => {
    const [root, ...rest] = to.split('/');
    const home = Object.hasOwn(ROOTS, root) ? o[ROOTS[root as Root]] : undefined;
    return home && path.join(home, ...rest);
  };

  // a config file holding a ticked key is its owner's alone, whether or not this apply changed it
  DOCS.forEach((d, i) => {
    const { doc, keyed } = docs[i];
    if (doc && put(d.at(o), Buffer.from(d.format(doc)), keyed ? 0o600 : (statOf(d.at(o))?.mode ?? 0o600) & 0o777)) written.push(d.at(o));
    if (keyed) ownerOnly(d.at(o));
  });
  for (const { root, home, rel, to, from } of carried) {
    if (state.files[to] === next.files[to]) continue;
    const data = fs.readFileSync(from);
    const override = path.join(o.overrides, root, rel);
    const list = root === 'claude' && PLUGIN_LISTS.some((n) => rel === path.join('plugins', n));
    const bytes = fs.existsSync(override) ? fs.readFileSync(override) : list ? Buffer.from(asJson(relocated(JSON.parse(data.toString('utf8')), move) as Doc)) : data;
    const file = path.join(home, rel);
    if (put(file, bytes, fs.statSync(from).mode & 0o777)) written.push(file);
  }
  const keep = new Set(m.keep);
  const pluginList = path.join(m.homes.claudeDir, 'plugins/installed_plugins.json');
  // a plugin file stays as the mirror last wrote it while the Mac cannot read it, its plugin's manifest or the plugin list
  const unread = (to: string): boolean => {
    if (!to.startsWith('claude/plugins/')) return false;
    const mac = path.join(m.homes.claudeDir, to.slice('claude/'.length));
    return m.unreadable.some((u) => u === pluginList || u === mac || (u.endsWith('/.claude-plugin/plugin.json') && holds(path.dirname(path.dirname(u)), mac)));
  };
  for (const [to, h] of Object.entries(state.files)) {
    if (Object.hasOwn(next.files, to)) continue;
    if (keep.has(to) || unread(to)) {
      next.files[to] = h;
      if (unread(to) && state.keyed?.[to]) (next.keyed ??= {})[to] = state.keyed[to];
      continue;
    }
    const file = fileOf(to);
    if (file && fs.lstatSync(file, { throwIfNoEntry: false })) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  // a file holding a ticked key is its owner's alone, whether or not this apply wrote it
  for (const to of Object.keys(next.keyed ?? {})) {
    const file = fileOf(to);
    if (file) ownerOnly(file);
  }
  // the overrides of whole files, each over what the mirror wrote there
  const docOverrides = new Set(DOCS.map((d) => d.override));
  for (const root of Object.keys(ROOTS) as Root[]) {
    const home = o[ROOTS[root]];
    if (!home) continue;
    for (const rel of filesIn(path.join(o.overrides, root))) {
      if (docOverrides.has(path.posix.join(root, rel))) continue;
      const from = path.join(o.overrides, root, rel);
      const file = path.join(home, rel);
      if (put(file, fs.readFileSync(from), fs.statSync(from).mode & 0o777)) written.push(file);
    }
  }

  put(o.varsFile, Buffer.from(`${JSON.stringify(m.vars, null, 2)}\n`), 0o644);
  put(o.stateFile, Buffer.from(asJson(next)), 0o600);
  return { written, removed };
}

type Applying = { m: Manifest; state: WorkerState; next: WorkerState; move: (p: string) => string };

// one config file as the mirror leaves it, none when that is as it was, and whether it holds a ticked value: its
// keys merged, its servers put in place, its secrets settled and its override over them; one the Mac could not read keeps
// the record of it
function applyDoc(d: DocSpec, current: Doc | undefined, override: Doc | undefined, { m, state, next, move }: Applying): { doc?: Doc; keyed: boolean } {
  const doc: Doc = current ?? structuredClone(d.empty ?? {});
  const before = JSON.stringify(doc);
  const was = JSON.parse(before) as Doc;
  const leave = m.unreadable.includes(d.at(m.homes));
  const records = <T>(of: Record<string, T>): [string, T][] => Object.entries(of).filter(([k]) => JSON.parse(k)[0] === d.name);
  const leaves: Leaf[] = [];

  // its keys, each written when the Mac's changed since the mirror last wrote it
  const config = m.configs.find((c) => c.key === d.item);
  const oc = m.opencode.find((x) => x.file === d.name);
  const macDoc = d.name === 'settings.json' ? m.settings : d.name === 'config.toml' ? m.codex : oc?.doc;
  // this file's own secret fields: an OpenCode file shares its row with the other
  const fields = oc ? oc.fields : config?.fields ?? [];
  const remergedKeys = new Set<string>();
  let bareDoc: Doc = {};
  if (d.name !== '.claude.json' && leave) next.docs[d.name] = state.docs[d.name] ?? {};
  else if (d.name !== '.claude.json') {
    const ticked = relocated(macDoc ?? {}, move) as Doc;
    const bare = configRedacted(ticked, (config?.ticked ?? []).filter((f) => fields.includes(f)));
    bareDoc = bare;
    const recorded = state.docs[d.name] ?? {};
    const shas: Record<string, string> = {};
    for (const [k, v] of Object.entries(bare)) {
      if (d.owned.includes(k)) continue;
      shas[k] = sha(v);
      if (recorded[k] === shas[k]) continue;
      doc[k] = structuredClone(v);
      remergedKeys.add(k);
    }
    for (const k of Object.keys(recorded)) if (!Object.hasOwn(shas, k) && !d.owned.includes(k)) delete doc[k];
    next.docs[d.name] = shas;
    for (const g of leavesOf(fields, (f) => configPlace(ticked, f))) {
      leaves.push({
        record: recordKey(d.name, g.place), place: g.place, want: g.fields.some((f) => config?.ticked.includes(f)) ? getAt(ticked, g.place) as string : undefined,
        bare: getAt(bare, g.place) as string, named: g.fields.every((f) => f === g.place.join('.')), remerged: remergedKeys.has(String(g.place[0])), overOwn: true,
      });
    }
  }
  // Claude's env, which the worker owns: a ticked key never over one the worker set itself
  if (d.name === 'settings.json') {
    for (const f of config?.fields ?? []) {
      if (!f.startsWith('env.')) continue;
      const k = f.slice('env.'.length);
      leaves.push({
        record: recordKey(d.name, ['env', k]), place: ['env', k], want: config?.ticked.includes(f) ? m.settingsEnv[k] : undefined, named: true, remerged: false, overOwn: false,
      });
    }
  }

  // its servers, each in its own place, a Claude project's under the worker's own path of it
  const placed = (place: Place): Place => placedIn(d.name, place, move);
  const servers: Record<string, string> = {};
  const carried: { place: string[]; at: Place; bare: Doc; codex: boolean }[] = [];
  for (const s of m.servers.filter((x) => x.doc === d.name && Object.keys(x.entry).length)) {
    const rk = recordKey(d.name, s.place);
    const at = placed(s.place);
    const entry = relocatedServer(s.entry, move);
    const bare = relocatedServer(s.bare, move);
    carried.push({ place: s.place, at, bare, codex: s.agent === 'codex' });
    servers[rk] = sha(bare);
    // a server ticked whole carries its fields as they are, keys among them
    const whole = !s.secretFields.length && s.ticked.length ? serverSha(bare) : undefined;
    if (whole) (next.whole ??= {})[rk] = whole;
    const remerged = state.servers[rk] !== servers[rk] || getAt(doc, at) === undefined;
    if (remerged) setAt(doc, at, structuredClone(bare));
    for (const g of leavesOf(s.secretFields, (f) => fieldPlace(s.agent, s.entry, f))) {
      leaves.push({
        record: recordKey(d.name, [...s.place, ...g.place]), place: [...at, ...g.place],
        want: g.fields.some((f) => s.ticked.includes(f)) ? getAt(entry, g.place) as string : undefined, bare: getAt(bare, g.place) as string | undefined,
        named: !g.fields.some((f) => f.startsWith('url') || f.startsWith('args[')), remerged, overOwn: true,
        ...(s.agent === 'codex' && g.place[0] === 'env' && { server: at }),
      });
    }
  }
  for (const [rk, h] of records(state.servers)) {
    if (Object.hasOwn(servers, rk)) continue;
    if (!leave) setAt(doc, placed((JSON.parse(rk) as Place).slice(1)), undefined);
    else {
      servers[rk] = h;
      if (state.whole?.[rk]) (next.whole ??= {})[rk] = state.whole[rk];
    }
  }
  Object.assign(next.servers, servers);

  for (const l of leaves) settle(doc, was, l, state.secrets[l.record], next.secrets);
  // a value copied where the Mac now holds no secret is emptied as that place stands bare, while it is still the copy
  for (const [k, h] of records(state.secrets)) {
    if (leave) next.secrets[k] ??= h;
    if (leave || Object.hasOwn(next.secrets, k)) continue;
    const place = (JSON.parse(k) as Place).slice(1);
    const s = carried.find((c) => c.place.every((p, i) => place[i] === p));
    const leaf = s ? place.slice(s.place.length) : place;
    const l: Leaf = {
      record: k, place: s ? [...s.at, ...leaf] : placed(place), named: true, remerged: false, overOwn: true,
      bare: (s ? getAt(s.bare, leaf) : d.name === 'settings.json' && place[0] === 'env' ? undefined : getAt(bareDoc, place)) as string | undefined,
      ...(s?.codex && leaf[0] === 'env' && { server: s.at }),
    };
    if (isCopy(h, getAt(doc, l.place))) setLeaf(doc, l, l.bare);
  }

  overrideOver(d, doc, override);
  const keyed = leaves.some((l) => l.want !== undefined) || m.servers.some((x) => x.doc === d.name && Object.keys(x.entry).length > 0 && x.ticked.length > 0);
  return JSON.stringify(doc) === before ? { keyed } : { doc, keyed };
}

/** The home's side: its agent configuration packed and sent to a worker, by what the consent file ticks for it. */
export class Mirror {
  // each worker's last push, which its next one waits for
  private chains = new Map<MachineId, Promise<unknown>>();

  /** `overridesThere`: the fleet's overrides folder on a worker, as its rows name it. */
  constructor(private o: MirrorHomes & { consent: string; log: Logger; overridesThere?: string }) {}

  /** Resolves once the worker has applied what `link` carried; pushes to one worker go one at a time, in order. */
  push(link: Pick<WorkerLink, 'call' | 'sendBlob' | 'machine'>): Promise<{ sent: number }> {
    const run = (this.chains.get(link.machine) ?? Promise.resolve()).then(() => this.pushNow(link));
    this.chains.set(link.machine, run.catch(() => {}));
    return run;
  }

  /** Ticks `fields` of `item` for `machine`, or, `on` false, unticks every field of it. */
  consent(machine: MachineId, item: string, fields: string[], on: boolean): void {
    setConsent(this.o.consent, machine, item, fields, on);
  }

  /** The file of this Mac that holds `item` and cannot be read now, which leaves the item on a worker as the mirror last wrote it. */
  unreadFile(item: string): string | undefined {
    const o = this.o;
    const plugin = /^claude:plugin:(.+?)(?::mcp:.*)?$/.exec(item)?.[1];
    const installs = plugin === undefined ? [] : readPlugins(o.claudeDir, []).filter((p) => p.name === plugin);
    const holdsItem = (f: string): boolean => {
      if (plugin !== undefined) return f === path.join(o.claudeDir, 'plugins/installed_plugins.json') || installs.some((i) => holds(clean(i.installPath), f) || i.unreadMarket === f);
      if (item === CONFIG_ITEMS.settings) return f === path.join(o.claudeDir, 'settings.json');
      if (item.startsWith('claude:')) return f === o.claudeJson;
      if (item.startsWith('codex:')) return f === path.join(o.codexDir, 'config.toml');
      return item.startsWith('opencode:') && OPENCODE_FILES.some((n) => f === path.join(o.opencodeDir, n));
    };
    return mirrorPlan(o).unreadable.find(holdsItem);
  }

  /**
   * The setup rows of the mirror to `machine`, named `o.name`: what its next push carries by its consent, and what the
   * worker holds and runs, asked over `link` while it is linked.
   */
  async report(link: Pick<WorkerLink, 'call' | 'connected' | 'mismatch'> | undefined, machine: MachineId, o: { name: string; fleetFlag: string }): Promise<SetupRow[]> {
    // the worker's answer; none while it is not linked, or when it does not answer
    const ask = async <T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T | undefined> => {
      if (!link?.connected()) return undefined;
      try {
        return schema.parse(await link.call(method, params, { timeoutMs: REPORT_MS }));
      } catch (e) {
        this.o.log.error(`mirror: ${o.name} did not answer ${method}: ${(e as Error).message}`);
        return undefined;
      }
    };
    const facts = await ask('config.state', { homedir: this.o.homedir, projects: this.projects() }, WorkerFacts);
    const plan = mirrorPlan(this.o, readConsent(this.o.consent, machine), facts);
    // a worker that did not answer the first is not asked again
    const report = facts && await ask('config.report', reportAsk(plan), ConfigReport);
    const unchecked = link?.mismatch() ? `not checked: ${o.name} runs another release; upgrade it` : `not checked: ${o.name} is not reachable`;
    return setupRows(plan, report, { machine: o.name, fleetFlag: o.fleetFlag, unchecked, overrides: this.o.overridesThere ?? '~/.svall/mirror-overrides' });
  }

  // the Mac's project folders that hold servers
  private projects(): string[] {
    return [...new Set(readServers(this.o, []).servers.flatMap((s) => (typeof s.scope === 'object' && 'project' in s.scope ? [s.scope.project] : [])))];
  }

  private async pushNow(link: Pick<WorkerLink, 'call' | 'sendBlob' | 'machine'>): Promise<{ sent: number }> {
    const facts = WorkerFacts.parse(await link.call('config.state', { homedir: this.o.homedir, projects: this.projects() }));
    const plan = mirrorPlan(this.o, readConsent(this.o.consent, link.machine), facts);
    for (const line of plan.skipped) this.o.log.info(`mirror: ${line}; it stays on this Mac`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-mirror-'));
    try {
      const file = path.join(dir, 'mirror.tar');
      const { sent } = await packMirror(plan, file, facts.state);
      const id = `mirror_${crypto.randomUUID()}`;
      await link.call('config.blob', { id, sha256: await fileSha(file) });
      await link.sendBlob(id, file);
      await link.call('config.apply', { id }, { timeoutMs: APPLY_MS });
      return { sent };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
  return p.data;
};

/**
 * Holds this user's agent files for one mirror's apply, waiting while another fleet's daemon holds them: every fleet's
 * mirror on a machine writes the same files.
 */
export async function lockAgentFiles(homedir: string): Promise<() => void> {
  const name = `svall-mirror-${sha256Hex(fs.realpathSync(homedir))}`;
  for (;;) {
    const unlock = await tryLock(path.join(homedir, '.svall-mirror.lock'), name);
    if (unlock) return unlock;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// removes the blobs a daemon left under `stage`, which may hold ticked keys, answering how many
function dropBlobs(stage: string): number {
  const left = (fs.existsSync(stage) ? fs.readdirSync(stage, { withFileTypes: true }) : []).filter((f) => f.isDirectory() && f.name.startsWith('mirror-'));
  for (const f of left) fs.rmSync(path.join(stage, f.name), { recursive: true, force: true });
  return left.length;
}

/**
 * Takes back what the mirror copied into this machine's agent files, by the record at `stateFile`, each while it is still
 * the copy: a copied value becomes what an untick leaves there, a server's env key its agent's reference, a settings env
 * key gone and any other key ''; a server copied whole leaves its file; a file holding a ticked key is removed; and a blob
 * left beside the record goes. Answers a line for each file it changed or could not.
 */
export function takeBackCopies(o: Homes & { stateFile: string }): string[] {
  const state = readState(o.stateFile);
  const done: string[] = [];
  for (const d of DOCS) {
    const keys = Object.keys(state.secrets).filter((k) => JSON.parse(k)[0] === d.name);
    const whole = Object.keys(state.whole ?? {}).filter((k) => JSON.parse(k)[0] === d.name);
    if (!keys.length && !whole.length) continue;
    let doc: Doc | undefined;
    try { doc = readDocFile(d.at(o), d.parse); } catch (e) {
      done.push(`could not take the mirror's keys back from ${d.at(o)}: ${(e as Error).message}`);
      continue;
    }
    if (!doc) continue;
    const projects = Object.keys(isDoc(doc.projects) ? doc.projects : {});
    // a Claude project lies under this machine's own path of it, which the record does not keep
    const places = (k: string): Place[] => {
      const place = (JSON.parse(k) as Place).slice(1);
      return d.name === '.claude.json' && place[0] === 'projects' ? projects.map((p) => ['projects', p, ...place.slice(2)]) : [place];
    };
    let n = 0;
    for (const k of keys) {
      for (const at of places(k)) {
        if (!isCopy(state.secrets[k], getAt(doc, at))) continue;
        const key = String(at.at(-1));
        const leaf: Leaf = { record: k, place: at, named: true, remerged: false, overOwn: true };
        if (d.name === 'settings.json' && at[0] === 'env' && at.length === 2) setAt(doc, at, undefined);
        else if (d.name === 'config.toml' && at[0] === 'mcp_servers' && at.at(-2) === 'env') setLeaf(doc, { ...leaf, server: at.slice(0, -2) }, undefined);
        else if (d.name === '.claude.json' && at.at(-2) === 'env') setAt(doc, at, `\${${key}}`);
        else if (OPENCODE_FILES.some((f) => f === d.name) && at[0] === 'mcp' && at.at(-2) === 'environment') setAt(doc, at, `{env:${key}}`);
        else setAt(doc, at, '');
        n += 1;
      }
    }
    let w = 0;
    for (const k of whole) {
      for (const at of places(k)) {
        const v = getAt(doc, at);
        if (!isDoc(v) || !isCopyOf(state.whole?.[k], serverSha(v))) continue;
        setAt(doc, at, undefined);
        w += 1;
      }
    }
    if (!n && !w) continue;
    put(d.at(o), Buffer.from(d.format(doc)), (statOf(d.at(o))?.mode ?? 0o600) & 0o777);
    const took = [n && `${n} ${n === 1 ? 'key' : 'keys'} the mirror copied`, w && `${w} ${w === 1 ? 'server' : 'servers'} the mirror copied whole`].filter(Boolean);
    done.push(`took ${took.join(' and ')} out of ${d.at(o)}`);
  }
  // every file holding a ticked key is a plugin's, under Claude's folder
  for (const [to, h] of Object.entries(state.keyed ?? {})) {
    if (!to.startsWith('claude/')) continue;
    const file = path.join(o.claudeDir, to.slice('claude/'.length));
    let bytes: Buffer;
    try { bytes = fs.readFileSync(realPath(file)); } catch { continue; }
    if (!isCopyOf(h, sha256Hex(bytes))) continue;
    try {
      fs.rmSync(realPath(file), { force: true });
      done.push(`removed ${file}, which held keys the mirror copied`);
    } catch (e) {
      done.push(`could not remove ${file}, which holds keys the mirror copied: ${(e as Error).message}`);
    }
  }
  const blobs = dropBlobs(path.dirname(o.stateFile));
  if (blobs) done.push(`removed ${blobs} mirror ${blobs === 1 ? 'blob' : 'blobs'} left in ${path.dirname(o.stateFile)}`);
  return done;
}

/**
 * A worker's side: `config.state` answers with its record and which of the Mac's projects it has, `config.report` with
 * what it holds and runs of what the home asks, `config.blob` takes the blob's id before the home sends a byte of it,
 * and `config.apply` applies it once it has arrived as it left, answering with the files written and removed. A blob
 * may hold ticked keys, so none outlasts the link it came over or the daemon that took it.
 */
export function mirrorCalls(o: MirrorHomes & {
  overrides: string; stage: string; stateFile: string; varsFile: string; envFile: string; connection: Pick<HomeConnection, 'receiveBlob'>; log: Logger;
}): { calls: Record<string, (raw: unknown) => Promise<unknown>>; linkLost(): void } {
  const blobs = new Map<string, { dir: string; sha256: string; got: Promise<{ sha256: string }>; applying?: true }>();
  const drop = (id: string): void => {
    const b = blobs.get(id);
    blobs.delete(id);
    if (b) fs.rmSync(b.dir, { recursive: true, force: true });
  };
  dropBlobs(o.stage);
  const calls: Record<string, (raw: unknown) => Promise<unknown>> = {
    'config.state': async (raw) => configState(parse(StateAsk, raw), o),
    'config.report': async (raw) => configReport(parse(ReportAsk, raw), o),
    'config.blob': async (raw) => {
      const { id, sha256 } = parse(Offer, raw);
      fs.mkdirSync(o.stage, { recursive: true });
      const dir = fs.mkdtempSync(path.join(o.stage, 'mirror-'));
      const got = o.connection.receiveBlob(id, path.join(dir, 'mirror.tar'));
      // a link that closes before the apply leaves nothing behind
      got.catch(() => drop(id));
      blobs.set(id, { dir, sha256, got });
      return { ready: true };
    },
    'config.apply': async (raw) => {
      const { id } = parse(ById, raw);
      const b = blobs.get(id);
      if (!b) throw new ApiError('not_found', `no agent configuration ${id} came here`);
      b.applying = true;
      try {
        if ((await b.got).sha256 !== b.sha256) throw new Error('the agent configuration did not arrive as it left');
        await unpack(path.join(b.dir, 'mirror.tar'), path.join(b.dir, 'blob'));
        const unlock = await lockAgentFiles(o.homedir);
        let done: { written: string[]; removed: string[] };
        try { done = applyMirror(path.join(b.dir, 'blob'), o); } finally { unlock(); }
        if (done.written.length || done.removed.length) o.log.info(`mirror: ${done.written.length} files of the home's agent configuration written, ${done.removed.length} removed`);
        return done;
      } finally {
        drop(id);
      }
    },
  };
  // the one being applied goes once it is
  return { calls, linkLost: () => { for (const [id, b] of blobs) if (!b.applying) drop(id); } };
}
