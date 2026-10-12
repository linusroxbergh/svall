# Fleet handover — deferred follow-ups

What the reviews found and left open, by area. Paths are from the repository root.

## Destination and Git

- Activation and provisioning write fleet.json from the parsed schema, so every default is written out and keys the
  schema does not know are dropped (`packages/svalld/src/handover/destination.ts:670`,
  `packages/svalld/src/linux/provision.ts:127`).
- Root paths are not compared with each other for case or Unicode folding, so two roots that fold together pass
  preflight and land in one folder on a case-folding destination (`packages/cli/src/controller/handover.ts:950`).
- `caseCollisions` folds whole file paths only, so folders that differ only by case (`A/x`, `a/y`) pass preflight and
  merge on a case-folding destination (`packages/svalld/src/handover/probe.ts:20`).
- `foldsCase` reads false for a folder with no letters in its name or entries, so a case clash there shows as a
  misleading `external_writer` before the commit (`packages/svalld/src/handover/probe.ts:38`).
- A destination worktree registration whose id matches a carried one is replaced, whatever it points to
  (`packages/svalld/src/handover/git-import.ts:65`).
- A destination registration whose folder is absent, a locked one on unmounted media included, is deleted at import
  (`packages/svalld/src/handover/git-import.ts:70`).
- A carried repository's `objects/info/alternates` is not read, so objects borrowed from outside every root do not
  travel and nothing blocks (`packages/svalld/src/handover/git-graph.ts:175`).
- `unusedWork` ignores `prunable`, so a broken worktree registration can be reported as holding changes
  (`packages/svalld/src/handover/git-graph.ts:261`).
- The dirty-unused-worktree blocker says a handover back drops the registration, while the import keeps one whose
  worktree is present (`packages/svalld/src/handover/git-graph.ts:251`).
- Prepare compares git status with nested `Array.includes` scans, quadratic in the changed files, on the destination
  daemon's event loop (`packages/svalld/src/handover/git-import.ts:175`).
- Destination `lay()` marks a terminal dormant before `killWindow`, which swallows errors, and nothing checks the
  window closed (`packages/svalld/src/handover/destination.ts:883`).
- After a destination crash, a window that survived with its agent up gets no resume record, so an agent that leaves
  its trust prompt after Complete leaves a plain shell (`packages/svalld/src/handover/destination.ts:744`).
- Import strips Codex `-p`/`--profile`/`--local-provider` from the revive command, so a round trip loses the Mac's own
  Codex profile (`packages/svalld/src/handover/validate.ts:130`).

## Source and rest

- An idle agent with a child of its own still running, such as a user's hook, is `agent_unsettled` at the first read,
  with no wait for it to end (`packages/svalld/src/handover/rest.ts:175`).
- If the pane recheck after a kill throws, the slot keeps its tmux id while SessionEnd clears its agent, and a re-run
  lays it dormant with no agent (`packages/svalld/src/handover/rest.ts:407`).
- `HandoverService.open()` hands a journal that names another fleet, which startup ignores, to status and the
  handover steps (`packages/svalld/src/handover/service.ts:266`).
- The control link's `recover()` runs outside `track`, so `fleet.settle()` does not wait for it
  (`packages/svalld/src/fleet/control.ts:60`).
- A revived Codex quit before its first prompt is laid dormant as a failed resume, since Codex reports no session
  until then (`packages/svalld/src/fleet/poll.ts:113`).
- A prompt held for a busy agent (`char.run` answering `queued`) does not hold up a rest, and the fleet leaving this
  machine drops it without a word, neither carried nor logged (`packages/svalld/src/fleet/prompts.ts:216`).

## Controller and transfer

- Every root is claimed before any copy starts, and nothing checks a root again before its `rsync --delete`, so edits
  made on the destination in between are overwritten (`packages/cli/src/controller/handover.ts:552`).
- `transfer()` checks that exactly one side is remote only after `claim()`
  (`packages/cli/src/controller/handover.ts:552`).
- A journal rebuilt by `adopt()` has no landed list, so the source seals the frozen manifest and the return trip can
  raise a false `destination_diverged` (`packages/cli/src/controller/handover.ts:1016`).
