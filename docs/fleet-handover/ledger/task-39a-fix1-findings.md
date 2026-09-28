# Task 39a — fix round 1 findings

From `ledger/task-39a-review.md` (review of 39a's 9 commits). Read each item there in full and fix all of them:

- **I1.** "ready for handover" after a doctor run: the CLI never prints it and the app shows it only when nothing warns
  (stock Ubuntu 24.04 warns on tmux 3.4, a missing `gh` and PATH). Say what a healthy result really looks like.
- **I2.** An unattended `--detach` run waits, frozen, until someone attaches (`errors.md:51-52`, `handover.md:65`).
- **I3.** The "remove and add again" recoveries for `identity_mismatch` and `home_mismatch` leave out `archi host enable`,
  and a moved fleet then sits at `generation_mismatch`, which "restart the daemon" cannot clear. Trace the real
  recovery in the code (and run it under a temp HOME if you can) before writing it.
- **I4.** The catalogue test misses codes with `_`, `-` or a digit in the name and union members named by alias. Plant
  those in a scratch copy: each must fail the test (test first).
- **Minor 1–7** (all wrong details in the docs and SMOKE, plus `doctor.ts:159` telling Ubuntu to `brew install gh`: fix
  it in code with a test — the companion doctor names apt or the GitHub CLI's Linux install instead).
