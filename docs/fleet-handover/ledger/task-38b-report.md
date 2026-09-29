# Task 38b report — performance audit

Status: DONE_WITH_CONCERNS. BASE fe4e2a09 (dispatch), my commits 84532f80..09a23137 among 38a's fix round 2 and ledger
commits. The doc's section is `docs/security/fleet-handover.md` "Performance and limits".

## Commits

| Commit | What |
| --- | --- |
| 84532f80 | Dangling-link check: one lookup per link in a set of its root's paths (was links × files) |
| c579374c | Session files hashed as a stream (were read whole into memory, then hashed) |
| 0145948c | A scan hashes up to eight files at once and sorts what it lists (was one at a time) |
| 391ab4d4 | A terminal viewer whose socket holds 1 MB unsent gets no output until it drains, then a resync |
| f5340ba1 | Bound test: 50,000 itemized files give one progress event per state and second |
| b4a6e8ef | Bound test: a manifest under 256 bytes a file, so the 128 MiB cap carries over 500,000 files |
| d2373a47 | Test: rsync carries empty folders and folder modes; its compare itemizes a folder's mode |
| 15181f00 | Case-collision blocker names six paths and counts the rest (listed every one) |
| 429739a2 | `scripts/bench/handover.sh`, `handover.mjs`, `machine.mjs`: the benchmark |
| f8981dd8 | A viewer that fell behind holds no paused pane for the viewers that keep up |
| 09a23137 | Security doc: "Performance and limits" |

No wire or manifest change; protocol stays 17. Nothing changes what a handover carries: files are hashed in a
different order and listed sorted, as `scanRoots` already sorted them.

## Benchmark matrix

