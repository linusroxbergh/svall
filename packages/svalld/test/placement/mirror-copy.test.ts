import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineId, type SetupRow } from '@svall/protocol';
import { answer, dispatch, type Ctx } from '../../src/api/methods.js';
import { rootIdOf } from '../../src/resources/scan.js';
import { DurableBatch } from '../../src/durable.js';
import { fileSha } from '../../src/placement/bundle.js';
import { filesIn } from '../../src/placement/docs-sync.js';
import { backupsHere } from '../../src/placement/mirror.js';
import { applyMirror, takeBackCopies } from '../../src/placement/mirror-apply.js';
import { setAt } from '../../src/placement/mirror-config.js';
import { refuseForeign } from '../../src/placement/mirror-copy.js';
import { setConsent } from '../../src/placement/mirror-consent.js';
import { carriable, mirrorPlan, packMirror } from '../../src/placement/mirror-plan.js';
import { keysOnly, MANIFEST, readState } from '../../src/placement/mirror-state.js';
import { unpack } from '../../src/placement/move-steps.js';
import { seedTrust } from '../../src/placement/trust.js';
import { realPath } from '../../src/paths.js';
import { silentLogger } from '../../src/log.js';
import { fleetBackups } from '../../src/uninstall.js';
import { makeHome } from '../helpers.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';
import { H, stopWorlds, until, W, world } from './world.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await stopWorlds();
});

const OTHER = MachineId.parse('dddddddd-0000-4000-8000-000000000000');
const KEY = 'lin_api_1234567890';

const call = async <T = unknown>(ctx: Ctx, method: string, params: object): Promise<T> => {
  const res = await dispatch({ id: 1, method, params } as never, ctx);
  if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result as T;
};
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'unauthorized' });
const folders = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
// the files under `dir` that hold `value`
const holding = (dir: string, value: string): string[] => filesIn(dir).filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(value));

// a machine with no agent setup
function bare() {
  const homedir = makeHome();
  const claudeDir = path.join(homedir, '.claude');
  return { homedir, claudeDir, codexDir: path.join(homedir, '.codex'), agentProfiles: path.join(homedir, '.svall/agent-profiles'), claudeJson: path.join(homedir, '.claude.json'), opencodeDir: path.join(homedir, '.config/opencode') };
}

// a home whose setup a Mac takes, and a Mac as a person's is: a large .claude.json, a config.toml, both plugin lists, a
// CLAUDE.md linked into a dotfiles tree, and files of its own where the mirror writes
function onto() {
  const home = macHome();
  const mac = farHome();
  fs.rmSync(mac.overrides, { recursive: true, force: true });
  const dotfile = path.join(mac.homedir, 'dotfiles/CLAUDE.md');
  put(dotfile, '# my own\n');
  fs.symlinkSync(dotfile, path.join(mac.claudeDir, 'CLAUDE.md'));
  put(path.join(mac.claudeDir, 'rules/style.md'), 'mine\n');
  put(path.join(mac.claudeDir, 'rules/only-here.md'), 'stays\n');
  editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.model = 'mine'; j.onlyHere = true; j.enabledPlugins = { 'onlymac@x': true }; });
  const projects = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`/Users/ada/code/p${i}`, { allowedTools: [], history: [{ display: 'x'.repeat(200) }] }]));
  put(mac.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'ada@test' }, numStartups: 41, projects, mcpServers: { minehere: { command: 'npx', args: ['-y', 'mine-mcp'] } } }));
  put(path.join(mac.codexDir, 'config.toml'), ['model = "mine"', 'approval_policy = "never"', ''].join('\n'));
  put(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { onlymac: [{ scope: 'user', installPath: path.join(mac.claudeDir, 'plugins/cache/x/onlymac/1.0.0'), version: '1.0.0' }] } }));
  put(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'), JSON.stringify({ mymarket: { source: { source: 'git', url: 'https://git.test/my.git' }, installLocation: path.join(mac.claudeDir, 'plugins/marketplaces/mymarket') } }));
  const backups = path.join(mac.homedir, '.svall/mirror-backup');
  const w = world({ mirror: { home, worker: { ...mac, platform: 'darwin', backups } } });
  const day = () => path.join(backups, folders(backups)[0]);
  return { home, mac, backups, w, day };
}

describe('the rows of a Mac', () => {
  it('name no Linux installer for a program a Mac lacks, and do on a Linux worker', async () => {
    for (const [platform, run] of [['darwin', undefined], ['linux', 'sudo apt install nodejs npm']] as const) {
      const worker = farHome();
      const w = world({ mirror: { home: macHome(), worker: { ...worker, platform } } });
      await w.link();
      vi.stubEnv('PATH', '/nonexistent');
      const { rows } = await call<{ rows: SetupRow[] }>(w.home.ctx, 'machines.setup', { machine: W });
      vi.unstubAllEnvs();
      const row = rows.find((r) => r.key === 'runtime:npx');
      expect([row?.action, row?.run]).toEqual(['install npx on w1', run]);
    }
  });

  it('say a server that runs only here does so on a Mac to a Linux worker, and not to a Mac', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const w = world({ mirror: { home: macHome(), worker: { ...farHome(), platform } } });
      await w.link();
      const { rows } = await call<{ rows: SetupRow[] }>(w.home.ctx, 'machines.setup', { machine: W });
      const row = rows.find((r) => r.key === 'maconly:claude:chrome');
      expect(row?.detail.includes('only runs on a Mac;')).toBe(platform === 'linux');
    }
  });

  it('are offered for a machine whose record says darwin, and a tick there is saved and pushed', async () => {
    const worker = farHome();
    const w = world({ mirror: { home: macHome(), worker }, record: { platform: 'darwin' }, dialIn: true });
    await w.link();
    await w.home.links.mirrorSettled(W);
    const { rows } = await call<{ rows: SetupRow[] }>(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    expect(rows.find((r) => r.key === 'claude:mcp:linear')).toMatchObject({ status: 'ok', tick: { on: true } });
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('lin_api_1234567890');
  });
});

