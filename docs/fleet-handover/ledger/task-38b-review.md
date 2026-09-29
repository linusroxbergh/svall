# Task 38b — review

**Verdict: Needs fixes.** 0 Critical, 2 Important, 4 Minor.

The performance changes are correct. None of them changes what a handover carries. The manifest stays deterministic, and a slow terminal viewer no longer grows the daemon or blocks other viewers. When a viewer falls behind, it gets a screen resync; it does not silently lose output. There are two gaps. First, process memory still grows about 5 KB per file, and nothing refuses a handover before a daemon runs out of heap. The task brief's Do 5 asks to bound memory as well. Second, one of the three bound tests cannot fail.

## Spec and brief compliance

| Item | | Note |
| --- | --- | --- |
| Benchmark on small, large-file and ≥50k-file repositories, first and incremental | ✅ | `scripts/bench/`. 40 handovers across 4 fixed-build runs, all complete |
| Wall time, peak RSS of the controller and both daemons, event count/volume, rsync RSS | ✅ | Measured per handover, taken from `/proc` VmHWM |
| Hashing memory | ✅ | Bounded by construction (8 streams of 64 KiB, one Git index whole) and covered by a test. Not measured separately |
| Largest RPC message | ⚠️ | Computed from `manifest.json` size plus a guessed envelope, not observed (M3) |
| Power and IO-stall state recorded; rerun documented | ✅ | The IO-stall column exists only in `bench-final2`. Power and thermal state are missing for the `bench-fixed*` runs (M3) |
| Doc numbers are the script's output | ⚠️ | True within rounding, except the 92.9 s base run, the Mac scan timings and the tmux measurement (M3) |
| Void runs excluded honestly | ✅ | The two charging base runs (404.5 s, 960.3 s) and the base small run (68 % charging) are cited nowhere in the doc |
| Bound what grows with repository size: event rate, message size | ✅ | Progress throttle test and the manifest/request caps |
| Bound what grows with repository size: memory | ❌ | Only hashing memory is bounded. Daemon and controller memory grow about 5 KB per file with no refusal before a heap crash (I1) |
| 84532f80: dangling-link lookup | ✅ | Behaves the same as before (see Verified clean) |
| c579374c: streamed session hashing | ✅ | |
| 0145948c: eight-at-once hashing, path order | ✅ | The manifest is still deterministic |
| 391ab4d4 / f8981dd8: terminal backpressure | ✅ | No silent loss; other viewers unaffected. Rejoin threshold is M2 |
| 15181f00: bounded collision list | ✅ | Bounded. Which names it shows is M1 |
| Protocol stays 17 | ✅ | `messages.ts:360`. 38b's diff touches no protocol file |
| Fault suites and integration run stay green | ✅ | `test:faults` 1302/1302 (my rerun). Integration round trip passed in each setup (see Verified clean) |
| Bound tests fail when the bound is exceeded: f5340ba1, d2373a47 | ✅ | Mutations below |
| Bound tests fail when the bound is exceeded: b4a6e8ef | ❌ | Passes under a mutation that pushes real per-file records past its bound (I2) |
| Carried: surfaces past MaxSessions | ✅ | Sound reason; measured and documented |
| Carried: double hashing at preflight and claim | ✅ | Sound: each proof guards a different moment |
| Carried: unrecorded folders and modes | ✅ | Sound: rsync carries them, and `compare()` blocks on a folder's itemized mode |
| Carried: memory as the real ceiling | ❌ | See I1: there should be a refusal before version 1 |

## Findings

### Important

**I1. Nothing refuses a handover before a daemon or the controller runs out of memory.**
`packages/archid/src/handover/source.ts:158-165,204-205`; `packages/protocol/src/messages.ts:326`; `docs/security/fleet-handover.md:324-325`.

