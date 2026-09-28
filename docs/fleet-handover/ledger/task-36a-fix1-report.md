# Task 36a fix round 1 — report

Commits `2a5a0f08..a676269e` on `experimental-remote-sessions` (not pushed), on top of `8a7b7582`:

1. `2a5a0f08` The fault suite crashes at every run of every step without fsync, and fails when status offers nothing to do (M2, M4)
2. `a66a9242` Every removal of a handover's files runs between two failpoints, and the fault suite watches every write under the homes for the whole run (M1)
3. `40781eb0` An agent terminal whose window a crashed rest closed resumes with the launch flags that rest recorded, whether the handover goes on or is aborted (M3)
4. `ed25ada8` Opening a terminal a handover has yet to answer for keeps the resume command it carries, so an activation retried after a crash lays it dormant with its launch flags (new defect A)
5. `538404d7` The rest's SIGKILL, the destination's window kills and a diverged root's archive and second claim each run between two failpoints, and the fault suite reaches them (I1)
6. `9680eca4` An activation retried after a crash between laying a terminal dormant and closing its window closes that window before it opens the terminal afresh (new defect B)
7. `a676269e` Every party removes what a transaction owns before the record that names it, and the fault suite finds no file of a settled handover left on any machine (I2)

## Findings

**I1.** New failpoints `source.rest.forcekill` (the rest's SIGKILL), `destination.activate.kill` (the kill in `lay`, and in
`closeLeft`, below) and `destination.claim.archive`; the claim after an archive runs inside `destination.claim.root`. The
world now reaches each one:

- bo's `npm run dev` ignores SIGTERM, so every run terminates it and then SIGKILLs it;
- trift holds a sealed replica record for `~/work/cy` whose baseline names a file that is gone. The root is diverged, and
  the user's `archiveRoots` choice archives it at claim. cy is empty, so on the one disk the archive and the fresh
  reserve leave the same content;
- a new character, c_di, runs `claude --effort high` with a real transcript under `~/.claude`. The session travels
  through the controller's transfer (the fake rsync copies its files into the stage), is placed, and resumes on
  activation with a SessionStart. `REACH` has a `setup` hook: `destination.activate.kill` crashes after c_di's open,
  its agent exits back to its shell while trift is down, and the retried activation kills that window.

Before the failpoints existed, the move probe reported `mac signal 3001 by the source ran outside every failpoint`. It
also reported `removal`, `link` and `rename of trift/replicas/<fleet>/<hash>.json by the destination ran outside every
failpoint`, for the archive and the second claim. The scratch retry case reported `trift kill @4 by the destination ran
outside every failpoint`.

**I2.**

- `fileStore.clear` removes `handover/<tx>/` inside the new `controller.clear` and then `handover.json`.
- The source's `release(tx)` removes the manifest inside `source.release.manifest` before it closes the journal. Abort
  and a refused freeze both go through it.
- `supersede` removes the manifest before it closes the journal.
- `settledOn` checks that both `handover/` folders are empty, recursively, and that `ctl/` holds nothing beyond an
  empty `handover/`.

Failing first:

- `controller.journal:after#15` and `controller.clear:before#1`, both variants: 12 entries left under
  `ctl/handover/<tx>/`;
- the new case "a freeze asked again that refuses": crash at `source.freeze.manifest:after#1`, c_cy kept here, resume.
  It went `resume->blocked` and left `mac/handover/manifest-<tx>.json`;
- a new `source.test.ts` case: a crash at supersede's manifest removal, then a start. It left the manifest.

**M1.**

- `boundary` calls the hook with `threw` when a step throws. It is no failpoint; the world only closes that step's count.
- The watch covers every `renameSync`, `linkSync`, `rmSync`, `unlinkSync` and `rmdirSync` under `mac/`, `trift/`, `gw/`
  and `ctl/`. The allow-list is durable temps, `state.json` other than its promotion, and the gateway's `.quarantined`
  marker, which it lifts on every read that finds the record.
- A new guard test fails before the change: a write after a rejected `controller.commit` was not reported, and neither
  was an unknown `stage-x.json` written and removed under `mac/handover/`.
- The reversed watch found unguarded writes. They are now under new failpoints: `controller.manifest`,
  `controller.landed`, `source.complete.manifest`, `source.release.manifest`, `destination.prepare.stage` (both call
  sites), `destination.complete.clear`, `destination.abort.clear` and `destination.abort.stage` (`dropStage`). The
  stale-manifest removal moved inside `source.freeze.manifest`, and the relay secret inside `destination.prepare.state`.
- Mutation check: dropping the `destination.prepare.stage` boundary makes the move probe report `removal of
  trift/handover/sessions-<tx> by the destination ran outside every failpoint`.

**M2.** `worlds()` stubs `fs.fsyncSync`, and `CASES` crashes at every hit of every step: 421 tests in about 20 s.

**M3.** `stoppedTerminals` entries carry the terminal's launch flags, recorded at `source.rest.stopped` when there are
any. The rest's already-gone pass and `revive` both lay a stopped terminal dormant with them.

