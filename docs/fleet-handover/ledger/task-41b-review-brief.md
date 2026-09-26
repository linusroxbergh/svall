# Task 41b — review (brief)

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`, commits 5521fa2a..366ced84. Task brief: `docs/fleet-handover/ledger/task-41-brief.md`
(41b half and "Both halves"); implementer's report `task-41b-report.md`; 41a's reports for the bridge it removes
(`task-41a-report.md`, `task-41a-fix1-report.md`, `task-41a-fix2-report.md`); the probe `task-41-probe-report.md`; plan
Task 41; spec `docs/fleet-handover/spec.md` (binding: "Git repository graphs", "Agent sessions", "Terminal records",
"Compatibility"); delivery rules `ledger/review-constraints.md`.

## Check

1. Git: unlisted registrations removed from the destination copy without removing branch refs, then validation of
   `git worktree list`, `git status` and staged changes against the manifest; no gitfile rewrite, no `git worktree
   prune`/`repair` anywhere; `git-repair.ts` and its test gone; O6 (uncarried worktrees keep their registration on their
   own machine) and O8 (ignorecase/precomposeunicode) still hold where meaningful.
2. Sessions: files copied byte for byte (compare hashes in the tests); no path rewriting, no record/attachment type
   lists, no version maximum; file discovery (Claude JSONL + session-specific sidecars and subagent data; Codex rollout),
   a minimum version (from main's per-CLI adapters if the implementer shared it) and the missing-file blocker kept;
   `agent.transcriptPath` is the same absolute path on the destination; Claude 2.1.283 passes preflight.
3. Safety: nothing written outside claimed roots and the session stage; argv-only subprocesses; no destination activation
   before Commit.
4. Dead code gone (types, helpers, protocol fields, fixtures, doc comments, ledger-irrelevant); tests fail without their
   change (revert in a scratch copy).
5. The acceptance tests from the plan: the Task 3 worktree fixture validates without repair; the Claude and Codex
   fixtures resume after an unchanged copy; a session written by a CLI newer than every fixture is accepted; an unlisted
   registration is removed but its branch ref stays.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root. Run protocol, archid,
cli and web projects and `pnpm typecheck`.

6. Judge the implementer's concerns: the Claude adapter still blocks on an unknown file kind inside a session's own
   folder (Task 22's whitelist) — against the spec's "depends only on where its CLI keeps a session's files, not on the
   record format… no maximum", should everything under the session's own folder travel instead; Claude's floor stays
   in `claude.ts` (2.1.251) while Codex's comes from main's adapter; the import no longer checks git can open the copy
   before removing registrations; the ssh-gated remote Git test was deleted, not ported; spike scripts, the
   `*-portability` tests and fixture READMEs still describe rewrite-and-repair.

## Rules

Read-only. Editing, creating, staging or committing any file other than your review file fails the task. Never touch
`~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault.

## Report

`docs/fleet-handover/ledger/task-41b-review.md`: verdict (Approved / Needs fixes), findings ranked Critical / Important /
Minor with file:line, evidence and suggested fix, what you verified clean. End your reply with the verdict line and
the finding counts.
