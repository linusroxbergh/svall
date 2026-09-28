# Task 36a review

Commits `46978368..0d7722d4` on `experimental-remote-sessions`.

**Verdict: Needs fixes.** Critical 0, Important 2, Minor 4.

The failpoint registry, the fault world and both fixes are sound. No case lets two machines run terminals. Two things
fall short of the brief. Some terminal kills and one replica write in production code run outside every failpoint. And
three leaks of the same shape as defect 2 remain; the suite passes over two of them.

## Important

### I1. Production steps that run outside every failpoint

- **The destination's window kill.** `destination.ts:731-743` (`lay`, kill at 742) runs outside every boundary. It is
  called from `wakeSlot` (569, 606, 623) and `watch` (664), after the `destination.activate.fleet` boundary has closed.
  The plan names "terminal kill … on each side that has one". The suite never reaches this kill: it has shell terminals
  only, and no case loses a window before a retry. I wrote a scratch case: crash at `destination.activate.open:after#1`,
  drop the opened window, restart, resume. The guard then reports `trift kill @1 by the destination ran outside every
  failpoint`.
- **The rest's SIGKILL escalation.** `rest.ts:270-272` runs outside every boundary. Only the SIGTERM has one
  (`source.rest.terminate`). The fake job always dies on SIGTERM (`faults.test.ts:180-183`), so this is never reached.
- **The archive and the claim after it.** `destination.ts:292-299`: `replicas.archive` moves a diverged root aside and
  rewrites its replica record, and the claim after it writes the replica record again. Both run outside
  `destination.claim.root`, which the report lists as that record's failpoint. Nothing here reaches them, since one
  disk leaves nothing to archive.

Fix: put each step inside a named boundary, for example `destination.activate.kill`, `source.rest.forcekill`,
`destination.claim.archive`, and the second claim inside `destination.claim.root`. Give each a `REACH` case:

- a job that ignores SIGTERM reaches the SIGKILL;
- a window gone before the retry reaches the kill. `REACH` needs a small setup hook for that, beside `after`;
- no one-disk case can reach the archive, so crash at it in a `destination.test.ts` case.

One agent terminal in the world would also reach `lay` through `wakeSlot`'s agent branch.

### I2. Leaks of defect 2's shape remain (brief item 3)

- **The controller's transaction folder.** `recovery.ts:101-104` (`clear`) removes `handover.json` inside
  `controller.journal`, then removes `handover/<tx>/`. A crash at `controller.journal:after#15`, a case the matrix
  already runs, leaves `manifest.json`, `landed.json`, `progress.json` and `filters/*.rules` there for good. Nothing
  sweeps the folder, and `settledOn` checks only `ctl/handover.json` (`faults.test.ts:628`), so the case passes.
  Confirmed in scratch.
- **A freeze retried and then refused.** `source.ts:452-458` (`refuse`) closes the journal through `release()` and never
  removes `manifest-<tx>.json`. Suppose a first freeze dies after `source.freeze.manifest` and its retry refuses. The
  manifest the first freeze wrote then stays for good, and the controller's abort cannot remove it: `runAbort` returns
  early once the owner is unfrozen. Scratch case: crash at `source.freeze.manifest:after#1`, set `keepHere` on `c_cy`,
  restart, resume. Status went `open:resume+abort`, `resume->blocked`, `none`, and `mac/handover/manifest-<tx>.json`
  was left behind.
- **Supersede.** `source.ts:246-247` closes the journal before removing the manifest. The report names this one.

Fix:

- in `clear`, remove every transaction folder the journal no longer names, which also covers one a crash left
  earlier. This avoids reordering the two removals, which would leave a journal whose folder is gone;
- in `refuse`, remove the manifest before `release()`, as `runAbort` now does;
- in `supersede`, swap the two lines;
- in `settledOn`, assert that `ctl/handover/` is empty.

## Minor

### M1. The write guard catches less than the report says

