# Task 38b — fix round 2 findings

From the "Re-review of fix round 1" section of `ledger/task-38b-review.md`:

- **H (Important).** Preflight hashes every file before it can count them, so above ~3.7× the bound (~250k files on a
  1 GiB heap) the live source daemon runs out of memory on every attempt and the user never sees `too_many_files`.
  Count names before hashing at preflight and before resting at freeze; no wire change. Test first with a fleet above
  the bound whose hashing would exceed a small injected heap.
- **N1 (Minor).** After a size refusal the destination is still inspected against empty file lists, so it hashes any
  unrecorded folder at a root path and can report a false `destination_occupied` (reachable at ~69k files). Skip the
  destination inspection once preflight has refused on size.
