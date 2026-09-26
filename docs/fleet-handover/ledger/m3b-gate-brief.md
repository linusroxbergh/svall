# M3b gate — on-machine pass (brief)

W = `docs/fleet-handover/ledger` in the worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl` (branch
`experimental-remote-sessions`, HEAD at dispatch). Spec `docs/fleet-handover/spec.md` is binding.

Goal (plan M3b gate, verbatim): "On the rebased build, with a linus-vault account whose home is the Mac's, hand a fleet
with mocked agents, one real Claude session and one real Codex session Mac→Linux→Mac. Both conversations resume under
their original session ids, entity docs arrive, and a second daemon on Linux refuses to start." The owner's by-eye pass
in the built app comes after this and is not yours.

You verify; you do not change product code. When something fails, capture the exact command, output and the file:line
you believe is responsible, and keep going with whatever else can still be proven. A defect that blocks the rest ends
the pass early with status BLOCKED.

## Read first

`W/m3b-env.md` (the environment and its harness), `W/task-40-smoke-brief.md` ("Authorised by the owner" and "Shell
notes" — both still hold, plus what this brief adds), `W/task-40-smoke2-report.md` (the last round trip and its
checks), `W/task-41-probe-report.md`, and the reports of what changed since: Task 40's fix round 1
(`task-40-fix1-report.md`: R5 host upgrade, R6 setup leaves a replica's home alone), Task 41a/41b (`task-41a-report.md`
and its fix reports, `task-41b-report.md`), Task 42 (`task-42-report.md`, review `task-42-review.md`) and the rebase checkpoint onto main 4067bfea
(the last lines of `progress.md`).

## Authorised by the owner, beyond the first brief

- Real Claude on both machines with his Mac login: read the keychain item `Claude Code-credentials`
  (`security find-generic-password -s "Claude Code-credentials" -w`) straight into the Mac test HOME's
  `~/.claude/.credentials.json` and archi-m3b's `~/.claude/.credentials.json` (0600; never print it). Do this right
  before the real-Claude steps, check `claudeAiOauth.expiresAt` leaves at least 90 minutes, and finish the real-Claude
  steps inside that window, so no test-side Claude refreshes and rotates his login. If less than 90 minutes is left,
  stop and report NEEDS_CONTEXT. Delete both copies at the end of the pass unless the by-eye pass needs them (say which).
- Real Claude binaries: the owner's `~/.local/share/claude/versions/2.1.283` copied into the Mac test HOME's `agents/`,
  and archi-m3b's `~/agents/claude-2.1.283` (already there). A wrapper dispatches `claude` to the real binary in the
  real-Claude character's folder and to the mock everywhere else, on both machines (Part C did the same; see
  `W/m3-env.md` "Part C changes").

## Steps

1. Rebuild the app and the linux-x64 companion from HEAD; install the app into the test `ARCHI_APP_DEST`; the bundled
   setup; restart the Mac daemon. `archi host upgrade m3b`: it must end ready with no rollback and report the release m3b
   runs (R5). Check m3b's mission-control home is untouched by the upgrade (R6) — the first handover must not need
   `--archive` for `home`. Expect it once for `agent-profiles`: m3b seeded that folder when it owned the fleet in
   the second smoke, before profiles travelled (Task 42 review m3); record the blocker's text, then `--archive` it.
2. Fixture additions on the Mac: one real-Claude character (one trivial turn, a code word to recall); entity docs made
   through the product — a fleet doc, an island doc, a character doc and a repo doc (a repo one of the fixture's
   characters uses); `alpha-feat` keeps its custom profile `m3b-role`; one registered worktree no character uses, with
   a stash (the Git import removes unlisted registrations on the destination and keeps branch refs; the kept-on-its-own-
   machine rule O6 must hold both ways — Task 41b replaced the repair, and its ssh-gated remote Git test was dropped,
   so this pass is that test). Snapshot.
3. Mac → Linux. Everything the second smoke checked, plus: the real Claude character resumes on Linux under its
   original session id (SessionStart reports it; a turn recalls the code word; one transcript file); the real Codex
   characters likewise; the four entity docs are found on Linux by the same keys (through the product's docs API or UI
   read path, not only on disk); `m3b-role` arrives and alpha-feat's brief uses it; no pid travelled.
4. On Linux, with the unit running: start a second archid for the same fleet home as archi-m3b (the release's archid,
   the same `ARCHI_HOME`) — it must refuse with "already running" and leave the running daemon and its state untouched.
   Same on the Mac against the test daemon.
5. Linux → Mac (`handover local`). The same checks; compare against the original snapshot.
6. Leave the environment running for the by-eye pass (the Mac owns the fleet, no transaction open) and update
   `W/m3b-env.md` in place, including exactly how the owner can open the test build's app against the test HOME
   without touching his own app or fleet — or, if that can't be done safely, say so and why.

## Report

`W/m3b-gate-report.md`: per step the commands (tokens redacted), key output, PASS / FAIL / NOT RUN, suspected file:line
for every FAIL; a Defects list with severity (Critical/Important/Minor) and evidence; one status line: DONE,
DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT.
