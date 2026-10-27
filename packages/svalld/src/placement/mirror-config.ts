import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { VAR_NAME } from '../claude.js';
import { holds } from '../handover/portable-path.js';
import { shq } from '../text.js';
import { relocated, type MirrorHomes } from './mirror.js';

export const Scope = z.union([z.literal('user'), z.object({ project: z.string() }), z.object({ plugin: z.string() })]);
export type Scope = z.infer<typeof Scope>;

/**
 * An MCP server as its agent's config holds it: `raw` the entry itself, the rest read from it; `file` the file it was read
 * from and `place` the keys that lead to its entry there.
 */
export type McpServer = {
  agent: AgentKind; name: string; scope: Scope; command?: string; args: string[]; cwd?: string; env: Record<string, string>;
  url?: string; headers: Record<string, string>; raw: Record<string, unknown>; known: boolean; file?: string; place?: string[];
};
/**
 * An installed plugin; `named` the server files its marketplace entry names by path, under the plugin, and `unreadMarket`
 * its marketplace.json when that cannot be read, so its entry is not known.
 */
export type PluginInstall = { name: string; installPath: string; named?: string[]; unreadMarket?: string };
/**
 * A value found by its field: `env.<KEY>`, `headers.<Name>`, `url.<param>`, `url.userinfo`, `args[<arg>]`, `args[<arg>].<param>`,
 * `args[<arg>].userinfo`, `oauth.<key>`, an arg by what names it as argFields says; a field that holds several is listed once for each.
 */
export type Secret = { field: string; value: string };

export const KNOWN_FIELDS: readonly string[] = [
  'type', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'transport', 'oauth', 'enabled', 'timeout', 'bearer_token_env_var', 'env_vars',
  'http_headers', 'env_http_headers', 'startup_timeout_sec', 'tool_timeout_sec', 'environment',
];
// each agent's share of KNOWN_FIELDS, as its own server schema names them
const AGENT_FIELDS: Record<AgentKind, readonly string[]> = {
  claude: ['type', 'command', 'args', 'env', 'url', 'headers', 'oauth', 'timeout'],
  codex: ['command', 'args', 'cwd', 'env', 'url', 'oauth', 'enabled', 'bearer_token_env_var', 'env_vars', 'http_headers', 'env_http_headers', 'startup_timeout_sec', 'tool_timeout_sec'],
  opencode: ['type', 'command', 'cwd', 'environment', 'url', 'headers', 'oauth', 'enabled', 'timeout'],
};
/** Where each agent's entry holds a server's env, headers and args; OpenCode's args are its `command` from index 1. */
export const FIELD_PATHS: Record<AgentKind, { env: string; headers: string; args: string }> = {
  claude: { env: 'env', headers: 'headers', args: 'args' },
  codex: { env: 'env', headers: 'http_headers', args: 'args' },
  opencode: { env: 'environment', headers: 'headers', args: 'command' },
};
// a variable's name as VAR_NAME takes it
const NAME = VAR_NAME.source.slice(1, -1);
/** A reference: `${NAME}`, `${NAME:-default}` or `{env:NAME}`, the variable named in its first or second group. */
export const VAR_REF = new RegExp(`\\$\\{(${NAME})(?::-[^}]*)?\\}|\\{env:(${NAME})\\}`, 'g');
export const KNOWN_OAUTH_HOSTS: readonly string[] = [
  'mcp.linear.app', 'mcp.notion.com', 'mcp.atlassian.com', 'mcp.sentry.dev', 'mcp.stripe.com', 'mcp.asana.com', 'mcp.intercom.com', 'mcp.figma.com',
  'mcp.vercel.com', 'mcp.cloudflare.com',
];
export const CODEX_SECRET_PATHS: readonly string[] = [
  'model_providers.*.http_headers.*', 'model_providers.*.experimental_bearer_token', 'model_providers.*.query_params.*', 'otel.**.headers.*', 'shell_environment_policy.set.*',
];
// Codex's URLs whose query values are keys, and its lists of args read as a server's
const CODEX_URLS = ['model_providers.*.base_url', 'otel.**.endpoint'];
const CODEX_ARGS = ['model_providers.*.auth.args'];
export const CODEX_NEED_PATHS: readonly string[] = ['model_providers.*.env_http_headers.*', 'model_providers.*.env_key'];
export const OPENCODE_SECRET_PATHS: readonly string[] = [
  'provider.*.options.apiKey', 'provider.*.options.headers.*', 'provider.*.models.*.headers.*', 'providers.*.headers.*', 'providers.*.body.**',
  'providers.*.models.*.headers.*', 'providers.*.models.*.body.**', 'agents.*.request.headers.*', 'agents.*.request.body.**', 'lsp.*.env.*', 'formatter.*.environment.*',
];
// OpenCode's option maps, each string under which is a key when its name says so
const OPENCODE_OPTIONS = ['provider.*.options.**', 'provider.*.models.*.options.**', 'agent.*.options.**', 'agents.*.options.**'];

