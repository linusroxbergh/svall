# M3 on-machine fix wave, O1–O11: report

Status: **DONE_WITH_CONCERNS**. The concerns are listed at the end. None of them stops the on-machine re-run.

Branch `fleet-handover-impl`. The wave runs from 17a8a0c6 to 888c6369: 11 commits, 41 files, +1331/−142. No commit carries attribution.

All test commands were run from the worktree root with `unset ARCHI_HOME ARCHI_CHAR_ID TMUX`. Everything ran against temp homes. Nothing touched the live fleet, `~/.ssh`, `/Applications`, LaunchAgents or linus-vault.

## Commits

| SHA | Items | Subject |
| --- | --- | --- |
| 28260765 | O11 | Host enable marks the machine it names a gateway in the registry |
| ffcec29a | O2 | A link whose only itemized difference is its mode verifies, since a Linux link cannot take the Mac's |
| 0b796521 | O9 | An abort on a destination that journaled nothing still removes the sessions the transfer staged for it, once the gateway has let the handover go |
| 3aedea2e | O3 | A root the user chose to archive is a preflight notice, not a blocker, and counts whole against the destination's room |
| e7c06e36 | O10 | Doctor on Linux looks for the agent CLIs on the PATH the fleet's unit runs with, where the daemon finds them |
| 18f49f37 | O8 | Git repair sets core.ignorecase and core.precomposeunicode to what git init would probe on the destination, and leaves the rest of the config as it came |
| ebf2af6b | O1 | Host enable gives the gateway machine its copy of each fleet it enables, and a handover to a machine running another fleet stops at once and names host enable |
| 3f71c84c | O4 | A destination root no handover left that already holds exactly what the handover brings is a replica of that content, proven again at claim |
| 45c7519b | O5, O7 | A carried session lands under the real path of the cwd its agent resumes in, and its records move from either spelling of a source root to the spelling the destination's agent records |
| 4451ebf7 | O6 | A worktree no character uses keeps its registration on the machine it stays on through a handover away and back, and one whose commit nothing coming back holds stops preflight |
| 888c6369 | O5, O6 review | A session no adapter here reads keeps the manifest's place for install to refuse, and a received graph names its common directory by an absolute path |

## Per item

### O1 (Critical): host enable provisions the far copy; a fleet-id mismatch is not transient

**Changed**

- **The companion's side.** New `packages/archid/src/linux/provision.ts` holds `provisionFleet()`, which handles three cases:
  - **Absent home**, meaning no fleet.json, config.json, state.json, owner.json or journal. It creates the home (0700), writes fleet.json with the fleet id and `gatewayMachineId`, and runs `setupFleetHome` (port 0 for a non-private profile, as on the Mac). It then writes `archipelago-archid@<profile>.service` and runs `enable --now`. It writes no owner.json.
  - **Same id.** Nothing is written and systemctl is not run.
  - **Another id.** It re-keys only when the home is pristine: no journal, an owner.json that is readable with no transaction and generation 0, and a state.json with no characters. The unit is ensured with a daemon-reload only if it changed. Then `stop`, then fleet.json is rewritten (id and gateway, other fields kept), owner.json is removed, and `enable --now` runs. Otherwise it throws `ProvisionRefused`, naming the far home, the fleet it holds, and why.
  - `service.ts` gains `stopUnit`, and the archid package exports `./linux/provision`.
- **The companion's command.** New `packages/cli/src/commands/fleet-provision.ts`: `archi [-p profile] fleet provision --id <fleet> --gateway <machine> [--json]`.
  - It is Linux-only and needs a profile home. It validates both ids and passes `tmux -V` to setup.
  - It is wired into `fleetCommands`, which now also takes `target`, and into `main.ts`.
- **The controller.** In `host.ts`, `enableHost` runs `provisionCopy()` over the master. The argv is shell-quoted words only: `<archi> -p <profile> fleet provision --id … --gateway <entry.id> --json`, with a 120 s timeout. The profile is `profileOf(fleetHome)`.
  - This runs inside the existing `fleet` step, before fleet.json is written. The app's host checklist has no row for a new step name, so no web change was needed.
  - A refusal fails the step with the far message. The action is to ssh there, move the far fleet home aside, and run `archi host enable <name> --fleet <profile>` again. fleet.json and the registry are left untouched.
  - The order is now: authority record first, then the far copy, then local fleet.json. A re-keyed daemon starts and finds the gateway's record.
- **Not transient.** `connection.ts` adds `FleetMismatch`, an `SshError` of kind `other`. `remoteConnectionInfo` throws it on a fleet-id mismatch. The message ends: `` `archi host enable <machine> --fleet <profile|private>` gives it a copy of this one``.
  - In `handover.ts`, `transient()` excludes it, so it is never retried.
  - `start()` turns it into a `blocked` result at `begin`, with an `identity_mismatch` blocker carrying that message. A mismatch in a later phase lands in the interrupted result's error, with the same hint.

**Tests**

- `packages/archid/test/linux-provision.test.ts` (new):
  - fresh home: created and started, calls `[daemon-reload, enable --now]`;
  - same id: files byte-identical, no systemctl call;
  - pristine other id: re-keyed, owner.json gone, state kept, calls `[daemon-reload, stop, enable --now]`, and fleet.json still held the old id when the unit was stopped;
  - four used homes (one character, generation 2, a transaction, a journal): each refused naming home and reason, nothing changed, no systemctl call.
