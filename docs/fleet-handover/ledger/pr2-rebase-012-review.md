# PR #2 rebase onto 0.12.0 (`2ab80fda` on `f857baa6`): review

**Verdict: Approved.** No Critical, no Important, 3 Minor. The merge loses or doubles nothing from either side, and the
agent's changes are right. All but one of them fail a test when reverted.

## Critical

None.

## Important

None.

## Minor

1. **A hung `ps` stalls a freeze, and nothing gets it out.**
   - Where: `packages/svalld/src/load/procs.ts:44` runs `ps` with no timeout. Delete (`fleet.ts:683`) and Sleep
     (`fleet.ts:728`) now put that read inside the work `settle()` waits for (`fleet.ts:177-179`, called by the
     freeze at `handover/source.ts:303`).
   - Scenario: on the Linux companion one process is stuck in D state (a hung NFS or FUSE mount), so `ps` blocks
     reading its `/proc/<pid>/cmdline`. A Delete or Sleep let through just before the freeze never settles.
     `handover.freeze` never returns, and Cancel waits behind it. The PR bounds its own rest `ps` calls
     (`rest.ts:227,243`).
   - Fix: add `timeout: 10_000` to that `exec`, matching the helper call two lines up (the dormancy sweep uses 5 s,
     `dormancy.ts:167`).

