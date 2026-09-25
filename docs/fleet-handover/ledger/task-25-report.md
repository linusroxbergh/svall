# Task 25 — Source freeze, abort and export service

Commit: `2b4f015 A source fleet freezes and aborts without losing its crew` (on fleet-handover-impl, parent bdc2744)

Status: DONE_WITH_CONCERNS. The concerns are two interface decisions that Task 27 depends on (the wire params, and how the
source daemon reaches the gateway) plus files touched beyond the plan's list. Details are under Concerns.

## What was implemented

### `packages/archid/src/handover/source.ts` (new): `SourceHandover`

This class holds the source side of the transaction. `HandoverService` builds it when it is given `source` deps. Phases
run one at a time on a promise queue.

**Preflight** never writes a file, fences, sends a signal or asks the gateway. It reports:

- identity:
  - `identity_mismatch` when the fleet has no gateway;
  - `identity_mismatch` when the destination is this machine;
  - `identity_mismatch` when the destination the controller described is not `toMachineId`.
- release, protocol and schema: `incompatible_release`, `incompatible_protocol`, and `incompatible_schema` for the
  state schema and the transfer schema each. A handover needs an exact release match.
- agents: `agentBlockers` (Task 22), fed with this machine's probes and the destination's `system.info` agent list. It
  runs only for the agent kinds the fleet's terminals record.
- paths and Git: `buildInventory` and `buildManifest`. Task 21's Git blockers arrive through these once it is
  cherry-picked.
- processes: one bounded read of `tmux list-panes` plus `ps`, judged by `unapproved(...)` under the choices the freeze
  will carry.

It returns `{ manifestSummary, blockers, warnings }`.

**Freeze** (`runFreeze`) steps:

1. If a journal for this transaction already holds a digest, return the kept manifest. A journal at `aborted` is refused.
2. `begun()`: ask the authority. It must name this machine as owner at `p.generation`, with transaction `p.transactionId`,
   from this machine to the destination described, in phase `preparing`. Otherwise the freeze is refused with
   `not_owner`, `generation_mismatch`, `transaction_mismatch` or `authority_unreachable`, and nothing is written.
3. Fence:
   - write the source journal (`phase: 'freeze'`) first;
   - then `ownership.freeze(tx)`, which puts frozen, surrendered and the transaction in owner.json;
   - then `fleet.settle()`.
4. Re-run the cheap checks (identity, versions, agents, inventory). A blocker here returns the fleet to normal ownership
   with no window closed.
5. Emit per-character `handover.entity` progress, then `restTerminals`. A rest blocker returns the fleet to normal
   ownership, the same way as step 4.
6. Build the manifest from the rested state (every slot dormant, with its resume command). A blocker here comes after
   windows have closed, so the source stays frozen with its journal, and Abort revives the terminals.
7. Remove any manifest file no journal names, then write `handover/manifest-<tx>.json` (0600, canonical, immutable).
   Record `manifestDigest` in the journal, emit done/total per character, and return the manifest.

**Abort** (`runAbort`) steps:

1. Nothing to abort (no journal, not frozen) returns `{}`.
2. `mayTakeBack()` refuses in these cases:
   - `authority_unreachable`;
   - `handover_committed` when the gateway names another owner, or this transaction committed;
   - `generation_mismatch`;
   - `not_ready` while the gateway still holds this transaction open. The controller must `owner.abort` first.

   A standalone fleet skips the proof.
3. Journal to `aborted`.
4. Revive only `stoppedTerminals` (`tmux.ensureServer`, then `reviveCharacter` or `openSecond`). A terminal that fails
   is logged, reported as an entity error, and left dormant.
5. `release()`:
   - close the journal while the surrender still stands;
   - `ownership.unfreeze()`;
   - `fleet.activate()` and `fleet.reconcileNow()`.
6. Remove the manifest file.

**Idempotency:**

- A repeated Freeze with the same choices joins the one in flight.
- A repeated Freeze with other choices cancels the in-flight wait (nothing closed) and rests with its own choices. This
  is how Interrupt and carry works mid-rest.
- A repeated Freeze after success, or after a restart, answers the kept manifest without asking the gateway or touching
  tmux.
- A repeated Abort returns `{}`.
- An Abort cancels a Freeze that is still waiting. A Freeze already closing windows finishes first.

### Other files

