import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configNeeds, configSecrets, FIELD_PATHS, isMacOnly, isOAuth, needsOf, oauthLogin, readPluginConfigs, readPlugins, readServers, redacted,
  relocatedServer, runtimesOf, secretsOf, type McpServer,
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
      ['claude', 'pdf', { plugin: 'acme' }], ['codex', 'github', 'user'], ['opencode', 'ctx', 'user'], ['opencode', 'far', 'user'],
    ]);
    expect([...listed, ...unreadable]).toEqual([]);
  });

  it('finds secrets by field and references as needs; a value that is both is both', () => {
    const s = server('claude', { env: { API_KEY: 'sk-live-1234567890ab', REF: '${OTHER}', DB: 'postgres://u:s3cret@${DB_HOST}/db' }, headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' }, url: 'https://x.test/sse?key=abc', args: ['--github-token', 't0k3n', 'DB_URL=postgres://u:p@h/db', '--port=3334', 'mysql://a:b@h/x'] });
    expect(secretsOf(s).map((f) => f.field).sort()).toEqual(['args[1]', 'args[2]', 'args[4].userinfo', 'env.API_KEY', 'env.DB', 'url.key']);
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
    expect(isMacOnly(server('claude', { url: 'http://127.0.0.1:3845/sse' }))).toBe(true);
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
    expect(readPluginConfigs([{ name: 'acme', installPath: acmeWithEnv }])).toEqual([{ name: 'acme', file: path.join(acmeWithEnv, 'settings.json'), fields: ['env', 'model'] }]);
    expect(readServers(withJsonc('{ // c\n "mcp": {} }'), []).unreadable).toEqual([]);
    expect(readServers(withJsonc('{ "mcp": '), []).unreadable).toEqual([path.join(oc, 'opencode.jsonc')]);
    const plain = path.join(bare, 'plain');
    put(path.join(plain, 'settings.json'), JSON.stringify({ hooks: {}, model: 'opus', env: { K: '${K}' } }));
    expect(readPluginConfigs([{ name: 'plain', installPath: plain }])).toEqual([]);
  });

  it('as the pinned agents keep them: an OAuth client secret and an mcp-remote --header value are secrets, header auth is no OAuth, Codex env_vars by name, a plugin\'s own variables no needs, and a login by the agent\'s own subcommand', () => {
    const codex = server('codex', { url: 'https://mcp.linear.app/mcp', raw: { oauth: { client_id: 'cid', client_secret: 'cs-1' } } });
    expect(secretsOf(codex)).toEqual([{ field: 'oauth.client_secret', value: 'cs-1' }]);
    expect(redacted(codex, new Set())).toEqual({ url: 'https://mcp.linear.app/mcp', oauth: { client_id: 'cid', client_secret: '' } });
    const header = server('claude', { command: 'npx', args: ['mcp-remote', 'https://mcp.linear.app/sse', '--header', 'Authorization: Bearer sk-1'] });
    expect(secretsOf(header)).toEqual([{ field: 'args[3]', value: 'Bearer sk-1' }]);
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
    expect(secretsOf(q)).toEqual([{ field: 'args[2].api_key', value: 'sk-live-123' }]);
    expect(redacted(q, new Set()).args).toEqual(['-y', 'mcp-remote', 'https://server.test/x/mcp?api_key=&profile=${PROFILE}']);
    const u = server('claude', { url: 'https://tok-1@x.test/mcp', args: ['--from', 'git+https://ghp_tok@github.com/o/r.git', '--mirrors=https://u:p@a.test,https://v:q@b.test', 'https://${GH_TOKEN}@github.com/o', 'ssh://git@github.com/o', 'postgres://user@h/db'] });
    expect(secretsOf(u)).toEqual([
      { field: 'url.userinfo', value: 'tok-1' }, { field: 'args[1].userinfo', value: 'ghp_tok' }, { field: 'args[2].userinfo', value: 'u:p' }, { field: 'args[2].userinfo', value: 'v:q' },
    ]);
    expect(needsOf(u)).toEqual(['GH_TOKEN']);
    expect(redacted(u, new Set())).toMatchObject({ url: 'https://x.test/mcp', args: ['--from', 'git+https://github.com/o/r.git', '--mirrors=https://a.test,https://b.test', 'https://${GH_TOKEN}@github.com/o', 'ssh://git@github.com/o', 'postgres://user@h/db'] });
    expect(configSecrets('codex', { feeds: 'https://a:1@x.test https://tok@y.test' }).map((f) => [f.field, f.value])).toEqual([['feeds.userinfo', 'a:1'], ['feeds.userinfo', 'tok']]);
  });

  it('a secret flag ends in a word of any case: --githubToken and --access_token too', () => {
    expect(secretsOf(server('claude', { args: ['--githubToken', 'g1', '--access_token=a1', '--monkey', 'm1'] })).map((f) => f.field)).toEqual(['args[1]', 'args[2]']);
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
});
