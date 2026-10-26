import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { holds } from '../handover/portable-path.js';
import { shq } from '../text.js';
import { relocated, type MirrorHomes } from './mirror.js';

export const Scope = z.union([z.literal('user'), z.object({ project: z.string() }), z.object({ plugin: z.string() })]);
export type Scope = z.infer<typeof Scope>;

/** An MCP server as its agent's config holds it: `raw` the entry itself, the rest read from it; `file` a plugin server's file. */
export type McpServer = {
  agent: AgentKind; name: string; scope: Scope; command?: string; args: string[]; cwd?: string; env: Record<string, string>;
  url?: string; headers: Record<string, string>; raw: Record<string, unknown>; known: boolean; file?: string;
};
export type PluginInstall = { name: string; installPath: string };
/** A value found by its field: `env.<KEY>`, `headers.<Name>`, `url.<param>`, `url.userinfo`, `args[<i>]`, `args[<i>].userinfo`, `oauth.<key>`. */
export type Secret = { field: string; value: string };

export const KNOWN_FIELDS: readonly string[] = [
  'type', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'transport', 'oauth', 'enabled', 'timeout', 'bearer_token_env_var', 'env_vars',
  'http_headers', 'env_http_headers', 'startup_timeout_sec', 'tool_timeout_sec', 'environment',
];
/** Where each agent's entry holds a server's env, headers and args; OpenCode's args are its `command` from index 1. */
export const FIELD_PATHS: Record<AgentKind, { env: string; headers: string; args: string }> = {
  claude: { env: 'env', headers: 'headers', args: 'args' },
  codex: { env: 'env', headers: 'http_headers', args: 'args' },
  opencode: { env: 'environment', headers: 'headers', args: 'command' },
};
export const VAR_REF = /\$\{([A-Z_][A-Z0-9_]*)\}|\{env:([A-Z_][A-Z0-9_]*)\}/g;
export const KNOWN_OAUTH_HOSTS: readonly string[] = [
  'mcp.linear.app', 'mcp.notion.com', 'mcp.atlassian.com', 'mcp.sentry.dev', 'mcp.stripe.com', 'mcp.asana.com', 'mcp.intercom.com', 'mcp.figma.com',
  'mcp.vercel.com', 'mcp.cloudflare.com',
];
export const CODEX_SECRET_PATHS: readonly string[] = [
  'model_providers.*.http_headers.*', 'model_providers.*.experimental_bearer_token', 'model_providers.*.query_params.*', 'otel.**.headers.*', 'shell_environment_policy.set.*',
];
export const CODEX_NEED_PATHS: readonly string[] = ['model_providers.*.env_http_headers.*', 'model_providers.*.env_key'];
export const OPENCODE_SECRET_PATHS: readonly string[] = ['provider.*.options.apiKey', 'provider.*.options.headers.*', 'lsp.*.env.*', 'formatter.*.environment.*'];

const SECRET_FLAG = /(?:^|-)(api[-_]?key|token|secret|password|passwd|auth(?:orization)?|key|credential)s?$/i;
const HEADER_FLAG = /^(--header|-H)$/;
const ENV_ARG = /^[A-Z][A-Z0-9_]*=.+/;
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@:]+):([^\s/?#@]*)@/i;
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

/** JSON with `//` and `/* *\/` comments outside its strings, as opencode.jsonc holds it. */
export const parseJsonc = (source: string): unknown =>
  JSON.parse(source.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s: string | undefined) => s ?? ''));

// a config file's object, or undefined for none; a file there that cannot be read or parsed is named in `unreadable`
function readDoc(file: string, parse: (source: string) => unknown, unreadable: string[]): Doc | undefined {
  let source: string;
  try { source = fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(file);
    return undefined;
  }
  try {
    const doc = parse(source);
    return isDoc(doc) ? doc : undefined;
  } catch {
    unreadable.push(file);
    return undefined;
  }
}

