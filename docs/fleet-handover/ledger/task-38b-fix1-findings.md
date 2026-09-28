# Task 38b — fix round 1 findings

From `ledger/task-38b-review.md` (review of 38b's 11 commits). Read each there in full; fix all of them, test first:

- **I1 (Important).** Only the 128 MiB manifest cap limits size, and memory runs out first (~5 KB per file in a daemon;
  Node's default heap is ~2 GiB on Linux boxes under 16 GB, ~1 GiB in the benchmark VM), so a large enough repository
  crashes the live source daemon at preflight/freeze or the destination at prepare after the whole copy. Add a
  preflight blocker on the carried file count (a bound derived from the measured per-file memory and the smaller
  machine's heap, with the reasoning in the doc), with a test at the bound, a new code in the error catalogue
  (`docs/remote-machines/errors.md`; its test reads codes from the code) and the doc's number.
- **I2 (Important).** The b4a6e8ef bound test measures hand-written records only; measure the real scanner's records
  (the reviewer's mutation to 271 bytes per file must fail it).
- **M1.** The case-collision preview can list six names with no colliding pair among them: show whole pairs.
- **M2.** A viewer rejoins just under 1 MB unsent instead of once drained (it alternates between falling behind and
  full resyncs): rejoin only when drained (or well below the mark); stop the test's leftover polling timer.
- **M3.** The doc's numbers must be the script's recorded output: rerun or drop the base 92.9 s, the Mac scan and tmux
  timings and the computed "largest message", record thermal state for every run, fix the off ranges.
- **M4.** The benchmark's container names must not collide with the integration run's (and it must not remove theirs).
