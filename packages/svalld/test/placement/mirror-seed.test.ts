import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, dispatch, type Ctx } from '../../src/api/methods.js';
import { readState } from '../../src/placement/mirror-state.js';
import { editJson, farHome, macHome, put, read } from './mirror-homes.js';
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

// a server as `svall setup` leaves it: no one's setup, only Svall's permission rules, its hooks and the profiles a fleet starts with
function emptyServer() {
  const home = farHome();
  for (const dir of [home.claudeDir, home.codexDir, home.opencodeDir]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home.overrides, { recursive: true, force: true });
  put(home.claudeJson, JSON.stringify({ oauthAccount: { a: 1 } }));
  put(path.join(home.claudeDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, statusLine: { type: 'command', command: '/x' }, permissions: SVALL_RULES }));
  put(path.join(home.codexDir, 'rules/svall.rules'), '# Managed by Svall: robot command permissions\n');
  put(path.join(home.agentProfiles!, 'reviewer.md'), 'a starter\n');
  return home;
}

function seeded(server = emptyServer(), keeps = true) {
  const mac = { ...macHome(), overrides: path.join(server.homedir, 'unused-overrides') };
  editJson(path.join(mac.claudeDir, 'settings.json'), (s) => { s.permissions = { allow: ['Bash(git:*)'] }; });
  const backups = path.join(mac.homedir, '.svall/mirror-backup');
  const w = world({ mirror: { home: server, worker: { ...mac, ...(keeps && { backups }) } } });
  const linked = async () => {
    await w.link();
    await until(() => expect(w.worker.connection.connected()).toBe(true));
    await w.home.links.mirrorSettled(W);
  };
  return { server, mac, backups, w, linked };
}
const seed = (ctx: Ctx) => call<{ sent: number; backup?: string }>(ctx, 'machines.copySetupFrom', { machine: W, seed: true });
const folders = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

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
  ])('holds one with %s, and refuses a seed', async (_what, make) => {
    const server = emptyServer();
    make(server);
    const { w, linked } = seeded(server);
    await linked();
    const asked = vi.spyOn(w.worker.handlers, 'config.copyToHome');
    expect(await call(w.home.ctx, 'machines.holdsSetup', {})).toEqual({ holds: true });
    await expect(seed(w.home.ctx)).rejects.toMatchObject({ code: 'refused' });
    expect(asked).not.toHaveBeenCalled();
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
