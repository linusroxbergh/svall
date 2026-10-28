import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableBatch } from '../../src/durable.js';
import { realPath } from '../../src/path-tools.js';
import { claudeAdapter } from '../../src/sessions/claude.js';
import { clearConsent, mask, readConsent, setConsent, tickedFields } from '../../src/placement/mirror-consent.js';
import { silentLogger } from '../../src/log.js';
import { lockAgentFiles } from '../../src/kernel-lock.js';
import { fileSha } from '../../src/placement/bundle.js';
import { mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { mirrorCalls } from '../../src/placement/mirror.js';
import { seedTrust } from '../../src/placement/trust.js';
import { SHIM } from '../../src/profile.js';
import { cleanHomes, diskLog, makeHome } from '../helpers.js';
import { editJson, FAR_HOOKS, farHome, json, macHome, marketKey, mirroredFiles, put, read, statsOf } from './mirror-homes.js';
import { H, W, until, world } from './world.js';

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  cleanHomes();
});

describe('the agent configuration mirror', () => {
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

  it('a worker applying a mirror on a disk slow to sync and to remove keeps answering its home', async () => {
    const mac = macHome();
    for (let i = 0; i < 40; i++) put(path.join(mac.claudeDir, `skills/many/${i}.md`), `${i}\n`);
    const worker = farHome();
    const w = world({ mirror: { home: mac, worker } });
    stops.push(() => w.stop());
    // each fsync takes 20 ms more, holding the thread that asks it, as a disk busy writing back does; removing a blob's
    // folder holds it 1.5 s, as one of thousands of files does
    const hold = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const [fsync, rm] = [fs.fsyncSync, fs.rmSync];
    const slow = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => { hold(20); fsync(fd); });
    const slowRm = vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => { if (path.basename(String(p)).startsWith('mirror-')) hold(1500); rm(p, o); });
    stops.push(() => { slow.mockRestore(); slowRm.mockRestore(); });
    diskLog({ syncMs: 20 });
    let last = performance.now();
    let stall = 0;
    const beat = setInterval(() => { stall = Math.max(stall, performance.now() - last); last = performance.now(); }, 5);
    stops.push(() => clearInterval(beat));
    await w.link();
    await w.home.links.pushMirror(W);
    expect(read(path.join(worker.claudeDir, 'skills/many/39.md'))).toBe('39\n');
    // a ping waits on the worker no longer than this
    expect(stall).toBeLessThan(1000);
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

  it('an apply that fails lets go of the agent files only once none of its writes is in flight, so a later apply is not written over', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const stage = path.join(scratch, 'cache');
    const style = path.join(mac.claudeDir, 'rules/style.md');
    const tars: Record<string, string> = {};
    for (const id of ['old', 'new']) {
      put(style, `${id}\n`);
      await packMirror(mirrorPlan(mac), (tars[id] = path.join(scratch, `${id}.tar`)));
    }
    const connection = { receiveBlob: async (id: string, into: string) => { fs.copyFileSync(tars[id], into); return { sha256: await fileSha(into) }; } };
    const m = mirrorCalls({ ...worker, stage, stateFile: path.join(stage, 'mirror-state.json'), varsFile: path.join(stage, 'mirror-vars.json'), envFile: path.join(stage, '.env'), connection, log: silentLogger });
    // the first apply's rename of style.md waits; another of its writes fails meanwhile
    const rename = fsp.rename;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const holding = new Promise<void>((r) => { entered = r; });
    let failed!: () => void;
    const failing = new Promise<void>((r) => { failed = r; });
    let first = true;
    let late: Promise<void> | undefined;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (first && String(to).endsWith('rules/style.md')) { entered(); await held; return (late = rename(from, to)); }
      if (first && String(to).endsWith('commands/ship.md')) {
        await holding;
        first = false;
        failed();
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    stops.push(() => spy.mockRestore());
    for (const id of ['old', 'new']) await m.calls['config.blob']({ id, sha256: await fileSha(tars[id]) });
    const old = m.calls['config.apply']({ id: 'old', seq: 1 });
    old.catch(() => {});
    await failing;
    const applied = m.calls['config.apply']({ id: 'new', seq: 2 });
    await Promise.race([applied, new Promise((r) => setTimeout(r, 1000))]);
    release();
    await expect(old).rejects.toThrow('EIO');
    await applied;
    await late;
    expect(read(path.join(worker.claudeDir, 'rules/style.md'))).toBe('new\n');
  });

  it('an applied blob that cannot be removed is logged, and the apply still answers with what it wrote', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const stage = path.join(scratch, 'cache');
    const file = path.join(scratch, 'm.tar');
    await packMirror(mirrorPlan(mac), file);
    const connection = { receiveBlob: async (_id: string, into: string) => { fs.copyFileSync(file, into); return { sha256: await fileSha(into) }; } };
    const errors: string[] = [];
    const log = { ...silentLogger, error: (msg: string) => { errors.push(msg); } };
    const m = mirrorCalls({ ...worker, stage, stateFile: path.join(stage, 'mirror-state.json'), varsFile: path.join(stage, 'mirror-vars.json'), envFile: path.join(stage, '.env'), connection, log });
    const rm = fsp.rm;
    const busy = vi.spyOn(fsp, 'rm').mockImplementation(async (p, o) => {
      if (path.basename(String(p)).startsWith('mirror-')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return rm(p, o);
    });
    stops.push(() => busy.mockRestore());
    await m.calls['config.blob']({ id: 'one', sha256: await fileSha(file) });
    const done = await m.calls['config.apply']({ id: 'one', seq: 1 }) as { written: string[] };
    expect(done.written).toContain(path.join(worker.claudeDir, 'rules/style.md'));
    expect(errors).toEqual([expect.stringMatching(/^mirror: .*mirror-.* was not removed: EBUSY/)]);
  });

  it('trust a move seeds while an apply holds the agent files is written after it, so the apply does not write over it', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const stage = path.join(scratch, 'cache');
    const file = path.join(scratch, 'm.tar');
    await packMirror(mirrorPlan(mac), file);
    const connection = { receiveBlob: async (_id: string, into: string) => { fs.copyFileSync(file, into); return { sha256: await fileSha(into) }; } };
    const m = mirrorCalls({ ...worker, stage, stateFile: path.join(stage, 'mirror-state.json'), varsFile: path.join(stage, 'mirror-vars.json'), envFile: path.join(stage, '.env'), connection, log: silentLogger });
    const app = path.join(worker.homedir, 'code/app');
    fs.mkdirSync(app, { recursive: true });
    put(worker.claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
    // the seed lands once the apply has read the config files and before it writes them
    const settle = DurableBatch.prototype.settle;
    let seeding: Promise<unknown> | undefined;
    const spy = vi.spyOn(DurableBatch.prototype, 'settle').mockImplementation(async function (this: DurableBatch) {
      if (!seeding) {
        seeding = seedTrust('claude', app, { agentHome: worker.claudeDir, homedir: worker.homedir, agentRunning: async () => false, waitMs: 5000 });
        await new Promise((r) => setTimeout(r, 300));
      }
      return settle.call(this);
    });
    stops.push(() => spy.mockRestore());
    await m.calls['config.blob']({ id: 'one', sha256: await fileSha(file) });
    await m.calls['config.apply']({ id: 'one', seq: 1 });
    expect(await seeding).toBe('seeded');
    expect(claudeAdapter.trusts!(worker.claudeDir, { cwd: app })).toBe(true);
    expect(json(worker.claudeJson).mcpServers).toHaveProperty('linear');
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
    expect(await seedTrust('claude', app, { agentHome: worker.claudeDir, homedir: worker.homedir, agentRunning: async () => false, waitMs: 5000 })).toBe('seeded');
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