- A rebuilt journal of a committed handover that fails with an error other than `Stopped` reports phase `begin`,
  offering resume and abort (`packages/cli/src/controller/handover.ts:315`).
- Building a side retries four times with backoff on any plain error, such as a machine missing from the registry
  (`packages/cli/src/controller/handover.ts:1054`).
- The checksum dry run counts a folder whose only difference is its time as a change, which keeps a pass unstable
  (`packages/cli/src/controller/transfer.ts:342`).
- The local scan hashes every file without an abort signal, so Cancel waits until hashing finishes
  (`packages/cli/src/controller/transfer.ts:331`).
- `pathProblem` accepts empty segments (`/`, `//`, a trailing slash) that svalld's `absoluteProblem` refuses
  (`packages/cli/src/controller/transfer.ts:120`).
- An rsync exit that looks like a dropped link runs `ssh -O check` (up to 10 s) only to label a failure nothing reads
  (`packages/cli/src/controller/transfer.ts:366`).
- `--interrupt-after` has no upper bound and is added to the freeze call's timeout, which overflows `setTimeout` past
  about 596 hours (`packages/cli/src/commands/handover.ts:56`).
- `handover.abort` gets only the 30 s client timeout, though the source's abort asks the gateway and revives every
  rested terminal (`packages/protocol/src/messages.ts:93`).
- `svall handover local` never names the source, so its abort line says "the machine it ran on"
  (`packages/cli/src/commands/handover.ts:166`).
- A machine can be added as `status` or `attach`, and `svall handover status`/`attach` then runs the subcommand
  (`packages/cli/src/controller/registry.ts:136`).
- With the gateway unreachable and no journal found, status says no handover of this fleet is open anywhere
  (`packages/cli/src/controller/recovery.ts:159`).
- Closing a master that `open()` already replaced sends `-O exit` on the shared socket, ending the new master
  (`packages/cli/src/controller/ssh.ts:223`).

## Recovery

- If the force write to a replacement gateway lands but its answer is lost, a rerun with `--gateway` refuses, and
  fleet.json still names the lost gateway (`packages/cli/src/commands/fleet-recover.ts:219`).
- A recover onto a replacement gateway never names `svall host enable` among its next steps
  (`packages/cli/src/commands/fleet-recover.ts:335`).
- Forcing the owner to the destination of an unfinished handover does not say that machine runs its pre-handover copy
  (`packages/cli/src/commands/fleet-recover.ts:150`).

## Ownership and local sockets

- `OwnershipState.load` takes any readable owner.json without comparing its fleetId with fleet.json's
  (`packages/svalld/src/ownership/state.ts:31`).
- The Linux daemon lock is an abstract socket named by a hash of the home's path, so another account can bind it
  first and a bind-mounted home gets two names (`packages/svalld/src/main.ts:84`).
- On Linux without TMPDIR, control sockets go under `/tmp/svall-<uid>`; another account can make that folder first,
  and every master is then refused (`packages/cli/src/controller/ssh.ts:57`).
- The `host add` tmux probe opens its server at a guessable `${TMPDIR:-/tmp}/svall-probe-$$`
  (`packages/cli/src/controller/host.ts:274`).

## Machines and setup

- Linux `setup --release` never passes `rollbackTo`, so an install that replaces a release neither restarts the
  running daemons nor probes them (`packages/cli/src/commands/setup.ts:249`).
- `svall host` saves the machines.json it loaded when it started, so a registry change made meanwhile is lost
  (`packages/cli/src/controller/host.ts:415`).
- `host add` under a second name for a registered machine uploads and installs, then fails at the registry step
  (`packages/cli/src/controller/host.ts:313`).
- `remoteConnectionInfo` checks the fleet id before the machine id, so an alias that reaches another machine gets
  `svall host enable` advice instead of a machine mismatch (`packages/cli/src/controller/connection.ts:128`).
