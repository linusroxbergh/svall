# Follow-up 21b — path roots through symlinks, and the handover.json read

Small follow-up on Tasks 21 and 25, found by their reviews. Both already on fleet-handover-impl.

## 1. A path root declared through a symlink blocks every repository under it
`discoverGit` (packages/archid/src/handover/git-graph.ts) reports real paths (e.g. /private/tmp/…, /Volumes/work/code/…), while `buildInventory` (packages/archid/src/handover/inventory.ts) places graph paths against the declared path roots lexically. So a path root declared through a symlink — /tmp on macOS, or a `~/code` that links to /Volumes/work/code — blocks every repository under it (`path_root_missing`/unmapped). Fails closed, but it blocks real layouts.
Required outcome: a graph path is placed under the path root whose real path contains it, and the destination path is mapped from the declared root (the manifest keeps declared, portable paths — never leak the source's real-path spelling into destination paths). Paths that are not under any root by real path still block. Tests: a root declared through a symlink (macOS /tmp is a natural fixture) carries its repository; a repo outside every root still blocks. Check `divergence.ts`/`replicas.ts` and the manifest for the same lexical-vs-real mismatch only where a test shows it; don't refactor beyond that.

## 2. The `.archipelago/handover.json` read (packages/archid/src/handover/source.ts:85–87)
- It follows symlinks and reads without a limit: a FIFO there hangs the pre-rest check while the fleet is frozen (Abort queues behind it); a link out of the root is judged while the link itself is carried. Fix: lstat; require a regular, non-link file; cap the read (64 KiB); anything else is a `platform_unsupported` blocker naming the file.
- A regular file named `.archipelago` at a repository root raises a false `ENOTDIR` blocker. Treat ENOTDIR like ENOENT (no handover file).
Tests for the FIFO/link/oversize/ENOTDIR cases.