- `packages/cli/test/host.test.ts`:
  - enable sends the exact provision argv with `-p work` and reports the far home;
  - a refused provision leaves fleet.json and the registry alone, with the action naming the ssh destination;
  - the existing enable tests now answer `fleet provision`.
- `packages/cli/test/controller/connection.test.ts`: the mismatch is a `FleetMismatch` naming `archi host enable trift --fleet work|private`.
- `packages/cli/test/controller/handover.test.ts`: a destination whose companion runs another fleet blocks at once with that message. `system.info` is asked once, no `handover.retry` is emitted, and no Begin is sent.
- `packages/cli/test/fleet-provision.test.ts` (new) covers id validation, Linux only, and profile home only. It was written together with the command; see the concerns.

**RED**

- `pnpm vitest run --project archid packages/archid/test/linux-provision.test.ts`
  - `FAIL test/linux-provision.test.ts: Error: Failed to load url ../src/linux/provision.js … Does the file exist?`
- `pnpm vitest run --project cli packages/cli/test/host.test.ts -t "host enable"`
  - `× host enable > gives the machine its copy of the fleet under the profile the controller reaches it by, before it names the gateway`
  - `× host enable > names the far fleet home that holds another fleet in use, and leaves fleet.json and the registry alone`
- `pnpm vitest run --project cli packages/cli/test/controller/connection.test.ts packages/cli/test/controller/handover.test.ts -t "host enable"`
  - `× preflight > blocks at once, naming host enable, … and asks it only once → expected { status: 'interrupted', …(3) } to deeply equal { status: 'blocked', …(2) }`
  - `× remote connections > names host enable as the way on … → The instanceof assertion needs a constructor but undefined was given.`

**GREEN**

- linux-provision: 4 passed.
- host enable: 10 passed.
- connection and handover: 106 passed.
- fleet-provision: 3 passed.

### O2 (Critical): a link's mode-only itemization is not a change

**Changed**

- `rsync.ts` adds `linkModeOnly(change)`, which matches `^\.L[. ]{3}p[. ]{5}$`, exactly `.L...p.....`.
- `transfer.ts` `compare()`, the verification dry run and the only place an item line is read as a difference, skips those lines.
- Changes to a link's content or target (`c`), its times (`t`) or its type still count.

**Tests** in `packages/cli/test/controller/transfer.test.ts`:

- a link whose only dry-run item is `.L...p..... link -> a.txt` verifies in 1 pass;
- `cLc.t...... link`, `.L..tp..... link` and `>f.st...... a.txt` still end `external_writer`.

**RED**: `pnpm vitest run --project cli packages/cli/test/controller/transfer.test.ts -t "link"`

- `× verifies a link whose only difference the compare itemizes is its mode, which Linux cannot set on a link → expected [ { id: 'r_app', …(2) } ] to match object`, which was blocked `external_writer`.

**GREEN**: `transfer.test.ts` and `rsync.test.ts`: 52 passed, 1 skipped.

### O3 (Important): `--archive <root>` clears the preflight blocker it is offered for

**Changed**

- `ARCHIVABLE` moved into `replicas.ts` and is exported. `destination.ts` now imports it.
- `handover.ts` `destinationChecks` now takes the choices. A root that meets both conditions below becomes a notice (warning) instead of a blocker:
  - its inspect check is refused with an archivable code;
  - `archiveRoots` names it by id, claimed path or manifest destination path.
- The notice keeps the code and entity, with the message `<path> is archived when the handover claims it: <original>`. The root also counts whole against the destination's room.
- Claim still archives it, as it did before.
- The interactive Archive answer re-runs preflight with `archiveRoots`, so it now clears too.

**Test**: `handover.test.ts` › `takes a root the user chose to archive as a notice, counting all it brings against the room, and archives it at claim`

- Without the choice there is a `destination_diverged` blocker.
- With it:
  - the notice warning appears and the room blocker is now counted;
  - with room, the run completes and claim archives the root.

**RED**: `… handover.test.ts -t "chose to archive"`

- `→ expected [ 'destination_diverged' ] to deeply equal [ 'destination_no_space' ]`

**GREEN**

- `handover.test.ts`: 54 passed.
- `destination.test.ts` and `replicas.test.ts`: 73 passed.

### O4 (Important): a destination root holding exactly the incoming content is not occupied

**Changed**

- `replicas.ts` adds `contentDigest(files)`: the canonical sha256 over sorted `[path, type, size, sha256 | target]`. Modes are not part of it, as the ruling lists.
- In `ReplicaStore.assess`, a root that exists with no record is scanned under the root's excludes when a content digest is given. If it is readable and equal, it is `{ kind: 'replica', found }`. Otherwise it is occupied, as before.
- `inspect` takes the digest from the caller. `claim` computes it from the final manifest's incoming files, so claim re-proves the equality. The claim records a `receiving` record whose baseline is the found content, and only then can `--delete` touch the root. If the root is no longer equal at claim, it is refused as `destination_occupied` before anything is written.
- Protocol: `handover.inspect` params `roots[].content: Sha256` (optional).
- The controller sends `contentDigest(manifest root files)` for each carried root. The destination's inspect passes it through.

**Tests**