- Failing first: `source.rest.kill:after#4` (c_di's kill) in both variants. The agent came back as `claude --resume
  <sid>`.
- Each half is load-bearing: reverting the `rest.ts` half fails the resume variant, and reverting the `source.ts` half
  fails the abort variant.

**M4.** `recover()` records a violation and stops when status offers neither action. Mutation check: an `open` verdict
with `safe: []` fails `source.freeze.digest:after#1` with "status offers nothing to do, yet says continue".

## Defects the widened world found

**A. A carried terminal's resume command was lost when its window opened** (`ed25ada8`).

- `Fleet.doRevive` and `doOpenSecond` deleted `revive` on open. The reconciles already keep it for a terminal the
  handover carries.
- Suppose the destination crashes after opening c_di and before recording its row, and the agent exits meanwhile. The
  retry's `lay` has no carried revive, so it rebuilds `claude --resume <sid>` without the flags.
- Fix: both opens keep `revive` while `carried(id, term)`. The fake fleet models this.
- Test: a new `fleet.test.ts` case covering the re-attach branch, a new window and a second terminal (it fails before
  the fix). The scratch retry case failed the same way.

**B. A crash inside `lay`, between the dormancy and the kill, left the agent unresumed** (`9680eca4`).

- The retry finds the terminal dormant while its window lives on. The fleet goes back to that window and types
  nothing, so the agent never comes up and the terminal is left dormant with an error.
- To model the real fleet, the fake fleet now reuses a window it finds by name without running anything in it.
- Fix: `wakeSlot` closes any window named for a dormant terminal (`closeLeft`, under `destination.activate.kill`)
  before it opens the terminal afresh.
- Test: `destination.activate.kill:before#1`, both variants. It was committed as expected-to-fail in `538404d7` and
  passes from `9680eca4`.

No case let two machines run terminals, gave the destination a window before the commit, or ran the source after it.

## Failpoints

58 names, 116 failpoints (source 20, destination 25, gateway 6, controller 7). Added in this round:

| Side | Phase | Added |
| --- | --- | --- |
| source | Freeze | `source.rest.forcekill` |
| source | Abort / refuse | `source.release.manifest` |
| source | Complete | `source.complete.manifest` |
| destination | Transfer | `destination.claim.archive` |
| destination | Prepare | `destination.prepare.stage` |
| destination | Activate | `destination.activate.kill` |
| destination | Complete | `destination.complete.clear` |
| destination | Abort | `destination.abort.stage`, `destination.abort.clear` |
| controller | all | `controller.manifest`, `controller.landed`, `controller.clear` |

Exhaustiveness:

- `REACH` is a `Record<Failpoint, Reach>`, so a new name without an entry fails typecheck.
- The probes check every count.
- The registry test checks that every name appears in the source.
- The reversed watch flags any rename, link or removal under a home, and any window kill, open or signal, made outside
  an open boundary of its party. A step that throws closes its count, so the watch stays on for the whole run.

## Scenario matrix

| Suite | Tests | Result |
| --- | --- | --- |
| Registry | 5 | pass |
| Guard after a thrown step, and on unknown files | 1 | pass |
| Coverage: both edges of every name | 1 | pass |
| Probes: move, cancel after prepare, cancel during transfer (`cancel`, new) | 3 | pass |
| Crash matrix: 198 cases (every hit) × resume / abort | 396 | pass |
| A freeze asked again that refuses | 1 | pass |
| Gateway lost at five points × resume / abort | 10 | pass |
| Stale `owner.json` beside a surrendered journal | 4 | pass |

`recover()` restarts what died before each new controller, as launchd would, since a second crash can now fall during
recovery.

## Seeds and verification

- `pnpm typecheck`: clean.
- `pnpm test packages/archid/test/handover/faults.test.ts`: 421 passed, about 20 s. Shuffled with seeds 36, 2026 and 7,
  and once more in order: 421 passed each time.
- `pnpm vitest run --project archid --project cli --project @archipelago/desktop-web`: 181 files passed and 1 skipped;
  3267 tests passed and 5 skipped.

## Concerns

- **A leftover `revive` on a live slot.** After fix A, a carried main terminal keeps `revive` on its live slot until
  it next goes dormant; the poll clears a second terminal's. Every reader (`doRevive`, `run`, the startup reconcile,
  `importState`, the web's resuming view) acts only on a dormant slot or one rested first.
- **Supersede has no failpoint.** The force-owner path stays out of the suite, as in 36a. Its new order is tested in
  `source.test.ts` only.
- **Call sites the matrix does not crash at.** These names are crashed at their other call site only:
  - `destination.activate.kill` in `closeLeft` (reached in the recovery of `kill:before#1`);
  - `source.release.manifest` in a refused freeze (one dedicated case);
  - `destination.prepare.stage` on a prepare retried after it prepared.
- **The one disk.** It can archive only an empty root: archiving a root with content would move the source's copy too.
- **Agents.**
  - c_di's SessionStart comes right after a fresh window opens.
  - Trust and bypass prompts, the watch loop and Codex are not under crash.
- **The reverse import.** It now also takes the `RunRsync` type from `packages/cli/src`.
