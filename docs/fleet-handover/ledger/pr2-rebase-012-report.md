# PR #2 rebase onto 0.12.0: report

**DONE_WITH_CONCERNS**

- Base: `f857baa6` (origin/main, the D1 merge; tree = `ac75767c`), per the coordinator's follow-up.
- Handover commit: `ed3dda15` on branch `pr2-v3`, worktree `.claude/worktrees/pr2-rebase-012`. Body is `26fb94b1`'s
  with "protocol 22" → "protocol 23". No attribution trailer. Nothing pushed; `pr2-final` and `d1-painted-cursor` untouched.

## Conflicts (15)

| File | Resolution |
| --- | --- |
| web `SideCard.tsx` | both: main's cpu/ram/procs rows (`useLoad`), then the PR's resume-error row and keep-here toggle |
| web `selectors.ts` | `isVeiled` takes main's `sleepingCharacter` and the PR's `hostOpen`/`handoverOpen` |
| web `test/store.test.ts` | both imports |
| protocol `test/messages.test.ts` | "is 23 with ownership and handover" + "was 22 with the load reading" (main's `load.get` checks) |
| svalld `api/methods.ts` | PR's imports + `LoadSnapshot`; `Ctx` has `handover`, `ownership` and `load` |
| svalld `api/server.ts` | Opts/destructure/`base` carry both; PR's broadcast block kept |
| svalld `dormancy.ts` | both new functions (`sleepFlags`, `portableRevive`) |
| svalld `fleet.ts` | Deps union; close = PR's `second?.tmux` + main's sweep; sleep adapted (decisions 3–4); PR's `doRevive(admitted)` with main's comment |
| svalld `fleet/poll.ts` | PR's `resumeMs` + main's "or a sleep" comment |
| svalld `main.ts` | `startApi` gets `load` and the PR's `origins()`, `ownership`, `handover` |
| test `api`, `guards`, `mobile` | PR's imports/opts + `stubLoad` / `load: stubLoad` |
| test `fleet` | boot options union; `Fleet` gets `ownership` and main's `readProcs` stub |
| test `helpers` | imports union (`FleetId`, `LoadSnapshot`, `Config`) |

Clean merges that were wrong (typecheck or by eye):

- PR renamed `LiveWindow.pid` → `panePid`; main's `loadScope`/`owned` used `pid` (`fleet.ts:270`, `:290`).
- `c.second?.tmux` is optional in the PR; main's `loadScope`, `owned`, sleep windows assumed it (`fleet.ts:273,289,705`).
- PR tests building `Ctx`/`startApi`/`Fleet` lacked `load`/`ownership` (`ownership.test`, `destination.test`, `procs-helper.test`).
- Dock: owner badge + Handover + main's Load tab clipped "Handover" to "andove" and "Setti…" on a remote fleet.
  `dock.css:13-15,24,30`: owner items size to content, Handover never shrinks, utilities show glyphs alone beside
  them. Screenshotted local/remote/phone/long-name; labels unchanged without handover. Pinned by
  `handover.spec.ts:105`.

## Decisions

1. **Protocol 23.** `messages.ts:419`; test `messages.test.ts:153`; `migration.md:29,33`; `release-notes.md:39`;
   commit body. State schema stays 9 (`state.ts:186`); 0.12.0's is 8 (`git show v0.12.0:packages/protocol/src/state.ts:179`).
2. **Downgrading → 0.12.0 (protocol 22, state schema 8).** `git diff v0.11.0 v0.12.0` touches no state, store,
   migrate, config, setup or paths file; same refusal message. `migration.md:53,59,65,104`.
3. **Freeze/ownership.**
   - `guard.ts:25` `char.sleep` mutation, `:42` `load.get` read.
   - `fleet.ts:708` Sleep asserts `mutation` after its process read, before any state write or kill.
   - Delete (`fleet.ts:676-684`): read → kill → sweep is tracked, so `settle()` (the freeze) waits for it.
   - Sleep's closing is tracked too (`fleet.ts:728`): a freeze waits up to ~63 s for a slept agent's exit and sweep.
   - Auto-sleep: `endIdleAgents` is gated by `!writable()` (`fleet.ts:351`) and `endAll` by `writable()` (`:359`).
     Main changed neither path beyond comments.
   - Load buttons go through `char.sleep`/`char.close`, so they are refused with a toast. The web disables nothing
     while frozen, same as every other PR mutation.
4. **Sleep vs handover.** Main stores no sleep flag: a slept robot is dormant with `revive.command` and no
   `revive.interrupted`.
   - `importState` keeps `interrupted` only when set (`validate.ts:132`).
   - The destination wakes only `restedBy === tx` (`destination.ts:694`) plus `resumeInterrupted`, so a slept
     robot stays asleep both ways.
   - Rest classifies only slots with `tmux` (`rest.ts:105-108`), so Sleep's own process ends never block.
   - Sleep now keeps a second terminal that ran an agent dormant (`loseSecond`, `fleet.ts:717`) rather than
     deleting it, as quit does.
   - Sleep registers the closing under `<id>-2` too (`fleet.ts:706`), so a poll/reconcile cannot re-adopt the
     closing second window.
   - A dormant second's stale pid is not waited on (`fleet.ts:702`).
5. **Attribution.** Unchanged, side by side:
   - main's `load/procs` + `attribute` serve Load, Delete and Sleep.
   - the PR's `ProcessTable` serves preflight/rest.
   - `dormancy.processes` serves idle ending.
   - Cheap shared reader, not done: one `ps -A -ww -o pid=,ppid=,pgid=,tpgid=,stat=,time=,rss=,args=` could feed
     all three parsers.
6. **Linux.**
   - The companion bundle has no Swift helper: `runtime.ts:34,43` gives no sources/helper when bundled, and
     `setup.ts:32` removes `hooks/svall-hook`. `readProcs` therefore falls back to ps (`fleet.ts:283`, `main.ts:213`).
   - procps 4.0.4 accepts main's `ps -axww -o pid=,ppid=,time=,rss=,args=` (ubuntu:24.04 container).
   - Fixed: procps prints `DD-HH:MM:SS` past a day of CPU, which parsed to NaN (`procs.ts:17-21`); NaN would reach
     the Load panel as null.
   - The ps fallback is bounded at 10 s (`procs.ts:44`), as the helper call is: a hung ps no longer holds a freeze
     waiting on a Delete or Sleep.
   - Without marks, Delete and Sleep end just the pane trees.
7. **Docs.**
   - `handover.md:20`: while frozen the Load tab reads, Sleep and Delete are refused.
   - `handover.md:198-199`: Load shows the owning machine's cost; on Linux only terminal trees, so background
     servers are neither listed nor ended.
   - `release-notes.md:44`: a slept robot's agent second terminal stays.
   - `spec.md:221`: "sleep" added to the owner-checked operations.
   - The handover sheet has no frozen-behaviour text to change.

## Tests added (red → green unless noted)

- `ownership.test.ts:277` sleep refused on replica/frozen; `load.get` passes the fence.
- `fleet.test.ts:1112` a dormant second terminal's stale pid, now another agent's, is neither waited on nor signalled.
  Red with the guard at `fleet.ts:702` reverted.
- `fleet.test.ts:1178` second terminal with an agent stays dormant on sleep.
- `fleet.test.ts:1190` reconcile does not re-adopt windows a sleep is closing. Load-bearing: red with the `<id>-2` key removed.
- `fleet.test.ts:1208` freeze during sleep's process read: refused `frozen`, window and state untouched.
- `fleet.test.ts:1219` settle waits for an admitted sleep's sweep.
- `fleet.test.ts:1236` settle waits for an overtaken delete's kill and sweep.
- `load-procs.test.ts:31` procps day-prefixed CPU time.
- `load-procs.test.ts:43` a ps that never answers is given up on (fake `ps` on PATH).
- `handover.spec.ts:105` (e2e) owner badge and Handover tab not clipped on a remote fleet. Red with the dock CSS reverted.
- Guards, green from the start:
  - `rest.test.ts:239` rest leaves a slept robot alone.
  - `destination.test.ts:1116` a slept robot stays asleep after activate.
- `messages.test.ts:153` protocol 23.

## Suites (on `2ab80fda`; `ed3dda15` re-run below)

- `pnpm typecheck` clean.
- `SVALL_REQUIRE_RSYNC=1 pnpm test`: 5840 passed, 10 skipped, 3 failed.
  - `scripts/desktop-install.test` ×2: known.
  - `workspace.test` "watches only the top of a folder outside git": fails alone too, here and on `ac75767c`'s tree
    (d1 worktree). Environmental, not this branch.
- `pnpm test:faults`: 1421 passed.
- `pnpm e2e`: 202 passed.
- `swift test --package-path apps/desktop/mac`: 86 tests, 0 failures.
- `ed3dda15` (review minors): typecheck clean; svalld fleet + load + procs-helper 242/242; `handover.spec.ts` 13/13.
- `vendor/rsync`, `vendor/node` copied from the fleet-handover-impl worktree (same pins). GhosttyKit linked from the
  main checkout (same Ghostty commit). Mobile bundle built first, as CI does.

## Unsure

- Sleep's tracked closing makes a freeze wait up to ~60 s for a hung slept agent, as an idle ending in flight already
  does (tracked at `poll.ts:218`).
- Keeping a slept robot's agent second terminal dormant reads main's "closes the second terminal" through the PR's
  dormant-second model.
- The dock CSS change is outside the brief's list. It is a by-eye call; no test pins it.
- `load.get` on a replica or deactivated source (no tmux server) errors, so the Load panel stays empty there. Left as is.
- The workspace watch test does not pass alone on this machine, contrary to the brief; it fails the same on main's tree.
