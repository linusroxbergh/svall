import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedAgentProfiles } from '../../src/agent-profiles.js';
import { answer, dispatch, type Ctx } from '../../src/api/methods.js';
import { holdsSetup, mirrorPlan, type MirrorPlan } from '../../src/placement/mirror-plan.js';
import { readState } from '../../src/placement/mirror-state.js';
import { editJson, farHome, macHome, put, read } from './mirror-homes.js';
import type { Logger } from '../../src/log.js';
import { stopWorlds, until, W, world } from './world.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await stopWorlds();
});

const call = async <T = unknown>(ctx: Ctx, method: string, params: object): Promise<T> => {
  const res = await dispatch({ id: 1, method, params } as never, ctx);
  if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result as T;
};
const SVALL_RULES = { allow: ['Bash(svall status:*)', 'Bash(svall robot new:*)'] };
const MAC_RULES = { allow: ['Bash(git:*)', 'Bash(npm test:*)'], deny: ['Read(./.env)'] };

// a server as `svall setup` and a Claude Code login leave it: no one's setup, only Svall's permission rules, its hooks, the profiles a fleet starts with and Claude Code's theme
function emptyServer() {
  const home = farHome();
  for (const dir of [home.claudeDir, home.codexDir, home.opencodeDir]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home.overrides, { recursive: true, force: true });
  put(home.claudeJson, JSON.stringify({ oauthAccount: { a: 1 } }));
  put(path.join(home.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, statusLine: { type: 'command', command: '/x' }, permissions: SVALL_RULES, theme: 'dark' }));
  put(path.join(home.codexDir, 'rules/svall.rules'), '# Managed by Svall: robot command permissions\n');
  seedAgentProfiles(home.agentProfiles!);
  return home;
}
type Home = ReturnType<typeof emptyServer>;

