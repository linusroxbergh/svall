import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { ChangedFile, DiffBase } from '@svall/protocol';

export type GitResult = { code: number; stdout: Buffer };

// a git that hangs on a lock or a credential prompt would hold its caller for good
const TIMEOUT_MS = 10_000;

export function git(args: string[], cwd: string, input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`git ${args[0]} timed out after ${TIMEOUT_MS}ms`)); }, TIMEOUT_MS);
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) }); });
    // a git that refuses at once never reads its input; the exit code says what happened
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

const lines = (out: Buffer): string[] => out.toString().split('\0').filter(Boolean);

/** The names in `dir` git ignores; none outside a repository. */
export async function ignoredNames(dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const r = await git(['check-ignore', '--stdin', '-z'], dir, names.join('\0') + '\0');
  // 0 some matched, 1 none did, 128 no repository or other refusal
  return new Set(r.code === 0 ? lines(r.stdout) : []);
}

/** Whether `root` is the top of a git working tree; below it, diff and ls-files count their paths from different places. */
export async function isTop(root: string): Promise<boolean> {
  const r = await git(['rev-parse', '--show-toplevel'], root);
  return r.code === 0 && fs.realpathSync(r.stdout.toString().trim()) === fs.realpathSync(root);
}

// HEAD names a branch before it has a commit, which rev-parse cannot resolve; a detached one names none
export async function branchOf(root: string): Promise<string | undefined> {
  const r = await git(['symbolic-ref', '-q', '--short', 'HEAD'], root);
  if (r.code === 0) return r.stdout.toString().trim();
  return r.code === 1 ? 'HEAD' : undefined;
}

// origin's HEAD when the clone knows it, else a local main or master
async function defaultBranch(root: string): Promise<string | undefined> {
  const origin = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], root);
  if (origin.code === 0) return origin.stdout.toString().trim();
  for (const name of ['main', 'master']) {
    if ((await git(['rev-parse', '-q', '--verify', name], root)).code === 0) return name;
  }
  return undefined;
}

/** HEAD, or for `main` the merge-base with the default branch; HEAD again when there is none. */
export async function baseRef(root: string, base: DiffBase): Promise<string> {
  if (base === 'head') return 'HEAD';
  const branch = await defaultBranch(root);
  if (!branch) return 'HEAD';
  const mb = await git(['merge-base', branch, 'HEAD'], root);
  return mb.code === 0 ? mb.stdout.toString().trim() : 'HEAD';
}

/** The working tree against `ref`, renames detected, plus untracked files as `?`; sorted by path. */
export async function changedFiles(root: string, ref: string): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  const diff = await git(['diff', '--name-status', '-z', '-M', ref], root);
  // an unborn HEAD has nothing to diff against: everything is untracked
  const parts = diff.code === 0 ? diff.stdout.toString().split('\0') : [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const s = parts[i][0];
    if (s === 'R' || s === 'C') { files.push({ path: parts[i + 2], status: 'R', from: parts[i + 1] }); i += 3; }
    else { files.push({ path: parts[i + 1], status: s === 'A' || s === 'D' ? s : 'M' }); i += 2; }
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  for (const p of lines(untracked.stdout)) files.push({ path: p, status: '?' });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The file's size at `ref`, or undefined when it was not there. */
export async function sizeAt(root: string, ref: string, rel: string): Promise<number | undefined> {
  const r = await git(['cat-file', '-s', `${ref}:${rel}`], root);
  return r.code === 0 ? Number(r.stdout.toString()) : undefined;
}

/** The file's bytes at `ref`, or undefined when it was not there. */
export async function fileAt(root: string, ref: string, rel: string): Promise<Buffer | undefined> {
  const r = await git(['show', `${ref}:${rel}`], root);
  return r.code === 0 ? r.stdout : undefined;
}