- `handover/service.ts`:
  - `HandoverDeps` gains optional `agents` (the probe function) and `source` (SourceDeps).
  - `preflight`, `freeze` and `abort` delegate to the source. They answer `not_ready` only when no source is wired,
    which happens in tests.
  - `freeze` skips `authorize` when the open source journal names the same transaction, so a repeated freeze on a
    frozen source is answered.
  - `abort` of a destination journal stays `not_ready` (Task 26).
  - New `agentAdapters()`.
- `api/methods.ts`: `system.info` reports `await handover.agentAdapters()` instead of `[]`.
- `handover/sessions/registry.ts`:
  - `agentAdapters` also reports `loggedIn` and `hooks`.
  - New `realProbeDeps()`: `execFile` with a 10 s timeout. A timeout counts as a failed run, and only a CLI that cannot
    start rejects.
  - New `agentProber(deps, ttl = 60 s)`: cached, and shared by callers while a probe is in flight.
- `handover/processes.ts`: new `ProcessTable.tree(roots)`, which returns roots plus every live descendant, whatever
  group or session each is in.
- `handover/rest.ts`:
  - terminate signals every process group in `table.tree(foreground)` and journals every process in it;
  - an `interruptAfterMs` longer than `waitMs` is clamped to `waitMs`.
- `gateway/client.ts`: new `fleetAuthority({ gatewayMachineId, machineId, prefix?, registry?, ssh? })`, a real
  `Authority`:
  - on the gateway machine, it uses the authority's own Unix socket at `gatewayPrefix()`;
  - elsewhere, it reads the gateway's ssh route from the controller registry (`~/.config/archipelago/machines.json`) and
    runs `ssh -o BatchMode=yes -o ConnectTimeout=10 -- <dest> '<archiBase>/current/bin/archi' 'gateway' 'owner' 'get' '--fleet' '<id>'`.
    The command is argv plus single-quoted remote words, as the controller builds it, and the last stdout line is read
    as the frame.
- `main.ts`:
  - wires `agents: agentProber(realProbeDeps())` and the source deps (store, fleet, tmux, `TerminalHub` as viewers, a
    `ps` reader with `installedScripts(paths.home)`, log);
  - adds `authority: fleetAuthority(...)` only when fleet.json names a gateway;
  - `TerminalHub` is now built before `HandoverService`. Its constructor only subscribes to fleet events.
- `paths.ts`: `manifest(transactionId)` → `handover/manifest-<tx>.json`.
- protocol `handover.ts` and `messages.ts`:
  - `AgentAdapter` gains optional `loggedIn` and `hooks`.
  - New `HandoverMachines = { source: { pathRoots }, destination: { info: SystemInfo, pathRoots, fleetHome } }`. Each
    `pathRoots` must hold `home`.
  - `handover.preflight` params become `{ toMachineId, choices = {} } & HandoverMachines`.
  - `handover.freeze` params become `{ transactionId, generation, choices = {} } & HandoverMachines`.
  - `handover.freeze` result requires `manifest.transactionId`.
  - New `HandoverError` code `authority_unreachable`.

## Carried obligations

1. **Freeze result without transactionId.** The result schema is now `TransferManifestV1.extend({ transactionId })`. A
   preflight-shaped manifest fails to parse (protocol test). The service also checks that the returned manifest names
   the transaction (`named()`), both for a fresh build and for a kept manifest.
2. **Continue waiting, clamp, choices read once.**
   - A rest blocker (agent_blocked, agent_working, shell_busy, agent_unsettled) comes back before any window closes.
     The source then closes its journal, unfreezes and restarts background work, so the user can answer the agent.
     The gateway transaction stays open. Freeze is callable again with the same transaction id; the spec's "returns it
     to normal ownership without killing a window" holds.
   - A later freeze with `interruptAfterMs: 0` interrupts, and a freeze with new choices while one waits supersedes the
     wait.
   - The clamp is in `restTerminals`.
   - Tests:
     - `gives a blocked agent back to its user … freezes again under the same handover once it is answered`
     - `interrupts a blocked agent when asked again with Interrupt and carry`
     - `takes Interrupt and carry asked while it waits on a working agent …`
     - rest `interrupts at the end of the wait when the chosen delay would outlast it`
3. **Aborted journal → frozen-source.** `release()` closes the journal before `ownership.unfreeze()`. The test records
   owner.json's `surrendered` at each journal event: `[true, true]`, for the `aborted` write and then the close. A crash
   between close and unfreeze is recovered by retrying Abort (test `finishes an abort a crash cut short…`).