function toServer(agent: AgentKind, name: string, scope: Scope, raw: Doc, file?: string): McpServer {
  const p = FIELD_PATHS[agent];
  const argv = agent === 'opencode' && Array.isArray(raw.command) ? raw.command.map(String) : undefined;
  const command = argv ? argv[0] : text(raw.command);
  const cwd = text(raw.cwd);
  const url = text(raw.url);
  return {
    agent, name, scope, args: argv ? argv.slice(1) : Array.isArray(raw.args) ? raw.args.map(String) : [], env: texts(raw[p.env]), headers: texts(raw[p.headers]), raw,
    known: Object.keys(raw).every((k) => KNOWN_FIELDS.includes(k)),
    ...(command !== undefined && { command }), ...(cwd !== undefined && { cwd }), ...(url !== undefined && { url }), ...(file !== undefined && { file }),
  };
}

// a plugin's servers by the file each was read from: .mcp.json, then plugin.json's mcpServers, inline or in the file it names
function pluginServers(installPath: string, unreadable: string[]): [string, [string, Doc][]][] {
  const servers = (doc: Doc | undefined): [string, Doc][] => (doc ? docs(Object.hasOwn(doc, 'mcpServers') ? doc.mcpServers : doc) : []);
  const mcpJson = path.join(installPath, '.mcp.json');
  const manifest = path.join(installPath, '.claude-plugin/plugin.json');
  const named = readDoc(manifest, JSON.parse, unreadable)?.mcpServers;
  const found: [string, [string, Doc][]][] = [[mcpJson, servers(readDoc(mcpJson, JSON.parse, unreadable))]];
  if (isDoc(named)) found.push([manifest, docs(named)]);
  else if (typeof named === 'string') {
    const file = path.resolve(installPath, named);
    found.push([file, servers(readDoc(file, JSON.parse, unreadable))]);
  }
  return found;
}

/**
 * Every agent's MCP servers: Claude's user servers, those of its projects under the home and each plugin's, once per plugin
 * and name from the first install; Codex's mcp_servers; OpenCode's, from opencode.jsonc when there is one, else opencode.json.
 */
export function readServers(homes: MirrorHomes, plugins: PluginInstall[]): { servers: McpServer[]; unreadable: string[] } {
  const servers: McpServer[] = [];
  const unreadable: string[] = [];
  const claude = readDoc(homes.claudeJson, JSON.parse, unreadable);
  for (const [name, raw] of docs(claude?.mcpServers)) servers.push(toServer('claude', name, 'user', raw));
  for (const [dir, project] of docs(claude?.projects)) {
    if (holds(homes.homedir, dir)) for (const [name, raw] of docs(project.mcpServers)) servers.push(toServer('claude', name, { project: dir }, raw));
  }
  const seen = new Set<string>();
  for (const p of plugins) {
    for (const [file, found] of pluginServers(p.installPath, unreadable)) {
      for (const [name, raw] of found) {
        if (seen.has(JSON.stringify([p.name, name]))) continue;
        seen.add(JSON.stringify([p.name, name]));
        servers.push(toServer('claude', name, { plugin: p.name }, raw, file));
      }
    }
  }
  const codex = readDoc(path.join(homes.codexDir, 'config.toml'), parseToml, unreadable);
  for (const [name, raw] of docs(codex?.mcp_servers)) servers.push(toServer('codex', name, 'user', raw));
  const jsonc = path.join(homes.opencodeDir, 'opencode.jsonc');
  const mcp = readDoc(fs.existsSync(jsonc) ? jsonc : path.join(homes.opencodeDir, 'opencode.json'), parseJsonc, unreadable)?.mcp;
  // OpenCode 2 keeps its servers under mcp.servers and still reads OpenCode 1's beside them
  const { servers: v2, ...v1 } = isDoc(mcp) ? mcp : {};
  for (const [name, raw] of docs({ ...v1, ...(isDoc(v2) ? v2 : {}) })) servers.push(toServer('opencode', name, 'user', raw));
  return { servers, unreadable };
}

