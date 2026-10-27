import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter, type TargetClass } from '@svall/protocol';
import { realPath } from '../paths.js';
import { plugins } from '../resources/parse.js';
import { fleetHomes } from '../uninstall.js';
import { within } from '../workspace/paths.js';
import { redact } from './redact.js';

/** A skill or rule file a finding may change, classed by where it really is, with the hash it had when read. */
export type Target = {
  id: string; kind: 'skill' | 'rule'; name: string; description?: string; path: string; realPath: string; class: TargetClass; hash: string; review: boolean;
};

type Found = { kind: 'skill' | 'rule'; name: string; path: string };

// a committed link can lead to a device or a huge file, so only a plain file under the cap is read
const readFile = (p: string): Buffer | undefined => {
  try { const st = fs.statSync(p); return st.isFile() && st.size <= 1024 * 1024 ? fs.readFileSync(p) : undefined; } catch { return undefined; }
};
const readJson = (p: string): Record<string, unknown> => {
  try { const v: unknown = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
};
const names = (dir: string): string[] => {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; }
};

// a skill is named as the agent calls it: its folder, after its plugin's name for a plugin's
const skillsIn = (dir: string, prefix = ''): Found[] => names(dir).map((n) => ({ kind: 'skill', name: prefix + n, path: path.join(dir, n, 'SKILL.md') }));
const rulesIn = (dir: string): string[] => names(dir).filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n));

// the plugins Claude installed, by the name each one's manifest gives
const pluginSkills = (claude: string): Found[] => plugins(readJson(path.join(claude, 'plugins/installed_plugins.json')).plugins, {}).flatMap((p) => {
  if (p.path === undefined) return [];
  const named = readJson(path.join(p.path, '.claude-plugin/plugin.json')).name;
  return skillsIn(path.join(p.path, 'skills'), `${typeof named === 'string' ? named : p.name}:`);
});

// claude.ai syncs its skills into a folder per account, and Claude calls them anthropic-skills:<name>
const syncedSkills = (claude: string): Found[] => names(path.join(claude, 'skills/synced')).flatMap((b) => skillsIn(path.join(claude, 'skills/synced', b), 'anthropic-skills:'));

const SETTINGS = /^(settings(\.local)?|hooks)\.json$/;
const tilde = (p: string, home: string): string => (within(p, home) ? `~${p.slice(home.length)}` : p);
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

/**
 * The skills and rule files the agents read here, from Claude's and Codex's own folders, ~/.agents, mission control's and
 * the repos'; the first of a name or a real path is kept.
 */
export function inventory(o: {
  homedir: string; claudeDir: string; codexDir: string; repos: string[]; homeCwd: string; reviewSkills?: string[]; isGitWithRemote: (realPath: string) => boolean;
}): Target[] {
  const claude = o.claudeDir, codex = o.codexDir;
  const roots = [o.homeCwd, ...o.repos];
  const found: Found[] = [
    ...skillsIn(path.join(claude, 'skills')), ...syncedSkills(claude), ...skillsIn(path.join(o.homedir, '.agents/skills')), ...skillsIn(path.join(codex, 'skills')),
    ...pluginSkills(claude),
    ...roots.flatMap((r) => [...skillsIn(path.join(r, '.claude/skills')), ...skillsIn(path.join(r, '.agents/skills'))]),
    ...[path.join(claude, 'CLAUDE.md'), ...rulesIn(path.join(claude, 'rules')), path.join(codex, 'AGENTS.md'),
      ...roots.flatMap((r) => [path.join(r, 'CLAUDE.md'), path.join(r, 'AGENTS.md'), ...rulesIn(path.join(r, '.claude/rules'))])]
      .map((p): Found => ({ kind: 'rule', name: tilde(p, o.homedir), path: p })),
  ];

  // a local edit to a plugin's or claude.ai's skill is overwritten at the next sync
  const synced = [path.join(claude, 'plugins'), path.join(claude, 'skills/synced')].map(realPath);
  const svall = [o.homeCwd, ...fleetHomes(o.homedir)].map(realPath);
  const classOf = (real: string): TargetClass =>
    synced.some((d) => within(real, d)) ? 'synced'
    : svall.some((d) => within(real, d)) ? 'svall'
    : SETTINGS.test(path.basename(real)) ? 'agent-settings'
    : o.isGitWithRemote(real) ? 'repo' : 'local';

  const review = new Set(o.reviewSkills);
  const ids = new Set<string>(), reals = new Set<string>();
  return found.flatMap((f): Target[] => {
    const id = `${f.kind}:${f.name}`, real = realPath(f.path);
    if (ids.has(id) || reals.has(real)) return [];
    const bytes = readFile(f.path);
    if (bytes === undefined) return [];
    ids.add(id); reals.add(real);
    const { description } = f.kind === 'skill' ? frontmatter(bytes.toString('utf8')) : {};
    return [{
      id, kind: f.kind, name: f.name, ...(description && { description }), path: f.path, realPath: real, class: classOf(real), hash: sha256(bytes),
      review: f.kind === 'skill' && (f.name.includes('review') || review.has(f.name)),
    }];
  });
}

/** The target's file as the judge reads it, its secrets masked. */
export function targetText(t: Target): string {
  return redact(fs.readFileSync(t.realPath, 'utf8'));
}

/** The targets that fit in `maxTokens` at `ratio` characters a token, the most named first; `ts` holds a target once for each note naming it. */
export function fitTargets(ts: Target[], maxTokens = 40_000, ratio: number): Target[] {
  const named = new Map<string, { t: Target; n: number }>();
  for (const t of ts) { const e = named.get(t.id); if (e) e.n++; else named.set(t.id, { t, n: 1 }); }
  let left = maxTokens;
  return [...named.values()].sort((a, b) => b.n - a.n).flatMap(({ t }) => {
    const tokens = Math.ceil(targetText(t).length / ratio);
    if (tokens > left) return [];
    left -= tokens;
    return [t];
  });
}

const remotes = new Map<string, boolean>();

/** Whether `file` is in a git repository with a remote, asked of git once per repository. */
export function isGitWithRemote(file: string): boolean {
  let root = path.dirname(file);
  while (!fs.existsSync(path.join(root, '.git'))) {
    if (root === path.dirname(root)) return false;
    root = path.dirname(root);
  }
  let has = remotes.get(root);
  if (has === undefined) {
    try { has = execFileSync('git', ['-C', root, 'remote'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''; } catch { has = false; }
    remotes.set(root, has);
  }
  return has;
}