4. **Standalone frozen-source.** With no gateway there is no `authority`, and Abort skips the proof. Test
   `lets a standalone fleet out of a freeze without any gateway`: the restarted daemon is surrendered, and Abort
   unfreezes it and revives the terminals.
5. **probeAgent/agentBlockers and system.info.** Preflight runs `agentBlockers` with this machine's probes and the
   destination's reported adapters. `system.info` returns the real probe through the 60 s cache. Tests:
   - four preflight cases: missing CLI, logged out, hooks missing, and unsupported release on either machine;
   - `are probed once a minute at most … and reported by system.info`.
6. **Terminate leaves no tree behind.** `ProcessTable.tree` plus rest's terminate cover it.
   - Fixture tests, on both platforms:
     - the standalone Codex tree includes `node_repl`, `adlc mcp-server`, `codex-code-mode-host` and the tool;
     - the npm layout;
     - the Claude tree's groups include the browser an MCP server launched, the tool, the statusline and the hook.
   - A rest test terminates a Codex whose `node_repl` and code-mode host outlive it (own groups, tpgid = Codex). Both
     get SIGTERM, the stubborn host gets SIGKILL, and no window closes until the last is gone.
   - **Live check (optional), done on this Mac:**
     - Setup: a throwaway tmux server on a temp socket, Codex 0.155.1 in a `/tmp/archi-live-*` dir, no model turn.
       ARCHI_HOME, ARCHI_CHAR_ID and TMUX were unset.
     - The real `ps` showed `node_repl` (pgid 62203, tpgid = Codex's 62144) and `adlc mcp-server` (own group) under
       Codex, and `tree` found both. SIGTERM to the three groups left none alive.
     - `codex-code-mode-host` did not start without a turn.
     - Cleanup: the trust prompt was answered once, which added a `[projects."/private/tmp/archi-live-…"]` entry to
       `~/.codex/config.toml`. That file was restored byte-for-byte from a backup taken just before (diff checked
       first: the entry was the only difference). Codex's own shell snapshot and writer lock for that thread were
       removed.
     - No session rollout or state-DB thread or project row was created. Codex's own log, cache and `version.json`
       update check touched their usual files.
     - The temp dir and the tmux server are gone. `~/.archipelago` was not touched.
7. **Preflight without mutation.** Test `reports what would stop the move without writing, fencing, signalling or asking
   the gateway anything`:
   - it snapshots every file (size, mtime, mode) under the fleet home and under the work root before and after;
   - it checks that the store state is unchanged, that the world log (tmux or signal calls) is empty, that no gateway
     call was made, and that there is no journal and no fence.

   The only side effect is the agent probes. They run the CLIs' own read-only status commands (`--version`,
   `auth status` / `login status`), cached 60 s.

## Tests

- `test/handover/source.test.ts` (new, 24 tests):
  - preflight (5): no mutation; choices approve; identity; release, protocol, schema and agents; source CLI release;
  - freeze (11):
    - Begin record table (7 refusals plus standalone), each writing nothing;
    - fence, journal-first and manifest persistence, progress events;
    - repeated in process, concurrent join, and after a restart;
    - crash recovery with an orphan manifest;
    - blocked agent released, then frozen again;
    - Interrupt and carry, in two ways;
    - path blocker before rest;
    - post-rest blocker stays frozen, then Abort revives;
    - Abort cancels a waiting freeze;
    - refuses to freeze an aborting transaction;
  - abort (7): happy path with order and idempotence; refusal table (unreachable, still open, generation, committed);
    committed journal; standalone; crash between close and unfreeze; another transaction; revive failure keeps going;
  - probes and system.info (1).
- `processes.test.ts`: tree test on both fixtures.
- `rest.test.ts`: Codex helpers terminated; clamp.
- `gateway/server.test.ts`: `fleetAuthority` over the local socket (and nothing listening), and over ssh (argv and
  quoting, error frame, no frame, no route).
- Updated for the new params and output: `service.test.ts`, `api.test.ts`, `sessions.test.ts`, and protocol
  `messages.test.ts` / `handover.test.ts`.

Results:

