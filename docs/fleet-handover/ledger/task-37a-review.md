# Task 37a — review

Range a1dd62b4..da059e2a (6 commits). Reviewed against `task-37-brief.md` (37a: Do 1, 2, 6, 7 and the rulings),
spec "Verification", "Failure and recovery", "Ownership authority", and `review-constraints.md`.

## Verdict: Approved

No Critical or Important findings, and 6 Minor. The harness checks what it claims against the source's state from
before the move, and it fails when the product is wrong. The one open item is a ruling, not a code change: Verify asks
for both architectures, and x86-64 has no run yet (see Concern 1).

## Spec and brief compliance

| Item | | Notes |
| --- | --- | --- |
| Do 1: harness, fixture, `host add`, local → remote → local | ✅ | Ubuntu 24.04 with systemd, sshd, rsync, tmux and Git. The fixture has a stash, staged, unstaged, untracked and ignored changes, a linked worktree, a shell and a mocked Claude. It checks the manifest, Git, trees, state, both owners, the gateway, journals and the resume argv. |
| Do 1: promote `claude.mjs`, a Codex mock if one exists | ✅ | Codex was skipped for a stated reason: its fixture writes under `$ARCHI_HOME`, so a handover could not carry it. |
| Do 2: kill and drop at the boundaries, both directions | ✅ | Kill at 5 boundaries, drop at 4. `drop@activate` fires on the `activate` event right after Commit returns (row 19: `commit@2582`, `activate@2670`), so it stands in for a drop right after Commit. |
| Do 2: recovery only by the action `status` offers | ✅ | Before Commit, `safe` includes `abort`, then `--abort`. After Commit, `safe` is exactly `["resume"]`, then `--resume`. |
| Spec: pre-commit abort revives only the source; post-commit retry activates only the destination; the source never reactivates | ✅ | `runsFleet` on the owner, `holdsNothing` on the other machine, and the stopped snapshot (`source stays down`, `destination not started`/`waits`). |
| Spec "Failure and recovery": no destination window before Commit; the source stays fenced after it; status is rebuilt after the controller dies | ✅ | fleet-handover.mjs:340-351 |
| Spec "Ownership authority": gateway record, generation, no transaction left | ✅ | `gatewayIs`, `noJournals`, generation tracked across 20 handovers |
| Do 6: `integration` job; trigger unchanged | ✅ | Trigger stays `workflow_dispatch`. All five action tags exist (checked through the GitHub API). |
| Do 6: rsync tests fail instead of skipping in CI | ✅ | The test job builds `vendor/rsync` and sets `ARCHI_REQUIRE_RSYNC`. RED and GREEN were rerun (below). This closes Task 23's minor. |
| Do 7: `docs/integration.md` | ✅ | Accurate, except the two claims in M2 |
| Ruling "one script, two hosts" | ✅ | The CI job is only the wrapper call, and the wrapper takes the Docker host's own architecture. |
| Verify: every scenario, both directions, recorded | ✅ | `full-arm64` shows ALL PASS for 20 handovers. The artifacts were inspected. |
| Verify: both architectures | ❌ | x86-64 was not run. The reason holds up (Concern 1), but it needs a ruling. |

## Findings

### Critical

None.

### Important

None.

### Minor

**M1. `drive` can read the result before the controller's stdout is drained.**
- **Where:** `scripts/integration/machine.mjs:217` and `:262-267`.
- **Evidence:** `exited` resolves on the child's `exit` event. Node documents that stdio may still be open at `exit`.
  Two things can then go wrong:
  - `summary.result` is taken before readline has delivered the final `handover.result` line.
  - `log.end()` runs before the last `log.write`. That write raises a write-after-end `error` with no listener, which
    crashes `drive`.

  Either way the result is a spurious failure of a clean or drop scenario, never a false pass. None was seen in about
  40 handovers, but the first CI runs will be on a different machine under different load.
- **Fix:** resolve `exited` on `close`. Nothing the controller spawns inherits its stdout: ssh and rsync get pipes,
  and the master gets `ignore`. So `close` still fires promptly after a SIGKILL.

**M2. The docs and report claim two checks the code does not make.**
- **Where:** `fleet-handover.mjs:416` and `:315`; `docs/integration.md:77,85-86`; the report's step 4.
- **Evidence:**
  - Only the turn on remote (`:408-414`) checks that the transcript grew by 2 records in the same file. The turn
    after remote → local (`:416`) checks nothing. Yet the docs say every handover checks that "the next turn appends to
    the same file". A resumed agent writing to a new transcript on local would go unseen, because each later base is
    taken after that turn.
  - The report says fleet.json "names remote as gateway on both sides". `:315` checks `gatewayMachineId` only on
    `now`.
