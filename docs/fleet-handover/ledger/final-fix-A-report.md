# Final fix wave — Fixer A report (daemon and protocol)

Status: DONE_WITH_CONCERNS. Commits `e1c5df49` … `c1150cd3` on `experimental-remote-sessions` (interleaved with C1's), not
pushed. Every item in `final-fix-A.md` is done; two leave cli fallout for Fixer B (below).

## Items

| Item | What changed | Commit | RED → GREEN |
| --- | --- | --- | --- |
| C01 | `Fleet.settle()` waits for `background`, `reviving` and `openingSecond` (allSettled). A revive or second terminal asked while the fleet was writable re-checks `assertOwner('terminal')` after its `ending` wait and after its window listing, before any window opens; the handover's own revives (run frozen on abort) are not fenced. | e1c5df49 | fleet.test "opens no window for a revive admitted before a freeze…": `expected true to be false` (settle returned while the revive waited) → pass |
| C04 | After each `kill-window` the rest lists the windows again; a window still live (not dead) throws, so the freeze fails with the journal open and the slot live, never dormant. A server gone counts as gone. Security doc row updated. | b49e1670 | rest.test "stops with the journal open and the slot live…": `promise resolved {ok:true}` → pass |
| C05 | `step()`: an `agent-ready` terminal whose agent still has tool commands is terminated only when chosen, else `agent_unsettled` "is idle with work still running in the background: <cmd> still runs"; preflight's `unapproved` reports it. | e1b8e623 | rest.test "rests an idle agent still running commands…" and unapproved test → pass |
| I1 | The rest's wait extends to `interruptAfterMs` instead of capping it; `serverWait('handover.freeze')` adds `choices.interruptAfterMs` to the budget. | f9a118d3 | rest.test "waits for an interrupt chosen for later…", messages.test serverWait → pass |
| C30 | Scrollback capture and `RestedTerminal` fields gone; `SettleResult.terminals` is `TerminalRef[]`; `capture` left the rest's tmux Pick. | edad4c66 | refactor; rest tests adjusted |
| C19 | Source Complete calls `fleet.deactivate()` after installing the committed record, behind new failpoint `source.complete.deactivate`. The fault world's `settledOn` now asserts the non-owner's fleet is inactive, across every case. | 9fa1234a | source.test complete `expected [] to equal ['deactivate']`; faults "reaches each step of the move run" `expected true to be false` → pass |
| C20 | Daemon gateway client refuses an answer with no machine id (`identity_mismatch`), a silent ssh stays `disconnected`. New exported parsers `versionMachineId`, `ownerAnswer`, `OwnerAnswer`; quoting via `shq`. Security doc row updated. | c10e70f2 | server.test "refuses an answer whose archi names no machine…" `expected the call to be refused` → pass |
| C21 | `mintMachineId` uses `createDurable`; EEXIST read-back kept. | 7d66c9cc | machine.test "puts the file in place only once its whole content is on disk" `expected to throw` → pass |
| L51 | `writeTemp`/`writeDurable` remove their own temp on a thrown failure. | 223ef9d2 | durable.test "removes its temp when the write fails at %s" (×4) → pass |
| L38 | jsonfile.ts's `writeJsonAtomic` gone; push store uses atomic.ts's durable one. | 25604570 | refactor |
| C07 (helper) | `patchFleetConfig(file, patch)` in config.ts: keeps raw keys, `undefined` drops a key, refuses a file or result the schema rejects, writes through a link with the file's mode (durable). `saveMainAgent` and `setGateway` use it. | 4822c466 | config.test patchFleetConfig ×3 (setGateway wrote defaults) → pass |
| L48 | `initConfig` writes `{ id }` and the seed as given; `splitLegacy` routes only keys the legacy file held. | f23cb0ac | config-migration.test ×2 → pass |
| L42 | `readFleetConfig(paths)` exported; source reads through it (InvalidConfig). | 9f9b39cd | source.test "says what in fleet.json is wrong…" (got a ZodError dump) → pass |
| I7 | `AGENTS.claude.minVersion = [2, 1, 251]`; the Claude session adapter's `min` reads it. | 46594748 | agents.test `expected true to be false` → pass |
| F2 | `agentProber` takes `fresh`; `system.info` (`agentAdapters`) probes afresh, so preflight and freeze read current logins. | 31844465 | source.test prober `expected 6 to be 9` → pass |
| D1 | The poll drops a live main terminal's `revive` once `carried()` is false (as `attachSlot` does for the second). While carried (no activation row), it stays: ed25ada8's retry-after-crash flags hold (fault suite di case passes). | b1c4613e | fleet.test "drops the resume command a live terminal kept…" timed out → pass |
| F3 | Fleet keeps a per-terminal resume record (session, carried revive command) from a revive/open-second that types a resume of the terminal's own session until its SessionStart. If the agent ran and is back at the shell for two polls, or never came up within 60 s, the terminal goes dormant with the session, that revive command and a `resumeError`, and its window is closed (tracked in `ending`). `doOpenSecond` now waits for a closing second (and is fenced as in C01). | 9ffe11ea | fleet.test ×2 "lays a revived terminal dormant again…" timed out / not dormant → pass |
| C22 | Trust-prompt watch backs off 2 s → 60 s, ends when the journal closes or after an hour; adapter resolved once per watch; Claude's config is re-read only when its stat (ino/size/mtime/ctime) changes. | 11dff1f8 | destination.test "looks … less and less often" `150 > 9`, "stops … after an hour" → pass; sessions.test "reads its config again only once…" `4 reads` → pass |
| C33 | A claim writes a provisional seal record (roots, no files, the claim's excludes) behind new failpoint `destination.claim.seal`. An abort before prepare (dropStage with no journal, or discard with no prepare-time files) scans each root still `receiving` for the transaction and seals it at the source's generation, then removes the record. Security doc row updated. | a00bb71c | destination.test "seals each root it claimed as the transfer left it…" `state: receiving` → pass |
| I10/L43 | `relaySecret` gone from the prepare params, Paths, `fleetKeys` and the prepare write; tests and security doc updated. | f0cadfd4 | messages.test (key now stripped) → pass |
| C24 | `runUninstall` refuses unless `force`: a fleet home with a journal, a fleet this machine owns under a gateway, or gateway fleet records under the prefix; message names `archi handover local`, `archi host remove`, `--force`. Exported `stranded(homes, prefix)`. Security doc row updated. | bc314a61 | uninstall.test "refuses, unless forced…" `promise resolved` → pass |
| C23 | Archid unit renders `Environment="CLAUDE_CONFIG_DIR=…"`/`CODEX_HOME` after LANG (`@ENV@`). `agentHomesEnv(run)` reads them from this process, else `$SHELL -lic` (marker line, stderr ignored, failure → none). `setupLinux` uses it when `env` is not given. | 9badde9a | linux-setup.test ×2 → pass |
| L45 | Provision writes its unit through `writeUnits(o, fleetOnly)` (log dir 0700), carries the agent homes, reads owner.json through `OwnerCache`. | 3d694952 | linux-provision.test "keeps the units' logs … 0700 …" `493 ≠ 448` → pass |
| C26 | `absoluteProblem`/`filesProblem` exported from replicas.ts; validate.ts uses them. | bf6106f2 | refactor |
| C27 | `handover.status` result is `{ transaction?, quarantined? }`; `SourceJournal.progress`, `characterStatus` and `HandoverEntityStatus` gone. | b972aced | messages/service tests → pass |
| C28 | `Store.replace` and its tests deleted (the one update test kept under `Store.update`). | b4d135e8 | — |
| C29 | `HelloResult` has no `capabilities`; the daemon's hello reply is typed by it. | 03fc9641 | messages.test → pass |
| C11 (protocol) | `packages/protocol/src/handover-events.ts`: `SafeAction`, `CharacterResult`, `Outcome`, `Standing`, `Verdict`, `EntityData`, `Names`, `HandoverEvent` (cli's shapes; `handover.status` data is `Verdict & { helper? }`), with a `satisfies` contract test. | 70e2a357 | new type test |
| L40 | `excludedPath(relative, excluded, dir?)` in inventory.ts, used by divergence, git-graph and the root fold. | f2b3e0ec | refactor |
| L41 | `describeDivergence(at, d)` in divergence.ts, used by the blocker and `landedProblem`. | 812653cf | refactor |
| L44 | `Character = TerminalSlot.extend(…)`; `Second` gone. | 58985d93 | refactor |
| L46 | `source`/`destination` required in `HandoverDeps`; `notReady` fallback and `complete: 'journal'` gone. Tests that run no phase use new `idleSides(paths, {store, config})` in test/helpers.ts; two fallback-only service tests deleted, others now assert what the real phase does. | ac2bdab7 | — |
| L47, L52 | `STATE_SCHEMA_VERSION` in protocol (FleetState, emptyState, migrate, source, system.info); startup mode `receiving-destination`; guard.ts comment. | 3fc15e16 | — |
| L50 | `reservedProfileHomes(homedir)` in profile.ts; setup (Mac and Linux, via `setupUser`) prints one line per such home with the `mv … .archipelago-<name>-fleet` and `archi -p <name>-fleet setup`. | c1150cd3 | profile.test, setup.test → pass |

## Decisions

- **C22 vs the spec.** Ending the watch at Complete would, on its own, let a Claude that exits at its trust prompt after
  Complete become a plain shell, against "characters that fail to resume remain dormant with their transcript". F3's
  fleet-level resume record covers that case after the watch ends, so the existing test "leaves a Claude that exits at
  its trust prompt after Complete dormant again…" still passes (now through the fleet, generic error text).
- **C01 scope.** `createCharacter` is not waited for: its window opens at admission, but its record lands after
  `newWindow` resolves, so a freeze landing in that gap could snapshot without it and lay it dormant with its window live.
  Not in the brief; left.
- **C33.** Chose "seal as the transfer left it" (scan now, under the claim's excludes) over "revert": reverting to a
  previous record would still fail the next proof after rsync wrote. A user edit made in the replica during the transfer
  window would be sealed with it.
- **C24.** Refusal lives in `runUninstall(force)`; the CLI flag is B's.
- **L50.** The old launchd agent of a renamed profile stays until uninstall; the line says only the move and setup.

## Exports for B

- `@archipelago/archid/gateway/client`: `versionMachineId(stdout)`, `ownerAnswer(stdout)`, `type OwnerAnswer` (use in `identify` / `remoteOwner`; refuse `undefined` id).
- `@archipelago/archid/text` (new package export): `shq` — replace `shellQuote`.
- `@archipelago/archid/config`: `patchFleetConfig(file, patch)` (`{ gatewayMachineId: undefined }` drops it), `readFleetConfig(paths)`.
- `@archipelago/protocol`: `SafeAction`, `CharacterResult`, `Outcome`, `Standing`, `Verdict`, `EntityData`, `Names`, `HandoverEvent`, `STATE_SCHEMA_VERSION`.
- `@archipelago/archid/linux/setup`: `agentHomesEnv(run)`, `unitEnv(key, value)` (Linux daemon-env check in doctor).
- `@archipelago/archid/profile`: `reservedProfileHomes(homedir)`; `@archipelago/archid/uninstall`: `runUninstall({ …, force })`, `stranded(homes, prefix)`.

## What B must pick up (fallout of this wave)

1. **I7:** `cli/test/doctor.test.ts` fixtures report `claude 2.1.0`, now under the floor: 6 tests fail. Raise them to ≥ 2.1.251, and print the whole floor (`doctor.ts:109`, `controller/host.ts:233` print `x.y`, so "needs 2.1 or newer" misstates 2.1.251).
2. **C27:** `cli/test/controller/recovery.test.ts:30-31` still types `Result<'handover.status'>['characters']` and builds `{ characters: [], roots: [] }` — the one `pnpm typecheck` error. `test/controller/world.ts` fakes return the same keys (untyped, stale).
3. **C24:** add `archi uninstall --force` (pass `force`), and have `host remove` run the far `archi uninstall --force` after its own checks; without it, removing any gateway that holds fleet records is refused.
4. **C23:** extend doctor's daemon-env check to Linux with `agentHomesEnv` + `unitEnv` against the unit text.
5. `commands/version.ts` can use `STATE_SCHEMA_VERSION`.

For C2 (docs): `errors.md`'s `agent_unsettled` row now also covers an idle agent with background commands; the failpoint count is 94 (`source.complete.deactivate`, `destination.claim.seal` added).

## Verification

- `pnpm typecheck`: one error, `cli/test/controller/recovery.test.ts:30` (item 2 above); web tsconfig clean.
- `pnpm vitest run --project protocol --project archid --project cli --project scripts`: 3737 passed, 6 failed (cli doctor.test, item 1), 8 skipped. protocol + archid alone: all pass.
- `pnpm test:faults`: 1310 passed, seed `1790654918958`.

## Concerns

- The cli suite and typecheck are red until B lands items 1–2.
- F3's "ran" is read from `pane_current_command` each poll; a resume that fails within one poll counts as never having come up and waits the 60 s before it is laid dormant.
- `agentHomesEnv` runs an interactive login shell (`-lic`); an rc file that blocks waits out `realRun`'s 30 s before setup goes on without the values.

## Follow-up: createCharacter

Commit `7b9830a2`. What changed:

- `createCharacter` opens the window, records the character and types its start command in `openCharacter`. That promise is
  kept in `Fleet.creating` until it settles, and `settle()` now waits on `background`, `creating`, `reviving` and
  `openingSecond`.
- Just before the window opens it calls `assertOwner('terminal')`, so a create asked of a frozen fleet opens nothing. There
  is no await between the API guard and `newWindow`, so a create admitted before the freeze always opens its window before
  settle can return.
- A create that opened its window before the freeze ends once it is recorded: no link refresh starts, and a `run` prompt is
  never typed (`runSent: false`), including after an agent that reports in once the fleet is frozen.

Every window-opening path in archid was checked: `createCharacter`, `doRevive` and `doOpenSecond` (C01) are the only
`newWindow` calls. `terminals.ts` `attachSession` links an existing window into a viewer session, which the rest detaches.
`ensureServer` only makes `_keep`.

RED → GREEN, both in fleet.test:
- "settles only once a character created before a freeze holds its window…": settle had returned while `newWindow` was held
  (`expected true to be false`).
- "types no prompt into a character created before a freeze…": `runSent` was `true`.

Verification:
- protocol + archid: 2205 passed, 2 skipped.
- `pnpm test:faults`: 1310 passed with seed `1790655593251`. The run before it, seed `1790655362341`, failed once in cli
  `faults.test.ts` "are each struck, from every line that sends one". That test scans `packages/cli/src`, which Fixer B was
  editing at the time, and it passes alone and in the rerun.