```
$ pnpm vitest run --project archid test/handover/source.test.ts test/ownership.test.ts
 Test Files  2 passed (2)
      Tests  44 passed (44)
$ pnpm typecheck
 (clean)
$ pnpm vitest run --project archid --project protocol      # load avg ~8–24
 Test Files  74 passed | 1 skipped (75)
      Tests  1088 passed | 2 skipped (1090)
$ pnpm vitest run --project cli test/gateway.test.ts
      Tests  9 passed (9)
```

An earlier full run at load average ~36–44 failed three tests: the two known `fleet.test.ts` revive flakes and
`e2e.test.ts` "runs two turns against a fake claude and survives a tmux death" (17 s). All three passed alone, and the
final full run was clean.

## TDD evidence

RED, protocol (tests written first):

```
$ pnpm vitest run --project protocol
 × ownership and handover methods > says what a machine is and what it can run
 × ownership and handover methods > counts the transfer and lists what stops it, from the machines the controller describes
 × ownership and handover methods > freezes against a transaction and a generation and returns the manifest that names it
 × handover errors > names why the daemon refused
 Tests  4 failed | 102 passed (106)
```

RED, processes and rest:

```
$ pnpm vitest run --project archid test/handover/processes.test.ts test/handover/rest.test.ts
 × ps as 'macOS' prints it > reaches everything a job holding the terminal started, …   → table.tree is not a function
 × ps as 'Linux procps' prints it > reaches everything …                                 → table.tree is not a function
 × restTerminals > ends Codex's own-group helpers on the terminal with it …
   → expected [ 'keys %1 1b', 'SIGTERM 1001', …(1) ] to deeply equal [ 'keys %1 1b', 'SIGTERM 1001', …(3) ]
 × restTerminals > interrupts at the end of the wait when the chosen delay would outlast it → expected [] to deeply equal [ 'keys %1 1b' ]
 Tests  4 failed | 52 passed (56)
```

RED, source (before `source.ts` existed):

```
$ pnpm vitest run --project archid test/handover/source.test.ts
 → handover preflight is not implemented yet   (×5)
 → no handover: expected 'not_ready' to be 'transaction_mismatch'
 → handover freeze is not implemented yet / expected 'not_ready' to be 'blocked' / handover abort is not implemented yet …
 → agentProber is not a function
 Tests  23 failed (23)
```

RED, then GREEN, mid-rest supersede:

```
 × source freeze > takes Interrupt and carry asked while it waits on a working agent …
   → expected [ 'settle' ] to deeply equal [ 'settle', 'settle', 'keys %3 1b' ]
 → after the change: Tests 24 passed (24)
```

RED, gateway reach:

```
 × a fleet authority as its daemon reaches it > … → fleetAuthority is not a function   (×2)
 → after: Tests 10 passed (10)
```

GREEN is the results block above.

## Files changed

- `packages/archid/src/handover/source.ts` (new)
- `packages/archid/src/handover/service.ts`
- `packages/archid/src/handover/rest.ts`
- `packages/archid/src/handover/processes.ts`
- `packages/archid/src/handover/sessions/registry.ts`
- `packages/archid/src/gateway/client.ts`
- `packages/archid/src/api/methods.ts`
- `packages/archid/src/main.ts`
- `packages/archid/src/paths.ts`
- `packages/protocol/src/handover.ts`
- `packages/protocol/src/messages.ts`
- `packages/archid/test/handover/source.test.ts` (new)
- `packages/archid/test/handover/{processes,rest,service,sessions}.test.ts`
- `packages/archid/test/{api.test.ts,gateway/server.test.ts}`
- `packages/protocol/test/{handover,messages}.test.ts`

`inventory.ts` and `manifest.ts` are untouched, so Task 21's cherry-pick has no overlap there.

## Self-review findings (fixed before commit)

- A second Freeze with new choices joined the waiting one, so mid-rest Interrupt and carry took effect only after the
  wait ran out. It now supersedes the wait (new test).
- `HandoverMachines`' doc comment sat above the wrong declaration, and `runAgent` was exported with no user. Both fixed.
- `lastFrame` guards a non-object last line, because `'result' in 5` throws.

## Concerns