- **A step that throws leaves its party unguarded.** `boundary` calls `after` only once the step succeeds
  (`failpoints.ts:350-357`). `hit` closes an open count only on `after` (`faults.test.ts:321`), and `guarded` passes
  while any count is open (352). So after any boundary whose step throws, every later step that party takes counts as
  guarded. Scratch: after a rejected `controller.commit` boundary, an unguarded write by the controller was not
  reported.
- **Only files named in a regex are watched.** Removals are watched only for `journal.json` and `handover.json`
  (`faults.test.ts:358-361, 644`). A new kind of durable file is therefore never caught. Scratch mutation: a
  `stage-<tx>.json` under the fleet home, written in freeze outside any failpoint, removed in complete and left behind on
  abort. All 78 source cases and both probes still pass. Other writes already outside every failpoint and unwatched:
  the relay secret (`destination.ts:438`), the controller's `saveManifest` and `saveLanded` (`recovery.ts:91, 96`), and
  the removals of manifest, prepared and seal files.

Fix:

- let `boundary` tell the hook when a step throws, for bookkeeping only (it is no crash point), and close the count
  there;
- turn the watch around: every rename, link or rm under `mac/`, `trift/`, `gw/` and `ctl/` is a step, except for an
  allow-list (`state.json` outside a promotion, and durable temps).

### M2. `faults.test.ts` spends 93% of its runtime in fsync

Baseline: 145 s for 238 tests. With `vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {})` added to `worlds()`, the
same 238 pass in 9.6 s. A crash here happens inside one process and never loses the page cache, so fsync proves nothing
in this suite. At that speed, crash at every hit rather than only the first and the last (`faults.test.ts:729-732`).
That covers the 13 middle `controller.journal` steps and the middle hits of `claim.root`, `rsync`, `verify`,
`rest.kill`, `activate.open`, `activate.record` and `revive`. I ran it: 330 cases, all pass.

### M3. F3 hits the resume path too, not only revive

On the re-freeze, the rest has no track for a terminal whose window a dead rest closed. `rest.ts:340-343` therefore lays
it dormant with `flags` undefined, just as `source.ts:471-472` does on abort. An agent killed in that window comes back
without its launch flags on the destination as well.

Fix: record each terminal's flags in `stoppedTerminals` at `source.rest.stopped`, before any window closes. Use them in
both places.

### M4. `recover()` can take an action status did not offer

`faults.test.ts:596` falls back to `abort` when neither action is safe. That cannot happen today: every verdict other
than `none` offers an action (`recovery.ts:176-231`). But if `assess` changed, the suite would take an action status
did not offer instead of failing. Fix: fail there.

## Verified clean

- **Failpoint placement.** All 46 names have both edges, and every boundary the plan names has one on each side, apart
  from I1. Unarmed, `boundary` just runs the step; each wrapped call behaves as before. `armFailpoints` is the only way
  to arm them, it throws when `ARCHI_RELEASE_ROOT` is set, and nothing in `packages/*/src` calls it. No env var, config
  key or RPC reaches it.
- **Exhaustiveness.**
  - Adding `controller.extra` to `FAILPOINTS` fails typecheck with TS2741 at `REACH`.
  - Dropping the boundary around the rest's window kill makes the move probe report `mac kill @1/@2/@3 by the source
    ran outside every failpoint`.
  - An unguarded extra `installCommitted` in complete makes it report `rename of mac/owner.json by the source ran
    outside every failpoint`.
- **The invariant.** It is checked at every failpoint hit, daemon answer, gateway call, window open or kill, and boot,
  not only at the end. `can()` runs the real `guardMethod`. Recovery goes through `status()` and `assess`. Every restart
  is from disk: `OwnershipState.load`, `Store.load`, a new `HandoverService`, the startup mode and `adoptAtStart`, a
  gateway restarted on the same prefix, and a new controller over `fileStore`.
- **Gateway loss** before Begin, during Freeze, after Ready, after Commit and during Complete, each followed by a
  resume and by an abort. Nothing changes `owner.json` while the gateway is away.
- **Item 5.** A stale `owner.json` beside a surrendered journal comes up fenced with the gateway away and with it
  answering, and again after a second restart. So does a source that died between its journal and its surrender.
- **Fix 1** (`1c79bc1d`) is correct and minimal. Reverting both parts fails `source.rest.kill:after#1/#3` in both
  variants. Reverting only the `rest.ts` part fails the two resume cases; reverting only the `source.ts` part fails the
  two abort cases.
