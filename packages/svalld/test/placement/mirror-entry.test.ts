import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { SetupRow } from '@svall/protocol';
import { filesIn } from '../../src/placement/docs-sync.js';
import { applyMirror, takeBackCopies } from '../../src/placement/mirror-apply.js';
import { refuseForeign } from '../../src/placement/mirror-copy.js';
import { carriable, mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { configReport, reportAsk, setupRows } from '../../src/placement/mirror-report.js';
import { readState } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { makeHome } from '../helpers.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';

const K = 'sk_home_key_1234567890';
const OWN = 'sk_own_key_0987654321';
const FIELD = 'codex:config#model_providers.acme.http_headers.X-Key';
const PROVIDER = ['[model_providers.acme]', 'name = "Acme"', 'base_url = "https://acme.test/v1"', `http_headers = { "X-Key" = "${K}" }`, ''].join('\n');
const LISTED = ['[model_providers.acme]', 'name = "Acme"', '', '[model_providers.acme.auth]', 'command = "tok"', `args = ["--verbose", "--token", "${K}"]`, ''].join('\n');
const ARG = 'codex:config#model_providers.acme.auth.args[--token]';
const ODD = { command: 'odd', env: { T: K }, sandbox: { token: 'odd_token_1234567890' } };
const ODD_FIELDS = ['command', 'env', 'sandbox'].map((f) => `claude:mcp:odd#${f}`);

// a sender and a target that keeps backups, its own record of what the mirror wrote; `copy` a home taking a worker's Copy, `dialed` a Linux worker its home dials
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

describe('a key that lands in a config file', () => {
  for (const mode of ['mac', 'copy'] as const) {
    it(`on a ${mode}, ticked over a provider the person deleted, brings the whole entry back`, async () => {
      const s = setup(mode);
      put(s.homeToml, PROVIDER);
      s.consent.add(FIELD);
      await s.push();
      put(s.macToml, 'approval_policy = "never"\n');
      await s.push();
      expect(s.toml().model_providers.acme).toEqual({ name: 'Acme', base_url: 'https://acme.test/v1', http_headers: { 'X-Key': K } });
      expect(s.toml().approval_policy).toBe('never');
    });
  }

  it('ticked after the person deleted the provider brings the whole entry too', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    await s.push();
    put(s.macToml, 'approval_policy = "never"\n');
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.acme.name).toBe('Acme');
  });

  it('where the person removed its list, lands in the sender\'s list', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    put(s.macToml, ['[model_providers.acme]', 'name = "Acme"', '', '[model_providers.acme.auth]', 'command = "tok"', ''].join('\n'));
    await s.push();
    expect(s.toml().model_providers.acme.auth.args).toEqual(['--verbose', '--token', K]);
  });

  it('where the person shortened its list, stops no push', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    put(s.macToml, ['[model_providers.acme]', 'name = "Acme"', '', '[model_providers.acme.auth]', 'command = "tok"', 'args = ["--verbose"]', ''].join('\n'));
    await s.push();
    expect(s.toml().model_providers.acme.auth.args).toEqual(['--verbose', '--token', K]);
  });

  it('where the person reshaped its list, lands by the sender\'s form and writes over no arg of theirs', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    put(s.macToml, ['[model_providers.acme]', 'name = "Acme"', '', '[model_providers.acme.auth]', 'command = "tok"', 'args = ["--token", "${REF}", "--other"]', ''].join('\n'));
    await s.push();
    expect(s.toml().model_providers.acme.auth.args).toEqual(['--verbose', '--token', K]);
  });

  it('goes to no host the person pointed the entry at before the tick', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    await s.push();
    put(s.macToml, ['[model_providers.acme]', 'name = "Mine"', 'base_url = "https://mine.example/v1"', ''].join('\n'));
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.acme).toEqual({ name: 'Acme', base_url: 'https://acme.test/v1', http_headers: { 'X-Key': K } });
  });

  it('rotating, takes the sender\'s entry and keeps no new copy', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    s.consent.add(FIELD);
    await s.push();
    const before = s.holding('');
    fs.writeFileSync(s.macToml, read(s.macToml).replace('name = "Acme"', 'name = "Edited"'));
    put(s.homeToml, PROVIDER.replace(K, 'sk_rotated_1234567890'));
    await s.push();
    expect(s.toml().model_providers.acme).toMatchObject({ name: 'Acme', http_headers: { 'X-Key': 'sk_rotated_1234567890' } });
    expect(s.holding('')).toEqual(before);
    expect(s.holding(K)).toEqual([]);
  });

  it('standing, leaves a person\'s edit of the entry', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    s.consent.add(FIELD);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace('name = "Acme"', 'name = "Edited"'));
    await s.push();
    expect(s.toml().model_providers.acme).toMatchObject({ name: 'Edited', http_headers: { 'X-Key': K } });
  });
});