describe('the backup of the first push onto a Mac', () => {
  it('keeps each file it replaces and no other, its owner\'s alone, and takes nothing only the Mac has', async () => {
    const { mac, backups, w, day } = onto();
    await w.link();
    await w.home.links.mirrorSettled(W);
    await w.home.links.pushMirror(W);
    expect(folders(backups)).toEqual([new Date().toLocaleDateString('en-CA')]);
    expect(read(path.join(day(), '.claude/CLAUDE.md'))).toBe('# my own\n');
    expect(read(path.join(day(), '.claude/rules/style.md'))).toBe('mine\n');
    expect(json(path.join(day(), '.claude/settings.json'))).toMatchObject({ model: 'mine', onlyHere: true });
    // nothing was there to replace
    expect(fs.existsSync(path.join(day(), '.claude/skills/review/SKILL.md'))).toBe(false);
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('terse\n');
    expect(fs.statSync(day()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(day(), '.claude/settings.json')).mode & 0o777).toBe(0o600);
    expect(read(path.join(mac.claudeDir, 'rules/only-here.md'))).toBe('stays\n');
    expect(json(path.join(mac.claudeDir, 'settings.json'))).toMatchObject({ model: 'opus', onlyHere: true });
    expect(fs.existsSync(path.join(day(), '.claude/rules/only-here.md'))).toBe(false);
  });

  it('keeps each config file and plugin list of a Mac\'s real shape whole, a large .claude.json and a linked CLAUDE.md as they were, and the link stays a link', async () => {
    const { mac, w, day } = onto();
    const own = { claudeJson: read(mac.claudeJson), toml: read(path.join(mac.codexDir, 'config.toml')), installed: read(path.join(mac.claudeDir, 'plugins/installed_plugins.json')), known: read(path.join(mac.claudeDir, 'plugins/known_marketplaces.json')) };
    await w.link();
    await w.home.links.mirrorSettled(W);
    const kept = (f: string) => read(path.join(day(), path.relative(mac.homedir, f)));
    expect(kept(mac.claudeJson)).toBe(own.claudeJson);
    expect(kept(path.join(mac.codexDir, 'config.toml'))).toBe(own.toml);
    expect(kept(path.join(mac.claudeDir, 'plugins/installed_plugins.json'))).toBe(own.installed);
    expect(kept(path.join(mac.claudeDir, 'plugins/known_marketplaces.json'))).toBe(own.known);
    expect(read(path.join(day(), '.claude/CLAUDE.md'))).toBe('# my own\n');
    // the link stays, and what it leads to takes the home's
    expect(fs.lstatSync(path.join(mac.claudeDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read(path.join(mac.homedir, 'dotfiles/CLAUDE.md'))).toBe('# how I work\n');
    expect(json(mac.claudeJson).oauthAccount).toEqual({ emailAddress: 'ada@test' });
    expect(Object.keys(json(mac.claudeJson).projects)).toHaveLength(300);
    expect(json(mac.claudeJson).mcpServers.minehere).toBeDefined();
    expect((parseToml(read(path.join(mac.codexDir, 'config.toml'))) as any).approval_policy).toBe('never');
  });

  it('with mirror-backup occupied, a push changes nothing: every target stays as it was', async () => {
    const { mac, backups, w } = onto();
    put(backups, 'a file in the way\n');
    const targets = [mac.claudeJson, path.join(mac.codexDir, 'config.toml'), path.join(mac.claudeDir, 'settings.json'), path.join(mac.claudeDir, 'CLAUDE.md'), path.join(mac.claudeDir, 'rules/style.md'), path.join(mac.claudeDir, 'plugins/installed_plugins.json'), path.join(mac.claudeDir, 'plugins/known_marketplaces.json')];
    const before = targets.map(read);
    await w.link();
    await w.home.links.mirrorSettled(W);
    await w.home.links.pushMirror(W);
    expect(targets.map(read)).toEqual(before);
    expect(fs.existsSync(path.join(mac.claudeDir, 'skills/review/SKILL.md'))).toBe(false);
    expect(read(backups)).toBe('a file in the way\n');
    expect(readState(w.worker.paths.mirrorState).files).toEqual({});
  });

  it('a file that cannot be read for its copy stops the push with nothing replaced', async () => {
    const { mac, w } = onto();
    const locked = path.join(mac.claudeDir, 'rules/style.md');
    fs.chmodSync(locked, 0o000);
    try {
      // a test running as root reads it all the same
      if (process.getuid?.() === 0) return;
      await w.link();
      await w.home.links.mirrorSettled(W);
      expect(json(path.join(mac.claudeDir, 'settings.json')).model).toBe('mine');
    } finally { fs.chmodSync(locked, 0o644); }
  });

  it('a push cut short while it copies goes on in the same folder', async () => {
    const { mac, backups, w, day } = onto();
    const write = DurableBatch.prototype.write;
    const spy = vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
      if (file.endsWith(path.join('mirror-backup', folders(backups)[0] ?? '-', '.claude/rules/style.md'))) throw new Error('killed');
      return write.call(this, file, data, mode);
    });
    const before = [mac.claudeJson, path.join(mac.codexDir, 'config.toml'), path.join(mac.claudeDir, 'settings.json'), path.join(mac.claudeDir, 'CLAUDE.md'), path.join(mac.claudeDir, 'rules/style.md')].map((f) => [f, read(f)]);
    await w.link();
    await w.home.links.mirrorSettled(W);
    // nothing was written: every target as it was, a file new here not there, and the record names only the folder
    for (const [f, text] of before) expect(read(f), f).toBe(text);
    expect(fs.existsSync(path.join(mac.claudeDir, 'skills/review/SKILL.md'))).toBe(false);
    expect(readState(w.worker.paths.mirrorState)).toMatchObject({ files: {}, servers: {}, secrets: {}, docs: {} });
    spy.mockRestore();
    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('terse\n');
    expect(folders(backups)).toHaveLength(1);
    expect(read(path.join(day(), '.claude/rules/style.md'))).toBe('mine\n');
  });

  it('a record lost after a push overwrites no copy', async () => {
    const { w, day } = onto();
    await w.link();
    await w.home.links.mirrorSettled(W);
    const { backup } = readState(w.worker.paths.mirrorState);
    fs.writeFileSync(w.worker.paths.mirrorState, JSON.stringify({ files: {}, docs: {}, servers: {}, secrets: {}, backup }));
    await w.home.links.pushMirror(W);
    expect(read(path.join(day(), '.claude/rules/style.md'))).toBe('mine\n');
  });

  it('a key a cut-short push wrote lies in no backup after the untick', async () => {
    const home = macHome();
    const mac = farHome();
    fs.rmSync(mac.overrides, { recursive: true, force: true });
    put(path.join(mac.claudeDir, 'rules/style.md'), 'mine\n');
    const backups = path.join(mac.homedir, '.svall/mirror-backup');
    const w = world({ mirror: { home, worker: { ...mac, backups } } });
    const LINEAR = { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'] };
    setConsent(w.home.paths.mirrorConsent, W, LINEAR.item, LINEAR.fields, true);
    const stop = realPath(path.join(mac.claudeDir, 'rules/style.md'));
    const write = DurableBatch.prototype.write;
    const spy = vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
      if (file === stop) throw new Error('killed');
      return write.call(this, file, data, mode);
    });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(mac.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
    spy.mockRestore();
    await call(w.home.ctx, 'machines.consent', { ...LINEAR, on: false });
    expect(json(mac.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    expect(holding(backups, KEY)).toEqual([]);
    expect(holding(backups, 'mine')).toHaveLength(1);
  });

  it('keeps a script\'s exec bit, its owner\'s alone, and one outside the home under outside-home, with each folder made on disk', async () => {
    const home = macHome();
    const mac = farHome();
    fs.rmSync(mac.overrides, { recursive: true, force: true });
    put(path.join(home.claudeDir, 'skills/run/run.sh'), 'theirs\n');
    put(path.join(mac.claudeDir, 'skills/run/run.sh'), 'mine\n');
    fs.chmodSync(path.join(mac.claudeDir, 'skills/run/run.sh'), 0o755);
    const outside = path.join(makeHome(), '.claude.json');
    put(outside, JSON.stringify({ mine: 1 }));
    const backups = path.join(mac.homedir, '.svall/mirror-backup');
    const settle = vi.spyOn(DurableBatch.prototype, 'settle');
    const w = world({ mirror: { home, worker: { ...mac, claudeJson: outside, backups } } });
    await w.link();
    await w.home.links.mirrorSettled(W);
    const day = path.join(backups, folders(backups)[0]);
    expect(fs.statSync(path.join(day, '.claude/skills/run/run.sh')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(day, '.claude/settings.json')).mode & 0o777).toBe(0o600);
    expect(json(path.join(day, 'outside-home', outside))).toEqual({ mine: 1 });
    expect(settle.mock.calls.flatMap(([also]) => also ?? [])).toEqual(expect.arrayContaining([path.join(mac.homedir, '.svall'), backups, day, path.join(day, '.claude/skills/run')]));
  });

  it('a second push keeps no copy of what the mirror wrote, whatever it replaces', async () => {
    const { home, mac, backups, w, day } = onto();
    await w.link();
    await w.home.links.pushMirror(W);
    const held = readState(w.worker.paths.mirrorState).backup;
    put(path.join(home.claudeDir, 'rules/style.md'), 'terser\n');
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# edited since\n');
    // what the mirror itself wrote at the first push, with nothing there before it
    put(path.join(home.claudeDir, 'skills/review/SKILL.md'), 'review it harder\n');
    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.claudeDir, 'skills/review/SKILL.md'))).toBe('review it harder\n');
    expect(fs.existsSync(path.join(day(), '.claude/skills/review/SKILL.md'))).toBe(false);
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('terser\n');
    expect(read(path.join(day(), '.claude/rules/style.md'))).toBe('mine\n');
    expect(folders(backups)).toHaveLength(1);
    expect(read(path.join(day(), '.claude/CLAUDE.md'))).toBe('# my own\n');
    expect(readState(w.worker.paths.mirrorState).backup).toEqual(held);
  });

  it('a push killed between a copy and its write loses nothing, and the next goes on in the same folder without overwriting the copy', async () => {
    const { home, mac, backups, w, day } = onto();
    const stop = realPath(path.join(mac.claudeDir, 'rules/style.md'));
    const write = DurableBatch.prototype.write;
    let dead = true;
    const spy = vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
      if (dead && file === stop) throw new Error('killed');
      return write.call(this, file, data, mode);
    });
    await w.link();
    await w.home.links.mirrorSettled(W);
    await w.home.links.pushMirror(W);
    // the copy is on disk and the file as it was, and settings.json, written before it, has its copy too
    expect(read(path.join(day(), '.claude/rules/style.md'))).toBe('mine\n');
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('mine\n');
    expect(json(path.join(mac.claudeDir, 'settings.json')).model).toBe('opus');
    const cut = readState(w.worker.paths.mirrorState).backup;
    expect(cut).toEqual({ dir: day() });
    dead = false;
    spy.mockRestore();
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { j.model = 'haiku'; });
    await w.home.links.pushMirror(W);
    expect(json(path.join(mac.claudeDir, 'settings.json')).model).toBe('haiku');
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('terse\n');
    expect(json(path.join(day(), '.claude/settings.json')).model).toBe('mine');
    expect(folders(backups)).toHaveLength(1);
    expect(readState(w.worker.paths.mirrorState).backup).toEqual({ dir: cut!.dir });
  });

  it('a file a push cut short wrote, which the next removes, is copied first', async () => {
    const { home, mac, w, day } = onto();
    const stop = realPath(path.join(mac.claudeDir, 'rules/style.md'));
    const write = DurableBatch.prototype.write;
    const spy = vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
      if (file === stop) throw new Error('killed');
      return write.call(this, file, data, mode);
    });
    put(path.join(home.claudeDir, 'rules/gone.md'), 'first\n');
    fs.rmSync(path.join(home.claudeDir, 'skills/review'), { recursive: true });
    put(path.join(mac.claudeDir, 'rules/gone.md'), 'first\n');
    await w.link();
    await w.home.links.mirrorSettled(W);
    await w.home.links.pushMirror(W);
    spy.mockRestore();
    fs.rmSync(path.join(home.claudeDir, 'rules/gone.md'));
    await w.home.links.pushMirror(W);
    expect(fs.existsSync(path.join(mac.claudeDir, 'rules/gone.md'))).toBe(false);
    expect(read(path.join(day(), '.claude/rules/gone.md'))).toBe('first\n');
  });

  it('is asked of the machine: a Mac, or one that dials its home, whatever its record says', async () => {
    expect(backupsHere('/b', undefined, 'darwin')).toBe('/b');
    expect(backupsHere('/b', {}, 'darwin')).toBe('/b');
    expect(backupsHere('/b', { homeSsh: 'ada@studio' }, 'linux')).toBe('/b');
    expect(backupsHere('/b', {}, 'linux')).toBeUndefined();
    // this world's record says linux, as a Mac enrolled with the wrong --platform's does
    const { w, day } = onto();
    await w.link();
    await w.home.links.pushMirror(W);
    expect(read(path.join(day(), '.claude/rules/style.md'))).toBe('mine\n');
  });

  it('a Linux worker that does not dial keeps no copy', async () => {
    const home = macHome();
    const worker = farHome();
    const w = world({ mirror: { home, worker } });
    await w.link();
    await w.home.links.pushMirror(W);
    expect(read(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toBe('review it\n');
    expect(readState(w.worker.paths.mirrorState).backup).toBeUndefined();
    expect(fs.existsSync(path.join(worker.homedir, '.svall/mirror-backup'))).toBe(false);
  });
});

describe('an untick reaches Svall\'s rollback copies', () => {
  const STAMP = '.bak-1700000000000';
  const LINEAR = { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'] };
  function ticking(o: { platform?: NodeJS.Platform; backups?: boolean } = {}) {
    const worker = farHome();
    const home = macHome();
    const w = world({ mirror: { home, worker: { ...worker, ...(o.platform && { platform: o.platform }), ...(o.backups && { backups: path.join(worker.homedir, '.svall/mirror-backup') }) } } });
    const consent = (item: { item: string; fields: string[] }, on: boolean) => call(w.home.ctx, 'machines.consent', { machine: W, ...item, on });
    const seed = (kind: 'claude' | 'codex') => {
      const clone = fs.mkdtempSync(path.join(worker.homedir, 'clone-'));
      return seedTrust(kind, clone, { agentHome: kind === 'claude' ? worker.claudeDir : worker.codexDir, homedir: worker.homedir, agentRunning: async () => false, waitMs: 5000 });
    };
    const linked = async () => { await w.link(); await w.home.links.mirrorSettled(W); };
    return { home, worker, w, consent, seed, linked, push: () => w.home.links.pushMirror(W) };
  }

  it.each([['a Linux worker', {}], ['a Mac worker', { platform: 'darwin', backups: true }]] as const)('the trust a first move seeds with a key ticked leaves none behind on %s', async (_name, o) => {
    const { worker, consent, seed, linked } = ticking(o);
    await linked();
    await consent(LINEAR, true);
    expect(await seed('claude')).toBe('seeded');
    const dir = path.dirname(worker.claudeJson);
    expect(holding(dir, KEY)).toHaveLength(2);
    expect(holding(dir, KEY).some((f) => /\.claude\.json\.bak-\d{13}$/.test(f))).toBe(true);
    await consent(LINEAR, false);
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    expect(holding(worker.homedir, KEY)).toEqual([]);
  });

  it('config.toml\'s route: the trust Codex seeds with a key ticked leaves none behind', async () => {
    const { worker, consent, seed, linked } = ticking();
    await linked();
    const item = { item: 'codex:mcp:github', fields: ['env.GITHUB_TOKEN'] };
    const token = 'ghp_1234567890abcdef';
    await consent(item, true);
    expect(await seed('codex')).toBe('seeded');
    expect(holding(worker.codexDir, token).some((f) => /config\.toml\.bak-\d{13}$/.test(f))).toBe(true);
    await consent(item, false);
    expect(holding(worker.homedir, token)).toEqual([]);
  });

  it('a copy left by an earlier release goes at the next push, whether or not anything changed', async () => {
    const { worker, consent, linked, push } = ticking();
    await linked();
    await consent(LINEAR, true);
    const left = read(worker.claudeJson);
    await consent(LINEAR, false);
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, left);
    await push();
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(false);
  });

  it('leaves a copy while the key is ticked, and one holding no copied value', async () => {
    const { worker, consent, linked, push } = ticking();
    await linked();
    await consent(LINEAR, true);
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, read(worker.claudeJson));
    await push();
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(true);
    await consent(LINEAR, false);
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(false);
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, JSON.stringify({ mcpServers: { own: { env: { K: 'my_own_value_1234' } } } }));
    await push();
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(true);
  });

  it('takes nothing but a regular file of the exact name that parses', async () => {
    const { worker, consent, linked, push } = ticking();
    await linked();
    await consent(LINEAR, true);
    const left = read(worker.claudeJson);
    await consent(LINEAR, false);
    const outside = path.join(worker.homedir, 'elsewhere.json');
    fs.writeFileSync(outside, left);
    const kept = ['.bak-123', '.backup', `${STAMP}.old`, '.bak-17000000000000'].map((tail) => `${worker.claudeJson}${tail}`);
    for (const f of kept) fs.writeFileSync(f, left);
    const other = path.join(path.dirname(worker.claudeJson), `other.json${STAMP}`);
    fs.writeFileSync(other, left);
    const cut = `${worker.claudeJson}.bak-1700000000001`;
    fs.writeFileSync(cut, left.slice(0, -2));
    const link = `${worker.claudeJson}${STAMP}`;
    fs.symlinkSync(outside, link);
    await push();
    for (const f of [...kept, other, cut, outside]) expect(fs.existsSync(f), f).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('finds a copy beside the file as named and beside where a link leads', async () => {
    const { worker, consent, linked, seed, push } = ticking();
    const dotfiles = path.join(worker.homedir, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const real = path.join(dotfiles, 'claude.json');
    put(real, '{}');
    fs.rmSync(worker.claudeJson, { force: true });
    fs.symlinkSync(real, worker.claudeJson);
    await linked();
    await consent(LINEAR, true);
    await seed('claude');
    expect(holding(dotfiles, KEY).some((f) => f.includes('.bak-'))).toBe(true);
    const left = read(real);
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, left);
    await consent(LINEAR, false);
    await push();
    expect(holding(dotfiles, KEY)).toEqual([]);
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(false);
  });

  it('takes a copy holding a server copied whole once it is unticked', async () => {
    const { home, worker, consent, linked } = ticking();
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } }; });
    await linked();
    const odd = { item: 'claude:mcp:odd', fields: ['command', 'sandbox'] };
    await consent(odd, true);
    expect(json(worker.claudeJson).mcpServers.odd.sandbox.token).toBe('odd_token_1234567890');
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, read(worker.claudeJson));
    await consent(odd, false);
    expect(json(worker.claudeJson).mcpServers).not.toHaveProperty('odd');
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(false);
  });

  it('svall uninstall takes a copy holding a key still ticked', async () => {
    const { worker, w, consent, linked } = ticking();
    await linked();
    await consent(LINEAR, true);
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, read(worker.claudeJson));
    const said = await takeBackCopies({ ...worker, stateFile: w.worker.paths.mirrorState });
    expect(said).toContain(`removed ${worker.claudeJson}${STAMP}, a rollback copy that held keys the mirror copied`);
    expect(holding(worker.homedir, KEY)).toEqual([]);
  });

  it('a rollback copy that cannot be removed is said and left: the apply goes on and ends', async () => {
    const worker = farHome();
    const home = macHome();
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'state.json'), varsFile: path.join(scratch, 'vars.json'), log: { error: vi.fn() } };
    const apply = async (name: string, consent: Set<string>) => {
      const tar = path.join(scratch, `${name}.tar`);
      await packMirror(mirrorPlan(home, consent), tar, readState(o.stateFile));
      await unpack(tar, path.join(scratch, name));
      return applyMirror(path.join(scratch, name), o);
    };
    await apply('ticked', new Set(['claude:mcp:linear#env.LINEAR_API_KEY']));
    const bak = `${worker.claudeJson}${STAMP}`;
    fs.writeFileSync(bak, read(worker.claudeJson));
    const rm = fsp.rm;
    vi.spyOn(fsp, 'rm').mockImplementation((file, opts) => (String(file).endsWith(STAMP) ? Promise.reject(new Error('busy')) : rm(file, opts)));
    const done = await apply('unticked', new Set());
    expect(done.removed).toEqual([]);
    expect(fs.existsSync(bak)).toBe(true);
    expect(o.log.error).toHaveBeenCalledWith(expect.stringContaining(STAMP));
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    expect(readState(o.stateFile).applied).toBeUndefined();
    expect(Object.keys(readState(o.stateFile).servers).length).toBeGreaterThan(0);
  });

  it('a rollback of a large .claude.json lets the event loop on as it reads it', async () => {
    const { worker, consent, linked } = ticking();
    await linked();
    await consent(LINEAR, true);
    const doc = json(worker.claudeJson);
    doc.projects = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`/p${i}`, `v${i}`]));
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, JSON.stringify(doc));
    const immediate = vi.spyOn(globalThis, 'setImmediate');
    await consent(LINEAR, false);
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(false);
    expect(immediate.mock.calls.length).toBeGreaterThanOrEqual(20);
  });

  it('never touches mirror-backup: a Mac\'s own key, which the home mirrors too, stays in its first push\'s backup through an untick', async () => {
    const worker = farHome();
    const backups = path.join(worker.homedir, '.svall/mirror-backup');
    put(worker.claudeJson, JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: KEY } } } }));
    const own = read(worker.claudeJson);
    const w = world({ mirror: { home: macHome(), worker: { ...worker, backups } } });
    await w.link();
    await w.home.links.mirrorSettled(W);
    const dir = path.join(backups, folders(backups)[0]);
    const kept = path.relative(worker.homedir, worker.claudeJson);
    expect(read(path.join(dir, kept))).toBe(own);
    const tree = () => filesIn(dir).map((f) => [f, read(path.join(dir, f))]);
    const before = tree();
    editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = '${LINEAR_API_KEY}'; });
    await call(w.home.ctx, 'machines.consent', { machine: W, ...LINEAR, on: true });
    fs.writeFileSync(`${worker.claudeJson}${STAMP}`, read(worker.claudeJson));
    await call(w.home.ctx, 'machines.consent', { machine: W, ...LINEAR, on: false });
    expect(fs.existsSync(`${worker.claudeJson}${STAMP}`)).toBe(false);
    expect(tree()).toEqual(before);
    expect(read(path.join(dir, kept))).toBe(own);
    await takeBackCopies({ ...worker, stateFile: w.worker.paths.mirrorState });
    expect(tree()).toEqual(before);
  });
});