- **Fix 2** (`0d7722d4`) is correct and minimal. Reverting all of it fails 8 cases. Each part alone is load-bearing:
  - the order in abort fails `release.unfreeze:after`, `release.activate:before` and `release.activate:after`, each in
    both variants;
  - the order in complete fails `complete.journal:after`, in both variants;
  - the quiet `ENOENT` skip fails `complete.journal:before` through the no-error assertion.

  A missing manifest at complete can only mean an earlier complete already sealed and removed it, so the quiet skip
  hides nothing else.
- **Nothing left behind blocks the next handover.** After every crash case and both recoveries (216 runs) that settle on
  the source, a second handover to trift completes with no violation.
- **Reverse import.** It is acceptable. It is test-only. One root `tsconfig.json` typechecks every package. The
  companion build bundles from the entry points, so no test ships. No production dependency changes. 36b's cli suite
  imports in the natural direction.
- **One disk.** Accepted. Crash recovery of the reserve-and-create claim is covered at unit level in
  `replicas.test.ts:156-173`. The archive is the gap, as I1 says.
- **Shell terminals only.** Accepted for 36a, apart from the destination kill in I1.

## Runs

- `pnpm typecheck`: clean.
- `pnpm vitest run --project archid --project cli --project @archipelago/desktop-web`: 181 files passed and 1 skipped;
  3082 tests passed and 5 skipped; 211 s.
- `faults.test.ts`: 238 passed in 145 s (scratch copy).
- With the fsync spy (scratch):
  - shuffle seeds 1, 99 and 4242: 238 passed each;
  - three repeats: 238 passed each;
  - crash at every hit: 330 passed.
- Every mutation and scratch case ran in a scratch copy outside the worktree. The worktree is unchanged apart from this
  file.

## Fix round 1

Commits `2a5a0f08..a676269e`.

**Verdict: Needs fixes.** Critical 0, Important 1, Minor 1.

I1–I2 and M1–M4 are addressed, and so is fix A: each fails when I revert it. Fix B also fails when reverted, but the
defect it fixes comes from a gap in the fake fleet. The real code does not have it.

### Important

#### F1. Defect B does not happen with the real fleet, and fix B adds a race

- **Why B cannot happen in production.** The fake fleet's `reconcileNow` does nothing and its `activate` does no
  reconcile (`faults.test.ts:227, 240`). The real `Fleet.activate` → `begin` → `reconcileNow` (`fleet.ts:141, 293-303`)
  runs before `wake` on every activation (`destination.ts:492-497`). It takes back any live window named for a
  character, dormant and carried or not, and keeps the carried revive (`reconcile.ts:120-132`). I checked this with the
  real `Fleet` on real tmux in a scratch case. A carried character was laid dormant while its window lived on. After
  `reconcileNow` it had that window again, with its revive kept. So after the crash B describes, the retried activation
  finds the slot holding its window. `wakeSlot` then reads it as `shell` and runs `lay`, which kills it, and opens the
  terminal afresh. That is the path the other `activate.open` crash cases already cover.
- **The suite passes without fix B.** Scratch: I gave the fake `reconcileNow` the real reconcile's re-attach (a window
  named for a slot with no `tmux` is attached, and `revive` is kept while carried) and reverted `9680eca4`'s source
  change. All 421 cases pass, among them `destination.activate.kill:before#1` in both variants, with c_di resumed with
  its flags.
- **What `closeLeft` does in production.** It runs only when a window named for the terminal appears after the
  reconcile (`destination.ts:575-576, 752-757`). By then the destination is unheld (`destination.ts:493`), so a user can
  open a terminal too. For example, the phone revives a dormant character as soon as its view opens
  (`CharacterView.tsx:108`). If that happens while `wake` handles the slot, `closeLeft` kills the window the user just
  opened. `openSlot` then returns a slot pointing at a window that is gone, and the terminal is left dormant with an
  error. This is narrow and breaks no invariant, but it is a production change for a defect production does not have.

