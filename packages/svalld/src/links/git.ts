import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { trimEnd, type Repo } from '@svall/protocol';

const exec = promisify(execFile);

export async function resolveRepo(cwd: string): Promise<Repo | undefined> {
  const git = async (args: string[]) => (await exec('git', args, { cwd, timeout: 10_000, killSignal: 'SIGKILL' })).stdout.trim().split('\n');
  try {
    // one rev-parse answers the paths and the branch together; every character in the fleet asks this.
    // Before its first commit HEAD resolves to nothing, though the paths are out by then and it names a branch already
    const [root, common, dir, branch] = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir', '--abbrev-ref', 'HEAD'])
      .catch(async (e: { stdout?: string }) => {
        const paths = e.stdout?.trim().split('\n') ?? [];
        if (paths.length < 3) throw e;
        return [...paths.slice(0, 3), ...await git(['symbolic-ref', '--short', 'HEAD'])];
      });
    // only a linked worktree keeps its own git dir beside a shared common one; a submodule's two are the
    // same path inside .git/modules, where the checkout it belongs to is its own root
    const isWorktree = dir !== common;
    return { root, mainRoot: isWorktree ? path.dirname(common) : root, branch, isWorktree };
  } catch {
    return undefined;
  }
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