// a machine with no setup, and a Mac holding its own keys in env, a url, args and Codex's env, where the home holds none
const OWN_KEY = 'sk_live_00001234567890';
function keysOnMac() {
  const home = bare();
  put(path.join(home.claudeDir, 'CLAUDE.md'), '# the server\n');
  put(home.claudeJson, JSON.stringify({ mcpServers: {} }));
  const mac = farHome();
  fs.rmSync(mac.overrides, { recursive: true, force: true });
  put(mac.claudeJson, JSON.stringify({ oauthAccount: { a: 1 }, mcpServers: {
    byEnv: { command: 'npx', args: ['-y', 'y-mcp'], env: { Y_API_KEY: OWN_KEY } },
    byUrl: { type: 'http', url: `https://u.test/mcp?api_key=${OWN_KEY}` },
    byArgs: { command: 'npx', args: ['-y', 'a-mcp', '--api-key', OWN_KEY] },
  } }));
  put(path.join(mac.codexDir, 'config.toml'), ['[mcp_servers.gh]', 'command = "npx"', 'args = ["-y", "gh-mcp"]', `env = { GITHUB_TOKEN = "${OWN_KEY}" }`, ''].join('\n'));
  const w = world({ mirror: { home, worker: { ...mac, backups: path.join(mac.homedir, '.svall/mirror-backup') } } });
  return { home, mac, w };
}
const macKeys = (mac: ReturnType<typeof farHome>) => {
  const { mcpServers: m } = json(mac.claudeJson);
  return [m.byEnv.env.Y_API_KEY, m.byUrl.url, m.byArgs.args[3], (parseToml(read(path.join(mac.codexDir, 'config.toml'))) as any).mcp_servers.gh.env?.GITHUB_TOKEN];
};
const OWN_KEYS = [OWN_KEY, `https://u.test/mcp?api_key=${OWN_KEY}`, OWN_KEY, OWN_KEY];