- `replicas.test.ts`:
  - The old test `is refused … even as a copy of the same repository` encoded the rule O4 reverses. It is rewritten to cover what is still refused: an extra file, changed bytes, a missing file, and a file replaced by a link.
  - New: an exact copy of a mission-control folder, with a different cache under an excluded path and a different mode, is a replica at inspect. It is occupied without a digest, refused at claim once edited after preflight, and claimed as a replica once equal again, with the baseline recorded.
- `destination.test.ts` › `a destination root that already holds what the handover brings`:
  - passes preflight and is claimed as a replica;
  - is refused at claim, before anything is written, once changed after preflight.
- `handover.test.ts` › `tells the destination what each root brings…`

**RED**

- `replicas.test.ts -t "an existing root"`: 2× `TypeError: contentDigest is not a function`.
- `destination.test.ts -t "already holds"`:
  - `→ expected { ok: false, …(2) } to deeply equal { ok: true, …(2) }`
  - `→ expected { ok: false, …(2) } to match object { ok: true, kind: 'replica' }`
- `handover.test.ts -t "what each root brings"`: `→ expected [ [ 'r_app', undefined ], …(1) ] to deeply equal [ Array(2) ]`

**GREEN**

- destination and replicas: 76 passed.
- cli `handover.test.ts`: 56 passed.
- protocol: 114 passed.

### O5 and O7 (Important and Minor): sessions under a root declared through a symlink

**Changed**

- **Manifest.** `TransferManifestV1.sourceRealRoots` is new and optional. The source puts in it the real path of each of its roots that is declared through a link (`realRoots()` in `portable-path.ts`, which skips roots that are absent).
  - The inventory computes it and `buildManifest` carries it.
  - It is classified LOCAL in `PATH_FIELDS`.
- **Map (O7).** `sessionPathMap` pairs both the declared and the real spelling of each source root.
  - It maps onto the destination's real spelling (`destinationRealRoots`), which is what the agent there records. `installSession` computes that with `realRoots(destinationRoots)`.
  - The stale-field check in `records.ts` (`Walk.stays`) reads through `map.declared`, the same map with declared targets. The source's validation and the destination's rewrite therefore agree on what is stale, even when only the destination spelling differs.