// what Claude Code 2.1.319 wrote on a scratch home at its first start, logged in, no plugin asked for: its own state, its plugin lists and a clone of the official marketplace, cut to one of each kind of file
function claudeStarted(h: Home) {
  const market = path.join(h.claudeDir, 'plugins/marketplaces/claude-plugins-official');
  editJson(h.claudeJson, (j) => Object.assign(j, {
    numStartups: 1, hasCompletedOnboarding: true, customApiKeyResponses: { approved: [], rejected: [] }, officialMarketplaceAutoInstalled: true, pluginUsage: {},
    projects: { [path.join(h.homedir, 'work')]: { hasTrustDialogAccepted: true, allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [] } },
  }));
  put(path.join(h.claudeDir, '.credentials.json'), '{"claudeAiOauth":{}}');
  put(path.join(h.claudeDir, 'cache/changelog.md'), '# changelog\n');
  put(path.join(h.claudeDir, 'backups/.claude.json.backup.1'), '{}');
  put(path.join(h.claudeDir, 'plugins/known_marketplaces.json'), JSON.stringify({
    'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' }, installLocation: market, lastUpdated: '2026-11-07T14:31:03.177Z' },
  }));
  put(path.join(market, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'claude-plugins-official',
    plugins: [{ name: 'agent-sdk-dev', source: './plugins/agent-sdk-dev' }, { name: 'a-far-one', source: { source: 'git-subdir', url: 'https://github.test/a.git', path: 'plugins/a', ref: 'v1' } }],
  }));
  put(path.join(market, '.gcs-sha'), 'abc\n');
  put(path.join(market, 'README.md'), '# plugins\n');
  put(path.join(market, 'plugins/agent-sdk-dev/.claude-plugin/plugin.json'), JSON.stringify({ name: 'agent-sdk-dev', version: '1.0.1' }));
  put(path.join(market, 'plugins/agent-sdk-dev/agents/verifier.md'), '---\nname: verifier\nmodel: sonnet\n---\n\nYou verify.\n');
  put(path.join(market, 'external_plugins/github/.mcp.json'), JSON.stringify({ github: { type: 'http', url: 'https://api.githubcopilot.test/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } } }));
  return market;
}

function seeded(server = emptyServer(), keeps = true, homeLog?: Logger) {
  const mac = { ...macHome(), overrides: path.join(server.homedir, 'unused-overrides') };
  editJson(path.join(mac.claudeDir, 'settings.json'), (s) => { s.permissions = MAC_RULES; });
  const backups = path.join(mac.homedir, '.svall/mirror-backup');
  const w = world({ mirror: { home: server, worker: { ...mac, ...(keeps && { backups }) } }, ...(homeLog && { homeLog }) });
  const linked = async () => {
    await w.link();
    await until(() => expect(w.worker.connection.connected()).toBe(true));
    await w.home.links.mirrorSettled(W);
  };
  return { server, mac, backups, w, linked };
}
const seed = (ctx: Ctx) => call<{ sent: number; backup?: string }>(ctx, 'machines.copySetupFrom', { machine: W, seed: true });
const folders = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const holds = async (ctx: Ctx) => (await call<{ holds: boolean }>(ctx, 'machines.holdsSetup', {})).holds;
const permissionsOn = (home: { claudeDir: string }) => JSON.parse(read(path.join(home.claudeDir, 'settings.json'))).permissions;

describe('a home with no agent setup yet', () => {
  it('holds none past what svall setup leaves, and a Mac with one says so', async () => {
    const { w, linked } = seeded();
    await linked();
    expect(await call(w.home.ctx, 'machines.holdsSetup', {})).toEqual({ holds: false });
    expect(await call(w.worker.ctx, 'machines.holdsSetup', {})).toEqual({ holds: true });
  });

  it.each([
    ['a rule', (h: ReturnType<typeof emptyServer>) => put(path.join(h.claudeDir, 'rules/mine.md'), 'mine\n')],
    ['a CLAUDE.md', (h: ReturnType<typeof emptyServer>) => put(path.join(h.claudeDir, 'CLAUDE.md'), '# mine\n')],
    ['an AGENTS.md', (h: ReturnType<typeof emptyServer>) => put(path.join(h.codexDir, 'AGENTS.md'), '# mine\n')],
    ['a setting of a person\'s', (h: ReturnType<typeof emptyServer>) => editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.model = 'opus'; })],
    ['a permission of a person\'s', (h: ReturnType<typeof emptyServer>) => editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.permissions.allow.push('Bash(git:*)'); })],
    ['a server', (h: ReturnType<typeof emptyServer>) => editJson(h.claudeJson, (j) => { j.mcpServers = { s: { command: 'npx', args: ['-y', 's-mcp'] } }; })],
    ['a Codex setting', (h: ReturnType<typeof emptyServer>) => put(path.join(h.codexDir, 'config.toml'), 'model = "x"\n')],
    ['a settings file it cannot read', (h: ReturnType<typeof emptyServer>) => put(path.join(h.claudeDir, 'settings.json'), '[not an object]')],
    ['a plugin installed', (h: Home) => {
      const at = path.join(h.claudeDir, 'plugins/cache/mp/acme/1.0.0');
      put(path.join(at, 'skills/a/SKILL.md'), 'a\n');
      put(path.join(h.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'acme@mp': [{ scope: 'user', installPath: at }] } }));
    }],
    ['a plugin its list names, whose folder is gone', (h: Home) => { put(path.join(h.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'acme@mp': [{ scope: 'user', installPath: path.join(h.claudeDir, 'plugins/cache/mp/acme/1.0.0') }] } })); }],
    ['a plugin enabled and none installed', (h: Home) => { claudeStarted(h); editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.enabledPlugins = { 'acme@claude-plugins-official': true }; }); }],
    ['a key in its settings', (h: Home) => editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.env = { ANTHROPIC_API_KEY: 'sk-1234567890' }; })],
    ['an OpenCode setting', (h: Home) => put(path.join(h.opencodeDir, 'opencode.json'), '{"model":"x"}')],
    ['a deny rule beside Svall\'s', (h: Home) => editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.permissions.deny = ['Read(./.env)']; })],
    ['a starter profile a person edited', (h: Home) => put(path.join(h.agentProfiles!, 'reviewer.md'), 'my own reviewer\n')],
    ['a profile of a person\'s', (h: Home) => put(path.join(h.agentProfiles!, 'mine.md'), 'mine\n')],
    ['a CLAUDE.md over what the mirror carries', (h: Home) => put(path.join(h.claudeDir, 'CLAUDE.md'), 'x'.repeat(5 * 1024 * 1024 + 1))],
    ['a CLAUDE.md linked to nothing', (h: Home) => { fs.symlinkSync(path.join(h.homedir, 'dotfiles/CLAUDE.md'), path.join(h.claudeDir, 'CLAUDE.md')); }],
    ['a settings.json linked to nothing', (h: Home) => { fs.rmSync(path.join(h.claudeDir, 'settings.json')); fs.symlinkSync(path.join(h.homedir, 'dotfiles/settings.json'), path.join(h.claudeDir, 'settings.json')); }],
    ['a skills folder linked to nothing', (h: Home) => { fs.symlinkSync(path.join(h.homedir, 'dotfiles/skills'), path.join(h.claudeDir, 'skills')); }],
    ['a link to nothing in its rules', (h: Home) => { fs.mkdirSync(path.join(h.claudeDir, 'rules')); fs.symlinkSync(path.join(h.homedir, 'dotfiles/mine.md'), path.join(h.claudeDir, 'rules/mine.md')); }],
    ['a rules folder it cannot list', (h: Home) => { put(path.join(h.claudeDir, 'rules/mine.md'), 'mine\n'); fs.chmodSync(path.join(h.claudeDir, 'rules'), 0o000); }],
    ['a .claude.json cut short', (h: Home) => put(h.claudeJson, '{"oauth')],
    ['an empty .claude.json', (h: Home) => put(h.claudeJson, '')],
    ['a plugin list cut short', (h: Home) => { claudeStarted(h); put(path.join(h.claudeDir, 'plugins/installed_plugins.json'), '{"plugins'); }],
    ['one key an app wrote in its settings', (h: Home) => editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.feedbackSurveyState = { lastShownTime: 1 }; })],
    ['a Codex notice', (h: Home) => put(path.join(h.codexDir, 'config.toml'), '[notice]\nhide = true\n')],
    ['an OpenCode schema', (h: Home) => put(path.join(h.opencodeDir, 'opencode.json'), '{"$schema":"https://opencode.ai/config.json"}')],
  ])('holds one with %s, and refuses a seed', async (_what, make) => {
    const server = emptyServer();
    make(server);
    const { w, linked } = seeded(server);
    try {
      await linked();
      const asked = vi.spyOn(w.worker.handlers, 'config.copyToHome');
      expect(await call(w.home.ctx, 'machines.holdsSetup', {})).toEqual({ holds: true });
      await expect(seed(w.home.ctx)).rejects.toMatchObject({ code: 'refused' });
      expect(asked).not.toHaveBeenCalled();
    } finally { if (fs.existsSync(path.join(server.claudeDir, 'rules'))) fs.chmodSync(path.join(server.claudeDir, 'rules'), 0o755); }
  });

  it.each<[string, Partial<MirrorPlan>]>([
    ['a file of a person\'s', { files: [{ from: '/x/skills/a', to: 'claude/skills/a', mode: 0o644 }] }],
    ['a server', { servers: [{ key: 'k' } as MirrorPlan['servers'][number]] }],
    ['a plugin\'s item', { plugins: [{ key: 'k', name: 'n', fields: [], ticked: true, files: ['/x/a'] }] }],
    ['a config file with a key', { configs: [{ key: 'k', agent: 'claude', file: 'f', fields: [], preview: [], ticked: [] }] }],
    ['a setting', { settings: { model: 'x' } }],
    ['a permission of a person\'s', { settings: { permissions: { allow: ['Bash(svall status:*)', 'Bash(git:*)'] } } }],
    ['a deny rule', { settings: { permissions: { allow: ['Bash(svall status:*)'], deny: ['Read(./.env)'] } } }],
    ['a ticked key of its settings', { settingsEnv: { K: 'v' } }],
    ['a Codex setting', { codex: { model: 'x' } }],
    ['an OpenCode setting', { opencode: [{ file: 'opencode.json', doc: { model: 'x' }, fields: [] }] }],
    ['a file it cannot read', { unreadable: ['/x/settings.json'] }],
    ['a line of what stays here', { skipped: ['/x/CLAUDE.md is over 5 MB'] }],
  ])('counts %s alone', (_what, held) => {
    const plan = mirrorPlan(emptyServer());
    expect(holdsSetup(plan)).toBe(false);
    expect(holdsSetup({ ...plan, ...held })).toBe(true);
  });

  it('takes the theme Claude Code writes at its first start for no setup', () => {
    const plan = mirrorPlan(emptyServer());
    expect(plan.settings).toEqual({ permissions: SVALL_RULES, theme: 'dark' });
    expect(holdsSetup(plan)).toBe(false);
  });

  it('counts a theme beside any other setting', () => {
    const plan = mirrorPlan(emptyServer());
    expect(holdsSetup({ ...plan, settings: { ...plan.settings, model: 'opus' } })).toBe(true);
    expect(holdsSetup({ ...plan, settings: { theme: 'dark', feedbackSurveyState: { lastShownTime: 1 } } })).toBe(true);
  });

  it('takes no empty folder for a setup, and carries no rule of Codex\'s, Svall\'s or a person\'s', async () => {
    const server = emptyServer();
    for (const d of ['skills', 'rules', 'agents', 'commands']) fs.mkdirSync(path.join(server.claudeDir, d), { recursive: true });
    put(path.join(server.codexDir, 'rules/mine.rules'), 'prefix_rule(pattern = ["rm"], decision = "allow")\n');
    const plan = mirrorPlan(server);
    expect(plan.files.filter((f) => f.to.startsWith('codex/'))).toEqual([]);
    expect(holdsSetup(plan)).toBe(false);
  });

  it('pushes nothing over a Mac before its seed: no key of its settings goes, no record, no copy', async () => {
    const { mac, backups, w, linked } = seeded();
    const before = read(path.join(mac.claudeDir, 'settings.json'));
    await linked();
    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.claudeDir, 'settings.json'))).toBe(before);
    expect(readState(w.worker.paths.mirrorState).applied).toBeUndefined();
    expect(folders(backups)).toEqual([]);
  });

  it('takes this Mac\'s through the Copy, and is the source from there: its next push keeps a copy of equal bytes, and a change lands over it', async () => {
    const { server, mac, backups, w, linked } = seeded();
    const mine = read(path.join(mac.claudeDir, 'CLAUDE.md'));
    await linked();
    expect((await seed(w.home.ctx)).sent).toBeGreaterThan(0);
    expect(read(path.join(server.claudeDir, 'CLAUDE.md'))).toBe(mine);
    expect(JSON.parse(read(path.join(server.claudeDir, 'settings.json'))).permissions.allow).toContain('Bash(git:*)');
    expect(await call(w.home.ctx, 'machines.holdsSetup', {})).toEqual({ holds: true });
    // the next is no seed: a person's Copy from the pane still goes, and a seed refuses
    await expect(seed(w.home.ctx)).rejects.toMatchObject({ code: 'refused' });
    await call(w.home.ctx, 'machines.copySetupFrom', { machine: W });

    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.claudeDir, 'CLAUDE.md'))).toBe(mine);
    const [day] = folders(backups);
    expect(read(path.join(backups, day, '.claude/CLAUDE.md'))).toBe(mine);
    put(path.join(server.claudeDir, 'CLAUDE.md'), '# changed on the home\n');
    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.claudeDir, 'CLAUDE.md'))).toBe('# changed on the home\n');
    expect(read(path.join(backups, day, '.claude/CLAUDE.md'))).toBe(mine);
  });

  it('a home that emptied itself still takes back what it sent: only a first push goes unsent', async () => {
    const server = emptyServer();
    put(path.join(server.claudeDir, 'rules/gone.md'), 'gone\n');
    const { mac, w, linked } = seeded(server);
    await linked();
    expect(read(path.join(mac.claudeDir, 'rules/gone.md'))).toBe('gone\n');
    fs.rmSync(path.join(server.claudeDir, 'rules/gone.md'));
    await w.home.links.pushMirror(W);
    expect(fs.existsSync(path.join(mac.claudeDir, 'rules/gone.md'))).toBe(false);
  });

  it('a Linux worker its home dials takes the first push as it always has', async () => {
    const { mac, w, linked } = seeded(emptyServer(), false);
    await linked();
    expect(JSON.parse(read(path.join(mac.claudeDir, 'settings.json'))).permissions).toEqual(SVALL_RULES);
    expect(readState(w.worker.paths.mirrorState).applied).toBeGreaterThan(0);
  });

  it('asks only of a window: a phone and a worker are refused it', async () => {
    const { w, linked } = seeded();
    await linked();
    await expect(call({ ...w.home.ctx, viewer: { kind: 'phone' } } as Ctx, 'machines.holdsSetup', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(answer('machines.holdsSetup', {}, w.home.ctx, W)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('a home where Claude Code has only started', () => {
  it('holds none, so the Mac keeps its permissions and takes the seed', async () => {
    const server = emptyServer();
    claudeStarted(server);
    const { mac, w, linked } = seeded(server);
    const before = read(path.join(mac.claudeDir, 'settings.json'));
    await linked();
    expect(await holds(w.home.ctx)).toBe(false);
    expect(read(path.join(mac.claudeDir, 'settings.json'))).toBe(before);
    expect(readState(w.worker.paths.mirrorState).applied).toBeUndefined();

    expect((await seed(w.home.ctx)).sent).toBeGreaterThan(0);
    expect(read(path.join(server.claudeDir, 'CLAUDE.md'))).toBe(read(path.join(mac.claudeDir, 'CLAUDE.md')));
    expect(permissionsOn(server)).toEqual(MAC_RULES);
  });

  it('flips no answer when the first Claude robot starts under the sheet: its Copy still lands', async () => {
    const { server, w, linked } = seeded();
    await linked();
    expect(await holds(w.home.ctx)).toBe(false);
    claudeStarted(server);
    expect(await holds(w.home.ctx)).toBe(false);
    expect((await seed(w.home.ctx)).sent).toBeGreaterThan(0);
  });

  it('reads no marketplace nothing installs from, whatever lies in it: a key, a list it cannot read, a link to nothing', async () => {
    const server = emptyServer();
    const market = claudeStarted(server);
    put(path.join(market, 'external_plugins/keyed/.mcp.json'), JSON.stringify({ keyed: { command: 'npx', env: { X_API_KEY: 'key_1234567890' } } }));
    put(path.join(market, '.claude-plugin/marketplace.json'), '{"plugins');
    fs.symlinkSync(path.join(server.homedir, 'nowhere'), path.join(market, 'gone.md'));
    put(path.join(path.dirname(market), 'other/plugins/x/agents/keyed.md'), ['---', 'name: keyed', 'mcpServers:', '  - s:', '      command: npx', '      env:', '        K: agent_key_1234567890', '---', 'prompt', ''].join('\n'));
    const plan = mirrorPlan(server);
    expect(plan.unreadable.length).toBeGreaterThan(0);
    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(plan.plugins.length).toBeGreaterThan(0);
    expect(holdsSetup(plan)).toBe(false);
  });

  it('reads the marketplace as a person\'s once a plugin installs from it', async () => {
    const server = emptyServer();
    const market = claudeStarted(server);
    put(path.join(server.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agent-sdk-dev@claude-plugins-official': [{ scope: 'user', installPath: path.join(market, 'plugins/agent-sdk-dev') }] } }));
    expect(holdsSetup(mirrorPlan(server))).toBe(true);
  });
});

describe('a first push onto a Mac', () => {
  it.each<[string, (h: Home) => void]>([
    ['a .claude.json cut short', (h) => put(h.claudeJson, '{"oauth')],
    ['a settings file it cannot read', (h) => put(path.join(h.claudeDir, 'settings.json'), '[not an object]')],
  ])('does not go yet with %s, though no seed may go either', async (_what, make) => {
    const server = emptyServer();
    make(server);
    const { mac, w, linked } = seeded(server);
    const before = read(path.join(mac.claudeDir, 'settings.json'));
    await linked();
    await w.home.links.pushMirror(W);
    expect(readState(w.worker.paths.mirrorState).applied).toBeUndefined();
    expect(read(path.join(mac.claudeDir, 'settings.json'))).toBe(before);
    expect(await holds(w.home.ctx)).toBe(true);
    await expect(seed(w.home.ctx)).rejects.toMatchObject({ code: 'refused' });
  });

  it('says why it waits at each link-up, and says nothing where the home holds no setup', async () => {
    const lines: string[] = [];
    const log: Logger = { info: (l) => lines.push(l), error: (l) => lines.push(l) };
    const waits = () => lines.filter((l) => l.includes('the first push onto a machine that keeps its own setup waits'));
    await seeded(emptyServer(), true, log).linked();
    expect(waits()).toEqual([]);
    const server = emptyServer();
    put(server.claudeJson, '{"oauth');
    const { w, linked } = seeded(server, true, log);
    await linked();
    expect(waits()).toEqual([`mirror: ${server.claudeJson} cannot be read, and the first push onto a machine that keeps its own setup waits until it can`]);
    await w.home.links.pushMirror(W);
    expect(waits()).toHaveLength(2);
  });

  it.each([
    ['a Codex config that does not parse', (h: ReturnType<typeof macHome>) => put(path.join(h.codexDir, 'config.toml'), 'model = ')],
    ['an OpenCode config that does not parse', (h: ReturnType<typeof macHome>) => put(path.join(h.opencodeDir, 'opencode.json'), '{"model": ')],
  ])('a Mac home that never moved, with %s, pushes its setup to a Mac that joins it', async (_what, broken) => {
    const home = macHome();
    broken(home);
    const other = { ...farHome(), overrides: path.join(home.homedir, 'unused-overrides') };
    const w = world({ mirror: { home, worker: { ...other, backups: path.join(other.homedir, '.svall/mirror-backup') } } });
    await w.link();
    await until(() => expect(w.worker.connection.connected()).toBe(true));
    await w.home.links.mirrorSettled(W);
    expect(readState(w.worker.paths.mirrorState).applied).toBeGreaterThan(0);
    expect(read(path.join(other.claudeDir, 'CLAUDE.md'))).toBe('# how I work\n');
  });

  it('a Copy a person asks for still goes from a Mac with a file it cannot read, with what it can', async () => {
    const { server, mac, w, linked } = seeded();
    put(path.join(mac.codexDir, 'config.toml'), 'model = ');
    await linked();
    expect((await seed(w.home.ctx)).sent).toBeGreaterThan(0);
    expect(read(path.join(server.claudeDir, 'CLAUDE.md'))).toBe(read(path.join(mac.claudeDir, 'CLAUDE.md')));
  });

  it.each<[string, (h: Home) => void]>([
    ['a CLAUDE.md written on the home', (h) => put(path.join(h.claudeDir, 'CLAUDE.md'), '# written on the home\n')],
    ['one key an app wrote in its settings', (h) => editJson(path.join(h.claudeDir, 'settings.json'), (s) => { s.feedbackSurveyState = { lastShownTime: 1 }; })],
    ['a Codex notice', (h) => put(path.join(h.codexDir, 'config.toml'), '[notice]\nhide = true\n')],
    ['an OpenCode schema', (h) => put(path.join(h.opencodeDir, 'opencode.json'), '{"$schema":"https://opencode.ai/config.json"}')],
    ['a setup beside a Codex config it cannot read', (h) => { put(path.join(h.claudeDir, 'CLAUDE.md'), '# mine\n'); put(path.join(h.codexDir, 'config.toml'), 'model = '); }],
    ['a plugin installed from a marketplace whose list is cut short', (h) => {
      const market = claudeStarted(h);
      const at = path.join(market, 'plugins/agent-sdk-dev');
      put(path.join(h.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agent-sdk-dev@claude-plugins-official': [{ scope: 'user', installPath: at }] } }));
      put(path.join(market, '.claude-plugin/marketplace.json'), '{"plugins');
    }],
  ])('goes with %s, and leaves the Mac\'s permissions while the home holds only Svall\'s rules', async (_what, make) => {
    const { server, mac, w, linked } = seeded();
    await linked();
    make(server);
    await w.home.links.pushMirror(W);
    expect(readState(w.worker.paths.mirrorState).applied).toBeGreaterThan(0);
    expect(permissionsOn(mac)).toEqual(MAC_RULES);
  });

  it('carries the home\'s permissions once a person\'s are among them, and follows them from there, Svall\'s rules alone included', async () => {
    const { server, mac, w, linked } = seeded();
    await linked();
    const mine = { allow: [...SVALL_RULES.allow, 'Bash(ls:*)'] };
    editJson(path.join(server.claudeDir, 'settings.json'), (s) => { s.permissions = mine; });
    await w.home.links.pushMirror(W);
    expect(permissionsOn(mac)).toEqual(mine);
    editJson(path.join(server.claudeDir, 'settings.json'), (s) => { s.permissions = SVALL_RULES; });
    await w.home.links.pushMirror(W);
    expect(permissionsOn(mac)).toEqual(SVALL_RULES);
  });
});
