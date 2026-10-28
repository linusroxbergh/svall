import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ApiError, ObjectName, Sha256 } from '@svall/protocol';
import { byCodeUnit, canonicalDigest, hashStream, sha256Hex } from '../hash.js';
import { must, type GitRunner } from '../links/git.js';

const exec = promisify(execFile);

export const CREDENTIAL_PATTERNS = ['.env*', '*.pem', 'id_rsa*', '*.tfvars', '*.key', '.netrc'];
const CREDENTIAL = CREDENTIAL_PATTERNS.map((p) => new RegExp(`^${p.replaceAll('.', '\\.').replaceAll('*', '.*')}$`));

export const isCredential = (p: string): boolean => CREDENTIAL.some((re) => re.test(path.posix.basename(p)));

export const BUNDLE_MAX = 100 * 1024 * 1024;

export class BundleTooLarge extends Error {}

export const BundleManifest = z.object({
  base: ObjectName,
  branch: z.string(),
  staged: Sha256,
  unstaged: Sha256,
  untracked: z.array(z.object({ path: z.string(), mode: z.number().int(), size: z.number().int().nonnegative(), sha256: Sha256 })),
  commits: z.object({ count: z.number().int().positive(), prerequisites: z.array(ObjectName) }).optional(),
  credentialFiles: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
  fingerprint: Sha256,
});
export type BundleManifest = z.infer<typeof BundleManifest>;

const [STAGED, UNSTAGED, UNTRACKED, COMMITS, MANIFEST] = ['staged.patch', 'unstaged.patch', 'untracked.tar', 'commits.bundle', 'manifest.json'];
const CARRIED = [STAGED, UNSTAGED, UNTRACKED, COMMITS];