- **Placement (O5).** New `placeSessions(sessions, importedState)` in `registry.ts` computes each transcript's place on the destination during prepare, after the roots land. For Claude that is the adapter's slug of `realPath(cwd)`. Codex places by date, so its place does not change.
  - `runPrepare` uses these sessions for `sessionProblems`, `placeTranscripts` (the state's transcriptPath) and `installSession`.
  - If a transcript with the same session id is already at the target, it is superseded only when it is a prefix of the carried one. This is the existing rule in `installSession`. Anything else is `destination_diverged` and blocks before Commit.
  - Carried Codex records move through the same two-spelling map.
- **Review fix.** If `placeSessions` finds no adapter for a session, it leaves the session's place unchanged, so `installSession` reports that as a blocker rather than throwing outside it.

**Tests**

- `sessions.test.ts` › `a session under a path root declared through a link`:
  - **Round trip.** The Mac `work` root is a link to `m3w`, with a transcript under `slug(m3w/gamma)` holding 2 records.
    - Mac → Linux: `sourceRealRoots` is `{ work: …/m3w }`. The transcript is placed under `slug(linux cwd)`, and every record's cwd is the Linux cwd.
    - 2 Linux turns are then added.
    - Linux → Mac: the transcript is placed at the Mac's original real-slug path. The Mac's copy is a byte prefix and is superseded. There are 4 records, all with the real Mac cwd, in order one, two, three, four.
  - A unit test for the two-spelling map onto the real destination spelling.
- `destination.test.ts` › `places a transcript under the real path of its cwd when this machine declares the root through a link…`. This covers the wiring through `DestinationHandover.prepare`: the state's transcriptPath and the placed records.

**RED**

- As written: `sessions.test.ts -t "declared through a link"`:
  - `TypeError: placeSessions is not a function…`
  - `→ expected '/home/t/code/app' to be '/data/code/app'`
- The same round trip run against today's placement, using the manifest's own sessions, reproduces defect 7:
  - `- "/private/tmp/archi-s-GKqydE/linux/home/code/gamma" ×2`
  - `+ "/private/tmp/archi-s-GKqydE/m3w/gamma" ×2`
- `destination.test.ts -t "real path of its cwd"`: `→ expected { id: 'c_bo', … } to match object { …(2) }`

**GREEN**

- archid `handover/`: 17 files, 413 passed, 3 skipped.
- protocol passes.

### O6 (Important): an unused registered worktree survives a round trip on the machine it stays on

**Changed**

- **Source.** `readGraph` records `GitGraph.tips`: every `for-each-ref` object. It is optional in the protocol and listed in `NOT_PATHS`.
- **`git-repair.ts`:**
  - `graphsHere(manifest)` returns a `ReceivedGraph` for each graph: the mapped common dir, the carried registration names, and tips (refs, carried HEADs and stash). The protocol type requires an absolute `commonDir`.
  - `keptWorktrees(g)` returns each registration in the destination's own `<common>/worktrees` that the manifest does not carry and whose worktree exists here.
    - It also returns a `worktree_unused` blocker, naming the worktree and its short commit, whenever `HEAD^{commit}` is not reached by a tip. Reachability is `tips.includes(C)` or `git rev-list --ignore-missing -n 1 C --not <tips…>` returning nothing, in batches of 500, argv only.
  - `repairGraph` and `repairGraphs` take `kept` names and do not prune them.
  - `validateGraph` accepts a listed worktree whose gitfile points at a kept registration.
- **`replicas.ts`:**
  - Claim and inspect take `keep` (root-relative folders). Every proof ignores them: `proveReplica` now filters the accepted versions as well as the scan.
  - The `receiving` record stores `kept`. A resumed claim uses the recorded list.
  - The ok check returns `keep`. New `keptBy(root, tx)`.
- **`destination.ts`:**
  - `inspect` takes `git: ReceivedGraph[]` and returns `blockers` (preflight).
  - `claim` computes the kept registrations from the manifest's graphs. A root holding a graph whose kept commit is lost is refused with that blocker, before anything is written. Otherwise it passes `keep` to the replica claim and returns it on the `RootClaim`.
  - `prepare` reads `keptBy`, ignores kept paths in `landedProblem`, and passes the kept names to `repairGraphs`.
- **Protocol.** `RootClaim.keep`, inspect params `git`, inspect result `blockers`, `ReceivedGraph` and `GitGraph.tips`. All are optional.
- **Controller:**
  - `rsync.ts` `filterRules(excludes, kind, keep)` puts `- /<keep>/` rules first, ahead of the Git keep rules, so rsync neither sends nor deletes them. A kept path that is not plain is refused.
  - `transfer.ts` drops kept paths from `expected`, ignores them in every scan (so landed never includes them), and adds them to the resume key.
  - `handover.ts` sends `graphsHere(m)` to inspect, merges its blockers, and carries each claim's `keep` into the transfer entries.
  - The archid package exports `./handover/git-repair`.

**Tests**

- `git-repair.test.ts` (real git):
  - `keeps a worktree no character uses registered on the machine it stays on, through a handover away and back`: fixture there, back with a `--delete` mirror that keeps the kept folder, then repair. `git -C <unused> status --porcelain=v2 --branch` and HEAD are equal to before, and it is listed.
  - `blocks … when nothing the handover brings back holds its commit`: a unique commit on `unused-branch`, with that branch deleted on the other machine.
- `destination.test.ts` (real git, through the daemon):
  - `keeps a worktree … the machine the fleet comes back to`: a full return trip. The source sealed as the copy it left behind. inspect with `git` gives no blockers and a replica. claim returns `keep: ['.git/worktrees/unused']`. After the mirror and prepare, status and HEAD are unchanged and the worktree is listed.
  - `refuses, at preflight and at claim, a graph whose worktree that stays here holds a commit nothing coming back reaches`: an inspect blocker, a claim root refused with the same blocker, and the replica record unchanged.
- `transfer.test.ts`:
  - scripted: kept paths are out of landed files and the filter file equals `filterRules(…, keep)`, with the first line `- /.git/worktrees/stay/`; a kept `../escape` is refused;
  - real rsync over the fake ssh: `--delete` removes stale files and keeps `.git/worktrees/stay/` byte for byte.
- `handover.test.ts`: inspect receives the graphs and its blockers block preflight; the claim's `keep` reaches the transfer entries.

**RED**

- A throwaway test on today's code (trip, return mirror, repair) reproduced the defect: `Command failed: git … status … fatal: not a git repository: (null)`.
- `git-repair.test.ts -t "stays on"`: 2× `TypeError: graphsHere is not a function…`
- `destination.test.ts -t "no character uses|nothing coming back"`:
  - `→ expected { id: 'r_b02306b38155cfa8', …(2) } to match object { check: { ok: true }, …(1) }`, because the claim returned no `keep`;
  - `→ expected undefined to deeply equal [ ObjectContaining{…} ]`.
- `transfer.test.ts -t "keep"`:
  - `→ expected [ { id: 'r_app', …(3) } ] to match object`
  - real rsync: `ENOENT … .git/worktrees/stay/HEAD`, deleted by `--delete`.
- `handover.test.ts -t "graphs it receives|each claim keeps"`: `→ expected undefined to deeply equal …` (×2).

**GREEN**

- `git-repair.test.ts`: 17 passed, 1 skipped.
- destination: all passed.
- transfer and rsync: 54 passed, 1 skipped.
- cli handover: 58 passed.
- archid `handover/`: 417 passed, 3 skipped.
- cli `controller/`: 265 passed, 2 skipped.

### O8 (Minor): case and Unicode git config follow the destination filesystem

**Changed**

- In `git-repair.ts`, `probeFsRules(dir)` reads what `git init` would:
  - `ignoreCase`: `<gitdir>/CoNfIg` exists;
  - on darwin only, `precomposeUnicode`: a composed-name probe file found by its decomposed name. The file has a random name and is removed.
- `adaptRules` runs inside `repairGraph`, after the checks and before any write, for each carried common dir that holds a config. It reads each key with `git config --file <config> --type=bool --get` and writes with `git config --file <config> <key> <bool>` only where the value differs.
- A key git init would not write (ignorecase false, or precomposeunicode on Linux) is left out where it is absent. Every other byte is left as it came.
- The probe can be injected through `RepairDeps.probe`.

**Test**: `git-repair.test.ts` › `sets the case and Unicode rules git reads to the destination filesystem's, and leaves the rest of the config byte for byte`

- On a Linux probe, the main config equals the original with only those two lines flipped to false.
- On a Mac probe, both configs, including the submodule's, return byte-identical to the original.

**RED**: `… -t "case and Unicode"` → `expected '[core]\n\trepositoryformatversion = 0…' to be …`, so the values were unchanged.

**GREEN**

- `git-repair.test.ts`: 15 passed, 1 skipped.
- destination, worktree-portability and git-graph: 66 passed.

### O9 (Minor): an abort without a destination journal drops that transaction's session stage

**Changed**

- `service.ts` `abort`: when this machine is not receiving that transaction and is not the owner, it first calls `destination.dropStage(tx)`.
- `destination.ts` `dropStage` removes only `handover/sessions-<tx>`, and only when:
  - no journal of that transaction is open here;
  - the gateway answers and no longer holds that transaction.
- The abort's answer is unchanged (`not_owner`), which the controller already expects.

**Test**: `destination.test.ts` › `drops the session stage of a handover it never prepared once the gateway lets it go, and nothing else`

- While the gateway still holds the handover, the stage stays.
- After the gateway lets it go, the stage is gone.
- Another transaction's stage, every root's tree and every replica record are unchanged.

**RED**: `… -t "drops the session stage"` → `expected true to be false`

**GREEN**: destination and service: 83 passed.

### O10 (Minor): doctor checks agents with the unit's PATH

**Changed**

- `linux/setup.ts` exports `unitPath(o)`. It was the private `pathEnv`, the PATH written into the units.
- In `doctor.ts`:
  - `run(cmd, args, { path })` runs with that PATH when given.
  - `PreflightDeps.agentPath` is the unit PATH on Linux, `realPreflightDeps(platform)`. It is built from the installed release, or the checkout in development.
  - The claude check and `codexCheck` use it.
- `host doctor` reads the companion's doctor, so it now matches what the daemon sees. The shims check still reads the shell's PATH, which is what it is about.

**Tests** in `doctor.test.ts`:

- On Linux, with `claude` missing from the shell PATH and found on the unit PATH, claude and codex are ok.
- `realPreflightDeps('linux').agentPath` equals the PATH line of the unit `archidUnit()` renders, and is undefined on darwin.

**RED**

- `→ expected {claude warn} to match object { status: 'ok', …}`
- `→ expected undefined to be '/opt/homebrew/Cellar/node/26.9.0/bin:…'`

**GREEN**: doctor and setup: 20 passed; linux-setup: 23 passed.

### O11 (Minor): host list shows the gateway

**Changed**: `MachineRegistry.markGateway(id)`. The `fleet` step of `enableHost` calls it and saves the registry.

**Test**: `host.test.ts` › `marks the machine a gateway in the registry`

**RED**: `expected undefined to be true`

**GREEN**: host and registry: 59 passed, 1 skipped.

## Files changed

**Source:**

- `packages/archid/package.json` (exports `./linux/provision` and `./handover/git-repair`)
- `packages/archid/src/linux/{provision.ts (new), service.ts, setup.ts}`
- `packages/archid/src/handover/{destination, divergence, git-graph, git-repair, inventory, manifest, portable-path, replicas, service, validate}.ts`
- `packages/archid/src/handover/sessions/{records, registry, types}.ts`
- `packages/cli/src/commands/{doctor.ts, fleet-provision.ts (new), fleet-recover.ts}`
- `packages/cli/src/main.ts`
- `packages/cli/src/controller/{connection, handover, host, registry, rsync, transfer}.ts`
- `packages/protocol/src/{handover, messages}.ts`

**Tests:**

- `packages/archid/test/linux-provision.test.ts` (new)
- `packages/archid/test/handover/{destination, git-graph, git-repair, replicas, sessions}.test.ts`
- `packages/cli/test/fleet-provision.test.ts` (new)
- `packages/cli/test/{doctor, host}.test.ts`
- `packages/cli/test/controller/{connection, handover, transfer}.test.ts`

## Final suite results at 888c6369

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm vitest run --project protocol` | 8 files, 114 passed |
| `pnpm vitest run --project cli` | 29 files, 483 passed, 3 skipped |
| `pnpm vitest run --project archid` | 70 files passed and 1 skipped; 1145 tests passed and 3 skipped |

No known flake fired. Web, Playwright and Swift were not touched and not run.

## Self-review findings, fixed in 888c6369

- `placeSessions` called `sessionAdapter()` unguarded, before prepare's blocker path. A session with an unknown adapter would have thrown out of prepare instead of blocking. It now keeps the manifest's place, and `installSession` refuses it as before.
- `ReceivedGraph.commonDir` was any string, and the destination joins and reads under it. It is now the protocol's `MachinePath`: absolute, with no NUL, newline or `..`.
- Import order in `controller/handover.ts` was tidied.

## Concerns

1. **O10 scope.** Only the companion's doctor, and so `host doctor`, uses the unit PATH. `host add`'s own claude and codex steps (`agentChecks` in `host.ts`) still probe over the ssh login shell. After a user installs Claude into `~/.local/bin`, a re-run of `host add` would still say "not installed". The ruling named doctor only; this is the same defect in a sibling path.
2. **O6: blocker text that no longer holds.** The source-side blocker for a dirty unused worktree (`git-graph.ts` `unusedWork`) says "a handover back would leave [it] without [its] registration". With O6 that is no longer true, since the registration stays on its machine. I left the blocker and its text as they are, because the ruling did not cover them. It could now become a warning.
3. **O6: the reachability check is conservative.** A kept worktree's commit counts as held only if it is equal to, or an ancestor of, a ref, HEAD or stash the source sends, judged with the destination's own objects. A commit reachable only from a source commit the destination has never seen is reported as a blocker. A kept worktree whose branch the source moved on is not blocked: its HEAD moves with the returning ref, and git status there shows the difference. Neither case is covered by the ruling.
4. **O6: name clash.** If the source holds an unused registration with the same name as one the destination keeps, the source's copy is never sent. The source's Complete seal (from landed) then lacks those files, so a later claim on that source would read them as added. This is rare, and I did not handle it.
5. **O1: failure action.** The `fleet` step's action for any failed provision says to move the far fleet home aside. That also shows for failures that are not refusals, such as a far companion too old to have `fleet provision`, which needs `host upgrade`.
6. **Wire additions.** These fields are new, all optional:
   - `roots[].content`, `git` and `blockers` on `handover.inspect`;
   - `RootClaim.keep`;
   - `TransferManifestV1.sourceRealRoots`;
   - `GitGraph.tips`.

   PROTOCOL_VERSION stays at 10, since all components run from one checkout during development (delivery rule). The release gate should decide whether this counts as "the new wire surface".
7. **`fleet-provision.test.ts`.** The command and its tests were written together, so there is no separate RED for those three guards. The behaviour behind them (`provisionFleet`, enable) had its RED first.
8. **What the unit tests cannot show.** Some things can only be proven on the machines:
   - that a re-keyed far fleet takes the gateway's record at restart, and the systemd behaviour over a non-login ssh (`enable --now` and `stop` for `archipelago-archid@<profile>`);
   - the real Mac → Linux symlink mode case (`.L...p.....` came from the A report's own rsync run);
   - Linux git's handling of the kept registration.

   The on-machine re-run should repeat 6a (no hand steps D1–D4), 6c (links left at 0755), 6e (git config), 7 (`beta-unused` status), 8 (gamma-main keeps all its records) and an aborted Transfer (stage removed).

---

# Fix round 1

This round fixes the three binding findings in `m3-onmachine-fixes-fix1-findings.md`. Status: **DONE**.

## Commits

| SHA | Finding | Subject |
| --- | --- | --- |
| af0c004f | 2 | Fleet provision brings a home that already holds the fleet to a running unit, and host enable tells a refusal from any other failure |
| 45d0e8aa | 1, 3 | The source decides whether it reaches a kept worktree's commit the destination cannot prove comes back, and a graph's tips are full object names |

Findings 1 and 3 share one commit because both change the same protocol schemas.

## 1. O6 no longer blocks a kept commit that does come back

**Changed**

- **The destination only proves, never blocks.** `keptWorktrees` (git-repair.ts) no longer returns blockers. A kept HEAD commit the destination can prove comes back (it is one of the tips, or its own objects show a tip reaches it) is fine, as before. Any other kept commit is returned as `unproven: KeptCommit[]` (`{ graph, path, commit }`). Tips the destination has never seen can no longer turn into a false loss.
- **The source judges.** New `unreached(commonDir, commits, git)` runs `git rev-list -n 1 <commit> --not --all --` in the source's common directory, once per commit. It returns each commit no ref reaches, including one the source does not hold at all.
  - Served by the new RPC `handover.reaches`: params `{ commits: CommitAt[] }`, result `{ unreached: CommitAt[] }`.
  - `HandoverService.reaches` (service.ts) answers it with the source's git runner, frozen or not.
  - Routed in `api/methods.ts`. Classified `transaction` in the guard, so only the token-holding controller can ask it.
  - Gets the preflight time budget in `serverWait`.
- **The destination reports what it could not prove.** The `handover.inspect` result carries `unproven` in place of last round's `blockers`, and the `handover.claim` result now carries `unproven` too. The destination no longer refuses a root over a kept commit; it claims the root with its `keep` as before.
- **Controller** (`handover.ts`): new `lostCommits()`.
  - It asks the source's daemon about each unproven commit, using the source's own common dir from the manifest's graph.
  - It blocks only on what the source cannot reach.
  - It runs at preflight (inspect) and again at claim (before any rsync), where a loss goes to the user as a decision with the other refused roots.
  - If the source refuses the RPC, every asked commit counts as lost and the message says why.
- **New message:** `<path> is a worktree no character uses that stays on <destination>, at <commit>, which nothing <source> sends back reaches, so the copy that comes back would not hold that commit; put it on a branch on <source>, or remove this worktree on <destination>`.

**Tests**

- `packages/archid/test/handover/git-repair.test.ts`, real git:
  - The existing round trip still has nothing unproven (the commit is reachable from main).
  - New: the branch of the worktree that stays moves on, on the other side, to a commit this side has never seen. The commit is unproven here, the source's `unreached` answers `[]`, and after the mirror and repair the worktree's status is clean.
  - New: the branch is dropped on the other side. The commit is unproven, and `unreached` answers both it and a commit the source never had.
- `packages/archid/test/handover/destination.test.ts`: the round trip has no unproven commit. A dropped-branch commit is named in inspect's and claim's `unproven`, and the claim still takes the root with `keep`.
- `packages/archid/test/handover/service.test.ts`: `handover.reaches`, frozen, against a real repository: a reached commit, a loose commit and an unknown one.
- `packages/cli/test/controller/handover.test.ts`, at preflight and again at claim:
  - The source is asked by its own common dir.
  - An unreached commit blocks (at preflight with the new message; at claim through a decision, with no transfer, and the fleet stays on the source).
  - A reached commit passes (preflight has no blockers; the whole run completes).
- `packages/protocol/test/messages.test.ts`: `handover.reaches` is in the method list.

**RED:** new `-t` runs of the tests above, before the fix.

- `git-repair.test.ts -t "source|stays on"`:
  - `→ expected undefined to deeply equal []`
  - `→ expected undefined to deeply equal [ { …(3) } ]`
  - `→ Cannot read properties of undefined (reading 'map')`
- `destination.test.ts -t "no character uses|cannot prove"`: `→ expected undefined to deeply equal [ { …(3) } ]`
- `service.test.ts -t "refs do not reach"`: `→ handover.reaches is not a function`
- `controller/handover.test.ts -t "kept commit"`:
  - `→ expected [] to deeply equal [ { commits: [ { …(2) } ] } ]`
  - `→ expected [] to deeply equal [ [ ObjectContaining{…} ] ]`
- `messages.test.ts`: `takes empty params and answers every handover call → expected undefined to be defined`

**GREEN:** the same runs all pass (git-repair 5, destination 2, service 1, controller handover 59 in the full file, protocol 62). While going green, one harness fix was needed in the controller test's fake source. It only added the graph to preflight's manifest, so at claim the kept commit's graph was unknown and was counted as lost, conservatively. The fake's frozen manifest now carries the graph too.

## 2. O1's same-id case converges, and a refusal is reported distinctly

**Changed**

- **`provision.ts`.** The created and held cases both finish with the same `run()`: `setupFleetHome` (hooks, node.json with the profile's port, tmux.conf), then `ensureUnit` (written and daemon-reloaded only when different), then `enable --now`. Every step changes nothing that is already right, so a rerun converges and `held` means a home holding this fleet with its unit running. `setupFleetHome` is included beyond the finding's ensureUnit plus `enable --now`: a run cut off after fleet.json would otherwise leave no node.json, and the daemon's default port would clash with the private fleet's.
- **`fleet-provision.ts`.** `REFUSED = 3`. A `ProvisionRefused` writes `archi: <reason>` to stderr and exits 3. Every other failure is an ordinary error and exits 1. The provision function can be injected for tests.
- **`host.ts`** `provisionCopy`:
  - Exit 3 fails the step with the far reason and the action to move that fleet home aside.
  - Any other exit (a companion without `fleet provision`, a failed systemctl, a timeout or signal) fails with "`<name>` did not finish making its copy of this fleet: …" and no move-aside action.

**Tests**

- `packages/archid/test/linux-provision.test.ts`: the held test now covers a home a run left with only fleet.json.
  - It is finished: node.json has port 0, the hooks, tmux.conf and unit are written, and the calls are `[daemon-reload, enable --now]`.
  - A second run changes no file and calls only `[enable --now]`.
- `packages/cli/test/fleet-provision.test.ts`: a refusal exits `REFUSED` with exactly `archi: <reason>`; another failure rejects as an error.
- `packages/cli/test/host.test.ts`:
  - The refusal test now uses exit 3 and asserts the move-aside action.
  - New: `unknown command 'provision'` and a failed systemctl (both exit 1) get no action and nothing about moving aside.

**RED**

- `linux-provision.test.ts`: `→ ENOENT: no such file or directory, open '…/.archipelago-work/node.json'`
- `fleet-provision.test.ts -t "own code"`: `→ ENOENT: no such file or directory, mkdir '/home/linus/.archipelago'`. With no injection point yet, the real provision ran against a path that cannot be made on macOS, and failed there.
- `host.test.ts -t "aside"`: `→ expected 'ssh trift.test and move that fleet ho…' to be undefined`

**GREEN:** linux-provision 4 passed; fleet-provision and host 114 passed, 1 skipped (full files).

## 3. `tips` are full hex object names

**Changed:** protocol `ObjectName` (`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`). It is used for `GitGraph.tips`, `ReceivedGraph.tips`, `KeptCommit.commit` and `CommitAt.commit`, so no wire value can reach git's option position (`git-repair.ts` `reaches` and `unreached`).

**Test:** `packages/protocol/test/handover.test.ts` › `names the commits a graph's refs reach by full object names…`. SHA-1 and SHA-256 names parse. `--all`, `-n`, `HEAD`, 39 hex, upper case, a trailing space and 41 hex are refused, in both `GitGraph` and `ReceivedGraph`.

**RED:** `→ --all: expected [Function] to throw an error`

**GREEN:** protocol 115 passed.

## Verification at 45d0e8aa

All runs with `unset ARCHI_HOME ARCHI_CHAR_ID TMUX`.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm vitest run --project archid` on git-repair, destination, service, git-graph and inventory under `test/handover`, plus `linux-provision`, `ownership` and `api` | 8 files, 200 passed, 1 skipped |
| `pnpm vitest run --project cli` on `controller/handover`, `fleet-provision` and `host` | 3 files, 114 passed, 1 skipped |
| `pnpm vitest run --project protocol` | 8 files, 115 passed |
| Full `archid` suite (run once, because the wire types changed) | 70 files passed and 1 skipped; 1147 tests passed and 3 skipped |
| Full `cli` suite (same reason) | 29 files, 486 passed, 3 skipped |

## Notes

- A commit counts as reached when a ref of the source's repository reaches it (`--all`: refs, every worktree's HEAD and the stash), the refs whose history the copy brings back. A commit the source holds only unreachable counts as lost. That errs toward blocking, deliberately.
- An `unproven` entry naming a graph the manifest does not hold is treated as lost. It cannot come from a destination answering the graphs it was sent.

---

# Fix round 2

Fixes the findings in `m3-onmachine-fixes-fix2-findings.md`: 3 (still open on the claim path), plus 4 and 5 folded in. Status: **DONE**.

## Commits

| SHA | Finding | Subject |
| --- | --- | --- |
| 024a3b50 | 3 | A manifest's checkout heads and stash entries are full object names, so a claim never hands git an option through them |
| e4595b99 | 5 | A cancel stops the claim's question to the source about a kept commit at once, in its backoff or its call |
| 0248e2ac | 4 | Fleet provision's comment says a home holding the fleet is brought to a running unit |

## 3. Heads and stash are object names

**Changed:** in `packages/protocol/src/handover.ts`, `GitCheckout.head` is now `ObjectName.nullable()`, which covers the main checkout and each worktree, and `GitGraph.stash` is now `z.array(ObjectName)`.

- The source writes these values from `git worktree list` HEAD and `git stash list --format=%H`, so they are already full hex. A null HEAD (unborn branch) still parses.
- A manifest carrying anything else is now refused wherever it is parsed:
  - in the `handover.claim` params at the API;
  - in `identify()`, through `manifestDigest`, which parses the manifest before anything is read or written.
- `graphsHere` therefore never merges such a value into the tips it passes to `rev-list`.

`GitRegistration.head` (unused worktrees) was left a plain string. `graphsHere` does not merge it into tips, and no destination passes it to git.

**Tests**

- `packages/archid/test/handover/destination.test.ts` › `refuses a claim whose manifest names a checkout head or a stash entry that is not an object name, before git reads it`. Real git, through `DestinationHandover.claim`, with a recording git runner.
  - The setup: the return trip, with the kept `unused` worktree, its commit named by no tip, and the worktrees' heads set to null.
  - Then, one at a time, a main head and a stash entry of `--output=<file>`.
  - It asserts: the claim rejects, the file does not exist, and no git argument starting `--output` was ever passed.
- `packages/protocol/test/handover.test.ts` › `names the commits a graph's refs reach by full object names…` (extended).
  - A null head and a 64-hex stash entry parse.
  - Each of `--all`, `--output=/tmp/x`, `-n`, `HEAD`, 39 hex, upper case, a trailing space and 41 hex is refused in a main head, a worktree head and a stash entry, as well as in tips.

**RED**

- `pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "not an object name"`
  - `→ promise resolved "{ roots: [ { …(4) }, { …(3) }, …(2) ] }" instead of rejecting`
- The same test with the rejection assertion removed, on today's code: `→ expected true to be false`. Git wrote the file through the hostile tip, which reproduces the reviewer's `--output` proof on the claim path. The test file was restored afterwards.
- `pnpm vitest run --project protocol packages/protocol/test/handover.test.ts -t "full object names"`
  - `→ --all: expected [Function] to throw an error`

**GREEN:** both pass (1 passed each).

## 5. The claim's question to the source can be cancelled

**Changed:** in `packages/cli/src/controller/handover.ts`, `lostCommits` takes an optional `stop` signal.

- The claim path passes `this.cancel$.signal`.
- With a signal, the call to the source's `handover.reaches` goes through `cancellable`, and `retrying` gets the signal too. This matches the `handover.claim` call beside it.
- The preflight call keeps no stop signal, as the `handover.inspect` call beside it has none.

**Test:** `packages/cli/test/controller/handover.test.ts` › `asked while the claim waits on the source about a kept commit, stops waiting at once, whether in a backoff or in the call`.

- It runs twice:
  - `handover.reaches` fails transiently, and the backoff never ends on its own;
  - `handover.reaches` never answers.
- In each case a cancel ends the run `aborted` within 1 s, with one `handover.reaches` sent and no transfer.

**RED:** `pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "waits on the source"`

- `→ backoff: expected 'hung' to match object { status: 'aborted', …(1) }`

**GREEN:** 1 passed.

## 4. The doc comment

`provisionFleet`'s comment now says that a home already holding this fleet keeps it and is brought to a running unit, finishing what an earlier run left undone. This is a comment change only, so it has no test.

## Verification at 0248e2ac

All runs with `unset ARCHI_HOME ARCHI_CHAR_ID TMUX`.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm vitest run --project archid packages/archid/test/handover/ packages/archid/test/linux-provision.test.ts` | 18 files passed and 1 skipped; 424 tests passed and 3 skipped |
| `pnpm vitest run --project cli packages/cli/test/controller/` | 10 files, 267 passed, 2 skipped |
| `pnpm vitest run --project protocol` | 8 files, 115 passed |
