import path from 'node:path';
import type { AgentKind, Repo, Robot } from '@svall/protocol';
import { realScanFs } from '../handover/manifest.js';
import { clean, holds } from '../handover/portable-path.js';
import { relocate, type Relocation } from '../handover/relocate.js';
import { sessionAdapter } from '../handover/sessions/registry.js';
import type { SessionFs } from '../handover/sessions/types.js';

/** The user home and each agent's home on the Mac (`from`) and on the worker (`to`). */
export type Homes = { user: Relocation; agent: Record<AgentKind, Relocation> };

/**
 * Where a robot's worktree, folders and transcript lie on the worker: the worktree at the same place relative to the
 * clone as to the Mac's main checkout, a folder inside the worktree at the same place inside it, and any other path
 * and the transcript by their home.
 */
export function destinationPaths(c: Robot, clone: string, homes: Homes): {
  root: string; cwd: string; second?: string; transcriptPath?: string; panePath?: string; repo: Repo;
} {
  const { root: from, mainRoot } = c.repo ?? { root: c.cwd, mainRoot: c.cwd };
  const [src, main, dest] = [clean(from), clean(mainRoot), clean(clone)];
  const root = holds(main, src) ? path.posix.join(dest, path.posix.relative(main, src)) : relocate(src, homes.user);
  const place = (p: string): string => (holds(src, clean(p)) ? path.posix.join(root, path.posix.relative(src, clean(p))) : relocate(p, homes.user));
  const t = c.agent?.transcriptPath;
  return {
    root,
    cwd: place(c.cwd),
    ...(c.second && { second: place(c.second.cwd) }),
    ...(t && c.agent && { transcriptPath: relocate(t, homes.agent[c.agent.kind]) }),
    ...(c.panePath && { panePath: place(c.panePath) }),
    repo: { root, mainRoot: dest, branch: c.repo?.branch ?? '', isWorktree: c.repo?.isWorktree ?? false },
  };
}

/** The agent home a robot's session lies in on the source and its files relative to it, which land at the same place under the destination's. */
export async function sessionLanding(c: Robot, fs: SessionFs = realScanFs): Promise<{ sourceHome: string; files: string[] }> {
  const a = c.agent;
  if (!a?.transcriptPath) return { sourceHome: '', files: [] };
  const { home, files } = await sessionAdapter(a.kind).discover(a.transcriptPath, a.sessionId, fs);
  return { sourceHome: home, files };
}
