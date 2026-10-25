import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMirror, MIRROR_FILE_MAX, mirrorPlan, packMirror } from '../../src/placement/mirror.js';
import { unpack } from '../../src/placement/move.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const put = (file: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const json = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

const MAC_HOOKS = { Stop: [{ hooks: [{ type: 'command', command: '/Applications/Svall.app/hook' }] }] };
const MAC_STATUS = { type: 'command', command: '/Applications/Svall.app/status' };

// a Mac home: Claude's configuration with what must not travel beside it, Codex's, the shared skills and a profile
function macHome() {
  const homedir = makeHome();
  const claudeDir = path.join(homedir, '.claude');
  const codexDir = path.join(homedir, '.codex');
  const agentProfiles = path.join(homedir, '.svall/agent-profiles');
  put(path.join(claudeDir, 'CLAUDE.md'), '# how I work\n');
  put(path.join(claudeDir, 'skills/review/SKILL.md'), 'review it\n');
  put(path.join(claudeDir, 'skills/review/.env'), 'TOKEN=secret\n');
  put(path.join(claudeDir, 'rules/style.md'), 'terse\n');
  put(path.join(claudeDir, 'agents/planner.md'), 'plan\n');
  put(path.join(claudeDir, 'commands/ship.md'), 'ship\n');
  put(path.join(claudeDir, 'keybindings.json'), '[]\n');
  put(path.join(claudeDir, 'settings.json'), JSON.stringify({
    model: 'opus', theme: 'dark', hooks: MAC_HOOKS, statusLine: MAC_STATUS,
    scratchDir: path.join(homedir, 'scratch'), sandbox: { workPath: [path.join(homedir, 'code')], cwd: '/opt/shared' },
  }));
  put(path.join(claudeDir, 'plugins/installed_plugins.json'), '{}');
  put(path.join(claudeDir, '.credentials.json'), '{"token":"x"}');
  put(path.join(claudeDir, 'projects/-Users-ada-code/s.jsonl'), '{}\n');
  put(path.join(homedir, '.claude.json'), '{"mcpServers":{}}');
  put(path.join(codexDir, 'AGENTS.md'), '# codex\n');
  put(path.join(codexDir, 'auth.json'), '{}');
  put(path.join(homedir, '.agents/skills/lint/SKILL.md'), 'lint\n');
  put(path.join(agentProfiles, 'reviewer.md'), 'a reviewer\n');
  return { homedir, claudeDir, codexDir, agentProfiles };
}

describe('the agent configuration mirror', () => {
  it('the plan lists CLAUDE.md, skills, rules, agents, commands and a settings.json without hooks and statusLine, and nothing from .claude.json or plugins', () => {
    const mac = macHome();
    const plan = mirrorPlan(mac);
    expect(plan.files.map((f) => f.to).sort()).toEqual([
      'claude/CLAUDE.md', 'claude/agents/planner.md', 'claude/commands/ship.md', 'claude/keybindings.json', 'claude/rules/style.md',
      'claude/skills/review/SKILL.md', 'codex/AGENTS.md', 'home/.agents/skills/lint/SKILL.md', 'profiles/reviewer.md',
    ]);
    expect(plan.files.find((f) => f.to === 'claude/CLAUDE.md')).toEqual({ from: path.join(mac.claudeDir, 'CLAUDE.md'), to: 'claude/CLAUDE.md', mode: fs.statSync(path.join(mac.claudeDir, 'CLAUDE.md')).mode & 0o777 });
    expect(plan.settings).toEqual({ model: 'opus', theme: 'dark', scratchDir: path.join(mac.homedir, 'scratch'), sandbox: { workPath: [path.join(mac.homedir, 'code')], cwd: '/opt/shared' } });
    expect(plan.skipped).toEqual([]);
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
    const far = makeHome();
    const worker = {
      homedir: far, claudeDir: path.join(far, '.claude'), codexDir: path.join(far, '.codex'),
      agentProfiles: path.join(far, '.svall/agent-profiles'), overrides: path.join(far, '.svall/mirror-overrides'),
    };
    const farHooks = { Stop: [{ hooks: [{ type: 'command', command: '/home/ada/.svall/hooks/hook' }] }] };
    const farStatus = { type: 'command', command: '/home/ada/.svall/hooks/status' };
    put(path.join(worker.claudeDir, 'settings.json'), JSON.stringify({ model: 'haiku', cleanupPeriodDays: 7, hooks: farHooks, statusLine: farStatus }));
    put(path.join(worker.overrides, 'claude/settings.json'), JSON.stringify({ model: 'sonnet' }));
    put(path.join(worker.overrides, 'claude/CLAUDE.md'), '# this worker\n');

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
    expect(json(path.join(worker.claudeDir, 'settings.json'))).toEqual({
      model: 'sonnet', cleanupPeriodDays: 7, hooks: farHooks, statusLine: farStatus, theme: 'dark',
      scratchDir: path.join(far, 'scratch'), sandbox: { workPath: [path.join(far, 'code')], cwd: '/opt/shared' },
    });
    expect(fs.readFileSync(path.join(worker.claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# this worker\n');
    expect(fs.readFileSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'), 'utf8')).toBe('review it\n');
    for (const gone of ['skills/review/.env', 'plugins', '.credentials.json', 'projects']) expect(fs.existsSync(path.join(worker.claudeDir, gone))).toBe(false);
    expect(fs.existsSync(path.join(far, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(worker.codexDir, 'auth.json'))).toBe(false);

    const skill = fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'));
    const settings = fs.statSync(path.join(worker.claudeDir, 'settings.json'));
    expect(applyMirror(blob, worker)).toEqual([]);
    expect(fs.statSync(path.join(worker.claudeDir, 'skills/review/SKILL.md'))).toMatchObject({ ino: skill.ino, mtimeMs: skill.mtimeMs });
    expect(fs.statSync(path.join(worker.claudeDir, 'settings.json'))).toMatchObject({ ino: settings.ino, mtimeMs: settings.mtimeMs });
  });
});
