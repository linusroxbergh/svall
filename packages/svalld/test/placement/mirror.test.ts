import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/handover/hash.js';
import { realPath } from '../../src/handover/portable-path.js';
import { claudeAdapter } from '../../src/handover/sessions/claude.js';
import { clearConsent, mask, readConsent, setConsent, tickedFields } from '../../src/placement/mirror-consent.js';
import { silentLogger } from '../../src/log.js';
import { agentServers } from '../../src/placement/mirror-config.js';
import { applyMirror, lockAgentFiles, MIRROR_FILE_MAX, mirrorCalls, mirrorPlan, packMirror, takeBackCopies } from '../../src/placement/mirror.js';
import { fileSha, unpack } from '../../src/placement/move.js';
import { seedTrust } from '../../src/placement/trust.js';
import { SHIM } from '../../src/profile.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { editJson, FAR_HOOKS, FAR_STATUS, farHome, macHome, mirroredFiles, put, statsOf } from './mirror-homes.js';
import { H, W, until, world } from './world.js';

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  cleanHomes();
});

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const json = (file: string): any => JSON.parse(read(file));

const ACME = 'claude/plugins/cache/mp/acme/1.0.0';
const PLANNED = [
  'claude/CLAUDE.md', 'claude/agents/planner.md', 'claude/commands/ship.md', 'claude/keybindings.json',
  `${ACME}/.mcp.json`, `${ACME}/skills/pdf/SKILL.md`, 'claude/plugins/installed_plugins.json', 'claude/plugins/known_marketplaces.json',
  'claude/plugins/marketplaces/mp/.claude-plugin/marketplace.json', 'claude/rules/style.md', 'claude/skills/review/SKILL.md', 'codex/AGENTS.md',
  'home/.agents/skills/lint/SKILL.md', 'opencode/plugins/mine.js', 'profiles/reviewer.md',
];
const marketKey = (mac: ReturnType<typeof macHome>) => `${path.join(mac.claudeDir, 'plugins/marketplaces/mp/acme/.mcp.json')} holds a key`;

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

  it('applyMirror keeps the worker\'s hooks and statusLine, writes the servers into its .claude.json and merges mirror-overrides last; an unchanged file is not rewritten', async () => {
    const mac = macHome();
    const worker = farHome();
    const far = worker.homedir;
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    await packMirror(mirrorPlan(mac), path.join(scratch, 'mirror.tar'));
    const blob = path.join(scratch, 'blob');
    await unpack(path.join(scratch, 'mirror.tar'), blob);

    const { written } = applyMirror(blob, o);
    expect(written.sort()).toEqual([
      path.join(far, '.agents/skills/lint/SKILL.md'), path.join(worker.agentProfiles, 'reviewer.md'),
      ...[
        'CLAUDE.md', 'agents/planner.md', 'commands/ship.md', 'keybindings.json', 'rules/style.md', 'settings.json', 'skills/review/SKILL.md', '.claude.json',
        'plugins/installed_plugins.json', 'plugins/known_marketplaces.json', 'plugins/cache/mp/acme/1.0.0/.mcp.json', 'plugins/cache/mp/acme/1.0.0/skills/pdf/SKILL.md',
        'plugins/marketplaces/mp/.claude-plugin/marketplace.json',
      ].map((f) => path.join(worker.claudeDir, f)),
      path.join(worker.codexDir, 'AGENTS.md'), path.join(worker.codexDir, 'config.toml'),
      path.join(worker.opencodeDir, 'opencode.jsonc'), path.join(worker.opencodeDir, 'plugins/mine.js'),
    ].sort());
    // the worker's own secrets, as its hooks and status line, stay as they were
    expect(json(path.join(worker.claudeDir, 'settings.json'))).toEqual({
      model: 'sonnet', cleanupPeriodDays: 7, hooks: FAR_HOOKS, statusLine: FAR_STATUS, env: { HTTPS_PROXY: 'http://proxy:3128' }, apiKeyHelper: '/home/ada/bin/key', theme: 'dark',
      scratchDir: path.join(far, 'scratch'), sandbox: { workPath: [path.join(far, 'code')], cwd: '/opt/shared' },
    });
    expect(read(path.join(worker.claudeDir, 'CLAUDE.md'))).toBe('# this worker\n');
    expect(read(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toBe('review it\n');
    for (const gone of ['skills/review/.env', '.credentials.json', 'projects']) expect(fs.existsSync(path.join(worker.claudeDir, gone))).toBe(false);
    expect(json(worker.claudeJson).mcpServers).toEqual({
      linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' } },
      remote: { type: 'http', url: 'https://remote.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } },
      empty: { command: 'npx', args: ['-y', 'empty-mcp'], env: { E: '${E}' } },
    });
    expect(fs.existsSync(path.join(far, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(worker.codexDir, 'auth.json'))).toBe(false);
    expect(json(o.varsFile)).toEqual(['E', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'PDF_KEY', 'REMOTE_TOKEN']);

    const skill = fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'));
    const settings = fs.statSync(path.join(worker.claudeDir, 'settings.json'));
    expect(applyMirror(blob, o)).toEqual({ written: [], removed: [] });
    expect(fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toMatchObject({ ino: skill.ino, mtimeMs: skill.mtimeMs });
    expect(fs.statSync(path.join(worker.claudeDir, 'settings.json'))).toMatchObject({ ino: settings.ino, mtimeMs: settings.mtimeMs });
  });

  it('a worker takes the home\'s agent configuration over the link into its agent homes, its overrides last, before the push resolves', async () => {
    const mac = macHome();
    const worker = farHome();
    const w = world({ mirror: { home: mac, worker } });
    stops.push(() => w.stop());
    await w.link();
    await w.home.links.pushMirror(W);
    expect(read(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toBe('review it\n');
    expect(read(path.join(worker.homedir, '.agents/skills/lint/SKILL.md'))).toBe('lint\n');
    expect(read(path.join(worker.agentProfiles, 'reviewer.md'))).toBe('a reviewer\n');
    expect(read(path.join(worker.claudeDir, 'CLAUDE.md'))).toBe('# this worker\n');
    expect(json(path.join(worker.claudeDir, 'settings.json'))).toMatchObject({ model: 'sonnet', theme: 'dark', hooks: FAR_HOOKS, env: { HTTPS_PROXY: 'http://proxy:3128' } });
    // each blob's folder under the worker's cache goes once applied, the one the link's own push sent too
    await until(() => expect(fs.readdirSync(w.worker.paths.cache, { withFileTypes: true }).filter((f) => f.isDirectory() && f.name.startsWith('mirror-'))).toEqual([]));
  });

  it('takeBackCopies empties each value the record holds as copied while it is still the copy, as an untick leaves it, and leaves a value the worker set itself', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const project = path.join(mac.homedir, 'code/app');
    editJson(mac.claudeJson, (j) => { j.projects[project].mcpServers.db.env = { DB_PASSWORD: 'db_pass_1234567890' }; });
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const consent = new Set([
      'claude:mcp:linear#env.LINEAR_API_KEY', `claude:mcp:db@${project}#env.DB_PASSWORD`, 'claude:settings#env.ANTHROPIC_API_KEY', 'codex:mcp:github#env.GITHUB_TOKEN',
      'codex:config#model_providers.acme.http_headers.X-Key', 'opencode:config#provider.openai.options.apiKey',
    ]);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    applyMirror(path.join(scratch, 'blob'), o);
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'worker-own'; });
    const toml = path.join(worker.codexDir, 'config.toml');
    const settings = path.join(worker.claudeDir, 'settings.json');
    const jsonc = path.join(worker.opencodeDir, 'opencode.jsonc');
    expect(takeBackCopies(o).sort()).toEqual([
      `took 1 key the mirror copied out of ${jsonc}`, `took 1 key the mirror copied out of ${settings}`, `took 1 key the mirror copied out of ${worker.claudeJson}`,
      `took 2 keys the mirror copied out of ${toml}`, `left 1 key the mirror copied in ${worker.claudeJson}, which changed there since`,
    ].sort());
    const claude = json(worker.claudeJson);
    expect(claude.mcpServers.linear.env.LINEAR_API_KEY).toBe('worker-own');
    expect(Object.values(claude.projects).map((p: any) => p.mcpServers.db.env)).toEqual([{ DB_PASSWORD: '${DB_PASSWORD}' }]);
    expect(json(settings).env).toEqual({ HTTPS_PROXY: 'http://proxy:3128' });
    const codex = parseToml(read(toml)) as any;
    expect([codex.mcp_servers.github.env, codex.mcp_servers.github.env_vars, codex.model_providers.acme.http_headers]).toEqual([{}, ['GITHUB_TOKEN'], { 'X-Key': '' }]);
    expect(json(jsonc).provider.openai.options.apiKey).toBe('');
    expect(takeBackCopies(o)).toEqual([`left 1 key the mirror copied in ${worker.claudeJson}, which changed there since`]);
  });
  it('takeBackCopies removes a server copied whole, a plugin file holding a ticked key while each is still the copy, and a blob left beside the record; it leaves one the worker changed', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    editJson(mac.claudeJson, (j) => {
      j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } };
      j.mcpServers.mine = { command: 'mine', sandbox: { token: 'mine_token_1234567890' } };
    });
    fs.appendFileSync(path.join(mac.codexDir, 'config.toml'), '\n[mcp_servers.tbl]\ncommand = "tbl"\nenv = { TBL_KEY = "tbl_key_1234567890" }\nlabel = "tbl"\n');
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const consent = new Set([
      'claude:mcp:odd#command', 'claude:mcp:odd#sandbox', 'claude:mcp:mine#command', 'claude:mcp:mine#sandbox',
      'codex:mcp:tbl#command', 'codex:mcp:tbl#env', 'codex:mcp:tbl#label', 'claude:plugin:acme#env', 'claude:plugin:acme:mcp:pdf#env.PDF_KEY',
    ]);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    applyMirror(path.join(scratch, 'blob'), o);
    const toml = path.join(worker.codexDir, 'config.toml');
    const mcp = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const settings = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json');
    expect([json(worker.claudeJson).mcpServers.odd, (parseToml(read(toml)) as any).mcp_servers.tbl.label, read(mcp).includes('pdf_key_1234567890'), json(settings).env])
      .toEqual([{ command: 'odd', sandbox: { token: 'odd_token_1234567890' } }, 'tbl', true, { ACME_KEY: 'acme_1234567890abcd' }]);
    editJson(worker.claudeJson, (j) => { j.mcpServers.mine.command = 'mine-here'; });
    put(path.join(scratch, 'mirror-left/claude/.claude.json'), '{}');
    expect(takeBackCopies(o).sort()).toEqual([
      `removed 1 mirror blob left in ${scratch}`,
      `removed ${mcp}, which held keys the mirror copied`, `removed ${settings}, which held keys the mirror copied`,
      `took 1 server the mirror copied whole out of ${toml}`, `took 1 server the mirror copied whole out of ${worker.claudeJson}`,
      `left 1 server the mirror copied whole in ${worker.claudeJson}, which changed there since`,
    ].sort());
    expect(json(worker.claudeJson).mcpServers).not.toHaveProperty('odd');
    expect(json(worker.claudeJson).mcpServers.mine).toEqual({ command: 'mine-here', sandbox: { token: 'mine_token_1234567890' } });
    expect((parseToml(read(toml)) as any).mcp_servers).not.toHaveProperty('tbl');
    expect([fs.existsSync(mcp), fs.existsSync(settings), fs.existsSync(path.join(scratch, 'mirror-left'))]).toEqual([false, false, false]);
    expect(takeBackCopies(o)).toEqual([`left 1 server the mirror copied whole in ${worker.claudeJson}, which changed there since`]);
  });

  it('takeBackCopies leaves each copied value as an untick leaves it, by the kind of leaf its record keeps: a url, arg and header keep the rest, an env key its reference, in a server named env too', async () => {
    const mac = macHome();
    editJson(mac.claudeJson, (j) => {
      j.mcpServers.env = { type: 'http', url: 'https://x.test/mcp?token=tk_fake_1234567890&mode=a', headers: { 'X-Key': 'hk_fake_1234567890' } };
      j.mcpServers.cli = { command: 'cli', args: ['--api-key=ak_fake_1234567890', '--verbose'] };
    });
    fs.appendFileSync(path.join(mac.codexDir, 'config.toml'), '\n[mcp_servers.env]\nurl = "https://c.test/mcp?key=ck_fake_1234567890&v=1"\n');
    const consent = new Set([
      'claude:mcp:env#url.token', 'claude:mcp:env#headers.X-Key', 'claude:mcp:cli#args[--api-key]', 'claude:mcp:linear#env.LINEAR_API_KEY', 'codex:mcp:env#url.key',
      'codex:mcp:github#env.GITHUB_TOKEN', 'claude:settings#env.ANTHROPIC_API_KEY',
    ]);
    const scratch = makeHome();
    const blob = async (name: string, c: Set<string>) => {
      await packMirror(mirrorPlan(mac, c), path.join(scratch, `${name}.tar`));
      await unpack(path.join(scratch, `${name}.tar`), path.join(scratch, name));
      return path.join(scratch, name);
    };
    const [ticked, unticked] = [await blob('ticked', consent), await blob('unticked', new Set())];
    const taken = farHome();
    const untick = farHome();
    const at = (h: ReturnType<typeof farHome>) => ({ ...h, stateFile: path.join(h.homedir, 'state.json'), varsFile: path.join(h.homedir, 'vars.json') });
    applyMirror(ticked, at(taken)); takeBackCopies(at(taken));
    applyMirror(ticked, at(untick)); applyMirror(unticked, at(untick));
    const docs = (h: ReturnType<typeof farHome>) => JSON.stringify([
      json(h.claudeJson).mcpServers, (parseToml(read(path.join(h.codexDir, 'config.toml'))) as any).mcp_servers, json(path.join(h.claudeDir, 'settings.json')).env,
    ]).replaceAll(h.homedir, '~');
    expect(docs(taken)).toEqual(docs(untick));
    expect(json(taken.claudeJson).mcpServers.env).toEqual({ type: 'http', url: 'https://x.test/mcp?token=&mode=', headers: { 'X-Key': '' } });
    expect((parseToml(read(path.join(taken.codexDir, 'config.toml'))) as any).mcp_servers.env).toEqual({ url: 'https://c.test/mcp?key=&v=' });
  });

  it('takeBackCopies empties a ticked key in place in a file the agent needs, where it lies there: a marketplace list the worker moved and updated keeps its marketplaces, a subagent its servers and prompt', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const source = { source: 'url', url: 'https://x.test/m.json', headers: { Authorization: 'Bearer mh_fake_1234567890' } };
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.extraKnownMarketplaces = { x: { source } }; });
    editJson(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), (j) => { j.x = { source, installLocation: path.join(mac.claudeDir, 'plugins/marketplaces/x') }; });
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'mp', plugins: [{ name: 'acme', source: './acme' }, { name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headers: { Authorization: 'Bearer mk_fake_1234567890' } }],
    }));
    put(path.join(mac.claudeDir, 'agents/db.md'), ['---', 'name: db', 'mcpServers:', '  - github', '  - pg:', '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890', '---', 'the agent', ''].join('\n'));
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const consent = new Set(['claude:settings#extraKnownMarketplaces.x.source.headers.Authorization', 'claude:marketplace:mp#plugins.zip', 'claude:agent:db.md#mcpServers.pg']);
    await packMirror(mirrorPlan(mac, consent), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    applyMirror(path.join(scratch, 'blob'), o);
    const list = path.join(worker.claudeDir, 'plugins/known_marketplaces.json');
    const market = path.join(worker.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json');
    const agent = path.join(worker.claudeDir, 'agents/db.md');
    expect([read(list), read(market), read(agent)].map((t) => /mh_fake|mk_fake|pg_fake/.test(t))).toEqual([true, true, true]);
    // Claude on the worker updates its list itself
    editJson(list, (j) => { j.x.lastUpdated = '2026-10-27T00:00:00.000Z'; });
    expect(takeBackCopies(o).filter((l) => [list, market, agent].some((f) => l.endsWith(f))).sort()).toEqual([agent, list, market].map((f) => `took 1 key the mirror copied out of ${f}`).sort());
    expect(json(list)).toEqual({
      mp: expect.objectContaining({ installLocation: path.join(worker.claudeDir, 'plugins/marketplaces/mp') }),
      x: { source: { ...source, headers: { Authorization: '' } }, installLocation: path.join(worker.claudeDir, 'plugins/marketplaces/x'), lastUpdated: '2026-10-27T00:00:00.000Z' },
    });
    expect(json(market).plugins[1].headers).toEqual({ Authorization: '' });
    expect([agentServers(read(agent)), read(agent).startsWith('---\nname: db\n'), read(agent).endsWith('---\nthe agent\n')])
      .toEqual([[['pg', { command: 'npx', env: { PG_PASSWORD: '${PG_PASSWORD}' } }]], true, true]);
    expect(takeBackCopies(o).filter((l) => [list, market, agent].some((f) => l.endsWith(f)))).toEqual([]);
  });

  it('takeBackCopies takes a ticked key back where it alone lies now when an item added above moved it, and warns where the copy lies twice', async () => {
    const mac = macHome();
    const scratch = makeHome();
    const md = (...servers: string[]) => ['---', 'name: db', 'mcpServers:', '  - github', ...servers, '---', 'the agent', ''].join('\n');
    const pg = (name: string) => [`  - ${name}:`, '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890'];
    const entries = (...extra: object[]) => JSON.stringify({ name: 'mp', plugins: [...extra, { name: 'zip', source: { source: 'url', url: 'https://z.test/z.zip' }, headers: { Authorization: 'Bearer mk_fake_1234567890' } }] });
    put(path.join(mac.claudeDir, 'agents/db.md'), md(...pg('pg')));
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), entries());
    await packMirror(mirrorPlan(mac, new Set(['claude:agent:db.md#mcpServers.pg', 'claude:marketplace:mp#plugins.zip'])), path.join(scratch, 'mirror.tar'));
    await unpack(path.join(scratch, 'mirror.tar'), path.join(scratch, 'blob'));
    const worker = (twin: boolean) => {
      const h = farHome();
      const o = { ...h, stateFile: path.join(h.homedir, 'state.json'), varsFile: path.join(h.homedir, 'vars.json') };
      applyMirror(path.join(scratch, 'blob'), o);
      const files = { agent: path.join(h.claudeDir, 'agents/db.md'), market: path.join(h.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json') };
      put(files.agent, md(...(twin ? pg('twin') : ['  - other:', '      command: x']), ...pg('pg')));
      put(files.market, entries({ name: 'new', source: './new' }));
      return { o, ...files };
    };
    const moved = worker(false);
    expect(takeBackCopies(moved.o).filter((l) => [moved.agent, moved.market].some((f) => l.includes(f))).sort())
      .toEqual([moved.agent, moved.market].map((f) => `took 1 key the mirror copied out of ${f}`).sort());
    expect([/pg_fake/.test(read(moved.agent)), json(moved.market).plugins[1].headers]).toEqual([false, { Authorization: '' }]);
    const twins = worker(true);
    expect(takeBackCopies(twins.o).filter((l) => l.includes(twins.agent))).toEqual([`left ${twins.agent}, which holds keys the mirror copied and changed there since`]);
    expect(read(twins.agent)).toContain('pg_fake');
  });

  it('a plugin\'s subagent its plugin.json names by path is listed whole as one in agents/ is', () => {
    const mac = macHome();
    const acme = path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', agents: ['./reviewers/db.md'] }));
    put(path.join(acme, 'reviewers/db.md'), ['---', 'name: db', 'mcpServers:', '  pg:', '    command: npx', '    env:', '      PG_PASSWORD: custom_agent_fake_123', '---', 'b', ''].join('\n'));
    const plan = mirrorPlan(mac);
    const rel = 'plugins/cache/mp/acme/1.0.0/reviewers/db.md';
    expect(plan.plugins).toEqual([{ key: `claude:agent:${rel}`, name: rel, fields: ['mcpServers.pg'], ticked: false, files: [path.join(mac.claudeDir, rel)] }]);
    expect(plan.files.filter((f) => f.from.endsWith('reviewers/db.md'))).toEqual([]);
  });

  it('takeBackCopies says nothing of a key the worker set itself where the user unticked the copy, nor of a record without the bare form of its value', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json') };
    const apply = async (name: string, consent: Set<string>) => {
      await packMirror(mirrorPlan(mac, consent), path.join(scratch, `${name}.tar`));
      await unpack(path.join(scratch, `${name}.tar`), path.join(scratch, name));
      applyMirror(path.join(scratch, name), o);
    };
    await apply('ticked', new Set(['claude:mcp:linear#env.LINEAR_API_KEY']));
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'worker-own'; });
    await apply('unticked', new Set());
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('worker-own');
    expect(takeBackCopies(o)).toEqual([]);
    editJson(worker.claudeJson, (j) => { j.mcpServers.cli = { command: 'cli', args: ['--api-key='] }; });
    put(o.stateFile, JSON.stringify({ files: {}, docs: {}, servers: {}, secrets: { [JSON.stringify(['.claude.json', 'mcpServers', 'cli', 'args', 0])]: sha256Hex('--api-key=ak_fake_1234567890') } }));
    expect(takeBackCopies(o)).toEqual([]);
  });

  it('an apply older than the last one applied is refused once it takes the agent files, its blob dropped, so an untick pushed after it stays', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const stage = path.join(scratch, 'cache');
    const tar = async (name: string, consent: Set<string>) => {
      await packMirror(mirrorPlan(mac, consent), path.join(scratch, name));
      return path.join(scratch, name);
    };
    const tars: Record<string, string> = { old: await tar('old.tar', new Set(['claude:mcp:linear#env.LINEAR_API_KEY'])), new: await tar('new.tar', new Set()) };
    const arrive = new Map<string, () => void>();
    const connection = {
      receiveBlob: (id: string, into: string) => new Promise<{ sha256: string }>((resolve) => {
        arrive.set(id, () => { fs.copyFileSync(tars[id], into); void fileSha(into).then((sha256) => resolve({ sha256 })); });
      }),
    };
    const m = mirrorCalls({ ...worker, stage, stateFile: path.join(stage, 'mirror-state.json'), varsFile: path.join(stage, 'mirror-vars.json'), envFile: path.join(stage, '.env'), connection, log: silentLogger });
    await m.calls['config.blob']({ id: 'old', sha256: await fileSha(tars.old) });
    const old = m.calls['config.apply']({ id: 'old', seq: 1 });
    await m.calls['config.blob']({ id: 'new', sha256: await fileSha(tars.new) });
    const applied = m.calls['config.apply']({ id: 'new', seq: 2 });
    arrive.get('new')!();
    await applied;
    arrive.get('old')!();
    await expect(old).rejects.toMatchObject({ code: 'stale' });
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    expect(fs.readdirSync(stage).filter((f) => f.startsWith('mirror-') && fs.statSync(path.join(stage, f)).isDirectory())).toEqual([]);
  });

  it('an apply still waiting for the agent files when its link closes is abandoned and its blob dropped', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const stage = path.join(scratch, 'cache');
    const file = path.join(scratch, 'm.tar');
    await packMirror(mirrorPlan(mac, new Set(['claude:mcp:linear#env.LINEAR_API_KEY'])), file);
    const connection = { receiveBlob: async (_id: string, into: string) => { fs.copyFileSync(file, into); return { sha256: await fileSha(into) }; } };
    const m = mirrorCalls({ ...worker, stage, stateFile: path.join(stage, 'mirror-state.json'), varsFile: path.join(stage, 'mirror-vars.json'), envFile: path.join(stage, '.env'), connection, log: silentLogger });
    const unlock = await lockAgentFiles(worker.homedir);
    await m.calls['config.blob']({ id: 'one', sha256: await fileSha(file) });
    const apply = m.calls['config.apply']({ id: 'one', seq: 1 });
    apply.catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    m.linkLost();
    await expect(apply).rejects.toThrow();
    unlock();
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(worker.claudeJson)).toBe(false);
    expect(fs.readdirSync(stage).filter((f) => f.startsWith('mirror-'))).toEqual([]);
  });


  it('a mirror blob a daemon left in its cache goes at the next start, beside the record it keeps; a blob not yet applied goes when its link closes', async () => {
    const stage = path.join(makeHome(), 'cache');
    for (const f of ['mirror-abc123/mirror.tar', 'mirror-abc123/blob/mirror.json', 'docs-xyz/a.tar']) put(path.join(stage, f), 'x');
    put(path.join(stage, 'mirror-state.json'), '{}'); put(path.join(stage, 'mirror-vars.json'), '[]');
    const connection = { receiveBlob: async (_id: string, into: string) => { put(into, 'tar'); return { sha256: '0'.repeat(64) }; } };
    const m = mirrorCalls({ ...farHome(), stage, stateFile: path.join(stage, 'mirror-state.json'), varsFile: path.join(stage, 'mirror-vars.json'), envFile: path.join(stage, '.env'), connection, log: silentLogger });
    expect(fs.readdirSync(stage).sort()).toEqual(['docs-xyz', 'mirror-state.json', 'mirror-vars.json']);
    await m.calls['config.blob']({ id: 'mirror_1', sha256: '0'.repeat(64) });
    expect(fs.readdirSync(stage).filter((f) => f.startsWith('mirror-') && fs.statSync(path.join(stage, f)).isDirectory())).toHaveLength(1);
    m.linkLost();
    expect(fs.readdirSync(stage).sort()).toEqual(['docs-xyz', 'mirror-state.json', 'mirror-vars.json']);
    await expect(m.calls['config.apply']({ id: 'mirror_1', seq: 1 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('consent is per field: a new secret field on a ticked server is not ticked; setConsent off clears the item and no other; clearConsent clears the machine; mask', () => {
    const file = path.join(makeHome(), 'mirror-consent.json');
    setConsent(file, W, 'claude:plugin:acme', ['env'], true); setConsent(file, W, 'claude:plugin:acme:mcp:pdf', ['env.PDF_KEY'], true);
    setConsent(file, W, 'claude:plugin:acme', [], false);
    expect([...readConsent(file, W)]).toEqual(['claude:plugin:acme:mcp:pdf#env.PDF_KEY']);
    setConsent(file, W, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    // short of every field: off
    expect(tickedFields(readConsent(file, W), 'claude:mcp:linear', ['env.LINEAR_API_KEY', 'env.NEW_KEY'])).toEqual(['env.LINEAR_API_KEY']);
    setConsent(file, H, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true); clearConsent(file, W);
    expect([...readConsent(file, W)]).toEqual([]); expect([...readConsent(file, H)]).toEqual(['claude:mcp:linear#env.LINEAR_API_KEY']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(mask('lin_api_1234567890')).toBe('lin…90'); expect(mask('short-value')).toBe('••••');
  });
});

describe('the mirror over the link carries servers, plugins and each agent\'s config by key, only what changed, with keys only where ticked', () => {
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
  const push = () => w.home.mirror!.push(w.home.links.for(W)!);
  const tick = (item: string, fields: string[], on: boolean) => setConsent(w.home.paths.mirrorConsent, W, item, fields, on);
  const workerJson = () => json(worker.claudeJson);
  const setWorkerServer = (name: string, fields: Record<string, unknown>) => editJson(worker.claudeJson, (j) => { Object.assign(j.mcpServers[name], fields); });
  const codexToml = () => parseToml(read(path.join(worker.codexDir, 'config.toml'))) as any;

  it('a ticked field travels, an unticked one arrives emptied, and unticking later empties it on the next push', async () => {
    expect(workerJson().mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); await push();
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    tick('claude:mcp:linear', [], false); await push();
    expect(workerJson().mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
  });

  it('an unticked field keeps the worker\'s own non-empty value; a copied value an agent wrote back after the untick is emptied on the next push', async () => {
    setWorkerServer('linear', { env: { LINEAR_API_KEY: 'worker-own' } }); await push();
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('worker-own');
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); await push(); tick('claude:mcp:linear', [], false); await push();
    setWorkerServer('linear', { env: { LINEAR_API_KEY: 'lin_api_1234567890' } }); await push();
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
  });

  it('an unticked field\'s own value on the worker survives the Mac changing its server', async () => {
    setWorkerServer('linear', { env: { LINEAR_API_KEY: 'worker-own' } });
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.args.push('--verbose'); }); await push();
    expect(workerJson().mcpServers.linear).toEqual({ command: 'npx', args: ['-y', 'linear-mcp', '--verbose'], env: { LINEAR_API_KEY: 'worker-own' } });
  });

  it('an empty env value on the Mac is ${E} on the worker', async () => {
    await push();
    expect(workerJson().mcpServers.empty.env.E).toBe('${E}');
  });

  it('a second push with nothing changed sends no file and rewrites nothing; a worker-side edit survives until the Mac changes', async () => {
    await push();
    const before = statsOf(mirroredFiles(worker));
    expect((await push()).sent).toBe(0);
    expect(statsOf(mirroredFiles(worker))).toEqual(before);
    put(path.join(worker.claudeDir, 'rules/style.md'), 'edited here\n'); await push();
    expect(read(path.join(worker.claudeDir, 'rules/style.md'))).toBe('edited here\n');
    put(path.join(mac.claudeDir, 'rules/style.md'), 'changed on the Mac\n'); await push();
    expect(read(path.join(worker.claudeDir, 'rules/style.md'))).toBe('changed on the Mac\n');
  });

  it('a settings key edited on the worker stays until the Mac changes that key; one the Mac drops leaves the worker', async () => {
    const settings = path.join(worker.claudeDir, 'settings.json');
    editJson(settings, (j) => { j.theme = 'light'; }); await push();
    expect(json(settings)).toMatchObject({ theme: 'light' });
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.theme = 'solarized'; }); await push();
    expect(json(settings)).toMatchObject({ theme: 'solarized' });
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { delete j.theme; }); await push();
    expect(json(settings)).not.toHaveProperty('theme');
  });

  it('a server gone from the Mac leaves the worker; one the worker added by hand stays; a recorded one deleted on the worker is written again; a removed file goes', async () => {
    editJson(worker.claudeJson, (j) => { j.mcpServers.mine = { command: 'x' }; delete j.mcpServers.linear; });
    editJson(mac.claudeJson, (j) => { delete j.mcpServers.remote; }); fs.rmSync(path.join(mac.claudeDir, 'rules/style.md')); await push();
    expect(Object.keys(workerJson().mcpServers).sort()).toEqual(['empty', 'linear', 'mine']);
    expect(fs.existsSync(path.join(worker.claudeDir, 'rules/style.md'))).toBe(false);
  });

  it('a worker without its .claude.json gets {"mcpServers":{…}} there, and claudeAdapter.trusts still reads it', async () => {
    expect(workerJson()).toEqual({ mcpServers: {
      linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' } },
      remote: { type: 'http', url: 'https://remote.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } },
      empty: { command: 'npx', args: ['-y', 'empty-mcp'], env: { E: '${E}' } },
    } });
    expect(fs.existsSync(path.join(worker.homedir, '.claude.json'))).toBe(false);
    const app = path.join(worker.homedir, 'code/app');
    fs.mkdirSync(app, { recursive: true });
    expect(await seedTrust('claude', app, { agentHome: worker.claudeDir, agentRunning: async () => false })).toBe('seeded');
    editJson(mac.claudeJson, (j) => { j.mcpServers.extra = { command: 'npx', args: ['extra-mcp'] }; }); await push();
    expect(claudeAdapter.trusts!(worker.claudeDir, { cwd: app })).toBe(true);
    expect(workerJson().mcpServers.extra).toEqual({ command: 'npx', args: ['extra-mcp'] });
  });

  it('Codex config.toml keeps the worker\'s [projects] and [hooks], drops the Mac\'s notify, [desktop], [marketplaces] and [plugins], carries the rest by key, and http_headers only when ticked', async () => {
    const file = path.join(worker.codexDir, 'config.toml');
    expect(codexToml().model_providers.acme.http_headers).toEqual({ 'X-Key': '' });
    const own = { projects: { '/home/ada/code': { trust_level: 'trusted' } }, hooks: { state: { command: '/home/ada/.svall/hooks/hook' } }, notify: ['/home/ada/notify'] };
    fs.writeFileSync(file, stringifyToml({ ...codexToml(), ...own }));
    tick('codex:config', ['model_providers.acme.http_headers.X-Key'], true); await push();
    const toml = codexToml();
    expect(toml).toMatchObject({ ...own, model: 'gpt-5', model_providers: { acme: { name: 'Acme', base_url: 'https://acme.test/v1', http_headers: { 'X-Key': 'acme_key_1234567890' } } } });
    for (const gone of ['desktop', 'marketplaces', 'plugins']) expect(toml).not.toHaveProperty(gone);
    expect(toml.mcp_servers).toEqual({ github: { command: 'npx', args: ['-y', 'github-mcp'], cwd: path.join(worker.homedir, 'code'), env: {}, env_vars: ['GITHUB_TOKEN'] } });
  });

  it('opencode.jsonc merges by key, the Mac\'s plugin list included, and keeps the worker\'s own mcp entries and Svall\'s plugin file', async () => {
    editJson(path.join(worker.opencodeDir, 'opencode.jsonc'), (j) => { j.mcp.mine = { type: 'local', command: ['x'] }; }); await push();
    expect(json(path.join(worker.opencodeDir, 'opencode.jsonc'))).toMatchObject({
      plugin: ['oc-plugin'], mcp: { ctx: expect.any(Object), mine: { type: 'local', command: ['x'] } }, provider: { openai: { options: { apiKey: '' } } },
    });
    expect(read(path.join(worker.opencodeDir, `plugins/${SHIM}.js`))).toBe('// svall there\n');
    expect(fs.existsSync(path.join(worker.opencodeDir, 'plugins/mine.js'))).toBe(true);
  });

  it('plugins: installed_plugins.json and known_marketplaces.json land with their paths moved and no git login, the install tree travels, its .mcp.json redacted unless ticked; a marketplace server file holding a key stays on the Mac', async () => {
    const acme = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    expect(json(path.join(worker.claudeDir, 'plugins/installed_plugins.json'))).toMatchObject({ plugins: { acme: [{ installPath: acme }] } });
    expect(json(path.join(worker.claudeDir, 'plugins/known_marketplaces.json')))
      .toMatchObject({ mp: { installLocation: path.join(worker.claudeDir, 'plugins/marketplaces/mp'), source: { url: 'https://git.test/mp.git' } } });
    expect(read(path.join(acme, 'skills/pdf/SKILL.md'))).toBe('pdf\n');
    expect(json(path.join(acme, '.mcp.json'))).toMatchObject({ mcpServers: { pdf: { env: { PDF_KEY: '${PDF_KEY}' } } } });
    tick('claude:plugin:acme:mcp:pdf', ['env.PDF_KEY'], true); await push();
    expect(json(path.join(acme, '.mcp.json'))).toMatchObject({ mcpServers: { pdf: { env: { PDF_KEY: 'pdf_key_1234567890' } } } });
    tick('claude:plugin:acme:mcp:pdf', [], false); await push();
    expect(json(path.join(acme, '.mcp.json'))).toMatchObject({ mcpServers: { pdf: { env: { PDF_KEY: '${PDF_KEY}' } } } });
    expect(fs.existsSync(path.join(worker.claudeDir, 'plugins/marketplaces/mp/acme/.mcp.json'))).toBe(false);
    expect(mirrorPlan(mac).skipped).toContain(marketKey(mac));
  });

  it('project servers land only under projects the worker has; command, args and cwd under the home are moved', async () => {
    expect(workerJson()).not.toHaveProperty('projects');
    const app = path.join(worker.homedir, 'code/app');
    fs.mkdirSync(app, { recursive: true });
    await push();
    expect(workerJson().projects[realPath(app)].mcpServers.db).toEqual({ command: path.join(worker.homedir, '.local/bin/db-mcp'), args: ['--db', path.join(app, 'db.sqlite')] });
    expect(codexToml().mcp_servers.github.cwd).toBe(path.join(worker.homedir, 'code'));
  });

  it('settings env keys travel only when ticked, never over a key the worker set itself, and go when unticked', async () => {
    const settings = path.join(worker.claudeDir, 'settings.json');
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.env.HTTPS_PROXY = 'http://mac-proxy:3128'; }); await push();
    expect(json(settings).env).toEqual({ HTTPS_PROXY: 'http://proxy:3128' });
    tick('claude:settings', ['env.ANTHROPIC_API_KEY', 'env.HTTPS_PROXY'], true); await push();
    expect(json(settings).env).toEqual({ HTTPS_PROXY: 'http://proxy:3128', ANTHROPIC_API_KEY: 'sk-mac' });
    tick('claude:settings', [], false); await push();
    expect(json(settings).env).toEqual({ HTTPS_PROXY: 'http://proxy:3128' });
  });

  it('a ticked Codex env key lands in env and leaves env_vars; unticked it goes back to env_vars', async () => {
    tick('codex:mcp:github', ['env.GITHUB_TOKEN'], true); await push();
    expect(codexToml().mcp_servers.github).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_1234567890abcdef' } });
    expect(codexToml().mcp_servers.github).not.toHaveProperty('env_vars');
    tick('codex:mcp:github', [], false); await push();
    expect(codexToml().mcp_servers.github).toMatchObject({ env: {}, env_vars: ['GITHUB_TOKEN'] });
  });

  it('each of the Mac\'s opencode.json and opencode.jsonc merges into the worker\'s file of its name, each server into its own file and place', async () => {
    put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ theme: 'tokyo', mcp: { servers: { docs: { type: 'remote', url: 'https://docs.test/mcp' } } } }));
    await push();
    expect(json(path.join(worker.opencodeDir, 'opencode.json'))).toEqual({ theme: 'tokyo', mcp: { servers: { docs: { type: 'remote', url: 'https://docs.test/mcp' } } } });
    expect(json(path.join(worker.opencodeDir, 'opencode.jsonc'))).toMatchObject({ plugin: ['oc-plugin'], mcp: { ctx: { type: 'local', command: ['bunx', 'ctx-mcp'] } } });
    expect(json(path.join(worker.opencodeDir, 'opencode.jsonc'))).not.toHaveProperty('theme');
  });

  it('a config the Mac cannot read leaves the worker\'s copy and its servers as they are', async () => {
    const before = [read(worker.claudeJson), read(path.join(worker.codexDir, 'config.toml'))];
    put(mac.claudeJson, '{ "mcpServers": ');
    put(path.join(mac.codexDir, 'config.toml'), '[mcp_servers.x\n');
    await push();
    expect([read(worker.claudeJson), read(path.join(worker.codexDir, 'config.toml'))]).toEqual(before);
    expect(mirrorPlan(mac).unreadable).toEqual([mac.claudeJson, path.join(mac.codexDir, 'config.toml')]);
  });

  it('a server or plugin settings whose fields the mirror does not know travels whole only once every field is ticked, and leaves when unticked', async () => {
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } }; });
    const acmeSettings = 'plugins/cache/mp/acme/1.0.0/settings.json';
    put(path.join(mac.claudeDir, acmeSettings), JSON.stringify({ env: { ACME_KEY: 'acme_1234567890abcd' } }));
    tick('claude:mcp:odd', ['command'], true); await push();
    const plan = mirrorPlan(mac, readConsent(w.home.paths.mirrorConsent, W));
    expect(plan.servers.find((s) => s.name === 'odd')).toMatchObject({ known: false, secretFields: [], ticked: ['command'], entry: {} });
    expect(plan.plugins).toEqual([{ key: 'claude:plugin:acme', name: "acme's config", fields: ['env'], ticked: false, files: [path.join(mac.claudeDir, acmeSettings)] }]);
    expect(workerJson().mcpServers).not.toHaveProperty('odd');
    expect(fs.existsSync(path.join(worker.claudeDir, acmeSettings))).toBe(false);
    tick('claude:mcp:odd', ['sandbox'], true); tick('claude:plugin:acme', ['env'], true); await push();
    expect(workerJson().mcpServers.odd).toEqual({ command: 'odd', sandbox: { token: 'odd_token_1234567890' } });
    expect(json(path.join(worker.claudeDir, acmeSettings))).toEqual({ env: { ACME_KEY: 'acme_1234567890abcd' } });
    tick('claude:mcp:odd', [], false); tick('claude:plugin:acme', [], false); await push();
    expect(workerJson().mcpServers).not.toHaveProperty('odd');
    expect(fs.existsSync(path.join(worker.claudeDir, acmeSettings))).toBe(false);
  });

  it('a copied value whose field the Mac no longer holds as a key leaves the worker on the next push: a dropped settings env key, a literal turned into ${VAR}, a Codex key moved to env_vars', async () => {
    tick('claude:settings', ['env.ANTHROPIC_API_KEY'], true); tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); tick('codex:mcp:github', ['env.GITHUB_TOKEN'], true);
    await push();
    expect(json(path.join(worker.claudeDir, 'settings.json')).env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-mac' });
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    expect(codexToml().mcp_servers.github.env).toEqual({ GITHUB_TOKEN: 'ghp_1234567890abcdef' });
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { delete j.env.ANTHROPIC_API_KEY; });
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = '${LINEAR_API_KEY}'; });
    const toml = path.join(mac.codexDir, 'config.toml');
    fs.writeFileSync(toml, read(toml).replace('env = { GITHUB_TOKEN = "ghp_1234567890abcdef" }', 'env = {}\nenv_vars = ["GITHUB_TOKEN"]'));
    await push();
    expect(json(path.join(worker.claudeDir, 'settings.json')).env).toEqual({ HTTPS_PROXY: 'http://proxy:3128' });
    expect(workerJson().mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
    expect(codexToml().mcp_servers.github).toMatchObject({ env: {}, env_vars: ['GITHUB_TOKEN'] });
  });

  it('a plugin list or server file the Mac cannot read leaves the worker\'s plugin files as the mirror last wrote them', async () => {
    const acme = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    const list = path.join(mac.claudeDir, 'plugins/installed_plugins.json');
    const good = read(list);
    put(list, '{ "plugins": '); await push();
    expect(read(path.join(acme, 'skills/pdf/SKILL.md'))).toBe('pdf\n');
    expect(json(path.join(acme, '.mcp.json'))).toMatchObject({ mcpServers: { pdf: { env: { PDF_KEY: '${PDF_KEY}' } } } });
    expect(json(path.join(worker.claudeDir, 'plugins/installed_plugins.json'))).toMatchObject({ plugins: { acme: [{ installPath: acme }] } });
    put(list, good);
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json'), '{ "mcpServers": '); await push();
    expect(json(path.join(acme, '.mcp.json'))).toMatchObject({ mcpServers: { pdf: { env: { PDF_KEY: '${PDF_KEY}' } } } });
  });

  it('the worker\'s overrides of .claude.json servers, config.toml and an OpenCode file are merged last, and stay as they are', async () => {
    const files = ['claude/.claude.json', 'codex/config.toml', 'opencode/opencode.jsonc'].map((f) => path.join(worker.overrides, f));
    put(files[0], JSON.stringify({ mcpServers: { linear: { env: { LINEAR_API_KEY: 'worker-key' } }, mine: { command: 'mine' } }, theme: 'x' }));
    put(files[1], 'model = "o3"\n\n[mcp_servers.github]\nstartup_timeout_sec = 30\n');
    put(files[2], JSON.stringify({ theme: 'mine' }));
    const before = files.map(read);
    await push();
    expect(workerJson().mcpServers).toMatchObject({ linear: { command: 'npx', env: { LINEAR_API_KEY: 'worker-key' } }, mine: { command: 'mine' } });
    expect(workerJson()).not.toHaveProperty('theme');
    expect(codexToml()).toMatchObject({ model: 'o3', mcp_servers: { github: { command: 'npx', startup_timeout_sec: 30 } } });
    expect(json(path.join(worker.opencodeDir, 'opencode.jsonc'))).toMatchObject({ theme: 'mine', plugin: ['oc-plugin'] });
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.args.push('--verbose'); });
    put(path.join(mac.codexDir, 'config.toml'), read(path.join(mac.codexDir, 'config.toml')).replace('model = "gpt-5"', 'model = "gpt-6"'));
    await push();
    expect(workerJson().mcpServers.linear).toMatchObject({ args: ['-y', 'linear-mcp', '--verbose'], env: { LINEAR_API_KEY: 'worker-key' } });
    expect(codexToml().model).toBe('o3');
    expect(files.map(read)).toEqual(before);
  });

  it('an OpenCode key travels when ticked and leaves when unticked, in its own file only: the other file\'s reference at that path stays', async () => {
    put(path.join(mac.opencodeDir, 'opencode.json'), JSON.stringify({ provider: { openai: { options: { apiKey: '{env:OPENAI_KEY}' } } } }));
    await push();
    const apiKey = (f: string) => json(path.join(worker.opencodeDir, f)).provider.openai.options.apiKey;
    expect([apiKey('opencode.json'), apiKey('opencode.jsonc')]).toEqual(['{env:OPENAI_KEY}', '']);
    tick('opencode:config', ['provider.openai.options.apiKey'], true); await push();
    expect([apiKey('opencode.json'), apiKey('opencode.jsonc')]).toEqual(['{env:OPENAI_KEY}', 'sk-oc-1234567890']);
    tick('opencode:config', [], false); await push();
    expect([apiKey('opencode.json'), apiKey('opencode.jsonc')]).toEqual(['{env:OPENAI_KEY}', '']);
  });

  it('an apply waits while another fleet\'s mirror holds this user\'s agent files', async () => {
    const unlock = await lockAgentFiles(worker.homedir);
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    let done = false;
    const pushed = push().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 600));
    expect([done, workerJson().mcpServers.linear.env.LINEAR_API_KEY]).toEqual([false, '${LINEAR_API_KEY}']);
    unlock();
    await pushed;
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
  });

  it('two pushes at once go one after the other, each whole', async () => {
    const link = w.home.links.for(W)!;
    const calls: string[] = [];
    const spy = {
      machine: link.machine,
      sendBlob: (id: string, file: string | Buffer) => link.sendBlob(id, file),
      call<T>(method: string, params: unknown, o?: Parameters<typeof link.call>[2]): Promise<T> {
        calls.push(`${method}>`);
        return link.call<T>(method, params, o).finally(() => calls.push(`<${method}`));
      },
    };
    const first = w.home.mirror!.push(spy);
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    await Promise.all([first, w.home.mirror!.push(spy)]);
    const one = ['config.state>', '<config.state', 'config.blob>', '<config.blob', 'config.apply>', '<config.apply'];
    expect(calls).toEqual([...one, ...one]);
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
  });

  it('a key an apply wrote before it failed is emptied by the untick once the worker is fixed, and never reads as the worker\'s own; a key changed on the Mac too', async () => {
    const skills = path.join(worker.claudeDir, 'skills');
    const failing = async (n: number) => {
      put(path.join(mac.claudeDir, `skills/new-${n}/SKILL.md`), 'new\n');
      fs.chmodSync(skills, 0o555);
      try { await expect(push()).rejects.toThrow(); } finally { fs.chmodSync(skills, 0o755); }
    };
    const setup = () => w.home.mirror!.report(w.home.links.for(W), W, { name: 'w1', fleetFlag: '' });
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    await failing(1);
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    tick('claude:mcp:linear', [], false); await push();
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    expect((await setup()).find((r) => r.key === 'claude:mcp:linear')).toMatchObject({ status: 'warn', action: "copy linear's keys to w1" });

    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); await push();
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'lin_api_changed_0987654321'; });
    await failing(2);
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_changed_0987654321');
    tick('claude:mcp:linear', [], false); await push();
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
  });

  it('a config file or plugin server file holding a ticked key is written for its owner alone', async () => {
    const acme = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const settings = path.join(worker.claudeDir, 'settings.json');
    for (const f of [worker.claudeJson, settings, acme]) fs.chmodSync(f, 0o644);
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); tick('claude:settings', ['env.ANTHROPIC_API_KEY'], true); tick('claude:plugin:acme:mcp:pdf', ['env.PDF_KEY'], true);
    await push();
    expect([worker.claudeJson, settings, acme].map((f) => fs.statSync(f).mode & 0o777)).toEqual([0o600, 0o600, 0o600]);
  });

  it('a file holding a ticked key that an apply finds readable to others is its owner\'s alone again, its content as it was', async () => {
    const acme = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const settings = path.join(worker.claudeDir, 'settings.json');
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); tick('claude:settings', ['env.ANTHROPIC_API_KEY'], true); tick('claude:plugin:acme:mcp:pdf', ['env.PDF_KEY'], true);
    await push();
    const files = [worker.claudeJson, settings, acme];
    const before = files.map(read);
    for (const f of files) fs.chmodSync(f, 0o644);
    await push();
    expect(files.map((f) => fs.statSync(f).mode & 0o777)).toEqual([0o600, 0o600, 0o600]);
    expect(files.map(read)).toEqual(before);
  });

  it('a marketplace list the Mac cannot read keeps the files of each plugin installed from it on the worker as the mirror last wrote them', async () => {
    const acme = path.join(worker.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    editJson(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins = { 'acme@mp': j.plugins.acme }; });
    await push();
    expect(read(path.join(acme, 'skills/pdf/SKILL.md'))).toBe('pdf\n');
    put(path.join(mac.claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), '{ "plugins": ');
    await push(); await push();
    expect(read(path.join(acme, 'skills/pdf/SKILL.md'))).toBe('pdf\n');
    expect(json(path.join(acme, '.mcp.json'))).toMatchObject({ mcpServers: { pdf: { env: { PDF_KEY: '${PDF_KEY}' } } } });
  });

  it('unticking a copied env key while the Mac changes another field of its server leaves the agent\'s reference on the worker', async () => {
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true); await push();
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    tick('claude:mcp:linear', [], false);
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.args.push('--verbose'); });
    await push();
    expect(workerJson().mcpServers.linear).toEqual({ command: 'npx', args: ['-y', 'linear-mcp', '--verbose'], env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' } });
  });

  it('an apply the home gave up on that reaches the worker after a later untick is refused there, so the key stays emptied', async () => {
    const link = w.home.links.for(W)!;
    let first = true;
    let late: (() => Promise<void>) | undefined;
    let answer: Promise<unknown> | undefined;
    const spy = {
      machine: link.machine,
      sendBlob: (id: string, file: string | Buffer): Promise<void> => {
        if (!first) return link.sendBlob(id, file);
        const bytes = typeof file === 'string' ? fs.readFileSync(file) : file;
        late = () => link.sendBlob(id, bytes);
        return Promise.resolve();
      },
      call<T>(method: string, params: unknown, o?: Parameters<typeof link.call>[2]): Promise<T> {
        if (method !== 'config.apply' || !first) return link.call<T>(method, params, o);
        first = false;
        answer = link.call(method, params, o).catch((e: unknown) => e);
        return Promise.reject(new Error('the apply timed out'));
      },
    };
    tick('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    await expect(w.home.mirror!.push(spy)).rejects.toThrow('the apply timed out');
    tick('claude:mcp:linear', [], false);
    await w.home.mirror!.push(spy);
    await late!();
    expect(await answer).toMatchObject({ code: 'stale' });
    expect(workerJson().mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
  });

  it('a path too long for ustar is skipped with a line, and the push still goes', async () => {
    const deep = path.join(mac.claudeDir, 'skills', 'x'.repeat(120), 'y'.repeat(120), 'SKILL.md');
    put(deep, 'deep\n'); put(path.join(mac.claudeDir, 'rules/new.md'), 'new\n');
    expect(mirrorPlan(mac).skipped).toContain(`${deep} has a path too long for the mirror to carry`);
    await push();
    expect(read(path.join(worker.claudeDir, 'rules/new.md'))).toBe('new\n');
  });
});
