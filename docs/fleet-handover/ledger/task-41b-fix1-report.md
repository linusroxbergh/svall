# Task 41b fix round 1 — report

Branch `experimental-remote-sessions`, FIX_BASE 5f62409e, commits 5f62409e..b4442350 (five, not pushed). Uncommitted:
this report.

| Commit | Item |
| --- | --- |
| 2d92cec7 | I2, M1 |
| 95796f66 | M2 |
| d0e91455 | I1 |
| 9406e40b | M4 |
| b4442350 | M3 |

## Per item

**I1** (`sessions/claude.ts`)
- The sidecar whitelist is gone. `discover` carries every regular file under `projects/<slug>/<id>/`.
- `carries` accepts the transcript or any path under that folder.
- `filesUnder` still refuses links, non-regular entries and names it cannot carry, and `installSession` still refuses
  `..` and absolute paths.
- `file-history/<id>` and `session-env/<id>` sit outside the folder and still stay.
- Tests:
  - The discovery refusal test is now "finds every file of the session's own folder, whatever kind a release writes
    there". Four strays: a top-level `.txt`, `notes/plan.md`, `subagents/*.json`, a nested `tool-results/p1/*.jpg`.
  - The manifest blocker test is now "carries a file of a kind no release so far wrote in the session's folder, byte
    for byte". It runs manifest, stage and install, then compares the bytes.
  - `notes.md` is off the install refusal list.
  - cli `handover.test.ts` printed a sample blocker ("holds notes.bin, which … does not carry") that the adapter can
    no longer produce. It now prints the floor blocker, which can still happen.

**I2** (`git-import.ts`)
- `<common>/worktrees` is read with `lstat` first:
  - absent: nothing to remove;
  - anything but a real folder (a link included): `GitFailure`, which becomes `worktree_unresolved` for the graph.
    The message names the path.
- Test: a main-only graph whose `.git/worktrees` links to a folder outside every root, which holds `victim/data`. The
  import blocks, and `victim/data` is untouched.

**M1**
- The git runner is already injected, so no filesystem seam was added. The review's `chmod` route covers the
  filesystem side.
- Test one: a git that answers `config --file … --get` with exit 128. Each graph gets exactly one
  `worktree_unresolved` naming the failed `git config`, and no registration is removed.
- Test two: `worktrees` at mode 000. The first graph gets a `worktree_unresolved` naming `EACCES`. It is skipped when
  the tests run as root.

**M2**: `probeFsRules` names the two forms as `ä` and `ä` again. The bytes match the original
`git-repair.ts`, and the file holds no raw non-ASCII.

**M3**: Both fixture READMEs lose "Support is pinned …". Their "Task 22 still needs … path-root mapping" line now says
the production adapter copies byte for byte to the same path and carries every release from its minimum on. The spike
scripts, the `*-portability` tests, `spike-results.md`, `readiness.md` and the pick-up guide are untouched.

**M4**: Codex's `min` is `AGENTS.codex.minVersion ?? [0, 0, 0]`, with a one-line comment. A missing floor now means
every release counts, and there is no `!`.

## Failing first (logs in the session scratchpad)

- **I2:** `expected [] to deeply equal [ { …(3) } ]`. The import removed `victim` through the link, then validated
  clean.
- **I1:**
  - discovery: `… holds auto-mode-classifier-error.txt, notes/plan.md, subagents/agent-a1.json,
    tool-results/p1/page-1.jpg, which Claude Code session adapter 1 does not carry`;
  - arrival: `expected [ Array(1) ] to include 'projects/…/auto-mode-classifier-error.txt'` (the Claude session was
    blocked, so only Codex was in the manifest).
- **M1:** both tests pass on the current import, which already turns refusals into blockers. That is the behaviour
  under test. With the catch changed to `throw e` (the review's mutation), both fail:
  - `Error: …/config: git config --get core.ignorecase failed: fatal: bad config line 1`;
  - `Error: EACCES: permission denied, scandir '…/.git/worktrees'`.

  The source was restored before the I2 fix.
- **M2, M3, M4:** no behaviour change, so no failing test. Typecheck and the session tests pass.

## Verification

| Command | Result |
| --- | --- |
| `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2227 passed, 5 skipped |
| `pnpm typecheck` | clean |

The +3 against 41b (2224) are the I2 test and the two M1 tests. The I1 tests replace two tests in place. No load
flake fired. The web UI did not change.

## Concerns

- **I1:** a Claude session's folder now travels whole, including large tool output (PDFs, images), and none of it
  is checked for secrets. The same was true of `tool-results/*` before. The space check counts it.
- **M1:** the `chmod` test skips as root, so a root CI run covers only the git half.
