# Task 36a fix round 2 (findings)

From `ledger/task-36a-review.md` "## Fix round 1" (evidence there). FIX_BASE = HEAD at dispatch. Rules as
`task-36-brief.md`; report `ledger/task-36a-fix2-report.md` (uncommitted).

- **F1 (Important)** Defect B (9680eca4) exists only in the fake: the real `Fleet`'s reconcile runs before `wake` on every
  activation and re-attaches a leftover window with the carried revive (the reviewer confirmed it with the real `Fleet`
  on real tmux; with the fake given that re-attach and B reverted, all 421 cases pass). In production `closeLeft` can
  kill a window the user (or the phone's auto-revive) opened while `wake` handled the terminal. Model the reconcile's
  re-attach in the fake, drop `closeLeft`, keep the `destination.activate.kill:before#1` cases.
- **F2 (Minor, folded)** `settledOn`'s leftover check covers `handover/` and `ctl/` only; also assert that no path under
  any home names the transaction id after a settled move, abort or cancel (the reviewer found no false alarms).
