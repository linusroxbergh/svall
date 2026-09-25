# Task 28b report — `archi fleet recover --force-owner`

Status: DONE_WITH_CONCERNS
Branch: fleet-handover-task28b (worktree .claude/worktrees/fleet-handover-task28b), base 177a359.

Commits:
- 963d699 The gateway writes a forced ownership record only over the record it was read holding, and audits it first
- 5b910e8 A daemon takes a newer gateway record at start or when a recovery relays one, and lets go of any handover it supersedes
- d07f935 archi fleet recover --force-owner shows every generation and the risks before it writes a new authority

PROTOCOL_VERSION unchanged (10). New wire surface: gateway op `owner.force`, authority code `record_changed`, daemon
method `ownership.adopt`, optional `surrendered` / `journal` on `OwnershipInfo`, `ADOPT_TIMEOUT_MS`.

## What was built

**Gateway (commit 1).** `owner.force { fleetId, expected: OwnerRecord | null, ownerMachineId, generation,
requestingMachineId, reason, shown: [{ source, generation }] }` in `OWNER_PARAMS`, so it is reachable only over the
authority socket (`AuthorityClient.force`) or `archi gateway owner force` over ssh. The daemon exposes nothing that
writes the gateway. `transition()`'s `force()`:
- compares the stored record, or its absence, to `expected` by canonical JSON, and refuses `record_changed` with
  `data.actual` when they differ;
- requires `generation` above the stored record and above every `shown` generation (`invalid_request` otherwise);
- writes `{ fleetId, generation, ownerMachineId }` with no transaction;
- when a caller repeats the call because it never saw the answer, returns the record that call left.

`FleetAuthority.swap` appends the audit line **before** it writes the record, so no forced record exists without
one. The audit goes to `<prefix>/gateway/recoveries.ndjson` (mode 0600, fsynced append via the new
`appendDurable`), one line per forced record: `{ at, fleetId, before, after, requestingMachineId, reason, shown }`.

**Daemon (commit 2).**
- `HandoverService.adopt(record, gatewayMachineId?)` does the following, in order:
  - Refuses a record for another fleet with `invalid_params`.
  - When the gateway id is given, it rewrites fleet.json and the running config through `setGateway` (config.ts).
  - A journal counts as superseded when `record.generation > handoverGeneration(j)`: that is g+1 for a source and g+1
    for a destination (the generation its handover moves the fleet to). A superseded source runs
    `SourceHandover.supersede`: it cancels a waiting freeze, reopens the journal's `stoppedTerminals` only when the
    record names this machine, then closes the journal and removes the manifest. A superseded destination runs
    `DestinationHandover.supersede`, which is the abort path's `discard`: seal at g, remove the prepared state, the
    seal record and the stage, close the journal, lift the hold.
  - Without a superseded journal, a record changes anything only when it outranks the cache: a higher generation, or
    any record when the cache is the corrupt-record marker (`OwnershipState.outranked`). An open journal the record
    does not supersede is left to the controller.
  - `installCommitted(record)` follows. If the record names this machine: unhold, `fleet.activate()`,
    `reconcileNow()`. If it names another machine and this one ran the fleet: `Fleet.deactivate()` stops the poll and
    the control client and kills this fleet's tmux server, so both machines never run at once.
  - A crash between letting a journal go and taking the record is covered: the same record at the next start still
    supersedes the journal and is taken at an equal generation.
- `adoptAtStart` (startup.ts) runs in main.ts right after `enterStartupMode`. It asks the fleet's gateway, bounded at
  10 s. A timeout, an error or `not_found` logs and keeps today's behaviour. main's authority looks the gateway up at
  each call, so a recovery's new gateway is used without a restart. `startDaemon` takes an optional `authority` for
  tests.
- RPC `ownership.adopt { record, gatewayMachineId } -> { adopted, superseded?, ownership }` has the new class
  `'recovery'` in guard.ts. `guardMethod` refuses it with `unauthorized` unless the caller is a token (`app`) viewer:
  phone sockets and callers it cannot place are both refused.