- `svall host doctor` never compares the far machine id with the registry's (`packages/cli/src/controller/host.ts:454`).
- `host upgrade --rollback` never compares the far release with this controller's, and prints "ready for handover"
  for any ready outcome (`packages/cli/src/controller/host.ts:559`).
- `host remove`'s refusal always speaks of another Mac's fleet, even when this Mac's own stale cache caused it, and
  strips the `svall: ` prefix only from the first line (`packages/cli/src/controller/host.ts:664`).
- An agent missing at `host add` gets "install <agent>" without saying to run `host add` again, which writes its
  hooks (`packages/cli/src/controller/host.ts:236`).
- Stopping Add Machine leaves its interactive ssh and askpass dialog running (`packages/cli/src/commands/host.ts:31`).
- A `-N` dedup suffix can push an auto-created machine name past 32 characters, and the next load sets machines.json
  aside (`packages/cli/src/controller/registry.ts:26`).
- svalld exits at start when `~/.config/svall` cannot be made or machine.json is bad, and the app or systemd restarts
  it in a loop (`packages/svalld/src/main.ts:152`).
- `svall agent` talks to this machine's daemon, so for a fleet another machine owns it reads and sets the local copy
  (`packages/cli/src/commands/agent.ts:24`).
- fleet.json's schema is not strict, so machine keys put there (`port`, `host`, `shell`, `integrations`) are dropped
  without a word (`packages/protocol/src/handover.ts:69`).
- fleet.json is read without config.json's `unreserved` preprocess, so a reserved name there fails the name check
  (`packages/svalld/src/config.ts:154`).
- The reserved-name notice shows only in a setup that runs; `setup --if-needed` and doctor never show it, and its `mv`
  advice neither stops the fleet first nor unloads the old launchd agent, whose daemon makes the old home again
  (`packages/svalld/src/setup.ts:210`).
- Uninstall skips homes under a reserved name: their tmux servers and phone links keep running and `--purge` keeps
  their data (`packages/svalld/src/uninstall.ts:248`).
- With handover off, setup and doctor warn about Claude Code below 2.1.251, a floor only handover needs, and Mac
  doctor warns about the bundled rsync (`packages/cli/src/commands/preflight.ts:82`).
- Svall Dev and Svall share `~/.config/svall` and the Linux unit names, and a dev controller accepts a companion of
  any release (`packages/svalld/src/machine.ts:12`).
- `releaseVersion()` reads release.json on every call, so a process that runs across an in-place update reports the
  new release (`packages/svalld/src/release.ts:49`).

## Release and install

- Svall.app carries two controllers: the runtime bundle on `Helpers/node`, and `Resources/release` with its own Node,
  which the window helpers run (`apps/desktop/mac/build.sh:51`).
- `release.yml` publishes without a job that runs the typecheck or the unit tests (`.github/workflows/release.yml`).
- An install removes every release but `current` and the rollback target, one that a `--no-launchctl` daemon or a
  long-running `svall` still runs from included (`scripts/install-release.mjs:133`).
- An install killed part way leaves its `.staging-<pid>` and `.replaced-<version>-<pid>` trees, which later installs
  never remove (`scripts/install-release.mjs:96`).
- `--version` is not checked in `scripts/build-companion.mjs` and `scripts/build-controller.mjs`, and the stage
  deletes `<out>/releases/<version>`, so a `..` version deletes `--out` or a folder above it
  (`scripts/release-stage.mjs:337`).

## App and web

- Every window starts the Node connect helper and waits on it, even when fleet.json names no gateway
  (`apps/desktop/mac/Sources/Svall/RemoteConnection.swift:49`).
- Add Machine shows each sudo or login step as a command to run by hand and never offers a terminal on the machine
  (`apps/desktop/web/src/HostSetup.tsx:48`).
- The Machines panel has name and ssh inputs only, with no list of registered machines
  (`apps/desktop/web/src/HostSetup.tsx:91`).
- The Fleet config button opens only fleet.json: with none it does nothing, and node.json is never offered
  (`apps/desktop/mac/Sources/Svall/SvallHome.swift:29`).
