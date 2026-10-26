import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realPath } from '../../src/handover/portable-path.js';
import { claudeAdapter } from '../../src/handover/sessions/claude.js';
import { clearConsent, mask, readConsent, setConsent, tickedFields } from '../../src/placement/mirror-consent.js';
import { applyMirror, MIRROR_FILE_MAX, mirrorPlan, packMirror } from '../../src/placement/mirror.js';
import { unpack } from '../../src/placement/move.js';
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
    expect(json(o.varsFile)).toEqual(['E', 'REMOTE_TOKEN']);

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
    expect(plan.plugins).toEqual([{ key: 'claude:plugin:acme', name: 'acme', fields: ['env'], ticked: false, files: [path.join(mac.claudeDir, acmeSettings)] }]);
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

  it('a path too long for ustar is skipped with a line, and the push still goes', async () => {
    const deep = path.join(mac.claudeDir, 'skills', 'x'.repeat(120), 'y'.repeat(120), 'SKILL.md');
    put(deep, 'deep\n'); put(path.join(mac.claudeDir, 'rules/new.md'), 'new\n');
    expect(mirrorPlan(mac).skipped).toContain(`${deep} has a path too long for the mirror to carry`);
    await push();
    expect(read(path.join(worker.claudeDir, 'rules/new.md'))).toBe('new\n');
  });
});