1. **Wire params go beyond the spec's sketch.** The spec's `handover.preflight { toMachineId }` and
   `handover.freeze { transactionId, generation, choices }` cannot build a manifest. A daemon knows neither machine's
   path roots (they live in the controller's registry), nor the destination's fleet home or agent homes and logins. So
   both calls take `HandoverMachines`, which Task 27 fills from the registry and the destination's `system.info`.
   Preflight also takes `choices`, so `--terminate-shells` and `--interrupt-after` stop reporting blockers they cover.
   All protocol changes are additive to this branch's PROTOCOL_VERSION 10; there was no bump.
2. **How the source daemon reaches the gateway.** The brief asks the source to prove authority and to refuse on
   unreachable, so the daemon holds an `Authority` port. The real implementation for a Mac source (gateway elsewhere)
   runs `archi gateway owner get` over plain `ssh -o BatchMode=yes`, using the registry's route. That is a new
   daemon-side ssh path: no ControlMaster, and it needs non-interactive auth from the daemon's own environment (launchd
   on the Mac). It was not exercised against linus-vault; only argv and parsing are unit-tested. If the controller would
   rather relay the gateway record in the params, only `fleetAuthority`/main.ts change; the port stays.
3. **Abort needs the gateway transaction closed first.** Source Abort refuses (`not_ready`) while the gateway still holds
   this transaction open, since `ready-to-commit` could still commit after an unfreeze. Task 27 must call `owner.abort`
   before `handover.abort`, which is the spec's order.
4. **A rest blocker leaves the gateway transaction open while the source runs normally.** This is safe: ready needs the
   destination's prepared digest, which needs a manifest this source never answered. The controller either calls
   Freeze again or aborts.
5. **Files beyond the plan's list:** rest.ts and processes.ts (obligations 2 and 6), registry.ts and methods.ts
   (obligation 5), client.ts, main.ts and paths.ts (wiring and the manifest path), and the protocol files.
6. **Not built:**
   - the character_pinned blocker (no "Keep on this machine" state field exists) and platform blockers, which no task
     brief has picked up;
   - Task 22's carried Codex trust-prompt warning, which is not in this task's obligations and fits Task 26's
     activation;
   - scrollback capture on freeze (the spec says "may").
7. **`system.info` cost.** The first call runs `claude --version`, `claude auth status`, `codex --version` and
   `codex login status` (up to 10 s each on a hang), then 60 s of cache. `daemonRuns` in setup polls `system.info`, so
   its first answer can be slower.

---

## Fix round 1

Commit: `1d6a6b6 A freeze finds what stops it before a window closes, reopens what it closed when it cannot finish, and checks platforms, kept characters and Git graphs`
(on fleet-handover-impl, parent 1ac6d5c)

### Changes, by item

1. **Source-path blockers are found before rest, and a blocker after rest reopens what the freeze closed.**
   - `manifest.ts` gains `manifestBlockers(inventory, sfs)`. It runs the manifest's own checks from names and existence
     alone:
     - every root is walked without reading a file (`scanPath`/`walk` take a `hash` flag);
     - each session is found by its adapter, and its files are lstat'ed but not read (`scanSession` takes `read`), so
       a transcript a working agent is mid-append to is never judged.
   - `buildManifest` and `manifestBlockers` share `scanRoots`, so a gone Git root, an unsupported name, a missing
     transcript and a missing destination agent home produce the same blockers in both.
   - Freeze runs `check()` plus `manifestBlockers` after the fence and before `restTerminals`. A blocker there releases
     the fleet with no window closed.
   - `refuse()` now always reopens exactly `stoppedTerminals`, then releases: the journal closes, then the unfreeze,
     activate and reconcile. No manifest was answered, so nothing can commit. This covers a blocker only visible after
     rest, for example session content changed while windows closed.
2. **Platforms and "Keep on this machine."**
   - Carried checkouts (`repo`/`worktree` roots) are read for `.archipelago/handover.json`, shaped
     `{ "platforms": [...] }`. A list without the destination's platform, or a file that cannot be read or parsed, is a
     `platform_unsupported` blocker naming the file. This runs in `check()`, so in both preflight and freeze.
   - Preflight warns `platform_heuristic` for any carried root holding a `*.xcodeproj` or `*.xcworkspace` when the
     destination is not darwin. It is a warning, never a blocker.
   - `Character.keepHere: z.literal(true).optional()` is additive, with no schema bump. `char.update` takes
     `keepHere: boolean` (true sets it, false removes it) through `Fleet.updateCharacter`. `check()` emits
     `character_pinned` naming the character.