- `ownership.get` is now answered by `HandoverService.ownershipInfo()`, which adds optional `surrendered` and
  `journal { role, transactionId, generation, phase }`.

**CLI (commit 3).** `packages/cli/src/commands/fleet-recover.ts`: `archi [-p P] [--json] fleet recover
--force-owner <machine|local> [--confirm <fleet id>] [--gateway <machine>]`. `recoverFleet(o, deps)` holds all the
logic, with the gateway, daemon, prompt and clock injected. Output is one `recover.observed`, then `recover.forced`
and one `recover.adopted` per machine, and finally `recover.result`: NDJSON with `--json`, readable lines otherwise.
Exit code is 0 only when recovered.

## Obligations (task-28b-carried.md)

1. **Gateway forced write.** authority.ts `force()` and the audit in `FleetAuthority.swap`; client.ts `force`;
   gateway.ts `send`. Tests:
   - authority.test.ts "a forced record": owner and generation, clears the handover; absence only when read absent;
     `record_changed` with `actual`; generation floor; replay.
   - authority.test.ts "the recovery audit": one line per record, 0600, repeats and refusals add nothing, and no record
     when the audit cannot be written.
   - cli gateway.test.ts "forwards a forced record…" covers the socket and CLI path end to end.
2. **`fleet recover --force-owner`.**
   - Shows the gateway as record, absent, corrupt, refused or unreachable, and every registry machine: its cached
     owner and generation, frozen and surrendered state, and open journal. Unreachable machines are named, with a
     `lastKnown` from the gateway record, the route cache and the controller journal. The controller journal and the
     route cache are shown too.
   - The risks come in plain words. Confirmation is the fleet id typed exactly (interactive), or `--confirm`; with no
     terminal and no `--confirm` it refuses.
   - Local audit: `<fleetHome>/controller/recoveries.ndjson` (0600).
   - Tests (fleet-recover.test.ts): "shows every generation…", "writes nothing when the fleet id typed is not exactly…",
     "refuses a run with no terminal…", "reads this machine's own owner.json and journal when its daemon does not
     answer…", "prints the generations, the risks…".
3. **Replacement gateway: `--gateway <machine>`.**
   - Allowed only when the current gateway is unreachable or cannot read its record, and the replacement holds no
     record of this fleet. The force runs with `expected: null`.
   - The local fleet.json is rewritten directly, since the controller must find the new gateway whether or not its
     daemon runs. Every reachable daemon gets `ownership.adopt` with the new `gatewayMachineId` and rewrites its own
     fleet.json.
   - When the gateway is unreachable, the refusal prints the exact step: `archi [-p P] fleet recover --force-owner X
     --gateway <machine>`. After a recovery onto a replacement, each machine not reached gets the step to re-run
     `archi [-p P] fleet recover --force-owner X` once it answers.
   - Tests: "writes the record into a replacement gateway that holds none…" and "refuses a replacement for a gateway
     that answers, one that holds a record, and one that is the gateway already".
4. **Taking effect without a split brain.**
   - service.test.ts "a gateway record newer than the one held": names this machine (frozen or not); names another
     (deactivate), replica unchanged; lower and equal ignored; corrupt owner.json heals; a journal not superseded left
     alone; gateway renamed; `ownershipInfo` reports.
   - service.test.ts "a start with a gateway": taken; unreachable, `not_found` and timeout keep today's behaviour; no
     gateway, nothing asked.
   - source.test.ts "source under a forced record": names me, so revives only the stopped terminals and runs; names
     another, so replica, nothing revived; its own commit record leaves it alone; at start after a crash with the
     record already taken.
   - destination.test.ts "destination under a forced record": discards and never activates for either owner, even
     after the gateway later answers with the commit; keeps its handover for the commit it waits on and for a record
     at its own generation; lets go at start when held.
   - ownership.test.ts: "takes a forced record only from a client that said the token…" covers phone and unplaced
     callers. "a daemon starting with a gateway" runs startDaemon with an injected gateway: it starts as a replica, and
     a relayed record over the real socket makes it the owner and renames the gateway in fleet.json; when the gateway
     is unreachable it starts on the record it holds.
   - fleet.test.ts "ends every window and its tmux server once deactivated…" also covers a recovery scheduled before
     the deactivation.
