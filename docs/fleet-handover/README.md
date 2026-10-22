# Fleet handover — pick-up guide

Fleet handover moves a whole fleet from one machine to another: its characters, terminals, repos,
worktrees and Claude/Codex sessions. It runs between a Mac and a Linux gateway machine over SSH, and
the Linux account has the Mac's home path, so nothing the fleet records is rewritten. One machine owns
the fleet at a time, and a small gateway service on the Linux machine keeps the ownership record.
Everything sits behind `handover.enabled` in fleet.json, which is off by default.

## Status

- **Done:** version 1 — plan Tasks 1–29 and 36–42, milestones M0–M3, M3b's automated gate and M6, then
  the svall port (PR #2 on `worktree-port-pr-1`, main merged twice, protocol 25) and four fix waves on it,
  each a set of sub-PRs reviewed and re-reviewed before integration (`ledger/progress.md` from "2026-10-21"):
  the sheet's recovery states, the connection banner and Machines panel, controller recovery paths, flag-off
  inertness, agent-session honesty, transfer safety, the split-brain guard, the review step, Machines list
  and switch; then what the real-machine round trip found (index mode bits, transcript path after a cwd
  move, one OpenCode login probe, second-terminal rollback) and what the integration deep review found
  (`ledger/pr2-integration-review-18082655.md`: reserved-name fleets in uninstall, per-terminal launch
  flags, a durable prepare proof, submodule filters and archives, route-aware stops, forgetting a dead
  source). The fault suites crash every failpoint and fault every controller request; the container harness
  (`docs/integration.md`) hands a fleet over real sshd/rsync/tmux and passes at every integrated head; a
  release installs fresh on x86-64 and arm64; real Claude, Codex and OpenCode sessions resumed both ways on
  linus-vault at 10447557, 18082655 and 14377218 (`ledger/pr2-onmachine-report-10447557.md`).
- **Not done on purpose:** `handover.enabled` is still in place (Task 39's last box). It goes in one
  small commit once the items under "Owed" below exist.
- **After version 1:** Phase E, Tasks 30–33 (stable phone gateway), and Phase F, Tasks 34–35 (remote
  ports). Phase E needs a machine-wide `tailscale serve` path mapping on the gateway machine and a
  real phone for its gate, so ask the owner first.
- **Code:** one squashed feature commit on main, then one commit per change since. The pre-squash
  139-commit history is on branch `fleet-handover-history` in archipelago-dev.

## What is where

| File | What it is |
| --- | --- |
| `spec.md` | The design. It is binding: when the plan and the spec disagree, the spec wins. |
| `plan.md` | Tasks 1–42 with milestone gates. Boxes are ticked for every version-1 task; Task 39's flag removal and Phases E–F are open. |
| `spike-results.md`, `readiness.md` | What the M0 spikes proved and what they changed in the spec. |
| `ledger/progress.md` | **Read this before continuing.** Every dispatch, every `Ruling:` (a decision taken on the owner's behalf, with its cost if wrong), every deferred minor and parked finding, and every milestone gate. Grep it for `Ruling:`, `parked`, `minor (deferred)` and `carried`. |
| `ledger/task-N-brief.md`, `task-N-report.md` | Each task's requirements and its implementer's report, with test evidence. |
| `ledger/task-28-29-contract.md` | The fixed contract between the handover helper and the app: NDJSON events and exit codes. |
| `ledger/review-constraints.md` | The delivery rules every reviewer was given. |
| `ledger/m2-*`, `ledger/m3-*` | Milestone deep reviews, fix waves, and on-machine briefs and reports. The M3 on-machine reports are `m3-onmachine-{A,A2,B,C}-report.md`. |
| `ledger/final-review*.md`, `ledger/final-fix-*.md` | The final whole-branch review (candidates, validation, triage of every ledgered minor), its fix waves A, C1, B, C2 and D with their reports and re-reviews, and the deferred follow-ups. |
| `ledger/m3b-env.md` | The live test environment: the `archi-m3b` account on linus-vault and the Mac test HOME, both at `/Users/Shared/archi-m3b`, with its harness and teardown recipe. |
| `spikes-ledger/` | The ledger and reports for the M0 spikes (Tasks 1–4). |

Paths inside the ledger point at the old locations. `.superpowers/sdd/2026-09-20-fleet-handover/` is
now `ledger/`, and `docs/superpowers/{specs,plans}/…fleet-handover…` is now `spec.md` / `plan.md`.

## Owed before this can ship

- **The by-eye pass in the built app at the final head:** Add Machine, the Machines list and switch, the
  review step and Move, the sheet rebuilding after a relaunch, terminal re-attach after an SSH drop, and a
  round trip both ways on linus-vault. `ledger/pr2-onmachine-env.md` and `/Users/Shared/svall-m4/kit/STEPS.md`
  have the steps and how to open the test build against the test HOME without touching the owner's own app.
- **A notarized `pnpm release` dry run.** Merging puts the companion into the next public DMG whatever the
  flag says; Gatekeeper, the carried rsync and node have not been through notarization.
- **A release signing key.** `allowed_signers` holds only a comment until one exists, so every install
  needs `--allow-unsigned`; a release tag stops at once when the committed signers don't pin its key.
- **CI.** Actions jobs do not start on this repo because of billing. `ci.yml` has no Playwright step, and its
  integration and Swift jobs and `release.yml` have run only as the same scripts on this Mac.
- **Licence decisions** (`docs/security/fleet-handover.md`): GhosttyKit's dependency licence texts, the
  statically linked LGPL libintl, and the Flaticon art shipped as files.
- **A published download** would need the app to install its bundled release on first launch; the app
  ships from source today (`pnpm desktop:install`). No arm64 companion is carried.
- **Follow-ups** still open after the four fix waves: `docs/fleet-handover/deferred.md` at a84bf57d (the
  MinimalPlans board "svall remote machines" mirrors it), minus what the ledger marks fixed; the lows the
  last reviews left in the PR notes (`writeDurable`'s temp beside a config, the Mac-as-source lost-record
  wording, a stale OpenCode answer passing the Zen warning); plus the pre-commit resume canary, the nightly
  live resume test, and GitHub Support purging the pre-rewrite commit of `fix4-sessions`.

## How the work was run

- **Per task:** a fresh implementer wrote the failing test first, then a reviewer checked the diff
  against the task brief and the delivery rules. Findings looped through fix rounds. Minor findings were
  ledgered, not fixed, and the final whole-branch review triages them.
- **Per milestone:** a deep review, one fix wave, and an on-machine pass on real machines.
- **On-machine passes:** these ran on linus-vault (Ubuntu 24.04), always under a throwaway user such as
  `archi-m3`, created with sudo and deleted afterwards. The owner's own account, fleet, services and
  `tailscale serve` were never touched. On the Mac everything ran under a temp `HOME`, with
  `ARCHI_APP_DEST` pointing into it and `--no-launchctl`, so the real `~/.archipelago`, LaunchAgents,
  `/Applications` and `~/.ssh` stayed untouched.

## Testing notes

- Run `unset ARCHI_HOME ARCHI_CHAR_ID TMUX` before any test. Shells inside a character point at the live
  fleet.
- Test commands:
  - `pnpm typecheck`
  - `pnpm vitest run --project archid|cli|protocol|@archipelago/desktop-web`
  - `swift test --package-path apps/desktop/mac`
  - `pnpm --filter @archipelago/desktop-web exec playwright test`
  - `pnpm test:faults` (both fault suites in a seeded random order; `--sequence.seed=<n>` reruns one)
  - the container harness and fresh installs: `docs/integration.md`
- Known load flakes; rerun them alone:
  - archid `fleet.test.ts`: the revive tests, "marks the agent working", "deactivate timeout";
  - archid e2e "two turns against a fake claude";
  - the `processes.test.ts` real-ps case and the `source.test.ts` FIFO timer;
  - cli `cli.test.ts` browser and `ssh.test.ts` spawn-count, `transfer.test.ts` "keeps a dropped link's partial copy";
  - web `e2e/ide.spec.ts:136`, `e2e/keys.spec.ts:3` and `e2e/card.spec.ts:122`.
- Tests that need real sshd use `ARCHI_TEST_SSH=<host>`. They cannot run against localhost on the Mac.