3. **`mayTakeBack` refuses on any open transaction from this machine past preparing** (`not_ready`), besides its own.
4. **Task 21's `discoverGit` is wired.**
   - Both of the source's inventory builds go through `inventory(state, p)`:
     `discoverGit(state, { excludes: expandExcludes(fleet.handover).excludes, git: deps.git })` → `buildInventory(..., git)`.
   - That covers preflight, the pre-rest check, and the post-rest manifest (re-read on the rested state).
   - `SourceDeps.git` is injectable.

### Tests

`source.test.ts`, 28 tests:

- New:
  - `blocks a character kept on this machine`
  - `blocks a repository that names the platforms it runs on without the destination, and warns of an Xcode project`
    (real git: darwin-only file → blocker; darwin destination → neither; invalid file → blocker naming it; both
    platforms → none)
  - `carries the graph of a repository a character stands in` (real git: `manifest.git[0].main.path` is the repo,
    characters `['c_bo']`, root kind `repo`)
  - `finds a name it cannot carry, a transcript that is gone or a character kept here before it touches a terminal`
    (world log is only `settle, activate, reconcile`)
- Rewritten: `reopens exactly the terminals it stopped and lets the fleet run again when a blocker turns up only after
  windows closed` (the transcript is removed as windows close; log shows the three kills, then `ensure-server`,
  `revive c_ada`, `second c_ada`, `revive c_bo`, `activate`, `reconcile`; owner.json unfrozen; journal and manifest gone)
- Added to the abort refusal table: `another handover from here past preparing`.
- Test harness:
  - the work root is its real path, because git answers in real paths;
  - `git` defaults to an injected "not a repository" runner, and two tests opt into real git;
  - the two Interrupt-and-carry timing tests wait on the condition instead of a fixed number of ticks, since the
    pre-rest pass now does real filesystem reads before the rest starts. Three consecutive runs were green.

Also:

- `map.test.ts`: `char.update keeps a character on this machine, and lets it go again`.
- `protocol/messages.test.ts`: `char.update keeps a character on this machine or lets it go, and a character says which`.

### RED

```
$ pnpm vitest run --project archid --project protocol test/handover/source.test.ts test/map.test.ts test/messages.test.ts
 × messages > char.update keeps a character on this machine or lets it go … → expected { id: 'c' } to deeply equal { id: 'c', keepHere: true }
 × Fleet layout > char.update keeps a character on this machine, and lets it go again → expected undefined to be true
 × source preflight > blocks a character kept on this machine → expected [] to deeply equal [ { code: 'character_pinned', …(2) } ]
 × source preflight > blocks a repository that names the platforms … → expected [] to deeply equal [ [ 'platform_unsupported', …(1) ] ]
 × source freeze > carries the graph of a repository a character stands in → expected [] to deeply equal [ { …(2) } ]
 × source freeze > finds a name it cannot carry, a transcript that is gone or a character kept here …
   → expected [ 'path_unsupported', …(1) ] to deeply equal [ 'character_pinned', …(2) ]
 × source freeze > reopens exactly the terminals it stopped … → expected [ 'settle', 'detach c_ada', …(4) ] to deeply equal [ 'settle', 'detach c_ada', …(10) ]
 × source abort > stays frozen while the gateway cannot be asked, … → the call succeeded
 Tests  8 failed | 61 passed (69)
```

### GREEN

```
$ pnpm vitest run --project archid test/handover/source.test.ts test/ownership.test.ts test/map.test.ts \
    test/handover/manifest.test.ts test/handover/replicas.test.ts test/handover/inventory.test.ts
 Test Files  6 passed (6)
      Tests  139 passed (139)
$ pnpm vitest run --project protocol
      Tests  110 passed (110)
$ pnpm typecheck
 (clean)
$ pnpm vitest run --project archid --project protocol     # load ~7–17
      Tests  2 failed | 1142 passed | 3 skipped (1147)     # the two known fleet.test revive flakes
$ pnpm vitest run --project archid test/fleet.test.ts
      Tests  37 passed (37)
```

### Notes

- **Real paths and path roots (Task 21's inventory).** `discoverGit` reports real paths. `buildInventory` locates graph
  paths lexically against the path roots, so a root declared through a symlink (such as `/tmp`, which is
  `/private/tmp` on macOS) blocks every repository under it with `path_root_missing`. Home-based roots are unaffected.
  I left it alone, since it is outside this task; the source tests use a real-path work root.
- **Unreadable files in the names pass.** The pass does not open files, so an unreadable file inside a root is still
  found only by the hashing build after rest. That path now reopens the terminals and releases, as the ruling allows.
