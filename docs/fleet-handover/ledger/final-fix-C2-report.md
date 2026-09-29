# Final fix wave 3 — Fixer C2 report (spec and docs)

Status: DONE_WITH_CONCERNS. Commits `4f84969c` (spec) and `1cf85aea` (user docs), on `experimental-remote-sessions`
after `be90eb18`, not pushed. No code touched.

## Spec amendments (`docs/fleet-handover/spec.md`)

| Item | Where | Checked against |
| --- | --- | --- |
| I2 | Resting characters: a blocker Freeze finds (before, during or after the rest) reopens the stopped terminals and releases the source; the gateway transaction stays open, an answer re-sends Freeze with no new Begin, Cancel aborts; `status` offers Resume or Abort | source.ts `runFreeze`/`refuse`/`release`; controller handover.ts `freeze`/`decide`; recovery.ts `open` verdict |
| I3 | Compatibility and Preflight blockers: the gateway's authority schema, read from `archi version --json` before the first ownership op, blocks as `incompatible_protocol` | reach.ts `authorityOp({ schema })`, handover.ts `incompatible` |
| I4 | Supported environment and Add Machine step 2: even-year `.04` passes, other Ubuntu warns, other systems refused, 24.04 tested | host.ts `isLts`/`osProbe` |
| I6 | Add Machine steps 3, 8; "Not in version 1" gains the offered terminal | host.ts `toolsProbe`, `agentChecks` (`ssh …, then …` actions) |
| I8 | Agent sessions: `config_difference` compares CLI versions of agents the fleet runs; settings, skills, MCP named, not compared; destination login read afresh | handover.ts `differences`; service.ts `agents(true)` |
| I9 | Add Machine closing paragraph and the CLI list: `host upgrade --rollback [release]` | commands/host.ts, controller host.ts `rollbackHost` |
| I13 | Git graphs: uncarried registrations whose worktree is on the destination are kept; preflight and the claim block on an unreachable kept commit | git-import.ts `keptWorktrees`/`importGraph`; handover.ts `lostCommits` (both call sites) |
| I14 | Ownership authority: higher generation wins, equal with another owner while no journal is open, lower ignored; a gated fleet with no owner.json owns nothing | ownership/state.ts `outranked`, `load`; service.ts adopt |
| I15 | Destination replicas: a record-less root whose content equals what arrives is adopted at the claim | replicas.ts `holding` |
| I16 | Same paths: the registry covers FleetState, FleetConfig, NodeConfig, MachineRecord, the manifest; RPC params validated where received; of the fleet home only the inventory travels | portable-path.ts keys |
| Also | Remote attach command (`ControlMaster=no`, `BatchMode=yes`, `--`, built only while the master answers); signature then unchanged SHA256SUMS; pruning to current + rollback target; unit name `archipelago-archid@`; units carry `CLAUDE_CONFIG_DIR`/`CODEX_HOME`; rsync 3.2.3 floor and warning; idle agent with background command blocks (C05); `--interrupt-after` extends the wait (I1); scrollback not saved (C30); source stops its fleet at Complete (C19); a resume or abort from a third machine refused (C03); `handover.status` result `{ transaction?, quarantined? }` (C27); state schema v8 (was written v7); uninstall refusals and `host remove --force` (C24) | SurfaceManager.swift `AttachCommand`; install-release.mjs; linux/setup.ts; rsync.ts `MIN_RSYNC`; rest.ts `step`; fleet.ts `deactivate`; handover.ts `adopt`; messages.ts; state.ts `STATE_SCHEMA_VERSION`; uninstall.ts `stranded` |

## User docs