- **The only size check.** The source's `oversize` compares the manifest's JSON against `MAX_MANIFEST_BYTES` (128 MiB). No code reads `v8.getHeapStatistics()`, `os.totalmem()` or a file count.
- **What memory grows by.** Measured: each daemon's peak grows 236–279 MiB at 50,116 files on a first copy, about 5 KB per file. The controller peaks at 291–350 MiB.
- **What the cap admits.** At 174 bytes per file the cap admits about 770k files. At 5 KB each, that is about 3.8 GB per daemon.
- **V8's default heap.** Node sizes it from physical or cgroup memory: 4288 MiB on this 48 GB Mac, at most about 2 GiB on a Linux machine under 16 GB, and less on smaller ones (about 1 GiB each in the benchmark's own 2 GiB VM).
- **The window.** From a few hundred thousand files up to the cap, preflight passes and a daemon dies with "heap out of memory":
  - **On the source**, the dying daemon is the live owner's, at preflight or freeze.
  - **On the destination**, it dies at prepare after the whole copy. That is before Commit, so recovery aborts, but every retry fails the same way.
- **The doc** reads as if such a handover would simply use "several GB".
- **Fix.** Before version 1, block at preflight on the carried file count (`summary.files`), with the same exclude hint as `manifest_too_large`.
  - **No wire change:** a fixed cap sized for the smallest supported companion, from the measured ~5–6 KB per file.
  - **Or, better:** derive the limit from the lower of the two daemons' `heap_size_limit`. The source reads its own, and the destination reports its own in the inspect answer; that field rides protocol 17 while it is unreleased.
  - State the supported size in the doc. Add a test that a file count over the limit is refused at preflight.

**I2. The manifest-size bound test (b4a6e8ef) cannot fail on a scanner change.**
`packages/archid/test/handover/manifest.test.ts:421-434`; `docs/security/fleet-handover.md:300`.

- **What it measures.** The test serializes 50,000 file records it writes by hand. The scanner's output is never measured.
- **Mutation, in a scratch copy of `git archive 09a23137`.** `TransferFile` gains `ino` and `sha1`, and `addFile` fills them.
  - Real `scanPath` records with the test's path shape grow from 198.0 to 271.0 bytes per file, past the 256-byte bound.
  - The bound test still passes. Only the unrelated exact-shape test "lists each carried file once…" fails, and it would not catch an existing field getting wider.
- **The doc's "over 500,000 files"** holds only for paths up to about 100 characters: a record costs about 147 bytes plus the path.
- **Fix.**
  - Build the records with `scanPath` or `buildManifest` over a temp tree with long paths.
  - Measure `JSON.stringify` as `oversize` does.
  - Bound bytes per file minus the path's bytes, for example under 160.
  - In the doc, write the cap as 128 MiB / (≈150 B + path length).

### Minor

**M1. The collision blocker's six names may include no colliding pair.**
`packages/cli/src/controller/handover.ts:919`; `packages/archid/src/handover/probe.ts:28`.

- **Why.** `caseCollisions` sorts every name flat, so upper-case names sort ahead of their lower-case partners.
- **Evidence.** For 10,000 pairs of the form `data/fN.csv` / `data/FN.csv`, the message names `data/F0.csv, data/F1.csv, data/F10.csv, data/F100.csv, data/F1000.csv, data/F1001.csv`. None of these collide with each other, so the user cannot see what clashes with what.
- **Fix.** Keep the groups by fold. Show the first two or three groups whole, for example "data/F0.csv and data/f0.csv", and count the rest. Assert in the test that each name shown appears with its partner.

**M2. A viewer rejoins as soon as its unsent output is just under 1 MB, not once it drains.**
`packages/archid/src/terminals.ts:148,158`; `packages/archid/test/terminals.test.ts:100-110`; `docs/security/fleet-handover.md:305,316`.

