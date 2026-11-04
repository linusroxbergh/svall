import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineId, type SetupRow } from '@svall/protocol';
import { answer, dispatch, type Ctx } from '../../src/api/methods.js';
import { DurableBatch } from '../../src/durable.js';
import { backupsHere } from '../../src/placement/mirror.js';
import { readState } from '../../src/placement/mirror-state.js';
import { realPath } from '../../src/paths.js';
import { editJson, farHome, json, macHome, put, read } from './mirror-homes.js';
import { H, stopWorlds, W, world } from './world.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await stopWorlds();
});

const OTHER = MachineId.parse('dddddddd-0000-4000-8000-000000000000');

const call = async <T = unknown>(ctx: Ctx, method: string, params: object): Promise<T> => {
  const res = await dispatch({ id: 1, method, params } as never, ctx);
  if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.result as T;
};
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'unauthorized' });
const folders = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// a home whose setup a Mac's, and a Mac with a person's own files where the mirror writes
function onto() {
  const home = macHome();
  const mac = farHome();
  fs.rmSync(path.join(mac.overrides, 'claude/CLAUDE.md'), { force: true });
  fs.rmSync(path.join(mac.overrides, 'claude/settings.json'), { force: true });
  put(path.join(mac.claudeDir, 'CLAUDE.md'), '# my own\n');
  put(path.join(mac.claudeDir, 'rules/style.md'), 'mine\n');
  put(path.join(mac.claudeDir, 'rules/only-here.md'), 'stays\n');
  editJson(path.join(mac.claudeDir, 'settings.json'), (j) => { j.model = 'mine'; j.onlyHere = true; });
  const backups = path.join(mac.homedir, '.svall/mirror-backup');
  const w = world({ mirror: { home, worker: { ...mac, backups } } });
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
    expect(folders(backups)).toEqual([new Date().toISOString().slice(0, 10)]);
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

  it('a second push keeps no copy, whatever it replaces', async () => {
    const { home, mac, backups, w, day } = onto();
    await w.link();
    await w.home.links.pushMirror(W);
    const held = readState(w.worker.paths.mirrorState).backup;
    expect(held?.done).toBe(true);
    put(path.join(home.claudeDir, 'rules/style.md'), 'terser\n');
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# edited since\n');
    await w.home.links.pushMirror(W);
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
    expect(readState(w.worker.paths.mirrorState).backup).toEqual({ dir: cut!.dir, done: true });
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

// a home that holds a setup of its own, and a Mac whose setup is copied there
function copyOf() {
  const home = farHome();
  fs.rmSync(path.join(home.overrides, 'claude/CLAUDE.md'), { force: true });
  put(path.join(home.claudeDir, 'CLAUDE.md'), '# the server\n');
  const mac = { ...macHome(), overrides: path.join(home.homedir, 'unused-overrides') };
  editJson(mac.claudeJson, (j) => {
    j.mcpServers.two = { command: 'npx', args: ['-y', 'two-mcp'], env: { A_KEY: 'a_key_1234567890', B_KEY: 'b_key_1234567890' } };
  });
  const w = world({ mirror: { home, worker: mac } });
  return {
    home, mac, w,
    ask: () => call<{ sent: number; backup?: string }>(w.home.ctx, 'machines.copySetupFrom', { machine: W }),
    linked: async () => { await w.link(); await w.home.links.mirrorSettled(W); },
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
    const { w } = copyOf();
    await w.link();
    await call(w.worker.ctx, 'home.setupConsent', { item: 'claude:mcp:two', fields: ['env.A_KEY'], on: true });
    expect(fs.existsSync(w.home.paths.mirrorConsent)).toBe(false);
    expect(json(w.worker.paths.mirrorConsent)[H]).toEqual(['claude:mcp:two#env.A_KEY']);
  });

  it('keeps a folder for each copy, as each may replace what was edited on the home since', async () => {
    const { home, mac, ask, linked } = copyOf();
    await linked();
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# first\n');
    const first = await ask();
    put(path.join(home.claudeDir, 'CLAUDE.md'), '# edited on the server\n');
    put(path.join(mac.claudeDir, 'CLAUDE.md'), '# second\n');
    const second = await ask();
    expect(read(path.join(home.claudeDir, 'CLAUDE.md'))).toBe('# second\n');
    expect(second.backup).not.toBe(first.backup);
    expect(read(path.join(second.backup!, '.claude/CLAUDE.md'))).toBe('# edited on the server\n');
    expect(read(path.join(first.backup!, '.claude/CLAUDE.md'))).toBe('# the server\n');
  });

  it('a copy that replaces nothing names no folder', async () => {
    const { ask, linked } = copyOf();
    await linked();
    await ask();
    expect((await ask()).backup).toBeUndefined();
  });

  it('takes the mirror\'s calls from no worker it was not told of, nor from any once told of another', async () => {
    const { w } = copyOf();
    await w.link();
    const send = () => w.worker.connection.call('config.state', asks);
    await refused(send());
    w.home.setupCopy!.arm(OTHER);
    await refused(send());
  });

  it('refuses a named worker past its grant\'s expiry', async () => {
    const { w } = copyOf();
    await w.link();
    w.home.setupCopy!.arm(W, -1);
    await refused(w.worker.connection.call('config.state', asks));
    w.home.setupCopy!.arm(W);
    await expect(w.worker.connection.call('config.state', asks)).resolves.toBeDefined();
  });

  it('refuses a second use of one grant: a second blob, and anything past the apply', async () => {
    const { home, mac, w } = copyOf();
    await w.link();
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

  it('the grant ends with the copy, one that failed too, and with the worker\'s link', async () => {
    const { w, ask } = copyOf();
    await w.link();
    await ask();
    await refused(w.worker.connection.call('config.state', asks));
    await expect(w.home.setupCopy!.from(W, () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await refused(w.worker.connection.call('config.state', asks));
    w.home.setupCopy!.arm(W);
    w.home.setupCopy!.lost(W);
    await refused(w.worker.connection.call('config.state', asks));
  });

  it('never takes the mirror\'s other calls, and a worker still sends on no machines call', async () => {
    const { w } = copyOf();
    await w.link();
    w.home.setupCopy!.arm(W);
    await refused(answer('config.report', {}, w.home.ctx, W));
    await refused(answer('env.set', { name: 'A', value: 'b' }, w.home.ctx, W));
    await refused(answer('machines.copySetupFrom', { machine: W }, w.home.ctx, W));
  });

  it('is asked of the home by a window alone: a worker\'s daemon sends it on and is refused, and a phone is refused', async () => {
    const { w } = copyOf();
    await w.link();
    await refused(call(w.worker.ctx, 'machines.copySetupFrom', { machine: W }));
    await expect(call({ ...w.home.ctx, viewer: { kind: 'phone' } } as Ctx, 'machines.copySetupFrom', { machine: W })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(w.home.ctx, 'machines.copySetupFrom', { machine: OTHER })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call({ ...w.worker.ctx, viewer: { kind: 'phone' } } as Ctx, 'home.setup', {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('names a worker\'s rows and backup with its home away, and a home has no such rows', async () => {
    const { w } = copyOf();
    await w.link();
    await w.worker.connection.stop();
    const { rows } = await call<{ rows: SetupRow[] }>(w.worker.ctx, 'home.setup', {});
    expect(rows.some((r) => r.key === 'claude:mcp:two')).toBe(true);
    await expect(call(w.home.ctx, 'home.setup', {})).rejects.toMatchObject({ code: 'not_found' });
  });
});
