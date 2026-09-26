# Task 40a, second rebase — onto origin/main 86fcac4d (brief)

Same task as `ledger/task-40-brief.md` (read it: rules, integration checks, verification, flakes, report shape);
this brief only names what differs. The first rebase's report is `ledger/task-40-rebase-report.md`, its review
`ledger/task-40-rebase-review.md`.

## Where

Branch `experimental-remote-sessions` at f9ad8a8c: seven commits on 615da858 (8d321c0d feature, three docs commits,
fe22ba68 "The fleet handover branch runs on current main", two ledger commits). `origin/main` is 86fcac4d, about 40
commits ahead: #18 main-agent onboarding (a main agent kept in config.json, `archi agent`, an adapter per agent CLI with
binary, version floor and login probe, setup only for installed CLIs, doctor checks per CLI, Codex crew with AGENTS.md
and skills, a fake codex), #20–#23 (island drag and delete dialog, phone card and context, softer island glow). About
20 files conflict.

## Differs from the first rebase

1. `git rebase origin/main`, keeping every commit. Conflict resolutions go into the commit they belong to; semantic
   ports that no conflict forces go into fe22ba68 if they are rebase ports, or one new commit at the tip with subject
   `The fleet handover branch runs on current main's agent adapters`. `PROTOCOL_VERSION` stays one above main's (read
   main's; if main bumped past 14, go one above it). The state schema stays one above main's.
2. Integration checks new with #18:
   - main's `mainAgent` (and any other new key) in config.json goes into the branch's split: fleet.json or node.json by
     the branch's rule (fleet-wide intent travels in fleet.json; machine facts stay in node.json) — say which and why;
   - main's per-CLI adapters (binary, version floor, login probe) and the branch's session adapters
     (`packages/archid/src/handover/sessions/`) and host add/doctor agent checks: keep both working now; Task 41b will
     make the session adapters minimum-only and Task 40's fix wave (F11) aligns host add's probes with main's adapters.
     Note in the report where the two could share code;
   - every RPC method #18 added is classified in the ownership guard;
   - setup for installed CLIs only (and `CODEX_HOME` creation) against the branch's release setup and Linux systemd
     setup;
   - `desktop-install.sh` and its test (main reworked the output) against the branch's release install.
3. Report: `ledger/task-40-rebase2-report.md`, shaped like the first.

Do not push. End your reply with the status line the first brief asks for.
