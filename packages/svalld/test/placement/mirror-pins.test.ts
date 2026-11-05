import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, type Ctx } from '../../src/api/methods.js';
import { DurableBatch } from '../../src/durable.js';
import { filesIn } from '../../src/placement/docs-sync.js';
import { MANIFEST, readState } from '../../src/placement/mirror-state.js';
import { applyMirror } from '../../src/placement/mirror-apply.js';
import { refuseForeign } from '../../src/placement/mirror-copy.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { unpack } from '../../src/placement/move-steps.js';

import { makeHome } from '../helpers.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';
import { stopWorlds, until, W, world } from './world.js';

afterEach(async () => { vi.restoreAllMocks(); await stopWorlds(); });
const call = async <T = unknown>(ctx: Ctx, method: string, params: object): Promise<T> => {
  const res = await dispatch({ id: 1, method, params } as never, ctx);
  if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result as T;
};
const OWN = 'sk_live_00001234567890';
const bare = () => {
  const homedir = makeHome();
  const claudeDir = path.join(homedir, '.claude');
  return { homedir, claudeDir, codexDir: path.join(homedir, '.codex'), agentProfiles: path.join(homedir, '.svall/agent-profiles'), claudeJson: path.join(homedir, '.claude.json'), opencodeDir: path.join(homedir, '.config/opencode') };
};
const holding = (dir: string, value: string): string[] => (fs.existsSync(dir) ? filesIn(dir).filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(value)) : []);
const toml = (m: { codexDir: string }) => parseToml(read(path.join(m.codexDir, 'config.toml'))) as any;
const tomlAt = (m: { codexDir: string }, lines: string[]) => put(path.join(m.codexDir, 'config.toml'), [...lines, ''].join('\n'));
const list = (m: { claudeDir: string }) => path.join(m.claudeDir, 'plugins/installed_plugins.json');
const onLinux = () => {
  const home = bare();
  put(home.claudeJson, JSON.stringify({ mcpServers: {} }));
  const worker = farHome();
  fs.rmSync(worker.overrides, { recursive: true, force: true });
  const w = world({ mirror: { home, worker } });
  return { home, worker, w, synced: async () => { await w.link(); await w.home.links.mirrorSettled(W); } };
};
const onMac = () => {
  const home = bare();
  put(home.claudeJson, JSON.stringify({ mcpServers: {} }));
  const mac = farHome();
  fs.rmSync(mac.overrides, { recursive: true, force: true });
  const backups = path.join(mac.homedir, '.svall/mirror-backup');
  const w = world({ mirror: { home, worker: { ...mac, platform: 'darwin', backups } } });
  return { home, mac, backups, w, synced: async () => { await w.link(); await w.home.links.mirrorSettled(W); }, push: () => w.home.links.pushMirror(W), consent: (item: string, fields: string[], on: boolean) => call(w.home.ctx, 'machines.consent', { machine: W, item, fields, on }) };
};

describe('a Linux worker its home dials', () => {
  it('G1 takes the home\'s config entry over its own literal', async () => {
    const { home, worker, synced } = onLinux();
    tomlAt(worker, ['[model_providers.acme]', 'name = "Mine"', `http_headers = { "X-Key" = "${OWN}" }`]);
    tomlAt(home, ['[model_providers.acme]', 'name = "Acme"', 'http_headers = { "X-Key" = "\${K}" }']);
    await synced();
    expect(toml(worker).model_providers.acme.name).toBe('Acme');
  });

  it('G2 takes the home\'s server over one of its own of a shape the mirror cannot read', async () => {
    const { home, worker, synced } = onLinux();
    put(worker.claudeJson, JSON.stringify({ mcpServers: { odd: { command: 'mine', sandbox: { on: true } } } }));
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'home', args: ['x'], env: { K: '${K}' } }; });
    await synced();
    expect(json(worker.claudeJson).mcpServers.odd.command).toBe('home');
  });

  it('G3 does not merge again what an agent wrote in a push\'s window', async () => {
    const { home, worker, w, synced } = onLinux();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'] }; });
    await synced();
    const write = DurableBatch.prototype.write;
    let done = false;
    vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(async function (this: DurableBatch, file, data, mode) {
      if (!done && path.basename(file) === 'mirror-state.json') { done = true; editJson(worker.claudeJson, (j) => { j.written = 'in the window'; }); }
      return write.call(this, file, data, mode);
    });
    editJson(home.claudeJson, (j) => { j.mcpServers.a.args = ['b']; });
    await w.home.links.pushMirror(W);
    expect(done).toBe(true);
    expect(json(worker.claudeJson).written).toBeUndefined();
  });
});

