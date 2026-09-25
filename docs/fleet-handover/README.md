# Fleet handover — pick-up guide

Fleet handover moves a whole fleet from one machine to another: its characters, terminals, repos,
worktrees and Claude/Codex sessions. It runs between a Mac and a Linux gateway machine over SSH. One
machine owns the fleet at a time, and a small gateway service on the Linux machine keeps the ownership
record. Everything sits behind `handover.enabled` in fleet.json, which is off by default.

## Status

- **Done:** plan Tasks 1–29, milestones M0–M3. Every task was reviewed; M1, M2 and M3 each got a deep
  review, one fix wave and an on-machine pass. The M3 on-machine pass is done, apart from one real-Claude
  check (below).
- **Next:** Phase E, Tasks 30–33 (stable phone gateway). Then Phase F, Tasks 34–35 (remote ports), and
  Phase G, Tasks 36–39 (hardening, CI, audit, docs, rollout). A final whole-branch review comes last.
- **Code:** one squashed commit on main. The full 139-commit history is on branch
  `fleet-handover-history`, and its commit messages are the best per-change record.

## What is where

| File | What it is |
| --- | --- |
| `spec.md` | The design. It is binding: when the plan and the spec disagree, the spec wins. |
| `plan.md` | Tasks 1–39 with milestone gates. Boxes are ticked through Task 29. |
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

- **Real Claude, both directions.** Real Codex was handed Mac→Linux→Mac with nothing done by hand.
  Real Claude 2.1.280 was checked to report the carried session id on `claude --resume`. The full
  handover of a real Claude session has not run: the test's copied credentials had expired, and the
  Mac keychain read needs the owner's own hands.
- **The by-eye pass in the built app:** Add Machine, the handover sheet, and terminal re-attach after
  an SSH drop.
- **A release signing key.** `allowed_signers` holds only a comment until one exists, so every install
  needs `--allow-unsigned`.
- **Supported Claude range.** It is 2.1.251–2.1.280, and a newer Claude blocks preflight with
  `incompatible_adapter`. The Mac has already auto-updated to 2.1.281. Tasks 38/39 own keeping the range
  current: a fixture plus a live probe for each release.
- **The daemon lock on Linux.** Main's single-daemon lock uses a macOS-only flag, so on the Linux
  gateway it does not stop a second daemon for the same fleet. That is a fencing gap on exactly the
  machine handover targets.
- **Entity docs do not travel.** Main's fleet, island, character and repo docs live under the fleet
  home (`paths.ts`, from #108). The handover inventory treats the fleet home as machine-local, so a
  moved fleet arrives without its docs, and no preflight warning says so. Repo docs are also keyed by
  a hash of the absolute repo path (`docs.ts`), so the path-root mapping must re-key them. Carry and
  re-key them, or at least warn at preflight, before the flag goes on.
- **`agent.pid` travels with the snapshot.** It came in with main's live-pid session guard. On the
  destination, a stale pid that happens to be alive can make the reducer ignore a new session. Strip
  `agent.pid` and `second.agent.pid` in `exportSnapshot` (`portable-path.ts`).
- **A smoke run on the rebased build.** The on-machine passes ran before the squash onto main, which
  ported the branch to zod 4, TS 7 and Node 24. Run one Mac→Linux→Mac round trip before building
  further.
- **CI.** Actions jobs do not start on this repo because of billing. Task 37's fresh-install CI needs
  that sorted first.
- **Phase E.** The phone gateway needs a `tailscale serve` path mapping on the gateway machine, which is
  a machine-wide change, plus a real phone for the M4 gate. Ask the owner first.

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