Fix:

- make the fake's `activate` and `reconcileNow` re-attach windows by name, as `reconcile` does;
- drop `closeLeft` and the `else if (!held)` branch;
- keep the `destination.activate.kill:before#1` cases, which then run the real path.

### Minor

#### F2. `settledOn` covers only `handover/` and `ctl/`

`settledOn` checks `handover/` on each machine and all of `ctl/` (`faults.test.ts:688, 699`). A transaction file
anywhere else under a fleet home is not checked. Scratch mutation:

- `mac/stage-<tx>.json`, written inside `source.freeze.manifest` and removed only in complete, is left behind by every
  abort. All 106 source and probe cases still pass, apart from the move probe's count, which fails only because I
  reused a failpoint name.
- The same file under `mac/handover/` fails more than 40 cases.

Nothing leaks today, since every file a transaction writes lives in `handover/`.

Fix: also assert that no path under the base names the transaction id. I ran that check after a settled move, abort
and cancel, and it finds nothing, so it raises no false alarm.

### Each item

- **I1.**
  - Dropping any one of the four new boundaries fails the suite:
    - `source.rest.forcekill`: the move probe reports `mac signal 3001 … outside every failpoint`;
    - the kill in `lay`: `destination.activate.kill:*#1` reports `trift kill @4 …`, in both variants;
    - `destination.claim.archive`: the probe reports the removal of a `trift/replicas/…` record;
    - the claim after the archive: the probe reports the link of a record.
  - The claim after the archive now runs the reserve-and-create branch under crash, which 36a's one disk could not.
- **I2.**
  - Reverting `clear`'s order fails `controller.journal:after#15` and `controller.clear:before#1`, in both variants.
  - Dropping `source.release.manifest` fails 16 abort cases and the refused-freeze case.
  - Reverting supersede's order fails its `source.test.ts` case.
  - I thought moving the folder's removal ahead of the journal's would leave a journal whose folder is gone. That does
    no harm: `clear` runs only after both sides and the gateway finished or let go. A later finish reads `landed` as
    absent, and no daemon still has a journal to complete. `controller.clear:after#1` settles in both variants.
- **M1.** My mutation from 36a now fails. A `stage-<tx>.json` under `mac/`, written in freeze outside any failpoint and
  removed in complete, fails the move, abort and cancel probes with `rename` and `removal of mac/stage-<tx>.json by the
  source ran outside every failpoint`. The `threw` edge closes the count, and the guard test covers it.
- **M2.** 421 cases in about 20 s, every hit of every step.
- **M3.** Reverting the `rest.ts` half fails `source.rest.kill:after#4` resume, and reverting the `source.ts` half fails
  the abort variant.
- **M4.** An `open` verdict with `safe: []` fails `source.freeze.digest:after#1` with "status offers nothing to do".
- **Fix A** (`ed25ada8`) is correct: the real `doRevive` and `doOpenSecond` dropped the carried revive.
  - Reverting `fleet.ts` fails the new `fleet.test.ts` case.
  - Reverting the fake's matching change fails the four `destination.activate.kill` cases.
- **Fix B** (`9680eca4`): reverting it fails `destination.activate.kill:before#1` in both variants, in the world as
  modelled. See F1.

### The concerns

- **A leftover revive on a live main terminal.** Accepted. Every reader acts only on a dormant slot:
  - `run` and `doRevive` check `!c.tmux`, and the web's "Resuming" view is shown only for a dormant slot;
  - the next rest's `markDormant` overwrites it before any manifest is built;
  - the next start's reconcile clears it.

  Clearing it in the poll's main-terminal branch, as `attachSlot` already does for a second terminal, would make the two
  slots match, but it is not needed.
