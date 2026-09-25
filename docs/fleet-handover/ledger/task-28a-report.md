# Task 28a report: the `archi handover` commands and helper

Status: **DONE_WITH_CONCERNS**. Every obligation and contract section is met, with code and tests. The concerns below are a contract hazard in the relayed daemon phases, one additive event field, and sizing.

Commits on `fleet-handover-impl` (BASE 177a359). None has an attribution line.

- `7ec3620` The controller relays the daemons' own rest and activation rows, and keeps every event for whoever records a run
- `b9b77d2` The CLI can hand over, resume and abort a fleet, in the foreground or through a helper the app attaches to
- `a83c47d` Removing a gateway names the handover that brings its stranded fleet back
- `9412878` A character can be kept on this machine from the CLI, and list and show say so

The first two commits were each typechecked on their own: the staged index was checked out to a temp folder and `tsc` run there.

## What was implemented

### Controller (Task 27 files, small additive changes)
- `controller/events.ts`:
  - `handover.status` (`Verdict & { helper?: { pid } }`) and `handover.detached` (`{ pid }`) join the vocabulary.
  - `handover.preflight` carries an optional `names: { characters: id→name, roots: id→destination path }`, built by `namesOf(manifest)`.
  - `Observer` takes a second sink, `record`. It gets every event, including those after a post-commit cancel detached the watcher, and a record that throws is skipped.
