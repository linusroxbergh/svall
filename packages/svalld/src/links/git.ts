import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { trimEnd, type Repo } from '@svall/protocol';

const exec = promisify(execFile);

export type GitResult = { code: number; stdout: string; stderr: string };
/** Runs one git command in `cwd`. A git that cannot start or runs out of time answers a non-zero code. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

// variables that would point git at another repository than the one around cwd
const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];

/** git as a reader beside the user's own: messages in English, and no index refresh that takes its lock. */
export function gitRunner(timeoutMs = 300_000, killSignal: NodeJS.Signals = 'SIGTERM'): GitRunner {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of REDIRECTS) delete env[k];
  return (args, cwd) => new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code, signal) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString(),
      stderr: signal ? `git ${args[0]} stopped by ${signal}` : Buffer.concat(err).toString(),
    }));
  });
}

export const runGit: GitRunner = gitRunner();

/** A checkout's top, the Git directory its worktrees share and its own, each absolute and real. */
export type GitDirs = { root: string; commonDir: string; gitDir: string };

export const DIRS_ARGS = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'] as const;

export function parseDirs(stdout: string): GitDirs {
  const [root, commonDir, gitDir] = stdout.replace(/\n$/, '').split('\n');
  return { root, commonDir, gitDir };
}

// every character in the fleet asks this, so a git that hangs is killed after ten seconds
const quickGit: GitRunner = gitRunner(10_000, 'SIGKILL');

export async function resolveRepo(cwd: string, git: GitRunner = quickGit): Promise<Repo | undefined> {
  // one rev-parse answers the paths and the branch together. Before its first commit HEAD resolves to nothing,
  // though the paths are out by then and it names a branch already
  const r = await git([...DIRS_ARGS, '--abbrev-ref', 'HEAD'], cwd);
  let branch = r.stdout.replace(/\n$/, '').split('\n')[3];
  if (r.code !== 0) {
    if (r.stdout.trim().split('\n').length < 3) return undefined;
    const head = await git(['symbolic-ref', '--short', 'HEAD'], cwd);
    if (head.code !== 0) return undefined;
    branch = head.stdout.trim();
  }
  const { root, commonDir, gitDir } = parseDirs(r.stdout);
  // only a linked worktree keeps its own git dir beside a shared common one; a submodule's two are the
  // same path inside .git/modules, where the checkout it belongs to is its own root
  const isWorktree = gitDir !== commonDir;
  return { root, mainRoot: isWorktree ? path.dirname(commonDir) : root, branch, isWorktree };
}

// the browsable url behind a remote: scp-style and url-style both land on https, without the .git.
// the parser drops any credential the remote carries, so a token never reaches the state or the rail
export function webUrl(remote: string): string | undefined {
  const r = trimEnd(remote.trim(), '/').replace(/\.git$/, '');
  // the scp shape has no scheme, so it is rewritten to one before the url parser reads it
  const scp = /^(?!\w+:\/\/)(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(r);
  try {
    const u = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : r);
    return /^(https?|ssh|git):$/.test(u.protocol) ? `https://${u.hostname}${u.pathname}` : undefined;
  } catch { return undefined; }
}

export async function originUrl(cwd: string): Promise<string | undefined> {
  try { return webUrl((await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 10_000, killSignal: 'SIGKILL' })).stdout); }
  catch { return undefined; }
}
