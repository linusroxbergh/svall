import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { must } from '../handover/git-graph.js';
import type { GitRunner } from '../links/git.js';
import { applyBundle, buildBundle, fingerprintOf, isCredential, untrackedFiles } from './bundle.js';

const WORKTREES = '.claude/worktrees';

const slugOf = (s: string): string => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-');

/** A folder and branch name for a robot's worktree: its name's, else its branch's, with -2, -3 while either is taken in `main`. */
export async function worktreeSlug(name: string, branch: string, o: { main: string; git: GitRunner }): Promise<string> {
  const stem = slugOf(name) || slugOf(branch) || 'robot';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const slug = `${stem.slice(0, 40 - suffix.length).replace(/-$/, '')}${suffix}`;
    if (fs.existsSync(path.join(o.main, WORKTREES, slug))) continue;
    if ((await o.git(['show-ref', '--verify', '--quiet', `refs/heads/${slug}`], o.main)).code !== 0) return slug;
  }
}

// what a reset of main would drop uncarried: an operation under way, or edits git is told not to look at
const UNDER_WAY: Record<string, string> = { MERGE_HEAD: 'merge', CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase' };

async function refuseUncarried(main: string, git: GitRunner): Promise<void> {
  const gitDir = (await must(git, ['rev-parse', '--absolute-git-dir'], main)).trim();
  const under = Object.keys(UNDER_WAY).find((f) => fs.existsSync(path.join(gitDir, f)));
  if (under) throw new Error(`${main} is in the middle of a ${UNDER_WAY[under]}; finish or abort it first`);
  const hidden = (await must(git, ['ls-files', '-v', '-z'], main)).split('\0').find((e) => /^[a-z] /.test(e));
  if (hidden) throw new Error(`${hidden.slice(2)} in ${main} is marked assume-unchanged, so its edits would be lost; run git update-index --no-assume-unchanged on it first`);
}

// a carried file and each folder that leaves empty, up to the checkout
function remove(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel), { force: true });
  for (let d = path.dirname(rel); d !== '.' && fs.readdirSync(path.join(root, d)).length === 0; d = path.dirname(d)) fs.rmdirSync(path.join(root, d));
}

/**
 * Moves what the main checkout holds beyond its HEAD into a new worktree on a new branch `slug`, through the bundle's
 * patches and tar so staged and unstaged stay apart, and leaves main clean on its branch. The stash list is never touched.
 */
export async function convertMainCheckout(main: string, o: { git: GitRunner; slug: string }): Promise<{ root: string; branch: string }> {
  const { git, slug } = o;
  const root = path.join(main, WORKTREES, slug);
  await refuseUncarried(main, git);
  const into = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-convert-'));
  try {
    const head = (await must(git, ['rev-parse', '--verify', 'HEAD^{commit}'], main)).trim();
    // credential files git does not ignore move into the worktree too, or main would not be clean
    const carry = (await untrackedFiles(main, git)).filter(isCredential);
    const manifest = await buildBundle(main, { git, into, have: [head], carry });
    await must(git, ['worktree', 'add', '-q', '-b', slug, root, head], main);
    await applyBundle(root, into, { ...manifest, branch: slug }, git);
    // main is reset only while it still holds exactly what the worktree now does
    for (const at of [root, main]) if (await fingerprintOf(at, git) !== manifest.fingerprint) throw new Error(`${at} does not match the changes carried from ${main}`);
    // index and tracked files back to HEAD at once, staged new files included; submodule checkouts are left as they are
    await must(git, ['reset', '-q', '--hard', '--no-recurse-submodules', head], main);
    for (const u of manifest.untracked) remove(main, u.path);
    const left = (await must(git, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=dirty'], main))
      .split('\0').filter((e) => e && !e.endsWith('/'));
    if (left.length) throw new Error(`${main} still holds ${left.join(', ')} after its changes moved to ${root}`);
    return { root, branch: slug };
  } finally {
    fs.rmSync(into, { recursive: true, force: true });
  }
}
