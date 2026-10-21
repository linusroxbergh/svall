# PR #2 final commit `ed3dda15`: verification report

**PASS.** The only failures are the 3 known vitest ones, which are not this branch's.

- Commit: `ed3dda15`, a single commit on `f857baa6` (= origin/main, Svall 0.12.0 + D1). The worktree was
  `.claude/worktrees/pr2-verify-012`, detached, with tracked files untouched; it has been removed.
- Host: macOS arm64, Node v26.12.0 (Homebrew), pnpm 12.6.0. `pnpm install --frozen-lockfile`.
- Vendor:
  - `vendor/rsync` (3.4.4-arm64) and `vendor/node` (v24.21.0 / v22.23.2 tarballs) came from `pr2-final`.
  - `vendor/ghostty-kit` (`332b2aef…-r1`) came from the main checkout. `ghostty-kit.sh current` passed, and the kit
    was symlinked to `apps/desktop/mac/GhosttyKit.xcframework`, as CI does.
- Mobile bundle built first, as CI does (5 s).
- Every shell: `unset SVALL_HOME SVALL_CHAR_ID TMUX SVALL_HOST SVALL_SITE_DIR OPENCODE_CONFIG_DIR`, `unset -f node`.
  `SVALL_RELEASE_KEY` unset.

| # | Check | Result | Counts | Duration |
| --- | --- | --- | --- | --- |
| 1 | `pnpm typecheck` | PASS | both tsconfigs clean | 2 s |
| 2 | `SVALL_REQUIRE_RSYNC=1 pnpm test` | PASS (known only) | files 247 passed, 2 failed, 1 skipped (250); tests **5844 passed, 3 failed, 8 skipped** (5855) | 334 s |
| 3 | `pnpm test:faults` | PASS | 2 files; **1421/1421**; seed `1792330716750` | 133 s |
| 4 | `pnpm e2e` | PASS | **203/203**, 1 worker, no retries | 294 s |
| 5 | `swift test --package-path apps/desktop/mac` | PASS | **86 tests, 0 failures** | 88 s (tests 20.5 s) |
| 6 | `release-build.sh` + `release-scan.mjs` | PASS | 3 archives, scan `ok` on each | build 22 s, scan 2 s |
| 7a | `scripts/integration/fresh-install.sh` (arm64) | PASS | 6/6 steps, ALL PASS | 90 s (harness 32 s) |
| 7b | `scripts/integration/fleet-handover.sh --scenarios all` (arm64) | PASS | 25/25 steps, 20 handovers, ALL PASS | 821 s (harness 806 s) |

## 2. Vitest failures (all known, not this branch)

The brief lists these as failing on plain main too. No other test failed, so nothing was rerun alone or on `f857baa6`.

- `test/desktop-install.test.ts` "asks each open window to quit by its pid, once, and the next only after it is gone":
  `expected [ '54624 no' ] to deeply equal [ '54624 no', '54633 no' ]` (`:68`).
- `test/desktop-install.test.ts` "stops before anything is installed when a window stays open or macOS will not pass
  the quit on": `expected +0 to be 1` (`:78`).
- `packages/svalld/test/workspace.test.ts` "Workspace watch watches only the top of a folder outside git, so what
  churns below it stays quiet": `expected 2 to be 1` (`:582`).

The 8 skips are all opt-in environment gates:
- `SVALL_TEST_GNU_TAR` ×2;
- `SVALL_TEST_RSYNC_BUILD` ×1;
- `SVALL_TEST_SSH` ×3;
- `SVALL_LIVE_REMOTE` ×2.

No rsync test skipped, because `SVALL_REQUIRE_RSYNC=1` was set and `vendor/rsync` was present.

## 6. Release build

`scripts/release-build.sh --out <scratch>/rel --version ed3dda15 --url-base https://github.com/linusroxbergh/svall/releases/download/ed3dda15`

| Archive | Bytes | sha256 | Scan |
| --- | --- | --- | --- |
| `svall-companion-ed3dda15-linux-x64.tar.gz` | 46,399,912 | `36c15df244899ea2aa4d510d417e2f700285609fcf0658c3087c642bfb78f22d` | ok, 328 files |
| `svall-companion-ed3dda15-linux-arm64.tar.gz` | 46,082,115 | `819d4299cdf81b266c1df03d259decc2400cf94c85671955628551a665ea3068` | ok, 328 files |
| `svall-controller-ed3dda15-darwin-arm64.tar.gz` | 42,659,716 | `2f161a001cea05e1f17510d173e0df151fb53cf3df37f8b0dc129b2a3b2e96b2` | ok, 332 files |

The controller's `release.json` reads:
- darwin-arm64, protocol 23, stateSchema 9, transferSchema 1, authoritySchema 1;
- node v24.21.0, rsync 3.4.4, `unsigned: true`;
- the two companions pinned by the digests above.

## 7. Container checks (colima, arm64, 2 vCPU / 2 GiB)

**7a, fresh install.** The run built `v0.12.0-3-ged3dda15` and `-next`, both darwin-arm64 and unsigned. The Mac
controller ran through its own shim and Node, with the controller home in `/var/tmp`, which the run removed.

Steps, each PASS:
1. the controller the app carries;
2. a clean Ubuntu 24.04 arm64 machine;
3. `host add`, with the companion downloaded from the loopback server;
4. lingering and `host enable --fleet work`;
5. a restart with no login;
6. `host upgrade` to `-next` (downloaded), then `setup --rollback`.

**7b, handover.** Two arm64 Ubuntu 24.04 containers. Every step was PASS:
- setup and the round trip, 7 steps: machines, install/host add/enable, fixture, local→remote, a turn on remote,
  remote→local, a turn on local;
- kill at begin, transfer, ready, commit and activate, in both directions: 10;
- drop at begin, transfer, ready and activate, in both directions: 8.

Each drop took 64–110 s.

**What 7b covers:** the controller runs from the Linux companion inside `svall-local`, so this is a Linux ⇄ Linux
handover driven from the Mac. No harness in `scripts/integration/` runs a Mac ⇄ Linux handover:
`docs/integration.md:147` leaves that to a manual run on real machines. The Mac controller is exercised against Linux
only by 7a (host add, upgrade and rollback).

**Docker state:**
- colima was `Stopped` at the start. It was started at 15:48 and stopped at 16:05.
- `colima stop` left the context on `default`, so it was set back to `desktop-linux`. The context list is as it was,
  with no `colima` entry.
- No containers or networks are left. The harness rebuilt `svall-it:latest` and `svall-it:machine` inside colima, as
  it does by design.

## Hygiene

- No bare `svall` was run.
- Nothing touched `~/.svall*`, `~/.config/svall`, launchd or the owner's app; the owner's svalld 27628 still runs.
- No processes or tmux servers from these runs are left.
- Nothing was pushed or committed.
