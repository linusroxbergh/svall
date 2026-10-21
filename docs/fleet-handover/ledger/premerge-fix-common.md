# Pre-merge fix wave — common rules (PR #2, base b31fe003)

Origin: the pre-merge review `ledger/pr2-premerge-review.md` (read the item your brief names there; it holds the
evidence and repro). The owner asked for the must and should items to go into PR #2. Five fixers work in parallel,
each in its own worktree and branch with exclusive files.

- Work only in your own worktree and branch (named in your brief). Never touch the other pm-fix-* worktrees,
  `port-pr-1`, `fleet-handover-impl`, `pr2-premerge-review` or the main checkout. Don't push.
- Run `unset SVALL_HOME SVALL_CHAR_ID TMUX` before any test. Deps are installed. Run vitest from the worktree root:
  `pnpm vitest run --project cli|svalld|protocol|@svall/desktop-web [file]`; scripts tests:
  `pnpm vitest run test/<file>`. Swift: `swift test --package-path apps/desktop/mac` (needs GhosttyKit.xcframework; if
  missing, a temporary gitignored symlink to the main checkout's copy, removed afterwards). Playwright: a single spec,
  on a free port (another worktree may hold 5183). `docs/fleet-handover/README.md` "Testing notes" lists known load
  flakes; rerun those alone.
- Never touch the real `~/.svall*`, `~/.config/svall`, LaunchAgents, `/Applications`, `~/.ssh`, the keychain or
  linus-vault. Anything that runs svall/svalld uses a temp HOME. No colima.
- Write the failing test first for every behaviour change, and show it RED then GREEN.
- `docs/fleet-handover/spec.md` is binding. Delivery rules: `ledger/review-constraints.md`.
- Match the surrounding code: naming, comment density, and the docs' prose style (plain, present tense, says what is,
  never history: no "previously", "now", "no longer", ticket or PR ids). Comments only where behaviour isn't
  self-evident, 1–2 lines.
- Smallest change that solves the item. Don't refactor or "improve" neighbours. No protocol bump (protocol 22 has
  not shipped).
- Commits: one plain present-tense sentence as the subject (repo style), no attribution lines. One commit per item.
- Finish with: typecheck clean, the touched projects' vitest passing, plus Swift/Playwright if you touched those.
  Report: status (DONE / DONE_WITH_CONCERNS / BLOCKED), commits (sha + subject), RED→GREEN evidence, verification
  summary, and any concern or minor you chose not to fix.
