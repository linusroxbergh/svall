# Fixer D — reviewer docs and the MaxSessions description

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/fix2-reviewer-docs`, branch
`fix2-reviewer-docs`. Read `ledger/inspiration-fix-common.md` first.

Exclusive files: `docs/fleet-handover/README.md`, `docs/fleet-handover/readiness.md`,
`docs/fleet-handover/plan.md`, a new `docs/fleet-handover/deferred.md`, `apps/desktop/mac/SMOKE.md`,
`docs/remote-machines/handover.md`, the "Limits" section of `docs/security/fleet-handover.md`
(around lines 360-375 — don't touch row 28 of its table), and the comment at
`apps/desktop/mac/Sources/Svall/SurfaceManager.swift:28-29` (comment only, no code).

## D1. Reviewers can read everything the docs point them at

The ledger (`/Users/linusroxbergh/linus_laboratory/svall/ledger/`) is not in the repository
(`.git/info/exclude`), yet `docs/fleet-handover/README.md` (13-14, 19-20, 36-46, 51, 63-64),
`apps/desktop/mac/SMOKE.md:18` and `plan.md:1061` point at `ledger/*`, and `spikes-ledger/` (README:43)
isn't tracked either. `readiness.md` is a 2026-09-21 spike handoff still listed at README:35.

- README: describe the work and its evidence without pointing at files a reader can't open. Where the
  ledger is the only record, say it is kept outside the repository. Keep the "Owed before this can
  ship" gates. Keep it about the final state, no history narration.
- Deferred follow-ups: write `docs/fleet-handover/deferred.md` with one line each for what is still
  open from the ledger: `ledger/final-review.md` "Deferred as follow-ups", the follow-up rows of
  `ledger/final-review-triage.md`, `ledger/pr-review-2026-09-29.md` and `ledger/pr-review-2026-10-03.md`
  deferred items, and the `minor (deferred)` / `parked` / `Open:` lines in `ledger/progress.md`.
  Before listing an item, check it is still true at this head (grep the code); drop what has since been
  fixed. Group by area; one line per item with a path where useful. Add a `description:` line only if
  sibling docs use one. README's "Follow-ups" bullet points at this file.
- `readiness.md`: either remove it (and its README row) or mark it in one line at the top as the record
  of the M0 spikes, not current status. Pick the smaller honest option.
- SMOKE.md:18 and plan.md:1061: drop or replace the ledger pointer the same way.

## D2. The MaxSessions description matches the code

`docs/security/fleet-handover.md:365-371` (and `docs/remote-machines/handover.md:326-328`) describe more
than ten terminals on one remote machine (sshd `MaxSessions 10` on the shared master).
- Terminals: `SurfaceManager.swift:44-45` attaches with `ssh -S <sock> -o ControlMaster=no
  -o BatchMode=yes -tt -- <dest> tmux …`; past MaxSessions ssh falls back to a login of its own
  (succeeds only with agent/passphrase-less keys, otherwise ssh quits at once and the terminal shows
  "ssh quit as soon as it started", `SurfaceManager.swift:119-121`). The comment at `:28-29` says
  "never over a login of ssh's own", which contradicts that. Fix the comment to say what happens.
- The helper: the doc (:367) says its 30-second check also opens its own login while the master is full.
  But its commands target `svall-remote.invalid` (`packages/cli/src/controller/ssh.ts:50-54,183`), so a
  fallback login can't resolve; the command fails as `unreachable`, which `hold()` ignores
  (`packages/cli/src/controller/connect.ts:134-136`): the connection is kept but ownership isn't
  re-checked while the master is full. Confirm this. If Docker is available, run a quick check with the
  container harness's sshd (`docs/integration.md`) set to a low `MaxSessions`; otherwise confirm from
  OpenSSH's mux client behaviour and the code, and say in your report which you did. Then correct both
  docs to what happens. Don't claim the one-owner rule is broken: daemon fencing and generations are
  separate safeguards.
