# Fleet handover — pick-up guide

Fleet handover moves a whole fleet from one machine to another: its characters, terminals, repos,
worktrees and Claude/Codex/OpenCode sessions. It runs between a Mac and a Linux gateway machine over SSH, and
the Linux account has the Mac's home path, so nothing the fleet records is rewritten. One machine owns
the fleet at a time, and a small gateway service on the Linux machine keeps the ownership record.
Everything sits behind `handover.enabled` in fleet.json, which is off by default.

## Status

- **Done:** version 1 — plan Tasks 1–29 and 36–42, milestones M0–M3, M3b's automated gate and M6. Every
  task was reviewed, M1–M3 each got a deep review, fix wave and on-machine pass, and the whole branch got a
  final review (`ledger/final-review.md`) with one fix wave, then a PR review (`ledger/pr-review-2026-09-29.md`)
  with its own fix wave, and a review of the branch on svall (`ledger/pr-review-2026-10-03.md`) with one more.
  The fault suites (`pnpm test:faults`) crash
  every one of 94 failpoints and fault every controller request; the container harness
  (`docs/integration.md`) hands a fleet over real sshd/rsync/tmux, and a release installs fresh on x86-64
  and arm64; real Claude and Codex sessions resumed both ways on test-server, and the spec's manual
  acceptance passed there from release artifacts (`ledger/task-39b-report.md`). OpenCode characters
  hand over too, from 2.0.22, as their session's export (`ledger/opencode-*.md`).
- **Not done on purpose:** `handover.enabled` is still in place (Task 39's last box). It goes in one
  small commit once the items under "Owed" below exist.
- **After version 1:** Phase E, Tasks 30–33 (stable phone gateway), and Phase F, Tasks 34–35 (remote
  ports). Phase E needs a machine-wide `tailscale serve` path mapping on the gateway machine and a
  real phone for its gate, so ask the owner first.
- **Code:** one squashed feature commit on main, then one commit per change since. The pre-squash
  139-commit history is on branch `fleet-handover-history` in the archived dev repository.

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
| `ledger/m3b-env.md` | The live test environment: the `svall-m3b` account on test-server and the Mac test HOME, both at `/Users/Shared/svall-m3b`, with its harness and teardown recipe. |
| `spikes-ledger/` | The ledger and reports for the M0 spikes (Tasks 1–4). |

Paths inside the ledger point at the old locations. `.superpowers/sdd/2026-09-20-fleet-handover/` is
now `ledger/`, and `docs/superpowers/{specs,plans}/…fleet-handover…` is now `spec.md` / `plan.md`.

## Owed before this can ship

- **The by-eye pass in the built app:** Add Machine, the handover sheet (including the sheet rebuilding
  after a relaunch), terminal re-attach after an SSH drop. `ledger/m3b-env.md` has the steps and how to
  open the test build against the test HOME without touching the owner's own app or fleet.
- **A round trip on the real machines after the PR review's fix wave.** The last one ran at release d0602dc,
  before it; the fix wave changed claims, aborts, the transport's process groups and Linux setup.
- **A release signing key.** `allowed_signers` holds only a comment until one exists, so every install
  needs `--allow-unsigned`; a release tag stops at once when the committed signers don't pin its key.
- **CI.** Actions jobs do not start on this repo because of billing. `ci.yml`'s integration and Swift jobs
  and `release.yml` have run only as the same scripts on this Mac.
- **Licence decisions** (`docs/security/fleet-handover.md`): GhosttyKit's dependency licence texts, the
  statically linked LGPL libintl, and the Flaticon art shipped as files.
- **Svall Dev.** `svall-dev` and its daemon run from the checkout, which carries no `release.json`, companion or
  rsync, so only Svall.app, which carries its controller release, can hand a fleet over.
- **Follow-ups** the final review deferred: `ledger/final-review.md` ("Deferred as follow-ups"), the
  triage's follow-up rows in `ledger/final-review-triage.md`, and `minor (deferred)` lines in the ledger.

## How the work was run

- **Per task:** a fresh implementer wrote the failing test first, then a reviewer checked the diff
  against the task brief and the delivery rules. Findings looped through fix rounds. Minor findings were
  ledgered, not fixed, and the final whole-branch review triages them.
- **Per milestone:** a deep review, one fix wave, and an on-machine pass on real machines.
- **On-machine passes:** these ran on test-server (Ubuntu 24.04), always under a throwaway user such as
  `svall-m3`, created with sudo and deleted afterwards. The owner's own account, fleet, services and
  `tailscale serve` were never touched. On the Mac everything ran under a temp `HOME`, with
  `SVALL_APP_DEST` pointing into it and `--no-launchctl`, so the real `~/.svall`, LaunchAgents,
  `/Applications` and `~/.ssh` stayed untouched.

## Testing notes

- Run `unset SVALL_HOME SVALL_CHAR_ID TMUX` before any test. Shells inside a character point at the live
  fleet.
- Test commands:
  - `pnpm typecheck`
  - `pnpm vitest run --project svalld|cli|protocol|@svall/desktop-web`
  - `swift test --package-path apps/desktop/mac`
  - `pnpm --filter @svall/desktop-web exec playwright test`
  - `pnpm test:faults` (both fault suites in a seeded random order; `--sequence.seed=<n>` reruns one)
  - the container harness and fresh installs: `docs/integration.md`
- Known load flakes; rerun them alone:
  - svalld `fleet.test.ts`: the revive tests, "marks the agent working", "deactivate timeout";
  - svalld e2e "two turns against a fake claude";
  - the `processes.test.ts` real-ps case and the `source.test.ts` FIFO timer;
  - cli `cli.test.ts` browser and `ssh.test.ts` spawn-count, `transfer.test.ts` "keeps a dropped link's partial copy";
  - web `e2e/ide.spec.ts:136`, `e2e/keys.spec.ts:3` and `e2e/card.spec.ts:122`.
- Tests that need real sshd use `SVALL_TEST_SSH=<host>`. They cannot run against localhost on the Mac.
