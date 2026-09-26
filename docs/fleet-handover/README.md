# Fleet handover — pick-up guide

Fleet handover moves a whole fleet from one machine to another: its characters, terminals, repos,
worktrees and Claude/Codex sessions. It runs between a Mac and a Linux gateway machine over SSH, and
the Linux account has the Mac's home path, so nothing the fleet records is rewritten. One machine owns
the fleet at a time, and a small gateway service on the Linux machine keeps the ownership record.
Everything sits behind `handover.enabled` in fleet.json, which is off by default.

## Status

- **Done:** plan Tasks 1–29 and 40–42, milestones M0–M3. Every task was reviewed; M1, M2 and M3 each
  got a deep review, one fix wave and an on-machine pass. Task 40 rebased onto current main and ran a
  Mac→Linux→Mac round trip with real Codex on the rebased build. Tasks 41–42 made both machines share one
  home path, so nothing is rewritten, and carry entity docs and agent profiles.
- **Next:** the M3b gate: an on-machine round trip with real Claude and real Codex, entity docs and the
  Linux lock, then the owner's by-eye pass. Then Phase G, Tasks 36–39 (hardening, CI, audit, docs,
  rollout), which ends version 1. A final whole-branch review comes last.
- **After version 1:** Phase E, Tasks 30–33 (stable phone gateway), and Phase F, Tasks 34–35 (remote
  ports). Phase E needs a machine-wide `tailscale serve` path mapping on the gateway machine and a
  real phone for its gate, so ask the owner first.
- **Code:** one squashed feature commit on main, then one commit per change since. The pre-squash
  139-commit history is on branch `fleet-handover-history` in archipelago-dev.

## What is where

| File | What it is |
| --- | --- |
| `spec.md` | The design. It is binding: when the plan and the spec disagree, the spec wins. |
| `plan.md` | Tasks 1–42 with milestone gates. Boxes are ticked through Task 29 and for Tasks 40–42. |
| `spike-results.md`, `readiness.md` | What the M0 spikes proved and what they changed in the spec. |
| `ledger/progress.md` | **Read this before continuing.** Every dispatch, every `Ruling:` (a decision taken on the owner's behalf, with its cost if wrong), every deferred minor and parked finding, and every milestone gate. Grep it for `Ruling:`, `parked`, `minor (deferred)` and `carried`. |
| `ledger/task-N-brief.md`, `task-N-report.md` | Each task's requirements and its implementer's report, with test evidence. |
| `ledger/task-28-29-contract.md` | The fixed contract between the handover helper and the app: NDJSON events and exit codes. |
| `ledger/review-constraints.md` | The delivery rules every reviewer was given. |
| `ledger/m2-*`, `ledger/m3-*` | Milestone deep reviews, fix waves, and on-machine briefs and reports. The M3 on-machine reports are `m3-onmachine-{A,A2,B,C}-report.md`. |
| `ledger/m3b-env.md` | The live test environment: the `archi-m3b` account on linus-vault and the Mac test HOME, both at `/Users/Shared/archi-m3b`, with its harness and teardown recipe. |
| `spikes-ledger/` | The ledger and reports for the M0 spikes (Tasks 1–4). |

Paths inside the ledger point at the old locations. `.superpowers/sdd/2026-09-20-fleet-handover/` is
now `ledger/`, and `docs/superpowers/{specs,plans}/…fleet-handover…` is now `spec.md` / `plan.md`.

## Owed before this can ship

- **Real Claude, both directions** (M3b gate). Real Codex was handed Mac→Linux→Mac on the rebased
  build. Task 41's probe resumed a real Claude 2.1.283 session and a real Codex rollout, copied
  unchanged, in both directions. The full handover of a real Claude character has not run yet. Real
  Claude under a Mac temp HOME logs in from a copied `~/.claude/.credentials.json`, which the owner
  approved.
- **The by-eye pass in the built app** (M3b gate): Add Machine, the handover sheet, and terminal
  re-attach after an SSH drop.
- **A release signing key.** `allowed_signers` holds only a comment until one exists, so every install
  needs `--allow-unsigned`. Before release, Task 38 must also restore the far machine's own signer check
  on `host upgrade` (see the ledger's Task 40 fix round 1).
- **CI.** Actions jobs do not start on this repo because of billing. Task 37's fresh-install CI needs
  that sorted first.

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
- Known load flakes; rerun them alone:
  - archid `fleet.test.ts`: the revive tests, "marks the agent working", "deactivate timeout";
  - archid e2e "two turns against a fake claude";
  - the `processes.test.ts` real-ps case and the `source.test.ts` FIFO timer;
  - cli `cli.test.ts` browser and `ssh.test.ts` spawn-count;
  - web `e2e/ide.spec.ts:136`, `e2e/keys.spec.ts:3` and `e2e/card.spec.ts:122`.
- Tests that need real sshd use `ARCHI_TEST_SSH=<host>`. They cannot run against localhost on the Mac.
