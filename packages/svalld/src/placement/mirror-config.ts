import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { VAR_NAME } from '../claude.js';
import { holds } from '../path-tools.js';
import { shq } from '../text.js';
import { relocated, type MirrorHomes } from './mirror-state.js';

export const Scope = z.union([z.literal('user'), z.object({ project: z.string() }), z.object({ plugin: z.string() })]);
export type Scope = z.infer<typeof Scope>;

/**
 * An MCP server as its agent's config holds it: `raw` the entry, the rest read from it; `place` the keys to it in `file`;
 * `known` whether Svall reads every field of it, which it cannot for a shell's -c script.
 */
export type McpServer = {
  agent: AgentKind; name: string; scope: Scope; command?: string; args: string[]; cwd?: string; env: Record<string, string>;
  url?: string; headers: Record<string, string>; raw: Record<string, unknown>; known: boolean; file?: string; place?: string[];
};
/**
 * An installed plugin; `named`, `namedLsp` and `namedAgents` the server files, LSP configs and subagents its marketplace
 * entry names by path, `unreadMarket` its marketplace.json when that cannot be read.
 */
export type PluginInstall = { name: string; installPath: string; named?: string[]; namedLsp?: string[]; namedAgents?: string[]; unreadMarket?: string };
/**
 * A value found by its field: `env.<KEY>`, `headers.<Name>`, `url.<param>`, `url.userinfo`, `url.path`, `args[<arg>]`, `args[<arg>].<param>`,
 * `args[<arg>].userinfo`, `args[<arg>].path`, `args[<arg>].<JSON path>`, `oauth.<key>`, an arg by what names it as argFields says; a
 * field that holds several is listed once for each.
 */
export type Secret = { field: string; value: string };

// the server fields each agent's own schema names
const AGENT_FIELDS: Record<AgentKind, readonly string[]> = {
  claude: ['type', 'command', 'args', 'env', 'url', 'headers', 'oauth', 'timeout'],
  codex: [
    'command', 'args', 'cwd', 'env', 'url', 'oauth', 'enabled', 'bearer_token_env_var', 'env_vars', 'http_headers', 'env_http_headers', 'startup_timeout_sec',
    'startup_timeout_ms', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools',
  ],
  opencode: ['type', 'command', 'cwd', 'environment', 'url', 'headers', 'oauth', 'enabled', 'timeout'],
};
/** Where each agent's entry holds a server's env, headers and args; OpenCode's args are its `command` from index 1. */
export const FIELD_PATHS: Record<AgentKind, { env: string; headers: string; args: string }> = {
  claude: { env: 'env', headers: 'headers', args: 'args' },
  codex: { env: 'env', headers: 'http_headers', args: 'args' },
  opencode: { env: 'environment', headers: 'headers', args: 'command' },
};
// VAR_NAME unanchored
const NAME = VAR_NAME.source.slice(1, -1);
/** A reference: `${NAME}`, `${NAME:-default}` or `{env:NAME}`, the variable named in its first or second group. */
export const VAR_REF = new RegExp(`\\$\\{(${NAME})(?::-[^}]*)?\\}|\\{env:(${NAME})\\}`, 'g');
// a reference that stands for its variable alone: one with a default holds that default as a value
const BARE_REF = new RegExp(`\\$\\{${NAME}(?::-)?\\}|\\{env:${NAME}\\}`, 'g');
const KNOWN_OAUTH_HOSTS: readonly string[] = [
  'mcp.linear.app', 'mcp.notion.com', 'mcp.atlassian.com', 'mcp.sentry.dev', 'mcp.stripe.com', 'mcp.asana.com', 'mcp.intercom.com', 'mcp.figma.com',
  'mcp.vercel.com', 'mcp.cloudflare.com',
];
const CODEX_SECRET_PATHS: readonly string[] = [
  'model_providers.*.http_headers.*', 'model_providers.*.experimental_bearer_token', 'otel.**.headers.*', 'shell_environment_policy.set.*',
];
// Codex's query params, each a key as a URL's query value is
const CODEX_QUERY = 'model_providers.*.query_params.*';
// Codex's URLs whose query values may be keys, and its lists of args read as a server's
const CODEX_URLS = ['model_providers.*.base_url', 'otel.**.endpoint'];
const CODEX_ARGS = ['model_providers.*.auth.args'];
const CODEX_NEED_PATHS: readonly string[] = ['model_providers.*.env_http_headers.*', 'model_providers.*.env_key'];
const OPENCODE_SECRET_PATHS: readonly string[] = [
  'provider.*.options.apiKey', 'provider.*.options.headers.*', 'provider.*.models.*.headers.*', 'providers.*.headers.*', 'providers.*.models.*.headers.*',
  'providers.*.models.*.variants.*.headers.*', 'agents.*.request.headers.*', 'lsp.*.env.*', 'formatter.*.environment.*',
];
// OpenCode's option, settings and request body maps, each string under which is a key when its name says so
const OPENCODE_OPTIONS = [
  'provider.*.options.**', 'provider.*.models.*.options.**', 'agent.*.options.**', 'agents.*.options.**', 'providers.*.settings.**', 'providers.*.models.*.settings.**',
  'providers.*.models.*.variants.*.settings.**', 'providers.*.body.**', 'providers.*.models.*.body.**', 'providers.*.models.*.variants.*.body.**', 'agents.*.request.body.**',
];