describe('listed', () => {
  it('L1 a person removes the list as the home drops it, then installs: a list brought back does not take it', async () => {
    const { home, mac, synced, push } = onMac();
    put(list(home), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/a', version: '1' }] } }));
    await synced();
    fs.rmSync(list(mac));
    fs.rmSync(list(home));
    await push();
    put(list(mac), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/mine', version: '9' }] } }));
    await push();
    put(list(home), JSON.stringify({ version: 2, plugins: {} }));
    await push();
    expect(Object.keys(json(list(mac)).plugins)).toContain('acme');
  });

  it('L2 the home drops enabledPlugins, the person enables one, the home enables another: the person\'s stays', async () => {
    const { home, mac, synced, push } = onMac();
    const s = (m: { claudeDir: string }) => path.join(m.claudeDir, 'settings.json');
    put(s(home), JSON.stringify({ enabledPlugins: { 'acme@mp': true } }));
    await synced();
    put(s(home), JSON.stringify({ model: 'x' }));
    await push();
    editJson(s(mac), (j) => { j.enabledPlugins = { 'acme@mp': true }; });
    await push();
    put(s(home), JSON.stringify({ model: 'x', enabledPlugins: { 'beta@mp': true } }));
    await push();
    expect(json(s(mac)).enabledPlugins['acme@mp']).toBe(true);
  });
});

describe('the entry', () => {
  const K = 'sk_home_00001234567890';
  it('E1 a tick on a list the person reshaped, with no key of their own in it, lands by the sender\'s form', async () => {
    const { home, mac, synced, consent } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    await synced();
    editJson(mac.claudeJson, (j) => { j.mcpServers.a.args = ['-y', 'a-mcp', '--api-key', '']; });
    await consent('claude:mcp:a', ['args[--api-key]'], true);
    expect(json(mac.claudeJson).mcpServers.a.args).toEqual(['a-mcp', '--api-key', K]);
  });

  it('E2 a whole server with a lost record is a copy again: the untick takes it', async () => {
    const { home, mac, w, synced, consent, push } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } }; });
    put(path.join(mac.claudeDir, 'rules/own.md'), 'own\n');
    put(path.join(home.claudeDir, 'rules/own.md'), 'home\n');
    await synced();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    fs.rmSync(w.worker.paths.mirrorState);
    await push();
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    expect(read(mac.claudeJson)).not.toContain('odd_key_secret');
  });

  it('E3 a server the mirror wrote and the person gave a field it cannot read stays through a push', async () => {
    const { home, mac, synced, push } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'] }; });
    await synced();
    editJson(mac.claudeJson, (j) => { j.mcpServers.a.sandbox = { on: true }; delete j.mcpServers.a.command; });
    await push();
    expect(json(mac.claudeJson).mcpServers.a).toBeDefined();
  });

  it('E4 a tick on an entry holding another key of the person\'s, with the ticked key equal already, replaces it whole', async () => {
    const { home, mac, synced, consent } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { A: K, B: 'sk_home_b_1234567890' } }; });
    await synced();
    editJson(mac.claudeJson, (j) => { j.mcpServers.a.env = { A: K, B: OWN }; });
    await consent('claude:mcp:a', ['env.A'], true);
    expect(json(mac.claudeJson).mcpServers.a.env.B).toBe('${B}');
  });
});