describe('a table of entries', () => {
  it('keeps a provider only the target holds, with no key, its selection working', async () => {
    const s = setup();
    put(s.macToml, ['model_provider = "mine"', '', '[model_providers.mine]', 'name = "Mine"', 'env_key = "MINE_KEY"', ''].join('\n'));
    put(s.homeToml, PROVIDER);
    await s.push();
    expect(s.toml().model_provider).toBe('mine');
    expect(Object.keys(s.toml().model_providers).sort()).toEqual(['acme', 'mine']);
    expect(s.toml().model_providers.mine.env_key).toBe('MINE_KEY');
  });

  it('keeps one the person added after the mirror wrote, through a change of the sender\'s', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    await s.push();
    fs.appendFileSync(s.macToml, '\n[model_providers.mine]\nname = "Mine"\n');
    put(s.homeToml, PROVIDER.replace('name = "Acme"', 'name = "Acme 2"'));
    await s.push();
    expect(s.toml().model_providers.mine).toEqual({ name: 'Mine' });
    expect(s.toml().model_providers.acme.name).toBe('Acme 2');
  });

  it('takes an entry the mirror wrote and the sender dropped, and the table once none stays', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER + '\n[model_providers.two]\nname = "Two"\n');
    await s.push();
    put(s.homeToml, PROVIDER);
    await s.push();
    expect(Object.keys(s.toml().model_providers)).toEqual(['acme']);
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    expect(s.toml().model_providers).toBeUndefined();
  });

  it('keeps a target\'s own entry where the sender drops the table', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    await s.push();
    fs.appendFileSync(s.macToml, '\n[model_providers.mine]\nname = "Mine"\n');
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    expect(Object.keys(s.toml().model_providers)).toEqual(['mine']);
  });

  it('on a Copy, removes no provider of the home, and lays the sender\'s over it whole', async () => {
    const s = setup('copy');
    put(s.homeToml, PROVIDER);
    await s.push();
    fs.appendFileSync(s.macToml, '\n[model_providers.local]\nname = "Local"\n');
    put(s.homeToml, PROVIDER.replace('name = "Acme"', 'name = "Acme 2"'));
    await s.push();
    expect(s.toml().model_providers.local).toEqual({ name: 'Local' });
    expect(s.toml().model_providers.acme.name).toBe('Acme 2');
  });

  it('replaces a settings value that is no table of entries as one', async () => {
    const s = setup();
    const at = path.join(s.home.claudeDir, 'settings.json');
    const here = path.join(s.w.claudeDir, 'settings.json');
    editJson(at, (j) => { j.permissions = { allow: ['a'] }; });
    editJson(here, (j) => { j.permissions = { deny: ['b'] }; });
    await s.push();
    expect(json(here).permissions).toEqual({ allow: ['a'] });
  });
});

