# Task 39 — documentation, migration, smoke test and rollout (brief)

Plan: `docs/fleet-handover/plan.md` Task 39. Spec `docs/fleet-handover/spec.md` is binding ("Manual acceptance",
"Published remote setup", what transfers and what stays, "Not in version 1"). Delivery rules
`ledger/review-constraints.md`. Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`,
branch `experimental-remote-sessions`.

## Split

39a: items 1–5 (docs, error catalogue, migration and downgrade, SMOKE, copy and release notes); report
`task-39a-report.md`. 39b (after 39a's review): item 6, the manual acceptance on release artifacts on the real machines;
report `task-39b-report.md`. Your dispatch names your part.

## Rulings that shape this task (ledgered)

- **The feature gate stays.** `handover.enabled` is not removed in this task. The plan removes it only once M0–M3b and M6
  evidence is attached to a release, and three pieces of that evidence need the owner: his by-eye pass, a release
  signing key, and a first real GitHub run (Actions never start here). The docs describe the flag and how to turn it
  on; the removal is one small follow-up commit.
- **First-run self-install is not built here.** A published app would install its bundled release tree on first launch
  (Task 12's ruling put that in Task 39). The app is distributed from source today (`pnpm desktop:install`), and a
  signed, notarized download needs an Apple identity that does not exist yet. The docs say so, and the owed list names it.

## Do

1. User docs, one folder (e.g. `docs/remote-machines/`): supported hosts (Ubuntu 24.04 x86-64 and arm64, systemd user
   services, linger), Add Machine prerequisites including the same home path, what transfers and what stays (data,
   secrets, entity docs, agent profiles, sessions; pids and machine-local fields stripped), the supported agent versions
   and what a new Claude/Codex release does (the fixture + live probe process), process restart semantics (what the
   rest stops and how each terminal comes back), and the known limitations collected in the ledger (grep
   `known limitation`, `Task 39 docs`, `sheet wording`: two controllers driving one handover, an orphaned Begin, tool
   results still naming the source path, the give-up time after a dropped link, a fleet running nowhere after a drop
   right after Commit, Claude's trust and bypass prompts, Codex's folder trust).
2. Every blocker, warning and error code the handover can emit (preflight blockers, handover NDJSON errors, `status`
   actions, host add/doctor/upgrade failures) with its meaning and safe recovery, including destination divergence,
   pre-commit abort, post-commit activation retry and force-owner disaster recovery. Make it exhaustive by construction:
   a test that fails when the code has a code the catalogue lacks (the codes live in `packages/protocol/src/` and the
   controller).
3. Migration notes for `config.json` → `fleet.json`/`node.json`, source-checkout CLI shims, named fleets, and state
   schema v8 (protocol 17). Prove downgrade behaviour: run an older build against a migrated home in a temp HOME and
   record what happens; if downgrade needs a backup restore, say exactly which files and how.
4. `apps/desktop/mac/SMOKE.md` (create it if missing, or extend the repo's existing smoke doc if one exists elsewhere —
   say which): provisioning, both handover directions, worktrees, agent resume, a foreground blocker, network failure,
   controller kill and relaunch, re-attach after an SSH drop.
5. `README.md` (a short section pointing at the docs), settings/first-run copy for the host setup and handover sheet
   (behind the flag), and release notes for the feature.
6. (39b) The spec's "Manual acceptance" on release artifacts built from a `git archive` snapshot (37b's
   `scripts/release-build.sh`), on the M3b environment (`ledger/m3b-env.md`): grow the test fleet to twelve characters
   across five islands; both directions; working agents finish or are interrupted and a foreground shell blocks
   visibly; the network pulled during each displayed phase gives the documented Abort or Resume; the controller killed
   before and after Commit and `status` reconstructing the right action; a failed destination agent login before freeze
   blocks; a resume failure after Commit leaves one dormant, retryable character without reactivating the source; a
   destination file edited while inactive is never overwritten without explicit archive approval. What only the app's
   UI can show (the sheet reconstructing on relaunch, the same selected character and browser tab URLs) goes to the
   owner's by-eye list with exact steps, not faked from the CLI.

## Verify

39a: `pnpm typecheck`; `pnpm vitest run --project protocol --project archid --project cli --project
@archipelago/desktop-web --project scripts`; `pnpm --filter @archipelago/desktop-web exec playwright test` if copy
changed in the web app; `swift test --package-path apps/desktop/mac` if Swift changed; every doc command you give
checked against the code (flag names, paths). 39b: each acceptance item's result from the machines.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single test files as `pnpm test <path>` from the root.

## Rules

Docs describe what the code does now, plainly, for a user; no history or "previously". Test first where behaviour
changes. Argv-only subprocesses; durable 0600 writes. Never touch `~/.archipelago`, `~/Library`, `~/.claude`,
`~/.claude.json`, `~/.codex` or `~/.ssh`; 39a never touches `/Users/Shared/archi-m3b` or linus-vault. 39b works only
inside the M3b environment as `ledger/m3b-env.md` describes (its wrappers, `archi-m3b` on linus-vault, never the owner's
account, services or `tailscale serve/funnel/set`), with the credential rule of `ledger/task-37-brief.md` for any
real-Claude step, and leaves the environment ready for the by-eye pass (Mac owns the fleet, nothing open, no credential
copy) with `m3b-env.md` updated. No bare `git stash`; don't rm gitignored build output. Comments only where behaviour
is not self-evident, 1–2 lines. Commit subjects: one plain sentence, repository style, no attribution lines. Commit
only your own paths; do not push.

## Report

Your part's report file (uncommitted): what each doc covers and where, the catalogue's exhaustiveness check, the
downgrade result, each acceptance item's result with evidence (39b), the by-eye list (39b), concerns. End your reply
with one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range, and the counts.
