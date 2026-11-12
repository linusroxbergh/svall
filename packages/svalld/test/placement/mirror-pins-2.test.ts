import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { filesIn } from '../../src/placement/docs-sync.js';
import { applyMirror } from '../../src/placement/mirror-apply.js';
import { refuseForeign } from '../../src/placement/mirror-copy.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { setupRows } from '../../src/placement/mirror-report.js';
import { readState } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { makeHome } from '../helpers.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';
import { stopWorlds, until, W, world } from './world.js';

afterEach(async () => { vi.restoreAllMocks(); await stopWorlds(); });
const K = 'sk_home_key_1234567890';
const OWN = 'sk_own_key_0987654321';
const FIELD = 'codex:config#model_providers.acme.http_headers.X-Key';
const PROVIDER = ['[model_providers.acme]', 'name = "Acme"', 'base_url = "https://acme.test/v1"', `http_headers = { "X-Key" = "${K}" }`, ''].join('\n');
const ODD = { command: 'odd', env: { T: K }, sandbox: { token: 'odd_token_1234567890' } };
const ODD_FIELDS = ['command', 'env', 'sandbox'].map((f) => `claude:mcp:odd#${f}`);
function setup(mode: 'mac' | 'copy' | 'dialed' = 'mac') {
  const home = macHome();
  const w = farHome();
  fs.rmSync(w.overrides, { recursive: true, force: true });
  const scratch = makeHome();
  const stateFile = path.join(w.homedir, '.svall/cache/mirror-state.json');
  const varsFile = path.join(w.homedir, '.svall/mirror-vars.json');
  const backups = path.join(w.homedir, '.svall/mirror-backup');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let seq = 0;
  const consent = new Set<string>();
  const options = { ...w, stateFile, varsFile, ...(mode !== 'dialed' && { backups }), ...(mode === 'copy' && { additive: true, refuse: refuseForeign }) };
  const push = async () => {
    const dir = path.join(scratch, String(++seq));
    const tar = `${dir}.tar`;
    const state = readState(stateFile);
    await packMirror(mirrorPlan(home, consent, { state, projects: {}, platform: 'darwin' } as never), tar, state);
    await unpack(tar, dir);
    return applyMirror(dir, { ...options, seq });
  };
  const holding = (value: string): string[] => (fs.existsSync(backups) ? filesIn(backups).filter((f) => read(path.join(backups, f)).includes(value)) : []);
  const toml = () => parseToml(read(path.join(w.codexDir, 'config.toml'))) as any;
  return { home, w, push, consent, stateFile, backups, holding, options, toml, homeToml: path.join(home.codexDir, 'config.toml'), macToml: path.join(w.codexDir, 'config.toml') };
}
const call = async <T = unknown>(ctx: Ctx, method: string, params: object): Promise<T> => {
  const res = await dispatch({ id: 1, method, params } as never, ctx);
  if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result as T;
};
function copyOf() {
  const home = farHome();
  fs.rmSync(path.join(home.overrides, 'claude/CLAUDE.md'), { force: true });
  put(path.join(home.claudeDir, 'CLAUDE.md'), '# the server\n');
  const mac = { ...macHome(), overrides: path.join(home.homedir, 'unused-overrides') };
  const w = world({ mirror: { home, worker: { ...mac, backups: path.join(mac.homedir, '.svall/mirror-backup') } } });
  return {
    home, mac, w,
    ask: () => call<{ sent: number; backup?: string; left?: string[]; replaced?: string[] }>(w.home.ctx, 'machines.copySetupFrom', { machine: W }),
    consent: (item: string, fields: string[], on: boolean) => call(w.worker.ctx, 'home.setupConsent', { item, fields, on }),
    linked: async () => { await w.link(); await until(() => expect(w.worker.connection.connected()).toBe(true)); await w.home.links.mirrorSettled(W); },
  };
}