describe('a server copied whole that the person edits', () => {
  it('gives the backup their key and none of the mirror\'s when a push replaces it', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.env.MINE = OWN; });
    await s.push();
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
    expect(s.holding('odd_token_1234567890')).toEqual([]);
    expect(read(s.w.claudeJson)).not.toContain(OWN);
    expect(readState(s.stateFile).replaced).toEqual([JSON.stringify(['.claude.json', 'mcpServers', 'odd'])]);
  });

  it('holding only what the mirror wrote is in no copy', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = OWN; });
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    const [file] = s.holding(OWN);
    expect(file).toBeDefined();
    expect(json(path.join(s.backups, file)).mcpServers.odd).toBeUndefined();
  });

  const EDITS: [string, (o: any) => void][] = [
    ['a number', (o) => { o.timeout = 5; }],
    ['a string in a field the mirror cannot read', (o) => { o.sandbox.mine = OWN; }],
    ['a key of their own', (o) => { o.env.MINE = OWN; }],
    ['a known shape', (o) => { delete o.sandbox; o.command = 'my-tool'; o.args = ['--profile', 'own', OWN]; }],
  ];
  for (const [what, edit] of EDITS) {
    it(`edited with ${what}, stays as edited through the untick and the home's drop, with its record`, async () => {
      const s = setup();
      editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
      for (const f of ODD_FIELDS) s.consent.add(f);
      await s.push();
      editJson(s.w.claudeJson, (j) => edit(j.mcpServers.odd));
      const held = structuredClone(json(s.w.claudeJson).mcpServers.odd);
      s.consent.clear();
      const r = await s.push();
      expect(json(s.w.claudeJson).mcpServers.odd).toEqual(held);
      expect(r.left).toEqual(['odd']);
      editJson(s.home.claudeJson, (j) => { delete j.mcpServers.odd; });
      await s.push();
      expect(json(s.w.claudeJson).mcpServers.odd).toEqual(held);
      expect(Object.keys(readState(s.stateFile).whole ?? {})).toEqual([JSON.stringify(['.claude.json', 'mcpServers', 'odd'])]);
    });
  }

  it('unedited, goes at the untick', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    s.consent.clear();
    const r = await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toBeUndefined();
    expect(r.left).toBeUndefined();
  });

  it('edited and unticked, a later tick replaces it with the file copied first, the mirror\'s strings left out', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.env.MINE = OWN; });
    s.consent.clear();
    await s.push();
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toEqual(ODD);
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });

  it('edited with no key and unticked, a later tick replaces it too, the file copied first', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.note = 'mine and only mine'; });
    s.consent.clear();
    await s.push();
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toEqual(ODD);
    expect(s.holding('mine and only mine').length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });

  for (const mode of ['mac', 'copy'] as const) {
    it(`edited with no new string, a later tick's copy keeps the edit and leaves the key out, on a ${mode}`, async () => {
      const s = setup(mode);
      await s.push();
      editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
      for (const f of ODD_FIELDS) s.consent.add(f);
      await s.push();
      editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 98765; });
      s.consent.clear();
      await s.push();
      for (const f of ODD_FIELDS) s.consent.add(f);
      await s.push();
      expect(json(s.w.claudeJson).mcpServers.odd).toEqual(ODD);
      expect(s.holding('98765').length).toBeGreaterThan(0);
      expect(s.holding(K)).toEqual([]);
    });
  }

  it('edited, under a server the sender now holds field by field, is named with its key and not called the target\'s own', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { T: K } }; });
    s.consent.clear();
    await s.push();
    expect(read(s.w.claudeJson)).toContain(K);
    const plan = mirrorPlan(s.home, s.consent);
    const rows = setupRows(plan, configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') }), { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' });
    expect(rows.find((r) => r.key === 'edited:claude:mcp:odd')).toMatchObject({ status: 'warn', action: 'remove odd on m', detail: 'odd stays as you edited it, with the key the mirror copied in it; remove it yourself' });
    expect(rows.find((r) => r.key === 'claude:mcp:odd')?.detail).not.toContain('has its own');
  });

  it('swapped for a server holding nothing of the mirror\'s, asks no removal, and a Copy names nothing', async () => {
    for (const mode of ['mac', 'copy'] as const) {
      const s = setup(mode);
      editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
      for (const f of ODD_FIELDS) s.consent.add(f);
      await s.push();
      editJson(s.w.claudeJson, (j) => { j.mcpServers.odd = { url: 'https://mine.test', sandbox: { on: true } }; });
      s.consent.clear();
      const r = await s.push();
      expect(json(s.w.claudeJson).mcpServers.odd.url).toBe('https://mine.test');
      expect(r.left).toBeUndefined();
      const plan = mirrorPlan(s.home, s.consent);
      const row = setupRows(plan, configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') }), { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((x) => x.key === 'claude:mcp:odd');
      expect(row?.action).not.toMatch(/^remove/);
      expect(row?.detail).not.toContain('with the key');
    }
  });

  it('swapped for one with every field and nothing of the mirror\'s, its row says it stays', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd = { command: 'mine', env: { X: 'mine too' }, sandbox: { a: 'b' } }; });
    s.consent.clear();
    await s.push();
    const plan = mirrorPlan(s.home, s.consent);
    const row = setupRows(plan, configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') }), { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((x) => x.key === 'claude:mcp:odd');
    expect(row).toMatchObject({ status: 'skip', detail: 'odd stays as you edited it' });
  });

  it('edited, deleted by the person, is done with: its record goes and a tick writes it anew', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    s.consent.clear();
    await s.push();
    editJson(s.w.claudeJson, (j) => { delete j.mcpServers.odd; });
    await s.push();
    expect(readState(s.stateFile).whole ?? {}).toEqual({});
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toEqual(ODD);
  });

  it('turning per-field with an equal key stays a copy, which the untick takes', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { T: K } }; });
    s.consent.clear();
    s.consent.add('claude:mcp:odd#env.T');
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd.env.T).toBe(K);
    expect(Object.keys(readState(s.stateFile).secrets)).toContain(JSON.stringify(['.claude.json', 'mcpServers', 'odd', 'env', 'T']));
    s.consent.clear();
    await s.push();
    expect(read(s.w.claudeJson)).not.toContain(K);
  });

  it('a rollback copy holding it stays while the live one holds the key, and goes once the person deletes that', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, read(s.w.claudeJson));
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(bak)).toBe(true);
    editJson(s.w.claudeJson, (j) => { delete j.mcpServers.odd; });
    await s.push();
    expect(fs.existsSync(bak)).toBe(false);
  });

  it('a rollback copy holding its key in a field the mirror cannot read goes once the live one has none', async () => {
    const s = setup();
    const odd = { command: 'odd', sandbox: { token: K } };
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    s.consent.add('claude:mcp:odd#command').add('claude:mcp:odd#sandbox');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, read(s.w.claudeJson));
    s.consent.clear();
    await s.push();
    editJson(s.w.claudeJson, (j) => { delete j.mcpServers.odd; });
    await s.push();
    expect(fs.existsSync(bak)).toBe(false);
  });

  it('a rollback copy of a person\'s own server of that name, holding no mirror key, stays', async () => {
    const s = setup();
    put(s.w.claudeJson, JSON.stringify({ mcpServers: { odd: { command: 'uvx', env: { MINE: OWN } } } }));
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, read(s.w.claudeJson));
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'uvx', env: { T: K }, sandbox: { on: true } }; });
    s.consent.add('claude:mcp:odd#command').add('claude:mcp:odd#env').add('claude:mcp:odd#sandbox');
    await s.push();
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(bak)).toBe(true);
  });

  it('on a Copy, stays while it holds more than the copy, and the apply says so', async () => {
    for (const edit of [(o: any) => { o.timeout = 5; }, (o: any) => { o.sandbox.mine = OWN; }]) {
      const s = setup('copy');
      editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
      for (const f of ODD_FIELDS) s.consent.add(f);
      await s.push();
      editJson(s.w.claudeJson, (j) => edit(j.mcpServers.odd));
      s.consent.clear();
      const r = await s.push();
      expect(json(s.w.claudeJson).mcpServers.odd.env.T).toBe(K);
      expect(r.left).toEqual(['odd']);
    }
  });

  it('on a Copy, still the copy, goes and leaves nothing to say', async () => {
    const s = setup('copy');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    s.consent.clear();
    const r = await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toBeUndefined();
    expect(r.left).toBeUndefined();
  });
});

