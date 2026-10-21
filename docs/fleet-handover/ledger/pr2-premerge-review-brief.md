# PR #2: what to tackle before merging

PR: https://github.com/linusroxbergh/svall/pull/2 (branch `worktree-port-pr-1`, head b31fe003, draft). It is up to date
with main (origin/main 091be0b0, Svall 0.9.0), and GitHub reports it MERGEABLE.

## Goal

A deep review of the whole PR against main that answers one question: what should be done before this merges? Report
only: no edits to the branch, no pushes, no PR comments.

## Read first

- `docs/fleet-handover/README.md` is the pick-up guide, including what is owed before shipping. `spec.md` is binding.
- `docs/fleet-handover/deferred.md` lists the findings already known and left open. Don't re-raise them, but say when
  one should be done before merging rather than after.
- The earlier PR reviews and their fixes are in this ledger: `pr-review-2026-09-29.md`, `pr-review-2026-10-03.md`,
  `pr-review-2026-10-07.md`, plus the tail of `progress.md`.

## Scope and weight

- The whole diff `origin/main...origin/worktree-port-pr-1`.
- Weight what no review has seen yet:
  - the inspiration fix wave, 09a4d83c..f8938750;
  - today's merge of main 0.9.0 with its follow-ups, f8938750..b31fe003. Those follow-ups are the opening shell made on
    a Mac only, keep awake for a local owner only, held prompts against a freeze, and the integration mocks' prompt lines.
- Merge risk. `handover.enabled` is off by default, but some changes ship to everyone: the config split into
  fleet.json/node.json, state schema 9, protocol 22, new top-level commands, the Claude Code 2.1.251 floor, the
  settings Machines pane, and any shared code the handover touched. Judge what a user who never turns the flag on would
  meet after updating, and what going back to 0.9.0 costs them.

## How

- Start in a new worktree at `origin/worktree-port-pr-1`. Don't use `port-pr-1` or `fleet-handover-impl`.
- Use the deep-review skill on PR #2, with sub-agents on Opus 5.5.
- Verify every finding before it goes in the report: a file:line, plus a reproduction or a failing test you ran.
- Run `unset SVALL_HOME SVALL_CHAR_ID TMUX` before any test. Known load flakes are in the README. Two
  `test/desktop-install.test.ts` failures also happen on main, because this Mac's Homebrew node is built `--shared`.
- Never touch the real `~/.svall`, LaunchAgents, `/Applications` or `~/.ssh`. Ask the owner before anything on
  linus-vault or the Mac keychain.
- Run the container harness (`docs/integration.md`) only when a finding needs it. If you do, stop colima afterwards
  and set the docker context back to `desktop-linux`.

## Output

Write `pr2-premerge-review.md` next to this brief. Sort the findings into four groups:

- **Must fix before merge**
- **Should fix before merge**
- **Follow-up ticket**
- **Checked, not an issue**

For each finding give the claim, the evidence, the suggested change and a rough cost. Keep it concise. Then append
one line to `progress.md` and end with a summary of at most 10 lines.