- A terminal attach refused with `handover_committed` becomes a sticky error; only `not_owner` and `frozen` are retried
  (`apps/desktop/web/src/terminals.ts:16`).
- An attach refused as `frozen` while the page follows no handover is retried only on an online change, so the pane
  stays blank (`apps/desktop/web/src/terminals.ts:71`).
- A `detached` result holds every terminal at "Resting…" with no badge, even after the new owner's fleet has loaded;
  only Follow clears it (`apps/desktop/web/src/handover.ts:252`).
- A sheet rebuilt after a relaunch has no destination, so it says "the other machine" even for This Mac and hides
  Try again (`apps/desktop/web/src/handover.ts:429`).
- A resume row counts as running once the main terminal has a window, so a failed second terminal shows "resumed"
  and hides Retry (`apps/desktop/web/src/HandoverSheet.tsx:65`).
- A preflight block that arrives after the sheet closed neither reopens it nor badges it
  (`apps/desktop/web/src/store/handover.ts:63`).
- `svall handover attach` exits 0 whenever the helper socket closes, mid-run included, and the sheet then offers Start
  (`packages/cli/src/commands/handover.ts:491`).
- "Check again" on a finished move replays it as `moved` without `onMoved`, so the window stays on the old owner until
  the connection re-routes (`apps/desktop/mac/Sources/Svall/Handover.swift:153`).
- A launch made while a launcher or status command runs is dropped without an exit, leaving the sheet at "Starting…"
  (`apps/desktop/mac/Sources/Svall/Handover.swift:124`).
- `LineChild.stop()` waits in the main run loop, so the child it stops can send a stray `handover.exit` as the next
  run starts (`apps/desktop/mac/Sources/Svall/LineChild.swift:90`).
- The sheet explains `agent_unsettled` as work still running after the interrupt, though it also covers an idle agent
  with a background command and no interrupt (`apps/desktop/web/src/handover.ts:317`).

## OpenCode

- The remote agent probe runs `opencode auth list` in the ssh shell's environment, not the unit's, and a timed-out
  probe can leave its private server running (`packages/cli/src/controller/host.ts:232`).
- The Mac daemon's environment carries no `OPENCODE_DB`, and doctor does not compare it
  (`packages/svalld/src/login-env.ts:7`).
- An abort after a prepare that imported leaves the imported session in the destination's database, owned by no fleet
  (`packages/svalld/src/handover/destination.ts:528`).
- The source's session exports stay in `transcripts/opencode/exports/` after complete or abort
  (`packages/svalld/src/handover/source.ts:454`).
- Sessions are exported once, at freeze, so a change made by hand on the frozen source afterwards is neither carried
  nor caught (`packages/svalld/src/handover/source.ts:322`).
- A CLI exit with no output gives a blank reason, and nothing retries it
  (`packages/svalld/src/handover/sessions/opencode.ts:21`).
- A held copy is deleted and imported again even when it equals the incoming export
  (`packages/svalld/src/handover/sessions/opencode.ts:117`).

## Tests

- The fault world loads each Store without `batchWritesWhile`, so no case covers batched writes lagging the journal
  after unhold (`packages/svalld/test/handover/fault-world.ts:543`).
- No test opens a second terminal across a freeze (`packages/svalld/src/fleet.ts:677`).
- No test compares a names-only build's `listed` count with the read manifest, for links or a single-file root
  (`packages/svalld/src/handover/manifest.ts:107`).
- The relay's malformed-frame test does not show the peer socket surviving the other's bad frame
  (`packages/svalld/test/gateway/relay-contract.test.ts:296`).
- The `LineChild` ordering test does not force a line to arrive after the exit
  (`apps/desktop/mac/Tests/SvallTests/HostProcessTests.swift:163`).
- The claude and codex doubles come first only on the test process's PATH; a pane's login shell running /etc/profile
  can find a real one first (`test/isolate.ts:18`).
- CI never sets `SVALL_TEST_GNU_TAR`, so the GNU tar far check and its install test always skip there
  (`.github/workflows/ci.yml:35`).
- The integration harness splits the mocked OpenCode's command line on spaces (`scripts/integration/machine.mjs:124`).

