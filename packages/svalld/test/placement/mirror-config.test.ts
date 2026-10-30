import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentKeys } from '../../src/placement/mirror-agents.js';
import {
  configNeeds, configPlace, configRedacted, configSecrets, FIELD_PATHS, fieldPlace, isMacOnly, isOAuth, keyedLsp, marketplaceList, needsOf, oauthLogin,
  readMirrorVars, readPluginConfigs, readPlugins, readServers, redacted, relocatedServer, runtimesOf, secretsOf, withoutCredentials, type McpServer,
} from '../../src/placement/mirror-config.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { macHome, put } from './mirror-homes.js';

afterEach(() => cleanHomes());

let mac: ReturnType<typeof macHome>;
let bare: string;
let oc: string;
let acmeWithEnv: string;
beforeEach(() => {
  mac = macHome();
  put(mac.claudeJson, JSON.stringify({
    mcpServers: {
      linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
      remote: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://x.test/sse', '3334'] },
      chrome: { type: 'stdio', command: 'npx', args: ['claude-in-chrome-mcp'] },
    },
    projects: {
      [`${mac.homedir}/code/app`]: { mcpServers: { db: { command: 'uvx', args: ['db-mcp'], env: { DB_URL: '${DB_URL}' } } } },
      '/opt/elsewhere': { mcpServers: { other: { command: 'x' } } },
    },
  }));
  const acme = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0');
  put(path.join(acme, '.mcp.json'), JSON.stringify({ pdf: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/pdf.js'] } }));
  put(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: acme }] } }));
  put(path.join(mac.codexDir, 'config.toml'), '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "github-mcp"]\nenv_vars = ["GITHUB_TOKEN"]\n');
  fs.rmSync(path.join(mac.opencodeDir, 'opencode.jsonc'));
  put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ mcp: { servers: {
    ctx: { type: 'local', command: ['bunx', 'ctx-mcp'], environment: { K: '{env:CTX_KEY}' } },
    far: { type: 'remote', url: 'https://far.test/mcp', headers: { Authorization: 'Bearer {env:FAR_TOKEN}' } },
  } } }));
  bare = makeHome();
  oc = path.join(bare, '.config/opencode');
  acmeWithEnv = path.join(makeHome(), 'acme');
  put(path.join(acmeWithEnv, 'settings.json'), JSON.stringify({ env: { K: 'v' }, model: 'opus' }));
});

// a server as readServers makes it, its raw entry in the agent's own shape
function server(agent: AgentKind, o: Partial<Pick<McpServer, 'command' | 'args' | 'env' | 'headers' | 'url'>> & { raw?: Record<string, unknown> } = {}): McpServer {
  const { raw: extra, ...fields } = o;
  const p = FIELD_PATHS[agent];
  const command = agent === 'opencode' && fields.args && !fields.command ? 'cmd' : fields.command;
  const argv = agent === 'opencode'
    ? (command !== undefined ? { command: [command, ...(fields.args ?? [])] } : {})
    : { ...(command !== undefined ? { command } : {}), ...(fields.args ? { args: fields.args } : {}) };
  const raw = {
    ...argv, ...(fields.env ? { [p.env]: fields.env } : {}), ...(fields.headers ? { [p.headers]: fields.headers } : {}), ...(fields.url ? { url: fields.url } : {}), ...extra,
  };
  return { agent, name: 'srv', scope: 'user', args: [], env: {}, headers: {}, known: true, ...fields, ...(command !== undefined ? { command } : {}), raw };
}

// homes with no agent configuration but what a test puts in OpenCode's folder
const bareHomes = () => ({ homedir: bare, claudeDir: path.join(bare, '.claude'), codexDir: path.join(bare, '.codex'), claudeJson: path.join(bare, '.claude.json'), opencodeDir: oc });
// such homes whose opencode.jsonc holds `text`
function withJsonc(text: string) {
  put(path.join(oc, 'opencode.jsonc'), text);
  return bareHomes();
}

const codexDoc = { model: 'gpt-5', model_providers: { acme: {
  base_url: 'https://acme.test/v1', http_headers: { 'X-Key': 'k-123' }, experimental_bearer_token: 'tok-123', env_http_headers: { 'X-Org': 'ACME_ORG' },
} } };
const ocDoc = { provider: { openai: { options: { apiKey: 'sk-oc-123' } }, anthropic: { options: { apiKey: '{env:ANTHROPIC_KEY}', baseURL: 'https://api.test' } } } };

