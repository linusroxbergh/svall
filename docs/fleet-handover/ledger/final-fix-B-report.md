# Final fix wave 2 — Fixer B report (controller and CLI)

Status: DONE_WITH_CONCERNS. 47 commits, `4fedee29` … `2c1e8cc3` on `experimental-remote-sessions`, interleaved with
Fixer A's follow-up `7b9830a2` and the orchestrator's ledger commits `93710326`, `5f857fa5` and `bfa45ed3`. Not pushed.
Every item in `final-fix-B.md` is done.

## Items

RED is the failure the new or changed test showed before the fix; "refactor" means no behaviour changed and the
existing tests stayed green.

| Item | What changed | Commit | RED → GREEN |
| --- | --- | --- | --- |
| I7 (A's fallout) | Doctor and host add print the whole floor (`2.1.251`, `0.155.0`). doctor.test fixtures run Claude 2.1.251. | 4fedee29 | doctor.test and host.test: `needs 0.155 or newer` against `0.155.0`; a new Claude 2.1.250 case → pass. The 6 fixture failures clear. |
| C27 (A's fallout) | recovery.test, world.ts and handover.test build `handover.status` as `{ transaction?, quarantined? }`. | 919f7de9 | `pnpm typecheck` error at recovery.test.ts:30 → clean |
| C03 | `adopt()` refuses when this machine is neither the source nor the destination, with `Stopped` and `safe: []`. The message names both: "run it on mac or trift". `resume` and `abort` route that through `stopped()`. `transfer()` refuses unless exactly one party has a master. Security doc's `rsync --delete` row updated. | 28213a2c | handover.test "resumed or aborted from a machine that is neither…": `status 'complete'`, where a third machine had rsynced onto its own disk; "never runs a transfer whose parties are both reached over ssh…" → pass |
| C02 | `localOwner()` in controller/authority.ts is the one local authority adapter. `resolveOwner` uses it when `gatewayId === registry.localId`, and `authorityOp`'s local branch too. | ae15e82b | connection.test "asks the authority on its own socket when this machine is the gateway…": `the gateway … has no ssh destination` → pass, with no ssh spawned |
| L01 | `archi gateway owner` goes through `localOwner`, and the eight-way `send` switch is gone. | b7d94143 | refactor (gateway.test 10/10) |
| C20 (cli) | `identify` uses A's `versionMachineId` and `remoteOwner` uses `ownerAnswer`; the local parser is gone. `OwnerAnswer` comes from archid. Version fixtures print pretty JSON, as `archi version --json` does. | b6790c12 | connection.test "reads the machine id only where archi version --json prints it…": a banner quoting another id was taken → pass |
| shq (A's export) | cli's `shellQuote` is replaced by `shq` from `@archipelago/archid/text`. The quoting test stays in ssh.test. | fed71d28 | refactor |
| C06 | `farProfile(target)` in target.ts gives the target's name for a profile home other than private, else nothing (the far default). program.ts passes it to routed commands, `connect`, `handover` and `fleet recover`. | 0c5454d9 | cli.test "asks a far machine for the named fleet ARCHI_HOME selects…": argv lacked `-p work` → pass; target.test |
| C07 | `host enable`, `host remove` and `fleet recover --gateway` write fleet.json with A's `patchFleetConfig`. | 7184b962 | host.test ×2 and fleet-recover.test ×1 with a symlinked 0640 fleet.json holding an unknown key: the link was replaced → pass |
| L13 | A machine-id mismatch in `remoteConnectionInfo` throws `MachineMismatch`. | cc414a55 | connection.test `not an instance of MachineMismatch` → pass |
| C08 + L11 | `transient()` retries an `SshError` only when connection.ts's `retryable` says so, and never retries `Refused` other than `authority_unreachable`. Delays come from `FIRST_DELAY`/`MAX_DELAY`. `start()` maps `SshError('version')` to `incompatible_protocol`. | 8de4d39e | handover.test "blocks at once, naming the upgrade…": `interrupted`; "asks again only after…": `['other', 3]` → pass |
| C09 | `enableHost`'s machine step refuses when fleet.json names a different gateway that the registry still holds. The action is `archi fleet recover --force-owner local --gateway <name>` for one gone for good. | 52035f31 | host.test: machine step `ok` → `fail`, no ssh; the same-name flow (old id no longer registered) still enables |
| C10 | `MachineRegistry.load` warns on stderr (or `o.warn`) when it moves a registry aside. `recovered` is the newest `machines.json.broken-*` at any later load. `setAside()` adds where it went to every "not a machine in the registry" / "no machine … in the registry" error in connection, reach, host, fleet-recover and handover. | 33a9339b | registry.test (no warning; later load unaware) and connection.test (message lacked the copy) → pass |
| C18 (cli) | `inspectCompanion` stages with C1's `stageArchive(archive, work, { verify, allowUnsigned: true })`, `signed: s.signed && release.unsigned !== true`. Security doc's controller bullet updated. | 1fdcbee9 | refactor (install.test + host.test 104/104); gated GNU tar test passes on colima |
| C16 (cli) | When `before === companion.version`, the upgrade's rollback runs `setup --rollback` with no release (`remoteRollback`'s `to` is now optional). It says "ran a release named X before, which this install replaced; it runs release Y, the newest one kept there", or "no other release is kept there". | 6aa46941 | host.test ×2: `'1.2.3'` not `'1.2.2'`; no failed step → pass. The fake far archi now refuses a rollback with nothing to go back to. |
| I9 | `archi host upgrade <m> --rollback [release]` runs `rollbackHost`: machine, master, rollback (the installed archi's `setup --rollback [release]`), then probe (doctor + `endToEnd` at the release now current). It is refused with `--release` or `--allow-unsigned`. The Linux `archi setup --rollback` checks each fleet unit's daemon with `daemonRuns` and fails naming any that does not answer. | a8683af3 | setup.test ×2 (probe never ran; resolved instead of rejecting); host.test `rollbackHost is not a function` → pass |
| C32 | Bare `archi setup` (and `--check`) on an installed release run from `currentRunFrom()` = `current`. | 7e9ba379 | setup.test with `isRelease` mocked true: `this is an installed release, not a checkout` → pass (shims point into `current`) |
| L04 | `currentRunFrom()` in version.ts is used by setup, fleet provision, doctor's unit PATH and launch. | af8ea003 | refactor |
| C24 (cli) | `archi uninstall --force` passes `force` to `runUninstall`. `host remove` runs the far `archi uninstall --force` after its own checks. Security doc row updated. | 14dff486 | uninstall.test (force not passed) and host.test (argv lacked `--force`) → pass |
| C23 | Doctor's `daemon env` runs on Linux: the fleet's unit (`unitDir/archipelago-archid@<fleet>.service`) must hold `unitEnv(k, v)` for `agentHomesEnv`'s values. The login shell is asked with a 10 s bound, which leaves host add's 30 s doctor probe its time. | 29e6a40a | doctor.test: `daemon env` undefined on Linux → pass |
| A's item 5 | `archi version` uses `STATE_SCHEMA_VERSION`. | f3bf9ac0 | refactor |
| L10 | Preflight returns `identity_mismatch` ("<name> already runs this fleet, at generation g; there is nothing to hand it") right after `gateway.get()`, so `start()`'s `ssh_interactive`/identity mapping covers it. `Preflight`'s summary and manifest are optional. `runHandover`'s owner pre-check, `Transaction.owner` and `Connected.owner` are gone. The view names this machine as the source of a push. | bd25a7a8 | controller test: ops `['gateway:get']` only; cli test: the start goes to the controller → pass |
| I3 | For the handover (`authorityOp(…, { schema: true })`), the far gateway's `authoritySchema` from `archi version --json` must equal `AUTHORITY_SCHEMA_VERSION` before any owner op. Otherwise `SshError('version')` naming the gateway, which preflight blocks on as `incompatible_protocol`. | 9665d2a1 | handover.test: the gateway was asked and answered → refuses, owner never asked; a start blocks as `incompatible_protocol` |
| I5 | host add's probe step is `addProbe`: `endToEnd`, then `archi gateway owner get` on the machine's own authority (any authority answer passes; `disconnected`/`timeout` fail), then a tmux window on a private socket under `$TMPDIR` with the units' PATH, which is killed afterwards. | 565a5bdb | host.test: remote calls lacked `archi gateway` and `sh -c`; a failing authority or tmux still registered the machine → pass. The script was run by hand on this Mac: exit 0, no socket left. |
| L17 | host add's rsync step warns below `MIN_RSYNC` (via `rsyncVersion`), with "install rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship". | 92716c2c | host.test: `ok` → `warn` with action |
| L34 | `downloadCompanion` returns the cached file when its digest is the pinned one, before reading or fetching the URL. | 200ea96e | install.test: ENOENT on the deleted `file:` archive → pass |
| C11 | cli `events.ts` and `recovery.ts`, and web `handover.ts`, take `SafeAction`, `CharacterResult`, `Outcome`, `Standing`, `Verdict`, `EntityData`, `Names` and `HandoverEvent` from `@archipelago/protocol`; the web re-exports them for its importers. Web fixtures (unit, dom, e2e) now carry whole verdicts (`journals`, `action`). The two archid fault-test files import `Outcome` from protocol, one line each. | 5a23c400, c2a004e7 | typecheck-driven; web suite 726 → green; error-catalogue.test now reads the protocol file |
| 39b F1 | `EntityData.archivedTo` in protocol. The claim sends it as its own field, not an `error`, and every later progress line of that root carries it (`entryEvent(tx, p, archivedTo)`). The CLI prints "what was there is kept at X" once. The sheet keeps it on the row: `rowText` appends it, and `readable` checks it. | 32cece90 | controller, CLI view and web tests (the note was an `error`, replaced by the next line) → pass |
| L20 | `handover.blocked` carries the run's `choices` (protocol type); attach's menu builds on them. | 510f7051 | cli test: the attached answer dropped `terminateShells`/`archiveRoots`; the controller event lacked choices → pass |
| L16 | A transfer that failed before its first entry reports `result.failure.error`. | cad9bce2 | handover.test: `the transfer ended failed` → the reason |
| L07 | fleet recover reads the controller journal with `fileStore(...).read()`. | f4028248 | refactor |
| L06 | fleet recover uses `rememberOwner`. | 2a43bfc6 | refactor |
| L21 | The CLI formats bytes in base 1000, as the sheet does. | 6b623dd8 | cli test: `1.4 MB` → `1.5 MB` |
| L05 | handover-view imports `ARCHIVABLE` from archid replicas. | 677ceeef | refactor |
| L08 | `TransferOptions.stateDir` and `transactionDir`'s base are required; the `configDir` default is gone. | 1087662c | refactor |
| L09 | `ControllerJournal` has no `entries`, `pending` or `error`. Complete's pending run leaves the journal open without writing them, and `interrupted()` writes nothing. The archid fault suite now counts 14 `controller.journal` writes in a move. | 988228e8, 471dae21 | refactor; faults table 15 → 14 |
| L12 | `Check` and `MARK` live in `checks-view.ts`, and `REFUSED` in controller/host.ts. | 8e6be955 | refactor |
| L14 | `observe()` asks status and ownership in parallel, and both sides in parallel. In the no-journal branch a machine found by its status is not asked again. | 2d34d24e | two tests fail on the previous code (a status gated on ownership hangs; 3 status calls for 2 machines) → pass |
| L15 | connectHandover's `side()` opens a far daemon when it builds the side and takes `fleetHome` from its answer; the throwing getter is gone. `reconnecting(connect, first?)` reuses that client. `Handover.side()` retries a build as a daemon call would, except in `observe()` and C03's name lookup. | b0107b31 | no RED (no path read `fleetHome` before an answer); one real-adapter fixture now reports `fleetHome`, as every companion does |
| L19 | `blockersOf` parses with `z.array(Blocker)`, and falls back to one `path_unsupported` blocker with the refusal's message. | b4255c68 | handover.test: a malformed list went through as-is → pass |
| C25 | `RETRIED`, `ConnectionInfo`, `parseControl`, `StepError`, `routeFile`, `MAX_PASSES` and `issueLine` are no longer exported. | eddeddad | refactor |

Outside the brief, needed for the round trip: `24517b9e` (the harness sets `handover.enabled` on a fleet.json that, after
A's L48, holds no `handover` key) and `2c1e8cc3` (after A's C19 a fenced machine runs no tmux server; the snapshot reads
"no server running" as no windows). Both are one-line fixes in C1's `scripts/integration`.

## Decisions

- **C03.** The stop has `safe: []` and names both parties, since only the machine that started the run holds the
  controller journal.
- **C06.** The private fleet and an unmanaged `ARCHI_HOME` send no `-p` (the far default), so the hints and the argv
  for the private fleet are unchanged.
- **C08.** Only preflight turns a version fault into the `incompatible_protocol` blocker. After Begin it stops the run
  `interrupted` with the message, not retried.
- **C09 and the docs.** `docs/remote-machines/handover.md`'s "account under another user name, fleet running there"
  flow (`host add studio2`, then `host enable studio2`) is now refused at enable while `studio` is registered. The action
  given runs `fleet recover --force-owner local --gateway studio2` first, then enable. **C2 needs to reorder that flow.**
- **I3.** Only the handover's gateway adapter checks the schema. `fleet recover` does not, since a recovery must stay
  possible, and a local gateway is not checked, being the same machine and release.
- **I5.** "The gateway authority" is taken as the far machine's own, which every companion runs.
- **I9.** The per-fleet check sits in the far `setup --rollback`, since only the far machine knows its units. The
  controller then probes as an upgrade does.
- **F1 and L20** changed `packages/protocol/src/handover-events.ts` (two optional fields), as the brief suggested.
- **L15.** Building a far side now dials its daemon. Errors surface at the build, not at the first call, and are retried
  the same way.
- **archid test edits** (C11's `Outcome` imports, L09's count) are each one line, in files Fixer A was not editing.

## Verification

- `pnpm typecheck`: clean, both tsconfigs.
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project scripts`:
  200 files, 4506 passed, 8 skipped, 0 failed. The scripts project reran after the harness fixes: 62 passed, 2 skipped.
- `pnpm test:faults`: 1306 passed, seed `1790660278622`. That is 1310 less the 4 `controller.journal` cases L09 removed.
- Integration round trip (arm64, colima): `scripts/integration/fleet-handover.sh --scenarios none` ALL PASS, after the
  two harness fixes above. The first two runs failed at those two harness spots, and the handover itself completed.
- `ARCHI_TEST_GNU_TAR=archi-it:machine` host.test far check (C18): passed.
- colima was stopped when I began. I started it, left no containers, stopped it again, and put the docker context back
  on `desktop-linux`.

## Concerns

- **Load flakes not in the README list.** transfer.test "keeps a dropped link's partial copy…" failed once in the full
  run (`6291456 < 6291456`) and passed alone 3/3; the cut is timing-sensitive. Two host.test cases (the pinned-companion
  ones) timed out once while the cli fault suite ran beside them, and passed alone and in both full runs.
- **Docs owed to C2:**
  - errors.md: `daemon env` now runs on Linux too.
  - errors.md: `rollback` and `probe` are also steps of `upgrade --rollback`.
  - errors.md: host add's `probe` now asks the gateway authority and opens a tmux window, and the `rsync` step warns.
  - errors.md: `incompatible_protocol` also covers a gateway on another authority schema.
  - The docs don't yet cover `archi uninstall --force` or `archi host upgrade --rollback`.
  - handover.md's studio2 flow (see C09).
  - integration.md says the old owner has "no windows but `_keep`"; it now runs no tmux server.
- **C24.** `host remove` forces past the far refusal, including gateway records of fleets that another controller keeps
  on that machine, which this Mac cannot see.
- **The sheet.** It does not adopt `handover.blocked`'s `choices`; only `handover attach` does. An app answering a run
  it did not start builds on its own choices.
- **L15.** C03's name lookup and preflight's same-machine refusal dial the machine to read its name.