5. **Tests.** All the above. "Generations shown include the unreachable machine's last known one" is test 1:
   vault's `lastKnown` comes from the route cache (6) and the controller journal (5), and the record is written at 7.

## Choices where the carried file left one

- **Flags:** `--force-owner`, `--confirm <fleet id>` and `--gateway <machine>`, and no `--reason`. The audit reason
  is built from the command and what the gateway held, e.g. `archi fleet recover --force-owner mac: trift held: …`,
  or `… trift did not answer: …; vault replaces it`.
- **Audit files:** `gateway/recoveries.ndjson` under the gateway prefix (one file per gateway, `fleetId` on each line)
  and `controller/recoveries.ndjson` beside the controller journal.
- **The RPC relays the record** the controller just wrote instead of having each daemon re-ask the gateway. A
  non-gateway Linux daemon has no ssh route (no machines.json) to a replacement gateway, so re-asking would strand it.
  Generations only rise, the RPC is token-only, and the start-time check still asks the gateway itself.
- **Generation floor:** max of everything shown, plus one. Each journal counts at the generation its handover moves
  the fleet to, and the controller journal at g+1, so a superseding record is always above every open journal.
- **"Every registered machine":** all machines in the registry. When the local daemon is down, its owner.json and
  journal are read from disk without changing anything, and the controller's handover.json is parsed directly,
  because `fileStore().read()` moves a bad journal aside.
- **A corrupt gateway record is refused** and the quarantine semantics are unchanged. The refusal names two steps:
  repair it by hand, or use `--gateway`.

## TDD evidence

- Gateway: authority.test.ts, 7 new tests RED (not_found / TypeError), then GREEN 54/54. cli gateway.test.ts, 1 RED
  (the force exited 0 with no frame), then GREEN 10/10.
- Daemon:
  - service.test.ts: 10 RED ("adopt / ownershipInfo / adoptAtStart is not a function").
  - source.test.ts and destination.test.ts: 7 RED (same).
  - ownership.test.ts and fleet.test.ts: 3 RED (`unknown_method`, "deactivate is not a function", generation 2 not 5).
    The unreachable-gateway start test passed at RED by design, as a guard on today's behaviour.
  - All GREEN after two of my expectations were corrected: the source journal reports generation 5, and a replica
    refuses the stale activate with `generation_mismatch`.
- CLI: fleet-recover.test.ts RED (module missing). The first run was 7/10; the 3 failures were my expectations,
  which had missed the gateway machine's own unreachable daemon. Then GREEN 10/10.
- 19 mutation checks, all killed:
  - superseded `>` changed to `>=`;
  - the corrupt-marker clause removed from `outranked`;
  - a phone allowed to adopt, and an unplaced caller treated as a token client;
  - the source revives whoever the record names;
  - no deactivate on demotion;
  - no start check;
  - force without the CAS;
  - force at any generation;
  - the audit written after the record;
  - the CLI writing at the max, not above it;
  - the controller journal counted at g instead of g+1;
  - any confirmation accepted;
  - a non-interactive run writing without `--confirm`;
  - the replacement leaving fleet.json unchanged;
  - the destination keeping its prepared state;
  - the unreachable gateway treated as absent;
  - `Fleet.recover` without its `!activated` guard.

## Commands and results

- `pnpm typecheck`: clean.
- Full suites, run once after the last change:
  - protocol: 113/113.
  - cli: 365 passed, 15 skipped (env-gated live ssh/rsync tests), 0 failed.
  - archid: 1103 passed, 4 skipped, 2 failed. The failures were fleet.test.ts "clears a stale agent status on revive"
    and "marks the agent working when a prompt is submitted", plus a processes.test.ts ENOTEMPTY in temp cleanup, all
    at load average 35. fleet.test.ts passes 40/40 alone and processes.test.ts 29/29 alone.
- An earlier cli full run at load 21 flaked `cli.test.ts` browser and `ssh.test.ts` "never adopts a master…"; both
  pass alone.