- **Fix:** move the transcript check into `turn()` and use it for both turns. Either add
  `left.fleet.gatewayMachineId === ids.remote` or drop that claim.

**M3. The `--resume <sessionId>` argv check exists only in `clean()`.**
- **Where:** `fleet-handover.mjs:311-313`, against `runsFleet` at `:224-245`.
- **Evidence:** fault recoveries rest on the state's session id and pid. That does catch a fresh session: activation
  waits for the SessionStart (`destination.ts:697`), and the hook overwrites `sessionId`. But the no-resume mutant was
  run only with `--scenarios none`, and the brief asks for "resumed under its session id" on every move.
- **Fix:** move the `resumed` check into `runsFleet`. After the round trip every agent was started with `--resume`,
  so the check holds for the untouched agent at Begin too.

**M4. `noJournals` misses a quarantined journal.**
- **Where:** `fleet-handover.mjs:216-221`.
- **Evidence:** `handover.status` returns `quarantined` with no `transaction` when a journal was unreadable
  (`protocol/src/messages.ts:305-309`, `service.ts:79`). The check reads only `transaction` and `error`, so a
  quarantined journal passes it.
- **Fix:** add `&& !s.handover?.quarantined`.

**M5. The controller's stderr never reaches the output folder, and the default output lands in the checkout.**
- **Where:** `fleet-handover.mjs:281-285` and `:41`, with `machine.mjs:216`.
- **Evidence:**
  - `drive` writes the controller's stderr to `/tmp/it/<label>.ndjson.stderr` inside local. The driver copies the
    `.ndjson` out, but not this file. On CI, a controller that dies with a stack trace leaves nothing of it in the
    uploaded artifact once the containers are removed.
  - Without `--out`, logs go to `./integration-logs`, which is not in `.gitignore`.
- **Fix:** copy the `.stderr` next to the `.ndjson`. Default `--out` to a temp folder, or ignore `integration-logs/`.

**M6. The image installs packages nothing uses.**
- **Where:** `scripts/integration/Dockerfile:9`.
- **Evidence:** nothing in the harness or product uses `socat`, and the product unpacks only `.tar.gz`
  (`install.ts:139`), so `xz-utils` is unused too. Both sit in an image whose header says it holds "the tools a
  handover drives".
- **Fix:** drop both.

## The implementer's concerns, against the spec