2. **No test covers the guard against a dormant second terminal's stale pid.**
   - Where: `fleet.ts:702` (`c.second?.tmux ? agentProc(c.second.agent) : undefined`).
   - Checked: reverting it to `agentProc(c.second?.agent)` leaves the whole `sleepCharacter` block and the rest of
     `fleet.test.ts` green.
   - Scenario after such a revert: a robot whose Terminal 2 is dormant keeps the old agent pid. Once another `claude`
     reuses that pid (another robot's, say), Sleep waits 60 s on it and then SIGKILLs it.
   - Fix: add a sibling of `fleet.test.ts:1093`. Delete `second.tmux`, set `second.agent.pid` to a spawned
     `sleep 30` listed in `procs` with `args: 'claude'`, then expect `ending` to settle within 3 s and the process to
     get no signal.

3. **No test covers the dock fix.**
   - Where: `apps/desktop/web/src/dock.css:13-15,24,30`.
   - Scenario: a revert, or a later change to `.use-owner`'s flex or the `:has` rule, brings back the "andove" /
     "Setti…" clipping on a remote or handover-enabled fleet, and no test fails.
   - Fix: add one Playwright check on a remote fleet at the default sidebar width: `owner-badge` and `handover-tab`
     have `scrollWidth <= clientWidth`.

## Checks

**1. Conflicts and clean merges.**
- Method: per file, the normalised +/- lines of main's change (`46e37bc5→f857baa6` against `26fb94b1→2ab80fda`)
  and of the PR's change (`46e37bc5→26fb94b1` against `f857baa6→2ab80fda`), plus the range-diff.
- Every hunk from both sides appears exactly once. The only differences are the intended adaptations: `panePid`,
  `second?.tmux?`, protocol 23, `load` and `ownership` in Ctx, Opts and tests, the Sleep and Delete changes, procps,
  dock and docs.
- D1's content is identical in `46e37bc5` and `ac75767c`.
- Spot checks:
  - SideCard keeps `useTick` and "last activity" once.
  - App keeps `MissionPrompt`.
  - keyboard keeps `covered()` and main's `setSleepingCharacter`.
  - messages.test turns main's 22 test into "was 22".

**2. Main's writers against freeze and ownership.** Nothing missed.
- Guard classes: `char.sleep` is a mutation (`guard.ts:25`) and `load.get` a read (`:42`). The table is a
  `Record<MethodName, …>`, so a method without a class fails typecheck.
- Load tab: its Sleep and Delete go through `char.sleep` and `char.close`.
- Delete: the guard and the state delete are synchronous (`methods.ts:143-147`, `fleet.ts:675`). The kill and sweep
  are tracked.
- Sleep: it checks ownership again after its awaits (`fleet.ts:708`), with no await between that check, the state
  write and `track`.
- Auto-sleep: main did not change it, and it is gated (`fleet.ts:351,359`).
- Read-only: the sampler, `loadScope` and `sleepable` only read. `list-panes` and `display` start no tmux server on a
  replica.
- No new callers in the CLI, mobile or Swift.

**3. The agent's changes.** Reverted one at a time in a scratch copy; the worktree is untouched.

| Change | Right / minimal | Red on revert |
| --- | --- | --- |
| Sleep re-checks ownership (`fleet.ts:708`) | yes | yes (`fleet.test.ts:1188`) |
| Delete tracked (`fleet.ts:683`) | yes | yes (`:1216`) |
| Sleep tracked (`fleet.ts:728`) | yes | yes (`:1199`) |
| Agent second terminal kept dormant (`fleet.ts:717`), as `endAll` does (`dormancy.ts:255`) | yes | yes (`:1158`) |
| `<id>-2` key (`fleet.ts:706`), a window name as poll uses (`poll.ts:194-195`); Terminal 2 opening also waits (`fleet.ts:823`), as it should | yes | yes (`:1170`) |
| Stale-pid guard (`fleet.ts:702`) | yes | **no** (Minor 2) |
| procps `DD-HH:MM:SS` (`procs.ts:17-21`) | yes | yes (`load-procs.test.ts:28`) |
| Dock CSS | yes, scoped to fleets showing the owner or Handover | no test (Minor 3) |
| `char.sleep` / `load.get` classes | yes | yes (`ownership.test.ts:277`, both ways) |

- The ~60 s freeze wait is acceptable:
  - The spec puts no bound on settle and waits up to three minutes for a working agent.
  - The PR already tracks idle endings with the same 60 s exit wait (`poll.ts:218`).
  - Waiting is needed: an OpenCode server must be gone before the export reads its database, and nothing should end
    after the snapshot.
- Ubuntu 24.04 container: procps `ps -axww` is read BSD-style and lists session leaders and processes without a tty,
  so pane shells are found.

**4. A slept robot across a handover, both ways.**
- A slept robot is dormant with its resume command, no `interrupted` and no `restedBy`.
- Rest classifies only slots with a live window (`rest.ts:107-108`). Abort revives only the terminals it stopped.
- Import keeps the resume command (`validate.ts:126-137`).
- The destination wakes only slots with `restedBy === tx` (`destination.ts:694`), and `resumeInterrupted` skips it.
  The same holds for its dormant second terminal.
- A late SessionEnd on a dormant slot is dropped (`agent-events.ts:41,62`), so the agent record that import needs
  survives.
- Rest cannot block on Sleep's own process ends: settle lets them finish first, and the window is already gone.
- A Sleep during rest is refused with `frozen`.

**5. Versions.**
- Protocol 23: `messages.ts:419`, `messages.test.ts:153-154`, `migration.md:29,33`, `release-notes.md:39` and the
  commit body. No 22 is left in the PR's text.
- State schema 9: `state.ts:186`.
- migration.md names 0.12.0 as protocol 22 (`v0.12.0` `messages.ts`) and schema 8 (`v0.12.0:state.ts:179`).
  `git diff v0.11.0 v0.12.0` touches no state, store, migrate, config, setup or paths file, so the lines carried over
  from 0.11.0 still hold.

**6. Verdicts on the report's "Unsure" list.**
- **Freeze waits up to ~60 s on a slept agent:** accept.
  - The report's second sentence is wrong: an idle ending in flight *is* waited on.
  - `poll.ts:218` tracks `endIdleAgents`, which awaits each closing (`dormancy.ts:235-236`).
- **Slept robot's agent second terminal kept dormant:** accept. Main's "everything it started ends" still holds: the
  window closes and the agent ends, and only the resumable record stays.
- **Dock CSS:** keep it, and add the e2e check (Minor 3).
- **`load.get` on a replica or deactivated source:** accept.
  - It is read-only, `useLoad` swallows the error, and the app reads load from the owner.
  - Nuance: a sampler already running when the source deactivates keeps serving its last snapshot
    (`sampler.ts:38-40`) for as long as a page keeps asking. This is harmless.
- **Workspace watch test:** a known flake, not ours.

## Verification

- `tsc` for both projects: clean.
- svalld `fleet`, `ownership`, `handover/rest`, `handover/destination`, `load-*`, `procs-helper` and `dormancy`:
  449 passed.
- Web `load-panel`, `utility-dock` and `store`, plus protocol `messages`: 127 passed.
- Nine single-line reverts (the table above) run in a scratch copy.
