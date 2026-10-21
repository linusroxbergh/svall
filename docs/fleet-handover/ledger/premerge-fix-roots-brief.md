# Fixer roots — S3 (a warning when a folder root carries repositories no character uses)

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/pm-fix-roots`, branch `pm-fix-roots`.
Read `ledger/premerge-fix-common.md` and item S3 of `ledger/pr2-premerge-review.md` first.

Exclusive files: `packages/svalld/src/handover/inventory.ts`, `packages/svalld/src/handover/source.ts`,
`packages/svalld/src/handover/manifest.ts` (if needed), `packages/protocol/src/handover-events.ts` and the protocol
file that defines warning codes, `packages/cli/src/commands/handover-view.ts`, `apps/desktop/web/src/handover.ts`,
`apps/desktop/web/src/HandoverSheet.tsx`, `docs/remote-machines/errors.md`, `docs/remote-machines/handover.md`, and
the tests for them.

Main 0.9.0's opening shell sits at `config.defaultCwd` (the projects folder, e.g. `~/Developer`). The inventory makes
every character cwd a `cwd` root and skips only the home (`inventory.ts:245`), so a new Mac fleet's first handover
copies every repository in that folder with no word: preflight shows only counts and `too_many_files` names no root.

Ruling (orchestrator): keep the spec's rule that a character's cwd is a root; don't skip `defaultCwd` (a character can
really work there). Add a preflight **warning** (not a blocker) whose entity is the character, when a non-Git `cwd`
root holds Git repositories (a `.git` below it) that no character's cwd or repo uses. The message names the folder and
how many such repositories it carries, and the way out (move the character's shell into the folder it works in, or
close it, or exclude paths with `handover.exclude`). The CLI prints it as it prints other warnings; the sheet shows it
as it shows other warnings. Add its row to errors.md (and a sentence in handover.md if it lists warnings).

- Use what preflight already has (the names manifest and the git graphs); no new filesystem walk if the manifest holds
  the names. Keep it cheap on a large root.
- Tests first: the review's repro (worker at Developer/app, shell at Developer, unrelated repo beside) gives the
  warning naming the shell; a cwd root with no unused repository gives none; a repo used by another character isn't
  counted. RED then GREEN. Web: the sheet renders the new code (dom or unit test as for other warnings). CLI view test.