describe('reading agent configs and finding secrets by field', () => {
  it('reads Claude user, project and plugin servers, Codex mcp_servers and OpenCode local and remote servers into one shape', () => {
    const listed: string[] = [];
    const { servers, unreadable } = readServers(mac, readPlugins(mac.claudeDir, listed));
    expect(servers.map((s) => [s.agent, s.name, s.scope])).toEqual([
      ['claude', 'linear', 'user'], ['claude', 'remote', 'user'], ['claude', 'chrome', 'user'], ['claude', 'db', { project: `${mac.homedir}/code/app` }],
      ['claude', 'other', { project: '/opt/elsewhere' }], ['claude', 'pdf', { plugin: 'acme' }], ['codex', 'github', 'user'], ['opencode', 'ctx', 'user'], ['opencode', 'far', 'user'],
    ]);
    expect([...listed, ...unreadable]).toEqual([]);
  });

  it('finds secrets by field and references as needs; a value that is both is both', () => {
    const s = server('claude', { env: { API_KEY: 'sk-live-1234567890ab', REF: '${OTHER}', DB: 'postgres://u:s3cret@${DB_HOST}/db' }, headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' }, url: 'https://x.test/sse?key=abc', args: ['--github-token', 't0k3n', 'DB_URL=postgres://u:p@h/db', '--port=3334', 'mysql://a:b@h/x'] });
    expect(secretsOf(s).map((f) => f.field).sort()).toEqual(['args[--github-token]', 'args[DB_URL]', 'args[mysql://h].userinfo', 'env.API_KEY', 'env.DB', 'url.key']);
    expect(needsOf(s)).toEqual(['DB_HOST', 'LINEAR_TOKEN', 'OTHER']);
    expect(isOAuth(s)).toBe(false);
  });

  it('an empty env value, {env:VAR}, bearer_token_env_var and env_http_headers are needs', () => {
    expect(needsOf(server('codex', { env: { A: '' }, raw: { bearer_token_env_var: 'GH_TOKEN', env_http_headers: { 'X-Org': 'ORG_ID' } } }))).toEqual(['A', 'GH_TOKEN', 'ORG_ID']);
    expect(needsOf(server('opencode', { env: { K: '{env:OC_KEY}' } }))).toEqual(['OC_KEY']);
  });

  it('mcp-remote, --oauth and a known host are OAuth, a plain https url is not; 127.0.0.1 and claude-in-chrome are Mac-only; npx needs node and npx', () => {
    expect(isOAuth(server('claude', { url: 'https://mcp.linear.app/sse' }))).toBe(true);
    expect(isOAuth(server('claude', { url: 'https://docs.example.com/mcp' }))).toBe(false);
    expect(isOAuth(server('claude', { command: 'npx', args: ['-y', 'mcp-remote', 'https://x.test/sse', '3334'] }))).toBe(true);
    expect(oauthLogin(server('claude', { command: 'npx', args: ['-y', 'mcp-remote', 'https://x.test/sse', '3334'] }))).toEqual({ run: 'claude', forward: 3334 });
    // Claude Code's own sign-in waits on a random port unless MCP_OAUTH_CALLBACK_PORT names one, or the server's config does
    expect(oauthLogin(server('claude', { url: 'https://mcp.linear.app/mcp' }))).toEqual({ run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118 });
    expect(oauthLogin(server('claude', { url: 'https://x.test/mcp', raw: { oauth: { clientId: 'cid', callbackPort: 8080 } } }))).toEqual({ run: 'claude', forward: 8080 });
    expect(isMacOnly(server('claude', { url: 'http://127.0.0.1:3845/sse' }))).toBe(true);
    expect(isMacOnly(server('claude', { command: 'xcrun', args: ['mcp-server'] }))).toBe(true);
    expect(isMacOnly(server('claude', { command: '/usr/bin/osascript' }))).toBe(true);
    expect(isMacOnly(server('claude', { command: 'adlc' }))).toBe(false);
    expect(runtimesOf(server('claude', { command: 'npx' }))).toEqual(['node', 'npx']);
    expect(runtimesOf(server('claude', { command: '/Users/ada/bin/srv' }))).toEqual(['/Users/ada/bin/srv']);
  });

  it('redacted empties secret fields at each agent\'s raw path, writes an emptied or empty env value as the agent\'s reference, and keeps the ticked ones', () => {
    expect(redacted(server('opencode', { env: { K: 'v' }, headers: { H: 'h' }, args: ['--token', 't'] }), new Set(['headers.H']))).toEqual({ environment: { K: '{env:K}' }, headers: { H: 'h' }, command: ['cmd', '--token', ''] });
    const codex = redacted(server('codex', { env: { K: 'v', E: '' }, headers: { H: 'h' } }), new Set());
    expect([codex.env, codex.env_vars, codex.http_headers]).toEqual([{}, ['K', 'E'], { H: '' }]);
    expect(redacted(server('claude', { env: { K: 'v', E: '' } }), new Set(['env.K']))).toMatchObject({ env: { K: 'v', E: '${E}' } });
  });

  it('relocatedServer moves command, args, cwd and OpenCode command[] under the home, and nothing outside it', () => {
    const move = (p: string) => p.replace(mac.homedir, '/home/ada');
    expect(relocatedServer({ command: `${mac.homedir}/bin/srv`, args: [`${mac.homedir}/x.json`, '/opt/y'], cwd: `${mac.homedir}/code` }, move))
      .toEqual({ command: '/home/ada/bin/srv', args: ['/home/ada/x.json', '/opt/y'], cwd: '/home/ada/code' });
    expect(relocatedServer({ type: 'local', command: [`${mac.homedir}/bin/srv`, '--log', `${mac.homedir}/log`] }, move)).toEqual({ type: 'local', command: ['/home/ada/bin/srv', '--log', '/home/ada/log'] });
  });

  it('config-file key fields: Codex http_headers, experimental_bearer_token, query_params, otel headers and shell_environment_policy.set are secrets, env_http_headers a need; OpenCode provider apiKey, lsp env and formatter environment secrets, {env:X} a need; userinfo in any string is a secret, a marketplace url\'s excepted', () => {
    expect(configSecrets('codex', codexDoc).map((f) => f.field)).toEqual(['model_providers.acme.http_headers.X-Key', 'model_providers.acme.experimental_bearer_token']);
    expect(configNeeds('codex', codexDoc)).toEqual(['ACME_ORG']);
    expect(configSecrets('opencode', ocDoc).map((f) => f.field)).toEqual(['provider.openai.options.apiKey']);
    expect(configNeeds('opencode', ocDoc)).toEqual(['ANTHROPIC_KEY']);
    expect(configSecrets('codex', { shell_environment_policy: { set: { K: 'v' } }, otel: { exporter: { 'otlp-http': { headers: { H: 'h' } } } }, model_providers: { m: { query_params: { key: 'q' }, base_url: 'https://u:p@x.test/v1' } } }).map((f) => f.field).sort())
      .toEqual(['model_providers.m.base_url.userinfo', 'model_providers.m.query_params.key', 'otel.exporter.otlp-http.headers.H', 'shell_environment_policy.set.K']);
    expect(configSecrets('opencode', { lsp: { ts: { env: { K: 'v', R: '{env:R}' } } }, formatter: { p: { environment: { K: 'v' } } } }).map((f) => f.field).sort()).toEqual(['formatter.p.environment.K', 'lsp.ts.env.K']);
    expect(configSecrets('claude', { feed: 'https://u:p@h.test/x', extraKnownMarketplaces: { m: { source: { url: 'https://u:p@git.test/m.git' } } } }).map((f) => f.field)).toEqual(['feed.userinfo']);
  });

  it('plugin servers come from .mcp.json, wrapped or flat, and from plugin.json mcpServers, inline or by path; each names its file, once per plugin and name, the user-scope install first', () => {
    const at = (p: string) => path.join(mac.claudeDir, 'plugins/cache/mp', p);
    put(at('a/.mcp.json'), JSON.stringify({ mcpServers: { s1: { command: 'x' } } })); put(at('a-old/.mcp.json'), JSON.stringify({ mcpServers: { s1: { command: 'y' } } }));
    put(at('b/.mcp.json'), JSON.stringify({ s2: { command: 'x' } }));
    put(at('c/.claude-plugin/plugin.json'), JSON.stringify({ name: 'c', mcpServers: { s3: { command: 'x' } } }));
    put(at('d/.claude-plugin/plugin.json'), JSON.stringify({ name: 'd', mcpServers: './servers.json' })); put(at('d/servers.json'), JSON.stringify({ mcpServers: { s4: { command: 'x' } } }));
    put(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      a: [{ scope: 'project', projectPath: '/p', installPath: at('a-old') }, { scope: 'user', installPath: at('a') }],
      b: [{ scope: 'user', installPath: at('b') }], c: [{ scope: 'user', installPath: at('c') }], d: [{ scope: 'user', installPath: at('d') }],
    } }));
    const servers = readServers(mac, readPlugins(mac.claudeDir, [])).servers.filter((s) => typeof s.scope === 'object' && 'plugin' in s.scope);
    expect(servers.map((s) => [s.name, s.command, s.file])).toEqual([
      ['s1', 'x', at('a/.mcp.json')], ['s2', 'x', at('b/.mcp.json')], ['s3', 'x', at('c/.claude-plugin/plugin.json')], ['s4', 'x', at('d/servers.json')],
    ]);
  });

  it('a server with a field the mirror does not know is not known; a plugin settings.json with env or an unknown key is listed whole; an opencode.jsonc with comments parses, a broken one is unreadable', () => {
    expect(readServers(withJsonc('{ "mcp": { "odd": { "type": "local", "command": ["x"], "sandbox": true } } }'), []).servers[0].known).toBe(false);
    expect(readPluginConfigs([{ name: 'acme', installPath: acmeWithEnv }], [])).toEqual([{ name: 'acme', file: path.join(acmeWithEnv, 'settings.json'), fields: ['env', 'model'] }]);
    expect(readServers(withJsonc('{ // c\n "mcp": {} }'), []).unreadable).toEqual([]);
    expect(readServers(withJsonc('{ "mcp": '), []).unreadable).toEqual([path.join(oc, 'opencode.jsonc')]);
    const plain = path.join(bare, 'plain');
    put(path.join(plain, 'settings.json'), JSON.stringify({ hooks: {}, model: 'opus', env: { K: '${K}' } }));
    expect(readPluginConfigs([{ name: 'plain', installPath: plain }], [])).toEqual([]);
  });

  it('as the pinned agents keep them: an OAuth client secret and an mcp-remote --header value are secrets, header auth is no OAuth, Codex env_vars by name, a plugin\'s own variables no needs, and a login by the agent\'s own subcommand', () => {
    const codex = server('codex', { url: 'https://mcp.linear.app/mcp', raw: { oauth: { client_id: 'cid', client_secret: 'cs-1' } } });
    expect(secretsOf(codex)).toEqual([{ field: 'oauth.client_secret', value: 'cs-1' }]);
    expect(redacted(codex, new Set())).toEqual({ url: 'https://mcp.linear.app/mcp', oauth: { client_id: 'cid', client_secret: '' } });
    const header = server('claude', { command: 'npx', args: ['mcp-remote', 'https://mcp.linear.app/sse', '--header', 'Authorization: Bearer sk-1'] });
    expect(secretsOf(header)).toEqual([{ field: 'args[--header Authorization]', value: 'Bearer sk-1' }]);
    expect(redacted(header, new Set()).args).toEqual(['mcp-remote', 'https://mcp.linear.app/sse', '--header', 'Authorization:']);
    expect(isOAuth(header)).toBe(false);
    expect(isOAuth(server('claude', { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } }))).toBe(false);
    expect(needsOf(server('codex', { raw: { env_vars: ['S', { name: 'T', source: 'local' }] } }))).toEqual(['S', 'T']);
    expect(needsOf({ ...server('claude', { args: ['${CLAUDE_PLUGIN_ROOT}/s.js', '${API_KEY}'] }), scope: { plugin: 'acme' } })).toEqual(['API_KEY']);
    expect(redacted(server('claude', { args: ['--api-key=k1', 'DB_URL=postgres://u:p@h/db', 'mysql://a:b@h/x'], url: 'https://u:p@x.test/sse?key=abc&debug' }), new Set()))
      .toMatchObject({ args: ['--api-key=', 'DB_URL=', 'mysql://h/x'], url: 'https://x.test/sse?key=&debug' });
    expect(oauthLogin(server('codex', { url: 'https://mcp.linear.app/mcp' }))).toEqual({ run: 'codex mcp login srv' });
    expect(oauthLogin(server('opencode', { url: 'https://mcp.linear.app/mcp' }))).toEqual({ run: 'opencode mcp auth srv' });
    expect(oauthLogin(server('codex', { command: 'npx', args: ['-y', 'mcp-remote', 'https://x.test/sse', '3334'] }))).toEqual({ run: 'codex', forward: 3334 });
  });

  it('a URL in an arg gives up its query values, every credential of each URL in a string is a secret, a lone token too, and all are emptied', () => {
    const q = server('claude', { command: 'npx', args: ['-y', 'mcp-remote', 'https://server.test/x/mcp?api_key=sk-live-123&profile=${PROFILE}'] });
    expect(secretsOf(q)).toEqual([{ field: 'args[https://server.test].api_key', value: 'sk-live-123' }]);
    expect(redacted(q, new Set()).args).toEqual(['-y', 'mcp-remote', 'https://server.test/x/mcp?api_key=&profile=${PROFILE}']);
    const u = server('claude', { url: 'https://tok-1@x.test/mcp', args: ['--from', 'git+https://ghp_tok@github.com/o/r.git', '--mirrors=https://u:p@a.test,https://v:q@b.test', 'https://${GH_TOKEN}@github.com/o', 'ssh://git@github.com/o', 'postgres://user@h/db'] });
    expect(secretsOf(u)).toEqual([
      { field: 'url.userinfo', value: 'tok-1' }, { field: 'args[git+https://github.com].userinfo', value: 'ghp_tok' }, { field: 'args[https://a.test].userinfo', value: 'u:p' },
      { field: 'args[https://a.test].userinfo', value: 'v:q' },
    ]);
    expect(needsOf(u)).toEqual(['GH_TOKEN']);
    expect(redacted(u, new Set())).toMatchObject({ url: 'https://x.test/mcp', args: ['--from', 'git+https://github.com/o/r.git', '--mirrors=https://a.test,https://b.test', 'https://${GH_TOKEN}@github.com/o', 'ssh://git@github.com/o', 'postgres://user@h/db'] });
    expect(configSecrets('codex', { feeds: 'https://a:1@x.test https://tok@y.test' }).map((f) => [f.field, f.value])).toEqual([['feeds.userinfo', 'a:1'], ['feeds.userinfo', 'tok']]);
  });

  it('a secret flag ends in a word of any case: --githubToken and --access_token too', () => {
    expect(secretsOf(server('claude', { args: ['--githubToken', 'g1', '--access_token=a1', '--monkey', 'm1'] })).map((f) => f.field)).toEqual(['args[--githubToken]', 'args[--access_token]']);
  });

  it('a field another agent reads is no field of this one: Claude http_headers, Codex headers, OpenCode env and args make a server not known, and redacting it holds', () => {
    put(mac.claudeJson, JSON.stringify({ mcpServers: { c1: { url: 'https://x.test', http_headers: { Authorization: 'Bearer sk-c' } }, c2: { command: 'x', environment: { K: 'v' } }, ok: { type: 'http', url: 'https://x.test', headers: {}, timeout: 5 } } }));
    put(path.join(mac.codexDir, 'config.toml'), '[mcp_servers.x1.headers]\nAuthorization = "Bearer sk-x"\n[mcp_servers.x2]\ncommand = "x"\nenvironment = { K = "v" }\n[mcp_servers.ok]\ncommand = "x"\ncwd = "/tmp"\nenv_vars = ["K"]\n');
    put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ mcp: { servers: {
      o1: { type: 'local', command: ['x'], env: { K: 'v' } }, o2: { type: 'local', command: 'x', args: ['--token', 't'] }, o3: { type: 'remote', url: 'https://x.test', http_headers: { A: 'b' } },
      ok: { type: 'local', command: ['x'], environment: {}, cwd: '/tmp' },
    } } }));
    const { servers } = readServers(mac, []);
    expect(servers.map((s) => [s.agent, s.name, s.known])).toEqual([
      ['claude', 'c1', false], ['claude', 'c2', false], ['claude', 'ok', true], ['codex', 'x1', false], ['codex', 'x2', false], ['codex', 'ok', true],
      ['opencode', 'o1', false], ['opencode', 'o2', false], ['opencode', 'o3', false], ['opencode', 'ok', true],
    ]);
    expect(redacted(servers.find((s) => s.name === 'o2')!, new Set())).toEqual({ type: 'local', command: 'x', args: ['--token', ''] });
  });

  it('every server names its file and its place there; OpenCode\'s come from opencode.json and opencode.jsonc both, under mcp.servers and flat both, one name in each', () => {
    const plugin = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const at = Object.fromEntries(readServers(mac, readPlugins(mac.claudeDir, [])).servers.map((s) => [s.name, [s.file, s.place]]));
    expect([at.linear, at.db, at.pdf, at.github]).toEqual([
      [mac.claudeJson, ['mcpServers', 'linear']], [mac.claudeJson, ['projects', `${mac.homedir}/code/app`, 'mcpServers', 'db']], [plugin, ['pdf']],
      [path.join(mac.codexDir, 'config.toml'), ['mcp_servers', 'github']],
    ]);
    put(path.join(oc, 'opencode.json'), JSON.stringify({ mcp: { timeout: { startup: 5 }, dup: { type: 'local', command: ['a'], environment: { K: 'sk-v1' } }, servers: { dup: { type: 'local', command: ['b'] } } } }));
    put(path.join(oc, 'opencode.jsonc'), '{ "mcp": { "servers": { "j": { "type": "remote", "url": "https://j.test" } } } }');
    expect(readServers(bareHomes(), []).servers.map((s) => [s.name, s.file, s.place, secretsOf(s).map((f) => f.field)])).toEqual([
      ['dup', path.join(oc, 'opencode.json'), ['mcp', 'servers', 'dup'], []], ['dup', path.join(oc, 'opencode.json'), ['mcp', 'dup'], ['env.K']],
      ['j', path.join(oc, 'opencode.jsonc'), ['mcp', 'servers', 'j'], []],
    ]);
  });

  it('a file that cannot be parsed or holds servers in a shape the mirror does not know is unreadable and yields none: .claude.json, config.toml, plugin JSON, a manifest naming an array or a file outside its plugin, installed_plugins.json', () => {
    const at = (p: string) => path.join(mac.claudeDir, 'plugins/cache/mp', p);
    put(mac.claudeJson, '{ "mcpServers": ');
    put(path.join(mac.codexDir, 'config.toml'), '[mcp_servers.x\n');
    put(path.join(mac.opencodeDir, 'opencode.json'), '[]');
    put(at('a/.mcp.json'), '{ "s": ');
    put(at('b/.claude-plugin/plugin.json'), JSON.stringify({ mcpServers: ['./extra.json'] })); put(at('b/extra.json'), JSON.stringify({ s: { command: 'x', env: { K: 'sk-arr' } } }));
    put(at('c/.claude-plugin/plugin.json'), JSON.stringify({ mcpServers: '../outside.json' })); put(at('outside.json'), JSON.stringify({ s: { command: 'x' } }));
    put(at('d/.mcp.json'), JSON.stringify({ mcpServers: 'x' }));
    expect(readServers(mac, ['a', 'b', 'c', 'd'].map((n) => ({ name: n, installPath: at(n) })))).toEqual({ servers: [], unreadable: [
      mac.claudeJson, at('a/.mcp.json'), at('b/.claude-plugin/plugin.json'), at('c/.claude-plugin/plugin.json'), at('d/.mcp.json'),
      path.join(mac.codexDir, 'config.toml'), path.join(mac.opencodeDir, 'opencode.json'),
    ] });
    const list = path.join(mac.claudeDir, 'plugins/installed_plugins.json');
    for (const broken of ['{ "plugins": ', '{ "version": 1, "plugins": { "a": { "installPath": "/x" } } }']) {
      put(list, broken);
      const listed: string[] = [];
      expect([readPlugins(mac.claudeDir, listed), listed]).toEqual([[], [list]]);
    }
  });

  it('an opencode.jsonc with trailing commas parses, a comma in a string stays', () => {
    const { servers, unreadable } = readServers(withJsonc('{ "mcp": { "servers": { "t": { "type": "local", "command": ["x", "a,}",], }, }, }, }'), []);
    expect([unreadable, servers.map((s) => [s.command, s.args])]).toEqual([[], [['x', ['a,}']]]]);
  });

  it('--header=Name: value, -H=Name: value, --env=KEY=value and -e=KEY=value carry keys as their two-arg forms do, and are emptied', () => {
    const s = server('claude', { args: ['--header=Authorization: Bearer sk-1', '-H=X-Key: k2', '--env=GITHUB_TOKEN=ghp_1', '-e=API_KEY=k3', '--env=REF=${REF}', '--port=3334'] });
    expect(secretsOf(s)).toEqual([
      { field: 'args[--header Authorization]', value: 'Bearer sk-1' }, { field: 'args[-H X-Key]', value: 'k2' }, { field: 'args[GITHUB_TOKEN]', value: 'ghp_1' },
      { field: 'args[API_KEY]', value: 'k3' },
    ]);
    expect(redacted(s, new Set()).args).toEqual(['--header=Authorization:', '-H=X-Key:', '--env=GITHUB_TOKEN=', '-e=API_KEY=', '--env=REF=${REF}', '--port=3334']);
  });

  it('a URL inside an arg gives up its query values wherever it starts in the arg', () => {
    const s = server('claude', { args: ['--endpoint=https://x.test/mcp?api_key=sk-live-1&debug'] });
    expect(secretsOf(s)).toEqual([{ field: 'args[https://x.test].api_key', value: 'sk-live-1' }]);
    expect(redacted(s, new Set()).args).toEqual(['--endpoint=https://x.test/mcp?api_key=&debug']);
  });

  it('a 5 MB arg of one token, and a long one after a ://, are scanned in well under a second', () => {
    const big = 'a'.repeat(5 * 2 ** 20);
    const s = server('claude', { args: [big, `://${'a'.repeat(2 ** 19)}`] });
    const t = Date.now();
    secretsOf(s); redacted(s, new Set()); configSecrets('codex', { big });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('OpenCode provider options: any key named as a key, an AWS credential, a private key and a baseURL\'s query value named as a key are secrets, a model\'s options too, and are emptied', () => {
    const doc = { provider: {
      bedrock: { options: { region: 'us-east-1', accessKeyId: 'AKIA123', secretAccessKey: 'sak-1', sessionToken: 'st-1', baseURL: 'https://u:p@x.test/v1?api_key=q1&v=2' } },
      vertex: { models: { m: { options: { privateKey: 'pk-1', private_key: 'pk-2', clientSecret: 'cs-1', apiKey: 'mk-1', project: 'p-1' } } } },
      openai: { options: { apiKey: 'sk-oc-1', headers: { 'X-Org': 'org-1' } } },
    } };
    expect(configSecrets('opencode', doc).map((f) => f.field).sort()).toEqual([
      'provider.bedrock.options.accessKeyId', 'provider.bedrock.options.baseURL.api_key', 'provider.bedrock.options.baseURL.userinfo', 'provider.bedrock.options.secretAccessKey',
      'provider.bedrock.options.sessionToken', 'provider.openai.options.apiKey', 'provider.openai.options.headers.X-Org', 'provider.vertex.models.m.options.apiKey',
      'provider.vertex.models.m.options.clientSecret', 'provider.vertex.models.m.options.privateKey', 'provider.vertex.models.m.options.private_key',
    ]);
    const out = configRedacted(doc, configSecrets('opencode', doc).map((f) => f.field)) as typeof doc;
    expect(out.provider.bedrock.options).toEqual({ region: 'us-east-1', accessKeyId: '', secretAccessKey: '', sessionToken: '', baseURL: 'https://x.test/v1?api_key=&v=2' });
    expect(out.provider.vertex.models.m.options).toEqual({ privateKey: '', private_key: '', clientSecret: '', apiKey: '', project: 'p-1' });
  });

  it('a baseURL query value whose name holds dots is emptied as it is listed, alone where only it is', () => {
    const doc = { provider: { x: { options: { baseURL: 'https://h.test/v1?auth.token=tok_1234567890&key=v_1234567890' } } } };
    const fields = configSecrets('opencode', doc).map((f) => f.field);
    expect(fields.sort()).toEqual(['provider.x.options.baseURL.auth.token', 'provider.x.options.baseURL.key']);
    expect((configRedacted(doc, fields) as typeof doc).provider.x.options.baseURL).toBe('https://h.test/v1?auth.token=&key=');
    expect((configRedacted(doc, ['provider.x.options.baseURL.auth.token']) as typeof doc).provider.x.options.baseURL).toBe('https://h.test/v1?auth.token=&key=v_1234567890');
  });

  it('a plugin manifest naming a server file through a link that leads outside the plugin is unreadable and yields none', () => {
    const acme = path.join(mac.claudeDir, 'plugins/cache/mp/link/1.0.0');
    const outside = path.join(makeHome(), 'keys.json');
    put(outside, JSON.stringify({ s: { command: 'x', env: { K: 'sk-outside-1234567890' } } }));
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'link', mcpServers: './servers.json' }));
    fs.symlinkSync(outside, path.join(acme, 'servers.json'));
    expect(readServers(bareHomes(), [{ name: 'link', installPath: acme }])).toEqual({ servers: [], unreadable: [path.join(acme, '.claude-plugin/plugin.json')] });
  });

  it('a plugin settings.json that cannot be parsed is unreadable, not a config to copy whole', () => {
    put(path.join(acmeWithEnv, 'settings.json'), '{ "env": ');
    const unreadable: string[] = [];
    expect(readPluginConfigs([{ name: 'acme', installPath: acmeWithEnv }], unreadable)).toEqual([]);
    expect(unreadable).toEqual([path.join(acmeWithEnv, 'settings.json')]);
  });

  it('a variable is named by letters, digits and underscores, of any case: needs outside that rule are none', () => {
    expect(needsOf(server('claude', { env: { api_key: '', 'A-B': '', ok_1: '' }, raw: {} }))).toEqual(['api_key', 'ok_1']);
    expect(needsOf(server('codex', { raw: { bearer_token_env_var: 'not a var', env_vars: ['GOOD'] } }))).toEqual(['GOOD']);
  });

  it('a reference is ${NAME} of any case, ${NAME:-} or {env:NAME}: a need, never a secret; a default in one is a value, a secret its reference is left for, its name still a need', () => {
    const s = server('claude', {
      env: { A: '${my_key}', B: '${API_KEY:-fb_fake_1}', C: '{env:oc_key}', D: '${EMPTY:-}' }, headers: { Authorization: 'Bearer ${TOK:-hd_fake_2}' },
      url: 'https://u:${PW:-pw_fake_3}@h.test/mcp?key=${QK:-qk_fake_4}', args: ['--api-key', '${AK:-ak_fake_5}'],
    });
    expect(secretsOf(s).map((f) => [f.field, f.value])).toEqual([
      ['env.B', '${API_KEY:-fb_fake_1}'], ['headers.Authorization', 'Bearer ${TOK:-hd_fake_2}'], ['url.key', '${QK:-qk_fake_4}'], ['url.userinfo', 'u:${PW:-pw_fake_3}'],
      ['args[--api-key]', '${AK:-ak_fake_5}'],
    ]);
    expect(needsOf(s)).toEqual(['AK', 'API_KEY', 'EMPTY', 'PW', 'QK', 'TOK', 'my_key', 'oc_key']);
    expect(redacted(s, new Set())).toMatchObject({
      env: { A: '${my_key}', B: '${API_KEY}', C: '{env:oc_key}', D: '${EMPTY:-}' }, headers: { Authorization: 'Bearer ${TOK}' },
      url: 'https://u:${PW}@h.test/mcp?key=${QK}', args: ['--api-key', '${AK}'],
    });
    const doc = { model_providers: { g: { http_headers: { 'X-Key': '${CX:-cx_fake_6}' } } } };
    expect(configSecrets('codex', doc).map((f) => f.field)).toEqual(['model_providers.g.http_headers.X-Key']);
    expect(configRedacted(doc, ['model_providers.g.http_headers.X-Key'])).toEqual({ model_providers: { g: { http_headers: { 'X-Key': '${CX}' } } } });
    const list = { x: { source: { source: 'url', url: 'https://x.test/m.json', headers: { Authorization: 'Bearer ${GH:-mh_fake_7}' } } } };
    expect(marketplaceList(list, new Set())).toEqual({ doc: { x: { source: { ...list.x.source, headers: { Authorization: 'Bearer ${GH}' } } } }, kept: false });
    expect(keyedLsp({ go: { command: 'gopls', env: { T: '${T:-lsp_fake_8}' } }, ts: { command: 'tsls', env: { T: '${T:-}' } } })).toEqual(['go']);
  });

  it('KEY=value in an arg holds a key where KEY is upper case or names one; another name=value does not', () => {
    const s = server('claude', { args: ['mode=fast', '--log=level=debug', 'db_url=postgres://h/db', 'api_token=tk_fake_1', '--env=Api_Token=tk_fake_2', 'DB_URL=postgres://h/db'] });
    expect(secretsOf(s).map((f) => [f.field, f.value])).toEqual([['args[api_token]', 'tk_fake_1'], ['args[Api_Token]', 'tk_fake_2'], ['args[DB_URL]', 'postgres://h/db']]);
    expect(redacted(s, new Set()).args).toEqual(['mode=fast', '--log=level=debug', 'db_url=postgres://h/db', 'api_token=', '--env=Api_Token=', 'DB_URL=']);
  });

  it('a URL\'s userinfo runs to its last @ before the host, and a password with no user is a credential: in a server url, an arg and a config string, all emptied', () => {
    const s = server('claude', { url: 'redis://:pw_fake_1@cache.test:6379', args: ['https://:pat_fake_2@dev.azure.com/x', 'https://user:p@ssw0rd_fake@host.test/x'] });
    expect(secretsOf(s).map((f) => f.value)).toEqual([':pw_fake_1', ':pat_fake_2', 'user:p@ssw0rd_fake']);
    expect(redacted(s, new Set())).toMatchObject({ url: 'redis://cache.test:6379', args: ['https://dev.azure.com/x', 'https://host.test/x'] });
    const doc = { feed: 'redis://:pw_fake_1@cache.test', mirror: 'https://user:p@ssw0rd_fake@host.test/x' };
    expect(configSecrets('codex', doc).map((f) => [f.field, f.value])).toEqual([['feed.userinfo', ':pw_fake_1'], ['mirror.userinfo', 'user:p@ssw0rd_fake']]);
    expect(configRedacted(doc, ['feed.userinfo', 'mirror.userinfo'])).toEqual({ feed: 'redis://cache.test', mirror: 'https://host.test/x' });
    expect(withoutCredentials('git clone https://:pat_fake_2@dev.azure.com/o/r.git https://u:p@ssw0rd_fake@b.test/r')).toBe('git clone https://dev.azure.com/o/r.git https://b.test/r');
  });

  it('a project server outside the Mac\'s home is read, for the worker to say whether it has that folder', () => {
    expect(readServers(mac, []).servers.find((s) => s.name === 'other')).toMatchObject({ scope: { project: '/opt/elsewhere' } });
  });

  it.each([
    ['providers.*.headers.*', { providers: { p: { headers: { Authorization: 'Bearer oc_fake_1' } } } }, 'providers.p.headers.Authorization'],
    ['providers.*.body.**', { providers: { p: { body: { auth: { token: 'oc_fake_2' }, n: 1 } } } }, 'providers.p.body.auth.token'],
    ['providers.*.models.*.headers.*', { providers: { p: { models: { m: { headers: { 'X-Key': 'oc_fake_3' } } } } } }, 'providers.p.models.m.headers.X-Key'],
    ['providers.*.models.*.body.**', { providers: { p: { models: { m: { body: { keys: ['oc_fake_4'] } } } } } }, 'providers.p.models.m.body.keys.0'],
    ['provider.*.models.*.headers.*', { provider: { p: { models: { m: { headers: { Authorization: 'Bearer oc_fake_5' } } } } } }, 'provider.p.models.m.headers.Authorization'],
    ['agents.*.request.headers.*', { agents: { a: { request: { headers: { 'X-Key': 'oc_fake_6' } } } } }, 'agents.a.request.headers.X-Key'],
    ['agents.*.request.body.**', { agents: { a: { request: { body: { secret: 'oc_fake_7' } } } } }, 'agents.a.request.body.secret'],
    ['agent.*.options.** by name', { agent: { a: { options: { apiKey: 'oc_fake_8', mode: 'fast' } } } }, 'agent.a.options.apiKey'],
    ['agents.*.options.** by name', { agents: { a: { options: { auth: { token: 'oc_fake_9' }, mode: 'fast' } } } }, 'agents.a.options.auth.token'],
    ['providers.*.models.*.variants.*.headers.*', { providers: { p: { models: { m: { variants: [{ id: 'v', headers: { Authorization: 'Bearer oc_fake_10' } }] } } } } }, 'providers.p.models.m.variants.0.headers.Authorization'],
    ['providers.*.models.*.variants.*.body.**', { providers: { p: { models: { m: { variants: [{ id: 'v', body: { auth: { key: 'oc_fake_11' } } }] } } } } }, 'providers.p.models.m.variants.0.body.auth.key'],
    ['providers.*.settings.** by name', { providers: { p: { settings: { apiKey: 'oc_fake_12', region: 'eu' } } } }, 'providers.p.settings.apiKey'],
    ['providers.*.models.*.settings.** by name', { providers: { p: { models: { m: { settings: { token: 'oc_fake_13', temperature: 'low' } } } } } }, 'providers.p.models.m.settings.token'],
    ['providers.*.models.*.variants.*.settings.** by name', { providers: { p: { models: { m: { variants: [{ id: 'v', settings: { secret: 'oc_fake_14' } }] } } } } }, 'providers.p.models.m.variants.0.settings.secret'],
  ])('an OpenCode key at %s is a secret field of opencode:config, emptied unless ticked', (_, doc, field) => {
    expect(configSecrets('opencode', doc).map((f) => f.field)).toEqual([field]);
    expect(JSON.stringify(configRedacted(doc, [field]))).not.toContain('oc_fake');
  });

  it('Codex keys in a provider\'s base_url query, an otel endpoint\'s query and a provider\'s auth args are secret fields of codex:config, emptied unless ticked', () => {
    const doc = {
      model_providers: { g: { base_url: 'https://u:p_fake@g.test/v1?key=cx_fake_1', auth: { command: 'helper', args: ['--secret', 'cx_fake_2', '--org=acme', 'https://x.test/t?token=cx_fake_3'] } } },
      otel: { exporter: { 'otlp-http': { endpoint: 'https://o.test/v1?api_key=cx_fake_4' } } },
    };
    const fields = configSecrets('codex', doc).map((f) => f.field);
    expect([...fields].sort()).toEqual([
      'model_providers.g.auth.args[--secret]', 'model_providers.g.auth.args[https://x.test].token', 'model_providers.g.base_url.key', 'model_providers.g.base_url.userinfo',
      'otel.exporter.otlp-http.endpoint.api_key',
    ]);
    expect(configRedacted(doc, fields)).toEqual({
      model_providers: { g: { base_url: 'https://g.test/v1?key=', auth: { command: 'helper', args: ['--secret', '', '--org=acme', 'https://x.test/t?token='] } } },
      otel: { exporter: { 'otlp-http': { endpoint: 'https://o.test/v1?api_key=' } } },
    });
    expect(configPlace(doc, 'model_providers.g.auth.args[--secret]')).toEqual([['model_providers', 'g', 'auth', 'args', '1']]);
  });

  it('an arg field is named by the secret flag or header before it, its own --flag= or KEY=, or its URL\'s scheme and host; by its index only where nothing names it', () => {
    const s = server('claude', { args: [
      '--db-password', 'db_fake_1', '--api-key=ak_fake_2', 'DB_URL=postgres://u:p@h/db', '-H', 'X-Key: hk_fake_3', 'https://u:uk_fake_4@x.test/mcp?key=qk_fake_5',
      '--header=Authorization: Bearer hb_fake_6', 'run.sh', '--db-password', 'db_fake_7',
    ] });
    expect(secretsOf(s).map((f) => f.field)).toEqual([
      'args[--db-password]', 'args[--api-key]', 'args[DB_URL]', 'args[-H X-Key]', 'args[https://x.test].key', 'args[https://x.test].userinfo', 'args[--header Authorization]', 'args[--db-password]',
    ]);
    expect(fieldPlace('claude', s.raw, 'args[https://x.test].key')).toEqual([['args', 6]]);
    expect(fieldPlace('opencode', { command: ['cmd', '--token', 'tk_fake_1'] }, 'args[--token]')).toEqual([['command', 2]]);
    expect(secretsOf(server('claude', { args: ['run.sh', 'x'] }))).toEqual([]);
  });

  it('a tick follows its arg\'s name: an arg ticked by name keeps its tick after the Mac reorders its args, and a value now at a ticked arg\'s old index stays unticked', () => {
    const after = server('claude', { args: ['--db-password', 'db_fake_1', '--token', 'tk_fake_2'] });
    expect(redacted(after, new Set(['args[--token]'])).args).toEqual(['--db-password', '', '--token', 'tk_fake_2']);
    expect(redacted(after, new Set(['args[1]'])).args).toEqual(['--db-password', '', '--token', '']);
  });

  it('every arg of one name is one field, ticked or not as a whole as an env key is, in a server and in a config\'s args', () => {
    const s = server('claude', { args: ['--token', 'tk_fake_1', '--token', 'tk_fake_2', '--key', 'k_fake_3'] });
    expect(secretsOf(s).map((f) => f.field)).toEqual(['args[--token]', 'args[--token]', 'args[--key]']);
    expect(redacted(s, new Set(['args[--token]'])).args).toEqual(['--token', 'tk_fake_1', '--token', 'tk_fake_2', '--key', '']);
    expect(redacted(s, new Set()).args).toEqual(['--token', '', '--token', '', '--key', '']);
    expect(fieldPlace('claude', s.raw, 'args[--token]')).toEqual([['args', 1], ['args', 3]]);
    const doc = { model_providers: { g: { auth: { command: 'helper', args: ['--secret', 'cx_fake_1', '--secret', 'cx_fake_2'] } } } };
    expect(configPlace(doc, 'model_providers.g.auth.args[--secret]')).toEqual([['model_providers', 'g', 'auth', 'args', '1'], ['model_providers', 'g', 'auth', 'args', '3']]);
    expect(configRedacted(doc, ['model_providers.g.auth.args[--secret]']).model_providers).toEqual({ g: { auth: { command: 'helper', args: ['--secret', '', '--secret', ''] } } });
  });

  it('a marketplace url\'s query values in settings.json are key fields of claude:settings, emptied there and in the marketplace list unless ticked', () => {
    const url = 'https://gl.test/api/v4/raw/marketplace.json?private_token=glpat_fake_1234567890';
    const doc = { extraKnownMarketplaces: { gl: { source: { source: 'url', url } } } };
    const field = 'extraKnownMarketplaces.gl.source.url.private_token';
    expect(configSecrets('claude', doc)).toEqual([{ field, value: 'glpat_fake_1234567890' }]);
    expect(configRedacted(doc, [field]).extraKnownMarketplaces).toEqual({ gl: { source: { source: 'url', url: 'https://gl.test/api/v4/raw/marketplace.json?private_token=' } } });
    const list = { gl: { source: { source: 'url', url }, installLocation: '/x' } };
    expect(marketplaceList(list, new Set()).doc.gl).toEqual({ source: { source: 'url', url: 'https://gl.test/api/v4/raw/marketplace.json?private_token=' }, installLocation: '/x' });
    expect(marketplaceList(list, new Set([field]))).toEqual({ doc: list, kept: true });
  });

  it('a subagent\'s frontmatter naming mcpServers anywhere the mirror does not read, a quoted or a second key, lists the file whole', () => {
    const md = (...l: string[]) => ['---', ...l, '---', 'b', ''].join('\n');
    expect(agentKeys(md('"mcpServers":', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: quoted_fake_1'))).toEqual(['mcpServers']);
    expect(agentKeys(md('mcpServers: [github]', 'name: d', 'mcpServers:', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: dup_fake_2'))).toEqual(['mcpServers']);
    expect(agentKeys(md('name: d', 'mcpServers: [github]'))).toEqual([]);
    expect(agentKeys(md('"mcp\\u0053ervers":', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: esc_fake_3'))).toEqual(['mcpServers']);
    for (const key of ['"mcp\\x53ervers":', '"mcp\\U00000053ervers":']) expect(agentKeys(md(key, '  pg:', '    command: npx', '    env:', '      P: esc_fake_4'))).toEqual(['mcpServers']);
    for (const key of ['? "mcpServers"', '? "mcp\\u0053ervers"']) expect(agentKeys(md(key, ':', '  pg:', '    command: npx', '    env:', '      P: esc_fake_5'))).toEqual(['mcpServers']);
    const srv = (ind: string) => [`${ind}  pg:`, `${ind}    command: npx`, `${ind}    env:`, `${ind}      P: esc_fake_6`];
    expect(agentKeys(md(' name: db', ' "mcp\\u0053ervers":', ...srv(' ')))).toEqual(['mcpServers']);
    expect(agentKeys(md(' name: db', ' ? "mcp\\u0053ervers"', ' :', ...srv(' ')))).toEqual(['mcpServers']);
    expect(agentKeys(md('{"name": "db", "mcp\\u0053ervers": {"pg": {"command": "npx", "env": {"P": "esc_fake_7"}}}}'))).toEqual(['mcpServers']);
    expect(agentKeys(md('name: db', 'description: "say \\"hi\\""'))).toEqual([]);
  });

  it('a key in an arg\'s JSON by its name, after --headers or -H and a header\'s name, after -k, --pat or --oauth2Bearer, and an auth scheme\'s credential are secrets, and are emptied', () => {
    const s = server('claude', { args: [
      '--config', '{"githubPersonalAccessToken":"ghp_fake_1","owner":"ada","nested":{"keys":["k_fake_2"]},"ref":"${GH}","token":"${GH_TOKEN}","apiKey":"${AK:-ak_fake_3}"}',
      '--headers', 'X-Api-Key', 'xk_fake_4', '-H', 'Authorization', 'Bearer sk_fake_5', '-k', 'k_fake_6', '--pat', 'pat_fake_7', '--oauth2Bearer', 'ob_fake_8',
      '--extra', 'X-Auth: Token tk_fake_9', '--opts={"h":"Basic b_fake_10","mode":"fast"}', '--servers', '[{"name":"gh","apiKey":"ak_fake_11"}]', '--name', 'Token', 'Bearer ${TOKEN_2}',
    ] });
    expect(secretsOf(s).map((f) => [f.field, f.value])).toEqual([
      ['args[--config].githubPersonalAccessToken', 'ghp_fake_1'], ['args[--config].nested.keys.0', 'k_fake_2'], ['args[--config].apiKey', '${AK:-ak_fake_3}'],
      ['args[--headers X-Api-Key]', 'xk_fake_4'], ['args[-H Authorization]', 'Bearer sk_fake_5'], ['args[-k]', 'k_fake_6'], ['args[--pat]', 'pat_fake_7'],
      ['args[--oauth2Bearer]', 'ob_fake_8'], ['args[--extra]', 'tk_fake_9'], ['args[--opts].h', 'Basic b_fake_10'], ['args[--servers].0.apiKey', 'ak_fake_11'],
    ]);
    const bare = redacted(s, new Set());
    expect(bare.args).toEqual([
      '--config', '{"githubPersonalAccessToken":"","owner":"ada","nested":{"keys":[""]},"ref":"${GH}","token":"${GH_TOKEN}","apiKey":"${AK}"}', '--headers', 'X-Api-Key', '',
      '-H', 'Authorization', '', '-k', '', '--pat', '', '--oauth2Bearer', '', '--extra', 'X-Auth: Token ', '--opts={"h":"","mode":"fast"}', '--servers', '[{"name":"gh","apiKey":""}]',
      '--name', 'Token', 'Bearer ${TOKEN_2}',
    ]);
    // the worker's report finds each key where the emptied copy holds it
    for (const f of new Set(secretsOf(s).map((x) => x.field))) expect(fieldPlace('claude', bare, f)).toEqual(fieldPlace('claude', s.raw, f));
    expect((redacted(s, new Set(['args[--config].githubPersonalAccessToken'])).args as string[])[1]).toContain('"githubPersonalAccessToken":"ghp_fake_1"');
    expect(secretsOf(server('claude', { args: ['--config', `${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}`] }))).toEqual([]);
  });

  it('prose that names an auth scheme, a host after -H and a flag after a header\'s name are no keys', () => {
    expect(secretsOf(server('claude', { args: [
      '--description', 'Issue a token for each user', '--mode', 'basic search', '--title', 'Token Bucket', '-e', "fetch(u,{headers:{Authorization:'Bearer '+process.env.T}})",
      '--config', '{"instructions":"Use basic formatting"}', '-H', 'localhost', '-P', '3306', '-H', 'buildhost', 'run', '--headers', 'X-Trace', '--verbose',
    ] }))).toEqual([]);
  });

  it('a server that runs a shell\'s -c script, which Svall cannot read for keys, is not known, so it travels only as it is', () => {
    put(path.join(bare, '.claude.json'), JSON.stringify({ mcpServers: {
      sh: { command: 'sh', args: ['-c', 'npx srv --token tk_fake_1'] }, bash: { command: '/bin/bash', args: ['--norc', '-lc', 'srv'] },
      env: { command: 'env', args: ['K=v', 'zsh', '-c', 'srv'] }, fish: { command: 'fish', args: ['--command', 'srv --token tk_fake_2'] },
      plain: { command: 'npx', args: ['srv', '-c', 'conf.json'] },
    } }));
    put(path.join(oc, 'opencode.json'), JSON.stringify({ mcp: { servers: { oc: { type: 'local', command: ['fish', '-c', 'srv'] } } } }));
    expect(readServers(bareHomes(), []).servers.map((s) => [s.name, s.known])).toEqual([['sh', false], ['bash', false], ['env', false], ['fish', false], ['plain', true], ['oc', false]]);
  });

  it('a URL path segment shaped as a token is a key, in a server\'s url and in an arg, and is emptied; a slug, a version or a reference is not', () => {
    const zapier = 'https://mcp.zapier.com/api/mcp/s/ZjQ2YzE1NDItODg3Zi00_fake1/mcp?path=/workspace';
    const s = server('claude', { url: zapier, args: ['-y', 'mcp-remote', 'https://mcp.pipedream.net/3fa85f64-5717-4562-b3fc-2c963f66afa6/gmail'] });
    expect(secretsOf(s)).toEqual([
      { field: 'url.path', value: 'ZjQ2YzE1NDItODg3Zi00_fake1' }, { field: 'args[https://mcp.pipedream.net].path', value: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
    ]);
    expect(redacted(s, new Set())).toMatchObject({ url: 'https://mcp.zapier.com/api/mcp/s//mcp?path=/workspace', args: ['-y', 'mcp-remote', 'https://mcp.pipedream.net//gmail'] });
    expect(redacted(s, new Set(['url.path'])).url).toBe(zapier);
    expect(redacted(server('claude', { url: 'https://h.test/ZjQ2YzE1NDItODg3Zi00_fake1/3fa85f64-5717-4562-b3fc-2c963f66afa6/mcp' }), new Set()).url).toBe('https://h.test///mcp');
    const nested = server('claude', { url: 'https://p.test/https://api.test/ZjQ2YzE1NDItODg3Zi00_fake1/mcp' });
    expect([secretsOf(nested).map((f) => f.field), redacted(nested, new Set()).url]).toEqual([['url.path'], 'https://p.test/https://api.test//mcp']);
    expect(secretsOf(server('claude', { url: 'https://gitmcp.io/my-awesome-project-2025/v1.2.3-beta.20251030/${ZAPIER_KEY}/mcp' }))).toEqual([]);
  });

  it('a URL query value is a key by its name or a token\'s shape, in a URL inside JSON or a list too, a Codex query param as a URL\'s is, and a string in an OpenCode request body by its name; the rest travel as they are', () => {
    const s = server('claude', {
      url: 'https://x.test/mcp?referrer_ide=vscode&plugin_version=1.2.3&api_key=ak_fake_1&session=3fa85f64-5717-4562-b3fc-2c963f66afa6&pwd=pw_fake&sig=sg_fake&id=abc12345def6789xyz1&ref=abc12345def6789xyz12',
      args: [
        '--config', '{"endpoint":"https://h.test/sse?customerId=c8f2a91b7d3e4f60a1b2","other":"https://o.test/x?api_key=ak_fake_2","mode":"fast"}',
        '--endpoints=https://a.test/x?sid=c8f2a91b7d3e4f60a1b2,https://b.test/y',
      ],
    });
    expect(secretsOf(s).map((f) => f.field)).toEqual([
      'url.api_key', 'url.session', 'url.pwd', 'url.sig', 'url.ref', 'args[--config].customerId', 'args[--config].api_key', 'args[https://a.test].sid',
    ]);
    expect(redacted(s, new Set())).toMatchObject({
      url: 'https://x.test/mcp?referrer_ide=vscode&plugin_version=1.2.3&api_key=&session=&pwd=&sig=&id=abc12345def6789xyz1&ref=',
      args: ['--config', '{"endpoint":"https://h.test/sse?customerId=","other":"https://o.test/x?api_key=","mode":"fast"}', '--endpoints=https://a.test/x?sid=,https://b.test/y'],
    });
    const oc = { providers: { vercel: { body: { providerOptions: { gateway: { order: ['anthropic'] } }, reasoningEffort: 'high', apiKey: 'oc_fake_1' } } } };
    expect(configSecrets('opencode', oc).map((f) => f.field)).toEqual(['providers.vercel.body.apiKey']);
    expect(configRedacted(oc, ['providers.vercel.body.apiKey'])).toEqual({ providers: { vercel: { body: { ...oc.providers.vercel.body, apiKey: '' } } } });
    const codex = { model_providers: { azure: { base_url: 'https://a.openai.azure.com/openai?api-version=2025-04-01-preview', query_params: { 'api-version': '2025-04-01-preview', 'api-key': 'az_fake_1' } } } };
    expect(configSecrets('codex', codex).map((f) => f.field)).toEqual(['model_providers.azure.query_params.api-key']);
  });
});

describe('readMirrorVars', () => {
  it('reads the recorded names, dropping any that are not variable names, and nothing when the file is absent or malformed', () => {
    const dir = makeHome();
    expect(readMirrorVars(path.join(dir, 'none.json'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(readMirrorVars(path.join(dir, 'bad.json'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(['GAMMA_TOKEN', 'lower', 'A B', 7, '_X1', '1X']));
    expect(readMirrorVars(path.join(dir, 'ok.json'))).toEqual(['GAMMA_TOKEN', 'lower', '_X1']);
  });
});
