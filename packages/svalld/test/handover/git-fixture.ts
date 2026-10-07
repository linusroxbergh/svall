import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { emptyState, type Character, type FleetState } from '@svall/protocol';

export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/**
 * A source machine under `$1/Users/source/work`: a main checkout with a worktree nested in it, a sibling
 * worktree, a detached one, a locked one, an unused one and a registration whose folder is gone, a file://
 * submodule, a stash, and staged, modified and untracked files in every used checkout. POSIX sh, so the
 * same fixture runs here and on a remote machine.
 */
export const SEED = String.raw`set -eu
T="$1"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
: > "$GIT_CONFIG_GLOBAL"
g() { git -c user.name=Probe -c user.email=probe@example.com -c commit.gpgsign=false -c init.defaultBranch=main -c protocol.file.allow=always "$@"; }
S="$T/Users/source/work"
M="$S/demo"
mkdir -p "$S"
g init -q "$S/lib"
echo lib > "$S/lib/lib.txt"
g -C "$S/lib" add lib.txt
g -C "$S/lib" commit -qm lib
g init -q "$M"
echo hello > "$M/a.txt"
g -C "$M" add a.txt
g -C "$M" commit -qm first
for b in nested-branch sibling-branch unused-branch locked-branch; do g -C "$M" branch "$b"; done
g -C "$M" worktree add -q "$M/.claude/worktrees/nested" nested-branch
g -C "$M" worktree add -q "$S/sibling" sibling-branch
g -C "$M" worktree add -q "$S/unused" unused-branch
g -C "$M" worktree add -q --detach "$S/detached" HEAD
g -C "$M" worktree add -q "$S/locked" locked-branch
g -C "$M" worktree lock --reason 'on the desk' "$S/locked"
g -C "$M" worktree add -q -b gone-branch "$S/gone"
rm -rf "$S/gone"
g -C "$M" submodule add -q "$S/lib" sub
g -C "$M" commit -qm 'add submodule'
echo 'stash me' > "$M/stashed.txt"
g -C "$M" add stashed.txt
g -C "$M" stash push -q -m probe-stash
for c in "$M" "$M/.claude/worktrees/nested" "$S/sibling" "$S/detached" "$S/locked"; do
  echo "staged in $c" > "$c/staged.txt"
  g -C "$c" add staged.txt
  echo edited >> "$c/a.txt"
  echo junk > "$c/untracked.txt"
done
echo 'sub edit' >> "$M/sub/lib.txt"
`;

/** Where the fixture puts each checkout under a base, at the same path on both machines, and the home they share. */
export function layout(base: string) {
  const home = path.join(base, 'Users/source');
  const at = (work: string) => ({
    work,
    main: path.join(work, 'demo'),
    nested: path.join(work, 'demo/.claude/worktrees/nested'),
    sub: path.join(work, 'demo/sub'),
    sibling: path.join(work, 'sibling'),
    detached: path.join(work, 'detached'),
    locked: path.join(work, 'locked'),
    unused: path.join(work, 'unused'),
    gone: path.join(work, 'gone'),
    lib: path.join(work, 'lib'),
  });
  return { base, home, source: at(path.join(home, 'work')) };
}
export type Layout = ReturnType<typeof layout>;

/**
 * Two machines share the fixture's home, and this disk holds one of them at a time: `park` sets the tree there
 * aside under a machine's name and answers where, `unpark` puts that machine's tree back at the home.
 */
export function park(l: Layout, machine: string): string {
  const to = path.join(l.base, `parked-${machine}`);
  fs.renameSync(l.home, to);
  return to;
}
export function unpark(l: Layout, machine: string): void {
  fs.renameSync(path.join(l.base, `parked-${machine}`), l.home);
}

/** Where `p`, a path under the home, lies in the tree parked at `at`. */
export const parkedAt = (l: Layout, at: string, p: string): string => path.join(at, path.relative(l.home, p));

/** Seeds the fixture under a fresh real folder here. */
export function seedHere(made: string[]): Layout {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/svall-git-'));
  made.push(base);
  const r = spawnSync('sh', ['-s', '--', base], { input: SEED, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr}`);
  return layout(base);
}

/** The fixture's crew: one character in each used checkout and the submodule, none in the main checkout. */
export function crew(l: Layout): FleetState {
  const s = l.source;
  const state = emptyState();
  state.characters = {
    nested: char('nested', { cwd: s.nested }),
    sib: char('sib', { cwd: s.sibling, second: { cwd: s.sibling, unread: false } }),
    det: char('det', { cwd: s.detached }),
    lock: char('lock', { cwd: s.locked }),
    sub: char('sub', { cwd: s.sub }),
    // a shell at the home root, which is on both machines and so copies nothing
    plain: char('plain', { cwd: path.dirname(s.work) }),
  };
  return state;
}

export function char(id: string, o: Partial<Character>): Character {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}

/** git with the fixture's identity and without the machine's own configuration. */
export function git(base: string, cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).replace(/\n$/, '');
}