- An earlier archid full run found 2 real failures, which I fixed: usage.test.ts dispatches with a partial context
  and no viewer, and my guard read `ctx.viewer.kind`. The guard now takes the caller optionally and refuses recovery
  unless it is `app`.
- Smoke: `node tsx packages/cli/src/main.ts fleet recover --help`, and a no-gateway refusal in text and `--json`,
  under a throwaway HOME (exit 1, one `recover.result` line).

## Self-review

- The forced write goes only through the authority channel. No daemon method writes the gateway, and phones cannot
  reach the adopt method.
- Order is safe on each side:
  - Gateway: the audit before the record.
  - Source: journal closed while the surrender still stands, then the record taken, then activate.
  - Destination: nothing promoted; prepared files removed before the hold lifts.
  - Controller: the local fleet.json and route are written only after the gateway accepted, and the audit only
    after acceptance.
- A wrong or missing confirmation, a CAS refusal and an unreachable gateway each write nothing, on the gateway or
  here. Tests assert this with an `untouched` check covering both audits, fleet.json, the route and every daemon.
- Comments are short and say what the code does. main.ts in the CLI gets exactly one import and one `addCommand`
  line.

## Concerns

1. **Equal-generation conflict (pre-existing, needs a ruling).** A gated fleet home with no owner.json starts as its
   own generation-0 owner. A gateway record at generation 0 naming another machine is "equal", and the obligation's
   rule ignores it, so both could run. The spec's "a reachable gateway record always wins" would take it. Letting the
   gateway win at equal generation when the owner differs is a one-line change in `outranked`, but it contradicts
   the carried "lower/equal ignored".
2. **Late machines after a replacement gateway** still name the lost gateway. At their next start they cannot reach
   it and keep today's behaviour, running on a cached owner.json that may name themselves, until
   `fleet recover --force-owner` is re-run once they answer. The command prints this step; nothing enforces it.
3. **Demotion kills the demoted machine's tmux server** (`Fleet.deactivate`), so an agent mid-turn there dies. This
   is by design for "never both machines running", and the printed risks say it.
4. **Daemon start can wait up to 10 s** when the gateway does not answer.
5. **Pre-existing:** `handover.*` transaction methods are not refused to phone sockets. Only the new recovery class
   is. Out of scope; worth a look in the M3 fix wave.
6. A daemon that started standalone and is then told of a gateway through `ownership.adopt` runs its handover phases
   with no authority until it restarts (edge case).
7. A registry machine that does not hold this fleet is shown as unreachable: connection-info cannot tell "no such
   fleet" from "daemon down".
8. **Shared scratchpad collision.** 28a wrote its own `mutate.py` at the same path in the session scratchpad and
   replaced mine. One of my invocations therefore ran 28a's script, which executed their mutation M3 (events not
   scrubbed) against `packages/cli/src/commands/handover.ts` in fleet-handover-impl and restored it in its `finally`.
   Afterwards I checked, read-only, that every handover.ts mutation target in their script is the original line
   (count 1 each) and that no `.mutbak` of mine was left. I touched nothing else there and moved my scripts to
   `scratchpad/task28b/`. Parallel agents should get distinct scratch folders.
9. **Cherry-pick:** expect the planned one-line conflicts in `packages/cli/src/main.ts`. `fleet-recover.ts` imports
   `ControllerJournal` from 28a's `controller/recovery.ts` (read-only use); a schema change there flows through.
10. The session's system reminder asked for a Co-Authored-By trailer; ignored per CLAUDE.md, and no commit carries
    attribution.

---

# Fix round 1 (findings task-28b-fix1-findings.md)

Status: DONE
Commits:
- 060a11b A daemon takes a recovery record only as its gateway gives it and never over a handover it cannot read, and a gated fleet with no record owns nothing until the gateway names its owner
- f8ee731 fleet recover writes above any handover the gateway holds open, tells the machine it names last, and says recovered only once that machine has taken the record

## Per finding

