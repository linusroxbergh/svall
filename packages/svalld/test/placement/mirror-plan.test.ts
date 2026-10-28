import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIRROR_FILE_MAX, mirrorPlan } from '../../src/placement/mirror-plan.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { ACME, editJson, macHome, marketKey, put } from './mirror-homes.js';

afterEach(() => cleanHomes());

const PLANNED = [
  'claude/CLAUDE.md', 'claude/agents/planner.md', 'claude/commands/ship.md', 'claude/keybindings.json',
  `${ACME}/.mcp.json`, `${ACME}/skills/pdf/SKILL.md`, 'claude/plugins/installed_plugins.json', 'claude/plugins/known_marketplaces.json',
  'claude/plugins/marketplaces/mp/.claude-plugin/marketplace.json', 'claude/rules/style.md', 'claude/skills/review/SKILL.md', 'codex/AGENTS.md',
  'home/.agents/skills/lint/SKILL.md', 'opencode/plugins/mine.js', 'profiles/reviewer.md',
];

describe('the agent configuration mirror', () => {
  it('the plan lists CLAUDE.md, skills, rules, agents, commands and a settings.json without hooks and statusLine, and the plugin trees, and nothing from .claude.json as a file or from the logins', () => {
    const mac = macHome();
    const plan = mirrorPlan(mac, new Set());
    expect(plan.files.map((f) => f.to).sort()).toEqual(PLANNED);
    expect(plan.files.find((f) => f.to === 'claude/CLAUDE.md')).toEqual({ from: path.join(mac.claudeDir, 'CLAUDE.md'), to: 'claude/CLAUDE.md', mode: fs.statSync(path.join(mac.claudeDir, 'CLAUDE.md')).mode & 0o777 });
    // and none of the settings that hold secrets or run what fetches them
    expect(plan.settings).toEqual({ model: 'opus', theme: 'dark', scratchDir: path.join(mac.homedir, 'scratch'), sandbox: { workPath: [path.join(mac.homedir, 'code')], cwd: '/opt/shared' } });
    expect(plan.skipped).toEqual([marketKey(mac)]);
  });

  it('a link to a login file, and a key by any of its names, stays on the Mac; a link into plugins and to a plain file travels', () => {
    const mac = macHome();
    put(path.join(mac.claudeDir, 'plugins/cache/acme/skills/pdf/SKILL.md'), 'pdf\n');
    fs.symlinkSync(path.join(mac.claudeDir, 'plugins/cache/acme/skills/pdf'), path.join(mac.claudeDir, 'skills/pdf'));
    fs.symlinkSync(path.join(mac.homedir, '.claude.json'), path.join(mac.claudeDir, 'skills/review/cfg.json'));
    fs.symlinkSync(path.join(mac.codexDir, 'auth.json'), path.join(mac.claudeDir, 'rules/codex.md'));
    fs.symlinkSync(path.join(mac.claudeDir, '.credentials.json'), path.join(mac.claudeDir, 'agents/login.md'));
    for (const key of ['id_ed25519', 'id_ed25519.pub', 'deploy.p12', 'credentials.json', 'auth.json', 'server.pem']) put(path.join(mac.homedir, '.agents/skills/lint', key), 'secret\n');
    put(path.join(mac.homedir, 'notes/house.md'), 'house style\n');
    fs.symlinkSync(path.join(mac.homedir, 'notes/house.md'), path.join(mac.claudeDir, 'rules/house.md'));
    expect(mirrorPlan(mac).files.map((f) => f.to).sort()).toEqual([...PLANNED, 'claude/rules/house.md', 'claude/skills/pdf/SKILL.md'].sort());
  });

  it('the common credential files and folders stay on the Mac, under a mirrored root or through a link into a dotfiles tree', () => {
    const mac = macHome();
    const lint = path.join(mac.homedir, '.agents/skills/lint');
    for (const rel of [
      '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.aws/credentials', '.aws/config', '.ssh/config', '.docker/config.json',
      '.config/gh/hosts.yml', '.gnupg/pubring.kbx', 'cert.pem', 'tls.key', '.env', '.env.local',
    ]) put(path.join(lint, rel), 'secret\n');
    put(path.join(mac.homedir, 'dotfiles/.aws/credentials'), 'secret\n');
    put(path.join(mac.homedir, 'dotfiles/notes.md'), 'notes\n');
    fs.symlinkSync(path.join(mac.homedir, 'dotfiles'), path.join(mac.claudeDir, 'skills/dotfiles'));
    expect(mirrorPlan(mac).files.map((f) => f.to).sort()).toEqual([...PLANNED, 'claude/skills/dotfiles/notes.md'].sort());
  });

  it('a file over 5 MB and a tree over 200 MB are left out, each with a line', () => {
    const mac = macHome();
    const sparse = (file: string, bytes: number) => { put(file, ''); fs.truncateSync(file, bytes); };
    sparse(path.join(mac.claudeDir, 'skills/review/model.bin'), MIRROR_FILE_MAX + 1);
    for (let i = 0; i < 41; i++) sparse(path.join(mac.claudeDir, `commands/big-${i}.md`), MIRROR_FILE_MAX);
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to)).toContain('claude/skills/review/SKILL.md');
    expect(plan.files.filter((f) => f.to.startsWith('claude/skills/review/model') || f.to.startsWith('claude/commands/'))).toEqual([]);
    expect(plan.skipped).toEqual([
      marketKey(mac),
      `${path.join(mac.claudeDir, 'skills/review/model.bin')} is over 5 MB`,
      `${path.join(mac.claudeDir, 'commands')} is over 200 MB`,
    ]);
  });

  it('a plugin or marketplace server file whose server holds a key or a field the mirror does not know, and a marketplace list defining one, stay on the Mac; a manifest that cannot be read keeps its whole plugin here, and what one names', () => {
    const mac = macHome();
    const market = path.join(mac.claudeDir, 'plugins/marketplaces/mp');
    const acme = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    const keyed = (k: string) => JSON.stringify({ s: { command: 'x', env: { K: k } } });
    put(path.join(market, 'odd/.mcp.json'), JSON.stringify({ odd: { command: 'odd', sandbox: { token: 'odd_token_1234567890' } } }));
    put(path.join(market, 'bad/.claude-plugin/plugin.json'), '{ "mcpServers": "./servers.json", ');
    put(path.join(market, 'bad/servers.json'), keyed('bad_key_1234567890'));
    put(path.join(market, 'far/.claude-plugin/plugin.json'), JSON.stringify({ name: 'far', mcpServers: '../shared/keys.json' }));
    put(path.join(market, 'shared/keys.json'), keyed('far_key_1234567890'));
    put(path.join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'mp', plugins: [{ name: 'inline', source: './inline', mcpServers: { s: { command: 'x', env: { K: 'inline_key_1234567890' } } } }] }));
    put(path.join(acme, '.claude-plugin/plugin.json'), '{ "mcpServers": "./servers.json", ');
    put(path.join(acme, 'servers.json'), keyed('acme_key_1234567890'));
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to).filter((t) => t.startsWith('claude/plugins/')).sort()).toEqual(['claude/plugins/installed_plugins.json', 'claude/plugins/known_marketplaces.json']);
    expect(plan.skipped).toEqual(expect.arrayContaining([
      `${path.join(market, 'odd/.mcp.json')} holds a key`, `${path.join(market, '.claude-plugin/marketplace.json')} holds a key`,
      `${path.join(market, 'bad/.claude-plugin/plugin.json')} cannot be read`, `${path.join(market, 'far/.claude-plugin/plugin.json')} cannot be read`,
      `${path.join(acme, '.claude-plugin/plugin.json')} cannot be read`,
    ]));
  });

  it('a server file a marketplace entry names by path is the plugin\'s server file in its install, redacted until ticked, and stays on the Mac in the marketplace while it holds a key', () => {
    const mac = macHome();
    const market = path.join(mac.claudeDir, 'plugins/marketplaces/mp');
    const acme = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    const servers = JSON.stringify({ mcpServers: { s: { command: 'x', env: { K: 'mk_key_1234567890' } } } });
    put(path.join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'mp', plugins: [{ name: 'acme', source: './acme', strict: false, mcpServers: './servers.json' }] }));
    put(path.join(market, 'acme/servers.json'), servers);
    put(path.join(acme, 'servers.json'), servers);
    const plan = mirrorPlan(mac);
    expect(plan.skipped).toContain(`${path.join(market, 'acme/servers.json')} holds a key`);
    expect(plan.files.map((f) => f.to)).not.toContain('claude/plugins/marketplaces/mp/acme/servers.json');
    const installed = plan.files.find((f) => f.to === `${ACME}/servers.json`);
    expect(JSON.parse(installed!.data!)).toEqual({ mcpServers: { s: { command: 'x', env: { K: '${K}' } } } });
    expect(plan.servers.find((s) => s.key === 'claude:plugin:acme:mcp:s')).toMatchObject({ secretFields: ['env.K'], ticked: [] });
    const ticked = mirrorPlan(mac, new Set(['claude:plugin:acme:mcp:s#env.K'])).files.find((f) => f.to === `${ACME}/servers.json`);
    expect([JSON.parse(ticked!.data!).mcpServers.s.env.K, ticked!.mode]).toEqual(['mk_key_1234567890', 0o600]);
  });

  it('a server file an entry of a marketplace added from a local folder names by path is redacted in its install until ticked; one whose folder is gone, or every one known_marketplaces.json alone names while it cannot be read, keeps its plugins on the Mac', () => {
    const mac = macHome();
    const local = path.join(mac.homedir, 'work/dirmp');
    const gone = path.join(mac.homedir, 'work/gone');
    const acme = path.join(mac.claudeDir, 'plugins/cache/dirmp/acme/1.0.0');
    const beta = path.join(mac.claudeDir, 'plugins/cache/gone/beta/1.0.0');
    const servers = JSON.stringify({ mcpServers: { s: { command: 'x', env: { K: 'mk_key_1234567890' } } } });
    put(path.join(local, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'dirmp', plugins: [{ name: 'acme', source: './acme', strict: false, mcpServers: './servers.json' }] }));
    put(path.join(local, 'acme/servers.json'), servers);
    put(path.join(acme, 'servers.json'), servers);
    put(path.join(beta, 'servers.json'), servers);
    editJson(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), (j) => {
      j.plugins = { 'acme@dirmp': [{ scope: 'user', installPath: acme }], 'beta@gone': [{ scope: 'user', installPath: beta }] };
    });
    editJson(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), (j) => {
      j.dirmp = { source: { source: 'directory', path: local }, installLocation: local };
      j.gone = { source: { source: 'directory', path: gone }, installLocation: gone };
    });
    const plan = mirrorPlan(mac);
    const installed = plan.files.find((f) => f.to === 'claude/plugins/cache/dirmp/acme/1.0.0/servers.json');
    expect(JSON.parse(installed!.data!)).toEqual({ mcpServers: { s: { command: 'x', env: { K: '${K}' } } } });
    expect(plan.servers.find((s) => s.name === 's')).toMatchObject({ secretFields: ['env.K'], ticked: [] });
    expect(plan.files.some((f) => f.from.startsWith(beta))).toBe(false);
    expect(plan.unreadable).toContain(path.join(gone, '.claude-plugin/marketplace.json'));
    put(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), '{');
    expect(mirrorPlan(mac).files.some((f) => f.from.startsWith(acme))).toBe(false);
  });

  it('a marketplace list that cannot be read keeps that marketplace and each plugin installed from it on the Mac', () => {
    const mac = macHome();
    const list = path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json');
    put(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'acme@mp': [{ scope: 'user', installPath: path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0') }] } }));
    put(list, '{ "plugins": ');
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to).filter((t) => t.startsWith('claude/plugins/')).sort()).toEqual(['claude/plugins/installed_plugins.json', 'claude/plugins/known_marketplaces.json']);
    expect(plan.unreadable).toContain(list);
  });

  it('a plugin settings.json that cannot be read stays on the Mac as a file to set up by hand, not a config to tick', () => {
    const mac = macHome();
    const settings = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json');
    put(settings, '{ "env": ');
    const plan = mirrorPlan(mac);
    expect([plan.plugins, plan.unreadable, plan.files.some((f) => f.from === settings)]).toEqual([[], [settings], false]);
  });

  it('a server\'s env key not ticked is a variable the worker\'s robots read, ticked it is not; a name no variable can have is none', () => {
    const mac = macHome();
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'x', env: { 'not-a-var': 'odd_key_1234567890' } }; });
    expect(mirrorPlan(mac).vars).toEqual(['E', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'PDF_KEY', 'REMOTE_TOKEN']);
    expect(mirrorPlan(mac, new Set(['claude:mcp:linear#env.LINEAR_API_KEY'])).vars).not.toContain('LINEAR_API_KEY');
  });

  it('the variables a plan names come from what it carries: a server withheld until ticked whole names none until it is', () => {
    const mac = macHome();
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { ODD_KEY: 'odd_key_1234567890', REF: '${ODD_REF}' }, sandbox: true }; });
    expect(mirrorPlan(mac).vars).toEqual(['E', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'PDF_KEY', 'REMOTE_TOKEN']);
    expect(mirrorPlan(mac, new Set(['command', 'env', 'sandbox'].map((f) => `claude:mcp:odd#${f}`))).vars).toContain('ODD_REF');
  });

  it('a project server outside the Mac\'s home goes where the worker says it has that folder', () => {
    const mac = macHome();
    const outside = path.join(makeHome(), 'shared');
    editJson(mac.claudeJson, (j) => { j.projects[outside] = { mcpServers: { far: { command: 'far' } } }; });
    const facts = (has: boolean) => ({ state: { files: {}, docs: {}, servers: {}, secrets: {} }, projects: { [outside]: has } });
    expect(mirrorPlan(mac, new Set(), facts(false)).servers.map((s) => s.name)).not.toContain('far');
    expect(mirrorPlan(mac, new Set(), facts(true)).servers.find((s) => s.name === 'far')).toMatchObject({ scope: { project: outside } });
  });

  it('a marketplace source\'s headers in settings.json are key fields of claude:settings, emptied there and in known_marketplaces.json unless ticked', () => {
    const mac = macHome();
    const source = { source: 'url', url: 'https://x.test/m.json', headers: { Authorization: 'Bearer mh_fake_1234567890' } };
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => {
      j.extraKnownMarketplaces = {
        x: { source },
        y: { source: { source: 'settings', plugins: [{ name: 'p', source: { source: 'url', url: 'https://y.test/p.zip' }, headers: { 'X-Key': 'ph_fake_1234567890' } }] } },
      };
    });
    editJson(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), (j) => { j.x = { source, installLocation: path.join(mac.claudeDir, 'plugins/marketplaces/x') }; });
    const listOf = (plan: ReturnType<typeof mirrorPlan>) => plan.files.find((f) => f.to === 'claude/plugins/known_marketplaces.json')!;
    const plan = mirrorPlan(mac);
    expect(plan.configs.find((c) => c.key === 'claude:settings')!.fields).toEqual([
      'extraKnownMarketplaces.x.source.headers.Authorization', 'extraKnownMarketplaces.y.source.plugins.0.headers.X-Key', 'env.ANTHROPIC_API_KEY',
    ]);
    expect(JSON.stringify([plan.settings, listOf(plan).data])).not.toMatch(/mh_fake|ph_fake/);
    const ticked = mirrorPlan(mac, new Set(['claude:settings#extraKnownMarketplaces.x.source.headers.Authorization']));
    expect([JSON.parse(listOf(ticked).data!).x.source.headers.Authorization, listOf(ticked).mode, ticked.keyed]).toEqual(['Bearer mh_fake_1234567890', 0o600, ['claude/plugins/known_marketplaces.json']]);
    expect((ticked.settings as any).extraKnownMarketplaces.x.source.headers.Authorization).toBe('Bearer mh_fake_1234567890');
    expect(JSON.stringify(ticked.settings)).not.toContain('ph_fake');
  });

  it('a plugin\'s LSP server holding a key in its env, in .lsp.json or plugin.json, lists the plugin\'s config whole, and a marketplace entry setting headers lists its marketplace.json whole; each stays on the Mac until ticked', () => {
    const mac = macHome();
    const acme = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    const market = path.join(mac.claudeDir, 'plugins/marketplaces/mp');
    const list = path.join(market, '.claude-plugin/marketplace.json');
    const lsp = JSON.stringify({ go: { command: 'gopls', env: { GO_TOKEN: 'lsp_fake_1234567890' } }, ts: { command: 'tsls', env: { K: '${K}' } } });
    put(path.join(acme, '.lsp.json'), lsp);
    put(path.join(market, 'acme/.lsp.json'), lsp);
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', lspServers: { py: { command: 'pyls', env: { PY_TOKEN: 'lsp_fake_0987654321' } } } }));
    put(list, JSON.stringify({ name: 'mp', plugins: [{ name: 'acme', source: './acme' }, { name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headers: { Authorization: 'Bearer mk_fake_1234567890' } }] }));
    const files = [path.join(acme, '.lsp.json'), path.join(acme, '.claude-plugin/plugin.json'), list];
    const plan = mirrorPlan(mac);
    expect(plan.plugins).toEqual([
      { key: 'claude:plugin:acme', name: "acme's config", fields: ['lspServers.go', 'lspServers.py'], ticked: false, files: files.slice(0, 2) },
      { key: 'claude:marketplace:mp', name: "mp's marketplace.json", fields: ['plugins.zip'], ticked: false, files: [list] },
    ]);
    expect(plan.files.filter((f) => files.includes(f.from) || f.from === path.join(market, 'acme/.lsp.json'))).toEqual([]);
    expect(plan.skipped).toEqual(expect.arrayContaining([...files.map((f) => `${f} is not ticked`), `${path.join(market, 'acme/.lsp.json')} holds a key`]));
    const ticked = mirrorPlan(mac, new Set(['claude:plugin:acme#lspServers.go', 'claude:plugin:acme#lspServers.py', 'claude:marketplace:mp#plugins.zip']));
    const carried = ticked.files.filter((f) => files.includes(f.from));
    expect(Object.fromEntries(carried.map((f) => [f.to, f.mode]))).toEqual({
      [`${ACME}/.lsp.json`]: 0o600, [`${ACME}/.claude-plugin/plugin.json`]: 0o600, 'claude/plugins/marketplaces/mp/.claude-plugin/marketplace.json': 0o600,
    });
    expect(ticked.keyed.sort()).toEqual(carried.map((f) => f.to).sort());
  });

  it('a subagent whose frontmatter defines an inline MCP server holding a key or fields the mirror does not know, or that it cannot read, is listed whole and stays on the Mac until ticked; one naming servers only, or whose servers hold none, travels', () => {
    const mac = macHome();
    const agents = path.join(mac.claudeDir, 'agents');
    const md = (...lines: string[]) => ['---', ...lines, '---', 'the agent', ''].join('\n');
    put(path.join(agents, 'db.md'), md('name: db', 'mcpServers:', '  - github', '  - pg:', '      type: stdio', '      command: npx', '      args: ["-y", "pg-mcp"]', '      env:', '        PG_PASSWORD: pg_fake_1234567890'));
    put(path.join(agents, 'team/odd.md'), md('mcpServers:', '  odd:', '    command: odd', '    sandbox: true'));
    put(path.join(agents, 'folded.md'), md('mcpServers:', '  - pg:', '      command: >', '        npx pg'));
    put(path.join(agents, 'ref.md'), md('mcpServers:', '- github', '- docs:', '    type: http', '    url: https://docs.test/mcp', '    headers:', "      Authorization: 'Bearer ${DOCS_TOKEN}'"));
    put(path.join(agents, 'names.md'), md('mcpServers: [github, "slack"]'));
    const plan = mirrorPlan(mac);
    expect(plan.plugins).toEqual([
      { key: 'claude:agent:db.md', name: 'agents/db.md', fields: ['mcpServers.pg'], ticked: false, files: [path.join(agents, 'db.md')] },
      { key: 'claude:agent:folded.md', name: 'agents/folded.md', fields: ['mcpServers'], ticked: false, files: [path.join(agents, 'folded.md')] },
      { key: 'claude:agent:team/odd.md', name: 'agents/team/odd.md', fields: ['mcpServers.odd'], ticked: false, files: [path.join(agents, 'team/odd.md')] },
    ]);
    expect(plan.files.map((f) => f.to).filter((t) => t.startsWith('claude/agents/')).sort()).toEqual(['claude/agents/names.md', 'claude/agents/planner.md', 'claude/agents/ref.md']);
    expect(plan.skipped).toEqual(expect.arrayContaining(['db.md', 'folded.md', 'team/odd.md'].map((f) => `${path.join(agents, f)} is not ticked`)));
    const ticked = mirrorPlan(mac, new Set(['claude:agent:db.md#mcpServers.pg']));
    expect([ticked.files.find((f) => f.to === 'claude/agents/db.md')?.mode, ticked.keyed]).toEqual([0o600, ['claude/agents/db.md']]);
  });

  it('a marketplace entry naming its LSP config by path lists that file whole in its plugin\'s install, and holds it in the marketplace, while it holds a key', () => {
    const mac = macHome();
    const market = path.join(mac.claudeDir, 'plugins/marketplaces/mp');
    const named = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/lsp/servers.json');
    put(path.join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'mp', plugins: [{ name: 'acme', source: './acme', strict: false, lspServers: './lsp/servers.json' }] }));
    const lsp = JSON.stringify({ go: { command: 'gopls', env: { GO_TOKEN: 'lsp_named_fake_1234567890' } } });
    put(path.join(market, 'acme/lsp/servers.json'), lsp);
    put(named, lsp);
    const plan = mirrorPlan(mac);
    expect(plan.plugins).toEqual([{ key: 'claude:plugin:acme', name: "acme's config", fields: ['lspServers.go'], ticked: false, files: [named] }]);
    expect(plan.files.filter((f) => f.from.endsWith('lsp/servers.json'))).toEqual([]);
    expect(plan.skipped).toEqual(expect.arrayContaining([`${path.join(market, 'acme/lsp/servers.json')} holds a key`, `${named} is not ticked`]));
  });

  it('a marketplace url\'s query values in settings.json are key fields of claude:settings, emptied there and in known_marketplaces.json unless ticked', () => {
    const mac = macHome();
    const url = 'https://gl.test/api/v4/raw/marketplace.json?private_token=glpat_fake_1234567890';
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.extraKnownMarketplaces = { gl: { source: { source: 'url', url } } }; });
    editJson(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), (j) => { j.gl = { source: { source: 'url', url }, installLocation: path.join(mac.claudeDir, 'plugins/marketplaces/gl') }; });
    const listOf = (plan: ReturnType<typeof mirrorPlan>) => JSON.parse(plan.files.find((f) => f.to === 'claude/plugins/known_marketplaces.json')!.data!);
    const plan = mirrorPlan(mac);
    expect(plan.configs.find((c) => c.key === 'claude:settings')!.fields).toEqual(['extraKnownMarketplaces.gl.source.url.private_token', 'env.ANTHROPIC_API_KEY']);
    expect(JSON.stringify([plan.settings, listOf(plan)])).not.toContain('glpat_fake');
    const ticked = mirrorPlan(mac, new Set(['claude:settings#extraKnownMarketplaces.gl.source.url.private_token']));
    expect([listOf(ticked).gl.source.url, (ticked.settings as any).extraKnownMarketplaces.gl.source.url, ticked.keyed]).toEqual([url, url, ['claude/plugins/known_marketplaces.json']]);
  });

  it('a plugin\'s own subagent defining a server holding a key, in its install or its marketplace, is listed whole by its path under Claude\'s folder and stays on the Mac until ticked', () => {
    const mac = macHome();
    const md = ['---', 'name: db', 'mcpServers:', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: plugin_agent_fake_1234567890', '---', 'body', ''].join('\n');
    const rels = ['plugins/marketplaces/mp/acme/agents/db.md', 'plugins/cache/mp/acme/1.0.0/agents/db.md'];
    for (const rel of rels) put(path.join(mac.claudeDir, rel), md);
    const plan = mirrorPlan(mac);
    expect(plan.plugins).toEqual(rels.map((rel) => ({ key: `claude:agent:${rel}`, name: rel, fields: ['mcpServers.pg'], ticked: false, files: [path.join(mac.claudeDir, rel)] })));
    expect(plan.files.filter((f) => f.from.endsWith('agents/db.md'))).toEqual([]);
    const ticked = mirrorPlan(mac, new Set(rels.map((rel) => `claude:agent:${rel}#mcpServers.pg`)));
    expect(ticked.files.filter((f) => f.from.endsWith('agents/db.md')).map((f) => [f.to, f.mode])).toEqual(rels.map((rel) => [`claude/${rel}`, 0o600]));
    // a marketplace whose list cannot be read keeps all of it here, rows of its own none
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), '{ "plugins": ');
    expect(mirrorPlan(mac).plugins.map((p) => p.key)).toEqual([`claude:agent:${rels[1]}`]);
  });

  it('a marketplace list ticked whole that only runs a headersHelper travels as a file with no key in it', () => {
    const mac = macHome();
    const list = path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json');
    put(list, JSON.stringify({ name: 'mp', plugins: [{ name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headersHelper: 'z-headers' }] }));
    const ticked = mirrorPlan(mac, new Set(['claude:marketplace:mp#plugins.zip']));
    expect([ticked.files.find((f) => f.from === list)?.mode, ticked.keyed, ticked.inPlace]).toEqual([fs.statSync(list).mode & 0o777, [], []]);
  });

  it('the variables a plan names come only from servers it carries: one in a plugin file it does not carry names none', () => {
    const mac = macHome();
    editJson(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins = { 'acme@mp': j.plugins.acme }; });
    editJson(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json'), (j) => { j.mcpServers.pdf.env.HELD = '${HELD_PLUGIN_VAR}'; });
    expect(mirrorPlan(mac).vars).toContain('HELD_PLUGIN_VAR');
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), '{ "plugins": ');
    const plan = mirrorPlan(mac);
    expect([plan.unreadInstalls.length, plan.vars.filter((v) => v === 'HELD_PLUGIN_VAR' || v === 'PDF_KEY')]).toEqual([1, []]);
  });

  it('a file the mirror writes itself is left out over 5 MB too', () => {
    const mac = macHome();
    const mcp = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    // under 5 MB as the Mac holds it, over once written out with its indent
    put(mcp, JSON.stringify({ mcpServers: { pdf: { command: 'node', args: Array<string>(700_000).fill('-v') } } }));
    expect(fs.statSync(mcp).size).toBeLessThan(MIRROR_FILE_MAX);
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to)).not.toContain(`${ACME}/.mcp.json`);
    expect(plan.skipped).toContain(`${mcp} is over 5 MB`);
  });

  it.each([
    ['no server', {}], ['a server inline', { mcpServers: { s: { command: 'node', args: ['x.js'] } } }],
    ['a server holding a key inline', { mcpServers: { s: { command: 'node', env: { K: 'inline_key_fake_123456' } } } }],
  ])('a plugin\'s subagent its plugin.json names by path is listed whole as one in agents/ is, the plugin.json holding %s', (_, servers) => {
    const mac = macHome();
    const acme = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', agents: ['./reviewers/db.md'], ...servers }));
    put(path.join(acme, 'reviewers/db.md'), ['---', 'name: db', 'mcpServers:', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: custom_agent_fake_123', '---', 'b', ''].join('\n'));
    const plan = mirrorPlan(mac);
    const rel = 'plugins/cache/mp/acme/1.0.0/reviewers/db.md';
    expect(plan.plugins).toEqual([{ key: `claude:agent:${rel}`, name: rel, fields: ['mcpServers.pg'], ticked: false, files: [path.join(mac.claudeDir, rel)] }]);
    expect(plan.files.filter((f) => f.from.endsWith('reviewers/db.md'))).toEqual([]);
  });

  it('a subagent a strict:false marketplace entry names in its agents is listed whole, in the marketplace, its list held for a key, and in the plugin\'s install', () => {
    const mac = macHome();
    const md = ['---', 'name: db', 'mcpServers:', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: entry_agent_fake_123', '---', 'b', ''].join('\n');
    const list = path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json');
    put(list, JSON.stringify({
      name: 'mp', plugins: [
        { name: 'acme', source: './acme', strict: false, agents: ['./reviewers/db.md'] },
        { name: 'kv', source: './kv', strict: false, mcpServers: { kv: { command: 'kv', env: { KV_TOKEN: 'kv_fake_1234567890' } } } },
      ],
    }));
    const rels = ['plugins/marketplaces/mp/acme/reviewers/db.md', 'plugins/cache/mp/acme/1.0.0/reviewers/db.md'];
    for (const rel of rels) put(path.join(mac.claudeDir, rel), md);
    const plan = mirrorPlan(mac);
    expect(plan.skipped).toContain(`${list} holds a key`);
    expect(plan.plugins).toEqual(rels.map((rel) => ({ key: `claude:agent:${rel}`, name: rel, fields: ['mcpServers.pg'], ticked: false, files: [path.join(mac.claudeDir, rel)] })));
    expect(plan.files.filter((f) => f.from.endsWith('reviewers/db.md'))).toEqual([]);
  });
});