1. **No x86-64 run locally.** The reason holds up. Under user-mode emulation, `/proc/<pid>/cmdline` starts with the
   interpreter, so the rest classifier sees every pane as busy. That is an artefact of emulation, not a product
   defect. The architecture-specific parts of the harness are the only ones involved: `docker info` Architecture
   gives `x86_64` and then `--arch x64`, and the Dockerfile is arch-neutral.
   - The evidence owed is the first GitHub run and linus-vault (x86-64, in 37c).
   - 37b needs x86-64 under emulation anyway, for its fresh installs, and the qemu-user probe already booted systemd
     `degraded` there. Rule on a full-system x86-64 VM once, for 37b (`colima start --arch x86_64`, which needs
     Homebrew qemu and the owner's ok). Then rerun this harness on that VM with `--scenarios none`, or `all`.
2. **A killed controller leaves its ssh master.** Confirmed in the code. `ssh -M -N` runs with `ControlPersist=no`,
   and only the exit and signal handlers end it (`ssh.ts:92-104,142,156`). The per-pid socket makes it harmless to
   correctness. It is already parked for the final review (progress.md:285, M2; :609, M3 D4). Nothing new for 37a.
3. **49–108 s before the controller gives up after a drop.** This matches the gateway calls' 30 s timeouts plus
   retries, and the master's 15 s × 3 keepalive (`ssh.ts:143`). The spec sets no bound. It asks only for the
   documented action, and `status` offered it in all 8 drop runs. Carry to Task 39 (sheet copy and timeouts).
4. **A drop at activation in remote → local leaves the fleet running nowhere until the gateway returns.** The spec
   requires this. Step 7 has the destination confirm the committed record, and "Ownership authority" lets an owner
   with an unresolved journal run on its cache only once that journal is resolved. `DestinationHandover.committed()`
   asks the gateway (`destination.ts:500-523`). The sheet's wording for it is Task 39's.
5. **A resume overlapping the dead controller's activation.** The destination serializes it, so the 4 passing runs
   were not luck.
   - Every destination phase goes through one promise queue per daemon (`destination.ts:241-242,886-890`).
   - `runActivate` is idempotent:
     - the phase guards at `:488-491`;
     - `wake()` starts only slots rested by this transaction and not yet answered;
     - `wakeSlot` judges an open window by what now holds its pane.
   - The controller's resume activates before it completes (`handover.ts:350-356,655-660`), so its Complete cannot
     overtake an activation still under way.

   The queue lives in memory. A daemon restart mid-activation falls back on the journal, which 36a's faults cover.

## Verified

- **Assertions bite: Git.** I replayed the fixture, then the harness's `gitOf` commands, in a scratch HOME, and
  applied one loss at a time. Every loss was caught by at least one key: `stash`, `refs`, `fsck`, `status`, `index` or
  `worktrees`. The losses were:
  - the stash reflog;
  - `refs/stash`;
  - the stash commit object;
  - the main and worktree indexes reset to HEAD;
  - an untracked file;
  - an unstaged change;
  - the worktree's `.git` file;
  - its admin folder;
  - the `feature` ref.

  The unmodified copy was not flagged. Together with the file-by-file tree hash and the two mutants, a lost stash or
  index change fails the run.
- **No vacuous passes.**
  - Every fault asserts `trigger !== null`.
  - Each negative check has a positive counterpart run by the same snapshot code. For example, `agents.length === 0`
    on one machine and `one agent process` on the other.
  - A null snapshot throws.
  - A drop that failed to install would let the handover finish, and the `not committed` or `status offers resume`
    check fails then. The recorded summaries show `drop 2` and `restore 0`.
- **Fault exactness.** The release shim `exec`s node (`release-stage.mjs:170`), so SIGKILL of `child.pid` is the
  controller itself. At a gateway operation, the driver waits for the orphaned ssh to exit.
  - The whole-session kill at transfer barely differs from killing the controller alone: rsync writes progress to the
    controller's pipe (`rsync.ts:183`), so an orphaned rsync dies at its next write.
- **Deterministic waits.**
  - Every wait is a bounded poll.
  - `char wait --until done,idle` cannot return before the turn: `char.run` marks the agent `working` before it
    returns (`fleet.ts:841-852`), and the mock posts Stop after both transcript records.
- **Cleanup.**
  - Containers and the network go in `finally` unless `--keep`, and leftovers are removed when a run starts.
  - The wrapper traps its temp folder.
  - There are no volumes. The `archi-it:latest` image is kept on purpose.
- **Nothing sensitive mounted or logged.**
  - No host mounts: only `docker cp` of the archive and two scripts.
  - The private key never leaves local.
  - `run.log` names the checkout path of whoever runs it (here under `/Users/…`, on CI the runner's workspace). It
    holds no secrets and is not a release artifact.
- **Quoting.** The harness's shell strings interpolate only its own constants and ids the product generated. The only
  product-adjacent change is the three test guards.
- **`ARCHI_REQUIRE_RSYNC`, rerun here.**
  - With a missing rsync and the flag: 2 files failed, each with `no rsync 3 at /nonexistent/rsync`.
  - With vendor/rsync and the flag: 3 files, 77 passed and 1 skipped.
  - With a missing rsync and no flag: 41 passed and 14 skipped, the old behaviour.
  - No other test file skips on rsync (grep over `skipIf`/`describe.skip`).
- **CI.**
  - The action tags `cache@v6`, `upload-artifact@v7`, `checkout@v7`, `setup-node@v7` and `action-setup@v6.1.0` all
    exist.
  - The cache key and `bundledRsync()`'s `vendor/rsync/<ver>-<arch>` path agree.
  - `@archipelago/protocol` exports its sources, so a fresh checkout needs no build step before `build-companion`.
  - The daemon and gateway log paths the driver tails match `linux/setup.ts:41-42`, and the recorded
    `*.daemon.log` files are non-empty.
- **Run evidence.** The folder is `scratchpad/it/full-arm64`: 20 summaries, stopped snapshots and recovery streams,
  matching the report's table. Examples: row 04, `phases: []` with Begin landed; row 20, "the gateway could not say
  who owns this fleet".
- **Not rerun:** docker scenarios, actionlint, shellcheck and typecheck. The report records them, and the change gives
  no reason to doubt them.