- `controller/handover.ts`:
  - `HandoverDeps.record` and `Handover.relay(e)`.
  - Preflight emits `names`.
  - `connectHandover`:
    - takes `record`;
    - hooks every daemon client it opens, local or through a forward, with `Client.onEvent`, and relays `handover.changed` and `handover.entity` unchanged;
    - returns `owner()` (the gateway's record) and `secrets()`;
    - `moved` is now `rememberOwner`.
- `client.ts`: `Client.onEvent(fn)`, which returns an unsubscribe. `Client.via` holds the name of the machine that `connectRemote` reached.
- `controller/route.ts`: `rememberOwner(fleetHome, record)`, the cached-route write that `connectHandover` used inline.
- `controller/recovery.ts`: `forgettable(observation, verdict)`. It says yes when the standing is `superseded`, or when the gateway is reachable and neither the gateway nor either daemon (both read successfully) still holds the journal's transaction. It says no when there is no controller journal, or when the gateway cannot say.
- `controller/ssh.ts`: exports `defaultSocketDir(tmp?)` and `ownSocketDir`, which the helper socket fallback reuses.

### Helper runtime (`controller/helper.ts`, new)
- `helperPaths(fleetHome, tmp?)`:
  - the socket is `<fleetHome>/controller/handover.sock`, or `$TMPDIR/archi-<uid>/handover-<sha256(fleetHome)[:16]>.sock` when that path is over 103 bytes;
  - the events file is `events.ndjson`, the log `handover.log` and the pid file `handover.pid`, all in `<fleetHome>/controller`.
- `probe(socket)` answers `live`, `stale` or `none`.
- `HelperServer.open`:
  - makes the controller dir mode 0700 and checks the temp dir with `ownSocketDir`;
  - listens; on `EADDRINUSE` a live socket throws `Live(pid)`, and a stale socket file is removed and listened on again;
  - chmods the socket to 0600, truncates the events file to empty at 0600, and writes the pid file at 0600.
  - `record(e)` scrubs the line, appends it to the events file and writes it to every client.
  - A client that joins gets every line so far, then each new one.
  - Control lines are `{"choose":HandoverChoices}` (checked with zod) or `{"cancel":true}`. Anything else is ignored.
  - `release(client, e)` sends one client its own last line and ends it.
  - `close()` ends every client, closes the server (Node unlinks the socket) and removes the pid file if it is this process's.
- `connectHelper(socket, onLine)` is the attach client.

### Commands (`commands/handover.ts` and `commands/handover-view.ts`, new; `main.ts`)
- `archi handover [machine]` with `--interrupt-after <duration>`, `--terminate-shells`, `--archive <root>` (repeatable), `--resume`, `--abort`, `--forget`, `--detach`, and a hidden `--helper`. Subcommands are `status` and `attach`.
- The transaction is injected: `CliDeps.connect({ fleetHome, profile, record, decide })` returns a `Transaction`. In production that is `connectHandover`.
- `runHandover(job, ctx)` does the foreground run, and the helper's run with `helper: true`, in this order:
  1. refuses a fleet with no gateway;
  2. resolves the destination;
  3. takes the lock;
  4. connects;
  5. for a start, checks the owner through the gateway; for resume and abort, pre-checks `superseded`;
  6. runs.

  Along the way:
  - The command owns the one `handover.result` and drops the Handover's own.
  - The interactive preflight retry loop and the post-commit `finished` follow-up live here.
  - Ctrl-C, SIGTERM and SIGHUP are handled here, and the exit code is set here.
- `launchHelper` is the `--detach` launcher.
- `runStatus`, `runAttach` and `runForget` are the other forms.
- `View` renders a person's reading. `options()` builds the per-blocker choice menu. `Prompter` is a line-based terminal prompt that leaves Ctrl-C a signal.

### Other supported paths
- `controller/host.ts` (F12): the refusal's action now names ``archi [-p <profile>] handover local`` for each stranded fleet, then ``archi host remove <name>``.
- `commands/char.ts`:
  - `char update --keep-here` and `--no-keep-here` send `keepHere` through `char.update`;
  - `char list` shows `name (kept here)`;
  - `char show` puts `<name> is kept on this machine, so a handover is blocked until that is cleared` above the brief.
- `commands/status.ts`: a client that reached another machine prints `archid on <machine>, which runs this fleet (home <home> here)`. Before, it read the local port file, which crashed with ENOENT when no daemon ran here (H1–H4).

## Obligations (task-28a-carried.md)

1. **Contract command set, output, detached helper, events file, control socket, attach, exit codes.** See the contract table below. Tests are in `test/handover.test.ts` (34), plus the real-CLI detach test.
2. **`local` and owner refusal before other work; no gateway refused first.**
   - `runHandover` resolves `local` through `registry.get('local')`.
   - A start calls `tx.owner()` before `handover.start()`. An owner equal to the destination gives `blocked` / `identity_mismatch` ("trift already runs this fleet…").
   - A fleet with no gateway is refused before the lock, the events file or connect, with ``archi host enable <host> --fleet <profile>``.
   - Tests: "takes local as this machine, and refuses the machine that already owns the fleet before any other work" (no `start` call); "refuses a fleet with no gateway before anything else…" (no connect, and no `controller/` dir created). The helper variant writes the reason to its log.
3. **Blockers before Begin, resolved for a human; warnings print; non-interactive never prompts.**
   - `View` and `issueLine` lead each blocker with the character's name, or the root's destination path. They skip that lead when the message already names it as a word; a name inside a path, such as `/Users/ada`, does not count.
   - Warnings print with `!`.
   - Non-interactive means no TTY, or `--json`, and not a helper. There `decide` returns `cancel` at once, and a preflight `blocked` exits 1 with the flags that would get past it (`--interrupt-after`, `--terminate-shells`, `--archive <path>`).
   - Tests:
     - "prints each blocker before Begin with what it names, and the warnings…", covering a transcript path, a Task 22 file name, a root and a rest message, for both a non-TTY run and TTY+`--json`;
     - "never waits on a blocker after Begin without a person or a helper…".
4. **Choices.**
   - Interactive preflight blockers go to a menu, and the answer is a new `start` with merged choices. Blockers after Begin go through `decide`, which returns the merged choices.
   - `i` typed while resting calls `Handover.choose({ interruptAfterMs: 0 })` and names the characters still resting.
   - The menu labels name the characters and paths: Continue waiting for …; Interrupt and carry … (Escape, then the hook or process tree must confirm it rested); Terminate and carry … (kills the foreground process, an unsettled agent included, and the shell reopens in its directory); Archive <paths> (moved to a timestamped sibling first); Cancel.
   - Tests: "asks at each blocker in a terminal, naming the characters and paths…"; "takes Interrupt and carry typed while the rest still waits, through choose…".
5. **`--terminate-shells` help.** It reads "…and an interrupted agent that will not settle; a Claude agent with a background command still running counts as not settled". Test: "says what --terminate-shells also ends".
6. **Daemon rest and activation events reach the stream.** This is `Client.onEvent` plus the `relaying()` hook in `connectHandover`. Tests:
   - "relays the daemon's own handover events as they arrive…", with a real local authority server, a fake WebSocket daemon and a real `connectHandover`; `state.patch` is not relayed;
   - "relays what a daemon reports…";
   - `Client` "hands each event the daemon pushes…".
7. **Ctrl-C and control `cancel` are `Handover.cancel()`.**
   - First Ctrl-C before the commit: the "Cancelling: …" note, then the abort's result, and the result names the next command.
   - After the commit: "The fleet is committed to <dest>, so the move goes on until it finishes. Ctrl-C again stops watching; `archi handover --resume` finishes it then". The run waits on `finished`.
   - Second Ctrl-C: exit 1 with `hard`, naming `--resume`. Before the commit it also names `status` and `--abort`, because a resume after a half-done cancel would go forward.
   - Typing `c` behaves exactly like Ctrl-C.
   - Tests: "on Ctrl-C before the commit…"; "on Ctrl-C after the commit … a second Ctrl-C … names --resume"; "on a first Ctrl-C after a client already let the committed move go on…".
8. **Superseded journal.**
   - `status` names `--forget`.
   - `--resume` and `--abort` pre-check the standing and end `interrupted` / `safe: []` with the error "…; `archi handover --forget` drops this controller's journal of it". Neither `resume()` nor `abort()` is called.
   - `--forget` removes only `handover.json` and `handover/<tx>/` (`fileStore.clear`), only when `forgettable` allows it, and never while a helper answers. The events file, route, daemon journals and gateway record are left alone.
   - Tests:
     - "refuses --resume and --abort on a journal the gateway has superseded, naming --forget";
     - "forgets only a journal the gateway has superseded, and only this controller's files";
     - "reads status … --forget …";
     - recovery.test `forgettable` ×2.
9. **F12.** `host remove` refuses with "bring it back to this Mac with `archi -p lab handover local` and `archi handover local`, then `archi host remove trift`". Test: host.test "names the handover that brings a stranded fleet back, profile and all…".
10. **I5 / H1–H4 at the command level.** The test "a fleet handed to another machine, from this one" runs the handover command with a fake transaction. What that transaction leaves behind is the gateway's record, now trift at generation 5, and the route cached through the production `rememberOwner`. Then the real `tsx main.ts` binaries run against a fake ssh and a fake trift daemon:
    - first with the gateway unreachable: `status --json` reaches trift through the route the handover cached (the route file is asserted);
    - then through the gateway: `status --json`, `char list --json`, human `archi status` (names trift, exit 0) and `connect --json` (`online` with `remote.name: trift`).

    This found and fixed a real H1–H4 bug: human `archi status` crashed on the missing local port file.
11. **Keep on this machine.** Tests: char.test "is set and cleared through char.update…"; "marks a kept character where char list and char show name it".

## Contract (task-28-29-contract.md), where each part lives

| Contract section | Where | Test |
|---|---|---|
| Commands, including `-p` and `--json` anywhere, `local`, `--archive <root>` (id or path), `--interrupt-after 0`, `0s`, `<n>s`, `<n>m` (amendment) | `handoverCommand`, `jobOf`, `parseDuration` | "reads the rest choices a start is given" (includes `0s` and `r_1f2e`) |
| Output: NDJSON only on stdout, the last line `handover.result`, diagnostics on stderr, no token anywhere | `output()`, `HelperServer.record` scrub, `redact` on results, verdicts and forget | "hands the fleet over in the foreground…" (token in a retry event is scrubbed; events file = stdout); helper "writes every event … scrubbed…" |
| `handover.status`, `handover.detached` | `events.ts`, `runStatus`, `launchHelper` | status and launcher tests |
| Relay of daemon `handover.changed` and `handover.entity` | `connectHandover`'s `relaying` | obligation 6 |
| Detached helper: own session, stdin and stdout closed, stderr to the 0600 log, waits for the socket, prints `handover.detached`, exit 0; a helper that cannot start is `handover.result` and exit 1; a decision waits for a client | `launchHelper`, `spawnHelper`, `started`, `runHandover({helper})` | "starts the helper in a session of its own…" (fixture reports its argv, pgid == pid, stdin closed, log 0600); "prints a handover.result naming why…" (exit before listening, live helper, no gateway); real-CLI "leaves the run to a helper it starts as itself…" |
| Events file: 0600, scrubbed, truncated per start, resume or abort | `HelperServer.open` and `record` | helper events-file test |
| Control socket: 0600 in a 0700 dir, hashed fallback, stale removed, live is the lock for start, resume, abort and forget, naming attach | `helperPaths`, `listen`, `settle`, `runForget` | helper path and lock tests; "refuses a second start, --resume, --abort and --forget while a helper answers…" |
| Socket protocol: replay then stream then result then close; `choose` answers the pending decision or else is `choose()`; `cancel` is Ctrl-C; unknown lines ignored; several clients | `HelperServer`, `onControl` in `runHandover` | helper replay and control tests; "attaches to a live helper: replays…, answers its decision with choose, cancels like Ctrl-C"; "lets an attached client go on its own cancel once the move is committed…" |
| `attach`: relay both ways, stdin EOF ends it with exit 0 without touching the helper; no helper means events file plus one `handover.status`; human rendering | `runAttach` | the attach tests, "ends attach when its input ends…", "rebuilds a run with no live helper … removing a stale socket", "lets a person attached at a terminal answer the helper from a menu…" |
| Exit codes | `done()`, `Ran` | "exits 0 only when the command did what it was asked" (6 cases) |

### Spellings chosen where the contract was open
- The hidden flag the launcher starts the helper with is `--helper`. The helper runs as `node [execArgv] <argv[1]> <this invocation's args without --detach> --helper` in its own session. That matches the release shim (`node lib/archi.mjs`) and tsx in development.
- The pid file is `<fleetHome>/controller/handover.pid`, which is where `helper.pid` in `handover.status` comes from. The log is appended across runs, never truncated, so a refused launch cannot clobber a live helper's log.
- Refusals before the lock (no gateway, unknown machine, live helper, and launcher failures) are `{ status: 'interrupted', phase: 'begin', error, safe: [] }`. The owner refusal is `{ status: 'blocked', phase: 'begin', blockers: [identity_mismatch] }`, as preflight would put it.
- `--forget --json` prints one `handover.status`: the status after forgetting, or the current one when it refuses. Exit is 0 or 1. `--forget` with a live helper prints only to stderr and exits 1.
- A second Ctrl-C exits 1, as the contract says ("1 otherwise"), not 130.
- A post-commit `cancel` from a client ends that client with its own `handover.result` `{ status: 'detached' }`. The helper, the events file and the other clients carry on to the real result.
- Human `attach` treats a decision as pending when the last non-entity event is `handover.blocked`, and prompts after a 150 ms settle so that a replayed, already-answered decision does not prompt. A typed `i` sends `{"choose":{"interruptAfterMs":0}}` and a typed `c` sends `{"cancel":true}`. Ctrl-C only ends `attach`.
- The launcher waits up to 20 s for the socket, then kills the child and reports why.

## TDD evidence
- **Cycle 1 (controller).** RED: `pnpm vitest run --project cli test/controller/handover.test.ts test/client.test.ts` gave 5 failed: `client.onEvent is not a function`; the preflight had no `names`; `expected [] to deeply equal [...]` (record); `c.relay is not a function`; `c.owner is not a function`. GREEN: 39/39.
- **Cycle 2 (helper).** RED: `Failed to load url ../src/controller/helper.js`. GREEN: 6/6.
- **Cycle 3 (commands).** RED: `Failed to load url ../src/commands/handover.js`. GREEN: 26/27. The one failure was the test waiting for text that my first Ctrl-C note already contained, so the wait was fixed. Then 27/27.
- **F12.** RED: `expected 'disable handover for /tmp/archi-host-…' to contain '`archi handover local`'`. GREEN: 45 passed, 1 skipped.
- **Keep-here.** RED ×2: an unknown option made commander exit; the list had no marker. GREEN: 6/6.
- **H1–H4.** RED 1: the handover exited 1 because `rememberOwner` did not exist yet. RED 2: `archi: ENOENT … /port` from the human `archi status`. GREEN.
- **Forward-only phase headings.** RED: two "Resting characters" lines. GREEN.
- **Written after the code**, with the mutation checks below standing in for RED:
  - `forgettable` unit tests;
  - the human-attach steering test;
  - the socket answering the terminal's question;
  - the non-interactive `decide`;
  - the real-CLI detach test;
  - the helper-log and detached-then-first-Ctrl-C tests;
  - the amended-contract parse assertions.

### Mutation checks: 25 mutations, all killed
Each mutation was run against its covering test through `scratchpad/task28a/mutate.py`.
- M1 record sink dropped
- M2 daemon events not relayed
- M3 events not scrubbed
- M4 stale socket not taken over
- M5 owner not checked
- M6 non-interactive `decide` waits
- M7 Ctrl-C does not cancel
- M8 the detached run is not followed to `finished`
- M9 superseded not refused
- M10 forget anything
- M11 route not cached
- M12 status reads the local port
- M14 `keepHere` not sent
- M15 canceller not released
- M16 `--detach` passed on to the helper
- M17 no names in preflight
- M18 no retry after a preflight choice
- M19 `choose` never answers a decision
- M20 events file kept across runs
- M21 `forgettable` ignores the daemons
- M22 F12 old action text
- M23 human attach never prompts
- M24 helper refusal not logged
- M25 first Ctrl-C after a detach exits
- M26 view heads backwards

## Files changed
- New:
  - `packages/cli/src/commands/handover.ts` (549 lines)
  - `packages/cli/src/commands/handover-view.ts` (278)
  - `packages/cli/src/controller/helper.ts` (181)
  - `packages/cli/test/handover.test.ts` (34 tests)
  - `packages/cli/test/fixtures/helper.mjs`
- Modified source: `packages/cli/src/{client,main}.ts`, `packages/cli/src/commands/{char,status}.ts`, `packages/cli/src/controller/{events,handover,recovery,route,ssh,connection,host}.ts`
- Modified tests: `packages/cli/test/{client,char,host}.test.ts`, `packages/cli/test/controller/{handover,recovery}.test.ts`
- Not touched: `packages/archid`, `commands/fleet-recover.ts`, `controller/authority.ts`, `apps/`, the protocol. There is no new protocol code and no `PROTOCOL_VERSION` bump.

## Test commands and results (ARCHI_HOME, ARCHI_CHAR_ID and TMUX unset)
- `pnpm vitest run --project cli` on the final tree before committing: **27 files, 410 passed, 3 skipped**. An earlier full run under load 32 failed one test, `ssh.test.ts` "never adopts a master it did not spawn, even on the socket it would use". That test counts fake-ssh master spawns, which is a timing race. It passed alone twice, and my ssh.ts change only exports two functions.
- At HEAD: `pnpm vitest run --project cli test/handover.test.ts test/controller/handover.test.ts test/controller/recovery.test.ts test/client.test.ts test/host.test.ts test/char.test.ts` gave **6 files, 142 passed, 1 skipped**.
- `pnpm typecheck`: clean.

## Self-review findings (fixed before commit)
- The source's journal closes at Complete re-emitting `freeze`, the destination's closes re-emitting `activate`, and the destination's claim writes `verify` while the controller is still transferring. Relayed as the contract requires, these printed headings backwards. The view now takes only forward phase changes (M26).
- A second Ctrl-C before the commit pointed only at `--resume`, which would carry the handover forward after the user asked to cancel. It now names `status`, `--resume` and `--abort`.
- A first terminal Ctrl-C after a client's cancel had already detached the run exited at once. It now says the move goes on (M25).
- A helper that failed before listening wrote nothing to the log the launcher points at. It now logs its refusal (M24).
- The helper, and the `status`, `attach` and `--forget` paths, now take their ssh masters down on a signal (`closeMastersOnSignal`), as other commands do.
- `--forget --json` printed an unscrubbed verdict. Fixed.
- `char show` first said a kept character is "left behind". It blocks the handover, and the text now says so.
- The H1–H4 test first read a route that resolveOwner had rewritten. Reordered, so the unreachable-gateway step runs first and uses only the route the handover cached.

## Concerns
1. **Relayed `handover.changed` is not monotonic.** It has the same shape as the controller's own events. At Complete, just before the result, the stream carries a late `freeze` (the source closing its journal) and `activate` (the destination closing its journal). A `verify` also arrives early, during transfer. Task 29's "close terminal surfaces on `handover.changed` → `freeze`" will see that late `freeze`. It is probably harmless, because the surfaces are already closed and the app reconnects after the result. But the app must not treat phases as monotonic or keyed by the last `changed`. Rulings the controller could make: relay only `handover.entity`, or document that relayed phases can trail.
2. **`names` on `handover.preflight` is an optional addition** to the contract vocabulary. The CLI needs it to name characters and root paths. It is additive, so the app may ignore it or use it. A resume has no preflight, so its rows fall back to ids; rest blockers name the character in their message anyway.
3. **Size.** `commands/handover.ts` is about 550 lines: the foreground and helper run, launcher, status, attach, forget and commander wiring. The launcher and attach are the natural cut if wanted. `controller/handover.ts` is now 1022 lines, and was about 1004 before.
4. **The real `connectHandover` has not run a handover through the CLI.** It is exercised only with a local gateway and daemon (the relay test) and with an unreachable gateway (the real-CLI detach test). The full SSH run stays with the M3 gate, as Task 27 carried.
5. **Stale-socket takeover race.** Two processes that find the same stale socket at the same moment can both unlink and listen. The window is narrow, and the controller journal's "already open" check in `start()` backs it up.
6. `archi handover status` and `archi handover attach` shadow hosts named `status` or `attach`.
7. **`archi status` output changed for a remote owner.** Human `archi status` now prints `archid on <machine>, which runs this fleet…` when it reached another machine. That touches a command outside handover, and it was needed for H1–H4.
8. **Shared scratchpad.** The coordinator reported that the 28b implementer's run used my `mutate.py` path. I checked afterwards: every intended edit is present, no `.mutbak` backup files remain, and the full suite passed on the final tree. My scratch files now live in `scratchpad/task28a/`.

## Fix round 1 (task-28a-fix1-findings.md: I1–I4, M1, M5; I5 and I6 added mid-round)

Commits on top of 9412878. Neither has an attribution line.

- `5007b3a` Only the controller says where a handover stands, and says it again once a decision is answered
- `8db9b47` A handover helper holds its fleet's lock alone, and attach, --forget and bad arguments keep to the app's contract

### Per finding

**I1. The daemons' `handover.changed` is no longer relayed.**
- Change: `connectHandover`'s `relaying` passes on only `handover.entity`, as the amended contract says: only the controller emits `handover.changed`.
- The view's phase check is back to a plain repeat check. With daemon phases gone, the only step back left is the controller's own: prepare → transfer, copying again after a prepare blocker, and the view now heads that step again.
- Test: `test/controller/handover.test.ts` "relays the daemon's own handover rows as they arrive and never its phases…". The fake daemon now also sends `handover.changed`, and only the entity row may be recorded. The connection is closed in a `finally`, so a failure shows as a failure rather than as a hang in `wss.close`.
- Test: `test/handover.test.ts` "heads a step once though it is said again after a decision, and again when the handover goes back to copy" replaces the test that fed daemon phases to the view.

**I2. End of input at an interactive `attach` ends the attach and never touches the helper.**
- Change: `Prompter`'s close handler abandons a pending question when the prompter has an `ended` callback (attach), and always calls `ended`. The foreground has no `ended`, so there EOF with a question pending is still `cancel`.
- Test: `test/handover.test.ts` "ends a terminal attach when its input ends with a question pending, and neither answers nor cancels". With a TTY attach and a menu shown, `stdin.end()` gives exit 0. After that the helper has no cancel, the decision is still pending, the socket is still live, and a second client answers it.

**I3. Bad arguments under `--json` or `--detach` give a `handover.result`.**
- Change: `--interrupt-after` is taken raw and parsed in `jobOf`. The action catches `jobOf`'s error. Under `--json` or `--detach` it prints `{ status: 'interrupted', phase: 'begin', safe: [], error }` (to stdout, or as a person's reading when `--detach` runs without `--json`) and exits 1 without launching. A foreground human run still throws to stderr.
- A person's reading of an `interrupted` at `begin` now reads "Stopped before it began: …".
- Test: `test/handover.test.ts` "answers bad arguments with a handover.result under --json or --detach, and starts nothing". It covers a bad duration with `--detach`, no machine with `--detach`, a bad duration with `--json` alone, and `trift --resume --detach` read by a person.
- Commander's own usage errors (an unknown option, a missing value) still reach main.ts's stderr before the action runs.