describe('a server of a shape the mirror cannot read', () => {
  const SWAP = { command: 'odd', sandbox: { token: OWN } };

  it('is copied first when a per-field tick replaces it, under a name the record does not hold', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.neu = SWAP; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.neu = { command: 'npx', env: { NEU_KEY: K } }; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.neu).toEqual(SWAP);
    s.consent.add('claude:mcp:neu#env.NEU_KEY');
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.neu.env.NEU_KEY).toBe(K);
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(readState(s.stateFile).replaced).toEqual([JSON.stringify(['.claude.json', 'mcpServers', 'neu'])]);
  });

  it('is the person\'s where they swapped it for one the mirror wrote: it stays unticked, and a tick copies it first', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear = SWAP; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear).toEqual(SWAP);
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.command).toBe('npx');
    expect(s.holding(OWN).length).toBeGreaterThan(0);
  });

  it('any edit that leaves it so freezes it: the sender\'s change does not land, and it stays through a drop, a row says so, and deleting it brings the sender\'s back', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.sandbox = { on: true }; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.linear.timeout = 9; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.sandbox).toEqual({ on: true });
    expect(json(s.w.claudeJson).mcpServers.linear.timeout).toBeUndefined();
    const plan = mirrorPlan(s.home, s.consent);
    const report = configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') });
    expect(setupRows(plan, report, { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((r) => r.key === 'edited:claude:mcp:linear')?.detail).toContain('stays as it is here and no longer follows');
    editJson(s.w.claudeJson, (j) => { delete j.mcpServers.linear; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear).toMatchObject({ command: 'npx', timeout: 9 });
  });

  it('frozen, stays when the home drops it', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.sandbox = { on: true }; });
    editJson(s.home.claudeJson, (j) => { delete j.mcpServers.linear; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.sandbox).toEqual({ on: true });
  });
});

describe('a per-field copy beside a key of the target\'s own', () => {
  it('on a Copy, goes at the untick while the row is listed, and their key stays', async () => {
    const s = setup('copy');
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.env.B = OWN; });
    s.consent.clear();
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.env.B).toBe(OWN);
    expect(read(s.w.claudeJson)).not.toContain('lin_api_1234567890');
  });

  it('on a Copy, stays once its sender no longer lists the row, as a Copy removes nothing', async () => {
    const s = setup('copy');
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    editJson(s.home.claudeJson, (j) => { delete j.mcpServers.linear; });
    await s.push();
    expect(read(s.w.claudeJson)).toContain('lin_api_1234567890');
    expect(Object.keys(readState(s.stateFile).secrets)).toContain(JSON.stringify(['.claude.json', 'mcpServers', 'linear', 'env', 'LINEAR_API_KEY']));
  });

  it('a config list\'s copied arg goes when the sender drops it, and the entry stays for their key', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    fs.appendFileSync(s.macToml, `\n[model_providers.acme.http_headers]\nX-Own = "${OWN}"\n`);
    put(s.homeToml, LISTED.replace(`"--token", "${K}"`, '"--plain"'));
    await s.push();
    expect(read(s.macToml)).not.toContain(K);
    expect(read(s.macToml)).toContain(OWN);
  });

  it('moved in its list by the person, reads as the mirror\'s and goes at the untick', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    s.consent.add('claude:mcp:a#args[--api-key]');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.a.args = ['--verbose', ...j.mcpServers.a.args]; });
    s.consent.clear();
    await s.push();
    expect(read(s.w.claudeJson)).not.toContain(K);
    expect(json(s.w.claudeJson).mcpServers.a.args).toContain('--verbose');
  });
});

describe('a tick over an entry holding a key of the target\'s own', () => {
  it('keeps the file first when the key is equal and only the entry differs', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear = { command: 'my-wrapper', args: ['--own'], env: { LINEAR_API_KEY: 'lin_api_1234567890' }, timeout: 5 }; });
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.command).toBe('npx');
    expect(s.holding('my-wrapper').length).toBeGreaterThan(0);
  });

  it('keeps no second copy once it has landed', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear = { command: 'my-wrapper', env: { LINEAR_API_KEY: OWN } }; });
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    await s.push();
    const copies = s.holding('');
    await s.push();
    await s.push();
    expect(s.holding('')).toEqual(copies);
  });

  it('in a config file, replaces it whole with the file copied first, whichever key differs', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER);
    s.consent.add(FIELD);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace('[model_providers.acme.http_headers]', `[model_providers.acme.http_headers]\nX-Own = "${OWN}"`));
    await s.push();
    expect(s.toml().model_providers.acme.http_headers).toEqual({ 'X-Key': K });
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });
});

