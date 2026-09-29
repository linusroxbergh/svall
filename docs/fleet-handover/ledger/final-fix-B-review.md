# Final fix wave — Fixer B scoped re-review

Scope: `final-fix-B.diff` (b7d94143..2c1e8cc3) and `final-fix-B-early.diff` (48d0e51c..b7d94143). Fixer A's 7b9830a2 out
of scope. Mutations ran in a `git archive 2c1e8cc3` copy; "caught" means the named test went red with the fix removed.

## Verdicts

| Item | Verdict | Evidence |
| --- | --- | --- |
| C03 | ADDRESSED | `adopt()` stops (safe `[]`, names both parties) before any gateway, daemon or rsync call in `resume()` and `abort()`, including `finish`, `finish-abort` and `undo`; `from`/`to` are always set when an action proceeds (`found()` types them). `transfer()` refuses unless exactly one side has a master. Helper resume/abort, the sheet's buttons and `attach` all reach these two methods; `--forget` needs a local journal. Both mutations caught (handover.test "resumed or aborted from a machine that is neither…", "never runs a transfer whose parties are both reached over ssh…"). |
| C02 | ADDRESSED | `askGateway` uses `localOwner` when `gateway.id === registry.localId`; mutation caught (connection.test "asks the authority on its own socket…"). |
| C06 | ADDRESSED | `farProfile(target())` feeds connect, routed commands, handover and fleet recover; mutation caught (cli.test, target.test). |
| C07 | ADDRESSED | enable, remove and recover all use `patchFleetConfig`; three mutations (rename-write of parsed config) caught. |
| C08 + L11 | ADDRESSED | `transient()` defers to `retryable()` for SshError; `start()` maps `version` to `incompatible_protocol`; both mutations caught. |
| L13 | ADDRESSED | `MachineMismatch` in `remoteConnectionInfo`; mutation caught. |
| C09 | ADDRESSED | Refusal is right: a registered old gateway may still hold the fleet. The named recovery is correct: `fleet recover --force-owner local --gateway <new>` accepts an unreachable current gateway and a record-free replacement, patches fleet.json, and the rerun `host enable` passes the check and `seedAuthority` accepts the existing record naming this Mac. Same-name flow still enables. Mutation caught. handover.md's studio2 flow at HEAD runs enable before recover and is refused; C2's working-tree edit already reorders it. |
| C10 | ADDRESSED | load warning and `setAside()` in every lookup error; two mutations caught. |
| C11 (cli, web import) | ADDRESSED | types from `@archipelago/protocol`. |
| C16 (cli) | ADDRESSED | mutation caught (two host.test cases). |
| C18 (cli) | ADDRESSED | `stageArchive` used as briefed (GNU tar test not rerun). |
| C20 (cli) | ADDRESSED | `versionMachineId`, `ownerAnswer`. |
| C25 | ADDRESSED | none of the seven exported. |
| C32 | ADDRESSED | `currentRunFrom()` for bare setup and `--check`; mutation caught. |
| L07, L10, L16, L17, L20, L34, 39b F1, L21 | ADDRESSED | each mutation caught (L21 only when both divisors revert). |
| I3 | ADDRESSED | schema compared on first identify per master; mutation caught. |
| I5 | ADDRESSED | authority and tmux probe; both mutations caught. |
| I9 | ADDRESSED | far `setup --rollback` probes each unit's daemon; `rollbackHost` probes; both mutations caught. |
| A's pickups (I7, C27, C24, C23, exports) | ADDRESSED | I7, C23, C24 (both halves) mutations caught. |
| L01, L04, L05, L06, L08, L09, L12, L14, L15, L19 | ADDRESSED | read; L14 has tests. |

## New breakage

- **Important — `host remove` can strand a fleet another controller keeps on that machine.** `removeHost` now runs
  the far `archi uninstall --force` (host.ts:649). `--force` makes `runUninstall` skip every `stranded()` check
  (uninstall.ts:156): open handover journals, fleets the machine runs for a gateway, and gateway records. What
  `gatewayFleets` checks first is only this Mac's own fleet homes and caches (host.ts:600-633), so a second Mac's fleet
  whose gateway is that machine, or which runs there, loses its gateway unit and daemons with no refusal. The spec text
  in C2's edit ("checks all of this from the controller") overstates it. Suggested: pass the fleet ids the controller
  checked (e.g. `archi uninstall --release-fleet <id>…`) and have `stranded()` exempt only those, so anything else still
  refuses. The brief asked for the plain `--force`.
- Minor — `transfer()`'s one-remote-party check runs after `claim()`, which may already have archived destination
  roots; unreachable while `adopt()` and preflight hold, but the guard belongs before the claim.
- Minor — a side build is now retried like a daemon call, so plain Errors (machine not in the registry, a far daemon
  that names no fleetHome) are retried four times (~7 s, with `handover.retry` lines); the `to === from` name lookup
  dials that machine's daemon, so an unreachable daemon turns the identity_mismatch into a connection error.
- Minor — ssh.ts keeps `shellQuote`'s JSDoc with nothing under it (line 51).
- Minor — `archi handover local` no longer sets `view.about.source`, so its abort line says "the machine it ran on"
  instead of naming it.

Counts: Critical 0, Important 1, Minor 4.

## Verification

In the 2c1e8cc3 copy: `pnpm typecheck` clean; `vitest --project cli --project protocol --project @archipelago/desktop-web`
2366 passed, 18 skipped, 1 failed (cli.test "prints the commit it runs from for --version", which needs a `.git` the
archive copy lacks). 30 fix-removal mutations: all caught.