- **Why.** A viewer goes behind at `>= DRAIN_LIMIT` and rejoins at `< DRAIN_LIMIT`. Its resync (a 2,000-line capture, about 0.5 MB base64 at 200 columns) then queues behind about 1 MB still unsent, and output resumes at once.
- **Effect.** A viewer on a slow link alternates between behind and resync, with a full capture every cycle. The daemon stays bounded, but the doc's "once it drains" is not what happens.
- **Test hygiene.** The "resumes a paused pane…" test leaves `viewer(5_000_000)` open. Its `catchUp` keeps polling every 50 ms for the rest of the worker.
- **Fix.** Rejoin below a low-water mark (for example `DRAIN_LIMIT / 4`), and `closeAll(v)` at the end of that test.

**M3. Some benchmark numbers in the doc are not the script's output, or are slightly off.**
`docs/security/fleet-handover.md:269,274-275,283-284,290-292,302,314`.

- **The 92.9 s base run (line 291).** It has no kept record. `bench-base-many` holds only the two void runs, and no log in the implementer's scratchpad names 92.9 s. Its power state and IO stall are unknown, and fixed-build incrementals span 40–180 s. One such run is no evidence for the speedup it is set against.
- **Ad-hoc measurements.** The Mac scan timings (line 290) and the tmux measurement of 8 MiB over 21 s (line 314) came from runs outside the script.
- **Quiet-disk numbers left out.** The report has them: sequential 3.5 s, pooled `buildManifest` 1.4 s.
- **"All the runs below were on AC… no thermal warning" (line 269).**
  - `bench-fixed`, `bench-fixed-many` and `bench-fixed-large` came from an earlier script. Its `pmset` capture lacks the power-source and thermal lines. "100%; charged" implies AC, but the thermal state was not recorded.
  - `bench-fixed-many` supplies the doc's "quietest run".
- **Ranges.**
  - Large incremental "9.3–11.3 s" leaves out `bench-fixed-large`'s 8.6 and 9.1 s, while the many-file ranges include `bench-fixed-many`.
  - The many-file controller low is 291 MiB, not 292.
  - rsync peaked at 7.2 MiB, against "no rsync went past 7 MiB".
- **"The freeze answer … is the largest" (line 302).**
  - It is computed as `manifest.json`'s compact size plus 30 bytes (`scripts/bench/machine.mjs:206-213`).
  - The preflight answer carries the same manifest (`source.ts:210-214`).
- **Fix.**
  - Rerun the base build with the committed script (`--archive` built at 5ec8ea39) and keep the folder, or drop the before/after sentence.
  - Say which runs each range covers.
  - Label the message sizes as computed from the manifest's compact JSON.

**M4. The benchmark and the integration run share container and network names, and each removes them.**
`scripts/bench/handover.mjs:176`; `scripts/integration/fleet-handover.mjs:18-20,46`; `docs/security/fleet-handover.md:354`.

- **Effect.** Parallel agents share one docker in this setup, so a benchmark and an integration run kill each other. The implementer's concern 3 suggests this already happened once.
- **Fix.** Add a name prefix (flag or environment variable) to both harnesses, defaulting to today's names.

## Verified clean

- **84532f80 (link lookup).** The set of each path and its folders gives the same answer as `startsWith(rel + '/')`. Reverted, the test reads 2,393,259 against a bound of 110,000.
- **c579374c (session hashing).** Reverted to held chunks, the reused-buffer test gets the wrong hash.
- **0145948c (eight-at-once hashing).**
  - Tasks cannot reject: `addFile` catches everything. At most eight are in flight, and a Git index is hashed alone.
  - The manifest stays deterministic. `canonicalJson` keeps array order, and both `scanRoots` and `scanPath` sort by code unit.
  - The other `scanPath` callers are order-free: `divergence.ts:95`, `replicas.ts:295`, `destination.ts:427`, `transfer.ts:423`, `contentDigest` and `compareReplica`.
  - `HASHING = 1`, `HASHING = 16` and removing `scanPath`'s sort each fail the new test.
  - The lstat-to-read window is wider, but the checksum compare and verify still catch a change.