describe('a config entry under a tick', () => {
  it('holding a key equal to the sender\'s and more of the target\'s, is copied first as it is replaced', async () => {
    const s = setup();
    await s.push();
    put(s.homeToml, PROVIDER);
    put(s.macToml, ['[model_providers.acme]', 'name = "Mine"', `http_headers = { "X-Key" = "${K}" }`, ''].join('\n'));
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.acme.name).toBe('Acme');
    expect(s.holding('name = "Mine"').length).toBeGreaterThan(0);
  });

  it('holding a copied arg the person moved is no key of theirs: it is replaced and no copy holds it', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace('"--verbose",', '"--new", "--verbose",'));
    await s.push();
    expect(s.toml().model_providers.acme.auth.args).toEqual(['--verbose', '--token', K]);
    expect(s.holding(K)).toEqual([]);
  });
});

describe('a Linux worker its home dials', () => {
  it('takes a ticked config key by the leaf, a person\'s edit of the entry staying', async () => {
    const s = setup('dialed');
    put(s.homeToml, PROVIDER);
    await s.push();
    fs.writeFileSync(s.macToml, read(s.macToml).replace('name = "Acme"', 'name = "Edited"'));
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.acme).toMatchObject({ name: 'Edited', http_headers: { 'X-Key': K } });
  });

  it('reads a whole copy turning per-field, its key unticked, as its own: it stays', async () => {
    const s = setup('dialed');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', env: { T: K } }; });
    s.consent.clear();
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd.env.T).toBe(K);
  });

  it('loses a whole copy it edited at the untick', async () => {
    const s = setup('dialed');
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    s.consent.clear();
    const r = await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd).toBeUndefined();
    expect(r.left).toBeUndefined();
  });

  it('is asked to set a variable its literal stands in for, as it does not keep the entry', async () => {
    const s = setup('dialed');
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.remote.headers.Authorization = `Bearer ${OWN}`; });
    const plan = mirrorPlan(s.home, s.consent);
    const report = configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') });
    expect(setupRows(plan, report, { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((r) => r.key === 'var:REMOTE_TOKEN')).toMatchObject({ status: 'warn' });
  });
});

describe('a held value of another shape than the sender\'s', () => {
  it('a table holding a key stays where the sender holds a list', async () => {
    const s = setup();
    const at = path.join(s.home.opencodeDir, 'opencode.jsonc');
    const here = path.join(s.w.opencodeDir, 'opencode.jsonc');
    await s.push();
    put(at, JSON.stringify({ provider: ['a', 'b'] }));
    put(here, JSON.stringify({ provider: { openai: { options: { apiKey: OWN } } } }));
    await s.push();
    expect(json(here).provider.openai.options.apiKey).toBe(OWN);
  });

  it('a scalar holding a key goes to the backup when a tick lands a table there', async () => {
    const s = setup();
    await s.push();
    put(s.homeToml, PROVIDER);
    put(s.macToml, `model_providers = "https://user:${OWN}@x.test"\n`);
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.acme.name).toBe('Acme');
    expect(s.holding(OWN).length).toBeGreaterThan(0);
  });
});

describe('a retained entry', () => {
  it('keeps a url it requires, in its redacted form, when the home drops the server', async () => {
    const s = setup();
    put(s.homeToml, ['[mcp_servers.gh]', `url = "https://gh.test/mcp?api_key=${K}"`, ''].join('\n'));
    s.consent.add('codex:mcp:gh#url.api_key');
    await s.push();
    expect(read(s.macToml)).toContain(K);
    fs.appendFileSync(s.macToml, `\n[mcp_servers.gh.http_headers]\nX-Mine = "${OWN}"\n`);
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    expect(read(s.macToml)).not.toContain(K);
    expect(s.toml().mcp_servers.gh.url).toMatch(/^https:\/\/gh\.test\/mcp/);
    expect(s.toml().mcp_servers.gh.http_headers['X-Mine']).toBe(OWN);
  });

  it('keeps a provider\'s base_url the same way', async () => {
    const s = setup();
    const url = `https://acme.test/v1?api_key=${K}`;
    put(s.homeToml, ['[model_providers.acme]', 'name = "Acme"', `base_url = "${url}"`, ''].join('\n'));
    const field = mirrorPlan(s.home).configs.find((c) => c.key === 'codex:config')!.fields.find((f) => f.includes('base_url'))!;
    s.consent.add(`codex:config#${field}`);
    await s.push();
    fs.appendFileSync(s.macToml, `\n[model_providers.acme.http_headers]\nX-Mine = "${OWN}"\n`);
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    expect(read(s.macToml)).not.toContain(K);
    expect(s.toml().model_providers.acme.base_url).toMatch(/^https:\/\/acme\.test\/v1/);
  });
});

