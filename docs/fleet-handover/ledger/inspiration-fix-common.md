# Inspiration fix wave — common rules (PR #2, base 09a4d83c)

Origin: a comparison of PR #2 with Ateam and herdr, validated by sol (high) and by verifiers who read
and reproduced each finding. Seven small items go into PR #2 before merge, split over three fixers with
exclusive files.

- Work only in your own worktree and branch (named in your brief). Never touch the other fix2-*
  worktrees, `port-pr-1`, or the main checkout. Don't push.
- Run `unset SVALL_HOME SVALL_CHAR_ID TMUX` before any test. Install deps first if `node_modules` is
  missing (`pnpm install --frozen-lockfile`). Run vitest from the repo root:
  `pnpm vitest run --project cli|svalld|protocol|@svall/desktop-web [file]`. Swift:
  `swift test --package-path apps/desktop/mac`. Playwright: `pnpm --filter @svall/desktop-web exec playwright test [spec]`.
  `docs/fleet-handover/README.md` "Testing notes" lists known load flakes; rerun those alone.
- Write the failing test first for every behaviour change, and show it RED then GREEN.
- `docs/fleet-handover/spec.md` is binding. Delivery rules: `ledger/review-constraints.md`
  (argv-only subprocesses, DI for ssh/fs, new UI stays behind `handover.enabled`).
- Match the surrounding code: its naming, comment density and prose style in docs (plain, present
  tense, describes what is, never history — no "previously", "now", "no longer", ticket ids).
  Comments only where behaviour isn't self-evident, 1–2 lines.
- Smallest change that solves the item. Don't refactor or "improve" neighbours. No protocol bump.
- Commits: one plain present-tense sentence as the subject (repo style, e.g. "Mission control's cards
  clear the map's bottom edge"), no attribution lines. One commit per item is fine.
- Finish with: typecheck clean, the touched projects' vitest passing, plus Swift/Playwright if you
  touched those. Report: status (DONE / DONE_WITH_CONCERNS / BLOCKED), commits (sha + subject), the
  RED→GREEN evidence, verification output summary, and any concern or minor you chose not to fix.