- **391ab4d4 / f8981dd8 (terminal backpressure).**
  - `ws.bufferedAmount` includes the socket's own buffer. A socket close runs `closeAll`, which clears `behind`. The phone repaints on `term.resync` (`apps/desktop/web/src/mobile/term.ts:41,49`).
  - Output sent to every viewer queues 7,628,120 bytes and the test fails. Dropping the `behind` filter, or skipping the catch-up resync, times out.
  - `terminals.test.ts` passed 13/13 in four runs.
- **15181f00 (collision list).** Unbounded, the test fails.
- **f5340ba1 (progress events).** `SHOWN_MS = 0` gives 50,004 events against a bound of 9. Journal writes are throttled (`progress.ts:69`).
- **d2373a47 (folders).** Changing `-rlpt` to `-rlt` fails the test. `compare()` counts every itemized line except a link's mode (`transfer.ts:343`), so a folder's mode does block verification.
- **Carried acceptances.** The reasons for MaxSessions, double hashing and folders hold. The WebSocket 8 MiB item is fixed: the 17.4 MB prepare went through in 40 handovers.
- **Doc numbers matched against every `bench.json`.** Carried files and bytes, manifest and prepare sizes, 5 parts, record sizes, events (34–44, 6.1–8.1 kB, longest line 836 bytes), daemon growth (236–279 MiB first, 57–120 MiB incremental), and the phase split of the quietest run.
- **Suites, in a scratch copy of 09a23137.**
  - `test:faults`: 1302/1302.
  - `tsc`: clean.
  - protocol, archid, cli, web and scripts: 4407 passed, 2 failed. `cli.test.ts --version` fails because an archive copy has no `.git`. transfer.test.ts "keeps a dropped link's partial copy…" is a timing test that failed at load 5–7 and passed 3/3 alone.
  - The integration run with fault scenarios was not rerun by the implementer or by me. The round trip passed in each setup, 40 benchmark handovers completed, and no recovery code changed.

## Re-review of fix round 1

**Verdict: Needs fixes.** One Important item remains: preflight should count files before it hashes them. All six findings are addressed. The fix diff introduces nothing Critical or Important; it widens one earlier path, noted below as N1 (Minor). Commits reviewed: 2ef3851b 515e9154 785ee975 2fae43ef 5926c4d2 bbb1d5f3 b4d9ba51 ee34500d.

### Per finding

| Finding | Verdict | Evidence |
| --- | --- | --- |
| I1: file bound | ADDRESSED | `too_many_files` is checked at preflight (`source.ts:222`, answered without file lists) and again at freeze (`:312`), using the smaller of the two heaps (`:174`). The controller fetches `system.info` again before freeze (`handover.ts:464`). Mutations each fail the test: no check at preflight, the destination's heap ignored, no check at freeze, `<` in place of `<=`. The catalogue row is at `errors.md:103`, and the catalogue test passes 15/15. Doc numbers: 4,288 MiB gives 274,432 files, and `host.json`'s 1,127,743,488 B gives 68,832. See the residual below. |
| I2: manifest bound test | ADDRESSED | My mutation (`ino` + `sha1`) now fails at 230.0 B against 160. Leaving `mtimeMs` untruncated fails at 161.7 B. |
| M1: collision preview | ADDRESSED | Flattening the groups again fails the pair check. The only caller of `caseCollisions` is `handover.ts:915`. |
| M2: rejoin threshold | ADDRESSED | Rejoin is at ≤ 250 kB (`terminals.ts` `REJOIN_AT`). With `DRAIN_LIMIT - 1` the test gets `['term.resync', 'term.output']` at 999,999 and fails. Both tests now call `closeAll`. |
| M3: doc numbers | ADDRESSED | The table and ranges match my recomputation over bench-final, bench-final-many, bench-final2 and bench-fix1: 26.0–57.0 / 39.5–179.6 s, controller 291.5–348.1 MiB, growth 235.8–297.7 and 54.7–120.1 MiB, rsync 7.7 MiB, longest event line 842 B. All 40 rows record AC, 100 % and both "No … warning" lines, before and after. The hand-measured figures are dropped or marked "by hand". |
| M4: shared names | ADDRESSED | `--prefix` is on both harnesses, and the benchmark defaults to `archi-bench`. Setting the default back to `archi` in `handover.sh` fails `bench-names.test.ts`. `IT_LINK` was already read (`integration/machine.mjs:194`). |