describe('an override on a target that keeps', () => {
  it('of a server it no longer holds is not written, as alone it is a config Codex refuses', async () => {
    const s = setup();
    put(s.homeToml, ['[mcp_servers.gh]', 'url = "https://gh.test/mcp"', ''].join('\n'));
    put(path.join(s.w.overrides, 'codex/config.toml'), ['[mcp_servers.gh]', 'startup_timeout_sec = 9', ''].join('\n'));
    await s.push();
    expect(s.toml().mcp_servers.gh.startup_timeout_sec).toBe(9);
    put(s.homeToml, 'model = "x"\n');
    await s.push();
    expect(s.toml().mcp_servers?.gh).toBeUndefined();
  });

  it('that names a server of its own, with a dialed worker as it always has', async () => {
    const s = setup('dialed');
    put(s.homeToml, 'model = "x"\n');
    put(path.join(s.w.overrides, 'codex/config.toml'), ['[mcp_servers.only.env]', 'X = "y"', ''].join('\n'));
    await s.push();
    expect(s.toml().mcp_servers.only.env).toEqual({ X: 'y' });
  });
});

describe('Codex\'s own approval of a tool', () => {
  const TOOLS = '\n[mcp_servers.github.tools.search]\napproval_mode = "approve"\n';

  it('freezes no server on a target: the sender\'s next change lands', async () => {
    const s = setup();
    await s.push();
    fs.appendFileSync(s.macToml, TOOLS);
    fs.writeFileSync(s.homeToml, read(s.homeToml).replace('github-mcp', 'github-mcp@2'));
    await s.push();
    expect(s.toml().mcp_servers.github.args).toContain('github-mcp@2');
  });

  it('drops no server from a target where the sender holds it, on a dialed worker too', async () => {
    for (const mode of ['mac', 'dialed'] as const) {
      const s = setup(mode);
      fs.appendFileSync(s.homeToml, TOOLS);
      await s.push();
      expect(s.toml().mcp_servers.github).toMatchObject({ command: 'npx', tools: { search: { approval_mode: 'approve' } } });
    }
  });
});

describe('settings.json\'s env', () => {
  it('loses a copied variable the home no longer lists: no empty value stands in for it', async () => {
    const s = setup();
    const at = path.join(s.home.claudeDir, 'settings.json');
    const here = path.join(s.w.claudeDir, 'settings.json');
    s.consent.add('claude:settings#env.ANTHROPIC_API_KEY');
    await s.push();
    expect(json(here).env.ANTHROPIC_API_KEY).toBe('sk-mac');
    editJson(at, (j) => { delete j.env; });
    await s.push();
    expect(Object.hasOwn(json(here).env, 'ANTHROPIC_API_KEY')).toBe(false);
  });
});

describe('a config entry\'s copy', () => {
  it('leaves out a copied arg the person moved, beside their own key', async () => {
    const s = setup();
    put(s.homeToml, LISTED);
    s.consent.add(ARG);
    await s.push();
    fs.writeFileSync(s.macToml, `${read(s.macToml).replace('"--verbose",', '"--new", "--verbose",')}\n[model_providers.acme.http_headers]\nX-Own = "${OWN}"\n`);
    await s.push();
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });

  it('takes no copy for the same entry in another key order', async () => {
    const s = setup();
    await s.push();
    const before = s.holding('');
    editJson(s.w.claudeJson, (j) => { const { command, args, env } = j.mcpServers.linear; j.mcpServers.linear = { env, args, command }; });
    s.consent.add('claude:mcp:linear#env.LINEAR_API_KEY');
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'lin_api_1234567890'; });
    await s.push();
    expect(s.holding('')).toEqual(before);
    expect(readState(s.stateFile).replaced).toBeUndefined();
  });
});

describe('what a table is', () => {
  it('a section with any child that is no table stays one value on a push', async () => {
    const s = setup();
    const [at, here] = [path.join(s.home.claudeDir, 'settings.json'), path.join(s.w.claudeDir, 'settings.json')];
    editJson(at, (j) => { j.sandbox = { enabled: true }; });
    editJson(here, (j) => { j.sandbox = { enabled: false, network: { allowedDomains: ['*'] } }; });
    await s.push();
    expect(json(here).sandbox).toEqual({ enabled: true });
  });

  it('a section the sender holds with no table in it stays one value too', async () => {
    const s = setup();
    const [at, here] = [path.join(s.home.claudeDir, 'settings.json'), path.join(s.w.claudeDir, 'settings.json')];
    editJson(at, (j) => { j.tools = { a: { on: true }, plain: 1 }; });
    editJson(here, (j) => { j.tools = { mine: { on: true } }; });
    await s.push();
    expect(json(here).tools).toEqual({ a: { on: true }, plain: 1 });
  });

  it('on a Copy, every child the home holds stays, the sender\'s laid over it', async () => {
    const s = setup('copy');
    const [at, here] = [path.join(s.home.claudeDir, 'settings.json'), path.join(s.w.claudeDir, 'settings.json')];
    editJson(at, (j) => { j.permissions = { allow: ['a'] }; j.sandbox = { enabled: true }; });
    editJson(here, (j) => { j.permissions = { allow: ['b'], deny: ['keep'] }; j.sandbox = { enabled: false, network: { allowedDomains: ['x'] } }; });
    await s.push();
    expect(json(here).permissions).toEqual({ allow: ['a'], deny: ['keep'] });
    expect(json(here).sandbox).toEqual({ enabled: true, network: { allowedDomains: ['x'] } });
  });
});

