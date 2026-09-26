# Task 42 — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits 632b71cd..8db67a32. Task brief: `docs/fleet-handover/ledger/task-42-brief.md`; implementer's
report `task-42-report.md`; plan Task 42; spec `docs/fleet-handover/spec.md` (binding: "Product contract" — entity docs
are preserved; "Same paths" — every path field, process-bound field and fleet-home entry classified; "Transfer
inventory"; "Terminal records"); delivery rules `ledger/review-constraints.md`.

## Check

1. Entity docs (fleet, island, character, repo docs under `<fleetHome>/docs/`) travel and are found by the same keys on
   the destination; they get the same replica, divergence and `--delete` protection as other carried data; a doc
   written on the non-owner side between handovers is treated as divergence, not overwritten silently.
2. Agent profiles travel so a moved character keeps its profile; bundled profiles seeded on both sides don't create a
   false divergence or get clobbered.
3. No pid or other process-bound field travels (F2 already strips `agent.pid`/`second.agent.pid`; check for any other).
4. The classification tests: every state field main and the branch have, every process-bound field, and every entry a
   fleet home can hold is classified travelling or machine-local, and an unclassified one fails. Check the fleet-home
   list against the code that writes into the fleet home (archid, cli, setup, mobile, scribe, usage, browser store,
   hooks, handover, controller, agent profiles, docs) — anything missing is a finding. Machine-local entries are
   stripped or left behind at export; secrets (`token`, `mobile-key`, `vapid.json`, `relay-secret`, …) never travel
   unless the spec says so.
5. The Linux lock: a second archid for the same fleet refuses on macOS and on Linux; the lock is released however the
   daemon dies; two different fleets on one machine don't block each other; the Linux evidence (container run) matches
   the committed code. Race: two daemons starting at the same instant.
6. Tests fail without their change (revert in a scratch copy).
7. Judge the implementer's concerns, and these in particular: (a) does any daemon or setup seed bundled profiles (or
   write docs) into `agent-profiles/` or `docs/` on a machine that does not own the fleet? If so, a replica diverges
   after every upgrade that adds a bundled profile, and the next handover blocks — the same shape as Task 40's N2 for
   the mission-control home (fixed in R6 by leaving a non-owner's carried roots alone); (b) a machine that seeded
   `agent-profiles/` before this build blocks once as occupied — should a byte-identical or bundled-only folder be
   adopted instead (as O4 adopts setup's home); (c) the Linux lock's abstract socket name can be bound first by another
   local user, which stops the fleet's daemon — acceptable, or should the name or mechanism change; (d) no protocol bump
   for the two new root kinds.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. Run protocol, archid,
cli and web projects and `pnpm typecheck`. `docker` via colima is available for a Linux run (start it if stopped, stop
it after, and restore the docker context to `desktop-linux`).

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault.

## Report

`docs/fleet-handover/ledger/task-42-review.md`: verdict (Approved / Needs fixes), findings ranked Critical / Important /
Minor with file:line, evidence and suggested fix, what you verified clean. End your reply with the verdict line and
the finding counts.
