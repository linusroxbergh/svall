import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexPaths } from '../src/codex/install.js';
import { opencodePaths } from '../src/opencode/install.js';
import { checkoutRuntime } from '../src/runtime.js';
import { installHomeTemplate, runSetup } from '../src/setup.js';
import { cleanHomes, makeHome } from './helpers.js';

const opencodeIn = (home: string) => opencodePaths({ XDG_CONFIG_HOME: path.join(home, 'xdg'), XDG_DATA_HOME: path.join(home, 'xdg-data') });

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = checkoutRuntime(repoRoot);

describe('the home template', () => {
  it("leaves mission control's edited settings alone on a silent refresh", async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const paths = { home, settingsPath: path.join(home, 'claude-settings.json'), codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime: checkoutRuntime(repoRoot), launchctl: false };
    await runSetup(paths);
    const edited = path.join(mc, '.claude', 'settings.json');
    fs.writeFileSync(edited, '{"mine":true}\n');
    await runSetup({ ...paths, replaceSettings: false });
    expect(fs.readFileSync(edited, 'utf8')).toBe('{"mine":true}\n');
  });

  it('writes the home CLAUDE.md once and leaves an edited one alone', async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) };
    const first = await runSetup(o);
    const md = path.join(mc, 'CLAUDE.md');
    expect(first.some((l) => l.startsWith('home CLAUDE.md ->'))).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('# Mission control');
    expect(fs.readFileSync(md, 'utf8')).toContain('.claude/rules/svall.md');
    fs.writeFileSync(md, 'mine');
    const second = await runSetup(o);
    expect(second.some((l) => l.startsWith('home CLAUDE.md ->'))).toBe(false);
    expect(fs.readFileSync(md, 'utf8')).toBe('mine');
  });

  it('rewrites the home skills and settings on every run', async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) };
    const first = await runSetup(o);
    expect(first.some((l) => l.startsWith('home skills ->'))).toBe(true);
    const settings = path.join(mc, '.claude/settings.json');
    const allow = JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow;
    expect(allow).toContain('Bash(svall robot update:*)');
    expect(allow).toContain('Bash(svall robot send:*)');
    expect(allow).not.toContain('Bash(svall:*)');
    expect(allow.some((a: string) => a.startsWith('Bash(svall robot new') || a.startsWith('Bash(svall robot run'))).toBe(false);
    for (const skill of ['svall-organise', 'svall-rename', 'svall-update-info', 'svall-status']) {
      expect(fs.readFileSync(path.join(mc, '.claude/skills', skill, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
    }
    const agentsMd = () => fs.readFileSync(path.join(mc, 'AGENTS.md'), 'utf8');
    // the crew rules, then the user's CLAUDE.md
    expect(agentsMd()).toContain('You are a crew member on the mission control island');
    expect(agentsMd()).toContain('Add your own rules for mission control here.');
    for (const skill of ['svall-organise', 'svall-rename', 'svall-update-info', 'svall-status']) {
      expect(fs.readFileSync(path.join(mc, '.agents/skills', skill, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
    }
    expect(fs.readFileSync(path.join(mc, '.codex/rules/svall.rules'), 'utf8')).toContain('prefix_rule(pattern = ["svall", "status"], decision = "allow")');
    // an edit to CLAUDE.md reaches codex with the next start
    fs.appendFileSync(path.join(mc, 'CLAUDE.md'), '- Launch every task in a fresh worktree.\n');
    fs.writeFileSync(settings, 'mine');
    const second = await runSetup(o);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(svall robot update:*)');
    const backup = second.find((l) => l.startsWith('backup ->') && l.includes('.claude/settings.json'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(backup!.split(' -> ')[1], 'utf8')).toBe('mine');
    expect(agentsMd()).toContain('Launch every task in a fresh worktree.');
  });

  it('backs up a hand-written AGENTS.md instead of overwriting it', () => {
    const mc = path.join(makeHome(), 'mc');
    fs.mkdirSync(mc, { recursive: true });
    const agentsMd = path.join(mc, 'AGENTS.md');
    fs.writeFileSync(agentsMd, 'my own codex crew rules');
    const done = installHomeTemplate(mc, { replaceSettings: false });
    const backup = done.find((l) => l.startsWith('backup ->') && l.includes('AGENTS.md.bak-'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(backup!.split(' -> ')[1], 'utf8')).toBe('my own codex crew rules');
    expect(fs.readFileSync(agentsMd, 'utf8')).toContain('svalld rewrites this file');
  });

  it('leaves AGENTS.md alone across runs when CLAUDE.md is a symlink to it, instead of growing it', () => {
    const mc = path.join(makeHome(), 'mc');
    fs.mkdirSync(mc, { recursive: true });
    const agentsMd = path.join(mc, 'AGENTS.md');
    const claudeMd = path.join(mc, 'CLAUDE.md');
    fs.writeFileSync(agentsMd, 'shared crew rules');
    fs.symlinkSync(agentsMd, claudeMd);
    installHomeTemplate(mc, { replaceSettings: false });
    const size1 = fs.statSync(agentsMd).size;
    installHomeTemplate(mc, { replaceSettings: false });
    const size2 = fs.statSync(agentsMd).size;
    expect(size2).toBe(size1);
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe('shared crew rules');
  });

  it('installs the shipped skills from skills/ into .claude/skills and .agents/skills, svall-retro among them', () => {
    const mc = path.join(makeHome(), 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const shipped = path.join(repoRoot, 'packages/svalld/skills');
    const skills = fs.readdirSync(shipped).sort();
    expect(skills).toContain('svall-retro');
    for (const dir of ['.claude/skills', '.agents/skills']) {
      expect(fs.readdirSync(path.join(mc, dir)).sort(), dir).toEqual(skills);
      for (const skill of skills) {
        expect(fs.readFileSync(path.join(mc, dir, skill, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(shipped, skill, 'SKILL.md'), 'utf8'));
      }
    }
  });

  it('a daemon start refreshes the skills but leaves edited settings alone', () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(svall robot update:*)');

    const skill = path.join(mc, '.claude/skills/svall-rename/SKILL.md');
    const rules = path.join(mc, '.claude/rules/svall.md');
    const mine = path.join(mc, '.claude/rules/mine.md');
    fs.writeFileSync(skill, 'stale');
    fs.writeFileSync(rules, 'stale');
    fs.writeFileSync(mine, 'mine');
    fs.writeFileSync(settings, 'mine');
    const done = installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(skill, 'utf8')).toContain('name: svall-rename');
    expect(fs.readFileSync(rules, 'utf8')).toContain('svall status');
    expect(fs.readFileSync(mine, 'utf8')).toBe('mine');
    expect(fs.readFileSync(settings, 'utf8')).toBe('mine');
    expect(done.some((l) => l.startsWith('backup ->'))).toBe(false);
  });

  it('a daemon start adds svall robot beside each svall char an older svalld allowed, keeping the rest', () => {
    const mc = path.join(makeHome(), 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    const shipped: string[] = JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow;
    const older = fs.readFileSync(settings, 'utf8').split('\n').filter((l) => !l.includes('svall char ')).join('\n')
      .replaceAll('svall robot ', 'svall char ').replace('"Bash(svall status:*)"', '"Bash(git log:*)", "Bash(svall status:*)"');
    fs.writeFileSync(settings, older);
    installHomeTemplate(mc, { replaceSettings: false });
    const migrated = fs.readFileSync(settings, 'utf8');
    expect(JSON.parse(migrated).permissions.allow).toEqual(expect.arrayContaining([...shipped, 'Bash(git log:*)']));
    installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(settings, 'utf8')).toBe(migrated);
  });

  it("old home settings gain svall retro in their allow list when the fleet offers it, keeping the user's rules", () => {
    const mc = path.join(makeHome(), 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    const shipped = fs.readFileSync(settings, 'utf8');
    const allow: string[] = JSON.parse(shipped).permissions.allow;
    const retro = allow.filter((r) => r.startsWith('Bash(svall retro '));
    const older = allow.filter((r) => !retro.includes(r));
    const write = (permissions: { allow: string[]; deny?: string[] }) => fs.writeFileSync(settings, `${JSON.stringify({ permissions }, null, 2)}\n`);
    const permissions = () => JSON.parse(fs.readFileSync(settings, 'utf8')).permissions;
    write({ allow: older });
    installHomeTemplate(mc, { replaceSettings: false, addRetro: true });
    expect(fs.readFileSync(settings, 'utf8')).toBe(shipped);

    // a start that offers nothing leaves out the rules a user removed
    write({ allow: older });
    installHomeTemplate(mc, { replaceSettings: false });
    expect(permissions().allow).toEqual(older);

    // a rule of the user's after the scribe's keeps its place
    write({ allow: [...older, 'Bash(git log:*)'] });
    installHomeTemplate(mc, { replaceSettings: false, addRetro: true });
    expect(permissions().allow).toEqual([...older, ...retro, 'Bash(git log:*)']);

    // the scribe's rule under deny pulls none into deny
    write({ allow: ['Bash(svall status:*)'], deny: ['Bash(svall scribe sweep:*)'] });
    installHomeTemplate(mc, { replaceSettings: false, addRetro: true });
    expect(permissions()).toEqual({ allow: ['Bash(svall status:*)', ...retro], deny: ['Bash(svall scribe sweep:*)'] });
  });

  it('settings that allow svall retro findings gain svall retro show beside it', () => {
    const mc = path.join(makeHome(), 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    const shipped = fs.readFileSync(settings, 'utf8');
    const allow: string[] = JSON.parse(shipped).permissions.allow;
    fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: allow.filter((r) => r !== 'Bash(svall retro show:*)') } }, null, 2)}\n`);
    installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(settings, 'utf8')).toBe(shipped);
    // settings that allow no findings gain no show
    fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: ['Bash(svall status:*)'] } }, null, 2)}\n`);
    installHomeTemplate(mc, { replaceSettings: false });
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toEqual(['Bash(svall status:*)']);
  });

  it('settings that allow svall robot update gain svall robot send beside it, and so for char', () => {
    const mc = path.join(makeHome(), 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    const shipped = fs.readFileSync(settings, 'utf8');
    const allow: string[] = JSON.parse(shipped).permissions.allow;
    fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: allow.filter((r) => !r.endsWith(' send:*)')) } }, null, 2)}\n`);
    installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(settings, 'utf8')).toBe(shipped);
  });

  // Claude Code asks before a command holding a shell variable even when a rule allows it
  it('lets the buttons run every svall command their skills name without asking, deleting an island, applying a retro finding and changing its config aside', () => {
    const svalld = path.join(repoRoot, 'packages/svalld');
    const allow: string[] = JSON.parse(fs.readFileSync(path.join(svalld, 'home/.claude/settings.json'), 'utf8')).permissions.allow;
    const prefixes = allow.map((a) => /^Bash\((.+):\*\)$/.exec(a)![1]);
    for (const skill of fs.readdirSync(path.join(svalld, 'skills'))) {
      const text = fs.readFileSync(path.join(svalld, 'skills', skill, 'SKILL.md'), 'utf8');
      const commands = [...text.matchAll(/(?:`|^ {4,})(svall [^`\n]+)/gm)].map((m) => m[1].trim());
      expect(commands.length, skill).toBeGreaterThan(0);
      // `svall retro` alone names the command and runs nothing
      for (const c of commands.filter((c) => !/^svall (island delete|retro apply|retro config)\b|^svall retro$/.test(c))) {
        expect(c, `${skill}: ${c}`).not.toContain('$');
        expect(prefixes.some((p) => c.startsWith(p)), `${skill}: ${c}`).toBe(true);
      }
    }
    for (const c of ['svall retro apply 1', 'svall retro config --exclude-island x']) expect(prefixes.some((p) => c.startsWith(p)), c).toBe(false);
  });

  it('the codex rules allow svall retro, applying a finding and changing its config aside', () => {
    const mc = path.join(makeHome(), 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(path.join(mc, '.codex/rules/svall.rules'), 'utf8'))
      .toContain('prefix_rule(pattern = ["svall", "retro", ["plan", "run", "wait", "status", "findings", "show", "mark"]], decision = "allow")');
  });

  it('allows a Codex crew exactly the svall commands a Claude crew is allowed', () => {
    const template = path.join(repoRoot, 'packages/svalld/home');
    const allow: string[] = JSON.parse(fs.readFileSync(path.join(template, '.claude/settings.json'), 'utf8')).permissions.allow;
    // ["svall", "robot", ["list", "read"]] allows svall robot list and svall robot read
    const expand = (pattern: (string | string[])[]): string[] =>
      pattern.reduce<string[]>((heads, word) => heads.flatMap((h) => [word].flat().map((w) => `${h} ${w}`.trim())), ['']);
    const rules = fs.readFileSync(path.join(template, '.codex/rules/svall.rules'), 'utf8');
    const codex = [...rules.matchAll(/^prefix_rule\(pattern = (\[.*\]), decision = "allow"\)$/gm)].flatMap((m) => expand(JSON.parse(m[1])));
    expect(codex.sort()).toEqual(allow.map((a) => /^Bash\((.+):\*\)$/.exec(a)![1]).sort());
  });
});