describe('what a kept entry holds', () => {
  it('a TOML date in it does not hide a tick going over a key of the target\'s', async () => {
    const s = setup();
    await s.push();
    put(s.homeToml, ['[model_providers.acme]', 'since = 2026-01-02', `http_headers = { "X-Key" = "${K}" }`, ''].join('\n'));
    put(s.macToml, ['[model_providers.acme]', 'since = 2026-01-02', `http_headers = { "X-Key" = "${OWN}" }`, ''].join('\n'));
    s.consent.add(FIELD);
    await s.push();
    expect(s.toml().model_providers.acme.http_headers['X-Key']).toBe(K);
    expect(s.holding(OWN).length).toBeGreaterThan(0);
  });

  it('a TOML value JSON cannot hold stays as it was', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER.replace(K, '${K}'));
    await s.push();
    put(s.macToml, ['[model_providers.acme]', `http_headers = { "X-Key" = "${OWN}" }`, 'limit = inf', ''].join('\n'));
    put(s.homeToml, `model = "new"\n\n${PROVIDER.replace(K, '${K}').replace('name = "Acme"', 'name = "Changed"')}`);
    await s.push();
    expect(s.toml().model).toBe('new');
    expect(s.toml().model_providers.acme.limit).toBe(Infinity);
  });
});

describe('a keyed file behind a link', () => {
  it('leaves no key where the link led once unticked', async () => {
    const s = setup();
    const agent = path.join(s.home.claudeDir, 'agents/keyed.md');
    put(agent, ['---', 'name: keyed', 'mcpServers:', '  x:', '    command: x', '    env:', `      K: ${K}`, '---', 'hi', ''].join('\n'));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'darwin' } as never).plugins.find((p) => p.key.startsWith('claude:agent:'))!;
    const dotfile = path.join(s.w.homedir, 'dotfiles/keyed.md');
    put(dotfile, 'mine\n');
    fs.mkdirSync(path.join(s.w.claudeDir, 'agents'), { recursive: true });
    fs.symlinkSync(dotfile, path.join(s.w.claudeDir, 'agents/keyed.md'));
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    await s.push();
    expect(read(dotfile)).toContain(K);
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(dotfile) && read(dotfile).includes(K)).toBe(false);
  });
});

describe('a link where a keyed file lay', () => {
  it('to a file no longer the copy stays at the untick with its record, the row and an uninstall naming it', async () => {
    const s = setup();
    put(path.join(s.home.claudeDir, 'agents/keyed.md'), ['---', 'name: keyed', 'mcpServers:', '  x:', '    command: x', '    env:', `      K: ${K}`, '---', 'hi', ''].join('\n'));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'darwin' } as never).plugins.find((p) => p.key.startsWith('claude:agent:'))!;
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    await s.push();
    const landed = path.join(s.w.claudeDir, 'agents/keyed.md');
    const dotfile = path.join(s.w.homedir, 'dotfiles/keyed.md');
    put(dotfile, `${read(landed)}my edit\n`);
    fs.rmSync(landed);
    fs.symlinkSync(dotfile, landed);
    s.consent.clear();
    const r = await s.push();
    expect(fs.lstatSync(landed).isSymbolicLink()).toBe(true);
    expect(read(dotfile)).toContain('my edit');
    expect(r.left).toEqual([landed]);
    expect(Object.keys(readState(s.stateFile).keyed ?? {})).toEqual(['claude/agents/keyed.md']);
    const plan = mirrorPlan(s.home, s.consent);
    const report = configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') });
    expect(setupRows(plan, report, { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((x) => x.key === row.key)?.detail).toBe('agents/keyed.md stays as you edited it, with any key the mirror copied in it; remove it yourself');
    expect((await takeBackCopies(s.options)).join('\n')).toContain(landed);
    fs.rmSync(landed);
    await s.push();
    expect(readState(s.stateFile).keyed ?? {}).toEqual({});
  });

  it('a plain keyed file edited goes at the untick, its key with it', async () => {
    const s = setup();
    put(path.join(s.home.claudeDir, 'agents/keyed.md'), ['---', 'name: keyed', 'mcpServers:', '  x:', '    command: x', '    env:', `      K: ${K}`, '---', 'hi', ''].join('\n'));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'darwin' } as never).plugins.find((p) => p.key.startsWith('claude:agent:'))!;
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    await s.push();
    const landed = path.join(s.w.claudeDir, 'agents/keyed.md');
    fs.appendFileSync(landed, 'my edit\n');
    s.consent.clear();
    const r = await s.push();
    expect(fs.existsSync(landed)).toBe(false);
    expect(r.left).toBeUndefined();
  });

  it('to a folder stops no push', async () => {
    const s = setup();
    put(path.join(s.home.claudeDir, 'agents/keyed.md'), ['---', 'name: keyed', 'mcpServers:', '  x:', '    command: x', '    env:', `      K: ${K}`, '---', 'hi', ''].join('\n'));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'darwin' } as never).plugins.find((p) => p.key.startsWith('claude:agent:'))!;
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    await s.push();
    const landed = path.join(s.w.claudeDir, 'agents/keyed.md');
    const dir = path.join(s.w.homedir, 'dotfiles');
    put(path.join(dir, 'x.md'), 'my own\n');
    fs.rmSync(landed);
    fs.symlinkSync(dir, landed);
    s.consent.clear();
    await s.push();
    expect(read(path.join(dir, 'x.md'))).toBe('my own\n');
  });
});