// a patch git applies whatever prefixes, colors or external diff tools this machine's config names
const PATCH = ['--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '--ignore-submodules=dirty'];
// tracked changes by modes and object names in git's own order, never patch text, which another machine's git, zlib or
// diff.orderFile may write otherwise
const RAW = ['--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=dirty', '-O/dev/null'];

const fileSha = async (file: string): Promise<string> => (await hashStream(fs.createReadStream(file))).sha256;

const contentSha = async (file: string, st: fs.Stats): Promise<string> =>
  (st.isSymbolicLink() ? sha256Hex(fs.readlinkSync(file, { encoding: 'buffer' })) : fileSha(file));

const bytesIn = (dir: string): number =>
  CARRIED.reduce((n, f) => n + (fs.statSync(path.join(dir, f), { throwIfNoEntry: false })?.size ?? 0), 0);

function refuseOver(root: string, bytes: number): void {
  if (bytes > BUNDLE_MAX) throw new BundleTooLarge(`${root}: its changes and commits come to ${(bytes / 2 ** 20).toFixed(1)} MB, over the ${BUNDLE_MAX / 2 ** 20} MB a move carries`);
}

/** Whether ustar holds `name`: one of 100 bytes, or one a slash splits into 155 and 100; bsdtar leaves any other out with a warning and exit 0. */
export const ustarFits = (name: Buffer): boolean => name.length <= 100 || name.some((b, at) => b === 0x2f && at <= 155 && name.length - at - 1 <= 100);

// ustar holds a link target of 100 bytes and the names ustarFits takes
function refuseUnpackable(root: string, paths: readonly string[], stats: readonly fs.Stats[]): void {
  for (const [i, p] of paths.entries()) {
    if (!ustarFits(Buffer.from(`./${p}`))) {
      throw new Error(`${p} has a path too long for a move to carry; rename or ignore it first`);
    }
    if (stats[i].isSymbolicLink() && fs.readlinkSync(path.join(root, p), { encoding: 'buffer' }).length > 100) {
      throw new Error(`${p} links to a target too long for a move to carry; point it closer or ignore it first`);
    }
  }
}

/** The untracked files git does not ignore, less nested repositories and worktrees, which git lists as folders. */
export async function untrackedFiles(root: string, git: GitRunner): Promise<string[]> {
  return (await must(git, ['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter((p) => p && !p.endsWith('/'));
}

// untracked files named like credentials, ignored ones too, but none inside a folder git ignores whole
export async function credentialsIn(root: string, git: GitRunner, listed: readonly string[]): Promise<string[]> {
  const ignored = (await must(git, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], root)).split('\0');
  return [...listed, ...ignored].filter((p) => p && !p.endsWith('/') && isCredential(p)).sort(byCodeUnit);
}

// the index and working tree against HEAD, and the untracked files but credentials, all by content; with `head`, those of a
// new worktree at HEAD, which holds none
async function digest(root: string, git: GitRunner, untracked: readonly { path: string; sha256: string }[], head = false): Promise<string> {
  const index = head ? '' : await must(git, ['diff', '--cached', ...RAW], root);
  const fields = head ? [] : (await must(git, ['diff', ...RAW], root)).split('\0');
  const worktree: (string | null)[][] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const file = path.join(root, fields[i + 1]);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    worktree.push([fields[i], fields[i + 1], st && !st.isDirectory() ? await contentSha(file, st) : null]);
  }
  const files = untracked.filter((u) => !isCredential(u.path)).map((u) => [u.path, u.sha256]).sort(([a], [b]) => byCodeUnit(a, b));
  return canonicalDigest({ index: sha256Hex(index), worktree, untracked: files });
}

/** What a worktree holds beyond its HEAD, the same on any machine holding the same index, working tree and untracked files but credentials. */
export async function fingerprintOf(root: string, git: GitRunner): Promise<string> {
  const untracked: { path: string; sha256: string }[] = [];
  for (const p of (await untrackedFiles(root, git)).filter((f) => !isCredential(f))) {
    const file = path.join(root, p);
    untracked.push({ path: p, sha256: await contentSha(file, fs.lstatSync(file)) });
  }
  return digest(root, git, untracked);
}

// the branch's commits past every commit of the worker's shas this machine holds too, as the worker holds each with its
// history; with none, past the merge base with origin's default branch, else all
async function bundleCommits(root: string, git: GitRunner, ref: string, base: string, have: readonly string[], file: string): Promise<BundleManifest['commits']> {
  const shas = [...new Set(have)].filter((h) => ObjectName.safeParse(h).success);
  const known = shas.length ? (await must(git, ['rev-list', '--no-walk', '--ignore-missing', ...shas, '--'], root)).split('\n').filter(Boolean) : [];
  if (!known.length) {
    const r = await git(['merge-base', base, 'refs/remotes/origin/HEAD'], root);
    if (r.code === 0) known.push(r.stdout.trim());
  }
  const not = known.map((h) => `^${h}`);
  const listed = (await must(git, ['rev-list', '--boundary', base, ...not, '--'], root)).split('\n').filter(Boolean);
  const count = listed.filter((l) => !l.startsWith('-')).length;
  if (!count) return undefined;
  await must(git, ['bundle', 'create', file, ref, ...not], root);
  return { count, prerequisites: listed.filter((l) => l.startsWith('-')).map((l) => l.slice(1)) };
}

// ustar, which bsdtar and GNU tar both write and read with modes and links; ./ keeps a name from reading as an option,
// and COPYFILE_DISABLE keeps macOS tar from adding ._ entries
export async function packTar(root: string, paths: readonly string[], file: string): Promise<void> {
  const list = `${file}.list`;
  fs.writeFileSync(list, paths.map((p) => `./${p}\0`).join(''));
  try {
    await exec('tar', ['-c', '-f', file, '--format=ustar', '--null', '--no-recursion', '-T', list], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  } finally {
    fs.rmSync(list, { force: true });
  }
}

/**
 * Writes into `into` both patches, the untracked files git does not ignore (credential files only as `carry` names them),
 * the commits past `have`, the worker's shas, and the manifest; with `head`, as a new worktree at HEAD would: the commits alone.
 */
export async function buildBundle(root: string, o: { git: GitRunner; into: string; have: string[]; carry: string[]; head?: boolean }): Promise<BundleManifest> {
  const { git, into } = o;
  const at = (f: string): string => path.join(into, f);
  const base = (await must(git, ['rev-parse', '--verify', 'HEAD^{commit}'], root)).trim();
  const ref = (await must(git, ['symbolic-ref', 'HEAD'], root)).trim();
  fs.mkdirSync(into, { recursive: true });
  for (const f of [...CARRIED, MANIFEST]) fs.rmSync(at(f), { force: true });
  if (o.head) for (const f of [STAGED, UNSTAGED]) fs.writeFileSync(at(f), '');
  else {
    await must(git, ['diff', ...PATCH, '--cached', `--output=${at(STAGED)}`], root);
    await must(git, ['diff', ...PATCH, `--output=${at(UNSTAGED)}`], root);
  }
  const listed = o.head ? [] : await untrackedFiles(root, git);
  const credentialFiles = o.head ? [] : await credentialsIn(root, git, listed);
  const ticked = new Set(o.carry);
  const paths = [...listed.filter((p) => !isCredential(p)), ...credentialFiles.filter((p) => ticked.has(p))].sort(byCodeUnit);
  const stats = paths.map((p) => fs.lstatSync(path.join(root, p)));
  refuseUnpackable(root, paths, stats);
  const commits = await bundleCommits(root, git, ref, base, o.have, at(COMMITS));
  // refused before any file is hashed or packed, then once more with the tar's own headers counted
  refuseOver(root, bytesIn(into) + stats.reduce((n, s) => n + s.size, 0));
  const untracked: BundleManifest['untracked'] = [];
  for (const [i, p] of paths.entries()) {
    untracked.push({ path: p, mode: stats[i].mode, size: stats[i].size, sha256: await contentSha(path.join(root, p), stats[i]) });
  }
  if (paths.length) await packTar(root, paths, at(UNTRACKED));
  const bytes = bytesIn(into);
  refuseOver(root, bytes);
  const manifest: BundleManifest = {
    base, branch: ref.replace(/^refs\/heads\//, ''), staged: await fileSha(at(STAGED)), unstaged: await fileSha(at(UNSTAGED)),
    untracked, commits, credentialFiles, bytes, fingerprint: await digest(root, git, untracked, o.head),
  };
  fs.writeFileSync(at(MANIFEST), JSON.stringify(manifest));
  return manifest;
}

/** Throws unless `dir` holds the patches the manifest names and the bytes it counts. */
export async function verifyBundle(dir: string, manifest: BundleManifest): Promise<void> {
  for (const [f, want] of [[STAGED, manifest.staged], [UNSTAGED, manifest.unstaged]]) {
    if (await fileSha(path.join(dir, f)) !== want) throw new Error(`${path.join(dir, f)} is not the patch the move's manifest names`);
  }
  const bytes = bytesIn(dir);
  if (bytes !== manifest.bytes) throw new Error(`${dir} holds ${bytes} bytes, not the ${manifest.bytes} the move's manifest counts`);
}

// the paths a patch writes that the index lacks; -z leaves them unquoted
async function createdBy(patch: string, root: string, git: GitRunner): Promise<string[]> {
  const numstat = (await must(git, ['apply', '--numstat', '-z', patch], root)).split('\0');
  const written = numstat.flatMap((f) => /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(f)?.[1] ?? []);
  const indexed = new Set((await must(git, ['ls-files', '-z'], root)).split('\0'));
  return written.filter((p) => !indexed.has(p));
}

export const branchAhead = (machine: string, name: string) => ({ reason: `${machine} has a branch ${name} with commits this one lacks`, action: 'merge or rename it there first' });

/** Whether `sha`, the tip of a branch the move would reset, is `head` or behind it, as only then does the move lose nothing of it. */
export const holdsWhole = async (sha: string, head: string, root: string, git: GitRunner): Promise<boolean> =>
  (await git(['merge-base', '--is-ancestor', sha, head], root)).code === 0;

// Puts a bundle into the worktree at `root`: its commits under the branch, both patches, the untracked files; throws unless
// that is what left. A branch of its name on `machine` that holds commits the bundle's lacks is refused, but at `keep`.
export async function applyBundle(root: string, dir: string, manifest: BundleManifest, git: GitRunner, o: { machine?: string; keep?: string } = {}): Promise<void> {
  const at = (f: string): string => path.join(dir, f);
  if (manifest.commits) await must(git, ['bundle', 'unbundle', at(COMMITS)], root);
  const held = (await git(['rev-parse', '--verify', '-q', `refs/heads/${manifest.branch}^{commit}`], root)).stdout.trim();
  if (held && held !== o.keep && !await holdsWhole(held, manifest.base, root, git)) {
    const f = branchAhead(o.machine ?? 'this machine', manifest.branch);
    throw new ApiError('refused', `${f.reason}; ${f.action}`, { refusal: { ...f, details: [] } });
  }
  await must(git, ['checkout', '-q', '--no-recurse-submodules', '-B', manifest.branch, manifest.base], root);
  if (fs.statSync(at(STAGED)).size) await must(git, ['apply', '--index', '--whitespace=nowarn', at(STAGED)], root);
  // a new file in the unstaged patch was added with intent to add, which `git add -N` restores; `git apply -N` would
  // empty the rest of the index on the git Ubuntu 24.04 ships (2.43)
  if (fs.statSync(at(UNSTAGED)).size) {
    const created = await createdBy(at(UNSTAGED), root, git);
    await must(git, ['apply', '--whitespace=nowarn', at(UNSTAGED)], root);
    if (created.length) await must(git, ['--literal-pathspecs', 'add', '--intent-to-add', '--force', '--', ...created], root);
  }
  if (manifest.untracked.length) await exec('tar', ['-x', '-p', '--no-same-owner', '-f', at(UNTRACKED), '-C', root]);
  for (const u of manifest.untracked) {
    const file = path.join(root, u.path);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st || await contentSha(file, st) !== u.sha256) throw new Error(`${file} did not unpack as it left`);
    // a link's own permissions differ between macOS and Linux, so only its type is compared
    const [got, want] = st.isSymbolicLink() ? [st.mode & 0o170000, u.mode & 0o170000] : [st.mode, u.mode];
    if (got !== want) throw new Error(`${file} unpacked with mode ${got.toString(8)}, not the ${want.toString(8)} it left with`);
  }
  // the untracked files by the manifest's list, which this machine's ignore rules may read otherwise
  if (await digest(root, git, manifest.untracked) !== manifest.fingerprint) throw new Error(`${root} does not hold what the move carried`);
}

/** The credential files the bundle carries as tracked changes or in its commits, which no tick can leave behind; `head` as buildBundle's. */
export async function trackedCredentials(root: string, git: GitRunner, manifest: BundleManifest, o: { head?: boolean } = {}): Promise<string[]> {
  const names = async (args: string[]): Promise<string[]> => (await must(git, args, root)).split('\0');
  const touched = [
    ...(o.head ? [] : [...await names(['diff', '--cached', '--name-only', '-z', '--no-renames']), ...await names(['diff', '--name-only', '-z', '--no-renames'])]),
    ...(manifest.commits
      ? await names(['log', '--no-show-signature', '--format=', '--name-only', '-z', '--no-renames', manifest.base, ...manifest.commits.prerequisites.map((p) => `^${p}`), '--'])
      : []),
  ];
  return [...new Set(touched)].filter((p) => p && isCredential(p)).sort(byCodeUnit);
}
