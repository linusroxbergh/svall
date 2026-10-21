# Rebase PR #2 onto Svall 0.12.0

svall PR #2 (https://github.com/linusroxbergh/svall/pull/2) is two commits on main 8defeaec (0.11.0): `46e37bc5` (D1,
the Claude painted-cursor fix) and `26fb94b1` (the whole handover change, behind `handover.enabled`). Main is now
`c499c984` (0.12.0, 19 commits: per-robot load, the Load tab, `char.sleep`, Delete ending every process a robot
started, `svall-hook procs`). D1 has been cherry-picked onto main as `ac75767c` (branch `d1-painted-cursor`, its own
PR). Rebase the handover commit onto `ac75767c`, so the branch is main + D1 + one handover commit.

## Setup

- Repo `/Users/linusroxbergh/linus_laboratory/svall`. Make a new worktree `.claude/worktrees/pr2-rebase-012`, branch
  `pr2-v3` at `26fb94b1`, then `git rebase --onto ac75767c 46e37bc5`. Don't touch `pr2-final` (the PR head) or
  `d1-painted-cursor`.
- `unset SVALL_HOME SVALL_CHAR_ID TMUX` in every shell. The `node` shell function is broken (nvm lazy loader):
  `unset -f node` first. Never run a bare `svall` or touch `~/.svall*`, `~/.config/svall`, launchd or the owner's app.
- Nothing is pushed. Don't touch the PR.

## What to resolve

`git merge-tree` names 15 conflicting files: web `SideCard.tsx`, `selectors.ts`, `test/store.test.ts`; protocol
`test/messages.test.ts`; svalld `api/methods.ts`, `api/server.ts`, `dormancy.ts`, `fleet.ts`, `fleet/poll.ts`,
`main.ts`, tests `api`, `fleet`, `guards`, `helpers`, `mobile`. Keep both sides' intent. Also read the clean merges
in files both sides touched; last time four of them were wrong without a conflict.

Things that need a decision, not just a merge:

1. **Protocol.** Main took `PROTOCOL_VERSION` 22 for `char.sleep` and `load.get`. The PR's protocol becomes 23. Find
   every place the PR names 22 (code, tests, docs, release notes, `docs/remote-machines/migration.md`) and move it.
   State schema: main stays 8 unless you find otherwise; the PR's 9 stays.
2. **migration.md "Downgrading"** names the release before as 0.11.0 (protocol 21, state schema 8). Make it 0.12.0
   with its real numbers, after checking `git diff v0.11.0 v0.12.0 -- packages/svalld/src/state.ts` (and the config
   files) for anything an older build would misread.
3. **Main's new writers against the freeze and ownership rules** (spec `docs/fleet-handover/spec.md` is binding):
   nothing writes fleet state, ends processes or types into terminals while frozen or not the owner. Check
   `char.sleep`, the Delete process sweep, auto-sleep's new paths and the Load tab's buttons: each must refuse the way
   the PR's other mutations do (`writable()`, `ownership.assertOwner('mutation')`), and every new API method needs
   its class in `packages/svalld/src/ownership/guard.ts` (`load.get` a read, `char.sleep` a mutation). Test each
   refusal red → green.
4. **Sleep against the handover.** A robot slept on request is never woken on its own. Check what main stores for
   that and whether it survives a handover both ways (import in `handover/validate.ts`, the destination's revive):
   a slept robot must stay asleep on the far side, not be revived. Rest must not treat Sleep's own process ends as a
   blocker, and Sleep during rest must refuse (frozen).
5. **Process attribution.** Main's `c75d6cda` attributes processes to robots; the PR has its own `ProcessTable`. Make
   them work together; don't refactor one into the other. If you see a cheap shared reader, note it, don't do it.
6. **Linux.** `svall-hook procs` is Swift, Mac only. On the Linux companion the load sampler and Delete must fall
   back cleanly (main says Delete then ends just the tree). Check nothing in the companion build pulls the Swift
   helper or fails without it.
7. The PR's docs and the app's handover sheet: if main's Load tab or Sleep changes what a user sees during a
   handover (a frozen fleet's Load buttons, for one), say so where the PR already documents frozen behaviour.

## Commit and verify

- Two commits on main: `ac75767c` unchanged, then the handover commit with `26fb94b1`'s message body (update counts
  or versions it names). No Claude attribution, no Co-Authored-By. Minimal comments, no history narration anywhere.
- Run: `pnpm typecheck`; full `pnpm test`; `pnpm test:faults` (both fault suites); `pnpm e2e` (Playwright); Swift
  tests (`apps/desktop/mac`, as the repo runs them). Known, not ours: `scripts/desktop-install.test` ×2; workspace
  watch tests, attach "Shift+Enter as CSI u", terminals "takes Enter or Esc", scribe-opencode ENOTEMPTY (pass alone;
  rerun alone to show it).

## Report

Write `docs/fleet-handover/ledger/pr2-rebase-012-report.md` in the worktree
`/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/fleet-handover-impl` (that file only, not committed):
DONE / DONE_WITH_CONCERNS / BLOCKED, the two SHAs, each conflict and how it was resolved (one line each), the
decisions for 1–7 with file:line, tests added, suite counts, and anything you were unsure of.