describe('a keyed file on a Copy', () => {
  it('edited on the home since, is named in what the apply left', async () => {
    const s = setup('copy');
    const acme = path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, 'settings.json'), JSON.stringify({ apiKey: K, other: 1 }));
    const row = mirrorPlan(s.home, s.consent, { state: readState(s.stateFile), projects: {}, platform: 'darwin' } as never).plugins.find((p) => p.key === 'claude:plugin:acme')!;
    for (const f of row.fields) s.consent.add(`${row.key}#${f}`);
    await s.push();
    const landed = path.join(s.w.claudeDir, 'plugins/cache/mp/acme/1.0.0/settings.json');
    editJson(landed, (j) => { j.other = 2; });
    s.consent.clear();
    const r = await s.push();
    expect(read(landed)).toContain(K);
    expect(r.left).toEqual([landed]);
  });
});

describe('a plan a Copy checks', () => {
  it('names only what it could carry in each list, a keyed file with a login\'s name held back', async () => {
    const s = setup('copy');
    const acme = path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', lspServers: './token.json' }));
    put(path.join(acme, 'token.json'), JSON.stringify({ lspServers: { ts: { command: 'ts', env: { K } } } }));
    const plan = mirrorPlan(s.home, new Set(['claude:mcp:linear#env.LINEAR_API_KEY']));
    expect(plan.plugins.some((p) => p.files.some((f) => f.endsWith('token.json')))).toBe(true);
    for (const to of [...plan.files.map((f) => f.to), ...plan.keep, ...plan.keyed, ...plan.unticked, ...plan.inPlace.map((f) => f.to)]) expect(to, to).toSatisfy(carriable);
    await s.push();
  });
});

describe('the rows of a target', () => {
  const rowsOf = (s: ReturnType<typeof setup>): SetupRow[] => {
    const plan = mirrorPlan(s.home, s.consent);
    const report = configReport(reportAsk(plan), { ...s.options, overrides: s.w.overrides, envFile: path.join(s.w.homedir, '.svall/.env') });
    return setupRows(plan, report, { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' });
  };

  it('ask for no variable a server kept for a key of the target\'s own does not read', async () => {
    const s = setup();
    put(s.w.claudeJson, JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://remote.test/mcp', headers: { Authorization: `Bearer ${OWN}` } } } }));
    await s.push();
    expect(read(s.w.claudeJson)).toContain(OWN);
    expect(rowsOf(s).find((r) => r.key === 'var:REMOTE_TOKEN')).toBeUndefined();
  });

  it('ask for it where the target holds the reference', async () => {
    const s = setup();
    await s.push();
    expect(rowsOf(s).find((r) => r.key === 'var:REMOTE_TOKEN')).toMatchObject({ status: 'warn' });
  });

  it('ask for a variable a kept server still reads, by what it holds', async () => {
    const s = setup();
    put(s.w.claudeJson, JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://remote.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}', 'X-Own': OWN } } } }));
    await s.push();
    expect(rowsOf(s).find((r) => r.key === 'var:REMOTE_TOKEN')).toMatchObject({ status: 'warn' });
  });

  it('ask for none a server kept for its shape does not read', async () => {
    const s = setup();
    put(s.w.claudeJson, JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://mine.test/mcp', sandbox: { on: true } } } }));
    await s.push();
    expect(rowsOf(s).find((r) => r.key === 'var:REMOTE_TOKEN')).toBeUndefined();
  });

  it('name a whole copy edited and unticked, and what to do', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    s.consent.clear();
    await s.push();
    expect(rowsOf(s).find((r) => r.key === 'claude:mcp:odd')?.detail).toBe('odd stays as you edited it, with the key the mirror copied in it; remove it yourself');
  });

  it('offer no tick for a server in a plugin file the plan does not carry', () => {
    const s = setup();
    const acme = path.join(s.home.claudeDir, 'plugins/cache/mp/acme/1.0.0');
    put(path.join(acme, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', mcpServers: './token.json' }));
    put(path.join(acme, 'token.json'), JSON.stringify({ mcpServers: { t: { command: 'node', args: ['t.js'], env: { T_KEY: K } } } }));
    const row = setupRows(mirrorPlan(s.home, s.consent), undefined, { machine: 'm', fleetFlag: '', unchecked: 'not checked', overrides: 'overrides' }).find((r) => r.key.includes(':mcp:t'));
    expect(row).toMatchObject({ status: 'skip' });
    expect(row?.tick).toBeUndefined();
  });
});

describe('a record lost beside its backups', () => {
  it('goes on in the newest folder a push named, by its number, and in no other folder', async () => {
    const s = setup();
    for (const name of ['2026-11-01-9', '2026-11-01-10', 'zz-mine']) fs.mkdirSync(path.join(s.backups, name), { recursive: true });
    await s.push();
    expect(readState(s.stateFile).backup?.dir).toBe(path.join(s.backups, '2026-11-01-10'));
  });
});