describe('a Linux worker,', () => {
  const K = 'sk_home_00001234567890';
  it('G4 a tick keeps what the worker added to the server by hand, as it writes the key alone', async () => {
    const { home, worker, w, synced } = onLinux();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { A: K } }; });
    await synced();
    editJson(worker.claudeJson, (j) => { j.mcpServers.a.timeout = 5; });
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:a', fields: ['env.A'], on: true });
    expect(json(worker.claudeJson).mcpServers.a).toMatchObject({ timeout: 5, env: { A: K } });
  });

  it('G5 a whole server the worker holds already, ticked and unticked, leaves', async () => {
    const { home, worker, w, synced } = onLinux();
    const odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } };
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    put(worker.claudeJson, JSON.stringify({ mcpServers: { odd } }));
    await synced();
    const consent = (on: boolean) => call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields: ['command', 'sandbox'], on });
    await consent(true);
    await consent(false);
    expect(json(worker.claudeJson).mcpServers.odd).toBeUndefined();
  });
});

describe('a forged Copy', () => {
  const blobs = () => {
    const mac = macHome();
    const scratch = makeHome();
    const worker = farHome();
    const o = { ...worker, stateFile: path.join(scratch, 'state.json'), varsFile: path.join(scratch, 'vars.json'), additive: true, refuse: refuseForeign };
    const blobOf = async (name: string, change: (m: any) => void): Promise<string> => {
      const tar = path.join(scratch, name + '.tar');
      await packMirror(mirrorPlan(mac), tar);
      const dir = path.join(scratch, name);
      await unpack(tar, dir);
      const manifest = json(path.join(dir, MANIFEST));
      change(manifest);
      fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest));
      return dir;
    };
    return { o, blobOf };
  };
  it('R1 a Codex server placed at a key of Codex\'s own', async () => {
    const { o, blobOf } = blobs();
    await expect(applyMirror(await blobOf('c', (m) => { m.servers.find((x: any) => x.doc === 'config.toml').place = ['notify']; }), o)).rejects.toThrow('places a codex server');
  });
  it('R2 an OpenCode server placed outside mcp', async () => {
    const { o, blobOf } = blobs();
    await expect(applyMirror(await blobOf('o', (m) => { m.servers.find((x: any) => x.agent === 'opencode').place = ['permission', 'x']; }), o)).rejects.toThrow('places a opencode server');
  });
  it('R3 an unticked path no plan could name', async () => {
    const { o, blobOf } = blobs();
    await expect(applyMirror(await blobOf('u', (m) => { m.unticked.push('home/.ssh/config'); }), o)).rejects.toThrow('does not carry');
  });
  it('R4 an in-place path no plan could name', async () => {
    const { o, blobOf } = blobs();
    await expect(applyMirror(await blobOf('i', (m) => { m.inPlace.push({ to: 'home/.ssh/config', places: [] }); }), o)).rejects.toThrow('does not carry');
  });
});

describe('a rollback copy', () => {
  const STAMP = '.bak-1730000000000';
  it('B1 a rollback copy of a whole server the person edited, holding its key, goes with the untick', async () => {
    const { home, mac, synced, consent } = onMac();
    const odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } };
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await synced();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    fs.writeFileSync(`${mac.claudeJson}${STAMP}`, read(mac.claudeJson));
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    expect(read(mac.claudeJson)).not.toContain('odd_token');
    expect(fs.existsSync(`${mac.claudeJson}${STAMP}`)).toBe(false);
  });
});

