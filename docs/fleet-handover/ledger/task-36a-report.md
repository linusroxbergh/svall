# Task 36a report — daemon and gateway fault injection

Commits `46978368..0d7722d4` on `experimental-remote-sessions` (not pushed):

1. `07408393` Every durable step of a handover runs between two named failpoints a test can crash at
2. `499093fe` A fault suite crashes the controller, both daemons and the gateway at every failpoint and settles the fleet on one machine
3. `1c79bc1d` A terminal whose window a crashed rest closed is carried and revived like the others the handover stopped
4. `0d7722d4` The source removes a handover's manifest before it closes the journal that names it, so no crash leaves it behind

## Failpoints (`packages/archid/src/handover/failpoints.ts`)

`FAILPOINTS` maps each name to its side. A step runs inside `boundary(name, step)`, which calls the armed hook
`before` it and `after` it (after a returned promise fulfils). Unarmed, `boundary` just runs the step: no hook, no
extra tick. `armFailpoints(hook)` is the only way to arm them, and it throws in a release (`isRelease()`, i.e.
`ARCHI_RELEASE_ROOT` set). No config, env var or RPC reaches it. Every name has both edges, so 46 steps give 92
failpoints.

| Side | Phase | Steps (each with before/after) |
| --- | --- | --- |
| source | Freeze | `source.freeze.journal` (journal write), `source.freeze.surrender` (owner.json), `source.rest.terminated` (journal), `source.rest.terminate` (SIGTERM to a job), `source.rest.stopped` (journal), `source.rest.kill` (each window), `source.freeze.manifest`, `source.freeze.digest` (journal) |
| source | start | `source.startup.surrender` (owner.json, a journaled source that had not surrendered) |
| source | Abort | `source.abort.journal`, `source.revive` (each terminal), `source.release.journal` (close), `source.release.unfreeze` (owner.json), `source.release.activate` |
| source | Complete | `source.complete.seal`, `source.complete.install` (owner.json), `source.complete.journal` (close) |
| destination | Transfer | `destination.claim.root` (each root's replica record) |
| destination | Verify | `destination.verify.journal`, `destination.verify.landed` (the landed check), `destination.verify.record` (journal) |
| destination | Prepare | `destination.prepare.seal`, `destination.prepare.state` (prepared state), `destination.prepare.journal` |
| destination | Activate | `destination.activate.install` (owner.json), `destination.commit.journal`, `destination.promote.fleet`, `destination.promote.state`, `destination.activate.journal`, `destination.activate.fleet`, `destination.activate.open` (each terminal), `destination.activate.record` (each journal row) |
| destination | Complete / Abort | `destination.complete.seal`, `destination.complete.journal`, `destination.abort.seal`, `destination.abort.journal` |
| gateway | every write | `gateway.begin.write`, `gateway.ready.write`, `gateway.commit.write`, `gateway.abort.write`, `gateway.complete.write` |
| gateway | Commit | `gateway.commit.respond` (the Commit answer on the socket) |
| controller | all | `controller.journal` (every write and the clear of `handover.json`), `controller.rsync` (each root and session entry), `controller.verify` (each checksum compare), `controller.commit` (the Commit request and its answer) |

I placed the controller's failpoints here too, because item 1 names every side. The suite below crashes the controller
at each of them, so the registry is fully covered in this half. 36b's cli suite can add lost, dropped and partition
faults at the same names.

`owner.create`, `owner.force` and `adopt`'s install, supersede and deactivate have no failpoints. They belong to setup
and force-owner recovery, not to a handover.

## How exhaustiveness is enforced

- **Compile time.** `REACH` in the suite is a `Record<Failpoint, …>` giving the scenario that reaches each step and how
  many times it runs there. A new name in `FAILPOINTS` without an entry fails typecheck. I checked this by adding
  `controller.extra`: TS2741.
- **Run time, coverage.** The cases are every name × both edges × {first run, last run}. Each case asserts its failpoint
  was actually struck. Two probe runs assert that every step runs exactly `REACH.times` times, so a new call site of an
  existing name fails the probe. A registry test asserts every name appears as a literal in `packages/archid/src` or
  `packages/cli/src`.
- **Run time, a new boundary without a failpoint.** This is how an unlisted step gets caught. The suite spies on
  `fs.renameSync`, `fs.linkSync` and `fs.rmSync`. Any rename, link or removal of a handover's durable files outside an
  open boundary of the party writing it is a violation. Those files are `owner.json`, `journal.json`, prepared, seal
  and manifest files, replica records, the destination's `fleet.json`, the `state.json` promotion, the gateway record
  and the controller's `handover.json`. A tmux window kill or open, or a job signal, outside a boundary is also a
  violation. The writer is identified by `AsyncLocalStorage` per daemon or controller process. Every case trips on the
  first such step it reaches. Two mutations prove it:
  - dropping the boundary around the `fleet.json` promotion gives `rename of trift/fleet.json by the destination ran
    outside every failpoint`;
  - dropping it around the rest's window kill gives `mac kill @1 by the source ran outside every failpoint`.

## The world (`packages/archid/test/handover/faults.test.ts`)

All parties run in one process over real durable files in a temp dir:

- the real controller (`Handover`, `fileStore`, the real `transfer()` with an injected rsync runner);
- both daemons (`HandoverService` with the real `SourceHandover` and `DestinationHandover`, reached through
  `api/methods` `dispatch` so the ownership guard runs);
- the real gateway (`startAuthorityServer` on its Unix socket).

Faked are tmux, processes and the fleet facade. They are per machine and outlive daemon restarts. The daemons get an
injected virtual clock. Both machines share one home path, as version 1 requires.

- **The fleet.** Three characters: `c_ada` with a second terminal, `c_bo` running `npm run dev` (terminated through
  `terminateShells`), and `c_cy` dormant before the freeze.
- **A crash.** The failpoint throws and marks that party's life dead. After that, every journal, store, tmux, fleet,
  gateway and controller-store call the dead life makes throws, as do its later failpoint hits. A dead gateway's
  sockets are destroyed at once, so its answer never leaves.
- **A restart.** The daemon is booted from disk as `main.ts` does: `OwnershipState.load`, `Store.load`, a new
  `HandoverService`, `startupMode` / `enterStartupMode` / `adoptAtStart`, then `activate` only if writable. It becomes
  reachable only after that. The gateway restarts on the same prefix; the controller is a new `Handover` over the same
  journal.
- **The legal action.** Each recovery step is a new controller that runs `status()` (`assess`). It takes `abort` or
  `resume` as `verdict.safe` allows, preferring the variant's choice, until status says nothing is open.
- **The invariant.** Checked at every failpoint hit, every daemon answer, every gateway call, every window kill or open
  and every boot:
  - at most one machine passes `guardMethod` for `term.attach`, `char.create` and `term.input`;
  - before the gateway's record names the destination, only the source may, and the destination holds no window and
    starts neither its fleet nor a terminal;
  - after it, the source may not, and never opens a terminal or starts its fleet;
  - both machines never hold windows at once;
  - status never offers `abort` after the commit.
- **Settled.** The record is `{g, source}` or `{g+1, destination}` with no transaction, and no journal or handover file
  is left on either machine. The owner runs exactly `c_ada`, `c_ada-2` and `c_bo`; `c_cy` stays dormant. The other
  machine holds no window and cannot run terminals, and the controller journal is gone. A living daemon logged no
  error. If the gateway ever committed, the fleet settled on the destination.

## Scenario matrix and results

| Suite | Cases | Result |
| --- | --- | --- |
| Registry: unarmed, both edges, throw stops the step, refused in a release, every name placed | 5 | pass |
| Probe runs: move and cancel-after-prepare abort, counts match `REACH` | 2 | pass |
| Coverage: both edges of every name are struck | 1 | pass |
| Crash matrix: 108 cases × 2 variants (resume after restarting what died; abort after restarting every party) | 216 | pass (12 failed before the fixes) |
| Gateway lost before Begin, during Freeze, after Ready, after Commit, during Complete × resume/abort | 10 | pass |
| Stale `owner.json` beside a surrendered journal (item 5) | 4 | pass |

Gateway loss:

| Lost | Who may run it while lost | Status meanwhile | Then resume | Then abort |
| --- | --- | --- | --- | --- |
| before Begin | source | nothing open | source | source |
| during Freeze | nobody | nothing safe | destination | source |
| after Ready | nobody | nothing safe | destination | source |
| after Commit | nobody | nothing safe | destination | destination |
| during Complete | destination | nothing safe | destination | destination |

While the gateway is lost, both daemons are restarted from disk. A resume and an abort are then tried and change no
`owner.json`.

Item 5:

- The source's `owner.json` is rolled back to its pre-freeze `{g, source}` while the destination runs the fleet
  (activated and completed, the source dead before Complete). The source still starts fenced, with the gateway away and
  with it answering, and again after a second restart. It surrenders durably and settles as a replica.
- A source that died between its journal and its surrender (unfrozen `owner.json`) starts fenced and surrendered, with
  the gateway away or answering.

## Defects found and fixed

1. **A terminal whose window a crashed rest closed was lost** (`source.rest.kill:after#1` and `#3`, both variants).
   The rest kills a window, then marks its slot dormant and `restedBy` this handover. A crash in between left the slot
   naming a window that no longer exists.
   - On resume, the re-freeze laid it dormant without `restedBy`, so the destination never started it.
   - On abort, `revive` saw the stale window id and skipped it (the real `Fleet.doRevive` returns early when `c.tmux` is
     set), so the source never reopened it.

   Fix (`1c79bc1d`), two parts, each shown load-bearing by reverting it alone:
   - `rest.ts`: the rest's already-gone pass marks a slot `restedBy` when the journal's `stoppedTerminals` lists it;
   - `source.ts`: `revive` lays dormant any stopped terminal whose recorded window is not live before reopening it.
2. **A leaked manifest** (`source.release.unfreeze:after`, `source.release.activate:before/after`,
   `source.complete.journal:after`). The source closed its journal before removing `manifest-<tx>.json`. A crash in
   between left a full fleet snapshot on disk that nothing would ever remove: the repeated call returns early once the
   journal is closed and the owner unfrozen.

   Fix (`0d7722d4`): abort and complete remove the manifest while the journal still names it, as the destination
   already does with its files. A complete repeated after that removal finds no manifest and seals nothing again, and
   no longer logs an error for it. Reverting any of the three changes fails its cases; the quiet skip is caught by the
   no-error assertion at `source.complete.journal:before`.

No case produced two machines that could run terminals, a destination window before the commit, or a source that ran
after it.

## Seeds and verification

- `pnpm typecheck`: clean.
- `pnpm test packages/archid/test/handover/faults.test.ts`: 238 passed, about 147 s.
- The fault suite with `--sequence.shuffle`, seeds 36, 2026 and 7: 238 passed each time.
- `pnpm vitest run --project archid --project cli`: 2364 passed, 5 skipped. The first full run had one failure, cli
  `transfer.test.ts` "keeps a dropped link's partial copy…": the link cut arrived only after all 6 MiB had gone. That
  test passed three times alone and in the full rerun, so it is a load flake not yet in the README's list. The unarmed
  boundary around `Mirror.run` adds no tick.
- Other runs:
  - handover, gateway and controller suites after the placement commit: 837 passed, 4 skipped;
  - `source`, `rest`, `service`, `destination` and `ownership` after fix 1: 217 passed;
  - `source` and `service` after fix 2: 86 passed.

## Concerns

- **Reverse import.** The archid suite imports the controller (`Handover`, `assess`, `fileStore`, `gatewayOf`,
  `transfer`) from `packages/cli/src`, a test-only import against the package direction. This is so the legal action
  comes from `archi handover status`'s own logic. Production dependencies are unchanged.
- **One disk.** Both machines share one filesystem, so every root is already in place: the destination's claim takes the
  content-equal replica path, and rsync is a no-op runner. The reserve-and-create claim of an absent root and a real
  copy are not crashed at here. Task 37's two-machine run covers them.
- **Shell terminals only.** Agent resume waits, session placement and the SessionStart watch are not under crash. The
  `destination.activate.open` crashes cover starting a terminal, not an agent's wait.
- **Supersede.** The force-owner path (`SourceHandover.supersede`) still closes its journal before removing the
  manifest: the same ordering as defect 2, which no case reaches, so I left it.
- **Revive flags.** The revive fix marks a terminal from a crashed rest dormant without the launch flags the rest would
  have kept. An agent terminal killed in that window resumes without its extra flags.
- **Runtime.** At about 150 s, `faults.test.ts` is the longest archid file (238 tests, each with real fsyncs).