describe('the answer of a Copy through the call', () => {
  it('PW1 names what an untick left', async () => {
    const { home, mac, ask, consent, linked } = copyOf();
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } }; });
    await linked();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    await ask();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    expect((await ask()).left).toEqual(['odd']);
  });
  it('PW2 names what a tick went over', async () => {
    const { home, mac, ask, consent, linked } = copyOf();
    put(home.claudeJson, JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: OWN } } } }));
    await linked();
    expect(json(mac.claudeJson).mcpServers.linear).toBeDefined();
    await consent('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    expect((await ask()).replaced).toEqual(['linear']);
  });
});

describe('a server of the person\'s under a name the record does not hold', () => {
  it('PU1 of a shape the mirror cannot read, holding only strings the sender holds, stays', async () => {
    const s = setup();
    await s.push();
    const mine = { command: 'npx', sandbox: { on: true } };
    editJson(s.w.claudeJson, (j) => { j.mcpServers.neu = mine; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.neu = { command: 'npx', env: { NEU_KEY: '${NEU_KEY}' } }; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.neu).toEqual(mine);
  });
});

describe('a dialed Linux worker as on main', () => {
  it('PG1 a copied arg it moved in its list stays through the untick', async () => {
    const s = setup('dialed');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    s.consent.add('claude:mcp:a#args[--api-key]');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.a.args = ['--verbose', ...j.mcpServers.a.args]; });
    s.consent.clear();
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.a.args).toContain(K);
  });
  it('PG2 enabledPlugins the home drops goes whole, its own entries with it', async () => {
    const s = setup('dialed');
    const at = path.join(s.home.claudeDir, 'settings.json');
    const here = path.join(s.w.claudeDir, 'settings.json');
    editJson(at, (j) => { j.enabledPlugins = { 'acme@mp': true }; });
    await s.push();
    editJson(here, (j) => { j.enabledPlugins['own@x'] = true; });
    editJson(at, (j) => { delete j.enabledPlugins; });
    await s.push();
    expect(json(here).enabledPlugins).toBeUndefined();
  });
});

describe('a file behind a link', () => {
  it('PL1 with no key, unticked or dropped, leaves what the link leads to', async () => {
    const s = setup();
    const rule = path.join(s.home.claudeDir, 'rules/linked.md');
    put(rule, 'home\n');
    const dotfile = path.join(s.w.homedir, 'dotfiles/linked.md');
    put(dotfile, 'mine\n');
    fs.mkdirSync(path.join(s.w.claudeDir, 'rules'), { recursive: true });
    fs.symlinkSync(dotfile, path.join(s.w.claudeDir, 'rules/linked.md'));
    await s.push();
    fs.rmSync(rule);
    await s.push();
    expect(fs.existsSync(dotfile)).toBe(true);
    expect(s.holding('mine\n').length).toBeGreaterThan(0);
  });
});

describe('a table the sender drops, holding a key of the target\'s', () => {
  it('PE1 keeps that entry alone: an entry the mirror wrote goes', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER + '\n[model_providers.two]\nname = "Two"\n');
    await s.push();
    fs.appendFileSync(s.macToml, `\n[model_providers.mine]\nname = "Mine"\nhttp_headers = { "X-Own" = "${OWN}" }\n`);
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    expect(Object.keys(s.toml().model_providers)).toEqual(['mine']);
  });
});