**I4. The route cache a real handover writes is covered.** No code changed.
- Test: `test/controller/handover.test.ts` "hands the gateway's record of the moved fleet to whatever routes to it next". `Handover` calls `moved` once with `{ fleetId, generation: G+1, ownerMachineId: trift }`.
- Test: "finishes a committed handover and caches the route to its new owner, which owner resolution then reads". This drives a real `connectHandover`:
  - a real authority server on this machine holds the handover to trift, committed at generation 1;
  - the local daemon is a fake WebSocket daemon;
  - trift is reached through the fake ssh (connection-info, then a forward to a second fake daemon);
  - `handover.resume()` finishes it: destination Complete, source Complete, gateway Complete, then `moved`.
  - Asserted: `route.json` is trift at generation 1, and `resolveOwner` resolves trift from that cached route, because this gateway has no ssh route from here.
- Mutations F4a (`this.d.moved?.(record)` removed) and F4b (the `moved` wiring in `connectHandover` removed) are both killed.

**I5. After an answered decision the controller says the current phase again.**
- Change: `controller/handover.ts` calls `this.phase('freeze')` once the freeze loop's decision is answered, and `this.phase('transfer')` once the claim loop's is. The other decision points already emit a phase when they loop: transfer through `phase('transfer')` at the loop's top, and prepare through the copy again.
- Test: `test/controller/handover.test.ts` "says where it stands again once a decision is answered, so a replayed stream never shows it still pending", with a blocked agent in freeze and a diverged root found at claim.

