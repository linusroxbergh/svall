import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMirror, MIRROR_FILE_MAX, mirrorPlan, packMirror } from '../../src/placement/mirror.js';
import { unpack } from '../../src/placement/move.js';
import { cleanHomes, makeHome } from '../helpers.js';
import { FAR_HOOKS, FAR_STATUS, farHome, macHome, put } from './mirror-homes.js';
import { W, until, world } from './world.js';

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  cleanHomes();
});

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const json = (file: string): unknown => JSON.parse(read(file));

const PLANNED = [
  'claude/CLAUDE.md', 'claude/agents/planner.md', 'claude/commands/ship.md', 'claude/keybindings.json', 'claude/rules/style.md',
  'claude/skills/review/SKILL.md', 'codex/AGENTS.md', 'home/.agents/skills/lint/SKILL.md', 'profiles/reviewer.md',
];

describe('the agent configuration mirror', () => {
  it('the plan lists CLAUDE.md, skills, rules, agents, commands and a settings.json without hooks and statusLine, and nothing from .claude.json or plugins', () => {
    const mac = macHome();
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to).sort()).toEqual(PLANNED);
    expect(plan.files.find((f) => f.to === 'claude/CLAUDE.md')).toEqual({ from: path.join(mac.claudeDir, 'CLAUDE.md'), to: 'claude/CLAUDE.md', mode: fs.statSync(path.join(mac.claudeDir, 'CLAUDE.md')).mode & 0o777 });
    // and none of the settings that hold secrets or run what fetches them
    expect(plan.settings).toEqual({ model: 'opus', theme: 'dark', scratchDir: path.join(mac.homedir, 'scratch'), sandbox: { workPath: [path.join(mac.homedir, 'code')], cwd: '/opt/shared' } });
    expect(plan.skipped).toEqual([]);
  });

  it('a link into plugins or to a login file, and a key by any of its names, stays on the Mac; a link to a plain file travels', () => {
    const mac = macHome();
    put(path.join(mac.claudeDir, 'plugins/cache/acme/skills/pdf/SKILL.md'), 'pdf\n');
    fs.symlinkSync(path.join(mac.claudeDir, 'plugins/cache/acme/skills/pdf'), path.join(mac.claudeDir, 'skills/pdf'));
    fs.symlinkSync(path.join(mac.homedir, '.claude.json'), path.join(mac.claudeDir, 'skills/review/cfg.json'));
    fs.symlinkSync(path.join(mac.codexDir, 'auth.json'), path.join(mac.claudeDir, 'rules/codex.md'));
    fs.symlinkSync(path.join(mac.claudeDir, '.credentials.json'), path.join(mac.claudeDir, 'agents/login.md'));
    for (const key of ['id_ed25519', 'id_ed25519.pub', 'deploy.p12', 'credentials.json', 'auth.json', 'server.pem']) put(path.join(mac.homedir, '.agents/skills/lint', key), 'secret\n');
    put(path.join(mac.homedir, 'notes/house.md'), 'house style\n');
    fs.symlinkSync(path.join(mac.homedir, 'notes/house.md'), path.join(mac.claudeDir, 'rules/house.md'));
    expect(mirrorPlan(mac).files.map((f) => f.to).sort()).toEqual([...PLANNED, 'claude/rules/house.md'].sort());
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
      `${path.join(mac.claudeDir, 'skills/review/model.bin')} is over 5 MB`,
      `${path.join(mac.claudeDir, 'commands')} is over 200 MB`,
    ]);
  });

  it('applyMirror keeps the worker\'s hooks and statusLine and merges mirror-overrides last; an unchanged file is not rewritten', async () => {
    const mac = macHome();
    const worker = farHome();
    const far = worker.homedir;
    const scratch = makeHome();
    await packMirror(mirrorPlan(mac), mac, path.join(scratch, 'mirror.tar'));
    const blob = path.join(scratch, 'blob');
    await unpack(path.join(scratch, 'mirror.tar'), blob);

    const written = applyMirror(blob, worker);
    expect(written.sort()).toEqual([
      path.join(far, '.agents/skills/lint/SKILL.md'), path.join(worker.agentProfiles, 'reviewer.md'),
      ...['CLAUDE.md', 'agents/planner.md', 'commands/ship.md', 'keybindings.json', 'rules/style.md', 'settings.json', 'skills/review/SKILL.md'].map((f) => path.join(worker.claudeDir, f)),
      path.join(worker.codexDir, 'AGENTS.md'),
    ].sort());
    // the worker's own secrets, as its hooks and status line, stay as they were
    expect(json(path.join(worker.claudeDir, 'settings.json'))).toEqual({
      model: 'sonnet', cleanupPeriodDays: 7, hooks: FAR_HOOKS, statusLine: FAR_STATUS, env: { HTTPS_PROXY: 'http://proxy:3128' }, apiKeyHelper: '/home/ada/bin/key', theme: 'dark',
      scratchDir: path.join(far, 'scratch'), sandbox: { workPath: [path.join(far, 'code')], cwd: '/opt/shared' },
    });
    expect(read(path.join(worker.claudeDir, 'CLAUDE.md'))).toBe('# this worker\n');
    expect(read(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toBe('review it\n');
    for (const gone of ['skills/review/.env', 'plugins', '.credentials.json', 'projects']) expect(fs.existsSync(path.join(worker.claudeDir, gone))).toBe(false);
    expect(fs.existsSync(path.join(far, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(worker.codexDir, 'auth.json'))).toBe(false);

    const skill = fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'));
    const settings = fs.statSync(path.join(worker.claudeDir, 'settings.json'));
    expect(applyMirror(blob, worker)).toEqual([]);
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
    await until(() => expect(fs.readdirSync(w.worker.paths.cache).filter((f) => f.startsWith('mirror-'))).toEqual([]));
  });
});