describe('what a Copy says it left', () => {
  const keyedFile = (s: ReturnType<typeof setup>) => {
    const acme = path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, 'settings.json'), JSON.stringify({ apiKey: K, other: 1 }));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'darwin' } as never).plugins.find((p) => p.key === 'claude:plugin:acme')!;
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    return { landed: path.join(s.w.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json'), src: path.join(acme, 'settings.json') };
  };
  it('PR1 no server its sender dropped, as no untick left it', async () => {
    const s = setup('copy');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.home.claudeJson, (j) => { delete j.mcpServers.odd; });
    const r = await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toBeDefined();
    expect(r.left).toBeUndefined();
  });
  it('PR2 no keyed file its sender dropped', async () => {
    const s = setup('copy');
    const { landed, src } = keyedFile(s);
    await s.push();
    fs.rmSync(src);
    const r = await s.push();
    expect(fs.existsSync(landed)).toBe(true);
    expect(r.left).toBeUndefined();
  });
  it('PR3 no keyed file the person removed on the home', async () => {
    const s = setup('copy');
    const { landed } = keyedFile(s);
    await s.push();
    fs.rmSync(landed);
    s.consent.clear();
    const r = await s.push();
    expect(r.left).toBeUndefined();
  });
  it('PR4 no keyed file the untick took', async () => {
    const s = setup('copy');
    const { landed } = keyedFile(s);
    await s.push();
    s.consent.clear();
    const r = await s.push();
    expect(fs.existsSync(landed)).toBe(false);
    expect(r.left).toBeUndefined();
  });
  it('PR5 no per-field server holding a key of the home\'s', async () => {
    const s = setup('copy');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = OWN; });
    const r = await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(OWN);
    expect(r.left).toBeUndefined();
  });
});

describe('a rollback copy', () => {
  it('PB1 holding a whole copy\'s string only in another server stays through the untick', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd-only', sandbox: { token: 'odd_token_1234567890' } }; });
    for (const f of ['command', 'sandbox']) s.consent.add(`claude:mcp:odd#${f}`);
    await s.push();
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, JSON.stringify({ mcpServers: { mine: { command: 'odd-only' } } }));
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(bak)).toBe(true);
  });
});

const LISTED = ['[model_providers.acme]', 'name = "Acme"', '', '[model_providers.acme.auth]', 'command = "tok"', `args = ["--verbose", "--token", "${K}"]`, ''].join('\n');
const ARG = 'codex:config#model_providers.acme.auth.args[--token]';

describe('a table of entries, more', () => {
  it('PT1 an entry both hold at the first push is the sender\'s, whole', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER.replace(K, '${K}'));
    put(s.macToml, '[model_providers.acme]\nname = "Mine"\nlimit = 3\n');
    await s.push();
    expect(s.toml().model_providers.acme.name).toBe('Acme');
    expect(s.toml().model_providers.acme.limit).toBeUndefined();
  });
  it('PT2 a record from before it named a table\'s entries: one the sender dropped goes', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER + '\n[model_providers.two]\nname = "Two"\n');
    await s.push();
    const state = json(s.stateFile);
    delete state.listed;
    fs.writeFileSync(s.stateFile, JSON.stringify(state));
    put(s.homeToml, PROVIDER);
    await s.push();
    expect(Object.keys(s.toml().model_providers)).toEqual(['acme']);
  });
});

describe('a copied arg the person moved', () => {
  it('PC1 on a Copy, in a config list its sender still lists, goes at the untick', async () => {
    const s = setup('copy');
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace('"--verbose",', '"--new", "--verbose",'));
    s.consent.clear();
    await s.push();
    expect(read(s.macToml)).not.toContain(K);
  });
  it('PO1 in a server, is in no copy when a tick goes over a key of the person\'s beside it', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    s.consent.add('claude:mcp:a#args[--api-key]');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.a.args = ['--verbose', ...j.mcpServers.a.args]; j.mcpServers.a.env = { MINE: OWN }; });
    await s.push();
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });
  it('PO2 in a config entry, is in no copy when a tick goes over a key of the person\'s beside it', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace('"--verbose",', '"--new", "--verbose",').replace('[model_providers.acme.auth]', `[model_providers.acme.http_headers]\nX-Own = "${OWN}"\n\n[model_providers.acme.auth]`));
    await s.push();
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });
});

describe('a dialed Linux worker as on main, a literal where a url or arg stands', () => {
  it('PG3 a server\'s arg literal goes when the home changes the server', async () => {
    const s = setup('dialed');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.a.args[2] = OWN; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.a.command = 'npm'; });
    await s.push();
    expect(read(s.w.claudeJson)).not.toContain(OWN);
  });
  it('PG4 a config list\'s literal goes when the home changes its table', async () => {
    const s = setup('dialed');
    put(s.homeToml, LISTED);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace(/"--token", "[^"]*"/, `"--token", "${OWN}"`));
    put(s.homeToml, LISTED.replace('name = "Acme"', 'name = "Changed"'));
    await s.push();
    expect(read(s.macToml)).not.toContain(OWN);
  });
});

