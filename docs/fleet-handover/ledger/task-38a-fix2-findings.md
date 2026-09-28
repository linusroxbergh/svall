# Task 38a — fix round 2 findings

From the "Re-review of fix round 1" section of `ledger/task-38a-review.md`. Read each there in full; fix all three, test
first (a reproduction that fails before and passes after), one commit each:

- **N1 (Important).** The spec-286 split opened a hole in the far check (`install.ts:151-160`): the script verifies the
  `SHA256SUMS` it extracted by name, then unpacks the whole archive over it and runs `sha256sum -c` on what the full
  unpack left; GNU tar lets a later `./releases/<v>/SHA256SUMS` (or `/./`, `//` spellings) replace the verified file.
  Reproduced end to end: `inspectCompanion` accepts the crafted archive and the far script prints `pinned`, exits 0 and
  stages the intruder's `archi` (pre-split 076d8339 refused it with exit 3). macOS bsdtar hides it — reproduce under GNU
  tar (the `archi-it:machine` image). Fix per the review: never let the full unpack replace what was verified (verify
  again after it, or keep the verified sums outside the unpack target) and refuse oddly spelled or duplicate members in
  `inspectCompanion` and every installer.
- **N2 (Minor).** In `identify` (the I5 fix), a far shell that prints to stdout skips the controller's gateway check and
  the fleet is routed `local`. A noisy login shell must not skip the check.
- **N3 (Minor).** `host remove` still uninstalls a machine that a handover through another gateway holds open.