describe('a key the target holds itself', () => {
  const server = (v: string) => ({ command: 'npx', args: ['-y', 'y-mcp'], env: { Y_API_KEY: v } });

  it('stays on the Mac through a Copy and the next push, in env, a url, args and Codex\'s env', async () => {
    const { home, mac, w } = keysOnMac();
    await w.link();
    await w.home.links.mirrorSettled(W);
    await until(() => expect(w.worker.connection.connected()).toBe(true));
    await call(w.home.ctx, 'machines.copySetupFrom', { machine: W });
    // what landed on the home holds none of them
    expect(json(home.claudeJson).mcpServers.byEnv.env.Y_API_KEY).toBe('${Y_API_KEY}');
    expect(read(home.claudeJson)).not.toContain(OWN_KEY);
    await w.home.links.pushMirror(W);
    expect(macKeys(mac)).toEqual(OWN_KEYS);
    expect(json(mac.claudeJson).oauthAccount).toEqual({ a: 1 });
    expect(readState(w.worker.paths.mirrorState).secrets).toEqual({});
    // and each entry stays whole as the home's server changes, so nothing of another shape lands in it
    const before = json(mac.claudeJson).mcpServers;
    editJson(home.claudeJson, (j) => { j.mcpServers.byEnv.args.push('--verbose'); j.mcpServers.byUrl.timeout = 5; j.mcpServers.byArgs.args.push('--verbose'); });
    await w.home.links.pushMirror(W);
    expect(macKeys(mac)).toEqual(OWN_KEYS);
    expect(json(mac.claudeJson).mcpServers).toEqual(before);
  });

  it('stays on a first push and on a later one that brings its server by reference, and in no record as a copy', async () => {
    const { home, mac, w } = keysOnMac();
    editJson(home.claudeJson, (j) => { j.mcpServers = { byEnv: server('${Y_API_KEY}') }; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(mac.claudeJson).mcpServers.byEnv.env.Y_API_KEY).toBe(OWN_KEY);
    editJson(home.claudeJson, (j) => { j.mcpServers.byArgs = { command: 'npx', args: ['--verbose', '-y', 'a-mcp', '--api-key', '${A_KEY}'] }; });
    await w.home.links.pushMirror(W);
    // an arg's place is the list's, so the list stays whole
    expect(json(mac.claudeJson).mcpServers.byArgs.args).toEqual(['-y', 'a-mcp', '--api-key', OWN_KEY]);
    expect(await takeBackCopies({ ...mac, stateFile: w.worker.paths.mirrorState })).toEqual([]);
    expect(macKeys(mac)).toEqual(OWN_KEYS);
  });

  it('stays on the home where a Copy brings a reference or nothing, and in no backup', async () => {
    const { home, mac, w, ask, linked } = copyOf();
    put(home.claudeJson, JSON.stringify({ mcpServers: {
      byEnv: server('sk_home_00001234567890'), noEnv: { command: 'npx', args: ['-y', 'n-mcp'], env: { N_KEY: 'sk_home_00001234567890' } },
    } }));
    editJson(mac.claudeJson, (j) => { j.mcpServers.byEnv = server('${Y_API_KEY}'); j.mcpServers.noEnv = { command: 'npx', args: ['-y', 'n-mcp'] }; });
    await linked();
    await ask();
    expect(json(home.claudeJson).mcpServers.byEnv.env.Y_API_KEY).toBe('sk_home_00001234567890');
    expect(json(home.claudeJson).mcpServers.noEnv.env.N_KEY).toBe('sk_home_00001234567890');
    // a later server by the same road
    editJson(home.claudeJson, (j) => { j.mcpServers.late = { command: 'npx', args: ['-y', 'l'], env: { L_KEY: 'sk_home_only_1234567890' } }; });
    editJson(mac.claudeJson, (j) => { j.mcpServers.late = { command: 'npx', args: ['-y', 'l'], env: { L_KEY: '${L_KEY}' } }; });
    await ask();
    expect(json(home.claudeJson).mcpServers.late.env.L_KEY).toBe('sk_home_only_1234567890');
    expect(holding(w.home.paths.mirrorBackup, 'sk_home_only')).toEqual([]);
  });

  it('a key in a config file stays where the sender holds a reference or nothing', async () => {
    const { home, mac, w } = keysOnMac();
    const toml = (lines: string[]) => [...lines, '[mcp_servers.gh]', 'command = "npx"', 'args = ["-y", "gh-mcp"]', `env = { GITHUB_TOKEN = "${OWN_KEY}" }`, ''].join('\n');
    put(path.join(mac.codexDir, 'config.toml'), toml(['[model_providers.acme]', 'name = "Mine"', `http_headers = { "X-Key" = "${OWN_KEY}" }`, '']));
    put(path.join(home.codexDir, 'config.toml'), ['[model_providers.acme]', 'name = "Acme"', 'http_headers = { "X-Key" = "${X_KEY}" }', ''].join('\n'));
    await w.link();
    await w.home.links.mirrorSettled(W);
    const after = parseToml(read(path.join(mac.codexDir, 'config.toml'))) as any;
    expect(after.model_providers.acme).toEqual({ name: 'Mine', http_headers: { 'X-Key': OWN_KEY } });
  });

  it('a server of the mirror\'s the home drops stays while it holds a key of the Mac\'s own', async () => {
    const { home, mac, w } = keysOnMac();
    editJson(home.claudeJson, (j) => { j.mcpServers = { byEnv: server('${Y_API_KEY}'), plain: { command: 'npx', args: ['-y', 'p'] } }; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(mac.claudeJson).mcpServers.plain).toBeDefined();
    editJson(home.claudeJson, (j) => { j.mcpServers = {}; });
    await w.home.links.pushMirror(W);
    expect(json(mac.claudeJson).mcpServers.byEnv.env.Y_API_KEY).toBe(OWN_KEY);
    expect(json(mac.claudeJson).mcpServers.plain).toBeUndefined();
  });

  it('a key a Mac held itself, ticked on the home with the same value, is left by the untick', async () => {
    const worker = farHome();
    const home = macHome();
    put(worker.claudeJson, JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: KEY } } } }));
    const w = world({ mirror: { home, worker: { ...worker, platform: 'darwin', backups: path.join(worker.homedir, '.svall/mirror-backup') } } });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
    const consent = (on: boolean) => call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on });
    await consent(true);
    expect(readState(w.worker.paths.mirrorState).secrets).toEqual({});
    await consent(false);
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
    expect(await takeBackCopies({ ...worker, stateFile: w.worker.paths.mirrorState })).toEqual([]);
  });

  it('a server of a Mac\'s own, ticked whole on the home with the same fields, is left by the untick', async () => {
    const worker = farHome();
    const home = macHome();
    const odd = { command: 'odd', sandbox: { token: 'odd_token_1234567890' } };
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    put(worker.claudeJson, JSON.stringify({ mcpServers: { odd } }));
    const w = world({ mirror: { home, worker: { ...worker, backups: path.join(worker.homedir, '.svall/mirror-backup') } } });
    await w.link();
    await w.home.links.mirrorSettled(W);
    const consent = (on: boolean) => call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields: ['command', 'sandbox'], on });
    const { rows } = await consent(true) as { rows: SetupRow[] };
    expect(rows.find((r) => r.key === 'claude:mcp:odd')).toMatchObject({ status: 'ok', detail: 'w1 has its own' });
    await consent(false);
    expect(json(worker.claudeJson).mcpServers.odd).toEqual(odd);
  });

  describe('a tick over a key the Mac holds itself', () => {
    const K1 = 'sk_own_mac_1234567890';
    const onMac = () => {
      const worker = farHome();
      fs.rmSync(worker.overrides, { recursive: true, force: true });
      const home = macHome();
      const backups = path.join(worker.homedir, '.svall/mirror-backup');
      const w = world({ mirror: { home, worker: { ...worker, platform: 'darwin', backups } } });
      const consent = (item: string, fields: string[], on: boolean) => call<{ rows: SetupRow[] }>(w.home.ctx, 'machines.consent', { machine: W, item, fields, on });
      return { worker, home, backups, w, linear: (on: boolean) => consent('claude:mcp:linear', ['env.LINEAR_API_KEY'], on), consent };
    };
    const live = (m: { claudeJson: string }) => json(m.claudeJson).mcpServers.linear.env.LINEAR_API_KEY;

    it('goes over it with the file kept first: K1 is in the backup after the untick, in no record or log, and the row says so', async () => {
      const { worker, home, backups, w, linear, consent } = onMac();
      const said: string[] = [];
      for (const m of ['info', 'error'] as const) vi.spyOn(silentLogger, m).mockImplementation((msg: string) => { said.push(msg); });
      editJson(home.claudeJson, (j) => { j.mcpServers.other = { command: 'npx', args: ['-y', 'o-mcp'], env: { O_KEY: 'sk_other_1234567890' } }; });
      put(worker.claudeJson, JSON.stringify({ numStartups: 1 }));
      await w.link();
      await w.home.links.mirrorSettled(W);
      // the first push's copy holds no K1: the person sets it after
      editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
      await consent('claude:mcp:other', ['env.O_KEY'], true);
      expect(live(worker)).toBe(K1);
      await linear(true);
      expect(live(worker)).toBe(KEY);
      const { rows } = await linear(false);
      expect(live(worker)).toBe('${LINEAR_API_KEY}');
      const kept = path.relative(worker.homedir, worker.claudeJson);
      expect(holding(backups, K1)).toEqual([path.join(folders(backups)[0], `${kept}.2`)]);
      expect(json(path.join(backups, folders(backups)[0], kept))).toEqual({ numStartups: 1 });
      // the copy holds the person's own and nothing the mirror copied
      expect(holding(backups, 'sk_other_1234567890')).toEqual([]);
      expect(holding(backups, KEY)).toEqual([]);
      expect(read(w.worker.paths.mirrorState)).not.toContain(K1);
      expect(said.join('\n')).not.toContain(K1);
      expect(rows.find((r) => r.key === 'claude:mcp:linear')?.detail).toContain('what w1 held itself is in its mirror-backup');
      expect((await call<{ replaced?: string[] }>(w.worker.ctx, 'home.setup', {})).replaced).toEqual(['linear']);
      expect(rows.find((r) => r.key === 'claude:mcp:other')?.detail).not.toContain('mirror-backup');
      // no restore, and no copy again
      await w.home.links.pushMirror(W);
      expect(live(worker)).toBe('${LINEAR_API_KEY}');
      expect(holding(backups, K1)).toHaveLength(1);
    });

    it('keeps the first push\'s copy as it was, and takes its key from the same file once', async () => {
      const { worker, backups, w, linear } = onMac();
      put(worker.claudeJson, JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: K1 } } } }));
      const own = read(worker.claudeJson);
      await w.link();
      await w.home.links.mirrorSettled(W);
      const day = path.join(backups, folders(backups)[0]);
      const first = path.join(day, path.relative(worker.homedir, worker.claudeJson));
      expect(read(first)).toBe(own);
      await linear(true);
      expect(live(worker)).toBe(KEY);
      expect(read(first)).toBe(own);
      expect(holding(backups, K1).length).toBeGreaterThanOrEqual(1);
    });

    it('a push cut short after its copy keeps no second copy as the next goes on', async () => {
      const { worker, backups, w, linear } = onMac();
      await w.link();
      await w.home.links.mirrorSettled(W);
      editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
      const stop = realPath(worker.claudeJson);
      const write = DurableBatch.prototype.write;
      const spy = vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
        if (file === stop) throw new Error('killed');
        return write.call(this, file, data, mode);
      });
      await expect(linear(true)).rejects.toThrow('did not take it');
      expect(live(worker)).toBe(K1);
      const kept = holding(backups, K1);
      expect(kept).toHaveLength(1);
      spy.mockRestore();
      await w.home.links.pushMirror(W);
      expect(live(worker)).toBe(KEY);
      expect(holding(backups, K1)).toEqual(kept);
    });

    it('a url and a config file\'s key go the same way', async () => {
      const { worker, home, backups, w, consent } = onMac();
      const url = (k: string) => `https://u.test/mcp?api_key=${k}`;
      editJson(home.claudeJson, (j) => { j.mcpServers.byUrl = { type: 'http', url: url('sk_home_url_1234567890') }; });
      put(worker.claudeJson, JSON.stringify({ mcpServers: { byUrl: { type: 'http', url: url('sk_own_url_1234567890') } } }));
      put(path.join(worker.codexDir, 'config.toml'), ['[model_providers.acme]', 'name = "Acme"', 'http_headers = { "X-Key" = "sk_own_toml_1234567890" }', ''].join('\n'));
      await w.link();
      await w.home.links.mirrorSettled(W);
      const after = (f: string) => folders(backups).flatMap((d) => filesIn(path.join(backups, d)).map((x) => path.join(backups, d, x))).filter((x) => read(x).includes(f));
      const wiped = () => { for (const d of folders(backups)) fs.rmSync(path.join(backups, d), { recursive: true }); };
      wiped();
      await consent('claude:mcp:byUrl', ['url.api_key'], true);
      expect(json(worker.claudeJson).mcpServers.byUrl.url).toBe(url('sk_home_url_1234567890'));
      expect(after('sk_own_url_1234567890')).toHaveLength(1);
      await consent('codex:config', ['model_providers.acme.http_headers.X-Key'], true);
      expect((parseToml(read(path.join(worker.codexDir, 'config.toml'))) as any).model_providers.acme.http_headers['X-Key']).toBe('acme_key_1234567890');
      expect(after('sk_own_toml_1234567890')).toHaveLength(1);
    });

    it('a server ticked whole over one of the Mac\'s own keeps the file first', async () => {
      const { worker, home, backups, w, consent } = onMac();
      editJson(home.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: 'home_token_1234567890' } }; });
      put(worker.claudeJson, JSON.stringify({ mcpServers: { odd: { command: 'odd', sandbox: { token: 'mac_token_1234567890' } } } }));
      await w.link();
      await w.home.links.mirrorSettled(W);
      for (const d of folders(backups)) fs.rmSync(path.join(backups, d), { recursive: true });
      const { rows } = await consent('claude:mcp:odd', ['command', 'sandbox'], true);
      expect(json(worker.claudeJson).mcpServers.odd.sandbox.token).toBe('home_token_1234567890');
      expect(holding(backups, 'mac_token_1234567890')).toHaveLength(1);
      expect(rows.find((r) => r.key === 'claude:mcp:odd')?.detail).toContain('in its mirror-backup');
    });

    it('its copy failing stops the tick, with K1 where it was', async () => {
      const { worker, backups, w, linear } = onMac();
      await w.link();
      await w.home.links.mirrorSettled(W);
      editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
      const write = DurableBatch.prototype.write;
      vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
        if (file.startsWith(backups)) throw new Error('killed');
        return write.call(this, file, data, mode);
      });
      await expect(linear(true)).rejects.toThrow('did not take it');
      expect(live(worker)).toBe(K1);
      expect(readState(w.worker.paths.mirrorState).secrets).toEqual({});
    });

    it('a key the person sets as the push runs is kept too', async () => {
      const { worker, backups, w, linear } = onMac();
      await w.link();
      await w.home.links.mirrorSettled(W);
      const write = DurableBatch.prototype.write;
      let written = false;
      vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(async function (this: DurableBatch, file, data, mode) {
        if (!written && path.basename(file) === 'mirror-state.json') {
          written = true;
          editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
        }
        return write.call(this, file, data, mode);
      });
      await linear(true);
      expect(live(worker)).toBe(KEY);
      expect(holding(backups, K1)).toHaveLength(1);
    });

    it('a Copy goes over the home\'s own the same way, and answers the folder', async () => {
      const { home, w, ask, linked } = copyOf();
      await linked();
      await ask();
      editJson(home.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
      await call(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
      const { backup } = await ask();
      expect(json(home.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
      expect(backup).toBeDefined();
      expect(holding(backup!, K1)).toHaveLength(1);
      expect(read(w.home.paths.mirrorState)).not.toContain(K1);
    });

    it('a Linux worker that does not dial keeps no copy and its row names none', async () => {
      const worker = farHome();
      const w = world({ mirror: { home: macHome(), worker } });
      await w.link();
      await w.home.links.mirrorSettled(W);
      editJson(worker.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = K1; });
      const { rows } = await call<{ rows: SetupRow[] }>(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
      expect(live(worker)).toBe(KEY);
      expect(fs.existsSync(path.join(worker.homedir, '.svall/mirror-backup'))).toBe(false);
      expect(readState(w.worker.paths.mirrorState).replaced).toBeUndefined();
      expect(rows.find((r) => r.key === 'claude:mcp:linear')?.detail).not.toContain('mirror-backup');
    });
  });

  it('a server the mirror cannot read field by field, the target\'s own, stays where the sender holds one it can', async () => {
    const { home, mac, w } = keysOnMac();
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = { command: 'odd', sandbox: { token: OWN_KEY } }; });
    editJson(home.claudeJson, (j) => { j.mcpServers = { odd: { command: 'odd' } }; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(mac.claudeJson).mcpServers.odd.sandbox.token).toBe(OWN_KEY);
    editJson(home.claudeJson, (j) => { j.mcpServers = {}; });
    await w.home.links.pushMirror(W);
    expect(json(mac.claudeJson).mcpServers.odd.sandbox.token).toBe(OWN_KEY);
  });
});