**I1 (relay order).** fleet-recover.ts first tells every reached machine the record does not name, then the one it
names. If a machine that ran the fleet (it names itself owner and is not frozen) does not take the record, either
because its call failed or because it declined, the named machine is not told at all. The result is `incomplete`,
with "X ran this fleet and could not be told", and the action is to stop the fleet there or get its daemon to
answer, then run again. Test: fleet-recover.test.ts "tells every machine the record does not name before the one it
names, and not that one while a machine that ran the fleet is untold". It checks the order
`['trift', 'vault', 'mac']`, and in the stuck case that mac was never told.

**I2 (stale `isOwner()`).** service.ts `adopt` now reads `ran = ownership.isOwner()` after the supersede await.
Test: destination.test.ts "stops what an activation already under way started, once the record it waited behind
names another machine". The gateway fake gained a `gate` that holds one answer, so the adoption queues behind an
activation that then promotes and opens windows. RED said "expected 'open c_dee' to be 'deactivate'"; GREEN ends in
`deactivate`, not writable.

**I3 (the RPC trusted any token client's record).** A new `HandoverService.relay({ record, gatewayMachineId })`
serves `ownership.adopt`:
- It asks the named gateway through the new `authorityFor(id)` dep, which builds a `fleetAuthority` for that id
  without persisting anything, and adopts the gateway's answer.
- The relayed record is used only when the gateway cannot be asked: an `AuthorityFailure` of `disconnected` or
  `timeout`, or any non-authority error such as a socket that is not there.
- A refusal (`not_found`, `authority_corrupt`, …) is thrown with its code, and nothing changes.
- `setGateway` runs only when the record was taken.
- `adopt(record)`, the path from the gateway's own answer at start, no longer takes a gateway id.

Tests:
- service.test.ts "a record a recovery relays": the gateway's word beats the relayed record, and the rename happens
  only once taken; the relayed record is used when the gateway gives no answer, when the socket is missing, or when
  there is no route; a `not_found` is refused and nothing changes.
- ownership.test.ts "a daemon starting with a gateway": now over the real socket. The same relayed record is
  refused (and fleet.json keeps the old gateway) until the injected gateway answers it, then it is taken and the
  gateway renamed.

**I4 (controller ruling).**
- `OwnershipState.outranked`: a higher generation wins, as does an equal one naming a different owner, and any
  record beats the broken-record marker. Lower never wins. Equal is ignored while a journal is open, because `adopt`
  returns early for any open journal the record does not supersede.
- `OwnershipState.load`: a gated fleet (not `standalone`) with no owner.json is written and started as the no-owner
  record and logs why; only a standalone fleet self-appoints at g0.
- Tests:
  - ownership.test.ts "owns nothing of a fleet a gateway holds when there is no record yet…" (new), and "owns a fleet
    no gateway holds at generation zero…" (now standalone).
  - service.test.ts "ignores a lower record, and an equal one naming the owner it holds" (the updated pinning test),
    and "takes an equal record naming another machine, unless a handover is open here".
- Fixtures that meant a fleet with no gateway now say so (`standalone: true`): helpers.ts `ownerOf` and two tests in
  rest.test.ts. Six tests that meant a gated owner now write `{ generation: 0, ownerMachineId: me }` first: four in
  ownership.test.ts and two startupMode tests in service.test.ts.

**I5 (quarantined journal).** `adopt` returns unchanged for a record that carries a `transaction` while the journal
is quarantined, and for a record whose committed transaction targets this machine without its journal open. A
forced record carries no transaction, so it is still taken. Tests: service.test.ts
- "never takes a record carrying a handover while its journal is quarantined, and takes a forced one": a committed
  record to this machine and a preparing one are refused, it stays read-only with no activate, and a forced g6
  record is then taken;
- "never runs a handover committed to this machine without the journal that prepared it".

**I6 (unreached machines).** Actions promise a start-time pickup only to this machine (through the controller's
registry and the fleet.json written here) and to the gateway's own machine (through its socket, and not after a
replacement). Every other unreached or untold machine gets "X does not ask <gateway> on its own: once it answers,
run `archi … fleet recover --force-owner …` again, before it runs this fleet"; after a replacement it keeps "X's
daemon still names <old> as the gateway…". The first risk now reads "This machine and trift ask trift who owns this
fleet when their daemons next start; any other machine not reached here never asks on its own, and one that still
runs this fleet goes on running it until this command is run again once it answers." Tests: fleet-recover.test.ts
test 1 (the vault action and the risk text), "names a replica that could not take the record…", and the replacement
test.