describe('what a Copy says it left, more', () => {
  it('PR6 no whole server the person removed on the home', async () => {
    const s = setup('copy');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { delete j.mcpServers.odd; });
    s.consent.clear();
    const r = await s.push();
    expect(r.left).toBeUndefined();
    expect(Object.keys(readState(s.stateFile).servers)).not.toContain(JSON.stringify(['.claude.json', 'mcpServers', 'odd']));
  });
});

describe('a rollback copy, more', () => {
  it('PB2 of an edited whole server holding only strings the file still holds stays', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', sandbox: { on: true } }; });
    for (const f of ['command', 'sandbox']) s.consent.add(`claude:mcp:odd#${f}`);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, read(s.w.claudeJson));
    fs.writeFileSync(bak, JSON.stringify({ mcpServers: { odd: json(s.w.claudeJson).mcpServers.odd } }));
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(bak)).toBe(true);
  });
});

describe('more entries', () => {
  it('PM1 a value equal to a key the mirror copied, in another server the person holds, is theirs', async () => {
    const s = setup();
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.b = { command: 'npx', args: ['b-mcp'], env: { B_KEY: 'lin_api_1234567890' } }; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.b = { command: 'npm', args: ['b-mcp'], env: { B_KEY: '${B_KEY}' } }; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.b).toEqual({ command: 'npx', args: ['b-mcp'], env: { B_KEY: 'lin_api_1234567890' } });
  });
  it('PK1 a ticked key standing: a person\'s edit of its server stays, and no copy is kept', async () => {
    const s = setup();
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    const before = s.holding('');
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.timeout = 5; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.timeout).toBe(5);
    expect(readState(s.stateFile).replaced).toBeUndefined();
    expect(s.holding('')).toEqual(before);
  });
  it('PE2 a held list holding a key stays whole where the sender holds a table', async () => {
    const s = setup();
    put(s.homeToml, '[mirrors.a]\nname = "x"\n');
    const list = [`https://me:${OWN}@a.test/x`, 'https://b.test/y'];
    put(s.macToml, `mirrors = ${JSON.stringify(list)}\n`);
    await s.push();
    expect(s.toml().mirrors).toEqual(list);
  });
  it('PE3 a tick on one provider leaves another holding a key of the person\'s', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    s.consent.add(FIELD);
    put(s.macToml, `[model_providers.mine]\nname = "Mine"\nhttp_headers = { "X-Own" = "${OWN}" }\n`);
    await s.push();
    expect(s.toml().model_providers.mine.http_headers['X-Own']).toBe(OWN);
    expect(s.toml().model_providers.acme.http_headers['X-Key']).toBe(K);
  });
  it('PE4 a tick landing on one provider leaves another of the person\'s with no key', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    await s.push();
    fs.appendFileSync(s.macToml, '\n[model_providers.mine]\nname = "Mine"\n');
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.mine).toEqual({ name: 'Mine' });
  });
  it('PF1 a key at a top-level list, ticked over another list, lands by the sender\'s whole list', async () => {
    const s = setup();
    const url = `https://me:${K}@a.test/x`;
    put(s.homeToml, `mirrors = ${JSON.stringify([url, 'https://b.test/y'])}\n`);
    put(s.macToml, 'mirrors = ["https://c.test/z", "https://d.test/w", "https://e.test/v"]\n');
    const plan = mirrorPlan(s.home, s.consent);
    const fields = plan.configs.find((c) => c.key === 'codex:config')!.fields.filter((f) => f.startsWith('mirrors'));
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) s.consent.add(`codex:config#${f}`);
    await s.push();
    expect(s.toml().mirrors).toEqual([url, 'https://b.test/y']);
  });
});