describe('the entry a target keeps', () => {
  const OWN = 'sk_live_00001234567890';
  function target() {
    const home = bare();
    put(home.claudeJson, JSON.stringify({ mcpServers: {} }));
    const mac = farHome();
    fs.rmSync(mac.overrides, { recursive: true, force: true });
    const backups = path.join(mac.homedir, '.svall/mirror-backup');
    const w = world({ mirror: { home, worker: { ...mac, platform: 'darwin', backups } } });
    const consent = (item: string, fields: string[], on: boolean) => call<{ rows: SetupRow[] }>(w.home.ctx, 'machines.consent', { machine: W, item, fields, on });
    const synced = async () => { await w.link(); await w.home.links.mirrorSettled(W); };
    return { home, mac, backups, w, consent, synced, push: () => w.home.links.pushMirror(W) };
  }
  const toml = (m: { codexDir: string }) => parseToml(read(path.join(m.codexDir, 'config.toml'))) as any;
  const tomlAt = (m: { codexDir: string }, lines: string[]) => put(path.join(m.codexDir, 'config.toml'), [...lines, ''].join('\n'));

  it('a provider table holding a key stays whole beside the home\'s, not as half an entry', async () => {
    const { home, mac, synced } = target();
    tomlAt(mac, ['[model_providers.acme]', 'name = "Acme"', 'base_url = "https://a.test/v1"', `http_headers = { "X-Key" = "${OWN}" }`]);
    tomlAt(home, ['[model_providers.other]', 'name = "Other"', 'base_url = "https://o.test/v1"']);
    await synced();
    expect(toml(mac).model_providers).toEqual({
      acme: { name: 'Acme', base_url: 'https://a.test/v1', http_headers: { 'X-Key': OWN } },
      other: { name: 'Other', base_url: 'https://o.test/v1' },
    });
  });

  it('a config arg list holding a key stays whole with its table, whatever the home\'s holds, and the push ends', async () => {
    const { home, mac, synced, push } = target();
    const provider = (args: string) => ['[model_providers.acme]', 'name = "Acme"', '[model_providers.acme.auth]', 'command = "c"', `args = ${args}`];
    tomlAt(mac, provider(`["--verbose", "--token", "${OWN}"]`));
    tomlAt(home, provider('[]'));
    put(path.join(home.claudeDir, 'rules/style.md'), 'lands\n');
    await synced();
    await push();
    expect(toml(mac).model_providers.acme.auth.args).toEqual(['--verbose', '--token', OWN]);
    expect(read(path.join(mac.claudeDir, 'rules/style.md'))).toBe('lands\n');
  });

  it('a config entry the home drops stays while it holds a key of the target\'s own', async () => {
    const { home, mac, synced, push } = target();
    tomlAt(mac, ['[model_providers.acme]', `http_headers = { "X-Key" = "${OWN}" }`]);
    tomlAt(home, ['[model_providers.acme]', 'http_headers = { "X-Key" = "\${K}" }', '[model_providers.gone]', 'name = "Gone"']);
    await synced();
    tomlAt(home, ['model = "x"']);
    await push();
    expect(toml(mac).model_providers).toEqual({ acme: { http_headers: { 'X-Key': OWN } } });
  });

  it('a tick replaces an arg list whole with the home\'s, and an untick leaves the home\'s form', async () => {
    const { home, mac, synced, consent } = target();
    const K = 'sk_home_00001234567890';
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    put(mac.claudeJson, JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'a-mcp', '--api-key', OWN] } } }));
    await synced();
    const args = () => json(mac.claudeJson).mcpServers.a.args;
    expect(args()).toEqual(['-y', 'a-mcp', '--api-key', OWN]);
    await consent('claude:mcp:a', ['args[--api-key]'], true);
    expect(args()).toEqual(['a-mcp', '--api-key', K]);
    await consent('claude:mcp:a', ['args[--api-key]'], false);
    expect(args()).toEqual(['a-mcp', '--api-key', '']);
  });

  it('one key ticked replaces the whole entry, a key of the target\'s own in it going to the backup', async () => {
    const { home, mac, backups, synced, consent } = target();
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { A: 'sk_home_a_1234567890', B: 'sk_home_b_1234567890' } }; });
    put(mac.claudeJson, JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['a'], env: { B: OWN } } } }));
    await synced();
    await consent('claude:mcp:a', ['env.A'], true);
    expect(json(mac.claudeJson).mcpServers.a.env).toEqual({ A: 'sk_home_a_1234567890', B: '${B}' });
    expect(holding(backups, OWN)).toHaveLength(1);
  });

  it('a tick on an entry the person reshaped since replaces it whole, so its key lands by the sender\'s form', async () => {
    const { home, mac, synced, consent } = target();
    const K = 'sk_home_00001234567890';
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    await synced();
    editJson(mac.claudeJson, (j) => { j.mcpServers.a.args = ['-y', 'a-mcp', '--api-key', OWN]; });
    await consent('claude:mcp:a', ['args[--api-key]'], true);
    expect(json(mac.claudeJson).mcpServers.a.args).toEqual(['a-mcp', '--api-key', K]);
  });

  it('a copied arg in a server that stays for an own key is emptied when the home drops it', async () => {
    const { home, mac, synced, consent } = target();
    const K = 'sk_home_00001234567890';
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a-mcp', '--api-key', K] }; });
    await synced();
    await consent('claude:mcp:a', ['args[--api-key]'], true);
    expect(json(mac.claudeJson).mcpServers.a.args[2]).toBe(K);
    editJson(mac.claudeJson, (j) => { j.mcpServers.a.env = { MINE: OWN }; });
    editJson(home.claudeJson, (j) => { delete j.mcpServers.a; });
    await consent('claude:mcp:other', [], false);
    expect(json(mac.claudeJson).mcpServers.a).toEqual({ command: 'npx', args: ['a-mcp', '--api-key', ''], env: { MINE: OWN } });
  });

  it('a push cut short while it copies is no lost record: a key the person holds stays theirs at the next', async () => {
    const { home, mac, backups, w, synced, consent, push } = target();
    const LINEAR = { command: 'npx', args: ['l'], env: { LINEAR_API_KEY: KEY } };
    editJson(home.claudeJson, (j) => { j.mcpServers.linear = LINEAR; });
    put(mac.claudeJson, JSON.stringify({ mcpServers: { linear: LINEAR } }));
    setConsent(w.home.paths.mirrorConsent, W, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    const write = DurableBatch.prototype.write;
    const spy = vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(function (this: DurableBatch, file, data, mode) {
      if (file.startsWith(backups)) throw new Error('killed');
      return write.call(this, file, data, mode);
    });
    fs.mkdirSync(path.join(backups, new Date().toLocaleDateString('en-CA')), { recursive: true });
    await synced();
    spy.mockRestore();
    await push();
    await consent('claude:mcp:linear', ['env.LINEAR_API_KEY'], false);
    expect(json(mac.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
  });

  it('settings.json\'s env: the tick wins there too, with the file copied first', async () => {
    const { home, mac, backups, synced, consent } = target();
    put(path.join(home.claudeDir, 'settings.json'), JSON.stringify({ model: 'x', env: { ANTHROPIC_API_KEY: 'sk-home-1234567890' } }));
    await synced();
    // set once the record names the file, so only the tick's copy can hold it
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.env = { ANTHROPIC_API_KEY: OWN }; });
    await consent('claude:settings', ['env.ANTHROPIC_API_KEY'], true);
    expect(json(path.join(mac.claudeDir, 'settings.json')).env.ANTHROPIC_API_KEY).toBe('sk-home-1234567890');
    expect(holding(backups, OWN)).toHaveLength(1);
  });

  it('10 pushes of a 5 MB file with an override at a ticked place make no more than one copy', async () => {
    const { home, mac, backups, synced, consent, push } = target();
    const K = 'sk_home_00001234567890';
    editJson(home.claudeJson, (j) => { j.mcpServers.a = { command: 'npx', args: ['a'], env: { A: K } }; });
    put(mac.claudeJson, JSON.stringify({ blob: 'x'.repeat(5 * 2 ** 20), mcpServers: { a: { command: 'npx', args: ['a'], env: { A: OWN } } } }));
    put(path.join(mac.overrides, 'claude/.claude.json'), JSON.stringify({ mcpServers: { a: { env: { A: OWN } } } }));
    await synced();
    await consent('claude:mcp:a', ['env.A'], true);
    for (let i = 0; i < 10; i++) {
      editJson(mac.claudeJson, (j) => { j.startups = i; });
      await push();
    }
    expect(json(mac.claudeJson).mcpServers.a.env.A).toBe(OWN);
    expect(filesIn(backups).filter((f) => f.includes('.claude.json'))).toHaveLength(1);
  });

  it('a file the record no longer names is copied beside its earlier copy when its bytes differ, and once', async () => {
    const { home, mac, backups, synced, push } = target();
    const rule = (m: { claudeDir: string }) => path.join(m.claudeDir, 'rules/x.md');
    put(rule(mac), 'v1\n');
    put(rule(home), 'the home\'s\n');
    await synced();
    fs.rmSync(rule(home));
    await push();
    expect(fs.existsSync(rule(mac))).toBe(false);
    put(rule(mac), 'v2\n');
    put(rule(home), 'the home\'s again\n');
    await push();
    expect(read(rule(mac))).toBe('the home\'s again\n');
    const day = path.join(backups, folders(backups)[0], '.claude/rules');
    expect([read(path.join(day, 'x.md')), read(path.join(day, 'x.md.2'))]).toEqual(['v1\n', 'v2\n']);
    fs.rmSync(rule(home));
    await push();
    put(rule(mac), 'v2\n');
    put(rule(home), 'once more\n');
    await push();
    expect(fs.readdirSync(day).sort()).toEqual(['x.md', 'x.md.2']);
  });

  it('a whole-ticked server the person edited since stays through the untick, its key in it, and no copy holds it', async () => {
    const { home, mac, backups, synced, consent, push } = target();
    const odd = { command: 'odd', env: { T: 'odd_key_secret_1234567890' }, sandbox: { on: true } };
    editJson(home.claudeJson, (j) => { j.mcpServers.odd = odd; });
    await synced();
    await consent('claude:mcp:odd', ['command', 'env', 'sandbox'], true);
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd.timeout = 5; });
    await push();
    await push();
    // the edit stands: this is the mirror's entry, no own key that a tick would replace
    expect(json(mac.claudeJson).mcpServers.odd.timeout).toBe(5);
    expect(holding(backups, 'odd_key_secret')).toEqual([]);
    await consent('claude:mcp:odd', ['command', 'env', 'sandbox'], false);
    expect(json(mac.claudeJson).mcpServers.odd).toEqual({ ...odd, timeout: 5 });
    expect(holding(backups, 'odd_key_secret')).toEqual([]);
  });

  it('a lost record beside a backup: a ticked equal value is a copy again, and the earlier folder stays named', async () => {
    const { mac, home, backups, w, synced, consent, push } = target();
    editJson(home.claudeJson, (j) => { j.mcpServers.linear = { command: 'npx', args: ['l'], env: { LINEAR_API_KEY: KEY } }; });
    put(path.join(mac.claudeDir, 'rules/own.md'), 'own\n');
    put(path.join(home.claudeDir, 'rules/own.md'), 'home\n');
    await synced();
    const first = folders(backups);
    await consent('claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    fs.rmSync(w.worker.paths.mirrorState);
    await push();
    expect(folders(backups)).toEqual(first);
    expect(readState(w.worker.paths.mirrorState).backup?.dir).toBe(path.join(backups, first[0]));
    await consent('claude:mcp:linear', ['env.LINEAR_API_KEY'], false);
    expect(json(mac.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
  });

  it('uninstall finds each fleet home\'s mirror-backup, and no folder that is not there', () => {
    const homedir = makeHome();
    put(path.join(homedir, '.svall/fleet.json'), '{}');
    put(path.join(homedir, '.svall-work/fleet.json'), '{}');
    expect(fleetBackups(homedir)).toEqual([]);
    put(path.join(homedir, '.svall-work/mirror-backup/2026-11-05/x'), 'x');
    expect(fleetBackups(homedir)).toEqual([path.join(homedir, '.svall-work/mirror-backup')]);
  });

  it('a push that fails here is told by home.setup, until one lands', async () => {
    const { home, mac, w, synced, push } = target();
    put(path.join(home.claudeDir, 'rules/from-home.md'), 'the home\'s\n');
    await synced();
    put(path.join(mac.claudeDir, 'settings.json'), 'not json');
    await push();
    const told = await call<{ pushFailed?: string }>(w.worker.ctx, 'home.setup', {});
    expect(told.pushFailed).toContain('cannot be parsed');
    put(path.join(mac.claudeDir, 'settings.json'), '{}');
    await push();
    expect((await call<{ pushFailed?: string }>(w.worker.ctx, 'home.setup', {})).pushFailed).toBeUndefined();
  });

  it('a temp a killed write left beside a config file goes at the next apply and at uninstall', async () => {
    const { home, mac, w, synced, push } = target();
    put(path.join(home.claudeDir, 'rules/from-home.md'), 'the home\'s\n');
    await synced();
    const temp = (n: number) => `${realPath(mac.claudeJson)}.durable-${n}-0000000${n}.tmp`;
    fs.writeFileSync(temp(1), KEY);
    await push();
    expect(fs.existsSync(temp(1))).toBe(false);
    fs.writeFileSync(temp(2), KEY);
    await takeBackCopies({ ...mac, stateFile: w.worker.paths.mirrorState });
    expect(fs.existsSync(temp(2))).toBe(false);
  });

  it('a plugin the Mac added after the home dropped it stays when the home brings back a list without it', async () => {
    const { home, mac, synced, push } = target();
    const list = (m: { claudeDir: string }) => path.join(m.claudeDir, 'plugins/installed_plugins.json');
    put(list(home), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/a', version: '1' }] } }));
    await synced();
    fs.rmSync(list(home));
    await push();
    put(list(mac), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: '/mine', version: '2' }] } }));
    put(list(home), JSON.stringify({ version: 2, plugins: { other: [{ scope: 'user', installPath: '/o', version: '1' }] } }));
    await push();
    expect(Object.keys(json(list(mac)).plugins).sort()).toEqual(['acme', 'other']);
  });

  it('a plugin server file with a name kept for keys stays home with a line, and no push stops for it', async () => {
    const mac = macHome();
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', mcpServers: './token.json' }));
    put(path.join(mac.claudeDir, 'plugins/cache/mp/acme/1.0.0/token.json'), JSON.stringify({ mcpServers: { t: { command: 'node', args: ['t.js'] } } }));
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to).filter((to) => !carriable(to))).toEqual([]);
    expect(plan.skipped.join('\n')).toContain('token.json has a name kept for a key or a login');
  });
});