describe('wholeKeys holds every string of the server', () => {
  const T = 'odd_token_1234567890';
  it('W1 a person\'s own key set in a whole copy, which a push then replaces, lies in the backup', async () => {
    const { home, mac, backups, synced, consent, push } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', sandbox: { token: T } }; });
    await synced();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', env: { K: OWN } }; });
    await push();
    const live = read(mac.claudeJson);
    const copies = holding(backups, OWN);
    expect(live.includes(OWN) || copies.length > 0).toBe(true);
  });
  it('W2 the same with a field the mirror cannot read kept', async () => {
    const { home, mac, backups, synced, consent, push } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', sandbox: { token: T } }; });
    await synced();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd.env = { K: OWN }; });
    await push();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd.command = 'npm'; });
    await push();
    const live2 = read(mac.claudeJson);
    const copies2 = holding(backups, OWN);
    expect(live2.includes(OWN) || copies2.length > 0).toBe(true);
  });
  it('W3 the person\'s key on an untick: a person\'s own string in an edited copy keeps the server', async () => {
    const { home, mac, synced, consent } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', sandbox: { token: T } }; });
    await synced();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd.sandbox.mine = OWN; });
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    expect(read(mac.claudeJson)).toContain(OWN);
  });
});

function copyOf() {
  const home = farHome();
  fs.rmSync(path.join(home.overrides, 'claude/CLAUDE.md'), { force: true });
  put(path.join(home.claudeDir, 'CLAUDE.md'), '# the server\n');
  const mac = { ...macHome(), overrides: path.join(home.homedir, 'unused-overrides') };
  const w = world({ mirror: { home, worker: { ...mac, backups: path.join(mac.homedir, '.svall/mirror-backup') } } });
  return {
    home, mac, w,
    ask: () => call<{ sent: number; backup?: string }>(w.home.ctx, 'machines.copySetupFrom', { machine: W }),
    consent: (item: string, fields: string[], on: boolean) => call(w.worker.ctx, 'home.setupConsent', { item, fields, on }),
    linked: async () => { await w.link(); await until(() => expect(w.worker.connection.connected()).toBe(true)); await w.home.links.mirrorSettled(W); },
  };
}
const AGENT = ['---', 'name: keyed', 'mcpServers:', '  - s:', '      command: npx', '      env:', '        K: agent_key_1234567890', '---', 'prompt', ''].join('\n');

describe('what a Copy takes back', () => {
  it('F1 a keyed file edited on the home since stays through the untick\'s Copy', async () => {
    const { home, mac, ask, consent, linked, w } = copyOf();
    put(path.join(mac.claudeDir, 'agents/keyed.md'), AGENT);
    await linked();
    const { rows } = await call<{ rows: any[] }>(w.worker.ctx, 'home.setup', {});
    const row = rows.find((r) => r.key === 'claude:agent:keyed.md');
    await consent(row.tick.item, row.tick.fields, true);
    await ask();
    const landed = path.join(home.claudeDir, 'agents/keyed.md');
    fs.appendFileSync(landed, 'edited on the home\n');
    await consent(row.tick.item, row.tick.fields, false);
    await ask();
    expect(read(landed)).toContain('edited on the home');
  });

  it('F2 a whole server edited on the home since stays through the untick\'s Copy', async () => {
    const { home, mac, ask, consent, linked } = copyOf();
    const odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } };
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await linked();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    await ask();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd.sandbox.mine = OWN; });
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    await ask();
    expect(json(home.claudeJson).mcpServers.odd.sandbox.mine).toBe(OWN);
  });

  it('F3 a whole server a Copy left, then listed unticked, is taken back', async () => {
    const { home, mac, ask, consent, linked } = copyOf();
    const odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } };
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await linked();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    await ask();
    editJson(mac.claudeJson, (j) => { delete j.mcpServers.odd; });
    await ask();
    expect(json(home.claudeJson).mcpServers.odd).toEqual(odd);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    await ask();
    expect(json(home.claudeJson).mcpServers.odd).toBeUndefined();
  });
});