### The fixer's concerns

- **Count before hashing (concern 1): yes, before version 1.**
  - **Why it matters.** Preflight builds the whole manifest (`source.ts:221`) before `limits` can count. The fixer measured about 3.9 KB per file at preflight. A daemon with a 1,076 MiB heap therefore runs out at roughly 250k files, about 3.7× its 68,832 bound; the same ratio holds on 2 and 4 GiB heaps. Past that, the live owner's daemon crashes and restarts on every attempt, and the user never sees `too_many_files`, the one blocker that says what to do. Nothing is frozen, and tmux survives.
  - **The fix is small, with no wire change.** Before `buildManifest`, walk the names only: `scanRoots(…, false)` with a counter, plus each session's file count. If the count is past the bound, answer the stripped manifest with `too_many_files`. The same count in freeze's pre-rest `manifestBlockers` (`:298`) would also refuse before any terminal is rested.
  - **Test.** A `ScanFs` whose `read` throws must still yield `too_many_files` past the bound.
- **Per-file budget from peak RSS, not heap (concern 2): acceptable.**
  - RSS includes off-heap buffers and garbage not yet collected, so it overstates what counts against `heap_size_limit`.
  - The budget sets 8 KiB against a 6.2 KB worst case and keeps half the heap in reserve.
  - Paths longer than the benchmark's roughly 25 characters add bytes per copy, but not enough to use up that margin.
- **Protocol 17 (asked).** Safe: main is at `PROTOCOL_VERSION = 16`, so 17 is unreleased.
  - **Optional `heapLimit`.** A peer without it leaves `destination` undefined, and the source falls back to its own heap (`source.ts:174`). A controller that does not know the field strips it (`z.object`), with the same outcome.
  - **The new enum value.** A peer without `too_many_files` would fail to parse it, but mixed builds are already refused by the exact-release check.
  - **Other lists of codes.** No other code lists issue codes: grep over apps/ and packages/ finds no Swift or web switch.

### New in the fix diff

**N1 (Minor). With the file lists stripped, the destination is still inspected against empty lists.**
`handover.ts:251,868`; `replicas.ts:293-297`.

- **Why.** After a source refuses with `too_many_files`, the controller still sends `handover.inspect` with `content: contentDigest([])`.
- **Effect.** The destination hashes any folder already at a root's path that no record covers, however large. It also reports `destination_occupied` for a folder that the full list would have adopted, which matches the stray blocker in the fixer's real run.
- **Why it counts now.** The path existed for `manifest_too_large`, but the fix makes it reachable at about 69k files instead of 500k or more.
- **Fix.** Skip `destinationChecks` when the source blocked on `too_many_files` or `manifest_too_large`, or pass no `content` for stripped roots.

### Verified on a scratch copy of ee34500d

- `tsc`: clean.
- The seven changed test files: 194/194.
- `test:faults`: 1302/1302.
- Full protocol, archid, cli, web and scripts run at load average 20–30: 18 failures. The 15 affected files then passed 523/523 alone at load 5–7. `cli.test.ts --version` fails only because the archive copy has no `.git`.
- Every mutation above was restored and compared against `git show ee34500d`.

## Re-review of fix round 2

