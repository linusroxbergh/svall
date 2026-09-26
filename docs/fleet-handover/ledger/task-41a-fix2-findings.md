# Task 41a fix round 2 (findings)

From the re-review, `ledger/task-41a-review.md` "## Fix round 1" (file:line and evidence there). FIX_BASE = HEAD at
dispatch. Rules and report shape as `task-41a-fix1-findings.md`; report `ledger/task-41a-fix2-report.md`.

- **F1 (Important)** Preflight writes and deletes `.archi-probe-<pid>-a` inside every existing carried folder on the
  destination (`handover.ts` ~820, `probe.ts` ~36): it touches the user's working copies on a return trip, fires file
  watchers, and a leftover file reads as `destination_diverged` next time. Replace it with read-only checks, as the
  reviewer verified on this Mac: writability with `fs.access(p, W_OK)`; case folding by looking the folder up with its
  name's case swapped and comparing device and inode (for a folder that is itself a mount point, swap the case of an
  entry inside it). Keep the case check on the root's own probe (question 3). If the older fs-rules probe in `.git`
  (`probeFsRules`, a known deferred minor that can leave `.archi-probe-*` for the seal) can use the same read-only
  check, do it in the same commit; otherwise say why not. Test: preflight leaves every destination root byte- and
  mtime-identical, and a read-only parent and a case-folding volume still give the right answers.
- **F2** `host doctor`'s `home` check passes for a machine registered by an earlier build whose home differs from the
  Mac's (`host.ts` ~425); it must fail there too.
- **F3** Test the rule that a single-file root needs its parent writable (removing it leaves every controller test
  passing today).
- **F4** The divergence blocker text still says "map the root elsewhere" (`divergence.ts` ~109); say what the user can
  do now (recover the changes by hand, or `--archive`).