/** Claude's installed plugins, each one's user-scope install first and then its others as listed. */
export function readPlugins(claudeDir: string): PluginInstall[] {
  const plugins = readDoc(path.join(claudeDir, 'plugins/installed_plugins.json'), JSON.parse, [])?.plugins;
  return Object.entries(isDoc(plugins) ? plugins : {}).flatMap(([name, installs]) => {
    const all = (Array.isArray(installs) ? installs : []).filter((i): i is Doc => isDoc(i) && typeof i.installPath === 'string');
    const paths = [...all.filter((i) => i.scope === 'user'), ...all.filter((i) => i.scope !== 'user')].map((i) => i.installPath as string);
    return [...new Set(paths)].map((installPath) => ({ name, installPath }));
  });
}

export const isReferenceOnly = (v: string): boolean => v.replace(VAR_REF, '').replace(/^(Bearer|Token|Basic)\s*$/i, '').trim() === '';

// a URL's user:password in `source`, unless the password is only references
function userinfo(source: string): string | undefined {
  const m = USERINFO.exec(source);
  return m && !isReferenceOnly(m[3]) ? `${m[2]}:${m[3]}` : undefined;
}

// the query parameters of `url` before any fragment
function params(url: string): { name: string; value: string }[] {
  const query = url.split('#')[0].split('?').slice(1).join('?');
  return query.split('&').flatMap((kv) => (kv.indexOf('=') > 0 ? [{ name: kv.slice(0, kv.indexOf('=')), value: kv.slice(kv.indexOf('=') + 1) }] : []));
}

// `url` with its userinfo and the parameter values `drop` names emptied
function urlWithout(url: string, drop: ReadonlySet<string>): string {
  const u = drop.has('url.userinfo') ? url.replace(USERINFO, '$1') : url;
  const end = u.includes('#') ? u.indexOf('#') : u.length;
  const q = u.slice(0, end).indexOf('?');
  if (q < 0) return u;
  const query = u.slice(q + 1, end).split('&').map((kv) => (kv.indexOf('=') > 0 && drop.has(`url.${kv.slice(0, kv.indexOf('='))}`) ? kv.slice(0, kv.indexOf('=') + 1) : kv));
  return `${u.slice(0, q + 1)}${query.join('&')}${u.slice(end)}`;
}

// arg `i` as the part that stays and the value a secret there would be: after a secret flag or --header, or in
// --flag=value with a secret flag, or KEY=value
function argValue(args: string[], i: number): [keep: string, value: string] | undefined {
  const a = args[i];
  const flag = /^--?([^=]+)$/.exec(args[i - 1] ?? '')?.[1];
  if (flag !== undefined && SECRET_FLAG.test(flag)) return ['', a];
  if (HEADER_FLAG.test(args[i - 1] ?? '') && a.includes(':')) return [a.slice(0, a.indexOf(':') + 1), a.slice(a.indexOf(':') + 1).trim()];
  const assigned = /^--?([^=]+)=/.exec(a);
  if (assigned && SECRET_FLAG.test(assigned[1])) return [assigned[0], a.slice(assigned[0].length)];
  if (ENV_ARG.test(a)) return [a.slice(0, a.indexOf('=') + 1), a.slice(a.indexOf('=') + 1)];
  return undefined;
}

// the secret in arg `i` and the arg without it; an arg listed whole is not listed again by its userinfo
function argSecret(args: string[], i: number): (Secret & { emptied: string }) | undefined {
  const kv = argValue(args, i);
  if (kv && !isReferenceOnly(kv[1])) return { field: `args[${i}]`, value: kv[1], emptied: kv[0] };
  const u = userinfo(args[i]);
  return u === undefined ? undefined : { field: `args[${i}].userinfo`, value: u, emptied: args[i].replace(USERINFO, '$1') };
}

