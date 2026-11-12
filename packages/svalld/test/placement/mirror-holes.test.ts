import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { filesIn } from '../../src/placement/docs-sync.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';
import { stopWorlds, W, world } from './world.js';
import { readState } from '../../src/placement/mirror-state.js';
import { DurableBatch } from '../../src/durable.js';
import { applyMirror, takeBackCopies } from '../../src/placement/mirror-apply.js';
import { carriable, mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { unpack } from '../../src/placement/move-steps.js';
import { makeHome } from '../helpers.js';
import { realPath } from '../../src/paths.js';

afterEach(async () => { vi.restoreAllMocks(); await stopWorlds(); });
const call = async <T = unknown>(ctx: Ctx, method: string, params: object): Promise<T> => {
  const res = await dispatch({ id: 1, method, params } as never, ctx);
  if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result as T;
};
const OWN = 'sk_live_00001234567890';
const setup = () => {
  const home = macHome();
  const mac = farHome();
  fs.rmSync(mac.overrides, { recursive: true, force: true });
  const backups = path.join(mac.homedir, '.svall/mirror-backup');
  const w = world({ mirror: { home, worker: { ...mac, platform: 'darwin', backups } } });
  return { home, mac, backups, w };
};
const holding = (dir: string, value: string): string[] => (fs.existsSync(dir) ? filesIn(dir).filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(value)) : []);