describe('a Linux worker its home dials', () => {
  it('behaves as it always has: no entry, plugin or same-value key of its own is kept, and no copy', async () => {
    const home = macHome();
    const worker = farHome();
    fs.rmSync(worker.overrides, { recursive: true, force: true });
    const list = (m: { claudeDir: string }) => path.join(m.claudeDir, 'plugins/installed_plugins.json');
    const OWN = 'sk_live_00001234567890';
    editJson(home.claudeJson, (j) => { j.mcpServers.byRef = { command: 'npx', args: ['r'], env: { R: '${R}' } }; j.mcpServers.gone = { command: 'npx', args: ['g'] }; });
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'acme@mp': true }; });
    put(worker.claudeJson, JSON.stringify({ mcpServers: {
      byRef: { command: 'npx', args: ['r'], env: { R: OWN } },
      linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: KEY } },
    } }));
    put(list(worker), JSON.stringify({ version: 2, plugins: { mine: [{ scope: 'user', installPath: '/m', version: '1' }] } }));
    editJson(path.join(worker.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'mine@x': true }; });
    const w = world({ mirror: { home, worker } });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(json(worker.claudeJson).mcpServers.byRef.env.R).toBe('${R}');
    expect(Object.keys(json(list(worker)).plugins)).toEqual(['acme']);
    expect(json(path.join(worker.claudeDir, 'settings.json')).enabledPlugins).toEqual({ 'acme@mp': true });
    const consent = (on: boolean) => call(w.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on });
    await consent(true);
    await consent(false);
    expect(json(worker.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    // a server it filled in by hand goes when the home drops it
    editJson(worker.claudeJson, (j) => { j.mcpServers.gone.env = { G: OWN }; });
    editJson(home.claudeJson, (j) => { delete j.mcpServers.gone; });
    await w.home.links.pushMirror(W);
    expect(json(worker.claudeJson).mcpServers.gone).toBeUndefined();
    expect(fs.existsSync(path.join(worker.homedir, '.svall/mirror-backup'))).toBe(false);
    expect(readState(w.worker.paths.mirrorState).listed).toBeUndefined();
  });

  it('takes a list or a plan a Copy would refuse: a plan is not refused on a push', async () => {
    const mac = macHome();
    const worker = farHome();
    const scratch = makeHome();
    const o = { ...worker, stateFile: path.join(scratch, 'state.json'), varsFile: path.join(scratch, 'vars.json') };
    const plan = mirrorPlan(mac);
    await packMirror({ ...plan, keep: [...plan.keep, 'home/.ssh/config'] }, path.join(scratch, 'm.tar'));
    await unpack(path.join(scratch, 'm.tar'), path.join(scratch, 'm'));
    await expect(applyMirror(path.join(scratch, 'm'), o)).resolves.toBeDefined();
  });
});

describe('a file the record does not name', () => {
  const day = (backups: string) => path.join(backups, folders(backups)[0]);

  it('is copied first on any push, into the same folder; a file the mirror wrote is not', async () => {
    const { home, mac, backups, w } = onto();
    await w.link();
    await w.home.links.mirrorSettled(W);
    const first = folders(backups);
    put(path.join(mac.claudeDir, 'rules/later.md'), 'mine, from later\n');
    put(path.join(home.claudeDir, 'rules/later.md'), 'the home\'s\n');
    put(path.join(home.claudeDir, 'rules/style.md'), 'terser\n');
    await w.home.links.pushMirror(W);
    expect(read(path.join(mac.claudeDir, 'rules/later.md'))).toBe('the home\'s\n');
    expect(read(path.join(day(backups), '.claude/rules/later.md'))).toBe('mine, from later\n');
    expect(folders(backups)).toEqual(first);
    // style.md is the mirror's since the first push, so what that push kept is all there is of it
    expect(read(path.join(day(backups), '.claude/rules/style.md'))).toBe('mine\n');
  });

  it('a first push that replaces nothing spends nothing: the next keeps what it replaces', async () => {
    const home = macHome();
    const mac = farHome();
    fs.rmSync(mac.overrides, { recursive: true, force: true });
    fs.rmSync(path.join(mac.claudeDir, 'settings.json'), { force: true });
    const backups = path.join(mac.homedir, '.svall/mirror-backup');
    const w = world({ mirror: { home, worker: { ...mac, backups } } });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(folders(backups)).toEqual([]);
    put(path.join(mac.claudeDir, 'rules/mine.md'), 'mine\n');
    put(path.join(home.claudeDir, 'rules/mine.md'), 'the home\'s\n');
    await w.home.links.pushMirror(W);
    expect(read(path.join(day(backups), '.claude/rules/mine.md'))).toBe('mine\n');
    const { backup } = await call<{ backup?: string }>(w.worker.ctx, 'home.setup', {});
    expect(backup).toBe(day(backups));
  });

  it('holding the same bytes as the home is copied too, so the next removes nothing without a copy', async () => {
    const { home, mac, backups, w } = onto();
    put(path.join(home.claudeDir, 'rules/same.md'), 'same\n');
    put(path.join(mac.claudeDir, 'rules/same.md'), 'same\n');
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(read(path.join(day(backups), '.claude/rules/same.md'))).toBe('same\n');
    fs.rmSync(path.join(home.claudeDir, 'rules/same.md'));
    await w.home.links.pushMirror(W);
    expect(fs.existsSync(path.join(mac.claudeDir, 'rules/same.md'))).toBe(false);
    expect(read(path.join(day(backups), '.claude/rules/same.md'))).toBe('same\n');
  });

  it('is copied first on a home too, by a later Copy as by the first', async () => {
    const { home, mac, w, ask, linked } = copyOf();
    for (const dir of [home.claudeDir, home.opencodeDir]) fs.rmSync(dir, { recursive: true, force: true });
    await linked();
    expect((await ask()).backup).toBeUndefined();
    expect(folders(w.home.paths.mirrorBackup)).toEqual([]);
    put(path.join(home.claudeDir, 'rules/late.md'), 'the home\'s own\n');
    put(path.join(mac.claudeDir, 'rules/late.md'), 'this Mac\'s\n');
    const { backup } = await ask();
    expect(read(path.join(home.claudeDir, 'rules/late.md'))).toBe('this Mac\'s\n');
    expect(read(path.join(backup!, '.claude/rules/late.md'))).toBe('the home\'s own\n');
  });

  it('a whole-file override over a file the record does not name is copied first', async () => {
    const { mac, backups, w } = onto();
    put(path.join(mac.claudeDir, 'keybindings.json'), '["mine"]\n');
    put(path.join(mac.overrides, 'claude/commands/only-here.md'), 'from the override\n');
    put(path.join(mac.claudeDir, 'commands/only-here.md'), 'mine\n');
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(read(path.join(mac.claudeDir, 'commands/only-here.md'))).toBe('from the override\n');
    expect(read(path.join(day(backups), '.claude/commands/only-here.md'))).toBe('mine\n');
  });
});

describe('a plugin of the target\'s own', () => {
  const installed = (m: { claudeDir: string }) => json(path.join(m.claudeDir, 'plugins/installed_plugins.json')).plugins;
  const known = (m: { claudeDir: string }) => json(path.join(m.claudeDir, 'plugins/known_marketplaces.json'));
  const settings = (m: { claudeDir: string }) => json(path.join(m.claudeDir, 'settings.json'));

  it('stays listed and enabled through a first push and a change of the home\'s; what the home lists is the home\'s; what the home drops goes', async () => {
    const { home, mac, w } = onto();
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'acme@mp': true }; j.permissions = { allow: ['Bash(ls)'] }; });
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.permissions = { allow: ['Bash(rm)'] }; });
    await w.link();
    await w.home.links.mirrorSettled(W);
    expect(Object.keys(installed(mac)).sort()).toEqual(['acme', 'onlymac']);
    expect(Object.keys(known(mac)).sort()).toEqual(['mp', 'mymarket']);
    expect(settings(mac).enabledPlugins).toEqual({ 'onlymac@x': true, 'acme@mp': true });
    // a permission both hold is the home's
    expect(settings(mac).permissions).toEqual({ allow: ['Bash(ls)'] });

    editJson(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins.later = [{ scope: 'user', installPath: '/x', version: '2' }]; });
    editJson(path.join(home.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins.more = [{ scope: 'user', installPath: path.join(home.claudeDir, 'plugins/cache/mp/more/1'), version: '1' }]; delete j.plugins.acme; });
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { j.enabledPlugins = { 'more@mp': true }; });
    await w.home.links.pushMirror(W);
    expect(Object.keys(installed(mac)).sort()).toEqual(['later', 'more', 'onlymac']);
    expect(settings(mac).enabledPlugins).toEqual({ 'onlymac@x': true, 'more@mp': true });
    expect(installed(mac).more[0].installPath).toBe(path.join(mac.claudeDir, 'plugins/cache/mp/more/1'));

    // the home's list and settings gone, the Mac's own stay
    fs.rmSync(path.join(home.claudeDir, 'plugins/installed_plugins.json'));
    editJson(path.join(home.claudeDir, 'settings.json'), (j) => { delete j.enabledPlugins; });
    await w.home.links.pushMirror(W);
    expect(Object.keys(installed(mac)).sort()).toEqual(['later', 'onlymac']);
    expect(settings(mac).enabledPlugins).toEqual({ 'onlymac@x': true });
  });

  it('a record from before it kept their names says nothing of whose they are: what the home drops goes', async () => {
    const { home, mac, w } = onto();
    await w.link();
    await w.home.links.mirrorSettled(W);
    const { listed: _listed, ...before } = readState(w.worker.paths.mirrorState);
    fs.writeFileSync(w.worker.paths.mirrorState, JSON.stringify(before));
    editJson(path.join(home.claudeDir, 'plugins/installed_plugins.json'), (j) => { j.plugins.more = [{ scope: 'user', installPath: '/m', version: '1' }]; delete j.plugins.acme; });
    await w.home.links.pushMirror(W);
    expect(Object.keys(installed(mac))).toEqual(['more']);
  });

  it('a Copy leaves the home\'s own the same way', async () => {
    const { home, mac, ask, linked } = copyOf();
    put(path.join(home.claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { homeonly: [{ scope: 'user', installPath: '/h', version: '1' }] } }));
    await linked();
    await ask();
    expect(Object.keys(installed(home)).sort()).toEqual(['acme', 'homeonly']);
    editJson(path.join(mac.claudeDir, 'plugins/installed_plugins.json'), (j) => { delete j.plugins.acme; });
    await ask();
    // a Copy removes nothing
    expect(Object.keys(installed(home)).sort()).toEqual(['acme', 'homeonly']);
  });
});

