# Fixer host — S1 (host add checks the release the far machine ends on)

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/pm-fix-host`, branch `pm-fix-host`.
Read `ledger/premerge-fix-common.md` and item S1 of `ledger/pr2-premerge-review.md` first.

Exclusive files: `packages/cli/src/controller/host.ts`, `packages/cli/test/host.test.ts` (and other cli host tests if
needed). Don't edit docs; if a user-facing message you add needs a row in `docs/remote-machines/errors.md`, put the
row text in your report.

`addProbe` (`controller/host.ts:277-278`) calls `endToEnd(master, entry)` without a release, and the identity step
checks only the protocol; `upgradeHost` passes `{ release: companion.version }` (`:543`). A far `svall setup --release`
whose new daemon does not answer goes back to the previous release and still exits 0, so a repeat `host add` (or a
first add over an existing install) reports `ready` and saves the registry for a machine on the old release.

- Make the add fail before the registry step when the far machine does not run `companion.version`, with an action
  that says the far setup went back to the release it names and what to do (read the daemon log there; `svall host
  upgrade <name>` or add again). Match upgradeHost's wording where it already says this.
- Tests first: the review's repro (far `setup` output carrying the rollback lines, far version and daemon on 1.2.2,
  archive 1.2.3) for a repeat add and for a first add over an existing install — RED (`ready`) then GREEN (not
  ready, registry untouched, the action names the old release). A normal add stays `ready`.
