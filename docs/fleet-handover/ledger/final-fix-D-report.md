# Final review — targeted fix D report

Status: DONE_WITH_CONCERNS. Commits on `experimental-remote-sessions` after `be7f7446`, not pushed.

| Item | Commit | What changed |
| --- | --- | --- |
| D1 | `b821e1e3` | archid `runUninstall({ forceFleets })` and `stranded(homes, prefix, released)`: the gateway records of the named fleets no longer count; every other record, an open journal and a fleet run for its gateway still refuse. A strand refusal is `UninstallRefused`. cli `archi uninstall --force-fleet <id...>` passes the ids; an `UninstallRefused` prints `archi: <reason>` and exits `REFUSED` (3), as `fleet provision` does. `host remove` runs `archi uninstall` with `--force-fleet <id>` for each fleet the `fleet` step found naming the machine (none: plain `archi uninstall`). Exit 3 fails the `uninstall` step with `<name> refuses: <far reason>` and an action; other exits keep the "could not be reached … --forget" path. `REFUSED`'s doc names both commands. |
| D2 | `53eecd70` | Setup's reserved-name line ends `…, then archi <name>-fleet` (the root action opens the profile and writes its agent when the plist is missing, as setup's own refusal says). |
| D3 | `55991e11` | The three `probe-*-handover.mjs` headers: manual is running the probe by hand on a real Claude session, Codex rollout or copied checkouts; the archid suite runs each through its `*-portability.test.ts`. `probe-claude-hook.mjs` keeps its header: no test runs it. |

## RED / GREEN

- D1 archid, uninstall.test "lets go only of the gateway records of the fleets it is told to…": RED `expected … /this machine is the gateway of 1 fleet/ but got 'uninstalling here would strand fleets…'` (both records counted) → pass. Mutation (plain `Error` for the refusal): `expected error to be instance of UninstallRefused`.
- D1 cli, uninstall.test "passes only the fleets named to force past, and exits with its own code on a refusal…": RED `process.exit unexpectedly called with "1"` (unknown option `--force-fleet`) → pass.
- D1 cli, host.test: "uninstalls on the machine before the route is dropped, forcing past no refusal…" RED argv ended `'--force'`; "forces the far uninstall past the gateway records of only the fleets it checked…" RED argv lacked `--force-fleet <FLEET>`; "reports the far refusal, with its reason, of what this Mac cannot see…" RED detail `trift.test could not be reached: …` → all pass.
- D2 archid, setup.test "says how to move a fleet whose profile name archi now keeps…": RED `expected […] to include '…then archi host-fleet'` → pass.
- D3: comment only; portability tests 18/18.

## Docs

- spec.md (Add Machine, host commands paragraph): `--force` vs `--force-fleet`; `host remove` forces only its fleets naming the machine; the far refusal is reported.
- setup.md: `host remove` table row; Linux bullet, with the two-Mac flow (`--forget` on the other Mac, `archi uninstall --force` on the machine, `--forget` here).
- errors.md: `uninstall` step row (what still refuses, the refusal's action). No new code: the refusal is a `fail` of the existing step; error catalogue 15/15.
- security doc: `archi host remove` and `archi uninstall` destructive rows (new tests cited), keep/delete table header, the accepted risk rewritten (the far takes the Mac's cached word for its own fleets; a gateway two Macs use needs `archi uninstall --force` by hand).

## Decisions

- `--force-fleet` passes only the named fleets' gateway records, not a journal or a "runs for its gateway" in a far home of the same fleet: the controller cannot see those, and a clean far copy has neither.
- Only fleets naming the machine are passed, not every fleet here: one whose config names another gateway may be stale about it. So a record left by a fleet that has since moved gateway refuses; the action covers it.

## Verification

- `pnpm typecheck`: clean.
- `pnpm vitest run --project protocol --project archid --project cli --project scripts`: 136 files passed (1 skipped), 3783 tests passed, 8 skipped. A first run had 1 failure, cli transfer.test "keeps a dropped link's partial copy, and a resume on a new master finishes it"; it passed alone 3/3 and in the full rerun.

## Concerns

- Two Macs sharing a gateway: neither `host remove` completes, since each Mac's record refuses the other; the last step is `archi uninstall --force` by hand (documented).
- A far `archi` older than this commit rejects `--force-fleet` (exit 1), which reads as "could not be reached"; `host upgrade` first.
- The far's refusal text carries its own advice, so the step's detail and action overlap.
- D2's `archi <name>-fleet` is the Mac's command; `launch` is Mac-only, and reserved-name homes cannot arise on Linux, where every fleet home comes from this branch.