- **Supersede without a failpoint.** Accepted. Force-owner recovery is not a step of a handover (spec, "Failure and
  recovery"). Its new order is proven by the `source.test.ts` crash case.
- **The cancel-during-transfer run.** A good addition. It is the only path to `dropStage` (`destination.abort.stage`).
- **Restarting dead daemons before each recovery attempt.** Accepted. It models launchd, and a second crash can now fall
  during recovery (`after` chains). A daemon that stays down while a controller recovers is 36b's to cover, with its
  lost and partition faults.
- **Call sites the matrix does not crash at, the one disk, agents, and the reverse import** (now with a type-only
  `RunRsync`). Accepted as reported. The `closeLeft` call site goes away with F1.

### Runs

- `pnpm typecheck`: clean.
- `pnpm vitest run --project archid --project cli --project @archipelago/desktop-web`: 181 files passed and 1 skipped;
  3267 tests passed and 5 skipped.
- `faults.test.ts`: 421 passed in 20 s (scratch copy).
  - shuffle seeds 1, 99 and 4242: 421 passed each;
  - two repeats in order: 421 passed each.
- `fleet.test.ts` and `source.test.ts`: 134 passed.
- Every mutation and scratch case ran in a scratch copy outside the worktree.

## Fix round 2

Commits `fd6e6d1f..ead06bdd`. I read the code at `ead06bdd`, and every scratch copy came from `git archive ead06bdd`.

**Verdict: Approved.** Critical 0, Important 0, Minor 0.

### F1: addressed, and no wider than needed

- **Production change.** It only removes code. `closeLeft`, its `else if (!held)` branch and the `secondName` import are
  gone from `destination.ts`. The one thing left of `9680eca4` is the corrected comment on `carried`, which is right
  since fix A.
- **The fake fleet** (`faults.test.ts:202-205, 238`).
  - Its `reconcileNow` runs the real `reconcile` from `src/reconcile.ts` over the fake tmux windows, with the carried
    terminals the destination registered. Like the real one, it does nothing unless the daemon is writable.
  - Its `activate` runs that reconcile, as `Fleet.begin` does.
  - It leaves out only what the world cannot produce: the renames of stray windows, and the filter for windows still
    closing for idleness.
- **Fake against real, repeated.**
  - With the real `Fleet` on real tmux at `ead06bdd`, I laid a carried character's main and second terminals dormant
    while their windows lived on. `reconcileNow` gave both their windows back and kept both carried revives.
  - The fake now calls that same function, so what it does matches the real fleet's.
- **Failing first.** With `closeLeft` gone and the fake's reconcile made a no-op again,
  `destination.activate.kill:before#1` fails in both variants. So the reconcile model is what carries these cases, on
  the real path: the reconcile takes the window back, `wakeSlot` reads it as `shell` with an agent, `lay` kills it at
  the second `destination.activate.kill` hit, and the terminal opens afresh with its flags.
- **`closeLeft` restored with a no-op reconcile** passes the same 48 `destination.activate` cases, which confirms what
  it used to cover.

### F2: addressed

- **What it checks.** `World.record()` collects every transaction id the gateway's record names, at every step of
  `check()`, so it includes a Begin whose answer never arrived. `settledOn` then asserts that no path anywhere under the
  base names one of them (`faults.test.ts:290, 431, 710`). The base holds `home/`, both fleet homes, `gw/` and `ctl/`.
  The checks on `handover/` and `ctl/` stay.
- **My stage-`<tx>` mutation, repeated.** I wrote `mac/stage-<tx>.json` inside `source.freeze.manifest` and removed it
  only in complete. With F2, 142 of 421 cases fail, naming `mac/stage-<tx>.json`: every abort path and every crash that
  ends back on the source. With the F2 test change reverted, only the move probe fails, and only because the mutation
  reuses a failpoint name.
- **Nothing is flagged without the mutation.** At `ead06bdd` all 421 cases pass.

### Runs (scratch copy of `ead06bdd`)

- `pnpm typecheck`: clean.
- `faults.test.ts`: 421 passed in 21 s. Shuffle seeds 1, 99 and 4242: 421 passed each.
- `pnpm vitest run --project archid --project cli --project @archipelago/desktop-web`: 181 files passed and 1 skipped;
  3253 tests passed and 19 skipped. The archive copy skips more than a checkout does (the report's run skipped 5), and
  nothing failed.
- I left the worktree untouched apart from this section; the other agent's edits there are theirs.