const SECRET_FLAG = /(?:^|-)(api[-_]?key|token|secret|password|passwd|auth(?:orization)?|key|credential)s?$/i;
// an OpenCode provider option that is a key by its name, beside those SECRET_FLAG names
const PROVIDER_KEY = /^(private[-_]?key|accessKeyId|secretAccessKey|sessionToken)$/i;
const HEADER_FLAG = /^(--header|-H)$/;
const ENV_ARG = new RegExp(`^${NAME}=.+`);
const ENV_KEY = new RegExp(`^(${NAME})=`);
// a URL's userinfo, up to the last @ before the / ? # or space that ends its authority; the scheme's length is bounded,
// so a long run of letters is scanned once
const USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)@/gi;
const URL_IN = /[a-z][a-z0-9+.-]{0,31}:\/\//i;
// a URL's host after its ://, past any userinfo
const HOST = /^(?:[^\s/?#]*@)?([^\s/?#,;]*)/;
const MCP_REMOTE = /(^|\/)mcp-remote(@[^/\s]*)?$/;
// Codex's and OpenCode 2's client_secret, OpenCode 1's clientSecret
const OAUTH_SECRETS = ['client_secret', 'clientSecret'];
// what Claude sets for a plugin's own servers
const PLUGIN_VARS = /^CLAUDE_PLUGIN_(ROOT|DATA|OPTION_\w+)$/;
const RUNTIME: Record<string, string[]> = {
  npx: ['node', 'npx'], node: ['node'], bunx: ['bun'], bun: ['bun'], uvx: ['uvx'], uv: ['uv'], docker: ['docker'], python3: ['python3'], python: ['python3'],
};
const MARKETPLACE_URL = 'extraKnownMarketplaces.*.source.url';
const PLUGIN_SETTINGS = ['permissions', 'hooks', 'model'];

type Doc = Record<string, unknown>;
const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const docs = (v: unknown): [string, Doc][] => (isDoc(v) ? Object.entries(v).filter((e): e is [string, Doc] => isDoc(e[1])) : []);
const texts = (v: unknown): Record<string, string> => (isDoc(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {});
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

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
// the server entries of `v`, which sits at `place` in `file`
const entries = (file: string, place: string[], v: unknown): Entry[] => docs(v).map(([name, raw]) => ({ name, raw, file, place: [...place, name] }));

// where `raw` holds its args, and from which index: OpenCode's command array from 1, else args
function argsAt(agent: AgentKind, raw: Doc): [key: string, from: number] {
  const key = FIELD_PATHS[agent].args;
  return key !== 'command' ? [key, 0] : Array.isArray(raw.command) ? ['command', 1] : ['args', 0];
}

function toServer(agent: AgentKind, scope: Scope, { name, raw, file, place }: Entry): McpServer {
  const p = FIELD_PATHS[agent];
  const [key, from] = argsAt(agent, raw);
  const argv = Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(String) : [];
  const command = key === 'command' ? argv[0] : text(raw.command);
  const cwd = text(raw.cwd);
  const url = text(raw.url);
  return {
    agent, name, scope, args: argv.slice(from), env: texts(raw[p.env]), headers: texts(raw[p.headers]), raw, file, place,
    known: Object.keys(raw).every((k) => AGENT_FIELDS[agent].includes(k)),
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

/** The Claude servers of plugin `plugin` in `v`, which lies at `place` in `file`. */
export const pluginServersAt = (plugin: string, file: string, place: string[], v: unknown): McpServer[] =>
  entries(file, place, v).map((e) => toServer('claude', { plugin }, e));

/** The Claude servers of plugin `plugin` in its server file `file`; a file it cannot read is named in `unreadable`. */
export const fileServers = (plugin: string, file: string, unreadable: string[]): McpServer[] =>
  fileEntries(file, unreadable).map((e) => toServer('claude', { plugin }, e));

/** The servers of the plugin installed at `p`, each from its file; a file it cannot read is named in `unreadable`. */
export const readPluginServers = (p: PluginInstall, unreadable: string[]): McpServer[] =>
  pluginServers(p.installPath, unreadable, p.named).map((e) => toServer('claude', { plugin: p.name }, e));

/**
 * Every agent's MCP servers: Claude's user servers, those of its projects and each plugin's, once per plugin
 * and name from the first install; Codex's mcp_servers; OpenCode's in opencode.json and opencode.jsonc, OpenCode 2's under
 * mcp.servers and OpenCode 1's flat in mcp, which OpenCode 2 still reads.
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
  const { named, broken, known, list } = marketNamed(claudeDir);
  return Object.entries(plugins as Record<string, Doc[]>).flatMap(([name, all]) => {
    const paths = [...all.filter((i) => i.scope === 'user'), ...all.filter((i) => i.scope !== 'user')].map((i) => i.installPath as string);
    // an install is named `<plugin>@<marketplace>`
    const files = named.get(name) ?? [...named].find(([k]) => !name.includes('@') && k.startsWith(`${name}@`))?.[1];
    const from = name.includes('@') ? name.slice(name.indexOf('@') + 1) : undefined;
    const market = from === undefined ? undefined : broken.get(from) ?? (list && !known.has(from) ? list : undefined);
    if (market) unreadable.push(market);
    return [...new Set(paths)].map((installPath) => ({ name, installPath, ...(files && { named: files }), ...(market && { unreadMarket: market }) }));
  });
}

/** The paths an `mcpServers` value names: one, or each of a list. */
export const namedPaths = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((n): n is string => typeof n === 'string');

// the server files each marketplace's plugin entries name by path, as `strict: false` entries do, by `<plugin>@<marketplace>`;
// each marketplace whose folder is not there or whose marketplace.json cannot be read, by its name; every name found; and
// known_marketplaces.json when it cannot be read. A marketplace lies under plugins/marketplaces, or where
// known_marketplaces.json puts one added from a local folder
function marketNamed(claudeDir: string): { named: Map<string, string[]>; broken: Map<string, string>; known: Set<string>; list?: string } {
  const named = new Map<string, string[]>();
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
      if (!isDoc(e) || typeof e.name !== 'string' || !namedPaths(e.mcpServers).length) continue;
      for (const market of new Set([m, typeof doc?.name === 'string' ? doc.name : m])) {
        known.add(market);
        named.set(`${e.name}@${market}`, [...new Set([...(named.get(`${e.name}@${market}`) ?? []), ...namedPaths(e.mcpServers)])]);
      }
    }
  }
  return { named, broken, known, ...(unreadList.length && { list: listFile }) };
}

export const isReferenceOnly = (v: string): boolean => v.replace(VAR_REF, '').replace(/^(Bearer|Token|Basic)\s*$/i, '').trim() === '';

// a URL's credential: its userinfo when it holds a password that is not only references, or when it is the lone user of
// an http(s) URL and not only references
function credential(scheme: string, userinfo: string): string | undefined {
  const colon = userinfo.indexOf(':');
  if (colon >= 0) return isReferenceOnly(userinfo.slice(colon + 1)) ? undefined : userinfo;
  return /https?:\/\/$/i.test(scheme) && !isReferenceOnly(userinfo) ? userinfo : undefined;
}
// whether `source` holds a URL; one without :// is not scanned further
const hasUrl = (source: string): boolean => source.includes('://') && URL_IN.test(source);
// the credential of each URL in `source`
const credentials = (source: string): string[] =>
  (hasUrl(source) ? [...source.matchAll(USERINFO)] : []).flatMap((m) => [credential(m[1], m[2])].filter((c): c is string => c !== undefined));
/** `source` without the credential of each URL in it. */
export const withoutCredentials = (source: string): string => (!hasUrl(source) ? source
  : source.replace(USERINFO, (all, scheme: string, userinfo: string) => (credential(scheme, userinfo) === undefined ? all : scheme)));

// the query parameters of `url` before any fragment
function params(url: string): { name: string; value: string }[] {
  const query = url.split('#')[0].split('?').slice(1).join('?');
  return query.split('&').flatMap((kv) => (kv.indexOf('=') > 0 ? [{ name: kv.slice(0, kv.indexOf('=')), value: kv.slice(kv.indexOf('=') + 1) }] : []));
}

// the secrets in `source`, the value of `field`: its query parameter values when `query`, and every URL credential in it
function urlSecrets(source: string, field: string, query: boolean): Secret[] {
  const values = query ? params(source).filter((p) => !isReferenceOnly(p.value)).map((p) => ({ field: `${field}.${p.name}`, value: p.value })) : [];
  return [...values, ...credentials(source).map((value) => ({ field: `${field}.userinfo`, value }))];
}

// `source`, the value of `field`, with the credentials and parameter values `drop` names emptied
function urlWithout(source: string, field: string, drop: ReadonlySet<string>): string {
  const u = drop.has(`${field}.userinfo`) ? withoutCredentials(source) : source;
  const end = u.includes('#') ? u.indexOf('#') : u.length;
  const q = u.slice(0, end).indexOf('?');
  if (q < 0) return u;
  const query = u.slice(q + 1, end).split('&').map((kv) => (kv.indexOf('=') > 0 && drop.has(`${field}.${kv.slice(0, kv.indexOf('='))}`) ? kv.slice(0, kv.indexOf('=') + 1) : kv));
  return `${u.slice(0, q + 1)}${query.join('&')}${u.slice(end)}`;
}

// a flag whose last word, in kebab-, snake- or camelCase, names a secret
const secretFlag = (flag: string): boolean => SECRET_FLAG.test(flag.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-'));

// a header `Name: value` after `keep`, as the part that stays and its value
const header = (keep: string, h: string): [keep: string, value: string] => [`${keep}${h.slice(0, h.indexOf(':') + 1)}`, h.slice(h.indexOf(':') + 1).trim()];

// a header `Name: value`'s name
const headerName = (h: string): string => h.slice(0, h.indexOf(':')).trim();

// what names arg `i`, whatever its value: the secret flag or the header flag and header before it, its own secret
// --flag= or --header=Name, the KEY of KEY= bare or after --flag=, or the scheme and host of a URL in it
function argName(args: string[], i: number): string | undefined {
  const a = args[i];
  const before = args[i - 1] ?? '';
  const flag = /^--?([^=]+)$/.exec(before)?.[1];
  if (flag !== undefined && secretFlag(flag)) return before;
  if (HEADER_FLAG.test(before) && a.includes(':')) return `${before} ${headerName(a)}`;
  const assigned = /^--?([^=]+)=/.exec(a);
  const rest = a.slice(assigned?.[0].length ?? 0);
  if (assigned && secretFlag(assigned[1])) return assigned[0].slice(0, -1);
  if (assigned && HEADER_FLAG.test(assigned[0].slice(0, -1)) && rest.includes(':')) return `${assigned[0].slice(0, -1)} ${headerName(rest)}`;
  const key = ENV_KEY.exec(rest)?.[1];
  if (key !== undefined) return key;
  return originOf(a);
}

// the scheme and host of the first URL in `a`, looked for back from each :// in it, so a long run of letters is not
// scanned for a scheme
function originOf(a: string): string | undefined {
  for (let i = a.indexOf('://'); i >= 0; i = a.indexOf('://', i + 1)) {
    const scheme = /[a-z][a-z0-9+.-]{0,31}$/i.exec(a.slice(Math.max(0, i - 32), i))?.[0];
    if (scheme) return `${scheme}://${HOST.exec(a.slice(i + 3))?.[1] ?? ''}`;
  }
  return undefined;
}

// each arg's field: `args[<what names it>]`, or `args[<i>]` where nothing names it or an arg before has that name
function argFields(args: string[]): string[] {
  const seen = new Set<string>();
  return args.map((_, i) => {
    const name = argName(args, i);
    if (name === undefined || seen.has(name)) return `args[${i}]`;
    seen.add(name);
    return `args[${name}]`;
  });
}

// the index of the arg whose field `field` is or lies under, or -1
function argIndex(args: string[], field: string): number {
  const fields = argFields(args);
  const exact = fields.indexOf(field);
  return exact >= 0 ? exact : fields.findIndex((f) => field.startsWith(`${f}.`));
}

// arg `i` as the part that stays and the value a secret there would be: after a secret flag or --header, or in
// --flag=value with a secret flag, --header=Name: value, or KEY=value bare or after --flag=
function argValue(args: string[], i: number): [keep: string, value: string] | undefined {
  const a = args[i];
  const flag = /^--?([^=]+)$/.exec(args[i - 1] ?? '')?.[1];
  if (flag !== undefined && secretFlag(flag)) return ['', a];
  if (HEADER_FLAG.test(args[i - 1] ?? '') && a.includes(':')) return header('', a);
  const assigned = /^--?([^=]+)=/.exec(a);
  const keep = assigned?.[0] ?? '';
  const rest = a.slice(keep.length);
  if (assigned && secretFlag(assigned[1])) return [keep, rest];
  if (HEADER_FLAG.test(keep.slice(0, -1)) && rest.includes(':')) return header(keep, rest);
  if (ENV_ARG.test(rest)) return [`${keep}${rest.slice(0, rest.indexOf('=') + 1)}`, rest.slice(rest.indexOf('=') + 1)];
  return undefined;
}

// the secrets in `args`, each by its field: an arg's value whole, or else the query and credentials of a URL anywhere in it
function argsSecrets(args: string[]): Secret[] {
  const fields = argFields(args);
  return args.flatMap((a, i) => {
    const kv = argValue(args, i);
    if (kv && !isReferenceOnly(kv[1])) return [{ field: fields[i], value: kv[1] }];
    return urlSecrets(a, fields[i], hasUrl(a));
  });
}

// arg `i` of `args`, whose field is `field`, with the secrets `drop` names emptied
function argWithout(args: string[], i: number, field: string, drop: ReadonlySet<string>): string {
  const kv = argValue(args, i);
  return kv && drop.has(field) ? kv[0] : urlWithout(args[i], field, drop);
}

/** The values in `s` that are secrets, each by its field; a value that is only references is none. */
export function secretsOf(s: McpServer): Secret[] {
  const fields = (kind: 'env' | 'headers'): Secret[] => Object.entries(s[kind]).filter(([, v]) => !isReferenceOnly(v)).map(([k, v]) => ({ field: `${kind}.${k}`, value: v }));
  const url = s.url === undefined ? [] : urlSecrets(s.url, 'url', true);
  const args = argsSecrets(s.args);
  const oauth = Object.entries(texts(s.raw.oauth)).filter(([k, v]) => OAUTH_SECRETS.includes(k) && !isReferenceOnly(v)).map(([k, v]) => ({ field: `oauth.${k}`, value: v }));
  return [...fields('env'), ...fields('headers'), ...url, ...args, ...oauth];
}

/**
 * The variables `s` names, which the worker's daemon must hold: references, empty env values and Codex's env-named fields,
 * each a variable's name.
 */
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

/** Whether `s` runs only on this Mac: a loopback url, the Chrome extension, Chrome's devtools or an app bundle. */
export const isMacOnly = (s: McpServer): boolean =>
  /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(s.url ?? '') || [s.command ?? '', ...s.args].some((a) => /claude-in-chrome|chrome-devtools|\/Applications\//.test(a));

/** What the worker must have to run `s`: the runtime its command names, or an absolute command itself. */
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
 * `s.raw` with each secret not in `keep` emptied where its agent holds it, and each such env value and every empty one
 * named as the agent's reference, so the worker's own variable is used: Claude `${KEY}`, OpenCode `{env:KEY}`, Codex `env_vars`.
 */
export function redacted(s: McpServer, keep: ReadonlySet<string>): Record<string, unknown> {
  const drop = new Set(secretsOf(s).map((f) => f.field).filter((f) => !keep.has(f)));
  const p = FIELD_PATHS[s.agent];
  const raw = structuredClone(s.raw);
  const unset = Object.keys(s.env).filter((k) => drop.has(`env.${k}`) || s.env[k] === '');
  const env = raw[p.env] as Doc;
  if (s.agent === 'codex' && unset.length) {
    for (const k of unset) delete env[k];
    const names = Array.isArray(raw.env_vars) ? raw.env_vars : [];
    raw.env_vars = [...names, ...unset.filter((k) => !names.some((n) => n === k || (isDoc(n) && n.name === k)))];
  } else for (const k of unset) env[k] = s.agent === 'claude' ? `\${${k}}` : `{env:${k}}`;
  for (const h of Object.keys(s.headers)) if (drop.has(`headers.${h}`)) (raw[p.headers] as Doc)[h] = '';
  if (s.url !== undefined) raw.url = urlWithout(s.url, 'url', drop);
  const [key, from] = argsAt(s.agent, raw);
  const fields = argFields(s.args);
  s.args.forEach((a, i) => {
    const emptied = argWithout(s.args, i, fields[i], drop);
    if (emptied !== a) (raw[key] as unknown[])[i + from] = emptied;
  });
  const oauth = raw.oauth;
  if (isDoc(oauth)) for (const k of OAUTH_SECRETS) if (drop.has(`oauth.${k}`)) oauth[k] = '';
  return raw;
}

/**
 * Where secret field `field` of a server lies in its entry `raw`: under its env, headers or oauth key, its url, or its arg;
 * none for an arg no longer there.
 */
export function fieldPlace(agent: AgentKind, raw: Record<string, unknown>, field: string): Place | undefined {
  if (field.startsWith('args[')) {
    const [key, from] = argsAt(agent, raw);
    const i = argIndex((Array.isArray(raw[key]) ? raw[key] as unknown[] : []).slice(from).map(String), field);
    return i < 0 ? undefined : [key, i + from];
  }
  const dot = field.indexOf('.');
  const head = field.slice(0, dot);
  if (head === 'url') return ['url'];
  return [head === 'env' ? FIELD_PATHS[agent].env : head === 'headers' ? FIELD_PATHS[agent].headers : head, field.slice(dot + 1)];
}

/** A server entry with its command, args, cwd and OpenCode's command array moved by `move` where they are absolute paths. */
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
const SECRET_PATHS: Record<AgentKind, readonly string[]> = { claude: [], codex: CODEX_SECRET_PATHS, opencode: OPENCODE_SECRET_PATHS };

// OpenCode's provider, model and agent options: each string named as a key, and the query values of their baseURL
function providerSecrets(doc: Record<string, unknown>): Secret[] {
  const options = OPENCODE_OPTIONS.flatMap((p) => strings(at(doc, p.split('.'))));
  const named = options.filter((l) => {
    const key = l.field.slice(l.field.lastIndexOf('.') + 1);
    return secretFlag(key) || PROVIDER_KEY.test(key);
  });
  const queries = options.filter((l) => l.field.endsWith('.options.baseURL')).flatMap((l) => urlSecrets(l.value, l.field, true).filter((s) => !s.field.endsWith('.userinfo')));
  return [...named, ...queries];
}

// Codex's provider base_url and otel endpoints by their query values, and its args lists as a server's args, each list's
// fields under its own path
function codexSecrets(doc: Record<string, unknown>): Secret[] {
  const queries = CODEX_URLS.flatMap((p) => strings(at(doc, p.split('.')))).flatMap((l) => urlSecrets(l.value, l.field, true).filter((s) => !s.field.endsWith('.userinfo')));
  const args = argLists(doc).flatMap((l) => argsSecrets(l.args).map((s) => ({ field: `${l.field}${s.field.slice('args'.length)}`, value: s.value })));
  return [...queries, ...args];
}

// each of Codex's args lists in `doc`, by its path
const argLists = (doc: unknown): { field: string; args: string[] }[] => CODEX_ARGS.flatMap((p) => at(doc, p.split('.')))
  .filter((l) => Array.isArray(l.value) && l.value.every((a) => typeof a === 'string')).map((l) => ({ field: l.field, args: l.value as string[] }));

/**
 * The secrets in an agent's config file `doc` by their concrete path: its key fields, and the userinfo of a URL in any
 * other string; Claude's marketplace urls lose theirs on the way, so they are none.
 */
export function configSecrets(agent: AgentKind, doc: Record<string, unknown>): Secret[] {
  const found = [...SECRET_PATHS[agent].flatMap((p) => strings(at(doc, p.split('.')))), ...(agent === 'opencode' ? providerSecrets(doc) : agent === 'codex' ? codexSecrets(doc) : [])];
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

/** Keys leading into a document, an array's index among them. */
export type Place = (string | number)[];

/** The value at `place` in `doc`, or undefined where nothing lies. */
export const getAt = (doc: unknown, place: Place): unknown =>
  place.reduce<unknown>((v, k) => (typeof v === 'object' && v !== null && Object.hasOwn(v, k) ? (v as Record<string | number, unknown>)[k] : undefined), doc);

/** Puts `v` at `place` in `doc`, making the objects that lead there; `undefined` removes what lies there. */
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

// a config field naming an arg, `<path of its list>[<name>]…`: the list's place, the arg's index there, the arg's own
// field among the list's args and the field under it
function argOf(doc: unknown, field: string): { list: string[]; i: number; args: string[]; own: string; field: string } | undefined {
  const open = field.indexOf('[');
  const list = open > 0 ? placeIn(doc, field.slice(0, open), (x) => Array.isArray(x) && x.every((a) => typeof a === 'string')) : undefined;
  if (!list) return undefined;
  const args = getAt(doc, list) as string[];
  const arg = `args${field.slice(open)}`;
  const i = argIndex(args, arg);
  return i < 0 ? undefined : { list, i, args, own: argFields(args)[i], field: arg };
}

/**
 * Where config field `field` of `doc`, as configSecrets names it, lies: its string, the arg that holds it, or the URL one
 * that holds it for a `.userinfo` or a query value, whose name may hold dots.
 */
export function configPlace(doc: unknown, field: string): string[] | undefined {
  const arg = argOf(doc, field);
  if (arg) return [...arg.list, String(arg.i)];
  const parts = field.replace(/\.userinfo$/, '').split('.');
  for (let n = parts.length; n > 0; n -= 1) {
    const place = placeIn(doc, parts.slice(0, n).join('.'));
    if (place) return place;
  }
  return undefined;
}

/** `doc` with each of `fields` emptied: a key field's string, or in a URL the credentials for a `.userinfo` or the query value. */
export function configRedacted(doc: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out = structuredClone(doc);
  for (const f of fields) {
    const arg = argOf(out, f);
    if (arg) {
      setAt(out, [...arg.list, arg.i], argWithout(arg.args, arg.i, arg.own, new Set([arg.field])));
      continue;
    }
    const place = configPlace(out, f);
    if (!place) continue;
    const v = getAt(out, place) as string;
    setAt(out, place, f.endsWith('.userinfo') ? withoutCredentials(v) : place.join('.') === f ? '' : urlWithout(v, place.join('.'), new Set([f])));
  }
  return out;
}

/** Claude's settings.json env, which stays off the worker. */
export const readSettingsEnv = (claudeDir: string): Record<string, string> => texts(readDoc(path.join(claudeDir, 'settings.json'), JSON.parse, [])?.env);

/**
 * Each plugin's settings.json that holds more than permissions, hooks, a model and env references, with its top-level keys;
 * one that cannot be read is named in `unreadable`.
 */
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
