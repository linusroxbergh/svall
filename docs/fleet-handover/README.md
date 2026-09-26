# Fleet handover — pick-up guide

Fleet handover moves a whole fleet from one machine to another: its characters, terminals, repos,
worktrees and Claude/Codex sessions. It runs between a Mac and a Linux gateway machine over SSH, and
the Linux account has the Mac's home path, so nothing the fleet records is rewritten. One machine owns
the fleet at a time, and a small gateway service on the Linux machine keeps the ownership record.
Everything sits behind `handover.enabled` in fleet.json, which is off by default.

## Status

- **Done:** plan Tasks 1–29, milestones M0–M3. Every task was reviewed; M1, M2 and M3 each got a deep
  review, one fix wave and an on-machine pass. The M3 on-machine pass is done, apart from one real-Claude
  check (below).
- **Next:** Phase D2, Tasks 40–42 and the M3b gate: rebase and smoke, the same home path on both
  machines, and main's newer fleet data. Then Phase G, Tasks 36–39 (hardening, CI, audit, docs,
  rollout), which ends version 1. A final whole-branch review comes last.
- **After version 1:** Phase E, Tasks 30–33 (stable phone gateway), and Phase F, Tasks 34–35 (remote
  ports). Phase E needs a machine-wide `tailscale serve` path mapping on the gateway machine and a
  real phone for its gate, so ask the owner first.
- **Code:** one squashed commit on main. The full 139-commit history is on branch
  `fleet-handover-history`, and its commit messages are the best per-change record.

## What is where

| File | What it is |
| --- | --- |
| `spec.md` | The design. It is binding: when the plan and the spec disagree, the spec wins. |
| `plan.md` | Tasks 1–42 with milestone gates. Boxes are ticked through Task 29. |
| `spike-results.md`, `readiness.md` | What the M0 spikes proved and what they changed in the spec. |
| `ledger/progress.md` | **Read this before continuing.** Every dispatch, every `Ruling:` (a decision taken on the owner's behalf, with its cost if wrong), every deferred minor and parked finding, and every milestone gate. Grep it for `Ruling:`, `parked`, `minor (deferred)` and `carried`. |
| `ledger/task-N-brief.md`, `task-N-report.md` | Each task's requirements and its implementer's report, with test evidence. |
| `ledger/task-28-29-contract.md` | The fixed contract between the handover helper and the app: NDJSON events and exit codes. |
| `ledger/review-constraints.md` | The delivery rules every reviewer was given. |
| `ledger/m2-*`, `ledger/m3-*` | Milestone deep reviews, fix waves, and on-machine briefs and reports. The M3 on-machine reports are `m3-onmachine-{A,A2,B,C}-report.md`. |
| `spikes-ledger/` | The ledger and reports for the M0 spikes (Tasks 1–4). |

Paths inside the ledger point at the old locations. `.superpowers/sdd/2026-09-20-fleet-handover/` is
now `ledger/`, and `docs/superpowers/{specs,plans}/…fleet-handover…` is now `spec.md` / `plan.md`.

## Owed before this can ship

- **Tasks 40–42** (`plan.md`, Phase D2):
  - a smoke run on the rebased build, since the on-machine passes ran before the squash onto zod 4,
    TS 7 and Node 24;
  - the same home path on both machines, which ends the Claude and Codex version pins. The Claude
    adapter accepts only 2.1.251–2.1.280, so the Mac's newer Claude blocks preflight with
    `incompatible_adapter` today;
  - entity docs, which live under the fleet home and do not travel yet;
  - `agent.pid`, which travels and must not;
  - the daemon lock on Linux, whose macOS-only flag leaves the gateway machine open to a second daemon
    for the same fleet.
- **Real Claude, both directions** (M3b gate). Real Codex was handed Mac→Linux→Mac with nothing done
  by hand. Real Claude 2.1.280 was checked to report the carried session id on `claude --resume`. The
  full handover of a real Claude session has not run: the test's copied credentials had expired, and
  the Mac keychain read needs the owner's own hands.
- **The by-eye pass in the built app** (M3b gate): Add Machine, the handover sheet, and terminal
  re-attach after an SSH drop.
- **A release signing key.** `allowed_signers` holds only a comment until one exists, so every install
  needs `--allow-unsigned`.
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