// a home that holds a setup of its own, and a Mac whose setup is copied there
function copyOf() {
  const home = farHome();
  fs.rmSync(path.join(home.overrides, 'claude/CLAUDE.md'), { force: true });
  put(path.join(home.claudeDir, 'CLAUDE.md'), '# the server\n');
  const mac = { ...macHome(), overrides: path.join(home.homedir, 'unused-overrides') };
  editJson(mac.claudeJson, (j) => {
    j.mcpServers.two = { command: 'npx', args: ['-y', 'two-mcp'], env: { A_KEY: 'a_key_1234567890', B_KEY: 'b_key_1234567890' } };
  });
  const w = world({ mirror: { home, worker: { ...mac, backups: path.join(mac.homedir, '.svall/mirror-backup') } } });
  return {
    home, mac, w,
    ask: () => call<{ sent: number; backup?: string }>(w.home.ctx, 'machines.copySetupFrom', { machine: W }),
    // the home is synced a moment before the worker has read its first ack, until when the worker's calls answer not_reachable
    linked: async () => {
      await w.link();
      await until(() => expect(w.worker.connection.connected()).toBe(true));
      await w.home.links.mirrorSettled(W);
    },
  };
}
const asks = { homedir: '/Users/ada', projects: [] };

describe('a copy of a worker\'s agent setup onto its home', () => {
  it('lands on the home, by the ticks the worker holds for it, field by field, and keeps what it replaced', async () => {
    const { home, mac, w, ask, linked } = copyOf();
    await linked();
    // the home's push on linking wrote this file; a person edits it here
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# edited here\n');
    const { rows } = await call<{ rows: SetupRow[] }>(w.worker.ctx, 'home.setup', {});
    expect(rows.find((r) => r.key === 'claude:mcp:two')?.tick).toMatchObject({ on: false, fields: ['env.A_KEY', 'env.B_KEY'] });
    const ticked = await call<{ rows: SetupRow[] }>(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:two', fields: ['env.A_KEY'], on: true });
    // the row is on only with all its fields ticked
    expect(ticked.rows.find((r) => r.key === 'claude:mcp:two')?.tick?.on).toBe(false);
    const { sent, backup } = await ask();
    expect(sent).toBeGreaterThan(0);
    expect(read(path.join(home.claudeDir, 'CLAUDE.md'))).toBe('# edited here\n');
    expect(json(home.claudeJson).mcpServers.two.env).toEqual({ A_KEY: 'a_key_1234567890', B_KEY: '${B_KEY}' });
    expect(json(home.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
    expect(fs.existsSync(path.join(home.claudeDir, '.credentials.json'))).toBe(false);
    expect(backup && path.dirname(backup)).toBe(w.home.paths.mirrorBackup);
    expect(read(path.join(backup!, '.claude/CLAUDE.md'))).toBe('# the server\n');
  });

  it('waits for a push of the home\'s under way before the worker reads what it sends, and holds the next', async () => {
    const { mac, w, ask, linked } = copyOf();
    await linked();
    const copying = vi.spyOn(w.worker.handlers, 'config.copyToHome');
    let release!: () => void;
    void w.home.mirror!.inTurn(W, () => new Promise<void>((r) => { release = r; }));
    const copy = ask();
    await new Promise((r) => setTimeout(r, 50));
    expect(copying).not.toHaveBeenCalled();
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# edited here\n');
    release();
    await copy;
    expect(copying).toHaveBeenCalledTimes(1);
    const order: string[] = [];
    const holding = w.home.mirror!.inTurn(W, async () => { order.push('copy'); });
    const next = w.home.mirror!.inTurn(W, async () => { order.push('push'); });
    await Promise.all([holding, next]);
    expect(order).toEqual(['copy', 'push']);
  });

  it('a tick the Mac holds for its home is the Mac\'s: nothing of it reaches the home unless copied', async () => {
    const { w, linked } = copyOf();
    await linked();
    await call(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:two', fields: ['env.A_KEY'], on: true });
    expect(fs.existsSync(w.home.paths.mirrorConsent)).toBe(false);
    expect(json(w.worker.paths.mirrorConsent)[H]).toEqual(['claude:mcp:two#env.A_KEY']);
  });

  it('a later copy keeps none of what an earlier one wrote, as that may hold what it copied', async () => {
    const { home, mac, w, ask, linked } = copyOf();
    await linked();
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# first\n');
    const first = await ask();
    put(path.join(home.claudeDir, 'CLAUDE.md'), '# edited on the server\n');
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# second\n');
    const second = await ask();
    expect(read(path.join(home.claudeDir, 'CLAUDE.md'))).toBe('# second\n');
    expect(second.backup).toBeUndefined();
    expect(folders(w.home.paths.mirrorBackup)).toEqual([path.basename(first.backup!)]);
    expect(read(path.join(first.backup!, '.claude/CLAUDE.md'))).toBe('# the server\n');
  });

  it('a key ticked for one copy and unticked for the next lies in no backup', async () => {
    const { home, w, ask, linked } = copyOf();
    await linked();
    const tick = (on: boolean) => call(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on });
    await tick(true);
    await ask();
    expect(json(home.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
    await tick(false);
    await ask();
    expect(json(home.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe('${LINEAR_API_KEY}');
    expect(holding(w.home.paths.mirrorBackup, KEY)).toEqual([]);
    expect(folders(w.home.paths.mirrorBackup).length).toBeLessThanOrEqual(1);
  });

  it('a first copy onto a home with no setup replaces nothing, and names no folder', async () => {
    const { home, w, ask, linked } = copyOf();
    for (const dir of [home.claudeDir, home.opencodeDir]) fs.rmSync(dir, { recursive: true, force: true });
    await linked();
    const { sent, backup } = await ask();
    expect(sent).toBeGreaterThan(0);
    expect(read(path.join(home.claudeDir, 'CLAUDE.md'))).toBe('# how I work\n');
    expect(backup).toBeUndefined();
    expect(folders(w.home.paths.mirrorBackup)).toEqual([]);
  });

  it('removes nothing on the home: a file, a server, a setting or a key a Mac no longer holds, as another Mac may have sent it', async () => {
    const { home, mac, w, ask, linked } = copyOf();
    await linked();
    const tick = () => call(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true });
    await tick();
    put(path.join(mac.claudeDir, 'rules/only-a.md'), 'from A\n');
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.fromA = true; });
    await ask();
    expect(read(path.join(home.claudeDir, 'rules/only-a.md'))).toBe('from A\n');
    expect(json(home.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
    put(path.join(home.claudeDir, 'rules/only-a.md'), 'from A, edited on the home since\n');
    fs.rmSync(path.join(mac.claudeDir, 'rules/only-a.md'));
    editJson(mac.claudeJson, (j) => { delete j.mcpServers.linear; });
    editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { delete j.fromA; });
    const second = await ask();
    expect(read(path.join(home.claudeDir, 'rules/only-a.md'))).toBe('from A, edited on the home since\n');
    expect(json(home.claudeJson).mcpServers.linear.env.LINEAR_API_KEY).toBe(KEY);
    expect(json(path.join(home.claudeDir, 'settings.json')).fromA).toBe(true);
    expect(second.backup).toBeUndefined();
    // and it stays through the next, whose record kept them
    await ask();
    expect(read(path.join(home.claudeDir, 'rules/only-a.md'))).toBe('from A, edited on the home since\n');
  });

  describe('a key a push left on a machine before the fleet moved there', () => {
    const ITEM = 'claude:mcp:linear';
    const FIELD = 'env.LINEAR_API_KEY';
    // the Mac its home, its ticked key pushed to the server; then the server the home, holding what an install leaves of that record.
    // `whole`: a server of a shape Svall cannot read, ticked whole too
    async function movedThere(whole?: object) {
      const server = farHome();
      const mac = macHome();
      if (whole) editJson(mac.claudeJson, (j) => { j.mcpServers.odd = whole; });
      const first = world({ mirror: { home: mac, worker: { ...server, overrides: server.overrides } } });
      await first.link();
      await until(() => expect(first.worker.connection.connected()).toBe(true));
      await first.home.links.mirrorSettled(W);
      await call(first.home.ctx, 'machines.consent', { machine: W, item: ITEM, fields: [FIELD], on: true });
      if (whole) await call(first.home.ctx, 'machines.consent', { machine: W, item: 'claude:mcp:odd', fields: ['command', 'sandbox'], on: true });
      await first.home.links.mirrorSettled(W);
      expect(json(server.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: KEY });
      const record = keysOnly(readState(first.worker.paths.mirrorState));
      await first.stop();
      const w = world({ mirror: { home: server, worker: { ...mac, overrides: path.join(server.homedir, 'unused-overrides'), backups: path.join(mac.homedir, '.svall/mirror-backup') } } });
      put(w.home.paths.mirrorState, JSON.stringify(record));
      const ask = () => call<{ sent: number; left?: string[] }>(w.home.ctx, 'machines.copySetupFrom', { machine: W });
      await w.link();
      await until(() => expect(w.worker.connection.connected()).toBe(true));
      await w.home.links.mirrorSettled(W);
      return { server, w, ask };
    }

    it('goes back at the next Copy once unticked, as one a Copy sent does', async () => {
      const { server, ask } = await movedThere();
      await ask();
      expect(json(server.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
    });

    it('stays while ticked, and goes back at the Copy after its untick', async () => {
      const { server, w, ask } = await movedThere();
      await call(w.worker.ctx, 'home.setupConsent', { item: ITEM, fields: [FIELD], on: true });
      await ask();
      expect(json(server.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: KEY });
      await call(w.worker.ctx, 'home.setupConsent', { item: ITEM, fields: [FIELD], on: false });
      await ask();
      expect(json(server.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
    });

    it('a server ticked whole stays through the untick and the next Copy, its key with it, where a key goes back', async () => {
      const odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } };
      const { server, ask } = await movedThere(odd);
      expect(json(server.claudeJson).mcpServers.odd).toEqual(odd);
      await ask();
      expect(json(server.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}' });
      expect(json(server.claudeJson).mcpServers.odd).toEqual(odd);
    });

    it('a key the home holds that no push copied stays through the untick', async () => {
      const { server, ask } = await movedThere();
      editJson(server.claudeJson, (j) => { j.mcpServers.linear.env.LINEAR_API_KEY = 'own_key_1234567890'; });
      await ask();
      expect(json(server.claudeJson).mcpServers.linear.env).toEqual({ LINEAR_API_KEY: 'own_key_1234567890' });
    });
  });

  it('an untick of a whole item takes it back at the next Copy while it is still the copy; a sender dropping it does not', async () => {
    const { home, mac, w, ask, linked } = copyOf();
    const odd = { command: 'odd', sandbox: { token: 'odd_key_secret_1234567890' } };
    editJson(mac.claudeJson, (j) => { j.mcpServers.odd = odd; j.mcpServers.dropped = { ...odd, command: 'dropped' }; });
    const agent = path.join(mac.claudeDir, 'agents/keyed.md');
    put(agent, ['---', 'name: keyed', 'mcpServers:', '  - s:', '      command: npx', '      env:', '        K: agent_key_1234567890', '---', 'prompt', ''].join('\n'));
    await linked();
    const consent = (item: string, fields: string[], on: boolean) => call(w.worker.ctx, 'home.setupConsent', { item, fields, on });
    const { rows } = await call<{ rows: SetupRow[] }>(w.worker.ctx, 'home.setup', {});
    const row = rows.find((r) => r.key === 'claude:agent:keyed.md')!;
    await consent('claude:mcp:odd', ['command', 'sandbox'], true);
    await consent('claude:mcp:dropped', ['command', 'sandbox'], true);
    await consent(row.tick!.item, row.tick!.fields, true);
    await ask();
    const landed = path.join(home.claudeDir, 'agents/keyed.md');
    expect(json(home.claudeJson).mcpServers.odd).toEqual(odd);
    expect(read(landed)).toContain('agent_key_1234567890');
    await consent('claude:mcp:odd', ['command', 'sandbox'], false);
    await consent(row.tick!.item, row.tick!.fields, false);
    editJson(mac.claudeJson, (j) => { delete j.mcpServers.dropped; });
    await ask();
    expect(json(home.claudeJson).mcpServers.odd).toBeUndefined();
    expect(fs.existsSync(landed)).toBe(false);
    expect(json(home.claudeJson).mcpServers.dropped.command).toBe('dropped');
  });

  it('a Copy leaves the variables of the servers it keeps', async () => {
    const { w, mac, ask, linked } = copyOf();
    await linked();
    await ask();
    const vars = () => json(w.home.paths.mirrorVars) as string[];
    expect(vars()).toContain('LINEAR_API_KEY');
    editJson(mac.claudeJson, (j) => { delete j.mcpServers.linear; });
    await ask();
    expect(vars()).toContain('LINEAR_API_KEY');
  });

  it('refuses a blob a plan could not make, before it writes a thing', async () => {
    const mac = macHome();
    const scratch = makeHome();
    const worker = farHome();
    const o = { ...worker, stateFile: path.join(scratch, 'state.json'), varsFile: path.join(scratch, 'vars.json') };
    const blobOf = async (name: string, change: (dir: string, manifest: any) => void): Promise<string> => {
      const tar = path.join(scratch, `${name}.tar`);
      await packMirror(mirrorPlan(mac), tar);
      const dir = path.join(scratch, name);
      await unpack(tar, dir);
      const manifest = json(path.join(dir, MANIFEST));
      change(dir, manifest);
      fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest));
      return dir;
    };
    const claude = (m: any) => m.servers.find((x: any) => x.doc === '.claude.json');
    const cases: [string, (dir: string, m: any) => void, string][] = [
      ['ssh', (dir) => put(path.join(dir, 'home/.ssh/authorized_keys'), 'ssh-ed25519 AAAA\n'), 'does not carry'],
      ['login', (dir) => put(path.join(dir, 'claude/.credentials.json'), '{}'), 'does not carry'],
      ['named', (dir) => put(path.join(dir, 'claude/skills/x/auth.json'), '{}'), 'does not carry'],
      ['keep', (_d, m) => { m.keep.push('home/.ssh/config'); }, 'does not carry'],
      ['keyed', (_d, m) => { m.keyed.push('home/.ssh/config'); }, 'does not carry'],
      ['hooks', (_d, m) => { claude(m).place = ['hooks']; }, 'places a claude server'],
      ['other doc', (_d, m) => { claude(m).doc = 'settings.json'; }, 'places a claude server'],
      ['proto', (_d, m) => { claude(m).place = ['mcpServers', '__proto__']; }, 'places a claude server'],
      ['opencode owned', (_d, m) => { m.opencode[0].fields.push('mcp.ctx.environment.K'); }, 'which this machine owns'],
      ['owned', (_d, m) => { m.configs.push({ key: 'claude:settings', fields: ['hooks.Stop'], ticked: ['hooks.Stop'] }); }, 'which this machine owns'],
    ];
    const before = read(path.join(worker.claudeDir, 'settings.json'));
    for (const [name, change, says] of cases) await expect(applyMirror(await blobOf(name, change), { ...o, additive: true, refuse: refuseForeign }), name).rejects.toThrow(says);
    expect(read(path.join(worker.claudeDir, 'settings.json'))).toBe(before);
    expect(fs.existsSync(o.stateFile)).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    setAt({}, ['__proto__', 'x'], 'polluted');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(carriable('claude/plugins/cache/mp/acme/1.0.0/.mcp.json')).toBe(true);
    expect(carriable('claude/../.ssh/config')).toBe(false);
    expect(carriable('opencode/agent/x.md')).toBe(true);
    expect(carriable('codex/config.toml')).toBe(false);
  });

  it('refuses a forged blob sent through the grant itself', async () => {
    const { mac, w, linked, home } = copyOf();
    await linked();
    const scratch = makeHome();
    const tar = path.join(scratch, 'm.tar');
    const plan = mirrorPlan(mac);
    await packMirror({ ...plan, keep: [...plan.keep, 'home/.ssh/config'] }, tar);
    const before = read(path.join(home.claudeDir, 'CLAUDE.md'));
    w.home.setupCopy!.arm(W);
    const c = w.worker.connection;
    await c.call('config.blob', { id: 'mirror_forged', sha256: await fileSha(tar) });
    await c.sendBlob('mirror_forged', tar);
    await expect(c.call('config.apply', { id: 'mirror_forged', seq: 1 })).rejects.toThrow('does not carry');
    expect(read(path.join(home.claudeDir, 'CLAUDE.md'))).toBe(before);
  });

  it('what a plan carries for a Mac of every shape passes the check', async () => {
    const mac = macHome();
    const plan = mirrorPlan(mac, new Set(['claude:mcp:linear#env.LINEAR_API_KEY']));
    expect(plan.files.map((f) => f.to).filter((to) => !carriable(to))).toEqual([]);
  });

  it('a blob on its way goes when the worker\'s link does, and one grant holds at a time', async () => {
    const { w, linked, ask } = copyOf();
    await linked();
    const c = w.worker.connection;
    let offered!: () => void;
    const offering = new Promise<void>((resolve) => { offered = resolve; });
    // the worker holds the copy open with a blob offered, until its link closes under it
    w.worker.handlers['config.copyToHome'] = async () => {
      await c.call('config.blob', { id: 'mirror_a', sha256: '0'.repeat(64) });
      offered();
      return new Promise(() => {});
    };
    const copying = ask();
    await offering;
    expect(() => w.home.setupCopy!.arm(OTHER)).toThrow(expect.objectContaining({ code: 'busy' }));
    const stage = () => (fs.existsSync(w.home.paths.cache) ? fs.readdirSync(w.home.paths.cache).filter((f) => f.startsWith('mirror-')) : []);
    expect(stage()).toHaveLength(1);
    const stopped = c.stop();
    await expect(copying).rejects.toThrow();
    await stopped;
    await until(() => expect(stage()).toEqual([]));
    expect(w.home.setupCopy!.arm(OTHER)).toBeDefined();
  });

  it('takes the mirror\'s calls from no worker it was not told of, nor from any once told of another', async () => {
    const { w, linked } = copyOf();
    await linked();
    const send = () => w.worker.connection.call('config.state', asks);
    await refused(send());
    w.home.setupCopy!.arm(OTHER);
    await refused(send());
  });

  it('refuses a named worker past its grant\'s expiry', async () => {
    const { w, linked } = copyOf();
    await linked();
    w.home.setupCopy!.arm(W, -1);
    await refused(w.worker.connection.call('config.state', asks));
    w.home.setupCopy!.arm(W);
    await expect(w.worker.connection.call('config.state', asks)).resolves.toBeDefined();
  });

  it('refuses a second use of one grant: a second blob, and anything past the apply', async () => {
    const { home, mac, w, linked } = copyOf();
    await linked();
    w.home.setupCopy!.arm(W);
    const c = w.worker.connection;
    await c.call('config.state', asks);
    const blob = path.join(mac.homedir, 'x');
    fs.writeFileSync(blob, 'x');
    await c.call('config.blob', { id: 'mirror_a', sha256: '0'.repeat(64) });
    await refused(c.call('config.blob', { id: 'mirror_b', sha256: '0'.repeat(64) }));
    await c.sendBlob('mirror_a', blob);
    // the bytes are not as offered, and the grant is spent all the same
    await expect(c.call('config.apply', { id: 'mirror_a', seq: 1 })).rejects.toThrow('did not arrive as it left');
    await refused(c.call('config.state', asks));
    await refused(c.call('config.apply', { id: 'mirror_a', seq: 2 }));
    expect(read(path.join(home.claudeDir, 'CLAUDE.md'))).toBe('# the server\n');
  });

  it('the grant ends with the copy, one that failed too', async () => {
    const { w, ask, linked } = copyOf();
    await linked();
    await ask();
    await refused(w.worker.connection.call('config.state', asks));
    await expect(w.home.setupCopy!.from(W, () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await refused(w.worker.connection.call('config.state', asks));
  });

  it('a copy that ends past its grant leaves the grant armed after it', async () => {
    const { w, linked } = copyOf();
    await linked();
    const now = Date.now();
    await w.home.setupCopy!.from(W, async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
      w.home.setupCopy!.arm(W);
    });
    await expect(w.worker.connection.call('config.state', asks)).resolves.toBeDefined();
  });

  it('never takes the mirror\'s other calls, and a worker still sends on no machines call', async () => {
    const { w, linked } = copyOf();
    await linked();
    w.home.setupCopy!.arm(W);
    await refused(answer('config.report', {}, w.home.ctx, W));
    await refused(answer('env.set', { name: 'A', value: 'b' }, w.home.ctx, W));
    await refused(answer('machines.copySetupFrom', { machine: W }, w.home.ctx, W));
  });

  it('is asked of the home by a window alone: a worker\'s daemon sends it on and is refused, and a phone is refused', async () => {
    const { w, linked } = copyOf();
    await linked();
    await refused(call(w.worker.ctx, 'machines.copySetupFrom', { machine: W }));
    await expect(call({ ...w.home.ctx, viewer: { kind: 'phone' } } as Ctx, 'machines.copySetupFrom', { machine: W })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(w.home.ctx, 'machines.copySetupFrom', { machine: OTHER })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call({ ...w.worker.ctx, viewer: { kind: 'phone' } } as Ctx, 'home.setup', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call({ ...w.worker.ctx, viewer: { kind: 'phone' } } as Ctx, 'home.setupConsent', { item: 'claude:mcp:two', fields: ['env.A_KEY'], on: true })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a worker\'s tick goes field by field, off as on, and its row says which', async () => {
    const { w, linked } = copyOf();
    await linked();
    const consent = (fields: string[], on: boolean) => call<{ rows: SetupRow[] }>(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:two', fields, on });
    await consent(['env.A_KEY', 'env.B_KEY'], true);
    const { rows } = await consent(['env.A_KEY'], false);
    expect(rows.find((r) => r.key === 'claude:mcp:two')?.tick).toMatchObject({ on: false, ticked: ['env.B_KEY'] });
    expect(json(w.worker.paths.mirrorConsent)[H]).toEqual(['claude:mcp:two#env.B_KEY']);
  });

  it('names a worker\'s rows and backup with its home away, and a home has no such rows', async () => {
    const { w, linked } = copyOf();
    await linked();
    await w.worker.connection.stop();
    const { rows } = await call<{ rows: SetupRow[] }>(w.worker.ctx, 'home.setup', {});
    expect(rows.some((r) => r.key === 'claude:mcp:two')).toBe(true);
    await expect(call(w.home.ctx, 'home.setup', {})).rejects.toMatchObject({ code: 'not_found' });
  });

  it('names the folder a push kept with its home away, once it is on disk, and every row has its tick', async () => {
    const { w, day, backups } = onto();
    await w.link();
    await w.home.links.mirrorSettled(W);
    const dir = day();
    await w.worker.connection.stop();
    const { rows, backup } = await call<{ rows: SetupRow[]; backup?: string }>(w.worker.ctx, 'home.setup', {});
    expect(backup).toBe(dir);
    expect(rows.every((r) => r.tick)).toBe(true);
    fs.rmSync(backups, { recursive: true });
    expect((await call<{ backup?: string }>(w.worker.ctx, 'home.setup', {})).backup).toBeUndefined();
  });

  it('the first save of a Claude file makes its folder on a home that has none', async () => {
    const { w } = copyOf();
    const dir = w.home.ctx.claude!.dir;
    expect(fs.existsSync(dir)).toBe(false);
    const id = rootIdOf(dir);
    await expect(call(w.home.ctx, 'fs.read', { id, path: 'CLAUDE.md' })).rejects.toMatchObject({ code: 'not_found' });
    expect(fs.existsSync(dir)).toBe(false);
    await call(w.home.ctx, 'fs.write', { id, path: 'CLAUDE.md', text: '# new\n', mtimeMs: 0 });
    expect(read(path.join(dir, 'CLAUDE.md'))).toBe('# new\n');
  });

  it('a Claude Code write to .claude.json as a push runs stays', async () => {
    const { home, mac, w } = onto();
    await w.link();
    await w.home.links.mirrorSettled(W);
    editJson(home.claudeJson, (j) => { j.mcpServers.added = { command: 'npx', args: ['-y', 'added-mcp'] }; });
    const write = DurableBatch.prototype.write;
    let written = false;
    // the first record of the push goes down after the file was read and before it is written
    vi.spyOn(DurableBatch.prototype, 'write').mockImplementation(async function (this: DurableBatch, file, data, mode) {
      if (!written && path.basename(file) === 'mirror-state.json') {
        written = true;
        editJson(mac.claudeJson, (j) => { j.oauthAccount = { login: 'in the window' }; });
      }
      return write.call(this, file, data, mode);
    });
    await w.home.links.pushMirror(W);
    const after = json(mac.claudeJson);
    expect(written).toBe(true);
    expect(after.mcpServers.added).toBeDefined();
    expect(after.oauthAccount).toEqual({ login: 'in the window' });
  });
});
