#!/usr/bin/env node
// An M0 spike probe (docs/fleet-handover/spike-results.md). Manual: running it by hand on a fleet's copied checkouts.
// The svalld suite runs its functions on the repositories packages/svalld/test/handover/worktree-portability.test.ts builds.

// A probe for moving a fleet's Git checkouts to another machine under a different home prefix.
// It touches the destination copy only. Measured against git 2.55.0 by
// packages/svalld/test/handover/worktree-portability.test.ts:
// - `git worktree repair <mapped paths>` fixes both the worktree's `.git` gitfile and the
//   registration's `gitdir` file, so rewriting them first is belt and braces, not a requirement.
// - `git worktree repair` with no paths fixes nothing: every registration still names the source.
// - A registration the manifest omits makes repair follow it to the source machine and rewrite that
//   checkout's `.git`, so those registrations come out before the repair runs.
// - `git worktree prune` is the wrong tool for that: at this point no registration resolves yet, so
//   it removes every transferred one too.
// - refs/stash and the branch refs of dropped registrations live in the common dir and travel with it.
// - A submodule's `.git` gitfile and its `core.worktree` are relative, so it needs no rewrite.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');

// a linked worktree keeps its own git dir beside the shared common one; a submodule's two are the
// same path under the superproject's .git/modules, which makes it a graph of its own
export function discoverGraph(cwd) {
  const [root, commonDir, gitDir] = git(cwd, 'rev-parse', '--path-format=absolute',
    '--show-toplevel', '--git-common-dir', '--git-dir').split('\n');
  return { root, commonDir, gitDir, isWorktree: gitDir !== commonDir };
}

export function listWorktrees(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).map((block) => {
    const entry = { path: '', head: '', branch: null, prunable: false };
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? '' : line.slice(space + 1);
      if (key === 'worktree') entry.path = value;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value;
      else if (key === 'prunable') entry.prunable = true;
    }
    return entry;
  });
}

export function snapshotCheckout(cwd) {
  const stash = git(cwd, 'stash', 'list');
  return {
    head: git(cwd, 'rev-parse', 'HEAD'),
    status: git(cwd, 'status', '--porcelain=v2', '--branch'),
    index: git(cwd, 'ls-files', '-s'),
    staged: git(cwd, 'diff', '--cached', '--name-status'),
    stash,
    stashRef: stash ? git(cwd, 'rev-parse', 'refs/stash') : null,
  };
}

// the gitfile of a linked worktree reads `gitdir: <common>/worktrees/<id>`; the id survives a copy
function registrationId(worktreePath) {
  const gitfile = path.join(worktreePath, '.git');
  const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitfile, 'utf8'));
  if (!named) throw new Error(`Not a linked worktree: ${worktreePath}`);
  return path.basename(named[1].trim());
}

export function reconstruct({ mainRoot, worktrees }) {
  const main = discoverGraph(mainRoot);
  if (main.isWorktree) throw new Error(`Expected a main checkout, got a linked worktree: ${mainRoot}`);
  const registrations = path.join(main.commonDir, 'worktrees');
  if (worktrees.length === 0) throw new Error('Refusing to prune every registration: name the worktrees to keep');
  const kept = new Map(worktrees.map((worktree) => {
    const target = path.resolve(worktree);
    return [registrationId(target), target];
  }));

  const pruned = [];
  for (const id of fs.existsSync(registrations) ? fs.readdirSync(registrations) : []) {
    if (kept.has(id)) continue;
    fs.rmSync(path.join(registrations, id), { recursive: true, force: true });
    pruned.push(id);
  }

  const rewritten = [];
  for (const [id, target] of kept) {
    const registration = path.join(registrations, id);
    if (!fs.existsSync(registration)) throw new Error(`No registration "${id}" under ${registrations}`);
    fs.writeFileSync(path.join(target, '.git'), `gitdir: ${registration}\n`);
    fs.writeFileSync(path.join(registration, 'gitdir'), `${path.join(target, '.git')}\n`);
    rewritten.push(target);
  }

  const repaired = [...kept.values()];
  const repair = spawnSync('git', ['-C', main.root, 'worktree', 'repair', ...repaired], { encoding: 'utf8' });
  if (repair.status !== 0) throw new Error(repair.stderr.trim() || 'git worktree repair failed');
  return { commonDir: main.commonDir, rewritten, pruned, repaired, repairReport: repair.stderr.trim() };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mainRoot, ...worktrees] = process.argv.slice(2);
  if (!mainRoot) {
    process.stderr.write('Usage: node scripts/spikes/probe-worktree-handover.mjs <destination-main-checkout> [<destination-worktree>...]\n');
    process.exitCode = 2;
  } else {
    try {
      const report = reconstruct({ mainRoot, worktrees });
      const checkouts = Object.fromEntries([mainRoot, ...report.repaired]
        .map((checkout) => [checkout, snapshotCheckout(checkout)]));
      process.stdout.write(`${JSON.stringify({ ...report, worktrees: listWorktrees(mainRoot), checkouts }, null, 2)}\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