| Item | Where | Checked against |
| --- | --- | --- |
| 39b M-a give-up time | handover.md "When a handover stops part way" and Known limitations: ~45 s to ~2.5 min; Complete toward the Mac longest, ends `complete` with a resume left | 39b measurements (47.5–144 s); connection.ts `FIRST_DELAY`/`MAX_DELAY`, `RETRY` 4 attempts, authority.ts 30 s, ssh.ts ServerAlive 15×3 |
| 39b M-b login recheck | errors.md `agent_logged_out`: try again, login asked afresh | registry.ts `agentProber(fresh)`, service.ts `system.info` |
| 39b M-c attach at EOF | handover.md "From a terminal" | commands/handover.ts `runAttach` (`rl.on('close')`) |
| 39b M-d fenced copy | handover.md "Working on the other machine", errors.md daemon `handover_committed` row, SMOKE §4 | ownership/state.ts `assertOwner`; source.ts `runComplete` installs the committed record |
| C24 uninstall | README Uninstall, setup.md, release-notes.md, errors.md `uninstall` step, security doc table header | archid uninstall.ts `stranded`/`runUninstall`; cli uninstall.ts `--force`; host.ts `removeHost` |
| C05 | handover.md choice table and "What restarts", errors.md `agent_unsettled` | rest.ts `step`, `lingering` |
| I1 | handover.md flag table and "What restarts" | rest.ts `waitMs`; messages.ts `serverWait` |
| I9 | setup.md "Looking after it" and Linux bullets, errors.md steps (`machine`, `master`, `probe`, `rollback` for `upgrade --rollback`), release-notes | host.ts `rollbackHost`; setup.ts `rollback` (per-fleet `daemonRuns`) |
| I3 / C08 | errors.md `incompatible_protocol` | reach.ts |
| C32 | setup.md Linux bullets, migration.md, README "What setup changes" | version.ts `currentRunFrom` |
| C15 | handover.md "Working on the other machine" and Known limitations (terminals past ten), SMOKE §9, security threat row and Limits | SurfaceManager.swift; ssh.ts master argv (BatchMode). The C1 report's unknown-host-key claim is not repeated; the security row states the check-to-attach residual |
| C17 / C16 | setup.md, migration.md, release-notes, README, security destructive row and a new accepted risk (a `--no-launchctl` daemon or long-lived `archi` on a pruned release) | install-release.mjs `installRelease`, `otherReleases`; test/install-release.test.ts |
| C18 | security doc: `archi setup --release` checks the signature once, then the SUMS byte for byte, then digests and tree; tests cited | install-release.mjs `stageArchive` |
| L17 | setup.md table, step 2 and "these are yours", errors.md `rsync` step and `rsync_unsupported` (openrsync or older than 3.2.3), release-notes, spec | host.ts rsync step; transfer.ts `farRsync` |
| I5 | setup.md step 6, errors.md `probe` | host.ts `addProbe`, `TMUX_PROBE` |
| I7 | setup.md step 5, errors.md `claude`/`codex` steps | agents.ts `minVersion`; host.ts `agentChecks` |
| C23 | errors.md doctor `daemon env` now both | doctor.ts `daemonEnv` |
| C09 | handover.md studio2 flow reordered (recover `--gateway studio2`, then enable), errors.md `machine` step | host.ts `enableHost`; fleet-recover.ts; confirmed by the wave-2 re-review |
| C10 | setup.md "What is installed where" | registry.ts `load`/`setAside` |
| C14 | handover.md: Settings → Fleet config says where the fleet is | RemoteConnection.swift `notice(forConfig:)` |
| C20 | errors.md gateway `identity_mismatch`: "or none" | gateway/client.ts |
| F1 / L20 | handover.md choice table and attach bullet, errors.md events rows, SMOKE §6 | protocol handover-events.ts; web handover.ts `rowText`; cli handover.ts attach `options(…, e.data.choices)` |
| I12 | readiness.md and spike-results.md probe paths now `scripts/spikes/` | `ls scripts/spikes`; the portability tests' imports |
| integration.md | fenced old owner runs no tmux server; `setup --rollback` checks each fleet's daemon; `host upgrade --rollback` runs in no automated run | machine.mjs (2c1e8cc3); setup.ts; fresh-install.mjs |
| L50 | migration.md and release-notes: reserved names no longer reach a fleet, even with `-p`; setup names the home and the `mv` | profile.ts `RESERVED`, `reservedProfileHomes`; target.ts `targetFor` |
| L48 | migration.md: a split `fleet.json` has no `handover` block | config.ts `initConfig`/`splitLegacy` |
| C07 | security doc durable records: a `fleet.json` change keeps its mode, through a link | config.ts `patchFleetConfig` |
| shq | security doc: `shq` replaces `shellQuote` | archid text.ts |
| Known limitations | handover.md: give-up time, file-count bound, BatchMode logins past ten, Codex quit before its first prompt (F3, A-m2) | as above; fleet.ts `settleAgent` message |
| errors.md sweep | `git_mismatch` no longer points at `host doctor` (it checks no git); `destination_occupied` notes content-equal adoption | doctor.ts check names; replicas.ts |

A's "94 failpoints" appears in no doc I own (only `docs/fleet-handover/README.md`, the orchestrator's). `ledger/task-28-29-contract.md` left as is; user docs give `--interrupt-after` values with `ms`.

## Code behaviour no doc or ruling covers

1. **L50's setup line suggests a command that refuses.** `archid/src/setup.ts:469` prints `…, then archi -p <name>-fleet setup`, but `commands/setup.ts` throws "archi setup configures the private fleet; run archi <name> to open that one" for any non-private target. The docs say only that setup names the home and the `mv`.
2. **The spike probes' "Manual:" header** says "no build or CI runs it", but the three `*-portability.test.ts` files import them and run in the archid suite.
3. **The wave-2 re-review's Important** (host remove's `--force` strands another controller's fleets) is documented as current behaviour: spec, setup.md, errors.md and a security accepted risk. If a cli round narrows `--force` (e.g. to named fleet ids), those four places need updating.
4. A-m1 (a window that survived a destination crash, whose agent exits at a trust prompt after Complete, becomes a plain shell) and the sheet not adopting `handover.blocked`'s `choices` are not documented.

## Verification

- `pnpm vitest run --project cli --project scripts`: 41 files, 1578 passed, 6 skipped (error catalogue 15/15).
- `pnpm typecheck`: clean.
- Every test name newly cited in the security doc was grepped in the tree; every command and flag checked in the commander definitions.

## Concerns

- `host upgrade --rollback` is exercised by no automated or by-hand run (integration.md says so).
- The spec's protocol surface still sketches the design's RPCs (no `handover.inspect`, `claim`, `complete`, `reaches`, `ownership.adopt`); only `handover.status` was brought in line, as the one a fix changed.