describe('the mirror on what a person holds, by its guards', () => {
  it('T1 a config key the home drops stays while it holds a key the Mac set itself', async () => {
    const { home, mac, w } = setup();
    const homeToml = path.join(home.codexDir, 'config.toml');
    put(homeToml, ['[model_providers.acme]', 'name = "Acme"', ''].join('\n'));
    await w.link();
    await w.home.links.mirrorSettled(W);
    const macToml = path.join(mac.codexDir, 'config.toml');
    put(macToml, ['[model_providers.acme]', 'name = "Acme"', `http_headers = { "X-Key" = "${OWN}" }`, ''].join('\n'));
    put(homeToml, 'model = "x"\n');
    await w.home.links.pushMirror(W);
    expect((parseToml(read(macToml)) as any).model_providers?.acme?.http_headers?.['X-Key']).toBe(OWN);
  });

  it('T2 a server copied whole holding a literal env key leaves when the home drops it', async () => {
    const { home, mac, w } = setup();
    const odd = { command: 'odd', env: { K: 'sk_copied_1234567890' }, sandbox: { token: 'odd_token_1234567890' } };
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    const { rows } = await call<{ rows: { key: string; tick?: { fields: string[] } }[] }>(w.home.ctx, 'machines.setup', { machine: W });
    const row = rows.find((r) => r.key === 'claude:mcp:odd');
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields: row!.tick!.fields, on: true });
    expect(json(mac.claudeJson).mcpServers.odd?.sandbox?.token ?? json(mac.claudeJson).mcpServers.odd?.env?.K).toBeDefined();
    const copied = read(mac.claudeJson);
    expect(copied).toContain('sk_copied_1234567890');
    editJson(home.claudeJson, (j) => { delete j.mcpServers.odd; });
    await w.home.links.pushMirror(W);
    expect(read(mac.claudeJson)).not.toContain('sk_copied_1234567890');
    expect(json(mac.claudeJson).mcpServers.odd).toBeUndefined();
  });

  it('T6 a server copied whole holding a literal env key leaves its key on an untick', async () => {
    const { home, mac, w } = setup();
    const odd = { command: 'odd', env: { K: 'sk_copied_1234567890' }, sandbox: { token: 'odd_token_1234567890' } };
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    const { rows } = await call<{ rows: { key: string; tick?: { fields: string[] } }[] }>(w.home.ctx, 'machines.setup', { machine: W });
    const fields = rows.find((r) => r.key === 'claude:mcp:odd')!.tick!.fields;
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields, on: true });
    expect(read(mac.claudeJson)).toContain('sk_copied_1234567890');
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields, on: false });
    expect(read(mac.claudeJson)).not.toContain('sk_copied_1234567890');
  });

  it('T7 a config file holding what the home sends is copied first, so the next push replaces it with a copy', async () => {
    const { home, mac, backups, w } = setup();
    put(path.join(home.codexDir, 'config.toml'), 'model = "same"\n');
    put(path.join(mac.codexDir, 'config.toml'), 'model = "same"\n');
    await w.link();
    await w.home.links.mirrorSettled(W);
    put(path.join(home.codexDir, 'config.toml'), 'model = "changed"\n');
    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.codexDir, 'config.toml'))).toContain('changed');
    expect(holding(backups, 'model = "same"').some((f) => f.endsWith('config.toml'))).toBe(true);
  });

  const ownPlugin = (mac: { claudeDir: string }) => {
    put(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { onlymac: [{ scope: 'user', installPath: '/x', version: '1' }] } }));
    put(path.join(mac.claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'onlymac@x': true } }));
  };
  const installed = (mac: { claudeDir: string }) => Object.keys(json(path.join(mac.claudeDir, 'plugins/installed_plugins.json')).plugins).sort();

  it('T8 a Mac\'s own plugin stays through a push cut short after its list is written', async () => {
    const { home, mac, w } = setup();
    ownPlugin(mac);
    put(path.join(mac.claudeDir, 'rules/style.md'), 'mine\n');
    const stop = realPath(path.join(mac.claudeDir, 'rules/style.md'));
    const write = DurableBatch.prototype.write;
    let cut = true;
    vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(async function (this: DurableBatch, file, data, mode) {
      if (cut && file === stop) {
        // the list goes first, as the pool may order it
        await new Promise((r) => { setTimeout(r, 200); });
        throw new Error('killed');
      }
      return write.call(this, file, data, mode);
    });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(installed(mac)).toContain('acme');
    cut = false;
    editJson(path.join(home.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins.more = [{ scope: 'user', installPath: '/m', version: '1' }]; });
    await w.home.links.pushMirror(W);
    expect(installed(mac)).toEqual(['acme', 'more', 'onlymac']);
    expect(json(path.join(mac.claudeDir, 'settings.json')).enabledPlugins['onlymac@x']).toBe(true);
  });

  it('T9 a Mac\'s own enabled plugin stays through a push that leaves enabledPlugins alone, then one that changes it', async () => {
    const { home, mac, w } = setup();
    ownPlugin(mac);
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'acme@mp': true }; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(path.join(mac.claudeDir, 'settings.json')).enabledPlugins).toEqual({ 'onlymac@x': true, 'acme@mp': true });
    put(path.join(home.claudeDir, 'rules/new.md'), 'new\n');
    await w.home.links.pushMirror(W);
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'more@mp': true }; });
    await w.home.links.pushMirror(W);
    expect(json(path.join(mac.claudeDir, 'settings.json')).enabledPlugins).toEqual({ 'onlymac@x': true, 'more@mp': true });
  });

  it('T11 a Copy keeps the record of a key file a later Copy no longer sends, so uninstall takes it back', async () => {
    const mac = macHome();
    const onHome = farHome();
    const scratch = makeHome();
    const o = { ...onHome, stateFile: path.join(scratch, 'mirror-state.json'), varsFile: path.join(scratch, 'mirror-vars.json'), backups: path.join(scratch, 'mirror-backup'), additive: true };
    const apply = async (name: string) => {
      await packMirror(mirrorPlan(mac, new Set(['claude:plugin:acme:mcp:pdf#env.PDF_KEY', 'claude:agent:db.md#mcpServers.pg'])), path.join(scratch, name + '.tar'));
      await unpack(path.join(scratch, name + '.tar'), path.join(scratch, name));
      await applyMirror(path.join(scratch, name), o);
    };
    put(path.join(mac.claudeDir, 'agents/db.md'), ['---', 'name: db', 'mcpServers:', '  - pg:', '      command: npx', '      env:', '        PG_PASSWORD: pg_fake_1234567890', '---', 'the agent', ''].join('\n'));
    await apply('one');
    const mcp = path.join(onHome.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json');
    const agent = path.join(onHome.claudeDir, 'agents/db.md');
    expect(read(mcp)).toContain('pdf_key_1234567890');
    expect(read(agent)).toContain('pg_fake_1234567890');
    fs.rmSync(path.join(mac.claudeDir, 'agents/db.md'));
    fs.rmSync(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/.mcp.json'));
    fs.rmSync(path.join(mac.claudeDir, 'plugins/marketplaces/mp/acme/.mcp.json'));
    await apply('two');
    expect(read(agent)).toContain('pg_fake_1234567890');
    await takeBackCopies(o);
    expect(read(agent)).not.toContain('pg_fake_1234567890');
    expect(fs.existsSync(mcp)).toBe(false);
  });

  it('T12 a copy failing in the re-merge stops the tick, with the key set in the window where it was', async () => {
    const { mac, backups, w } = setup();
    await w.link();
    await w.home.links.mirrorSettled(W);
    const K1 = 'sk_own_window_1234567890';
    const write = DurableBatch.prototype.write;
    let written = false;
    vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(async function (this: DurableBatch, file, data, mode) {
      if (!written && path.basename(file) === 'mirror-state.json') {
        written = true;
        editJson(mac.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
      }
      if (file.startsWith(backups) && written) throw new Error('killed');
      return write.call(this, file, data, mode);
    });
    await expect(call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true })).rejects.toThrow('Saved; w1 has not taken it yet');
    expect(json(mac.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(K1);
  });

  it('T13 what no plan carries is refused by the list, not only by the secret screen', () => {
    for (const to of ['home/.bashrc', 'home/.config/fish/config.fish', 'claude/settings.json', 'claude/hooks/x.sh', 'claude/skills/../../.bashrc', 'opencode/opencode.json', 'x/y']) expect(carriable(to), to).toBe(false);
  });

  it('T14 the copy a tick keeps holds no server the mirror copied whole', async () => {
    const { home, mac, backups, w } = setup();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } }; });
    put(mac.claudeJson, JSON.stringify({ numStartups: 1 }));
    await w.link();
    await w.home.links.mirrorSettled(W);
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields: ['command', 'sandbox'], on: true });
    expect(read(mac.claudeJson)).toContain('odd_token_1234567890');
    editJson(mac.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'sk_own_mac_1234567890'; });
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    expect(holding(backups, 'sk_own_mac_1234567890')).toHaveLength(1);
    expect(holding(backups, 'odd_token_1234567890')).toEqual([]);
  });

  it('T3 a server with a ticked copy the home drops leaves, key and all', async () => {
    const { home, mac, w } = setup();
    await w.link();
    await w.home.links.mirrorSettled(W);
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    expect(json(mac.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
    editJson(home.claudeJson, (j) => { delete j.mcpServers.linear; });
    await w.home.links.pushMirror(W);
    expect(json(mac.claudeJson).mcpServers.linear).toBeUndefined();
    expect(readState(w.worker.paths.mirrorState).secrets).toEqual({});
  });

  it('T4 an opencode config of the Mac\'s own is copied first', async () => {
    const { mac, backups, w } = setup();
    put(path.join(mac.opencodeDir, 'opencode.jsonc'), '{ "mine": true }\n');
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(holding(backups, '"mine"').some((f) => f.endsWith('opencode.jsonc'))).toBe(true);
  });

  it('T5 a config key copied, then a tick off with a recorded copy in a config file, leaves no key', async () => {
    const { mac, w } = setup();
    await w.link();
    await w.home.links.mirrorSettled(W);
    const item = { machine: W, item: 'codex:config', fields: ['model_providers.acme.http_headers.X-Key'] };
    await call(w.home.ctx, 'machines.consent', { ...item, on: true });
    const toml = path.join(mac.codexDir, 'config.toml');
    expect(read(toml)).toContain('acme_key_1234567890');
    await call(w.home.ctx, 'machines.consent', { ...item, on: false });
    expect(read(toml)).not.toContain('acme_key_1234567890');
  });
});