## Code structure

Behaviour-preserving refactors.

- master → connection-info → forward → client is written four times, each with its own cleanup
  (`packages/cli/src/controller/reach.ts:137`, `packages/cli/src/controller/connection.ts:161`,
  `packages/cli/src/controller/connect.ts:95`, `packages/cli/src/controller/host.ts:257`).
- Six CLI functions parse fleet.json themselves: `localFleetId` (`packages/cli/src/controller/connection.ts:91`),
  `fleetConfig` (`packages/cli/src/controller/connection.ts:191`), `connectHandover`
  (`packages/cli/src/controller/reach.ts:163`), `readFleet` (`packages/cli/src/controller/host.ts:686`), `recoverFleet`
  (`packages/cli/src/commands/fleet-recover.ts:185`) and `gatewayOf` (`packages/cli/src/commands/handover.ts:70`),
  which repeats svalld's `namedGateway` (`packages/svalld/src/config.ts:235`) and shares its name with
  `packages/cli/src/controller/reach.ts:73`'s.
- The CLI's `fleetHomes` (`packages/cli/src/controller/host.ts:592`) disagrees with svalld's
  (`packages/svalld/src/uninstall.ts:248`) on what a fleet home is.
- Which blocker each choice clears is spelled out in three places: `choiceFor` (`apps/desktop/web/src/handover.ts:262`),
  `options` (`packages/cli/src/commands/handover-view.ts:71`) and `ARCHIVABLE`
  (`packages/svalld/src/handover/replicas.ts:78`).
- `scripts/bench/handover.mjs` and `scripts/integration/fleet-handover.mjs` copy `USER_ENV` and `sh()`.
- `profileName`, `profile`, `fleetProfile`, `isPrivate` and `directoryName` each derive the profile from the home path
  (`apps/desktop/mac/Sources/Svall/SvallHome.swift:92-118`).
- `packages/svalld/src/handover/source.ts`, `packages/svalld/src/handover/destination.ts` and
  `packages/svalld/src/handover/rest.ts` each define their own `ask`, `processes`, `serial`, `realClock` and `keyOf`.
- The guard's token-only rule is one condition over the `recovery` and `transaction` classes and the method name
  `handover.inspect`, with `handover.reaches` classed `transaction` to fall under it
  (`packages/svalld/src/ownership/guard.ts:96`, `packages/svalld/src/ownership/guard.ts:89`).
- `resolveOwner` copies `rememberOwner`'s route write (`packages/cli/src/controller/connection.ts:302`).
- `LineBuffer` and `StderrTail` live in `apps/desktop/mac/Sources/Svall/ControllerProcess.swift`, which does not use
  them.
- `MachineRegistry.rename` throws when given the machine's own name, and only tests call it
  (`packages/cli/src/controller/registry.ts:112`).
- Unused: `repairBrief` and `AuthorityClient`'s typed wrappers (tests only), `SourceJournal.error`, `ensureBundle`'s
  `rebuild` option and result, `RunOptions` cwd/env/signal/maxOutputBytes, the per-surface fields of
  `SurfaceManager`'s `Attached`, `ERROR_CODES`/`ErrorCode`, and exports used only in their own files (`within`,
  `Imported`, `characterResults`, `PathList`, `label`, `Ran`).
- Unreachable: `ready()`'s `handover_committed` branch and `forward()`'s `Moved` catch
  (`packages/cli/src/controller/handover.ts:659`, `packages/cli/src/controller/handover.ts:398`).

## Docs

- The spec's protocol surface lists `handover.prepare` with a `snapshot` and leaves out `handover.claim`, `complete`,
  `inspect` and `reaches`, `ownership.adopt` and `owner.force` (`docs/fleet-handover/spec.md:803`).
- The spec says a gateway record above the cached generation wins at start, but `adopt` changes nothing for a
  quarantined journal, or for a committed record naming this machine with no journal here
  (`docs/fleet-handover/spec.md:207`).
- The README's uninstall section does not say `~/.config/svall` stays, even with `--purge` (`README.md:129`).
