# Task 41a — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits ce7b6f1c..f02d50bd. Task brief: `docs/fleet-handover/ledger/task-41-brief.md`
(the 41a half and "Both halves"); implementer's report: `task-41a-report.md`; plan `docs/fleet-handover/plan.md` Task
41; spec `docs/fleet-handover/spec.md` (binding: "Supported environment", "Stable identities", "Add Machine flow" step 2,
"Same paths", "Transfer inventory", "Preflight blockers"); delivery rules `ledger/review-constraints.md`.

## Check

1. Spec compliance, item by item: different home blocks at Add Machine and preflight with the commands the spec asks
   for; a root outside home needs its parent on the destination; path roots, portable paths and the state rewrite are
   gone and state paths travel as they are; every transfer root recorded and copied at its real path; a cwd, `home.cwd`,
   context ref or Git path whose real path differs blocks; replica keys, transcript placement and manifest fields use
   the recorded absolute path. Nothing missing, nothing extra.
2. Safety: the delivery rules still hold after the removals — rsync `--delete` only on absent/reserved or matching-replica
   roots, no destination activation before Commit, argv-only subprocesses, durable 0600 writes. Removing the path map
   must not let a root land somewhere its replica record doesn't name.
3. Dead code: anything the change made dead is gone (types, helpers, protocol fields, tests, doc comments), including web
   UI text about path roots (host setup, handover sheet) — the implementer ran only protocol/archid/cli; run the web
   project too.
4. Tests: each new test fails without its change (revert the relevant source in a scratch copy to check); the old
   `machines.json` load test; the round trip with identical homes.
5. Judge the implementer's concerns: the home check trusts the registry (should `system.info` report `home` and
   preflight compare live?); `parent_missing` is checked at preflight only while a claim still creates missing parents;
   no shim for a previous build's `pathRoots` params (acceptable given the exact-release rule?).
6. The 41b areas it touched mechanically (`git-repair.ts`, session adapters' path map, the Git fixture): correct as a
   bridge until 41b deletes them.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root.

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault.

## Report

`docs/fleet-handover/ledger/task-41a-review.md`: verdict (Approved / Needs fixes), findings ranked Critical / Important /
Minor with file:line, evidence and suggested fix, what you verified clean. End your reply with the verdict line and
the finding counts.
