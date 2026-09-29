export interface Graph { root: string; commonDir: string; gitDir: string; isWorktree: boolean }
export interface WorktreeEntry { path: string; head: string; branch: string | null; prunable: boolean }
export interface Snapshot {
  head: string; status: string; index: string; staged: string; stash: string; stashRef: string | null;
}
export interface Reconstruction {
  commonDir: string; rewritten: string[]; pruned: string[]; repaired: string[]; repairReport: string;
}

export function discoverGraph(cwd: string): Graph;
export function listWorktrees(cwd: string): WorktreeEntry[];
export function snapshotCheckout(cwd: string): Snapshot;
export function reconstruct(input: { mainRoot: string; worktrees: string[] }): Reconstruction;
