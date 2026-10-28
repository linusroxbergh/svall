import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind, SetupRow } from '@svall/protocol';
import { silentLogger } from '../../src/log.js';
import { fieldKey, readConsent, setConsent } from '../../src/placement/mirror-consent.js';
import { mirrorPlan } from '../../src/placement/mirror-plan.js';
import { configReport, forRobot, reportAsk, setupRows, type ConfigReport } from '../../src/placement/mirror-report.js';
import { Mirror } from '../../src/placement/mirror.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { editJson, farHome, macHome, put } from './mirror-homes.js';
import { W, world } from './world.js';

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  vi.unstubAllEnvs();
  cleanHomes();
});

const O = { machine: 'w1', fleetFlag: '', unchecked: 'not checked: w1 is not reachable', overrides: '~/.svall/mirror-overrides' };
const SAVED = 'not checked: w1 is not reachable; saved, and takes effect when w1 links';
const byKey = (key: string) => (r: SetupRow) => r.key === key;
const report = (o: Partial<ConfigReport> = {}): ConfigReport => ({ commands: {}, vars: {}, secrets: {}, whole: {}, oauth: {}, ...o });
const executable = (file: string) => { put(file, '#!/bin/sh\n'); fs.chmodSync(file, 0o755); };

describe('the setup rows of the mirror', () => {
  let mac: ReturnType<typeof macHome>;
  beforeEach(() => { mac = macHome(); });
  const rows = (r: ConfigReport | undefined, consent = new Set<string>(), o = O) => setupRows(mirrorPlan(mac, consent), r, o);
  // the row of `key` with every field of its item ticked, or none, by a report or, `unchecked`, none
  const row = (key: string, o: { ticked: boolean; secrets?: ConfigReport['secrets']; whole?: ConfigReport['whole']; unchecked?: true }) => {
    const fields = rows(undefined).find(byKey(key))!.tick!.fields;
    const r = o.unchecked ? undefined : report({ secrets: o.secrets ?? {}, whole: o.whole ?? {} });
    return rows(r, new Set(o.ticked ? fields.map((f) => fieldKey(key, f)) : [])).find(byKey(key));
  };

  it('a ticked and copied server is ok with its masked keys; unticked asks to copy them with the overrides folder in details; the worker\'s own is ok', () => {
    expect(row('claude:mcp:linear', { ticked: true, secrets: { 'claude:mcp:linear#env.LINEAR_API_KEY': 'copied' } }))
      .toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.LINEAR_API_KEY lin…90', tick: { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true } });
    expect(row('claude:mcp:linear', { ticked: false, secrets: {} }))
      .toMatchObject({
        status: 'warn', action: "copy linear's keys to w1",
        detail: 'copied without its keys (env.LINEAR_API_KEY lin…90); tick to copy them, set LINEAR_API_KEY on w1 (svall worker env LINEAR_API_KEY), or set them in ~/.svall/mirror-overrides there',
      });
    expect(row('claude:mcp:linear', { ticked: false, secrets: { 'claude:mcp:linear#env.LINEAR_API_KEY': 'own' } })).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
  });

  it('an unticked server env key is the worker\'s own once its daemon has the variable, with no row of its own for the variable; a header key is not, and names the fleet\'s overrides folder', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.hdr = { type: 'http', url: 'https://hdr.test/mcp', headers: { 'X-Key': 'hdr_key_1234567890' } }; });
    const all = rows(report({ vars: { LINEAR_API_KEY: true } }), new Set(), { ...O, fleetFlag: '-p work ', overrides: '~/.svall-work/mirror-overrides' });
    expect(all.find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    expect(all.find(byKey('var:LINEAR_API_KEY'))).toBeUndefined();
    expect(all.find(byKey('claude:mcp:hdr'))).toMatchObject({ status: 'warn', detail: 'copied without its keys (headers.X-Key hdr…90); tick to copy them, or set them on w1 in ~/.svall-work/mirror-overrides' });
    expect(rows(report({ vars: { LINEAR_API_KEY: false } })).find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'warn', action: "copy linear's keys to w1" });
  });

  it('an unticked env key holding a reference with a default asks for the variable that reference reads, and is the worker\'s own once it has it', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = '${LIN_KEY:-lin_fake_1234567890}'; });
    expect(rows(report({ vars: { LINEAR_API_KEY: true } })).find(byKey('claude:mcp:linear'))).toMatchObject({
      status: 'warn', detail: 'copied without its keys (env.LINEAR_API_KEY ${L…0}); tick to copy them, set LIN_KEY on w1 (svall worker env LIN_KEY), or set them in ~/.svall/mirror-overrides there',
    });
    expect(rows(report({ vars: { LIN_KEY: true } })).find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
  });

  it('an unticked server whose keys the worker still holds as the copy says they are still on w1, to check again', () => {
    expect(row('claude:mcp:linear', { ticked: false, secrets: { 'claude:mcp:linear#env.LINEAR_API_KEY': 'copied' } }))
      .toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'still on w1; check w1 again', tick: { on: false }, gap: { name: 'linear', what: 'unticked; still on w1' } });
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    expect(row('claude:plugin:acme', { ticked: false, whole: { 'claude:plugin:acme': true } })).toMatchObject({ gap: { name: "acme's config", what: 'unticked; still on w1' } });
  });

  it('a ticked server not yet copied says pushed, not yet on w1; one whose keys the worker holds as its own is ok', () => {
    expect(row('claude:mcp:linear', { ticked: true, secrets: {} })).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'sent; not on w1 yet' });
    expect(row('claude:mcp:linear', { ticked: true, secrets: { 'claude:mcp:linear#env.LINEAR_API_KEY': 'own' } })).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
  });

  it('a ${VAR} the worker lacks is "set VAR on w1" with svall worker env VAR, under the fleet\'s flag; one it has is ok', () => {
    expect(rows(report({ vars: { REMOTE_TOKEN: false } })).find(byKey('var:REMOTE_TOKEN')))
      .toMatchObject({ status: 'warn', action: 'set REMOTE_TOKEN on w1', run: 'svall worker env REMOTE_TOKEN', detail: "remote reads REMOTE_TOKEN, which is not set on w1" });
    expect(rows(report({ vars: {} }), new Set(), { ...O, fleetFlag: '-p work ' }).find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ run: 'svall -p work worker env REMOTE_TOKEN' });
    expect(rows(report({ vars: { REMOTE_TOKEN: true } })).find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'ok', detail: 'REMOTE_TOKEN is set on w1' });
  });

  it('a missing npx is "install npx on w1"; a Mac-only server is skipped and listed; a known-host remote is a login row running claude on its fixed sign-in port; config.toml is one row for its key fields', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    const all = rows(report({ commands: { node: true, npx: false } }));
    expect(all.find(byKey('runtime:npx'))).toMatchObject({ status: 'warn', action: 'install npx on w1', run: 'sudo apt install nodejs npm', detail: 'linear, empty, github need it' });
    expect(all.find(byKey('runtime:node'))).toBeUndefined();
    expect(all.find(byKey('maconly:claude:chrome'))).toMatchObject({ status: 'skip', detail: 'chrome only runs on a Mac; not mirrored' });
    expect(all.find(byKey('oauth:claude:mcp:notion'))).toMatchObject({ status: 'warn', action: 'log in once on w1', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118, detail: 'then /mcp and sign in to notion' });
    expect(rows(report({ oauth: { 'claude:mcp:notion': true } })).find(byKey('oauth:claude:mcp:notion'))).toMatchObject({ status: 'ok', detail: 'logged in on w1' });
    expect(all.filter(byKey('codex:config'))).toMatchObject([{ status: 'warn', action: "copy config.toml's keys to w1", tick: { item: 'codex:config', on: false } }]);
  });

  it('a command under the Mac\'s home is "install <name> on w1" naming its path; an OpenCode login is skipped with its command; the rows come in their order', () => {
    const db = path.join(mac.homedir, '.local/bin/db-mcp');
    put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ mcp: { servers: { sentry: { type: 'remote', url: 'https://mcp.sentry.dev/mcp' } } } }));
    const all = rows(report({ commands: { [db]: false, bun: false }, vars: { REMOTE_TOKEN: true } }));
    expect(all.find(byKey(`runtime:${db}`))).toEqual({
      key: `runtime:${db}`, status: 'warn', action: 'install db-mcp on w1', detail: `db runs ${db}, which w1 does not have; a path under this Mac's home is looked for under w1's`,
      gap: { name: 'db-mcp', what: 'not installed; db needs it' },
    });
    expect(all.find(byKey('oauth:opencode:mcp:sentry')))
      .toEqual({
        key: 'oauth:opencode:mcp:sentry', status: 'skip', run: 'opencode mcp auth sentry', detail: 'log in once on w1; the row stays either way: opencode mcp auth sentry',
        gap: { name: 'sentry', what: 'log in once there; the row stays' },
      });
    const kinds = all.map((r) => r.key.replace(/^(var|oauth|runtime|maconly|unreadable):.*$/, '$1').replace(/^.*:mcp:.*$/, 'server').replace(/^.*:(config|settings)$/, 'config'));
    expect(kinds.filter((k, i) => k !== kinds[i - 1])).toEqual(['server', 'var', 'oauth', 'runtime', 'maconly', 'config']);
  });

  it('a server with settings Svall cannot copy one by one is one row to copy it as it is, and the only one; a plugin\'s config too; a file that cannot be read is to set up by hand', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { K: '${ODD_VAR}' }, sandbox: { token: 'odd_token_1234567890' } }; });
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    const toml = path.join(mac.codexDir, 'config.toml');
    put(toml, 'model = [');
    const all = rows(report({ commands: { odd: false } }));
    expect(all.filter((r) => /(^|:)(odd|ODD_VAR)$/.test(r.key))).toEqual([{
      key: 'claude:mcp:odd', status: 'warn', action: 'copy odd to w1 as it is', detail: 'odd has settings Svall cannot copy one by one; tick to copy its file as it is, keys included',
      tick: { item: 'claude:mcp:odd', fields: ['command', 'env', 'sandbox'], on: false, preview: ['command', 'env', 'sandbox'] },
      gap: { name: 'odd', what: 'not copied; tick to copy it as it is' },
    }]);
    expect(row('claude:mcp:odd', { ticked: true, whole: { 'claude:mcp:odd': true } })).toMatchObject({ status: 'ok', detail: 'copied to w1 as it is', tick: { on: true } });
    expect(row('claude:mcp:odd', { ticked: true })).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'sent; not on w1 yet', tick: { on: true } });
    expect(row('claude:mcp:odd', { ticked: true, unchecked: true })).toMatchObject({ status: 'warn', action: 'check w1 again', detail: SAVED });
    expect(all.find(byKey('claude:plugin:acme'))).toEqual({
      key: 'claude:plugin:acme', status: 'warn', action: "copy acme's config to w1 as it is", detail: "acme's config has settings Svall cannot copy one by one; tick to copy its file as it is, keys included",
      tick: { item: 'claude:plugin:acme', fields: ['env'], on: false, preview: ['env'] }, gap: { name: "acme's config", what: 'not copied; tick to copy it as it is' },
    });
    expect(row('claude:plugin:acme', { ticked: true, whole: { 'claude:plugin:acme': true } })).toMatchObject({ status: 'ok', detail: 'copied to w1 as it is' });
    expect(row('claude:plugin:acme', { ticked: true })).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'sent; not on w1 yet' });
    expect(row('claude:plugin:acme', { ticked: true, unchecked: true })).toMatchObject({ status: 'warn', action: 'check w1 again', detail: SAVED });
    expect(all.filter((r) => r.key.startsWith('unreadable:')))
      .toEqual([{
        key: `unreadable:${toml}`, status: 'warn', detail: `${toml} cannot be read as JSON or TOML; set it up on w1 by hand`, gap: { name: 'config.toml', what: 'not copied: this Mac cannot read it' },
      }]);
    expect(all.find(byKey('codex:mcp:github'))).toBeUndefined();
  });

  it('without a report the rows still come, the probe-dependent ones not checked with check w1 again and no runtime rows; a link in mismatch says to upgrade', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    const linear = new Set([fieldKey('claude:mcp:linear', 'env.LINEAR_API_KEY')]);
    const all = rows(undefined, linear);
    expect(all.find(byKey('claude:mcp:linear'))).toMatchObject({ status: 'warn', action: 'check w1 again', detail: SAVED });
    expect(all.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'not checked: w1 is not reachable' });
    expect(all.find(byKey('oauth:claude:mcp:notion'))).toMatchObject({ status: 'warn', action: 'log in once on w1', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude' });
    expect(all.find(byKey('oauth:claude:mcp:notion'))?.gap).toBeUndefined();
    expect(all.find(byKey('codex:mcp:github'))).toMatchObject({
      status: 'warn', action: "copy github's keys to w1",
      detail: `${SAVED}: copied without its keys (env.GITHUB_TOKEN ghp…ef); tick to copy them, set GITHUB_TOKEN on w1 (svall worker env GITHUB_TOKEN), or set them in ~/.svall/mirror-overrides there`,
    });
    expect(all.filter((r) => r.key.startsWith('runtime:'))).toEqual([]);
    const odd = rows(undefined, linear, { ...O, unchecked: 'not checked: w1 runs another release; upgrade it' });
    expect(odd.find(byKey('claude:mcp:linear'))).toMatchObject({ detail: 'not checked: w1 runs another release; upgrade it; saved, and takes effect when w1 links' });
    expect(odd.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ detail: 'not checked: w1 runs another release; upgrade it' });
  });

  it('two plugins\' servers of one name are told apart by their plugin in the gap name; a name no other row shares stays bare', () => {
    const beta = path.join(mac.claudeDir, 'plugins/cache/mp/beta/1.0.0');
    editJson(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins.beta = [{ scope: 'user', installPath: beta, version: '1.0.0' }]; });
    put(path.join(beta, '.mcp.json'), JSON.stringify({ mcpServers: { pdf: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/pdf.js'], env: { PDF_KEY: 'pdf_key_0987654321' } } } }));
    const gaps = Object.fromEntries(rows(report()).map((r) => [r.key, r.gap?.name]));
    expect(gaps['claude:plugin:acme:mcp:pdf']).toBe('pdf (plugin acme)');
    expect(gaps['claude:plugin:beta:mcp:pdf']).toBe('pdf (plugin beta)');
    expect(gaps['claude:mcp:linear']).toBe('linear');
  });

  it('a row of what will not work on w1 yet names it and what it lacks; one that is there or a row not checked names none', () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    expect(Object.fromEntries(rows(report({ commands: { npx: false } })).map((r) => [r.key, r.gap]))).toEqual({
      'claude:mcp:linear': { name: 'linear', what: 'keys not copied (env.LINEAR_API_KEY)' },
      'claude:plugin:acme:mcp:pdf': { name: 'pdf', what: 'keys not copied (env.PDF_KEY)' },
      'codex:mcp:github': { name: 'github', what: 'keys not copied (env.GITHUB_TOKEN)' },
      'var:E': { name: 'E', what: 'not set; empty reads it' },
      'var:REMOTE_TOKEN': { name: 'REMOTE_TOKEN', what: 'not set; remote reads it' },
      'oauth:claude:mcp:notion': { name: 'notion', what: 'not logged in' },
      'runtime:npx': { name: 'npx', what: 'not installed; linear, empty, github need it' },
      'maconly:claude:chrome': { name: 'chrome', what: 'runs only on a Mac' },
      'claude:settings': { name: 'settings.json', what: 'keys not copied (env.ANTHROPIC_API_KEY)' },
      'codex:config': { name: 'config.toml', what: 'keys not copied (model_providers.acme.http_headers.X-Key)' },
      'opencode:config': { name: 'opencode.jsonc', what: 'keys not copied (provider.openai.options.apiKey)' },
    });
    const copied = { 'claude:mcp:linear#env.LINEAR_API_KEY': 'copied' } as const;
    expect(row('claude:mcp:linear', { ticked: true, secrets: copied })?.gap).toBeUndefined();
    expect(row('claude:mcp:linear', { ticked: true, secrets: {} })?.gap).toEqual({ name: 'linear', what: 'ticked; not on w1 yet' });
    expect(rows(undefined).find(byKey('var:REMOTE_TOKEN'))?.gap).toBeUndefined();
    expect(rows(report({ vars: { REMOTE_TOKEN: true } })).find(byKey('var:REMOTE_TOKEN'))).toBeDefined();
    expect(rows(report({ vars: { REMOTE_TOKEN: true } })).find(byKey('var:REMOTE_TOKEN'))?.gap).toBeUndefined();
  });

  it('a robot\'s rows are those of its agents: their servers, yours, a plugin\'s and a project\'s it works in, what those need, and their config', () => {
    const db = path.join(mac.homedir, '.local/bin/db-mcp');
    const r = report({ commands: { npx: false, [db]: false } });
    const of = (agents: AgentKind[], folders: string[]) => setupRows(forRobot(mirrorPlan(mac, new Set()), { agents, folders }), r, O);
    const keys = (agents: AgentKind[], folders: string[]) => of(agents, folders).map((x) => x.key);
    expect(keys(['claude'], [path.join(mac.homedir, 'code/app/.claude/worktrees/fix')]))
      .toEqual(['claude:mcp:linear', 'claude:plugin:acme:mcp:pdf', 'var:E', 'var:REMOTE_TOKEN', 'runtime:npx', `runtime:${db}`, 'maconly:claude:chrome', 'claude:settings']);
    expect(keys(['claude'], [path.join(mac.homedir, 'code/other')])).not.toContain(`runtime:${db}`);
    expect(of(['claude'], []).find(byKey('runtime:npx'))?.gap).toEqual({ name: 'npx', what: 'not installed; linear, empty need it' });
    expect(keys(['codex'], [])).toEqual(['codex:mcp:github', 'runtime:npx', 'codex:config']);
    expect(keys(['opencode'], [])).toEqual(['opencode:config']);
    expect(keys([], [])).toEqual([]);
  });

  it("a robot's rows leave out the plugins, Codex config and OpenCode config of agents it does not run, and the variables only those read", () => {
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    const toml = path.join(mac.codexDir, 'config.toml');
    put(toml, `${fs.readFileSync(toml, 'utf8')}\n[model_providers.oai]\nenv_key = "OAI_KEY"\n`);
    put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ provider: { groq: { options: { baseURL: '{env:GROQ_URL}' } } } }));
    const of = (agents: AgentKind[]) => setupRows(forRobot(mirrorPlan(mac, new Set()), { agents, folders: [] }), report(), O).map((x) => x.key);
    expect(of(['claude'])).toContain('claude:plugin:acme');
    expect(of(['codex'])).toEqual(expect.arrayContaining(['var:OAI_KEY', 'codex:config']));
    expect(of(['opencode'])).toEqual(expect.arrayContaining(['var:GROQ_URL', 'opencode:config']));
    expect(of(['claude']).filter((k) => /^(var:(OAI_KEY|GROQ_URL)|codex:|opencode:)/.test(k))).toEqual([]);
    expect(of(['codex', 'opencode']).filter((k) => k.startsWith('claude:'))).toEqual([]);
  });

  it("a robot's rows name the files this Mac cannot read of its agents only, and a project's Mac-only server only where it works in that project", () => {
    const toml = path.join(mac.codexDir, 'config.toml');
    put(toml, 'model = [');
    editJson(mac.claudeJson, (j) => { j.projects[path.join(mac.homedir, 'code/app')].mcpServers.devtools = { command: 'npx', args: ['chrome-devtools-mcp'] }; });
    const of = (agents: AgentKind[], folders: string[]) => setupRows(forRobot(mirrorPlan(mac, new Set()), { agents, folders }), report(), O).map((x) => x.key);
    expect(of(['codex'], [])).toContain(`unreadable:${toml}`);
    expect(of(['claude'], [])).not.toContain(`unreadable:${toml}`);
    expect(of(['claude'], [path.join(mac.homedir, 'code/app')])).toContain('maconly:claude:devtools');
    expect(of(['claude'], [path.join(mac.homedir, 'code/other')])).not.toContain('maconly:claude:devtools');
    expect(of(['claude'], [])).toContain('maconly:claude:chrome');
  });

  it('Mirror.report reads no link as not reachable and one in mismatch as another release; a worker that does not answer is asked once, logged, and the rows come unchecked', async () => {
    const errors: string[] = [];
    const mirror = new Mirror({ ...mac, consent: path.join(makeHome(), 'mirror-consent.json'), log: { ...silentLogger, error: (m) => errors.push(m) } });
    const remote = async (link: Parameters<Mirror['report']>[0]) => (await mirror.report(link, W, { name: 'w1', fleetFlag: '' })).find(byKey('var:REMOTE_TOKEN'));
    const call = () => Promise.reject(new Error('timed out'));
    expect(await remote(undefined)).toMatchObject({ detail: 'not checked: w1 is not reachable' });
    expect(await remote({ connected: () => false, mismatch: () => ({}) as never, call })).toMatchObject({ detail: 'not checked: w1 runs another release; upgrade it' });
    expect(errors).toEqual([]);
    expect(await remote({ connected: () => true, mismatch: () => undefined, call })).toMatchObject({ action: 'check w1 again', detail: 'not checked: w1 is not reachable' });
    expect(errors).toEqual(['mirror: w1 did not answer config.state: timed out']);
  });
});