const SECRET_FLAG = /(?:^|-)(api[-_]?key|token|secret|password|passwd|auth(?:orization)?|key|credential|bearer|pat|pass|passphrase|sig|signature)s?$/i;
// an OpenCode provider option that is a key by its name, beside those SECRET_FLAG names
const PROVIDER_KEY = /^(private[-_]?key|accessKeyId|secretAccessKey|sessionToken)$/i;
const HEADER_FLAG = /^(--header|-H)$/;
// an Authorization scheme where a string starts or after a quote, :, =, , or ;
const SCHEME = /(?<=^|[:="',;]\s*)(?:[Bb]earer|Basic|Token)\b/;
// such a scheme and the credential after it
const SCHEME_KEY = /(?<=^|[:="',;]\s*)(?:[Bb]earer|Basic|Token)\s+([\w~+/.=:${}-]+)/g;
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh'];
const ENV_KEY = new RegExp(`^(${NAME})=`);
// an upper-case KEY=, as an env assignment is, holds a key whatever it is named
const UPPER_KEY = /^[A-Z][A-Z0-9_]*$/;
// a URL's userinfo, up to the last @ before the / ? # or space that ends its authority; the scheme's length is bounded,
// so a long run of letters is scanned once
const USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)@/gi;
const URL_IN = /[a-z][a-z0-9+.-]{0,31}:\/\//i;
// a URL's host after its ://, past any userinfo
const HOST = /^(?:[^\s/?#]*@)?([^\s/?#,;]*)/;
const MCP_REMOTE = /(^|\/)mcp-remote(@[^/\s]*)?$/;
// a URL's authority, then its path, from just past its ://; a , or ; before another URL ends it
const AFTER_SCHEME = /[^\s/?#]*((?:[^\s?#"<>\\,;]|[,;](?![a-z][a-z0-9+.-]{0,31}:\/\/))*)/iy;
// Codex's and OpenCode 2's client_secret, OpenCode 1's clientSecret
const OAUTH_SECRETS = ['client_secret', 'clientSecret'];
// what Claude sets for a plugin's own servers
const PLUGIN_VARS = /^CLAUDE_PLUGIN_(ROOT|DATA|OPTION_\w+)$/;
const RUNTIME: Record<string, string[]> = {
  npx: ['node', 'npx'], node: ['node'], bunx: ['bun'], bun: ['bun'], uvx: ['uvx'], uv: ['uv'], docker: ['docker'], python3: ['python3'], python: ['python3'],
};
const MARKETPLACE_URL = 'extraKnownMarketplaces.*.source.url';
// every header a marketplace's source sends, its own or a plugin entry's
const MARKETPLACE_HEADERS = 'extraKnownMarketplaces.*.source.**.headers.*';
const PLUGIN_SETTINGS = ['permissions', 'hooks', 'model'];

type Doc = Record<string, unknown>;
export const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const docs = (v: unknown): [string, Doc][] => (isDoc(v) ? Object.entries(v).filter((e): e is [string, Doc] => isDoc(e[1])) : []);
const texts = (v: unknown): Record<string, string> => (isDoc(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {});
export const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The variable names the mirror recorded as needed on this machine; none when the file is absent or unreadable. */
export function readMirrorVars(file: string): string[] {
  try {
    const names: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string' && VAR_NAME.test(n)) : [];
  } catch { return []; }
}

/** JSON with `//` and `/* *\/` comments and trailing commas outside its strings, as OpenCode reads its config. */
export function parseJsonc(source: string): unknown {
  const bare = source.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s: string | undefined) => s ?? '');
  return JSON.parse(bare.replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (_, s: string | undefined) => s ?? ''));
}

// a config file's object, or undefined for none; a file there that cannot be read, or holds no object, is named in `unreadable`
function readDoc(file: string, parse: (source: string) => unknown, unreadable: string[]): Doc | undefined {
  let source: string;
  try { source = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(file);
    return undefined;
  }
  let doc: unknown;
  try { doc = parse(source); } catch { /* named below */ }
  if (isDoc(doc)) return doc;
  unreadable.push(file);
  return undefined;
}

type Entry = { name: string; raw: Doc; file: string; place: string[] };
const entries = (file: string, place: string[], v: unknown): Entry[] => docs(v).map(([name, raw]) => ({ name, raw, file, place: [...place, name] }));

function argsAt(agent: AgentKind, raw: Doc): [key: string, from: number] {
  const key = FIELD_PATHS[agent].args;
  return key !== 'command' ? [key, 0] : Array.isArray(raw.command) ? ['command', 1] : ['args', 0];
}

// a shell, then -c or --command among the args after it
const runsScript = (argv: string[]): boolean =>
  argv.some((a, i) => SHELLS.includes(path.posix.basename(a)) && argv.slice(i + 1).some((f) => /^(-[a-z]*c[a-z]*|--command)$/i.test(f)));

function toServer(agent: AgentKind, scope: Scope, { name, raw, file, place }: Entry): McpServer {
  const p = FIELD_PATHS[agent];
  const [key, from] = argsAt(agent, raw);
  const argv = Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(String) : [];
  const command = key === 'command' ? argv[0] : text(raw.command);
  const cwd = text(raw.cwd);
  const url = text(raw.url);
  return {
    agent, name, scope, args: argv.slice(from), env: texts(raw[p.env]), headers: texts(raw[p.headers]), raw, file, place,
    known: Object.keys(raw).every((k) => AGENT_FIELDS[agent].includes(k)) && !runsScript([command ?? '', ...argv.slice(from)]),
    ...(command !== undefined && { command }), ...(cwd !== undefined && { cwd }), ...(url !== undefined && { url }),
  };
}

// the server entries of a plugin's server file, wrapped in mcpServers or flat; one whose servers have another shape is
// named in `unreadable`
function fileEntries(file: string, unreadable: string[]): Entry[] {
  const doc = readDoc(file, JSON.parse, unreadable);
  if (!doc) return [];
  if (!Object.hasOwn(doc, 'mcpServers')) return entries(file, [], doc);
  if (isDoc(doc.mcpServers)) return entries(file, ['mcpServers'], doc.mcpServers);
  unreadable.push(file);
  return [];
}

// whether `file` lies under `dir` once links are followed; a file that is not there does not
function within(dir: string, file: string): boolean {
  try { return holds(fs.realpathSync(dir), fs.realpathSync(file)); } catch { return false; }
}

// a plugin's server entries: .mcp.json's, then plugin.json's mcpServers, inline or in a file under the plugin it names,
// then each file under it its marketplace entry names; a file named outside it, or not there, is named in `unreadable`
function pluginServers(installPath: string, unreadable: string[], marketNamed: string[] = []): Entry[] {
  const manifest = path.join(installPath, '.claude-plugin/plugin.json');
  const named = readDoc(manifest, JSON.parse, unreadable)?.mcpServers;
  const file = typeof named === 'string' ? path.resolve(installPath, named) : undefined;
  const inside = file !== undefined && within(installPath, file);
  if (named !== undefined && !isDoc(named) && !inside) unreadable.push(manifest);
  const market = marketNamed.map((n) => path.resolve(installPath, n)).filter((f) => {
    if (!within(installPath, f)) unreadable.push(f);
    return within(installPath, f);
  });
  return [
    ...fileEntries(path.join(installPath, '.mcp.json'), unreadable), ...entries(manifest, ['mcpServers'], named), ...(inside ? fileEntries(file, unreadable) : []),
    ...market.flatMap((f) => fileEntries(f, unreadable)),
  ];
}

export const pluginServersAt = (plugin: string, file: string, place: string[], v: unknown): McpServer[] =>
  entries(file, place, v).map((e) => toServer('claude', { plugin }, e));

/** The Claude servers of plugin `plugin` in its server file `file`; a file it cannot read is named in `unreadable`. */
export const fileServers = (plugin: string, file: string, unreadable: string[]): McpServer[] =>
  fileEntries(file, unreadable).map((e) => toServer('claude', { plugin }, e));

/** The servers of the plugin installed at `p`, each from its file; a file it cannot read is named in `unreadable`. */
export const readPluginServers = (p: PluginInstall, unreadable: string[]): McpServer[] =>
  pluginServers(p.installPath, unreadable, p.named).map((e) => toServer('claude', { plugin: p.name }, e));

/**
 * Every agent's MCP servers, a plugin's once per name from its first install; OpenCode's both under mcp.servers (OpenCode 2)
 * and flat in mcp (OpenCode 1), which OpenCode 2 still reads.
 */
export function readServers(homes: MirrorHomes, plugins: PluginInstall[]): { servers: McpServer[]; unreadable: string[] } {
  const servers: McpServer[] = [];
  const unreadable: string[] = [];
  const claude = readDoc(homes.claudeJson, JSON.parse, unreadable);
  for (const e of entries(homes.claudeJson, ['mcpServers'], claude?.mcpServers)) servers.push(toServer('claude', 'user', e));
  for (const [dir, project] of docs(claude?.projects)) {
    for (const e of entries(homes.claudeJson, ['projects', dir, 'mcpServers'], project.mcpServers)) servers.push(toServer('claude', { project: dir }, e));
  }
  const seen = new Set<string>();
  for (const p of plugins) {
    for (const s of readPluginServers(p, unreadable)) {
      if (seen.has(JSON.stringify([p.name, s.name]))) continue;
      seen.add(JSON.stringify([p.name, s.name]));
      servers.push(s);
    }
  }
  const toml = path.join(homes.codexDir, 'config.toml');
  for (const e of entries(toml, ['mcp_servers'], readDoc(toml, parseToml, unreadable)?.mcp_servers)) servers.push(toServer('codex', 'user', e));
  for (const file of ['opencode.json', 'opencode.jsonc'].map((f) => path.join(homes.opencodeDir, f))) {
    const mcp = readDoc(file, parseJsonc, unreadable)?.mcp;
    const flat = entries(file, ['mcp'], mcp).filter((e) => e.name !== 'servers' && e.name !== 'timeout');
    for (const e of [...entries(file, ['mcp', 'servers'], isDoc(mcp) ? mcp.servers : undefined), ...flat]) servers.push(toServer('opencode', 'user', e));
  }
  return { servers, unreadable };
}

/**
 * Claude's installed plugins, each one's user-scope install first and then its others as listed; a list that cannot be read,
 * or names its installs in another shape, is named in `unreadable`.
 */
export function readPlugins(claudeDir: string, unreadable: string[]): PluginInstall[] {
  const file = path.join(claudeDir, 'plugins/installed_plugins.json');
  const plugins = readDoc(file, JSON.parse, unreadable)?.plugins;
  if (plugins === undefined) return [];
  const shaped = isDoc(plugins) && Object.values(plugins).every((l) => Array.isArray(l) && l.every((i) => isDoc(i) && typeof i.installPath === 'string'));
  if (!shaped) {
    unreadable.push(file);
    return [];
  }
  const { named, namedLsp, namedAgents, broken, known, list } = marketNamed(claudeDir);
  return Object.entries(plugins as Record<string, Doc[]>).flatMap(([name, all]) => {
    const paths = [...all.filter((i) => i.scope === 'user'), ...all.filter((i) => i.scope !== 'user')].map((i) => i.installPath as string);
    // an install is named `<plugin>@<marketplace>`
    const of = (m: Map<string, string[]>) => m.get(name) ?? [...m].find(([k]) => !name.includes('@') && k.startsWith(`${name}@`))?.[1];
    const [files, lsp, agents] = [of(named), of(namedLsp), of(namedAgents)];
    const from = name.includes('@') ? name.slice(name.indexOf('@') + 1) : undefined;
    const market = from === undefined ? undefined : broken.get(from) ?? (list && !known.has(from) ? list : undefined);
    if (market) unreadable.push(market);
    return [...new Set(paths)].map((installPath) => ({
      name, installPath, ...(files && { named: files }), ...(lsp && { namedLsp: lsp }), ...(agents && { namedAgents: agents }), ...(market && { unreadMarket: market }),
    }));
  });
}

export const namedPaths = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((n): n is string => typeof n === 'string');

// the paths each marketplace's plugin entries name, as `strict: false` entries do, by `<plugin>@<marketplace>`; a marketplace
// lies under plugins/marketplaces, or where known_marketplaces.json puts one added from a local folder
function marketNamed(claudeDir: string): {
  named: Map<string, string[]>; namedLsp: Map<string, string[]>; namedAgents: Map<string, string[]>; broken: Map<string, string>; known: Set<string>;
  list?: string;
} {
  const named = new Map<string, string[]>();
  const namedLsp = new Map<string, string[]>();
  const namedAgents = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, paths: string[]): void => { if (paths.length) m.set(k, [...new Set([...(m.get(k) ?? []), ...paths])]); };
  const broken = new Map<string, string>();
  const known = new Set<string>();
  const dir = path.join(claudeDir, 'plugins/marketplaces');
  const roots: [string, string][] = [];
  try { for (const m of fs.readdirSync(dir)) roots.push([m, path.join(dir, m)]); } catch { /* none cloned */ }
  const listFile = path.join(claudeDir, 'plugins/known_marketplaces.json');
  const unreadList: string[] = [];
  for (const [m, v] of Object.entries(readDoc(listFile, JSON.parse, unreadList) ?? {})) {
    if (isDoc(v) && typeof v.installLocation === 'string') roots.push([m, v.installLocation]);
  }
  for (const [m, root] of roots) {
    const file = path.join(root, '.claude-plugin/marketplace.json');
    known.add(m);
    const unread: string[] = [];
    // a folder that is not there, or a list that leads outside it, cannot be read
    const inside = within(root, root) && (!fs.existsSync(file) || within(root, file));
    const doc = inside ? readDoc(file, JSON.parse, unread) : undefined;
    if (!inside || unread.length) broken.set(m, file);
    const list: unknown = doc?.plugins;
    for (const e of Array.isArray(list) ? list : []) {
      if (!isDoc(e) || typeof e.name !== 'string' || ![e.mcpServers, e.lspServers, e.agents].some((v) => namedPaths(v).length)) continue;
      for (const market of new Set([m, typeof doc?.name === 'string' ? doc.name : m])) {
        known.add(market);
        add(named, `${e.name}@${market}`, namedPaths(e.mcpServers));
        add(namedLsp, `${e.name}@${market}`, namedPaths(e.lspServers));
        add(namedAgents, `${e.name}@${market}`, namedPaths(e.agents));
      }
    }
  }
  return { named, namedLsp, namedAgents, broken, known, ...(unreadList.length && { list: listFile }) };
}

/** Whether `v` holds only references, after any auth scheme; a reference's default is a value, so only an empty one is. */
export const isReferenceOnly = (v: string): boolean => v.replace(BARE_REF, '').replace(/^(Bearer|Token|Basic)\s*$/i, '').trim() === '';

const defaultless = (v: string): string => v.replace(VAR_REF, (all, name: string | undefined) => (name === undefined ? all : `\${${name}}`));

/** Secret `v` without its references' defaults, where only references are left; else undefined. */
const asReference = (v: string): string | undefined => (isReferenceOnly(defaultless(v)) ? defaultless(v) : undefined);

// a URL's userinfo when its password, or the lone user of an http(s) URL, is not only references
function credential(scheme: string, userinfo: string): string | undefined {
  const colon = userinfo.indexOf(':');
  if (colon >= 0) return isReferenceOnly(userinfo.slice(colon + 1)) ? undefined : userinfo;
  return /https?:\/\/$/i.test(scheme) && !isReferenceOnly(userinfo) ? userinfo : undefined;
}
// a string without :// is not scanned by URL_IN
const hasUrl = (source: string): boolean => source.includes('://') && URL_IN.test(source);
const credentials = (source: string): string[] =>
  (hasUrl(source) ? [...source.matchAll(USERINFO)] : []).flatMap((m) => [credential(m[1], m[2])].filter((c): c is string => c !== undefined));
/** `source` without the credential of each URL in it; one that holds only references once their defaults go keeps them. */
export const withoutCredentials = (source: string): string => (!hasUrl(source) ? source : source.replace(USERINFO, (all, scheme: string, userinfo: string) => {
  if (credential(scheme, userinfo) === undefined) return all;
  return credential(scheme, defaultless(userinfo)) === undefined ? `${scheme}${defaultless(userinfo)}@` : scheme;
}));

// where a URL in an arg ends: a space, a double quote, a bracket or a backslash, or a , or ; before another URL
const URL_END = /([\s"<>\\]|[,;](?=[a-z][a-z0-9+.-]{0,31}:\/\/))/i;

// `source` as its URLs at even places and what lies between them at odd ones; a URL field is one URL whole
const urlParts = (source: string, arg: boolean): string[] => (arg ? source.split(URL_END) : [source]);

// where each URL piece's query lies: after its ?, or after the first & of a piece a space or a , ; split from a query; a quote,
// bracket or backslash ends a query
function queryRanges(pieces: string[]): ([from: number, to: number] | undefined)[] {
  let open = false;
  return pieces.map((p, i) => {
    if (i % 2) {
      if (/["<>\\]/.test(p)) open = false;
      return undefined;
    }
    const end = p.includes('#') ? p.indexOf('#') : p.length;
    const q = p.slice(0, end).indexOf('?');
    const amp = p.slice(0, end).indexOf('&');
    const from = q >= 0 ? q + 1 : open ? (amp >= 0 ? amp + 1 : end) : -1;
    open = from >= 0 && end === p.length;
    return from >= 0 ? [from, end] : undefined;
  });
}

// each URL's query params in `source`
function params(source: string, arg: boolean): { name: string; value: string }[] {
  const pieces = urlParts(source, arg);
  return queryRanges(pieces).flatMap((r, i) => (r ? pieces[i].slice(...r).split('&') : []))
    .flatMap((kv) => (kv.indexOf('=') > 0 ? [{ name: kv.slice(0, kv.indexOf('=')), value: kv.slice(kv.indexOf('=') + 1) }] : []));
}

// a value shaped as a token: 20 or more URL-safe characters, among them a run of 8 or more letters and digits mixing both, a
// %XX escape apart
const tokenShaped = (v: string): boolean =>
  v.length >= 20 && /^[\w.~+=:%-]+$/.test(v) && v.split(/%[0-9a-f]{2}|[^a-z0-9]/i).some((p) => p.length >= 8 && /\d/.test(p) && /[A-Za-z]/.test(p));

// a query value is a key when its name says so, Azure Functions' code and Zoom's pwd among them, or it is shaped as a token
const queryKey = (name: string, value: string): boolean => keyName(name) || name === 'code' || name === 'pwd' || tokenShaped(value);

function urlSecrets(source: string, field: string, arg = false): Secret[] {
  const values = params(source, arg).filter((p) => queryKey(p.name, p.value) && !isReferenceOnly(p.value)).map((p) => ({ field: `${field}.${p.name}`, value: p.value }));
  return [...values, ...credentials(source).map((value) => ({ field: `${field}.userinfo`, value }))];
}

// where each path segment shaped as a token lies in the URLs in `source`; each URL is read once, a URL inside another's path with it
function pathKeys(source: string): [from: number, to: number][] {
  const spans: [number, number][] = [];
  for (let i = source.indexOf('://'); i >= 0; i = source.indexOf('://', Math.max(i + 1, AFTER_SCHEME.lastIndex))) {
    AFTER_SCHEME.lastIndex = i + 3;
    const p = AFTER_SCHEME.exec(source)?.[1] ?? '';
    let pos = AFTER_SCHEME.lastIndex - p.length;
    for (const segment of p.split('/')) {
      if (tokenShaped(segment)) spans.push([pos, pos + segment.length]);
      pos += segment.length + 1;
    }
  }
  return spans;
}

const pathSecrets = (source: string, field: string): Secret[] => pathKeys(source).map(([from, to]) => ({ field: `${field}.path`, value: source.slice(from, to) }));

const withoutPathKeys = (source: string): string => pathKeys(source).reduceRight((s, [from, to]) => `${s.slice(0, from)}${s.slice(to)}`, source);

// `source`, the value of `field`, with the credentials, path keys and query keys `drop` names emptied
function urlWithout(source: string, field: string, drop: ReadonlySet<string>, arg = false): string {
  const bare = drop.has(`${field}.path`) ? withoutPathKeys(source) : source;
  const u = drop.has(`${field}.userinfo`) ? withoutCredentials(bare) : bare;
  const pieces = urlParts(u, arg);
  const ranges = queryRanges(pieces);
  return pieces.map((p, i) => {
    const r = ranges[i];
    if (!r) return p;
    const query = p.slice(...r).split('&').map((kv) => {
      const eq = kv.indexOf('=');
      const [name, value] = [kv.slice(0, eq), kv.slice(eq + 1)];
      return eq > 0 && drop.has(`${field}.${name}`) && queryKey(name, value) ? `${name}=${asReference(value) ?? ''}` : kv;
    });
    return `${p.slice(0, r[0])}${query.join('&')}${p.slice(r[1])}`;
  }).join('');
}

// a flag whose last word, in kebab-, snake-, dotted or camelCase, names a secret
const secretFlag = (flag: string): boolean => SECRET_FLAG.test(flag.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_.]/g, '-'));

// a name that says its value is a key
const keyName = (name: string): boolean => secretFlag(name) || PROVIDER_KEY.test(name);

// a leaf's own name, or its list's where it lies in one
const lastName = (place: string[]): string => [...place].reverse().find((k) => !/^\d+$/.test(k)) ?? '';

// an arg that is a flag rather than a value: --name, -x or --; a key may start with a dash
const isFlag = (a: string): boolean => /^(--([A-Za-z]|$)|-[A-Za-z]$)/.test(a);

// arg `i` as the value of the flag before it that names a key, or -k
const flagValue = (args: string[], i: number): boolean => {
  const before = args[i - 1] ?? '';
  return !isFlag(args[i]) && (before === '-k' || secretFlag(/^--?([^=]+)$/.exec(before)?.[1] ?? ''));
};

// arg `i` as a header's value, its name the arg before it: after --headers any name, after -H, which is also a host flag,
// Authorization, an X- name or one that names a key
const headerPair = (args: string[], i: number): boolean => !isFlag(args[i]) && /^\w[\w-]*$/.test(args[i - 1] ?? '')
  && (args[i - 2] === '--headers' || (args[i - 2] === '-H' && (/^(x-|authorization$)/i.test(args[i - 1]) || keyName(args[i - 1]))));

// where each credential after an auth scheme in `v` lies: 8 or more characters holding a digit, or 20 or more
const schemeKeys = (v: string): { from: number; to: number }[] => [...v.matchAll(SCHEME_KEY)]
  .filter((m) => m[1].length >= 20 || (m[1].length >= 8 && /\d/.test(m[1])))
  .map((m) => ({ from: m.index + m[0].length - m[1].length, to: m.index + m[0].length }));

// the JSON object or list an arg holds after any --flag=, as its text
function jsonArg(a: string): { keep: string; text: string } | undefined {
  const keep = /^--?[^=]+=/.exec(a)?.[0] ?? '';
  const text = a.slice(keep.length);
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    const doc: unknown = JSON.parse(text);
    return typeof doc === 'object' && doc !== null ? { keep, text } : undefined;
  } catch { return undefined; }
}

type JsonString = { path: string[]; value: string; from: number; to: number };

// each string in the JSON text `t` with its path and where it lies; a key given twice lies in both places
function jsonStrings(t: string): JsonString[] {
  const found: JsonString[] = [];
  let i = 0;
  const skip = (): void => { while (i < t.length && ' \t\n\r'.includes(t[i])) i++; };
  const string = (): string => {
    const from = i;
    for (i++; t[i] !== '"'; i++) if (t[i] === '\\') i++;
    i++;
    return JSON.parse(t.slice(from, i)) as string;
  };
  const value = (path: string[]): void => {
    skip();
    if (t[i] === '"') {
      const from = i;
      found.push({ path, value: string(), from, to: i });
    } else if (t[i] === '{' || t[i] === '[') {
      const list = t[i] === '[';
      for (let n = 0; ; n++) {
        i++;
        skip();
        if (t[i] === '}' || t[i] === ']') break;
        const key = list ? String(n) : string();
        if (!list) {
          skip();
          i++;
        }
        value([...path, key]);
        skip();
        if (t[i] !== ',') break;
      }
      i++;
    } else while (i < t.length && !',]} \t\n\r'.includes(t[i])) i++;
  };
  value([]);
  return found;
}

// a JSON arg's strings that are keys, named as one or carrying an auth scheme's credential, each where it lies; none read
// from one nested too deep to walk
function jsonKeyStrings(a: string): { keep: string; text: string; keys: JsonString[] } | undefined {
  const json = jsonArg(a);
  if (!json) return undefined;
  let strings: JsonString[] = [];
  try { strings = jsonStrings(json.text); } catch { /* too deep */ }
  return { ...json, keys: strings.filter((j) => (keyName(lastName(j.path)) || schemeKeys(j.value).length > 0) && !isReferenceOnly(j.value)) };
}

const jsonKeys = (a: string): Secret[] => (jsonKeyStrings(a)?.keys ?? []).map((j) => ({ field: `.${j.path.join('.')}`, value: j.value }));

// arg `a`, the value of `field`, with each key of its JSON that `drop` names emptied in place, the rest of its text as it is
function jsonWithout(a: string, field: string, drop: ReadonlySet<string>): string {
  const json = jsonKeyStrings(a);
  const cut = json?.keys.filter((j) => drop.has(`${field}.${j.path.join('.')}`)) ?? [];
  if (!json || !cut.length) return a;
  return `${json.keep}${cut.sort((x, y) => y.from - x.from).reduce((t, j) => `${t.slice(0, j.from)}${JSON.stringify(asReference(j.value) ?? '')}${t.slice(j.to)}`, json.text)}`;
}

// a header `Name: value` after `keep`, as the part that stays and its value
const header = (keep: string, h: string): [keep: string, value: string] => [`${keep}${h.slice(0, h.indexOf(':') + 1)}`, h.slice(h.indexOf(':') + 1).trim()];

const headerName = (h: string): string => h.slice(0, h.indexOf(':')).trim();

// what names arg `i` whatever its value: a secret or header flag before it, its own --flag= or --header=, a KEY=, the flag of
// a JSON object or an auth scheme, or a URL's origin
function argName(args: string[], i: number): string | undefined {
  const a = args[i];
  const before = args[i - 1] ?? '';
  if (flagValue(args, i)) return before;
  if (HEADER_FLAG.test(before) && a.includes(':')) return `${before} ${headerName(a)}`;
  if (headerPair(args, i)) return `${args[i - 2]} ${before}`;
  const assigned = /^--?([^=]+)=/.exec(a);
  const own = assigned?.[0].slice(0, -1);
  const rest = a.slice(assigned?.[0].length ?? 0);
  if (assigned && secretFlag(assigned[1])) return own;
  if (own !== undefined && HEADER_FLAG.test(own) && rest.includes(':')) return `${own} ${headerName(rest)}`;
  const key = ENV_KEY.exec(rest)?.[1];
  if (key !== undefined) return key;
  // a scheme stays when its credential is emptied, so the arg keeps its name
  const flag = own ?? (/^--?[^=]+$/.test(before) ? before : undefined);
  if (flag !== undefined && (jsonArg(a) || SCHEME.test(rest))) return flag;
  return originOf(a);
}

// looks back from each :// for a scheme, so a long run of letters is not scanned for one
function originOf(a: string): string | undefined {
  for (let i = a.indexOf('://'); i >= 0; i = a.indexOf('://', i + 1)) {
    const scheme = /[a-z][a-z0-9+.-]{0,31}$/i.exec(a.slice(Math.max(0, i - 32), i))?.[0];
    if (scheme) return `${scheme}://${HOST.exec(a.slice(i + 3))?.[1] ?? ''}`;
  }
  return undefined;
}

// each arg's field: `args[<what names it>]`, which every arg of that name shares, or `args[<i>]` where nothing names it
const argFields = (args: string[]): string[] => args.map((_, i) => `args[${argName(args, i) ?? i}]`);

const argIndices = (args: string[], field: string): number[] => argFields(args).flatMap((f, i) => (field === f || field.startsWith(`${f}.`) ? [i] : []));

// arg `i` as the part that stays and the value a secret there would be; undefined where none could be, a JSON arg's
// strings and an auth scheme's credentials read one by one
function argValue(args: string[], i: number): [keep: string, value: string] | undefined {
  const a = args[i];
  if (flagValue(args, i)) return ['', a];
  if (HEADER_FLAG.test(args[i - 1] ?? '') && a.includes(':')) return header('', a);
  if (headerPair(args, i)) return ['', a];
  const assigned = /^--?([^=]+)=/.exec(a);
  const keep = assigned?.[0] ?? '';
  const rest = a.slice(keep.length);
  if (assigned && secretFlag(assigned[1])) return [keep, rest];
  if (HEADER_FLAG.test(keep.slice(0, -1)) && rest.includes(':')) return header(keep, rest);
  const key = ENV_KEY.exec(rest)?.[1];
  if (key !== undefined && rest.length > key.length + 1 && (UPPER_KEY.test(key) || secretFlag(key))) return [`${keep}${key}=`, rest.slice(key.length + 1)];
  return undefined;
}

// each auth scheme's credential in arg `a` that is not only references
const argSchemeKeys = (a: string): { from: number; to: number }[] => (jsonArg(a) ? [] : schemeKeys(a).filter(({ from, to }) => !isReferenceOnly(a.slice(from, to))));

// an arg's value whole, or else its auth schemes' credentials, the keys in its JSON and each URL's query, credentials and path
// keys in it; the args are named only once one holds a secret
function argsSecrets(args: string[]): Secret[] {
  const found = args.flatMap((a, i) => {
    const kv = argValue(args, i);
    if (kv && !isReferenceOnly(kv[1])) return [{ i, part: '', value: kv[1] }];
    const schemes = argSchemeKeys(a).map(({ from, to }) => ({ field: '', value: a.slice(from, to) }));
    const urls = hasUrl(a) ? [...urlSecrets(a, '', true), ...pathSecrets(a, '')] : [];
    return [...schemes, ...jsonKeys(a), ...urls].map((u) => ({ i, part: u.field, value: u.value }));
  });
  const fields = found.length ? argFields(args) : [];
  return found.map(({ i, part, value }) => ({ field: `${fields[i]}${part}`, value }));
}

function argWithout(args: string[], i: number, field: string, drop: ReadonlySet<string>): string {
  const kv = argValue(args, i);
  if (kv && !isReferenceOnly(kv[1]) && drop.has(field)) return `${kv[0]}${asReference(kv[1]) ?? ''}`;
  const a = args[i];
  const bare = drop.has(field) ? argSchemeKeys(a).reduceRight((t, { from, to }) => `${t.slice(0, from)}${asReference(t.slice(from, to)) ?? ''}${t.slice(to)}`, a) : a;
  return urlWithout(jsonWithout(bare, field, drop), field, drop, true);
}

/** The values in `s` that are secrets, each by its field; a value that is only references is none. */
export function secretsOf(s: McpServer): Secret[] {
  const fields = (kind: 'env' | 'headers'): Secret[] => Object.entries(s[kind]).filter(([, v]) => !isReferenceOnly(v)).map(([k, v]) => ({ field: `${kind}.${k}`, value: v }));
  const url = s.url === undefined ? [] : [...urlSecrets(s.url, 'url'), ...pathSecrets(s.url, 'url')];
  const args = argsSecrets(s.args);
  const oauth = Object.entries(texts(s.raw.oauth)).filter(([k, v]) => OAUTH_SECRETS.includes(k) && !isReferenceOnly(v)).map(([k, v]) => ({ field: `oauth.${k}`, value: v }));
  return [...fields('env'), ...fields('headers'), ...url, ...args, ...oauth];
}

/** The variables the worker's daemon must hold for `s`: its references, empty env values and Codex's env-named fields. */
export function needsOf(s: McpServer): string[] {
  const named = [...Object.values(s.env), ...Object.values(s.headers), s.url ?? '', ...s.args, ...Object.values(texts(s.raw.oauth))]
    .flatMap((v) => [...v.matchAll(VAR_REF)].map((m) => m[1] ?? m[2]));
  const empty = Object.keys(s.env).filter((k) => s.env[k] === '');
  const envVars = Array.isArray(s.raw.env_vars) ? s.raw.env_vars.map((e) => (isDoc(e) ? e.name : e)) : [];
  const codex = s.agent === 'codex' ? [s.raw.bearer_token_env_var, ...envVars, ...Object.values(texts(s.raw.env_http_headers))] : [];
  const plugin = typeof s.scope === 'object' && 'plugin' in s.scope;
  return [...new Set([...named, ...empty, ...codex])].filter((n): n is string => typeof n === 'string' && VAR_NAME.test(n) && !(plugin && PLUGIN_VARS.test(n))).sort();
}

const hostOf = (url: string | undefined): string => {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
};

/** Whether `s` logs in by OAuth: mcp-remote, --oauth, an oauth entry or a known host, unless it sends a header. */
export function isOAuth(s: McpServer): boolean {
  const byHeader = Object.keys(s.headers).length > 0 || s.args.some((a) => HEADER_FLAG.test(a)) || s.raw.bearer_token_env_var !== undefined
    || Object.keys(texts(s.raw.env_http_headers)).length > 0;
  if (byHeader) return false;
  return [s.command ?? '', ...s.args].some((a) => MCP_REMOTE.test(a)) || s.args.some((a) => /^--oauth(=|$)/.test(a)) || Boolean(s.raw.oauth)
    || KNOWN_OAUTH_HOSTS.includes(hostOf(s.url));
}

// programs only a Mac has: Xcode's, and the ones that script macOS
const MAC_ONLY_COMMANDS = ['xcrun', 'xcodebuild', 'osascript', 'swift'];
/** Whether `s` runs only on this Mac: a loopback url, the Chrome extension, Chrome's devtools, an app bundle or a Mac's own program. */
export const isMacOnly = (s: McpServer): boolean =>
  /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(s.url ?? '') || [s.command ?? '', ...s.args].some((a) => /claude-in-chrome|chrome-devtools|\/Applications\//.test(a))
  || MAC_ONLY_COMMANDS.includes(path.posix.basename(s.command ?? ''));

export function runtimesOf(s: McpServer): string[] {
  if (!s.command) return [];
  if (path.posix.isAbsolute(s.command)) return [s.command];
  const base = path.posix.basename(s.command);
  return Object.hasOwn(RUNTIME, base) ? RUNTIME[base] : [base];
}

// Claude Code's MCP sign-in waits on a random port unless MCP_OAUTH_CALLBACK_PORT names one; this is its own fallback
const CLAUDE_OAUTH_PORT = 3118;

/** The command that logs `s` in on the worker, and the port its callback listens on there when Svall knows it. */
export function oauthLogin(s: McpServer): { run: string; forward?: number } {
  const argv = [s.command ?? '', ...s.args];
  const remote = argv.findIndex((a) => MCP_REMOTE.test(a));
  const url = remote < 0 ? -1 : argv.findIndex((a, i) => i > remote && /^https?:\/\//.test(a));
  const port = url < 0 ? undefined : argv[url + 1];
  const name = /^[\w.-]+$/.test(s.name) ? s.name : shq(s.name);
  // a server's own callbackPort wins over the variable in Claude Code
  const own = s.agent === 'claude' && isDoc(s.raw.oauth) && Number.isInteger(s.raw.oauth.callbackPort) ? s.raw.oauth.callbackPort as number : undefined;
  // mcp-remote logs in once the agent starts it; Codex's and OpenCode's own logins take remote servers only
  const run = remote >= 0 ? s.agent : s.agent === 'codex' ? `codex mcp login ${name}` : s.agent === 'opencode' ? `opencode mcp auth ${name}`
    : own !== undefined ? 'claude' : `MCP_OAUTH_CALLBACK_PORT=${CLAUDE_OAUTH_PORT} claude`;
  const forward = remote >= 0 ? (port !== undefined && /^\d+$/.test(port) ? Number(port) : undefined)
    : s.agent === 'claude' ? own ?? CLAUDE_OAUTH_PORT : undefined;
  return { run, ...(forward !== undefined && { forward }) };
}

/**
 * `s.raw` with each secret not in `keep` emptied but for its references; an emptied or empty env value names the worker's
 * own variable instead: Claude `${KEY}`, OpenCode `{env:KEY}`, Codex `env_vars`.
 */
export function redacted(s: McpServer, keep: ReadonlySet<string>): Record<string, unknown> {
  const drop = new Set(secretsOf(s).map((f) => f.field).filter((f) => !keep.has(f)));
  const p = FIELD_PATHS[s.agent];
  const raw = structuredClone(s.raw);
  const ref = (k: string): string | undefined => (drop.has(`env.${k}`) ? asReference(s.env[k]) : undefined);
  const unset = Object.keys(s.env).filter((k) => (drop.has(`env.${k}`) && ref(k) === undefined) || s.env[k] === '');
  const env = raw[p.env] as Doc;
  for (const k of Object.keys(s.env)) if (ref(k) !== undefined) env[k] = ref(k);
  if (s.agent === 'codex' && unset.length) {
    for (const k of unset) delete env[k];
    const names = Array.isArray(raw.env_vars) ? raw.env_vars : [];
    raw.env_vars = [...names, ...unset.filter((k) => !names.some((n) => n === k || (isDoc(n) && n.name === k)))];
  } else for (const k of unset) env[k] = s.agent === 'claude' ? `\${${k}}` : `{env:${k}}`;
  for (const h of Object.keys(s.headers)) if (drop.has(`headers.${h}`)) (raw[p.headers] as Doc)[h] = asReference(s.headers[h]) ?? '';
  if (s.url !== undefined) raw.url = urlWithout(s.url, 'url', drop);
  const [key, from] = argsAt(s.agent, raw);
  const fields = [...drop].some((f) => f.startsWith('args[')) ? argFields(s.args) : [];
  fields.forEach((field, i) => {
    const emptied = argWithout(s.args, i, field, drop);
    if (emptied !== s.args[i]) (raw[key] as unknown[])[i + from] = emptied;
  });
  const oauth = raw.oauth;
  if (isDoc(oauth)) for (const k of OAUTH_SECRETS) if (drop.has(`oauth.${k}`)) oauth[k] = asReference(String(oauth[k])) ?? '';
  return raw;
}

/** Where secret field `field` lies in entry `raw`: for an arg, each arg of its name, none when it is gone. */
export function fieldPlace(agent: AgentKind, raw: Record<string, unknown>, field: string): Place[] {
  if (field.startsWith('args[')) {
    const [key, from] = argsAt(agent, raw);
    return argIndices((Array.isArray(raw[key]) ? raw[key] as unknown[] : []).slice(from).map(String), field).map((i) => [key, i + from]);
  }
  const dot = field.indexOf('.');
  const head = field.slice(0, dot);
  if (head === 'url') return [['url']];
  return [[head === 'env' ? FIELD_PATHS[agent].env : head === 'headers' ? FIELD_PATHS[agent].headers : head, field.slice(dot + 1)]];
}

/** A server entry with the absolute paths in its command, args and cwd moved by `move`. */
export function relocatedServer(entry: Record<string, unknown>, move: (p: string) => string): Record<string, unknown> {
  const moved = { ...entry };
  for (const k of ['command', 'args', 'cwd']) if (Object.hasOwn(entry, k)) moved[k] = relocated(entry[k], move, true);
  return moved;
}

type Leaf = { field: string; place: string[]; value: unknown };
// the values at `pattern`'s dotted path in `doc`, `*` any one key and `**` any number of them, each by its concrete path
function at(doc: unknown, pattern: string[], field: string[] = []): Leaf[] {
  if (!pattern.length) return [{ field: field.join('.'), place: field, value: doc }];
  const [head, ...rest] = pattern;
  const kids = typeof doc === 'object' && doc !== null ? Object.entries(doc) : [];
  if (head === '**') return [...at(doc, rest, field), ...kids.flatMap(([k, v]) => at(v, pattern, [...field, k]))];
  return kids.filter(([k]) => head === '*' || k === head).flatMap(([k, v]) => at(v, rest, [...field, k]));
}
const strings = (leaves: Leaf[]): (Leaf & Secret)[] => leaves.filter((l): l is Leaf & Secret => typeof l.value === 'string');
const SECRET_PATHS: Record<AgentKind, readonly string[]> = { claude: [MARKETPLACE_HEADERS], codex: CODEX_SECRET_PATHS, opencode: OPENCODE_SECRET_PATHS };

// OpenCode's options, settings and request bodies: each string named as a key or carrying an auth scheme's credential, and
// the query keys of each URL in one
function providerSecrets(doc: Record<string, unknown>): Secret[] {
  const options = OPENCODE_OPTIONS.flatMap((p) => strings(at(doc, p.split('.'))));
  const named = options.filter((l) => keyName(lastName(l.place)) || schemeKeys(l.value).length > 0);
  const queries = options.filter((l) => hasUrl(l.value)).flatMap((l) => urlSecrets(l.value, l.field).filter((s) => !s.field.endsWith('.userinfo')));
  return [...named, ...queries];
}

// Codex's query params, base_url and otel endpoint query values, and its args lists read as a server's args under each list's path
function codexSecrets(doc: Record<string, unknown>): Secret[] {
  const named = strings(at(doc, CODEX_QUERY.split('.'))).filter((l) => queryKey(lastName(l.place), l.value));
  const queries = CODEX_URLS.flatMap((p) => strings(at(doc, p.split('.')))).flatMap((l) => urlSecrets(l.value, l.field).filter((s) => !s.field.endsWith('.userinfo')));
  const args = argLists(doc).flatMap((l) => argsSecrets(l.args).map((s) => ({ field: `${l.field}${s.field.slice('args'.length)}`, value: s.value })));
  return [...named, ...queries, ...args];
}

const argLists = (doc: unknown): { field: string; args: string[] }[] => CODEX_ARGS.flatMap((p) => at(doc, p.split('.')))
  .filter((l) => Array.isArray(l.value) && l.value.every((a) => typeof a === 'string')).map((l) => ({ field: l.field, args: l.value as string[] }));

/**
 * The secrets in an agent's config file `doc` by their concrete path: its key fields, and the userinfo of a URL in any
 * other string; Claude's marketplace urls lose theirs on the way, so only their query values are keys.
 */
export function configSecrets(agent: AgentKind, doc: Record<string, unknown>): Secret[] {
  const market = agent === 'claude' ? strings(at(doc, MARKETPLACE_URL.split('.'))).flatMap((l) => urlSecrets(l.value, l.field).filter((s) => !s.field.endsWith('.userinfo'))) : [];
  const found = [
    ...SECRET_PATHS[agent].flatMap((p) => strings(at(doc, p.split('.')))), ...(agent === 'opencode' ? providerSecrets(doc) : agent === 'codex' ? codexSecrets(doc) : []), ...market,
  ];
  const keys = found.filter((l, i) => !isReferenceOnly(l.value) && found.findIndex((o) => o.field === l.field) === i);
  const listed = agent === 'codex' ? argLists(doc).flatMap((l) => l.args.map((_, i) => `${l.field}.${i}`)) : [];
  const skip = new Set([...keys.map((l) => l.field), ...listed, ...(agent === 'claude' ? at(doc, MARKETPLACE_URL.split('.')).map((l) => l.field) : [])]);
  const userinfos = strings(at(doc, ['**'])).filter((l) => !skip.has(l.field)).flatMap((l) => credentials(l.value).map((value) => ({ field: `${l.field}.userinfo`, value })));
  return [...keys.map(({ field, value }) => ({ field, value })), ...userinfos];
}

/** The variables an agent's config file `doc` names: OpenCode's `{env:VAR}` anywhere, Codex's env-named key fields. */
export function configNeeds(agent: AgentKind, doc: Record<string, unknown>): string[] {
  const names = agent === 'opencode' ? strings(at(doc, ['**'])).flatMap((l) => [...l.value.matchAll(VAR_REF)].map((m) => m[2]))
    : agent === 'codex' ? CODEX_NEED_PATHS.flatMap((p) => strings(at(doc, p.split('.')))).map((l) => l.value) : [];
  return [...new Set(names)].filter((n): n is string => !!n).sort();
}

export type Place = (string | number)[];

export const getAt = (doc: unknown, place: Place): unknown =>
  place.reduce<unknown>((v, k) => (typeof v === 'object' && v !== null && Object.hasOwn(v, k) ? (v as Record<string | number, unknown>)[k] : undefined), doc);

/** Makes the objects that lead to `place`; `undefined` removes what lies there, but not from an array. */
export function setAt(doc: Record<string, unknown>, place: Place, v: unknown): void {
  let at = doc as Record<string | number, unknown>;
  for (const [i, k] of place.slice(0, -1).entries()) {
    if (typeof at[k] !== 'object' || at[k] === null) {
      if (v === undefined) return;
      at[k] = typeof place[i + 1] === 'number' ? [] : {};
    }
    at = at[k] as Record<string | number, unknown>;
  }
  const last = place[place.length - 1];
  if (v !== undefined) at[last] = v;
  else if (!Array.isArray(at)) delete at[last];
}

// the keys whose dotted join is `field` and that lead to a value `leaf` takes, a string unless it says otherwise
function placeIn(v: unknown, field: string, leaf: (x: unknown) => boolean = (x) => typeof x === 'string'): string[] | undefined {
  if (field === '') return leaf(v) ? [] : undefined;
  if (typeof v !== 'object' || v === null) return undefined;
  for (const [k, x] of Object.entries(v)) {
    if (field !== k && !field.startsWith(`${k}.`)) continue;
    const rest = placeIn(x, field.slice(k.length + 1), leaf);
    if (rest) return [k, ...rest];
  }
  return undefined;
}

// a config field naming an arg, `<path of its list>[<name>]…`: the list's place, its args and the field among them
function argOf(doc: unknown, field: string): { list: string[]; args: string[]; field: string } | undefined {
  const open = field.indexOf('[');
  const list = open > 0 ? placeIn(doc, field.slice(0, open), (x) => Array.isArray(x) && x.every((a) => typeof a === 'string')) : undefined;
  return list && { list, args: getAt(doc, list) as string[], field: `args${field.slice(open)}` };
}

/** Where configSecrets' field `field` lies in `doc`: its string, each arg of its name, or the URL holding it, whose name may hold dots. */
export function configPlace(doc: unknown, field: string): string[][] {
  const arg = argOf(doc, field);
  if (arg) return argIndices(arg.args, arg.field).map((i) => [...arg.list, String(i)]);
  const parts = field.replace(/\.userinfo$/, '').split('.');
  for (let n = parts.length; n > 0; n -= 1) {
    const place = placeIn(doc, parts.slice(0, n).join('.'));
    if (place) return [place];
  }
  return [];
}

/** `doc` with each of `fields` emptied but for the references it holds. */
export function configRedacted(doc: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out = structuredClone(doc);
  for (const f of fields) {
    // `doc` names the args, so a key emptied earlier in the pass cannot rename them
    const arg = argOf(doc, f);
    if (arg) {
      const own = argFields(arg.args);
      const now = getAt(out, arg.list) as string[];
      const emptied = argIndices(arg.args, arg.field).map((i) => [i, argWithout(now, i, own[i], new Set([arg.field]))] as const);
      for (const [i, a] of emptied) setAt(out, [...arg.list, i], a);
      continue;
    }
    const [place] = configPlace(out, f);
    if (!place) continue;
    const v = getAt(out, place) as string;
    setAt(out, place, f.endsWith('.userinfo') ? withoutCredentials(v) : place.join('.') === f ? asReference(v) ?? '' : urlWithout(v, place.join('.'), new Set([f])));
  }
  return out;
}

/** Claude's settings.json env, which stays off the worker. */
export const readSettingsEnv = (claudeDir: string): Record<string, string> => texts(readDoc(path.join(claudeDir, 'settings.json'), JSON.parse, [])?.env);

/** Each plugin's settings.json that holds more than PLUGIN_SETTINGS and env references, with its top-level keys. */
export function readPluginConfigs(plugins: PluginInstall[], unreadable: string[]): { name: string; file: string; fields: string[] }[] {
  return plugins.flatMap(({ name, installPath }) => {
    const file = path.join(installPath, 'settings.json');
    if (!fs.existsSync(file)) return [];
    const doc = readDoc(file, JSON.parse, unreadable);
    if (!doc) return [];
    const plain = Object.entries(doc).every(([k, v]) =>
      PLUGIN_SETTINGS.includes(k) || (k === 'env' && isDoc(v) && Object.values(v).every((x) => typeof x === 'string' && isReferenceOnly(x))));
    return plain ? [] : [{ name, file, fields: Object.keys(doc) }];
  });
}

/**
 * Claude's known_marketplaces.json with its sources' headers and url query values emptied but those `keep` holds by their
 * settings.json field; `kept` whether one of those stays.
 */
export function marketplaceList(doc: Record<string, unknown>, keep: ReadonlySet<string>): { doc: Record<string, unknown>; kept: boolean } {
  const out = structuredClone(doc);
  let kept = false;
  for (const l of strings(at(out, MARKETPLACE_HEADERS.split('.').slice(1)))) {
    if (isReferenceOnly(l.value)) continue;
    if (keep.has(`extraKnownMarketplaces.${l.field}`)) kept = true;
    else setAt(out, l.place, asReference(l.value) ?? '');
  }
  for (const l of strings(at(out, MARKETPLACE_URL.split('.').slice(1)))) {
    const field = `extraKnownMarketplaces.${l.field}`;
    const keys = urlSecrets(l.value, field).filter((s) => !s.field.endsWith('.userinfo')).map((s) => s.field);
    if (keys.some((k) => keep.has(k))) kept = true;
    const drop = new Set(keys.filter((k) => !keep.has(k)));
    if (drop.size) setAt(out, l.place, urlWithout(l.value, field, drop));
  }
  return { doc: out, kept };
}

/** The LSP servers in `v`, an LSP config wrapped in lspServers or flat, whose env holds a value that is not only references. */
export const keyedLsp = (v: unknown): string[] => docs(isDoc(v) && isDoc(v.lspServers) ? v.lspServers : v)
  .filter(([, s]) => Object.values(texts(s.env)).some((x) => !isReferenceOnly(x))).map(([name]) => name);

/**
 * The LSP configs under plugin root `root` with a server holding a key, as `lspServers.<name>`; one that cannot be read, or
 * leads outside the plugin, is named in `unreadable`.
 */
export function lspKeys(root: string, unreadable: string[], marketNamed: string[] = []): { file: string; fields: string[] }[] {
  const manifest = path.join(root, '.claude-plugin/plugin.json');
  const named = readDoc(manifest, JSON.parse, [])?.lspServers;
  const read = (f: string): { file: string; doc: unknown }[] => {
    if (!fs.existsSync(f)) return [];
    if (within(root, f)) return [{ file: f, doc: readDoc(f, JSON.parse, unreadable) }];
    unreadable.push(f);
    return [];
  };
  const found = [
    ...read(path.join(root, '.lsp.json')), ...(isDoc(named) ? [{ file: manifest, doc: named }] : []),
    ...[...new Set([...namedPaths(named), ...marketNamed].map((n) => path.resolve(root, n)))].filter((f) => f !== path.join(root, '.lsp.json')).flatMap(read),
  ];
  return found.flatMap(({ file, doc }) => {
    const fields = keyedLsp(doc).map((name) => `lspServers.${name}`);
    return fields.length ? [{ file, fields }] : [];
  });
}

export const readPluginLsp = (plugins: PluginInstall[], unreadable: string[]): { name: string; file: string; fields: string[] }[] =>
  plugins.flatMap((p) => lspKeys(p.installPath, unreadable, p.namedLsp).map((c) => ({ name: p.name, ...c })));

/** A marketplace list `doc` with each header its entries set emptied but for the references it holds. */
export function marketplaceBare(doc: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(doc);
  for (const l of strings(at(out, ['plugins', '*', '**', 'headers', '*']))) if (!isReferenceOnly(l.value)) setAt(out, l.place, asReference(l.value) ?? '');
  return out;
}

/** The entries of a marketplace list `doc` that set headers or a headersHelper anywhere in them, as `plugins.<name>`. */
export const headedEntries = (doc: unknown): string[] => (isDoc(doc) && Array.isArray(doc.plugins) ? doc.plugins as unknown[] : [])
  .flatMap((e, i) => (isDoc(e) && (at(e, ['**', 'headers']).length || at(e, ['**', 'headersHelper']).length) ? [`plugins.${typeof e.name === 'string' ? e.name : i}`] : []));

export const agentServer = (name: string, raw: Doc): McpServer => toServer('claude', 'user', { name, raw, file: '', place: [] });
