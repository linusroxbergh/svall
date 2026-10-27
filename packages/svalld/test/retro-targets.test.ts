import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realPath } from '../src/paths.js';
import { fitTargets, inventory, type Target } from '../src/retro/targets.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (name: string, d = `does ${name}`) => `---\nname: ${name}\ndescription: ${d}\n---\n# ${name}\n`;
const link = (to: string, from: string) => { fs.mkdirSync(path.dirname(from), { recursive: true }); fs.symlinkSync(to, from); };
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const noRemote = () => false;
const byId = (ts: Target[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const dirs = (home: string) => ({ homedir: home, claudeDir: path.join(home, '.claude'), codexDir: path.join(home, '.codex') });

describe('inventory', () => {
  it('classifies a symlinked skill by its real path', async () => {
    const home = makeHome(), dots = makeHome();
    put(path.join(dots, 'skills/shared/SKILL.md'), skill('shared'));
    link(path.join(dots, 'skills/shared'), path.join(home, '.claude/skills/shared'));
    link(path.join(dots, 'skills/shared'), path.join(home, '.codex/skills/shared'));
    put(path.join(home, '.agents/skills/mine/SKILL.md'), skill('mine'));
    put(path.join(home, '.claude/CLAUDE.md'), '# rules\n');
    const inRepo = (p: string) => p.startsWith(realPath(dots) + path.sep);

    const ts = byId(await inventory({ ...dirs(home), repos: [], homeCwd: path.join(home, '.svall/home'), isGitWithRemote: inRepo }));

    expect(Object.keys(ts).sort()).toEqual(['rule:~/.claude/CLAUDE.md', 'skill:mine', 'skill:shared']);
    expect(ts['skill:shared']).toMatchObject({
      kind: 'skill', name: 'shared', description: 'does shared', class: 'repo',
      path: path.join(home, '.claude/skills/shared/SKILL.md'), realPath: realPath(path.join(dots, 'skills/shared/SKILL.md')),
      hash: sha(path.join(dots, 'skills/shared/SKILL.md')),
    });
    expect(ts['skill:mine'].class).toBe('local');
    expect(ts['rule:~/.claude/CLAUDE.md']).toMatchObject({ kind: 'rule', name: '~/.claude/CLAUDE.md', class: 'local', review: false });
  });

  it('a plugin skill is synced', async () => {
    const home = makeHome();
    const plugin = path.join(home, '.claude/plugins/cache/market/plug/1.0.0');
    put(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'Plug' }));
    put(path.join(plugin, 'skills/do-thing/SKILL.md'), skill('do-thing'));
    put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'plug@market': [{ scope: 'user', installPath: plugin }] } }));
    put(path.join(home, '.claude/plugins/marketplaces/market/plugins/other/skills/not-installed/SKILL.md'), skill('not-installed'));
    put(path.join(home, '.claude/skills/synced/org_account/docs/SKILL.md'), skill('docs'));

    const ts = byId(await inventory({ ...dirs(home), repos: [], homeCwd: path.join(home, '.svall/home'), isGitWithRemote: () => true }));

    expect(Object.keys(ts).sort()).toEqual(['skill:Plug:do-thing', 'skill:anthropic-skills:docs']);
    expect(ts['skill:Plug:do-thing']).toMatchObject({ name: 'Plug:do-thing', class: 'synced' });
    expect(ts['skill:anthropic-skills:docs']).toMatchObject({ name: 'anthropic-skills:docs', class: 'synced' });
  });

  it("mission control's svall-* skills are svall", async () => {
    const home = makeHome(), repo = makeHome();
    const mc = path.join(home, '.svall/home');
    put(path.join(mc, '.claude/skills/svall-status/SKILL.md'), skill('svall-status'));
    put(path.join(mc, '.agents/skills/svall-status/SKILL.md'), skill('svall-status'));
    put(path.join(mc, 'CLAUDE.md'), '# mission control\n');
    put(path.join(mc, '.claude/rules/svall.md'), '# svall\n');
    put(path.join(repo, 'AGENTS.md'), '# repo\n');
    put(path.join(repo, '.claude/skills/publish/SKILL.md'), skill('publish'));

    const ts = byId(await inventory({ ...dirs(home), repos: [repo], homeCwd: mc, isGitWithRemote: () => true }));

    expect(ts['skill:svall-status']).toMatchObject({ class: 'svall', path: path.join(mc, '.claude/skills/svall-status/SKILL.md') });
    expect(ts['rule:~/.svall/home/CLAUDE.md'].class).toBe('svall');
    expect(ts['rule:~/.svall/home/.claude/rules/svall.md'].class).toBe('svall');
    expect(ts['skill:publish'].class).toBe('repo');
    expect(ts[`rule:${repo}/AGENTS.md`].class).toBe('repo');
  });

  it("reads Claude's and Codex's folders where CLAUDE_CONFIG_DIR and CODEX_HOME put them", async () => {
    const home = makeHome(), elsewhere = makeHome();
    put(path.join(home, '.claude/skills/default/SKILL.md'), skill('default'));
    put(path.join(home, '.codex/AGENTS.md'), '# default\n');
    put(path.join(elsewhere, 'claude/skills/mine/SKILL.md'), skill('mine'));
    put(path.join(elsewhere, 'claude/CLAUDE.md'), '# mine\n');
    put(path.join(elsewhere, 'codex/skills/theirs/SKILL.md'), skill('theirs'));
    put(path.join(elsewhere, 'claude/skills/synced/acct/docs/SKILL.md'), skill('docs'));

    const ts = byId(await inventory({
      homedir: home, claudeDir: path.join(elsewhere, 'claude'), codexDir: path.join(elsewhere, 'codex'), repos: [], homeCwd: path.join(home, '.svall/home'), isGitWithRemote: noRemote,
    }));

    expect(Object.keys(ts).sort()).toEqual([`rule:${path.join(elsewhere, 'claude/CLAUDE.md')}`, 'skill:anthropic-skills:docs', 'skill:mine', 'skill:theirs']);
    expect(ts['skill:anthropic-skills:docs'].class).toBe('synced');
  });

  it("drops a repo's or mission control's file whose real path leaves its folder", async () => {
    const home = makeHome(), repo = makeHome();
    const mc = path.join(home, '.svall/home');
    put(path.join(home, '.zshrc'), 'export PATH=x\n');
    link(path.join(home, '.zshrc'), path.join(repo, '.claude/skills/evil/SKILL.md'));
    link(path.join(home, '.zshrc'), path.join(repo, 'CLAUDE.md'));
    link(path.join(home, '.zshrc'), path.join(mc, 'AGENTS.md'));
    put(path.join(repo, 'docs/AGENTS.md'), '# repo\n');
    link(path.join(repo, 'docs/AGENTS.md'), path.join(repo, 'AGENTS.md'));

    const ts = byId(await inventory({ ...dirs(home), repos: [repo], homeCwd: mc, isGitWithRemote: () => true }));

    expect(Object.keys(ts)).toEqual([`rule:${repo}/AGENTS.md`]);
  });

  it('tells apart skills of one name in different folders by the folder, and keeps one file found twice', async () => {
    const home = makeHome(), a = path.join(home, 'code/a'), b = path.join(home, 'code/b');
    put(path.join(a, '.claude/skills/deploy/SKILL.md'), skill('deploy', 'deploys a'));
    put(path.join(b, '.claude/skills/deploy/SKILL.md'), skill('deploy', 'deploys b'));
    put(path.join(a, '.agents/skills/deploy/SKILL.md'), skill('deploy', 'a copy in a'));
    put(path.join(a, '.claude/skills/lint/SKILL.md'), skill('lint'));
    link(path.join(a, '.claude/skills/lint'), path.join(home, '.claude/skills/lint'));

    const ts = byId(await inventory({ ...dirs(home), repos: [a, b], homeCwd: path.join(home, '.svall/home'), isGitWithRemote: () => true }));

    expect(Object.keys(ts).sort()).toEqual(['skill:deploy@~/code/a', 'skill:deploy@~/code/b', 'skill:lint']);
    expect(ts['skill:deploy@~/code/a']).toMatchObject({ name: 'deploy', description: 'deploys a', path: path.join(a, '.claude/skills/deploy/SKILL.md') });
    expect(ts['skill:deploy@~/code/b']).toMatchObject({ name: 'deploy', description: 'deploys b', path: path.join(b, '.claude/skills/deploy/SKILL.md') });
  });

  it('review skills by name and by config', async () => {
    const home = makeHome();
    for (const n of ['deep-review', 'prepush', 'ship-it']) put(path.join(home, `.claude/skills/${n}/SKILL.md`), skill(n));
    put(path.join(home, '.claude/rules/review.md'), '# how to review\n');

    const ts = byId(await inventory({ ...dirs(home), repos: [], homeCwd: path.join(home, '.svall/home'), reviewSkills: ['prepush'], isGitWithRemote: noRemote }));

    expect(ts['skill:deep-review'].review).toBe(true);
    expect(ts['skill:prepush'].review).toBe(true);
    expect(ts['skill:ship-it'].review).toBe(false);
    expect(ts['rule:~/.claude/rules/review.md'].review).toBe(false);
  });
});

describe('fitTargets', () => {
  it('fitTargets stays under the cap', async () => {
    const home = makeHome();
    // 400, 4000 and 200 characters: 100, 1000 and 50 tokens at 4 characters a token
    put(path.join(home, '.claude/skills/a/SKILL.md'), 'a'.repeat(400));
    put(path.join(home, '.claude/skills/big/SKILL.md'), 'b'.repeat(4000));
    put(path.join(home, '.claude/skills/c/SKILL.md'), 'c'.repeat(200));
    const ts = byId(await inventory({ ...dirs(home), repos: [], homeCwd: path.join(home, '.svall/home'), isGitWithRemote: noRemote }));
    const [a, big, c] = [ts['skill:a'], ts['skill:big'], ts['skill:c']];

    // one entry per note naming it: c is named most, then big, then a
    const kept = fitTargets([a, big, c, big, c, c], 160, 4);

    expect(kept.map((t) => t.id)).toEqual(['skill:c', 'skill:a']);
    expect(fitTargets([a, c], 1000, 4).map((t) => t.id)).toEqual(['skill:a', 'skill:c']);
    expect(fitTargets([big], undefined, 4)).toEqual([big]);
  });
});
