# Task 23 report: controller rsync engine and progress journal

Status: DONE_WITH_CONCERNS. Commit `abad9db The Mac mirrors a verified fleet replica in either direction`
on `fleet-handover-task23` (from 9c939f6). No attribution lines.

## What was implemented

### `packages/cli/src/controller/rsync.ts`: the rsync command layer

- **Pinned feature set.** `MIN_RSYNC = 3.2.3` (`-s`, `--info=progress2` and `--mkpath` all exist from
  this version on). `probeRsync(exe)` runs `--version`. It refuses openrsync by name ("cannot protect
  remote arguments or report byte progress"), anything older than 3.2.3, and output it cannot parse.
  `resolveRsync()` throws the probe's reason.
- **Bundled binary.** `bundledRsync()` returns `<ARCHI_RELEASE_ROOT>/bin/rsync` in a release and
  `vendor/rsync/<pinned>-<arch>/rsync` in a checkout. The artifact build needed no change:
  `scripts/build-controller.mjs` (Task 12) already copies the pinned 3.4.4 into `<release>/bin/rsync`.
- **Remote shell, argv-safe.** `remoteShell(socket)` builds `ssh -S '<socket>' -o BatchMode=yes --`.
  The socket is quoted for rsync's own `-e` splitter: a quoted span keeps its spaces, and a doubled
  quote is one quote. I read this in rsync 3.4.4's `do_cmd` and proved it with a socket dir named
  `sock dir 'q'`. rsync appends the host after these words, so the single `--` lands right before the
  host, the same way `SshMaster.run` places it.
- **Placeholder host `archi-remote`.** rsync is never given the real destination. It would split
  `user@host` and insert `-l user` after the `--`. ssh reaches the far machine only through the master's
  socket. With no master, `archi-remote` resolves nowhere, so nothing falls back to an unmultiplexed
  connection.
- **Remote wildcard expansion (found while testing).** With `-s`, rsync's server passes every file
  argument through `glob_expand`, one path component at a time, for any component holding `*`, `?` or
  `[` (rsync 3.4.4 `io.c:read_args`, `util1.c:glob_match`). In a real test, pushing to an unescaped
  `dst[1]/` wrote into the sibling `dst1/`.
  - `remoteSpec()` escapes those components and the backslashes in them. An escaped name matches only
    a path that exists.
  - A root's far path always exists: the claim created or proved it, and a pull source must exist.
  - An exact file whose far destination holds a wildcard is refused, because it may not exist yet.
- **Filter file.** `filterRules(excludes)` writes `GIT_KEEP_RULES` first, then one `- <pattern>` line
  per exclude. An empty pattern, or one with a control character, is refused, because a newline would
  inject a rule. The file is passed as a single argv element, `--exclude-from=<file>`.
- **argv.**
  - Always: `-rlpt --no-specials --no-devices -s -8 --itemize-changes --no-human-readable`.
  - Then `--info=progress2` for a copy, or `--dry-run --checksum` for verification.
  - `--delete` only when the caller asks. `--mkpath` for exact files.
  - Then `-e <rsh>`, `--`, source, target.
  - Never `-o`/`-g`, never `--delete-excluded`, never `--partial`.
- **Parsing.** `parseLine` reads three kinds of line:
  - itemize lines (`YXcstpoguax name`, and `*deleting name`);
  - progress2 lines (bytes, plus `to-chk`/`ir-chk` turned into done/total);
  - everything else, as text.
- **Running rsync.** `runRsync` streams stdout through a `StringDecoder`, split on `\r` and `\n`, so a
  multibyte name split across chunks stays whole.
  - It keeps a bounded tail of stderr.
  - It strips every `RSYNC_*` variable from the environment. `RSYNC_ICONV` is read before `-s` takes
    effect.
  - On abort it sends SIGTERM, then SIGKILL after 2 s.
- **Exit codes.** `exitKind` reads 0 as ok, 24 as vanished (the source changed), and 10/12/30/35/255
  as disconnected. Everything else is failed.

### `packages/cli/src/controller/progress.ts`: durable, advisory journal

- `transactionDir(txid, base = configDir())` is `~/.config/archipelago/handover/<encoded txid>/`, the
  registry's state dir. The name is never `.` or `..`.
- `ProgressJournal` keeps one `progress.json` per transaction.
  - It is mode 0600, written with archid `writeDurable`: same-directory temp, fsync, rename, then a
    directory fsync.
  - It holds one `EntryProgress` per entry: state, pass, done/total (rsync's counts), bytes, totalBytes
    (from the manifest), items, exitCode, signal, error and verifiedKey.
  - A change of state is written at once. Progress within a state is written at most once a second.
  - A journal that cannot be read is treated as absent.
- `writeFilter(id, rules)` writes each root's filter to `<txdir>/filters/<id>.rules`, mode 0600.

### `packages/cli/src/controller/transfer.ts`: the engine

- **Input is data (ruling 1).**
  - `RootEntry { id, entry: dir|file, sourcePath, destinationPath, claim: { excludes, check:
    ReplicaCheck }, files }`.
  - `FileEntry { id, sourcePath, destinationPath, file }`.
  - Plus `roles` (explicitly `{source:'local',destination:'remote'}` or the reverse), `master:
    { socket }` (an `SshMaster` satisfies it), the resolved rsync, `stateDir`, `signal`, `secrets`,
    `onProgress`, and `deps` (run, scanFs, readFile, now).
- **Writes only where the claim says (ruling 2).**
  - A root whose `check.ok` is false is never written. It comes back `blocked` with the destination's
    own blocker, and the other entries go on.
  - An ok root is written only to `check.path`. `destinationPath` never appears in any argv (tested).
  - `--delete` is used only for an ok-claimed directory root.
  - Exact files never get `--delete` or a filter; they get `--mkpath`.
- **Exactly the claim's excludes, never `--delete-excluded` (controller note).** A root has one exclude
  list: `claim.excludes`. Both the filter file and the verification re-hash use it, so rsync cannot run
  under different excludes than the ones the replica was proved under.
- **Passes and verification (ruling 4).** Each pass is one real rsync run. Verification then:
  1. re-hashes this Mac's side against the manifest's files with archid `proveReplica`, under the claim's
     excludes (the source when pushing, the claimed copy when pulling);
  2. runs the same argv as `--checksum --dry-run`, where any itemized line counts as a difference.

  It needs no new RPCs.
  - A diverged re-hash, a dry-run difference, or exit 24 makes the pass unstable.
  - After three unstable passes the entry is blocked with a new `external_writer` blocker naming up to
    five changed paths.
  - The spec's "after three unstable passes" takes precedence over the brief's "retry at most three
    times".
- **Failures.**
  - Exit 23 and any other nonzero exit are `failed/rsync`. 255 and the other link codes are
    `failed/disconnected`.
  - Both keep the exit code and the last stderr lines. The transfer stops there, and the entries after
    it stay `pending`.
  - An rsync that cannot even start counts as a failed run.
  - A refused entry (a bad path, a wildcard in a far exact-file path, a bad exclude) fails on its own,
    and the others still run.
  - A clean exit only ends the run. The entry counts as verified only once the checksum compare agrees.
- **Resume (ruling 3).** Progress is advisory. A root skips its copy only when both hold:
  - the journal's `verifiedKey` equals this run's key (roles, source, target, excludes, manifest files);
  - a fresh verification still passes.

  Otherwise the root is copied again. The key is cleared as soon as a pass starts.
- **Cancellation.**
  - The signal kills the running rsync.
  - The entry is recorded as `cancelled` with its partial counts, and the rest stay `pending`.
  - Nothing is deleted. The claim stays `receiving`, and the journal and filter files remain for a
    resume.
- **Redaction (ruling 6).** Every error and blocker the engine records (the outcome, the journal, the
  events) passes through `redact`. The redacted values are the caller's `secrets`, plus every value of
  8 characters or more in the `.env` files among the entry's local files.

### Supporting changes

- `packages/archid/package.json` exports `./handover/inventory`, `./handover/divergence` and
  `./handover/durable`. archid still imports nothing from cli.
- `packages/protocol/src/handover.ts` adds `external_writer` to `HandoverIssueCode`, and the protocol
  test's list gains it.
- The fake ssh (`packages/cli/test/fixtures/ssh.mjs`, `packages/cli/test/controller/fake-ssh.ts`) gains
  `execute({ rsync, cutAfterBytes })`.
  - It runs the far command locally through `/bin/sh -c`, the way ssh hands the line to a login shell.
  - It runs only while its master is up, and dies with the master.
  - A cut drops the master once N bytes have crossed, as a network drop would.

## Tests and results

Verify command, on the final code:

```
$ pnpm vitest run --project cli test/controller/rsync.test.ts test/controller/transfer.test.ts
 ✓ |cli| test/controller/rsync.test.ts (18 tests) 12867ms
 ✓ |cli| test/controller/transfer.test.ts (20 tests | 1 skipped) 67967ms
 Test Files  2 passed (2)
      Tests  37 passed | 1 skipped (38)
```

The one skip is the env-gated live test. It ran on its own against the Linux box:

```
$ ARCHI_TEST_SSH=100.117.42.24 pnpm vitest run --project cli test/controller/transfer.test.ts -t "real Linux rsync"
 ✓ transfer with a real Linux rsync > mirrors a hostile tree to the Linux rsync and back, with its excludes read the same 3196ms
 Tests  1 passed | 19 skipped (20)
```

- The test runs its own master with `UpdateHostKeys=no` and `StrictHostKeyChecking=yes`.
- `~/.ssh/known_hosts` md5 was `1f403c13…` before and after the run.
- It wrote only into `mktemp -d /tmp/archi-rsync-XXXXXX`, which was removed afterwards
  (`ls -d /tmp/archi-rsync-* | wc -l` → 0).

Test list against the brief:

- **Spaces, unicode and hostile names.** Real rsync through the fake ssh master, push then pull back.
  - The root is named `app $(x) 'q' [1]`, and an empty decoy sibling `app $(x) 'q' 1` exists.
  - The tree holds `-rf`, `--delete`, `$(touch pwned)`, `it's "q"; x`, `glob[1]*?.txt`, `back\slash`,
    `sp ace/ö dir/smörgås 🍞.txt` and a symlink.
  - Result: the content is identical both ways, verified at pass 1, the decoy stays empty, and no path
    appears on the far shell's command line.
  - The live test repeats this against Linux rsync 3.2.7.
- **Excluded caches.** A replica's own `node_modules/far-only.js` survives `--delete`. The source's
  `node_modules/` is not copied. A non-excluded destination-only `stale.txt` is deleted.
  `.git/refs/heads/build/x` travels despite the `build/` exclude.
- **Partial exit.** Exit 23 with a "Permission denied" warning gives `failed/rsync` with code 23. The
  journal keeps `state:failed, exitCode:23, items:1, bytes:1, done:2, total:3` (mode 0600). No
  verification runs, and the next entry stays `pending`. A separate test shows that exit 0 with a stderr
  warning is still not verified until the checksum compare agrees.
- **Disconnect and resume.**
  - Scripted: 255 gives `failed/disconnected`, and a resume copies again.
  - Real: the fake ssh cuts the link after 2 MiB of a 6 MiB root. The journal keeps the partial bytes.
    A resume on a newly opened master finishes, verifies, and sends fewer bytes than a full copy.
- **Resume skip.** A verified root with the same key and a clean re-verify gets `passes: 0` and no copy.
  A moved claim path forces a copy. A copy that no longer matches forces a copy.
- **Source mutation.**
  - A source edited after every pass is blocked with `external_writer` after exactly three passes, both
    scripted and with real rsync.
  - A transient swap file, followed by exit 24 (vanished), settles and verifies at pass 3.
  - A pulled copy that keeps differing from the far source is also blocked.
- **Destination reservation.**
  - A root is written only to `claim.check.path`, with its claim's excludes, and `/far/mapped` never
    appears in any argv.
  - An unclaimed root (`ok:false`) is blocked with the destination's blocker, and nothing touches it.
  - An exact file gets no `--delete` and no filter, only `--mkpath`, into a folder that did not exist
    yet. The file beside it survives.
- **Both directions.** Push and pull, scripted and real, including the live Linux run.
- **Cancellation.**
  - Scripted: the running rsync gets the abort, the entry is `cancelled` and the rest `pending`.
  - Real: abort on the first itemized file. No rsync, and no ssh on the master's socket, remains. A
    resume verifies.
- **Redaction.** A token, and a `.env` value (`export API_KEY="sk-live-…"`), become `[redacted]` in the
  outcome, the progress events and `progress.json`. The 4-character `8080` is kept.
- **The rsync layer.**
  - Probe: accepts 3.4.4; refuses openrsync, 3.1.3, and a missing binary.
  - Path lookup: release vs checkout.
  - Wildcard escaping, filter rules and argv invariants.
  - Parsing, including unicode progress lines.
  - `runRsync`: a character split across writes, `RSYNC_*` stripped, cancel.
  - Real rsync through the master: exactly one `--` before `archi-remote`, the exact socket path, and no
    path on the far command line.
  - A real wildcard target lands where it names.
- **Exclude parity (carried obligation).** A dry run of the real rsync 3.4.4 with the generated filter
  file carries exactly the file list of archid's `scanPath` + `excludeMatcher`.
  - The tree includes `.git/refs/heads/build/x`, `.git/worktrees/dist/HEAD`, `.git/node_modules/x`, a
    `sub/.git` gitfile, and a live unix socket at `.git/fsmonitor--daemon.ipc`, which is skipped.
  - The excludes are the defaults plus `/root-only.txt`, `logs/**/*.log`, `*.swp` and `cache?/`.
  - Both sides keep `logs/a.log` and drop `logs/deep/b.log`.
  - On Linux samba rsync 3.2.7, the live test pushes everything with no excludes, then pulls with the
    excludes, so 3.2.7 is the sender applying them. What arrives, scanned with no excludes, equals
    `scanPath(src, excludes)`.

### Which rsync versions ran

- **Local rsync 3.4.4, protocol 32.** The pinned bundled build, copied into this worktree's gitignored
  `vendor/rsync/3.4.4-arm64/` from the impl worktree's Task 12 build. It is both ends of every fake-ssh
  test, and the parity test.
- **Linux rsync 3.2.7, protocol 31, samba.** On 100.117.42.24, Ubuntu 24.04 x86_64. It is the far end
  of the live test in both directions, and the sender that applies the excludes on the pull.
- **openrsync.** Used only as the refused case in the probe test.

### Full suite and typecheck

- `pnpm typecheck` passes (exit 0).
- `pnpm vitest run --project protocol` passes: 106 tests.
- `pnpm vitest run --project cli`: 263 passed, 44 failed, 3 skipped.
  - Every failure is a timeout (33 × 5000 ms, 6 × 20000 ms, 2 × 60000 ms, 2 `waitFor` timeouts) or an
    ssh master failing to open, across `ssh`, `install`, `cli`, `connection`, `connect`, `host`, and the
    two real `rsync.test.ts` tests.
  - Cause: this Mac ran at load average 155–192 on 18 cores, from other sessions' vitest runs. Node
    alone took 0.35–0.76 s to start.
  - Baseline check: I restored HEAD's `ssh.mjs` and `fake-ssh.ts` and ran `ssh.test.ts` +
    `install.test.ts` alone at load 192. The same timeouts appeared (8 failed), so they predate this
    change.
  - The failing files other than the two rsync tests import none of the new modules.
  - The two real tests in `rsync.test.ts` now carry a 60 s timeout, like the real `transfer.test.ts`
    tests, and they pass.

## TDD evidence

- **RED, rsync layer.** `pnpm vitest run --project cli test/controller/rsync.test.ts` failed with
  `Error: Failed to load url ../../src/controller/rsync.js ... Does the file exist?`. This was expected:
  the tests came first and the module did not exist yet.
- **GREEN, rsync layer.** The same command gave `✓ |cli| test/controller/rsync.test.ts (18 tests)`.
- **RED, engine.** `pnpm vitest run --project cli test/controller/transfer.test.ts` failed with
  `Error: Failed to load url ../../src/controller/progress.js ... Does the file exist?`. This was
  expected: `progress.ts` and `transfer.ts` did not exist yet.
- **First run after writing the engine: 8 failed.**
  - Most were `ENOENT ... progress.json`. This was a real bug:
    `this.o.onProgress?.(this.journal.put(...))` never evaluates its argument when there is no listener,
    so the journal was never written. Fixed by computing the record first.
  - The rest were default 5 s timeouts on the real tests.
- **GREEN, engine.** The transfer tests gave 19 passed, 1 skipped. Final run: see the verify command
  above.
- **Mutation checks.** Each was applied to the implementation, then restored.
  - Putting `GIT_KEEP_RULES` after the excludes fails the parity test: real rsync drops
    `.git/refs/heads/build/x`, `.git/worktrees/dist/HEAD` and `.git/node_modules/x`.
  - Removing the wildcard escaping fails the wildcard test: real rsync wrote into the sibling.
  - Writing a root to `destinationPath` instead of the claim's path fails two engine tests.
  - Allowing `--delete` on exact files fails the claim test.
  - Dropping the `check.ok` guard fails the unclaimed-root test.

## Files changed

- Created:
  - `packages/cli/src/controller/rsync.ts`, `transfer.ts`, `progress.ts`
  - `packages/cli/test/controller/rsync.test.ts`, `transfer.test.ts`
- Modified:
  - `packages/cli/test/fixtures/ssh.mjs`, `packages/cli/test/controller/fake-ssh.ts`
  - `packages/archid/package.json` (exports)
  - `packages/protocol/src/handover.ts`, `packages/protocol/test/handover.test.ts`

## Self-review findings

- Every brief step is covered, and so is every test in the brief's list. So are rulings 1–6, the carried
  obligations (`--no-specials --no-devices`, Git keep rules first, real-rsync parity), and the
  controller note (claim excludes only, no `--delete-excluded`). Each is enforced in code and has a
  test.
- File sizes stay within the plan's intent: rsync 194, transfer 323 and progress 88 lines.
- Comments are short and say why.

## Concerns

1. **The doctor does not flag openrsync yet.** `probeRsync` is exported. `archi doctor` on the Mac
   should call it on `bundledRsync()` and warn when the bundled binary is missing or refused. I left
   `doctor.ts` alone because it is not in this task's file list.
2. **The far rsync needs 3.2.3 or newer**, because `--mkpath` and `-s` are sent to the server. Ubuntu
   22.04 and 24.04 meet this. The engine does not check the far version. Task 15's host doctor only
   prints it, so an older far rsync would fail as `failed/rsync` with rsync's own message.
3. **The far path must exist when it holds a wildcard.**
   - An escaped wildcard component matches only a path that exists.
   - Exact files with such a far destination are refused.
   - A root relies on its claim having made the path. If someone deleted the root between the claim and
     the copy, rsync would create a directory whose name holds literal backslashes. That is harmless
     but wrong.
4. **No `--partial`.** A file cut off mid-transfer restarts from zero on resume; finished files are
   skipped. This keeps partial directories out of the roots, as Task 20's concern 5 asked.
   - A receiver that was SIGKILLed leaves its `.name.XXXXXX` temp in the root.
   - The same transaction's next pass deletes it with `--delete`.
   - A different transaction's claim would read the temp as `added`, which is the safe side.
5. **Wire change.** `external_writer` is a new `HandoverIssueCode`. Task 27, the CLI and the sheet must
   know it. It falls under the handover protocol bump that has already happened.
6. **Nothing removes the transaction's files yet.** No API removes `<txdir>` after Complete. That
   belongs to Task 27.
7. **Git housekeeping counts as a writer.** An IDE that runs `git status` refreshes `.git/index`. That
   makes a pass unstable and can reach `external_writer`, the same issue as Task 20's concern 1.
8. **The real-rsync tests are slow on a loaded machine.** Each spawns several node processes for the
   fake ssh and the master. The two files took about 80 s at load average 160. At normal load node
   starts in about 50 ms, and they should take a few seconds.

## Fix round 1

Commit `55da9b5 A pass verifies against the pass before it, the far rsync and a lost master are told apart, and doctor flags a Mac without its bundled rsync`, on top of abad9db. There are no attribution lines.

### 1 (Important): the verification baseline moves with each pass

**What changed in `transfer.ts`.**
- Each pass is checked against the scan taken after the pass before it. Pass 1 is checked against the manifest.
- A pass is stable when two things hold: this Mac's side (the source when pushing, the claimed copy when pulling) reads the same as that previous scan, compared with archid `proveReplica` on content and mode; and the checksum dry run is clean.
- The baseline is now the latest read. So a source edited once after Freeze verifies on the next pass. Before, it stayed different from the frozen manifest and ended in `external_writer` forever.
- A root that still has no two equal scans in a row, or a dirty dry run, after three passes is `external_writer`, as before.

**What the outcome returns.** A verified outcome now carries `files`: the scan that verified, which is what actually landed.
- For an exact file, the entry's own manifest path is restored.
- The progress journal keeps `verifiedScan`, a digest of path, content and mode, next to `verifiedKey`.
- On resume, a root skips its copy only when both hold: a fresh scan has that same digest, and the checksum dry run is clean.
- Otherwise the fresh scan becomes pass 1's baseline, and the resume converges.

**Which side the blocker names.**
- A scan that moved between passes names the source. In a pull, every pass rewrites the local copy to match the source, so a copy that moved means the source moved.
- On a dirty dry run, this Mac's side is scanned again. If it moved during the compare, the blocker names it: the source when pushing, `the local copy <path>` when pulling. If it held still, the blocker names the far side: `the far copy <claim path>` when pushing, the source when pulling.
- Message shape: `the source|far copy|local copy <path> kept changing through 3 passes (<names>); close whatever writes there, then resume`.

**Found while testing this: quick-check could miss an edit.** A real-rsync run of "edit once during pass 1" still blocked. Pass 2's quick check (size and whole-second mtime; `modify_window` 0 in rsync 3.4.4 `util1.c:same_time`) skipped an edit of the same size made within the same second. The dry run then flagged it on every pass. Pass 2 onwards now copies with `--checksum`; pass 1 keeps the cheap quick check. A new `RsyncJob.checksum` sets this.

### 2: the far rsync is probed, and a lost master is told apart from a far rsync failure

**The far probe.** `transfer()` first runs `rsync --version` on the far machine once, over the same master.
- It uses the new `Master` type: `{ socket, run, check }`, which `SshMaster` satisfies.
- A missing rsync (exit 126/127), one older than 3.2.3, openrsync, or any other nonzero exit returns `status: 'blocked'` with a new blocker, `rsync_unsupported`. All entries stay `pending`, and nothing is copied.
- An ssh failure (255 or no exit code) returns `status: 'failed'` with a new top-level `failure: { reason: 'disconnected', code, error }` (redacted).
- `rsyncVersion(out)` is now split out of `probeRsync`, so the far probe and doctor read versions the same way.

**Telling the link from the far rsync.** After exit 10, 12, 30, 35 or 255, `settle` asks `master.check()`. The failure is reported as `disconnected` only when the master is gone. While it still answers, the failure is `failed/rsync` with rsync's exit code and message, so Task 27 does not reconnect in a loop.

**Protocol.** `packages/protocol` gains `rsync_unsupported` in `HandoverIssueCode`, and the protocol test lists it.

### 3: `archi doctor` flags a Mac without its bundled rsync

- `doctor.ts` adds an `rsync` row on macOS only (after `launchd`). It is not part of `preflight`, so `archi setup` is unaffected.
- The row is `ok` when the bundled binary reports `3.4.4 at <path>`.
- Otherwise it is `warn`, the same status as tmux 3.4, a lost feature. The detail names three things:
  - what the bundled path is ("is not there", or the version reason);
  - what `rsync` on PATH is (e.g. openrsync);
  - the fix: `reinstall Archipelago; its release carries one in bin/` in a release, or `build it with node scripts/build-controller.mjs` in a checkout.
- It gets its dependencies through a new `DoctorDeps.rsync { bundled, fix }`.
- Linux has no row. The companion sends with its system rsync, which the host doctor checks and which the transfer now probes.

### 4: the placeholder host is `archi-remote.invalid`

`REMOTE_HOST` is `archi-remote.invalid`. RFC 6761 `.invalid` never resolves, so a dead master cannot fall back to some host that a search domain or MagicDNS resolves.

The argv test now asserts the literal `['-S', socket, '-o', 'BatchMode=yes', '--', 'archi-remote.invalid']`, and `remoteSpec` expectations use the literal.

### RED, captured before each change

- **Item 4:** `pnpm vitest run --project cli test/controller/rsync.test.ts -t "remoteSpec|rides the master"` gave:

  ```
  × remoteSpec > escapes the names rsync's server would expand as a wildcard, and nothing else
  × rsync 3 through the ssh master > rides the master's socket with one `--` before the host, and sends no path through the far shell
  Expected: "archi-remote.invalid:/home/li nus/it's $(x)/"
  Received: "archi-remote:/home/li nus/it's $(x)/"
  ```

- **Items 1 and 2:** `pnpm vitest run --project cli test/controller/transfer.test.ts -t scripted` gave 9 failed, 10 passed. The finding reproduces:

  ```
  × verifies on the next pass once a source edited during the first is left alone, and returns what landed
    AssertionError: expected 'blocked' to be 'verified'
  × refuses a far rsync that is missing, too old or openrsync before it copies anything
    AssertionError: expected { status: 'verified', …(2) } to deeply equal { status: 'blocked', …(2) }
  × stops before copying when the far rsync cannot be asked over a dead link
  × reads an exit of 12 or 255 as a lost link only when the master is gone, and a resume copies again
  × writes a root only where its claim says, … (no `files`, no far probe)
  × passes again while the source keeps changing, and after three unstable passes names it
  × names the far copy when the source holds still and the copy keeps differing
  × names the far source when a pulled copy that holds still keeps differing from it
  × names the local copy when something writes into it while it is compared
  ```

- **Quick-check (item 1):** the real test `lands a source edited once during the first pass on the second` first failed with `"status": "blocked"`, as described above. The scripted and argv tests then failed before the change: `expected [ false, false ] to deeply equal [ false, true ]`, and `rsyncArgv … ArrayContaining{… '--checksum' …}`.

- **Item 3:** `pnpm vitest run --project cli test/doctor.test.ts` gave `TypeError: Cannot read properties of undefined (reading 'detail')` and `expected undefined to deeply equal { name: 'rsync', status: 'warn', … }`.

### Tests added or changed

**`transfer.test.ts`, scripted:**
- `refuses a far rsync that is missing, too old or openrsync before it copies anything` (127, 3.1.3 and openrsync).
- `stops before copying when the far rsync cannot be asked over a dead link`.
- `reads an exit of 12 or 255 as a lost link only when the master is gone, and a resume copies again`.
- `verifies on the next pass once a source edited during the first is left alone, and returns what landed` (checks the landed hash against the manifest's).
- The three side-naming tests (source, far copy, local copy), and `passes again while the source keeps changing, …`.
- `does not take a clean exit …` now also asserts that pass 1 does not use `--checksum` and pass 2 does.
- The first test asserts the returned `files`, and that the far probe runs once for two entries.

**`transfer.test.ts`, real rsync over the fake ssh master:**
- `refuses a far rsync too old for protected arguments before it copies anything` (the far `rsync` is a 3.1.3 stand-in; nothing is written).
- `lands a source edited once during the first pass on the second, and hands back that scan`.
- The live Linux test now uses a `Master` built on its own ssh master (with `run` and `-O check`).

**`rsync.test.ts`:** the `.invalid` host literal, and the argv for `checksum: true`.

**`doctor.test.ts`:**
- The healthy report shows `rsync 3.4.4 at <path>`.
- `flags a Mac left with only the system openrsync, or an rsync too old, and names the fix`.
- Linux has no `rsync` row.

### GREEN

```
$ pnpm vitest run --project cli test/controller/rsync.test.ts test/controller/transfer.test.ts test/doctor.test.ts
 ✓ |cli| test/doctor.test.ts (16 tests)
 ✓ |cli| test/controller/rsync.test.ts (18 tests)
 ✓ |cli| test/controller/transfer.test.ts (27 tests | 1 skipped)
 Test Files  3 passed (3)
      Tests  60 passed | 1 skipped (61)

$ pnpm vitest run --project protocol test/handover.test.ts
      Tests  26 passed (26)

$ pnpm typecheck
typecheck exit=0

$ ARCHI_TEST_SSH=100.117.42.24 pnpm vitest run --project cli test/controller/transfer.test.ts -t "real Linux rsync"
 ✓ … mirrors a hostile tree to the Linux rsync and back, with its excludes read the same
      Tests  1 passed | 26 skipped (27)
```

- For the live run, `~/.ssh/known_hosts` had the same md5 before and after, and there were no `/tmp/archi-rsync-*` directories left on the box. The far probe read Linux rsync 3.2.7.
- The local side is still the bundled 3.4.4 build.

**Full cli suite.** It ran at load average about 30 this time: 314 passed, 1 failed, 3 skipped. The one failure is `cli.test.ts > archi browser opens, lists and closes tabs`, which timed out at 5039–5168 ms. It fails the same way with `doctor.ts` restored to HEAD. The only other code change to the `archi` entry point is Task 23's new doctor import, so it predates this round; that test drives the CLI binary several times under a 5 s budget.

### Concerns after this round

1. **Task 27 must seal `files` from each verified outcome, not the manifest's lists.** The manifest digest stays the transaction's identity.
2. **In a pull, a scan that moved between passes is always put down to the far source.** Every pass rewrites the local copy, so that is the only side that can move the scan once the dry run was clean. A local writer that lands exactly between a copy and the scan that follows it would be named as the source.
3. **Later passes cost more.** Pass 2 and pass 3 copy with `--checksum`, which reads every file on both sides. Only a root that was unstable ever reaches them.