/** The values in `s` that are secrets, each by its field; a value that is only references is none. */
export function secretsOf(s: McpServer): Secret[] {
  const fields = (kind: 'env' | 'headers'): Secret[] => Object.entries(s[kind]).filter(([, v]) => !isReferenceOnly(v)).map(([k, v]) => ({ field: `${kind}.${k}`, value: v }));
  const url = s.url === undefined ? [] : [
    ...params(s.url).filter((p) => !isReferenceOnly(p.value)).map((p) => ({ field: `url.${p.name}`, value: p.value })),
    ...[userinfo(s.url)].flatMap((u) => (u === undefined ? [] : [{ field: 'url.userinfo', value: u }])),
  ];
  const args = s.args.flatMap((_, i) => [argSecret(s.args, i)].flatMap((f) => (f ? [{ field: f.field, value: f.value }] : [])));
  const oauth = Object.entries(texts(s.raw.oauth)).filter(([k, v]) => OAUTH_SECRETS.includes(k) && !isReferenceOnly(v)).map(([k, v]) => ({ field: `oauth.${k}`, value: v }));
  return [...fields('env'), ...fields('headers'), ...url, ...args, ...oauth];
}

/** The variables `s` names, which the worker's daemon must hold: references, empty env values and Codex's env-named fields. */
export function needsOf(s: McpServer): string[] {
  const named = [...Object.values(s.env), ...Object.values(s.headers), s.url ?? '', ...s.args, ...Object.values(texts(s.raw.oauth))]
    .flatMap((v) => [...v.matchAll(VAR_REF)].map((m) => m[1] ?? m[2]));
  const empty = Object.keys(s.env).filter((k) => s.env[k] === '');
  const envVars = Array.isArray(s.raw.env_vars) ? s.raw.env_vars.map((e) => (isDoc(e) ? e.name : e)) : [];
  const codex = s.agent === 'codex' ? [s.raw.bearer_token_env_var, ...envVars, ...Object.values(texts(s.raw.env_http_headers))] : [];
  const plugin = typeof s.scope === 'object' && 'plugin' in s.scope;
  return [...new Set([...named, ...empty, ...codex])].filter((n): n is string => typeof n === 'string' && n !== '' && !(plugin && PLUGIN_VARS.test(n))).sort();
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

/** The command that logs `s` in on the worker, and the port mcp-remote's callback listens on there when its args name one. */
export function oauthLogin(s: McpServer): { run: string; forward?: number } {
  const argv = [s.command ?? '', ...s.args];
  const remote = argv.findIndex((a) => MCP_REMOTE.test(a));
  const url = remote < 0 ? -1 : argv.findIndex((a, i) => i > remote && /^https?:\/\//.test(a));
  const port = url < 0 ? undefined : argv[url + 1];
  const name = /^[\w.-]+$/.test(s.name) ? s.name : shq(s.name);
  // mcp-remote logs in once the agent starts it; Codex's and OpenCode's own logins take remote servers only
  const run = s.agent === 'claude' || remote >= 0 ? s.agent : s.agent === 'codex' ? `codex mcp login ${name}` : `opencode mcp auth ${name}`;
  return { run, ...(port !== undefined && /^\d+$/.test(port) && { forward: Number(port) }) };
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
  if (s.url !== undefined) raw.url = urlWithout(s.url, drop);
  const argv = raw[p.args] as unknown[];
  const from = s.agent === 'opencode' ? 1 : 0;
  s.args.forEach((_, i) => {
    const f = argSecret(s.args, i);
    if (f && drop.has(f.field)) argv[i + from] = f.emptied;
  });
  const oauth = raw.oauth;
  if (isDoc(oauth)) for (const k of OAUTH_SECRETS) if (drop.has(`oauth.${k}`)) oauth[k] = '';
  return raw;
}

/** A server entry with its command, args, cwd and OpenCode's command array moved by `move` where they are absolute paths. */
export function relocatedServer(entry: Record<string, unknown>, move: (p: string) => string): Record<string, unknown> {
  const moved = { ...entry };
  for (const k of ['command', 'args', 'cwd']) if (Object.hasOwn(entry, k)) moved[k] = relocated(entry[k], move, true);
  return moved;
}

type Leaf = { field: string; value: unknown };
// the values at `pattern`'s dotted path in `doc`, `*` any one key and `**` any number of them, each by its concrete path
function at(doc: unknown, pattern: string[], field: string[] = []): Leaf[] {
  if (!pattern.length) return [{ field: field.join('.'), value: doc }];
  const [head, ...rest] = pattern;
  const kids = typeof doc === 'object' && doc !== null ? Object.entries(doc) : [];
  if (head === '**') return [...at(doc, rest, field), ...kids.flatMap(([k, v]) => at(v, pattern, [...field, k]))];
  return kids.filter(([k]) => head === '*' || k === head).flatMap(([k, v]) => at(v, rest, [...field, k]));
}
const strings = (leaves: Leaf[]): Secret[] => leaves.filter((l): l is Secret => typeof l.value === 'string');
const SECRET_PATHS: Record<AgentKind, readonly string[]> = { claude: [], codex: CODEX_SECRET_PATHS, opencode: OPENCODE_SECRET_PATHS };

/**
 * The secrets in an agent's config file `doc` by their concrete path: its key fields, and the userinfo of a URL in any
 * string; Claude's marketplace urls lose theirs on the way, so they are none.
 */
export function configSecrets(agent: AgentKind, doc: Record<string, unknown>): Secret[] {
  const keys = SECRET_PATHS[agent].flatMap((p) => strings(at(doc, p.split('.')))).filter((l) => !isReferenceOnly(l.value));
  const skip = new Set([...keys.map((l) => l.field), ...(agent === 'claude' ? at(doc, MARKETPLACE_URL.split('.')).map((l) => l.field) : [])]);
  const userinfos = strings(at(doc, ['**'])).filter((l) => !skip.has(l.field))
    .flatMap((l) => [userinfo(l.value)].flatMap((u) => (u === undefined ? [] : [{ field: `${l.field}.userinfo`, value: u }])));
  return [...keys, ...userinfos];
}

/** The variables an agent's config file `doc` names: OpenCode's `{env:VAR}` anywhere, Codex's env-named key fields. */
export function configNeeds(agent: AgentKind, doc: Record<string, unknown>): string[] {
  const names = agent === 'opencode' ? strings(at(doc, ['**'])).flatMap((l) => [...l.value.matchAll(VAR_REF)].map((m) => m[2]))
    : agent === 'codex' ? CODEX_NEED_PATHS.flatMap((p) => strings(at(doc, p.split('.')))).map((l) => l.value) : [];
  return [...new Set(names)].filter((n): n is string => !!n).sort();
}

/** Claude's settings.json env, which stays off the worker. */
export const readSettingsEnv = (claudeDir: string): Record<string, string> => texts(readDoc(path.join(claudeDir, 'settings.json'), JSON.parse, [])?.env);

/** Each plugin's settings.json that holds more than permissions, hooks, a model and env references, with its top-level keys. */
export function readPluginConfigs(plugins: PluginInstall[]): { name: string; file: string; fields: string[] }[] {
  return plugins.flatMap(({ name, installPath }) => {
    const file = path.join(installPath, 'settings.json');
    if (!fs.existsSync(file)) return [];
    const doc = readDoc(file, JSON.parse, []);
    const plain = doc && Object.entries(doc).every(([k, v]) =>
      PLUGIN_SETTINGS.includes(k) || (k === 'env' && isDoc(v) && Object.values(v).every((x) => typeof x === 'string' && isReferenceOnly(x))));
    return plain ? [] : [{ name, file, fields: Object.keys(doc ?? {}) }];
  });
}
