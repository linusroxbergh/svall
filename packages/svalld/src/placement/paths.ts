import path from 'node:path';
import type { AgentKind, Repo, Robot } from '@svall/protocol';
import { realScanFs } from '../handover/manifest.js';
import { clean, holds } from '../handover/portable-path.js';
import { relocate, type Relocation } from '../handover/relocate.js';
import { sessionAdapter } from '../handover/sessions/registry.js';
import type { SessionFs } from '../handover/sessions/types.js';

/** The user home and each agent's home on the Mac (`from`) and on the worker (`to`). */
export type Homes = { user: Relocation; agent: Record<AgentKind, Relocation> };

/** Where a robot's worktree, folders and transcripts lie on the worker: inside the worktree at the same place relative to the clone, anywhere else by home. */
export function destinationPaths(c: Robot, clone: string, homes: Homes): {
  root: string; cwd: string; second?: string; transcriptPath?: string; secondTranscriptPath?: string; panePath?: string; repo?: Repo;
} {
  const transcript = (a: Robot['agent']): string | undefined => a?.transcriptPath ? relocate(a.transcriptPath, homes.agent[a.kind]) : undefined;
  const [t, t2] = [transcript(c.agent), transcript(c.second?.agent)];
  const tail = {
    ...(t && { transcriptPath: t }),
    ...(t2 && { secondTranscriptPath: t2 }),
  };
  if (!c.repo) {
    const user = (p: string): string => relocate(p, homes.user);
    return { root: user(c.cwd), cwd: user(c.cwd), ...(c.second && { second: user(c.second.cwd) }), ...(c.panePath && { panePath: user(c.panePath) }), ...tail };
  }
  const [src, main, dest] = [clean(c.repo.root), clean(c.repo.mainRoot), clean(clone)];
  const root = holds(main, src) ? path.posix.join(dest, path.posix.relative(main, src)) : relocate(src, homes.user);
  const place = (p: string): string => (holds(src, clean(p)) ? path.posix.join(root, path.posix.relative(src, clean(p))) : relocate(p, homes.user));
  return {
    root,
    cwd: place(c.cwd),
    ...(c.second && { second: place(c.second.cwd) }),
    ...(c.panePath && { panePath: place(c.panePath) }),
    ...tail,
    repo: { ...c.repo, root, mainRoot: dest },
  };
}

/** The agent home a robot's session lies in on the source and its files relative to it, which land at the same place under the destination's. */
export async function sessionLanding(c: Robot, fs: SessionFs = realScanFs): Promise<{ sourceHome: string; files: string[] }> {
  const a = c.agent;
  if (!a?.transcriptPath) return { sourceHome: '', files: [] };
  const { home, files } = await sessionAdapter(a.kind).discover(a.transcriptPath, a.sessionId, fs);
  return { sourceHome: home, files };
}