**Verdict: Approved.** H and N1 are addressed. The fix diff adds nothing Critical or Important; one Minor test gap is
noted below as N2. Commits reviewed: 664f1eb1 c07de1ec 725829e1.

### Per finding

| Finding | Verdict | Evidence |
| --- | --- | --- |
| H: count before hashing | ADDRESSED | Preflight builds a names-only manifest (`source.ts:222`) and, past the bound, answers it stripped without the hashed build (`:224`). Freeze counts the same way (`:302`) before `restTerminals` (`:309`), and checks the read manifest again after the rest (`:318`). Those are the only `buildManifest` calls. The names pass reads no file: `walk` hashes only with a pool, `scanPath` reads a file root only with `hash`, and `scanSession` skips the read at `manifest.ts:220`. On a scratch copy, a check over manifest.test's fixtures found `listed` equal to the read manifest's files and bytes, with identical blockers and warnings and 0 reads. The fixtures cover links (one dangling), default excludes, a folded nested worktree, the fleet `.env` file root, a real Git repo with its indexes, a bare gitdir, a checkout inside one, and a session. Three mutations each fail the new test: hashing first at preflight, dropping the freeze count, and dropping the session count (`:140`). |
| N1: false `destination_occupied` | ADDRESSED | `stripped` (`handover.ts:252`) matches the source's only strip condition (`manifest_too_large` or `too_many_files`). `destinationChecks` has no side effects. Its only caller is `preflight`, whose only caller `start` returns `blocked` on any blocker (`:272`), so no later step uses what was skipped. The mutation `false ?` fails the new test for both codes. The fixer's 250,116-file run (`huge2-handover.ndjson`) shows only `too_many_files`, where the 100,116-file run before the fix also showed `destination_occupied`. |

### New in the fix diff

**N2 (Minor). No committed test pins the names count for links or a file root.** `manifest.ts:107,258`.

- **Why.** Removing `scan.listed.files++` from `walk`'s link branch, or `counted.files++` from `scanPath`'s file branch, leaves the committed source and manifest tests passing. Only the scratch check above caught either one.
- **Effect.** Small. An undercount lets the hashed build run, and `limits` still refuses after it. Links and file roots are not what fills the heap.
- **Fix.** Add one manifest.test case: `buildManifest(inv, HEADER, sfs, false).listed` equals `summarize` of the read manifest's `files` and `bytes`, over `seed()` with `transferFleetEnv`.

### The fixer's concern: the extra names walk

Acceptable.

- **Measured.** On this Mac, 50,000 files over three warm rounds: names 0.54–0.57 s, hashed 1.17–1.27 s, as the fixer found.
- **In the benchmark.** In bench-fix2 the first preflight went from 3.7–4.6 s to 5.4 s. Incremental, at 10.1–10.6 s, sits within the earlier 8.3–11.5 s. At the 48 GB Mac's 274,432-file bound the extra walk is about 3 s, against a 10-minute `PREFLIGHT_TIMEOUT_MS`.
- **The alternative.** One walk that stops hashing once its count passes the bound would drop the extra walk. It would thread the bound through four functions, which version 1 does not need.

### Also checked

- **Protocol.** Still 17 (`messages.ts:360`). No file under `packages/protocol` changed, and `ManifestSummary`'s `files`/`bytes` are what `listed` overrides.
- **Doc ranges.** Recomputed over bench-final, bench-final-many, bench-final2, bench-fix1 and bench-fix2; they match. Controller 291.5–355.8 MiB; daemon growth 193.2–297.7 MiB first and 32.9–120.1 MiB incremental; large-file growth up to 55.6 MiB; small controller 88.4–98.1 MiB.
- **Scratch copy of 725829e1.**
  - `pnpm typecheck`: clean.
  - Source, manifest and controller handover tests: 152/152.
  - archid handover, cli controller and the error catalogue: 2059 passed, 18 skipped.
  - `test:faults`: 1302/1302.
  - Every mutation was restored and compared with the pristine files.
