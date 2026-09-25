# Task 29 — fix round 1 findings (from the task review at ffb8e7d)

F1 (Important). Every boot replays the last run as if it were live — web/src/boot.ts:70-72, web/src/store.ts:350-351, web/src/terminals.ts:90-93.
`attach` with no live helper prints the whole events file, then `handover.status`; the file persists until the next start, so every launch or reload after any handover folds it through `handoverEvent` as live:
(a) the replayed `handover.changed freeze` makes `holdsTerminals` true, the terminals.ts:90 subscription closes every attached surface, and the final status reattaches them — a close-and-reattach of every visible terminal at each launch;
(b) `asks` is true for any `handover.blocked`, so a replayed run that ever raised a decision (a routine "Continue waiting") opens the sheet on every launch, and `handoverOpen` is sticky and veils every surface until closed.
The tests miss it (store.test replays only a bare status; the e2e relaunch has no open terminals).
Fix: learn whether a helper is live before following — `archi handover status --json` first (the status carries `helper.pid` when live); spawn `attach` only when live; otherwise hand the page the status plus the events as a flagged replay that never triggers `asks` nor the hold-and-close transition. Add a test that replays a finished run with a decision while a terminal is open.

F2 (promoted Minor — Ruling: same defect class as F1, and the contract names `--forget` as superseded's way out). `superseded` opens the sheet on every launch (store.ts:350) with no action offered (handover.ts:205). Offer Forget (`archi handover --forget --json`) for a superseded standing, and do not open the sheet on launch for a standing that has nothing to decide.

F3 (Ruling — contract amended). Only the controller emits `handover.changed` now; daemons' `handover.entity` rows are still relayed, their `handover.changed` are not (task-28-29-contract.md, Output). A pending decision must clear on the app's own answer (the `choose`/`cancel` it sent), a controller `handover.changed`, or `handover.result` — never on a relayed `handover.entity` (web/src/handover.ts:106), which may arrive after the `handover.blocked` it preceded at the daemon.