describe('a key', () => {
  const HOME_KEY = 'sk-home-1234567890';
  it('G6 a Linux worker keeps its own key in settings.json env under a tick', async () => {
    const { home, worker, w, synced } = onLinux();
    put(path.join(home.claudeDir, 'settings.json'), JSON.stringify({ model: 'x', env: { ANTHROPIC_API_KEY: HOME_KEY } }));
    editJson(path.join(worker.claudeDir, 'settings.json'), (j) => { j.env = { ANTHROPIC_API_KEY: OWN }; });
    await synced();
    await call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:settings', fields: ['env.ANTHROPIC_API_KEY'], on: true });
    expect(json(path.join(worker.claudeDir, 'settings.json')).env.ANTHROPIC_API_KEY).toBe(OWN);
  });

  it('G7 a ticked key stays through each later push, and the record names it', async () => {
    const { home, mac, w, synced, consent, push } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { A: 'sk_a_1234567890' } }; });
    await synced();
    await consent('claude:mcp:a', ['env.A'], true);
    for (let i = 0; i < 3; i++) {
      await push();
      expect(json(mac.claudeJson).mcpServers.a.env.A).toBe('sk_a_1234567890');
      expect(Object.keys(readState(w.worker.paths.mirrorState).secrets).length).toBe(1);
    }
    await consent('claude:mcp:a', ['env.A'], false);
    expect(json(mac.claudeJson).mcpServers.a.env.A).toBe('${A}');
  });
});

describe('what a push and a tick leave', () => {
  it('S1 a temp beside where a linked config file leads goes at the next apply', async () => {
    const { mac, synced, push } = onMac();
    const real = path.join(mac.homedir, 'dotfiles/claude.json');
    put(real, '{}');
    fs.rmSync(mac.claudeJson, { force: true });
    fs.symlinkSync(real, mac.claudeJson);
    await synced();
    const temp = real + '.durable-1-00000001.tmp';
    fs.writeFileSync(temp, 'sk_temp_1234567890');
    await push();
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('G8 a worker\'s variables follow what the home sends: a dropped server\'s goes', async () => {
    const { home, w, synced } = onLinux();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { A_KEY: '${A_KEY}' } }; });
    await synced();
    expect(json(w.worker.paths.mirrorVars)).toContain('A_KEY');
    editJson(home.claudeJson, (j) => { delete j.mcpServers.a; });
    await w.home.links.pushMirror(W);
    expect(json(w.worker.paths.mirrorVars)).not.toContain('A_KEY');
  });

  it('N1 each tick that went over a key of the person\'s stays named', async () => {
    const { home, mac, w, synced, consent } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { K: 'sk_a_1234567890' } }; j.mcpServers.b = { command: 'npx', args: ['b'], env: { K: 'sk_b_1234567890' } }; });
    await synced();
    editJson(mac.claudeJson, (j) => { j.mcpServers.a.env.K = 'sk_own_a_1234567890'; j.mcpServers.b.env.K = 'sk_own_b_1234567890'; });
    await consent('claude:mcp:a', ['env.K'], true);
    await consent('claude:mcp:b', ['env.K'], true);
    const told = await call<{ replaced?: string[] }>(w.worker.ctx, 'home.setup', {});
    expect(told.replaced?.sort()).toEqual(['a', 'b']);
  });

  it('N2 a key set in the push\'s window that a tick goes over is named too', async () => {
    const { home, mac, w, synced, consent } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { K: 'sk_a_1234567890' } }; });
    await synced();
    const write = DurableBatch.prototype.write;
    let done = false;
    vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(async function (this: DurableBatch, file, data, mode) {
      if (!done && path.basename(file) === 'mirror-state.json') { done = true; editJson(mac.claudeJson, (j) => { j.mcpServers.a.env.K = 'sk_own_win_1234567890'; }); }
      return write.call(this, file, data, mode);
    });
    await consent('claude:mcp:a', ['env.K'], true);
    expect(done).toBe(true);
    const told = await call<{ replaced?: string[] }>(w.worker.ctx, 'home.setup', {});
    expect(told.replaced).toEqual(['a']);
  });
});