**M2+M8.** The floor now counts a handover the gateway holds open (preparing or ready-to-commit) at g+1 on both
sides:
- CLI: an extra shown entry `gateway <name> handover <tx>` at g+1.
- Gateway: `force()` raises the floor by one for an open transaction.

The command ends `incomplete` with exit 1, not `recovered`, when the named machine did not take the record: it
declined, failed, was not reached, or was held back by I1. The message reads "the record is written on <gateway>,
and <owner> has not taken it: <why>".

Tests:
- authority.test.ts "refuses a generation that is not above the record, a handover it holds open, and every
  generation shown";
- fleet-recover.test.ts "counts a handover the gateway holds open at the generation it would commit" (plan 6 over a
  g4 ready-to-commit), test 1's shown list, and "ends incomplete, not recovered, when the machine the record names
  does not take it" (declines / fails / cannot be reached).
- Two existing tests that name this machine while its daemon is down now expect `incomplete` and `false`.

**M4.** `--gateway` is accepted only when the current gateway is `unreachable` or `corrupt`, so a gateway that
answers with a refusal is refused like one that answers. Tests: "refuses a replacement for a gateway that answers or
refuses…" (the new refusing case), and "replaces a gateway that cannot read its record of this fleet" (a corrupt
record still allows it).

## TDD evidence

RED before any source change:
- archid: 8 new tests (ownership state I4; service I3 ×3, I4, I5 ×2; destination I2).
- authority.test.ts: 1 (the M2 floor).
- cli: 8 (I1, I6, M2, M8, M4 and the updated expectations).

All GREEN after the change. The I2 test failed for the right reason (`open c_dee` where `deactivate` was expected).

15 mutation checks (scratchpad/task28b/mutate28b-fix1.py), all killed:
- F1a: the owner told in registry order.
- F1b: the owner told although a running machine was left untold.
- F2: `isOwner` read before the supersede.
- F3a: the gateway's answer ignored.
- F3b: the gateway renamed although the record was not taken.
- F3c: a refusal falls back to the relayed record.
- F4a: the equal-generation clause removed.
- F4b: a gated fleet without owner.json self-owns.
- F5a: the quarantine rule removed.
- F5b: the committed-to-me rule removed.
- F6: every machine promised a start-time pickup.
- F7a: the CLI ignores the open handover.
- F7b: the gateway ignores the open handover.
- F8: `recovered` although the owner did not take the record.
- F9: a replacement over a refusing gateway.

## Commands and output

- `pnpm typecheck`: exit 0.
- Covering tests at f8ee731:
  - cli `test/fleet-recover.test.ts test/gateway.test.ts`: 2 files, 24 passed.
  - archid `test/handover/service.test.ts source.test.ts destination.test.ts test/ownership.test.ts
    test/gateway/authority.test.ts test/fleet.test.ts`: 6 files, 231 passed.
- Full suites (protocol untouched this round):
  - cli: 369 passed, 15 skipped (env-gated live ssh/rsync), 0 failed.
  - archid, first run: 1111 passed, 2 failed. Both were rest.test.ts tests that loaded ownership for a fleet with no
    gateway without `standalone`, and so hit the new I4 default. They were marked standalone, rest.test.ts went
    27/27, and the rerun was 1113 passed, 4 skipped, 0 failed.

## Notes

- The relay's fallback means a daemon with no route to the named gateway still takes the relayed record. That is the
  Linux non-gateway case: it never asks at start either, so no start-time check is defeated there.
- A reached machine that declines the record (the gateway it asked said otherwise) is listed among those still to
  be told. If it was running the fleet, the named owner is held back as in I1.
- The deferred minors in the ledger (line 516) were not touched.