Two Ubuntu 24.04 arm64 containers (the integration image), colima default profile: 2 vCPUs and 2 GiB for both,
docker network as the link, controller on local. Every recorded run: Mac on AC at 100 %, no thermal or performance
warning (`pmset -g batt`, `pmset -g therm` in each row's `power`). The Mac's one-minute load was 3–4 (other agents'
work) and reached ~20 during one test run, not during a benchmark row. Final run folders (scratchpad, not committed):
`bench-final2` (many, small, large, flood; stall and load columns), `bench-final`, `bench-final-many`,
`bench-fixed-many`, `bench-fixed-flood`.

Final run (`bench-final2`), times in seconds; memory is peak RSS (MiB), daemons as peak (+growth over the run):

| run | wall | preflight | freeze | claim+copy+verify | prepare | activate | controller | source | destination | rsync | events | event kB | manifest MB | prepare MB | largest frame MB | record MB | IO stall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| many first L→R | 48.3 | 3.8 | 5.4 | 11.9 | 20.6 | 0.6 | 292 | 344 (+236) | 360 (+246) | 7 | 43 | 7.8 | 8.7 | 17.4 | 8.7 | 8.7 | 3.4 |
| many incr R→L | 132.2 | 56.0 | 46.7 | 15.6 | 11.8 | 0.5 | 344 | 450 (+104) | 413 (+76) | 7 | 41 | 7.4 | 8.7 | 17.4 | 8.7 | 8.7 | 17.2 |
| many incr L→R | 50.6 | 11.5 | 7.2 | 15.9 | 14.0 | 0.2 | 312 | 406 (+79) | 505 (+120) | 7 | 41 | 7.4 | 8.7 | 17.4 | 8.7 | 8.7 | 6.9 |
| many fixture R→L | 2.2 | 0.5 | 0.1 | 0.7 | 0.1 | 0.4 | 93 | 477 (+0) | 354 (+2) | 6 | 34 | 6.1 | 0.0 | 0.0 | 0.0 | 8.7 | 0.1 |
| small first L→R | 2.9 | 0.8 | 0.4 | 0.8 | 0.2 | 0.2 | 96 | +1 | +0 | 6 | 41 | 7.4 | 0.1 | 0.1 | 0.1 | 0.04 | 0.1 |
| small incr R→L | 2.5 | 0.6 | 0.2 | 0.8 | 0.1 | 0.4 | 88 | +0 | +0 | 6 | 41 | 7.4 | 0.1 | 0.1 | 0.1 | 0.04 | 0.1 |
| small incr L→R | 3.0 | 0.8 | 0.4 | 0.8 | 0.2 | 0.2 | 95 | +3 | +0 | 6 | 41 | 7.4 | 0.1 | 0.1 | 0.1 | 0.04 | 0.1 |
| large first L→R | 9.5 | 1.5 | 1.1 | 4.2 | 1.8 | 0.2 | 154 | +0 | +0 | 6 | 42 | 7.6 | 0.1 | 0.1 | 0.1 | 0.04 | 0.2 |
| large incr R→L | 9.4 | 2.0 | 1.1 | 3.3 | 1.9 | 0.5 | 141 | +0 | +2 | 6 | 41 | 7.4 | 0.1 | 0.1 | 0.1 | 0.04 | 0.2 |
| large incr L→R | 9.9 | 2.3 | 1.4 | 3.3 | 1.8 | 0.2 | 139 | +1 | +2 | 6 | 41 | 7.4 | 0.1 | 0.1 | 0.1 | 0.04 | 0.1 |

(small and large ran after many here, so their daemon growth is small against daemons already grown; in
`bench-final`, where they ran first, small grew the daemons by up to 29 MiB and large by up to 39 MiB.)

Across all four runs on the fixed build: many first 30.4–57.0 s, incremental 39.9–179.6 s (half under 51 s; the slow
ones with IO stall, e.g. 17.2 s of stall in a 132 s run); small 2.3–3.0 s; large 9.3–14.7 s. Quietest 50k phases
(`bench-fixed-many`): first 30.4 s = 3.8 / 5.4 / 10.6 / 9.0; incremental 41.8 s = 8.9 / 8.0 / 13.7 / 9.1.

- **Hashing memory:** at most eight files streamed at once (64 KiB chunks), one Git index whole at a time (≤ 256 MiB).
  Process-level: the destination daemon grows ~5 KB a file at its peak on a first 50k copy.
- **Events:** 34–44 events, 6.1–8.1 kB, longest line 836 bytes, whatever the repository size.
- **Largest RPC message:** the prepare request, 17.36 MB at 50k files (manifest 8.68 MB + landed 8.68 MB), sent in
  5 parts of ≤ 5.6 MB frames; the claim 8.68 MB in 3 parts. The largest single frame is the freeze answer: 8.68 MB,
  daemon → controller, read under the client's 256 MiB cap.
- **Records:** a sealed replica record is 8.66 MB at 50k files.
- **rsync:** ≤ 7 MiB RSS on either side at 50k files (incremental recursion).

Before/after (same containers, same 50k repo, base build 5ec8ea39): incremental remote→local 92.9 s (preflight 24.5,
freeze 13.3, transfer 28.0, prepare 25.6) against 39.9–50.6 s in the fixed runs with little IO stall. On the Mac,
`scanPath` over 50,029 files alternating sequential and pooled in one process: 35.3/37.8/53.2 s against
13.2/12.2/8.6 s (disk busy with fseventsd and the endpoint agent); quiet, sequential took 3.5 s and a pooled
`buildManifest` 1.4 s.

**Void or throttled numbers:** the first base 50k run (first 404.5 s, freeze 309 s) and second (960.3 s) ran at
67–77 % charge while charging, and the host stalled during them (my stream stalled for 600 s and colima's VM
restarted before the third, which completed unrecorded). They are void and not used. Everything after ran at 100 % AC.

## Carried items

| Item (progress.md line) | Verdict |
| --- | --- |
| Surfaces past sshd's MaxSessions ride their own logins (275) | **Accepted.** Measured in the containers: a command on the master 3–4 ms; a login 168–174 ms; with the master's 10 sessions taken, a command falls back to a login (161–178 ms) and prints "Session open refused by peer". Cost: one login per surface past ten, and one per 30 s helper tick while the master is full. A pool needs the app (Swift `SurfaceManager`/`AttachCommand`) to pick a socket per surface and the helper to hold several masters; not worth it before release. In the doc's Limits. |
| Per-file lists inline in records and manifests (304, 361) | **Accepted, bounded.** 174 B a file (bench paths), under 256 B for long paths (test); the 128 MiB `manifest_too_large` cap covers 500k+ files; 8.7 MB manifest and record at 50k. The binding limit is daemon memory (~5 KB/file at peak), recorded as a concern. |
| One file hashed at a time (304) | **Fixed** 0145948c: eight at once. |
| Each replica hashed at preflight and again at claim (361) | **Accepted.** Each proof guards a moment (before any write, before `--delete`); a replica can change between them. Cost measured: a 50k pass is seconds; the doc lists every pass per side. |
| Daemon WebSocket 8 MiB cap passed by a prepare at ~25k files (446) | **Already fixed** in Task 27 (requests in 4 MiB parts to 256 MiB; `client.test.ts`, `api.test.ts`). Verified at scale: 50k prepare 17.4 MB in 5 parts; the freeze answer 8.68 MB is one frame the other way, under the client's 256 MiB. |
| Dangling-link check costs links × files (564) | **Fixed** 84532f80. |
| Directories, empty dirs, dir modes not recorded (312) | **Accepted, tested** d2373a47: rsync `-rlpt` carries empty folders and modes; the checksum compare itemizes a folder's mode (`.d...p.....`), so a differing copy does not verify. A folder made or re-moded on the destination while it was not the owner is not detected as divergence; `--delete` removes an empty one, the copy resets a mode; neither holds work. |

Also found and fixed: session files read whole (c579374c); an unbounded case-collision message (15181f00);
terminal viewers could grow the daemon without bound (391ab4d4, f8981dd8).

## Backpressure and payload limits

- **Remote desktop terminals** (`ssh -tt … tmux attach`): tmux blocks a lagging client. Measured in a throwaway
  container: a client reading nothing for 21 s beside a pane running `yes`: tmux stayed at 7.8–8.1 MB.
- **Daemon WebSocket viewers** (phone, page): before 391ab4d4 every `term.output` went to every viewer regardless of
  `bufferedAmount`; tmux's `pause-after=3` never fired because the daemon reads tmux at full speed, so the queue grew
  in the daemon. RED: 37,814,660 bytes queued for a viewer reading nothing while the terminal printed 16 MB (bound
  1,262,144). After: output stops at 1 MB unsent per socket, a resync once drained. Container flood (`--flood`): a
  terminal printing ~23.7 MB/s to a viewer that read nothing for 20 s, daemon RSS 359 → 360 MiB.
- **A pause held by a slow viewer:** `resumeWhenDrained` waited for every viewer's backlog, so a viewer that fell
  behind held the pane from the others for up to 30 s. RED: `continuePane` not called within 1 s; f8981dd8 ignores
  viewers already behind. Found when the flood test timed out under the full suite.
- **Caps** (unchanged, listed in the doc): 8 MiB frame / 256 MiB request in parts; 256 MiB answer; 128 MiB manifest;
  64 KiB notification POST; 1 MiB gateway and helper control lines; 1 MiB far command output; 16 MiB far listing.

## RED/GREEN

| Test | RED | GREEN |
| --- | --- | --- |
| handover.test.ts "reads a root's file list a few times over…" (5,000 files, 500 links) | 2,393,259 reads (bound 110,000) | 27,515 reads |
| manifest.test.ts "reads a session file a chunk at a time…" (a reader reusing one buffer) | wrong sha256 (chunks held and overwritten) | pass |
| manifest.test.ts "hashes several files at once, never more than eight…" | max in flight 1 | 2–8, sorted, hashes right |
| terminals.test.ts "sends a viewer no more output once a megabyte waits unsent…" | 37,814,660 queued (bound 1,262,144) | pass, 3/3 alone and in the full run after f8981dd8 |
| terminals.test.ts "resumes a paused pane for the viewers that keep up…" | timed out (1 s) | pass |
| handover.test.ts "names a few of a root's names that differ only by case…" (10,000 pairs) | no "and N more", 20,001 names | pass |
| transfer.test.ts "tells a watcher of a 50,000-file copy…" (bound, no fix) | mutation `SHOWN_MS = 0`: 50,004 events (bound 9) | pass |
| manifest.test.ts "names a file with a long path in under 256 bytes…" (bound, no fix) | 212 B a file failed a first 200 B bound; set at 256 B | pass |
| transfer.test.ts "carries empty folders and each folder's mode…" (documents behaviour) | n/a | pass on existing code |

## Verification

- `pnpm typecheck`: clean.
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project scripts`
  at 09a23137: 4410 passed, 6 skipped, 3 failed under a machine load of ~10–20 from another agent's suites
  (usage.test.ts "asks for the plan limits alone…" 2 s timeout; fleet.test.ts "ends an agent idle past the limit…";
  terminals.test.ts "takes Enter or Esc…"). The three files pass alone, 120/120. An earlier full run failed only my
  flood test, on a 15 s wait under load; f8981dd8 lightened it to 3 MB and fixed the pause it exposed.
- `pnpm test:faults`: 1302 passed, twice.
- Touched files alone: handover.test.ts 74, transfer.test.ts 36 + 1 skipped, manifest.test.ts 28, terminals.test.ts 13 (3 runs).

The integration round trip (`fleet-handover.mjs --scenarios none`) passed in each of the four benchmark setups
(8 PASS lines, ALL PASS). The full integration run with fault scenarios was not rerun: no change alters what a
handover carries, and `pnpm test:faults` passed.

## Concerns

1. **Memory, not the manifest cap, is the ceiling.** ~5 KB a file of daemon peak on a first copy (236–279 MiB at
   50k); near the 128 MiB cap (~750k files at 174 B) that is several GB per daemon, and the controller similar. No
   code bound below the cap; a lower cap or streaming the lists would be the fix if that size matters.
2. **Benchmark variance.** On a 2 GiB colima VM the 50k runs swing 40–180 s with IO stall (page cache for both copies
   beside ~1.2 GB of daemon and controller RSS). The benchmark now records IO/memory stall seconds and the Mac's load
   per run; numbers from a bigger VM or real machines (Task 39b) would be steadier. I did not change the shared colima
   profile's size.
3. **Container names are shared with the integration run** (`archi-local`, `archi-remote`), and setup removes whatever
   holds them. Between two of my runs a pair under those names appeared after my previous run had removed its own; if
   that was the 38a fix-round-2 implementer's integration run, my next setup cut it off.
4. **A daemon test flaked under load:** terminals.test.ts "takes Enter or Esc typed into a blocked agent…" failed once
   of three runs while the machine's load was ~20 (another agent's suites); it touches none of the code I changed.
5. **Surfaces past MaxSessions** stay as they are (accepted above); the app's user doc already says so
   (`docs/remote-machines/handover.md`).

## Fix round 1

Status: DONE_WITH_CONCERNS. Commits 2ef3851b..ee34500d (8, mine only; 7243b8dc and 76524110 between are Task 39b's).
Protocol stays 17: the new blocker code and `SystemInfo.heapLimit` (optional) ride the unreleased 17 (main is 16).

| Commit | Item | What |
| --- | --- | --- |
| 2ef3851b | M1 | `caseCollisions` returns groups by fold, each sorted; the blocker shows three groups whole ("data/F0.csv and data/f0.csv; …; and 9998 more") |
| 515e9154 | M2 | A viewer that fell behind rejoins at ≤ `DRAIN_LIMIT / 4` (250 kB) unsent, not < 1 MB; the "resumes a paused pane…" test closes its viewer |
| 785ee975 | I2 | Bound test measures `scanPath`'s own records over a temp tree with long paths, bytes beyond each path, widest numbers |
| 2fae43ef | I1 | `too_many_files` at preflight (answered without file lists) and at freeze; bound = min(own heap, destination's `system.info` `heapLimit`) / 2 / per-file |
| 5926c4d2 | M4 | `--prefix` on both harnesses; the benchmark defaults to `archi-bench-{local,remote,it}`, the integration run keeps `archi-*`; drive passes `IT_LINK` |
| bbb1d5f3 | M3 | Benchmark records each daemon's heap (via `system.info`) and the bound in `host.json`; the Mac column now needs both "No thermal" and "No performance warning" lines |
| b4d9ba51 | I1 | Per-file budget 6 → 8 KiB after the new run measured 6.2 KB a file (297.7 MiB / 50,116) |
| ee34500d | M3 | Doc numbers regenerated from four recorded runs; ad-hoc figures dropped or marked |

### Per item

- **I1.** Bound: files ≤ min(heap_size_limit) / 2 / 8 KiB. Per-file from the worst recorded first-copy daemon peak
  growth (297.7 MiB at 50,116 files = 6.2 KB, bench-fix1 destination), rounded up to 8 KiB; half the heap left for
  the daemon's own state and GC. Mac heap 4,288 MiB (measured, `node -e v8.getHeapStatistics()`) → 274,432 files; VM
  daemons 1,076 MiB (bench `host.json`) → 68,832. Controller runs on one of the two machines ("this controller moves a
  fleet only to or from the machine it runs on"), default heap there; its growth ≤ a daemon's. Doc: Limits paragraph,
  Bounds row, errors.md row.
  - RED: source.test "refuses at preflight, with nothing frozen, more files than the smaller of the two heaps holds…"
    — `expected [] to deeply equal [{ code: 'too_many_files' … }]`; error-catalogue test RED (41 vs 42 codes) until
    the row; api.test system.info updated for `heapLimit`. GREEN: at the bound (heap for exactly `files`) no blocker;
    one file past it on either side blocks, names the smaller side, strips file lists, `world.log` empty, ownership
    writable; freeze with the small destination heap refused `blocked`/`too_many_files`, ownership writable.
  - Real machines (final build b4d9ba51, containers `archi-fix1-*`): a 100,116-file fleet, `archi handover remote
    --json` → `blocked` at `begin` with `too_many_files` ("…carries 100116 files, and this machine's daemon, with a 1.1
    GiB heap, holds at most 68832…"); after it owner, generation 4 and `frozen: false` unchanged, the 4 tmux windows
    unchanged. Preflight took 16 s. (It also showed `destination_occupied`: I had made the same folder on the far side
    first.)
- **I2.** Real records: 144.0 B beyond the quoted path as scanned, 157.0 B with mode 0o7777 and a 1 TiB size (bound
  160). Reviewer's mutation (`ino` + `sha1` added in `addFile`): 223.0 B → the new test fails; restored. Doc: cap =
  128 MiB / (160 B + path), over 500,000 files with paths up to 100 bytes.
- **M1.** RED: probe.test got a flat list; handover.test's message had no pairs. GREEN: probe.test and handover.test
  79/79; the test checks three shown groups, each two names equal ignoring case, "; and 9998 more" (the fixture's
  README.md/Readme.md makes 10,001 groups).
- **M2.** RED: at 999,999 unsent the viewer got `['term.resync', 'term.output']`. GREEN: nothing at 999,999 or
  250,001, resync at 250,000; terminals.test 14/14, three runs alone.
- **M3.** New run `bench-fix1` (scratchpad, not committed) with the committed script at bbb1d5f3:
  `scripts/bench/handover.sh --out $S/bench-fix1 --flood --keep`, then `--reuse --repos none --keep --out
  $S/bench-fix1-host` after b4d9ba51 to record `mostFiles` 68,832. `pmset` before: AC, 100 %, "No thermal warning
  level", "No performance warning level", load 2.27; after: same, load 2.79 (01:58:50–02:02:34). Every row of the four
  cited runs (bench-final, bench-final-many, bench-final2, bench-fix1) has AC 100 % and both "No … warning" lines
  before and after; bench-fixed* (no thermal line) are no longer cited. Dropped from the doc: the 92.9 s base run, the
  Mac scan timings, the tmux 8 MiB/21 s figure; MaxSessions timings marked "by hand"; the largest message labelled as
  computed from the manifest's compact JSON (preflight and freeze answers both carry it). Ranges recomputed from
  bench.json (`ranges.mjs`): controller low 291.5 MiB, rsync max 7.7 MiB (7,896 KiB), longest event line 842 B.
- **M4.** RED: `bench-names.test.ts` saw the benchmark remove `archi-local`/`archi-remote`/`archi-it`, and
  `--prefix side` ignored. GREEN 2/2 (fake docker on PATH, both harnesses and handover.sh's pass-through). Real:
  `fleet-handover.sh --archive … --prefix archi-fix1 --scenarios drop@begin` ALL PASS; the link agent answered at
  `archi-fix1-remote:7070` ("drop 2", "restore 0") in both directions.

### Benchmark, bench-fix1 (build and scripts at bbb1d5f3, bound then 6 KiB a file; no row near it)

| run | wall s | pre | freeze | transfer | prepare | controller MiB | source +MiB | dest +MiB | events | IO stall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small first L→R | 2.8 | 0.8 | 0.4 | 0.8 | 0.1 | 91.4 | 4.9 | 7.3 | 41 | 0.1 |
| small incr R→L / L→R | 2.3 / 2.8 | | | | | 98.0 / 91.7 | | | 41 | 0 |
| large first L→R | 8.4 | 1.5 | 1.0 | 3.6 | 1.4 | 148.4 | 32.5 | 14.5 | 42 | 0.4 |
| large incr R→L / L→R | 7.3 / 7.6 | | | | | 150.7 / 148.7 | 45.0 / 32.9 | 33.4 / 45.3 | 41 | 0.2 / 0.1 |
| many first L→R | 26.0 | 3.7 | 5.2 | 7.9 | 7.7 | 338.4 | 246.5 | 297.7 | 42 | 1.8 |
| many incr R→L | 39.9 | 8.8 | 7.8 | 12.8 | 8.9 | 308.6 | 55.6 | 82.4 | 41 | 5.4 |
| many incr L→R | 39.5 | 8.3 | 5.9 | 12.9 | 10.6 | 313.7 | 94.0 | 54.7 | 41 | 5.4 |
| flood | daemon 323.5 → 324.0 MiB over 20 s; 22.9 MB read in the second before the pause | | | | | | | | | |

Integration round trip on the final build: inside the benchmark's setup (ALL PASS) and the `archi-fix1` run above.
Containers removed afterwards (`archi-bench-*`, `archi-fix1-*`); colima was stopped when I began, started for this,
`docker ps -a` empty, stopped again; docker context back to `desktop-linux`.

### Verification

- `pnpm typecheck`: clean.
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project
  scripts` at ee34500d: 4417 passed, 6 skipped, 0 failed (198 files + 1 skipped), load ~3–6.
- `pnpm test:faults`: 1302/1302.
- terminals.test.ts alone ×3: 14/14 each.

### Concerns

1. **Preflight itself is not bounded below the file count.** It hashes and lists every file before it can count
   them: at 100,116 files it raised the source daemon's peak RSS from 102.5 to 489.3 MiB (+387 MiB, ~3.9 KB a file,
   by hand, not the script) on a 1,076 MiB heap. A repository roughly 2.5× the bound or more can still exhaust the live
   source daemon at preflight (a daemon restart; nothing frozen; `KillMode=process` keeps tmux on Linux). Closing it
   needs a scan that stops counting past the bound; the doc says so without the number.
2. **The per-file budget rests on RSS, not heap.** 8 KiB covers the worst of 8 first copies (6.2 KB) by 31 %; RSS
   includes uncollected garbage, so it overstates live heap, but a different workload (long paths, many sessions) is
   unmeasured.
3. **The three older cited runs were on the benchmark's first build**, the fourth on this one; the changes between do
   not touch a measured path, and the doc says which runs each range covers.
