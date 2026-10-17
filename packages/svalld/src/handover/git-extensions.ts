import type { Blocker, HandoverEntity } from '@svall/protocol';
import { runGit, type GitRunner } from '../links/git.js';

// the first git that opens a repository using each extension; one missing here needs the git that opened it on the source
const INTRODUCED: Record<string, string> = {
  noop: '0.0.0',
  preciousobjects: '2.7.0',
  worktreeconfig: '2.20.0',
  partialclone: '2.22.0',
  objectformat: '2.29.0',
  refstorage: '2.45.0',
  relativeworktrees: '2.48.0',
};

/** A carried repository's format version and extensions, names lowercased as git reads them. */
export type GraphExtensions = { id: string; commonDir: string; version: number; extensions: Record<string, string> };

const numbers = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);

function older(a: string, b: string): boolean {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** `git --version`'s number, or nothing where git cannot run. */
export async function gitVersion(git: GitRunner = runGit): Promise<string | undefined> {
  const r = await git(['--version'], '/');
  return r.code === 0 ? /(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] : undefined;
}

/** What a repository's own config file says about the git that can open it. */
export async function readExtensions(commonDir: string, git: GitRunner = runGit): Promise<Pick<GraphExtensions, 'version' | 'extensions'>> {
  // exit 1 is a config that sets none of them
  const r = await git(['config', '--file', 'config', '--get-regexp', '^(core\\.repositoryformatversion|extensions\\..*)$'], commonDir);
  const read = { version: 0, extensions: {} as Record<string, string> };
  for (const line of r.code === 0 ? r.stdout.split('\n') : []) {
    const [key, ...value] = line.split(' ');
    if (key === 'core.repositoryformatversion') read.version = Number.parseInt(value.join(' '), 10) || 0;
    else if (key.startsWith('extensions.')) read.extensions[key.slice('extensions.'.length)] = value.join(' ');
  }
  return read;
}

/**
 * Each carried repository the destination's git cannot open. Only a repository at format version 1 or later
 * has its extensions read, and a git refuses one it does not know.
 */
export function extensionBlockers(graphs: readonly GraphExtensions[], git: { destination?: string; source?: string }): Blocker[] {
  const out: Blocker[] = [];
  for (const g of graphs) {
    const entity: HandoverEntity = { kind: 'git', id: g.id };
    if (!git.destination) {
      out.push({ code: 'git_extension', message: `the destination reported no git, and ${g.commonDir} is carried as a Git repository`, entity });
      continue;
    }
    if (g.version < 1) continue;
    for (const name of Object.keys(g.extensions).sort()) {
      const needs = INTRODUCED[name] ?? git.source;
      if (needs && !older(git.destination, needs)) continue;
      const which = needs ? `git ${needs} or newer` : 'a git that knows it';
      out.push({ code: 'git_extension', message: `${g.commonDir} uses the Git extension ${name}, which needs ${which}, and the destination runs git ${git.destination}`, entity });
    }
  }
  return out;
}
