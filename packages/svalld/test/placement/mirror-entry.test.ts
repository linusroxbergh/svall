import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { SetupRow } from '@svall/protocol';
import { filesIn } from '../../src/placement/docs-sync.js';
import { applyMirror } from '../../src/placement/mirror-apply.js';
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

// a sender and a target that keeps backups, its own record of what the mirror wrote; `copy` a home taking a worker's Copy
function setup(mode: 'mac' | 'copy' = 'mac') {
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
  const options = { ...w, stateFile, varsFile, backups, ...(mode === 'copy' && { additive: true, refuse: refuseForeign }) };
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

  it('stays through the untick for their key, the mirror\'s gone, and no later tick copies the mirror\'s', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.env.MINE = OWN; });
    s.consent.clear();
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd.env).toEqual({ T: '', MINE: OWN });
    expect(read(s.w.claudeJson)).not.toContain('odd_token_1234567890');
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    expect(s.holding(OWN).length).toBeGreaterThan(0);
    expect(s.holding(K)).toEqual([]);
  });

  it('goes with the home\'s drop the same way', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.env.MINE = OWN; });
    editJson(s.home.claudeJson, (j) => { delete j.mcpServers.odd; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.odd.env.MINE).toBe(OWN);
    expect(read(s.w.claudeJson)).not.toContain(K);
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

  it('a rollback copy holding it goes with the untick', async () => {
    const s = setup();
    editJson(s.home.claudeJson, (j) => { j.mcpServers.odd = ODD; });
    for (const f of ODD_FIELDS) s.consent.add(f);
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    const bak = `${s.w.claudeJson}.bak-1700000000000`;
    fs.writeFileSync(bak, read(s.w.claudeJson));
    await s.push();
    expect(fs.existsSync(bak)).toBe(true);
    s.consent.clear();
    await s.push();
    expect(fs.existsSync(bak)).toBe(false);
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

  it('holding only strings the sender holds is still the mirror\'s: a change of the sender\'s replaces it', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.sandbox = { on: true }; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.linear.timeout = 9; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.timeout).toBe(9);
    expect(json(s.w.claudeJson).mcpServers.linear.sandbox).toBeUndefined();
  });

  it('holding a string the sender no longer holds stays the person\'s, unticked', async () => {
    const s = setup();
    await s.push();
    editJson(s.w.claudeJson, (j) => { j.mcpServers.linear.sandbox = { on: true }; });
    editJson(s.home.claudeJson, (j) => { j.mcpServers.linear.args = ['-y', 'linear-mcp@2']; });
    await s.push();
    expect(json(s.w.claudeJson).mcpServers.linear.sandbox).toEqual({ on: true });
    expect(json(s.w.claudeJson).mcpServers.linear.args).toEqual(['-y', 'linear-mcp']);
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

describe('what a kept entry holds', () => {
  it('a TOML value JSON cannot hold stays as it was', async () => {
    const s = setup();
    put(s.homeToml, PROVIDER.replace(K, '${K}'));
    await s.push();
    put(s.macToml, ['[model_providers.acme]', `http_headers = { "X-Key" = "${OWN}" }`, 'limit = inf', ''].join('\n'));
    put(s.homeToml, PROVIDER.replace(K, '${K}').replace('name = "Acme"', 'name = "Changed"'));
    await s.push();
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
