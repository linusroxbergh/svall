# Task 40b, second run — the round trip on the fixed build (brief)

The first run (`W/task-40-smoke-brief.md`, report `W/task-40-smoke-report.md`) stopped BLOCKED before its first
handover on D1 (tmux 3.4 listing). The branch has since been rebased onto newer main (`W/task-40-rebase2-report.md`)
and the Task 40 fix wave landed (`W/task-40-fixes.md`, report `W/task-40-fixes-report.md`: F8 fixes D1, F9 stages the
agent profiles, F2 strips carried pids, F3 keeps launch flags, F10–F12). W = `docs/fleet-handover/ledger` in the
worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`.

Everything the first brief authorised still holds, and nothing more: read its "Authorised by the owner" and "Shell
notes" sections and follow them. The environment is up as `W/m3b-env.md` describes (archi-m3b on linus-vault, Mac test
HOME `/Users/Shared/archi-m3b`, the Mac owns fleet `private` at generation 0, `notes` idle-closed). The first run's
scripts are in its scratchpad `$S` (named in m3b-env.md); reuse them.

Since the first run, the orchestrator ran Task 41's probe in the same accounts: `/Users/Shared/archi-m3b/probe/` on
both machines, `~/agents/claude-2.1.283` and the owner's Mac Claude credential in archi-m3b's `~/.claude/` (see
`W/task-41-probe-report.md`). Leave them; they are not part of the fleet.

## Steps

1. Rebuild the app and the linux-x64 companion from HEAD (the release name must now come from the commit, F12). Install
   the app into the test `ARCHI_APP_DEST`, run the bundled setup as before, `archi host upgrade m3b`, restart the Mac
   daemon from the new release. Confirm both daemons seed the bundled agent profiles (F9) and that m3b's daemon now
   lists its tmux windows (F8: `_keep` only, no stray character). Delete `~/.archipelago.t40-aside` on m3b.
2. Snapshot the Mac (`s2-before-mac`), then run the first brief's step 6 (Mac → Linux) and step 7 (Linux → Mac, with the
   controller on the Mac), with every check it lists. Add:
   - the carried state on m3b has no `agent.pid`/`second.agent.pid` from the Mac (F2);
   - a character launched with extra flags (give one mocked character a start command with a flag main keeps, e.g.
     `--model x`) resumes with them on the destination, and a Codex `--profile` flag is dropped (F3);
   - alpha-feat keeps its agent profile on m3b if the profile travels, or record exactly what the destination shows
     (profiles travelling is Task 42; F9 only seeds the bundled ones);
   - the idle-closed `notes` arrives dormant with its transcript and wakes on open on Linux, then travels back.
3. Leave the environment running (the Mac owns the fleet, no transaction open) and update `W/m3b-env.md` in place.

## Report

`W/task-40-smoke2-report.md`, in the first report's format: per step the commands (tokens redacted), key output,
PASS / FAIL / NOT RUN, suspected file:line for every FAIL; a Defects list with severity and evidence; one status line:
DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT.