**I6. `--forget` removes the events file with the journal.**
- Change: `runForget` removes `events.ndjson` after `fileStore.clear`.
- Test: "forgets only a journal the gateway has superseded…" now asserts the events file is gone, and that `route.json` and `fleet.json` stay.

**M1. Lock races.**
- `controller/helper.ts` `takeLock(paths)`:
  - `<fleetHome>/controller/handover.lock` holds the holder's pid for the helper's whole life.
  - It is taken with `link()` from a temp file that already holds the pid, so it is never read empty.
  - A holder that is still running refuses with `Live(pid)`.
  - A gone holder's lock is `rename`d aside first and removed only if the moved file still names a process that is gone. A lock a live helper took meanwhile goes back through `link` (which fails if yet another took the place) and refuses.
  - `release` removes the lock only if it still holds this pid.
  - `HelperServer.open` takes the lock before the socket, and `close()` gives the socket up first, then the lock.
- The lock file replaces the pid file: `readPid` reads the lock, and status reports that pid.
- Only the listener removes a stale socket, only while `readPid === process.pid`. An `lstat` that finds the file gone is tolerated.
- The readers (status, attach, the launcher's pre-check and forget) only probe. The `settle()` that unlinked is gone.
- `--forget` holds the lock from its first look to the clear.
- The launcher's `started()` accepts only a live socket whose lock names `child.pid`. The fixture writes the lock the way a real helper does.
- A refused start whose lock holder does not answer on the socket (a `--forget` under way, a helper starting or stopping, or a reused pid) says so and names the lock file to remove, instead of pointing at `attach`.
- Tests, all in `test/handover.test.ts`, describe "the single-controller lock", unless noted:
  - "is never taken apart by a reader…": status, attach, the launcher and `--forget` each leave a stale socket in place, and the next helper takes it over.
  - "lets exactly one of two starts that find the same stale socket take it", five rounds with the two starts run concurrently.
  - "takes over a lock whose holder is gone, and refuses one a running process still holds", with the lock file left untouched in the refused case.
  - "is held by --forget from its first look to the clear…": a start during forget is refused before connecting.
  - "never takes another helper that comes up meanwhile for the one it started", in the `--detach` describe: a helper comes up in the test while the launched child never listens, and the launcher prints a `handover.result` and exits 1.
  - The attach test now asserts a stale socket is left alone.

**M5. Verdict errors are scrubbed.**
- Change: `verdictOf` rethrows any error from the transaction with its tokens redacted, so `runStatus` and `runAttach` print it scrubbed.
- Test: "keeps a token out of what status and attach say when the journals cannot be read", for both commands, with and without `--json`.

### TDD evidence (RED before each fix)
`pnpm vitest run --project cli test/handover.test.ts test/controller/handover.test.ts` failed 11, then 2 more once I5 and I6 were added:
- I1: `expected [ { …(2) }, …(1) ] to deeply equal [ { event: 'handover.entity', …(1) } ]`. The first run showed a 5 s timeout, because `c.close()` sat after the failing assertion; it is now in a `finally`.
- I2: `expected 1 to be +0` (the helper had been cancelled).
- I3: the command threw `bad duration "soon": …` instead of printing a result.
- I5: `- "phase": "freeze" / + "phase": "transfer"`.
- I6: `expected true to be false`, because the events file was kept.
- M1:
  - reader unlink: `ENOENT … lstat '…/controller/handover.sock'`, from both the attach test and the reader test;
  - two starts: `expected [ …(2) ] to have a length of 1 but got 2`;
  - lock takeover and the events test: `"path" argument … Received undefined`, since `paths.lock` did not exist yet;
  - `--forget`: a timeout waiting for the lock file;
  - launcher: `expected +0 to be 1`, because it took a stranger's socket.
- M5: `expected 'archi handover: archid on trift refus…' not to contain 'daemon-t0ken-never-written'`.
- The I4 tests passed from the start: they cover code that already existed. The mutations below stand in for RED.

### Mutation checks (`scratchpad/task28a/mutate-fix1.py`)
Killed:
- F1 daemon phases relayed
- F2b attach EOF handled as it was before the fix
- F3 bad arguments thrown
- F4a `moved` not handed on
- F4b `moved` not wired
- F5a freeze phase not said again
- F5b claim phase not said again
- F6 events file kept on forget
- F7 readers unlink a stale socket
- F8 lock taken from a live holder
- F9 launcher takes any socket
- F10 forget without the lock
- F11 verdict errors unscrubbed

Survived, and kept:
- **F2** (EOF resolves the pending pick as `cancel`): `ended()` closes the connection at once, so a late cancel is never delivered. The `null` only makes that explicit.
- **F12** (the stale-socket unlink without the "still holds the lock" check): this is the second guard, for the rare race where two takers both believe they hold the lock. One process cannot reproduce that race, so no test reaches the check.

### Commands and results (ARCHI_HOME, ARCHI_CHAR_ID and TMUX unset)
- `pnpm vitest run --project cli test/handover.test.ts test/controller/handover.test.ts test/controller/recovery.test.ts`: **3 files, 98 passed**.
- `pnpm typecheck`: exit 0.
- `pnpm vitest run --project cli`: **27 files, 421 passed, 3 skipped**.

### Notes
- The RED run with `paths.lock` still undefined wrote a stray file named `undefined`, holding a pid, at the worktree root. It was removed before the commits, and the tree is clean.
- The contract says "A socket file that refuses connections is stale and is removed". That now holds only for the helper that takes the lock. A reader treats a stale socket as no helper and leaves it.

## Fix round 2 (task-28a-fix2-findings.md: N1, N2)

Commits on top of Task 29's 9343c35. `apps/` is untouched, and neither commit has an attribution line.

- `e776a77` A decision answered at prepare says again where the handover stands
- `9fe6e25` A lock left by a killed helper never blocks the next handover, and the launcher reports a lock it cannot take

### N1. A lock whose pid another process has since been given
- Change, in `controller/helper.ts`: a lock's holder counts only while a process runs under its pid (`kill(pid, 0)`, with EPERM counting as running) and that process started before the lock was written.
  - "Started" is `ps -o lstart= -p <pid>`, run from an argv with `LC_ALL=C` and parsed by `Date.parse`. It is truncated to the second, so it never reads later than the true start.
  - "Written" is the lock file's mtime. The lock is a temp file linked into place, so its mtime is when its holder wrote it.
  - The genuine holder always started before it wrote its lock. A process started since, after a reboot or a SIGKILL, has only been given the same pid, and this process's own pid given again is the same case.
  - When `ps` cannot say, a running process still counts as the holder (fail closed).
  - The move-aside re-check uses the moved file's own mtime.
- `lockHolder(paths)` returns the running holder's pid, if any.
- Change, in `commands/handover.ts`: `launchHelper` now checks the lock as well as the socket before it spawns anything. A running holder that does not answer on the socket gets a `handover.result` naming `handover.lock` and saying to remove it if no `archi handover` runs here, and exit 1. It is no longer "exited … see the log".
- Tests, in `test/handover.test.ts`:
  - "never lets a process that took a gone holder's pid, this one included, keep the lock". An unrelated `sleep`, and this process's own pid, are each named in a lock whose mtime is an hour back, before either process started. Each lock is taken over, and each ends up holding this pid.
  - "reports a lock a running process holds without answering as its result, and launches nothing".
  - Kept: "…refuses one a running process still holds", where the `sleep` started before the lock was written.
- RED: "a handover of this fleet is already running here (pid 4314)…" for the gone-holder test, and `expected [ Array(1) ] to deeply equal []` for the launcher, which had launched.

### N2. A decision answered at prepare
- Change, in `controller/handover.ts`: `precommit()` calls `this.phase('prepare')` once the prepare decision is answered, before the empty-landed prepare call and the copy that follow it.
- Test: "says where it stands again once a decision is answered…" has a third case. The destination refuses the first prepare as `blocked` / `destination_diverged`, the decision is answered, and the next event after `handover.blocked` (phase `prepare`) must be `handover.changed` `prepare`.
- RED: the next event was `handover.changed` `transfer`.

### Mutation checks (`scratchpad/task28a/mutate-fix2.py`), all killed
- G1: holder judged by `kill` alone
- G2: launcher ignores the lock
- G3: prepare phase not said again
- G4: a running holder not refused

### Commands and results (ARCHI_HOME, ARCHI_CHAR_ID and TMUX unset)
- `pnpm vitest run --project cli test/handover.test.ts test/controller/handover.test.ts test/controller/recovery.test.ts`: **3 files, 100 passed**.
- `pnpm typecheck`: exit 0.
- `pnpm vitest run --project cli`: **27 files, 423 passed, 3 skipped**.

### Note
- A lock whose holder cannot be judged, because `ps` is missing or its output is unreadable, still refuses while the pid runs. The launcher reports that refusal, naming the lock file to remove.