describe('a record from before it kept a whole copy\'s strings', () => {
  it('PK2 the untick takes a whole copy still as it was written', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    const state = json(s.stateFile);
    delete state.wholeKeys;
    fs.writeFileSync(s.stateFile, JSON.stringify(state));
    s.consent.clear();
    await s.push();
    expect(read(s.w.claudeJson)).not.toContain(K);
    expect(json(s.w.claudeJson).mcpServers.odd).toBeUndefined();
  });
});

describe('a dialed Linux worker as on main, a keyed file behind a link', () => {
  it('PG5 an untick removes the link and leaves where it led', async () => {
    const s = setup('dialed');
    const agent = path.join(s.home.claudeDir, 'agents/keyed.md');
    put(agent, ['---', 'name: keyed', 'mcpServers:', '  x:', '    command: x', '    env:', `      K: ${K}`, '---', 'hi', ''].join('\n'));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'linux' } as never).plugins.find((p) => p.key.startsWith('claude:agent:'))!;
    const dotfile = path.join(s.w.homedir, 'dotfiles/keyed.md');
    put(dotfile, 'mine\n');
    fs.mkdirSync(path.join(s.w.claudeDir, 'agents'), { recursive: true });
    fs.symlinkSync(dotfile, path.join(s.w.claudeDir, 'agents/keyed.md'));
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    await s.push();
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(dotfile)).toBe(true);
  });
});

describe('a dialed Linux worker as on main, a config key', () => {
  it('PG6 its own literal stays at the place under the home\'s unticked literal', async () => {
    const s = setup('dialed');
    put(s.homeToml, PROVIDER);
    put(s.macToml, `[model_providers.acme]\nname = "Mine"\nhttp_headers = { "X-Key" = "${OWN}" }\n`);
    await s.push();
    expect(s.toml().model_providers.acme.name).toBe('Acme');
    expect(s.toml().model_providers.acme.http_headers['X-Key']).toBe(OWN);
  });
});

describe('a whole copy standing', () => {
  it('PS1 stays through each later push, as written', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    for (let i = 0; i < 2; i++) {
      await s.push();
      expect(json(s.w.claudeJson).mcpServers.odd).toEqual(ODD);
      expect(Object.keys(readState(s.stateFile).whole ?? {})).toContain(JSON.stringify(['.claude.json', 'mcpServers', 'odd']));
    }
  });
  it('PS2 on a Copy too', async () => {
    const s = setup('copy');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toEqual(ODD);
  });
});

describe('last', () => {
  it('PF2 a standing tick on a top-level list the person reshaped lands by the sender\'s whole list', async () => {
    const s = setup();
    const url = `https://me:${K}@a.test/x`;
    put(s.homeToml, `mirrors = ${JSON.stringify([url, 'https://b.test/y'])}\n`);
    const fields = mirrorPlan(s.home, s.consent).configs.find((c) => c.key === 'codex:config')!.fields.filter((f) => f.startsWith('mirrors'));
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) s.consent.add(`codex:config#${f}`);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace(/mirrors = \[[^\]]*\]/, 'mirrors = ["https://c.test/z", "https://d.test/w", "https://e.test/v"]'));
    await s.push();
    expect(s.toml().mirrors).toEqual([url, 'https://b.test/y']);
  });
  it('PSK a server of a shape the mirror cannot read in a plugin file the plan does not carry says why, with no tick', () => {
    const s = setup();
    const acme = path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', mcpServers: './token.json' }));
    put(path.join(acme, 'token.json'), JSON.stringify({ mcpServers: { t: { command: 'node', sandbox: { token: K } } } }));
    const row = setupRows(mirrorPlan(s.home, s.consent), undefined, { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((r) => r.key.includes(':mcp:t'));
    expect(row).toMatchObject({ status: 'skip', detail: 'not copied: Svall does not copy this file', gap: { name: 't', what: 'not copied: Svall does not copy this file' } });
    expect(row?.tick).toBeUndefined();
  });
});