describe('the worker\'s report over the link', () => {
  let mac: ReturnType<typeof macHome>;
  let worker: ReturnType<typeof farHome>;
  let w: ReturnType<typeof world>;
  beforeEach(async () => {
    mac = macHome();
    worker = farHome();
    w = world({ mirror: { home: mac, worker } });
    stops.push(() => w.stop());
    await w.link();
    await w.home.links.pushMirror(W);
  });
  const setup = () => w.home.mirror!.report(w.home.links.for(W), W, { name: 'w1', fleetFlag: '' });
  const rowOf = async (key: string) => (await setup()).find(byKey(key));
  const tick = (item: string, fields: string[], on: boolean) => setConsent(w.home.paths.mirrorConsent, W, item, fields, on);
  const push = () => w.home.mirror!.push(w.home.links.for(W)!);

  it('config.report answers from its PATH, env and .env', async () => {
    fs.appendFileSync(w.worker.paths.env, 'REMOTE_TOKEN=abc\nE=\n');
    const rows = await setup();
    expect(rows.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'ok', detail: 'REMOTE_TOKEN is set on w1' });
    expect(rows.find(byKey('var:E'))).toMatchObject({ status: 'warn', action: 'set E on w1' });
    const bin = path.join(makeHome(), 'bin');
    for (const b of ['node', 'npx']) executable(path.join(bin, b));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('E', 'from-the-daemon');
    // empty in the daemon's environment, set in .env
    vi.stubEnv('REMOTE_TOKEN', '');
    const again = await setup();
    expect(again.filter((r) => r.key.startsWith('runtime:'))).toEqual([
      {
        key: 'runtime:bun', status: 'warn', action: 'install bun on w1', run: 'curl -fsSL https://bun.sh/install | bash', detail: 'ctx needs it',
        gap: { name: 'bun', what: 'not installed; ctx needs it' },
      },
    ]);
    expect(again.find(byKey('var:E'))).toMatchObject({ status: 'ok' });
    expect(again.find(byKey('var:REMOTE_TOKEN'))).toMatchObject({ status: 'ok' });
  });

  it('config.state names the projects the worker has; a command under the Mac\'s home is looked for under the worker\'s; a project server\'s key is read under the worker\'s path of it', async () => {
    const db = path.join(mac.homedir, '.local/bin/db-mcp');
    const item = `claude:mcp:db@${path.join(mac.homedir, 'code/app')}`;
    editJson(mac.claudeJson, (j) => { j.projects[path.join(mac.homedir, 'code/app')].mcpServers.db.env = { DB_PASSWORD: 'db_pass_1234567890' }; });
    tick(item, ['env.DB_PASSWORD'], true);
    expect((await setup()).filter((r) => r.key.includes('db-mcp') || r.key === item)).toEqual([]);
    fs.mkdirSync(path.join(worker.homedir, 'code/app'), { recursive: true });
    expect(await rowOf(`runtime:${db}`)).toMatchObject({ status: 'warn', action: 'install db-mcp on w1' });
    expect(await rowOf(item)).toMatchObject({ status: 'warn', detail: 'sent; not on w1 yet' });
    await push();
    expect(await rowOf(item)).toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.DB_PASSWORD db_…90' });
    executable(path.join(worker.homedir, '.local/bin/db-mcp'));
    expect((await setup()).filter((r) => r.key.includes('db-mcp'))).toEqual([]);
  });

  it('a ticked key is ok once the worker holds the copy, a plugin server\'s too; unticked, the reference the mirror leaves is not the worker\'s own, a value it set itself is', async () => {
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    tick('claude:plugin:acme:mcp:pdf', ['env.PDF_KEY'], true);
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'warn', detail: 'sent; not on w1 yet' });
    await push();
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.LINEAR_API_KEY lin…90' });
    expect(await rowOf('claude:plugin:acme:mcp:pdf')).toMatchObject({ status: 'ok', detail: 'keys copied to w1: env.PDF_KEY pdf…90' });
    tick('claude:mcp:linear', [], false);
    // the copy stays until the next push takes it
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'still on w1; check w1 again' });
    await push();
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'warn', action: "copy linear's keys to w1" });
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'worker-own'; });
    expect(await rowOf('claude:mcp:linear')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    // a plugin server file the worker changed holds its own
    tick('claude:plugin:acme:mcp:pdf', [], false);
    await push();
    editJson(path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json'), (j) => { j.mcpServers.pdf.env.PDF_KEY = 'pdf-own'; });
    expect(await rowOf('claude:plugin:acme:mcp:pdf')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
  });

  it('a key in the worker\'s overrides or its own settings env is its own before the next push, and ticked after it; a Claude login is read from its credentials', async () => {
    expect(await rowOf('codex:mcp:github')).toMatchObject({ status: 'warn', action: "copy github's keys to w1" });
    put(path.join(worker.overrides, 'codex/config.toml'), '[mcp_servers.github.env]\nGITHUB_TOKEN = "worker-own"\n');
    expect(await rowOf('codex:mcp:github')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    tick('codex:mcp:github', ['env.GITHUB_TOKEN'], true);
    await push();
    expect(await rowOf('codex:mcp:github')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys', tick: { on: true } });
    expect(await rowOf('claude:settings')).toMatchObject({ status: 'warn', action: "copy settings.json's keys to w1" });
    editJson(path.join(worker.claudeDir, 'settings.json'), (j) => { j.env.ANTHROPIC_API_KEY = 'sk-worker'; });
    expect(await rowOf('claude:settings')).toMatchObject({ status: 'ok', detail: 'w1 has its own keys' });
    editJson(mac.claudeJson, (j) => { j.mcpServers.notion = { type: 'http', url: 'https://mcp.notion.com/mcp' }; });
    expect(await rowOf('oauth:claude:mcp:notion')).toMatchObject({ status: 'warn', action: 'log in once on w1' });
    put(path.join(worker.claudeDir, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'notion|4f1c': { accessToken: 'x' } } }));
    expect(await rowOf('oauth:claude:mcp:notion')).toMatchObject({ status: 'ok', detail: 'logged in on w1' });
  });

  it('a subagent file listed whole asks to be copied whole and reads as copied once the worker holds it', async () => {
    put(path.join(mac.claudeDir, 'agents/db.md'), ['---', 'mcpServers:', '  - pg:', '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890', '---', ''].join('\n'));
    expect(await rowOf('claude:agent:db.md')).toMatchObject({ status: 'warn', action: 'copy agents/db.md to w1 as it is', tick: { fields: ['mcpServers.pg'], on: false } });
    tick('claude:agent:db.md', ['mcpServers.pg'], true);
    await push();
    expect(await rowOf('claude:agent:db.md')).toMatchObject({ status: 'ok', detail: 'copied to w1 as it is' });
    expect(fs.statSync(path.join(worker.claudeDir, 'agents/db.md')).mode & 0o777).toBe(0o600);
  });

  it('an unticked item carried whole that the worker still holds says it is still on w1, to check again, until a push takes it', async () => {
    put(path.join(mac.claudeDir, 'agents/db.md'), ['---', 'mcpServers:', '  - pg:', '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890', '---', ''].join('\n'));
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } }; });
    tick('claude:agent:db.md', ['mcpServers.pg'], true);
    tick('claude:mcp:odd', ['command', 'sandbox'], true);
    await push();
    tick('claude:agent:db.md', [], false);
    tick('claude:mcp:odd', [], false);
    for (const item of ['claude:agent:db.md', 'claude:mcp:odd']) {
      expect(await rowOf(item)).toMatchObject({ status: 'warn', action: 'check w1 again', detail: 'still on w1; check w1 again', tick: { on: false } });
    }
    await push();
    expect(await rowOf('claude:agent:db.md')).toMatchObject({ status: 'warn', action: 'copy agents/db.md to w1 as it is' });
    expect(await rowOf('claude:mcp:odd')).toMatchObject({ status: 'warn', action: 'copy odd to w1 as it is' });
  });

  it('a key in an arg under the Mac\'s home, unticked, reads as the mirror left it there, moved, and not as the worker\'s own', async () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.run = { command: 'sh', args: ['-c', `${mac.homedir}/run.sh https://u:pw_1234567890@host.test/x`] }; });
    await push();
    expect(await rowOf('claude:mcp:run')).toMatchObject({ status: 'warn', action: "copy run's keys to w1" });
  });

  it('with every item ticked no secret value is in the ask, the answer or the rows; once pushed, each item reads as the worker holds it', async () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } }; });
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    const ticks = setupRows(mirrorPlan(mac), undefined, O).flatMap((r) => (r.tick ? [r.tick] : []));
    expect(ticks.map((t) => t.item).sort()).toEqual([
      'claude:mcp:linear', 'claude:mcp:odd', 'claude:plugin:acme', 'claude:plugin:acme:mcp:pdf', 'claude:settings', 'codex:config', 'codex:mcp:github', 'opencode:config',
    ]);
    for (const t of ticks) tick(t.item, t.fields, true);
    expect(await rowOf('claude:mcp:odd')).toMatchObject({ status: 'warn', detail: 'sent; not on w1 yet' });
    expect(await rowOf('claude:plugin:acme')).toMatchObject({ status: 'warn', detail: 'sent; not on w1 yet' });
    await push();
    const rows = (await setup()).filter((r) => r.tick);
    const whole = ['claude:mcp:odd', 'claude:plugin:acme'];
    expect(rows.map((r) => [r.key, r.status, r.detail.split(':')[0]])).toEqual(ticks.map((t) => [t.item, 'ok', whole.includes(t.item) ? 'copied to w1 as it is' : 'keys copied to w1']));
    const plan = mirrorPlan(mac, readConsent(w.home.paths.mirrorConsent, W));
    const ask = reportAsk(plan);
    const answer = configReport(ask, { ...worker, envFile: w.worker.paths.env, stateFile: w.worker.paths.mirrorState });
    expect(Object.values(answer.secrets)).toEqual(Object.values(answer.secrets).map(() => 'copied'));
    const said = JSON.stringify([ask, answer, setupRows(plan, answer, O)]);
    for (const secret of [
      'lin_api_1234567890', 'pdf_key_1234567890', 'ghp_1234567890abcdef', 'acme_key_1234567890', 'sk-oc-1234567890', 'sk-mac', 'odd_token_1234567890', 'acme_1234567890abcd',
    ]) expect(said).not.toContain(secret);
  });
});