describe('entryOf', () => {
  it('E5 a top-level list holding a key of the person\'s stays whole beside the home\'s', async () => {
    const { home, mac, synced } = onMac();
    tomlAt(mac, ['mirrors = ["https://me:sk_own_1234567890@a.test/x", "https://b.test/y", "https://c.test/z"]']);
    tomlAt(home, ['mirrors = ["https://home.test/only"]']);
    await synced();
    expect(toml(mac).mirrors).toEqual(['https://me:sk_own_1234567890@a.test/x', 'https://b.test/y', 'https://c.test/z']);
  });
});

describe('a list and a Copy', () => {
  it('H1 a tick on one key of a table the target holds replaces it with the other key redacted', async () => {
    const { home, mac, synced, consent } = onMac();
    tomlAt(home, ['[model_providers.acme]', 'name = "Acme"', 'http_headers = { "X-A" = "sk_home_a_1234567890", "X-B" = "sk_home_b_1234567890" }']);
    tomlAt(mac, ['[model_providers.acme]', 'name = "Acme"', `http_headers = { "X-A" = "${OWN}" }`]);
    await synced();
    await consent('codex:config', ['model_providers.acme.http_headers.X-A'], true);
    const t = read(path.join(mac.codexDir, 'config.toml'));
    expect(t).toContain('sk_home_a_1234567890');
    expect(t).not.toContain('sk_home_b_1234567890');
  });

  it('P1 a plugin both name is the home\'s', async () => {
    const { home, mac, synced } = onMac();
    put(list(mac), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/mine', version: '9' }] } }));
    put(list(home), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/home', version: '1' }] } }));
    await synced();
    expect(json(list(mac)).plugins.acme[0].version).toBe('1');
  });

  it('P2 a list the home drops, left for own entries, stays a list Claude Code reads', async () => {
    const { home, mac, synced, push } = onMac();
    put(list(mac), JSON.stringify({ version: 2, plugins: { mine: [{ scope: 'user', installPath: '/m', version: '1' }] } }));
    put(list(home), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/a', version: '1' }] } }));
    await synced();
    fs.rmSync(list(home));
    await push();
    expect(json(list(mac))).toMatchObject({ version: 2, plugins: { mine: expect.anything() } });
  });

  it('P3 a list of the target\'s that does not parse stops no push', async () => {
    const { home, mac, backups, synced } = onMac();
    put(list(mac), 'not json');
    put(list(home), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/a', version: '1' }] } }));
    put(path.join(home.claudeDir, 'rules/style.md'), 'lands\n');
    await synced();
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('lands\n');
    expect(Object.keys(json(list(mac)).plugins)).toEqual(['acme']);
    expect(holding(backups, 'not json')).toHaveLength(1);
  });

  it('W4 the same lost key on a home, by a Copy', async () => {
    const { home, mac, w, ask, consent, linked } = copyOf();
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', sandbox: { token: 'odd_token_1234567890' } }; });
    await linked();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    await ask();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', env: { K: OWN } }; });
    await ask();
    expect(read(home.claudeJson).includes(OWN) || holding(w.home.paths.mirrorBackup, OWN).length > 0).toBe(true);
  });

  it('W5 the row of W1 says the key is in the folder', async () => {
    const { home, mac, w, backups, synced, consent, push } = onMac();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', sandbox: { token: 'odd_token_1234567890' } }; });
    await synced();
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'npx', env: { K: OWN } }; });
    await push();
    const told = await call<{ replaced?: string[]; backup?: string }>(w.worker.ctx, 'home.setup', {});
    expect(told.replaced).toEqual(['odd']);
    expect(holding(backups, OWN)).toHaveLength(1);
  });
});
