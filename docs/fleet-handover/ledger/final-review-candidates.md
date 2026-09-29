# Final review candidates (deduped)

Paths are relative to the snapshot `SNAP` (see context.md). Each candidate: id · panel severity · file:line · claim.

## High / Medium — one validator each

- **C01** · high · packages/archid/src/fleet.ts:157 — Freeze does not wait for in-flight revives: `Fleet.settle()` waits for `background` and the scribe but not `reviving`/`openingSecond`; a `char.revive` admitted just before a freeze and waiting on an idle close (`this.ending`, up to 60 s, fleet.ts:725) opens its window after the rest listed terminals (`tracks ??=`, rest.ts:245); the rest never kills it and marks the slot dormant (rest.ts:357), so after Commit the source keeps an agent running while the destination resumes the same session.
- **C02** · high · packages/cli/src/controller/connection.ts:279 — Routed `archi` commands (status, char, island — which mission control's settings allow) fail on the gateway machine itself after the fleet is handed there: `resolveOwner` asks the gateway over ssh, but on the gateway machine the registry entry is the local record with no `ssh`, so `askGateway` throws (line 208) and `fromCachedRoute` throws too (no route.json there).
- **C03** · medium · packages/cli/src/controller/handover.ts:526 — A resume on a machine that is neither source nor destination (controller journal gone, rebuilt from the gateway, e.g. a Linux-driven L1→L2 handover resumed from the Mac) mirrors the source's roots with `--delete` into the same absolute paths on the controller's own disk: only preflight (line 228) checks the controller is a party; `transfer()` sets roles from `source.master` and writes the pull target locally.
- **C04** · medium · packages/archid/src/handover/rest.ts:354 — Rest marks a terminal dormant without confirming its window closed: `Tmux.killWindow` (tmux.ts:233) swallows errors, so a failed kill of a live window still records the slot dormant and restedBy; the destination then resumes the session while the source window keeps running it.
- **C05** · medium · packages/archid/src/handover/rest.ts:167 — Rest closes an idle agent (`agent-ready`) that still has `run_in_background` commands running, without the user choosing Terminate; `step()` ignores `c.processes.agent.commands`, while the interrupted branch and fleet.ts:439's idle close treat them as work in progress; the orphaned command keeps writing into a carried root after the manifest.
- **C06** · medium · packages/cli/src/program.ts:54 — The far fleet profile comes only from the `-p` flag: with a named fleet selected through `ARCHI_HOME`, routed commands, `archi handover`, `fleet recover` and `connect` ask the far companion for its private fleet (remoteConnectionInfo adds `-p` only when given, connection.ts:112), failing with FleetMismatch and advice naming the wrong fleet; `fleet recover --force-owner` sees a reachable far owner as unreachable.
- **C07** · medium · packages/cli/src/controller/host.ts:685 (and :599-600, fleet-recover.ts:290, archid config.ts:127 setGateway) — `host enable`/`host remove` rewrite fleet.json from `FleetConfig.parse` output: unknown keys dropped, every default written out (pinned), and a symlinked fleet.json replaced by a plain 0600 file; archid `saveMainAgent` writes through the link keeping raw keys.
- **C08** · medium · packages/cli/src/controller/handover.ts:113 — A companion on another protocol version (Mac updated first) never gets the `incompatible_protocol` blocker: `remoteConnectionInfo` throws `SshError('version')` (connection.ts:128-130), `transient()` retries it 4× and the run ends `interrupted` with `safe: []`, so the sheet's "Upgrade <machine>" hint never shows.
- **C09** · medium · packages/cli/src/controller/host.ts:681 — `host enable` for a fleet whose fleet.json names a different, still-registered gateway re-points it: seedAuthority (host.ts:625-626) creates a record naming this Mac at generation 0 on the new gateway and fleet.json switches, stranding the fleet the old gateway holds.
- **C10** · medium · packages/cli/src/controller/registry.ts:63 — A machines.json that fails to parse is moved aside to `.broken-<time>` and replaced with a registry of only this machine; `registry.recovered` is never read outside tests, so every later routed command/handover fails with "names gateway X, which is not a machine in the registry" and nothing says the registry was reset.
- **C11** · medium · apps/desktop/web/src/handover.ts:7 — The helper↔app NDJSON event types are re-declared by hand in the web app (SafeAction, Outcome, Verdict, HandoverEvent, …) with no shared type or contract test; `HandoverLine.decode` checks only that `event` is a string and `applyEvent` reads `e.data.blockers/warnings/reason` unguarded, so a shape change or an older release's replayed events.ndjson throws and the sheet sticks at "Looking for a handover…".
- **C12** · medium · apps/desktop/mac/Sources/Archipelago/ShellRouter.swift:346 — After "Make it this fleet's gateway" (or Remove) succeeds, the page's gateway name stays stale until reload: `shell.info` (with `gateway`) is sent only on the page's `connection` message; `startHost`'s onExit sends only `host.done`, and enableHost rewrites fleet.json without restarting archid.
- **C13** · medium · apps/desktop/mac/Sources/Archipelago/RemoteConnection.swift:48 — A helper that fails or exits before its first `online` leaves the window's route `.pending` forever, even for a local-only fleet (no gateway, handover never enabled): `connection` stays nil, AttachCommand.build returns nil, and after archid recovers the window still shows "archid not running" until reopened.
- **C14** · medium · apps/desktop/mac/Sources/Archipelago/ShellRouter.swift:265 — Settings → Fleet config opens this Mac's local fleet.json while the fleet runs on the Linux machine (`openConfig` skips the `isHere`/remote notice that openFolder and reveal use); edits never reach the running daemon and the incoming fleet.json overwrites them at the handover back (destination.ts:531).
- **C15** · medium · apps/desktop/mac/Sources/Archipelago/SurfaceManager.swift:32 — A remote terminal surface attaches with `ssh -S <controlSocket> -tt -- <destination> tmux …` without BatchMode or ControlMaster=no; if the helper's master is gone it opens its own interactive ssh to the real destination with no machine-id check, against the security doc's rule that a command on a dead master fails (the CLI names `archi-remote.invalid`).
- **C16** · medium · scripts/install-release.mjs:82 — A same-version reinstall (dev `--dirty` names repeat) renames the existing releases/<version> aside, deletes it after moving `current`, and returns `rollbackTo` = that same path; `host upgrade`'s failed-probe rollback (host.ts:487-510) then lands on the new broken tree and reports it as "the one it ran before".
- **C17** · medium · scripts/install-release.mjs:108 — Installed releases are never pruned; every `pnpm desktop:install` at a new commit and every `host upgrade` adds a full release tree (~190 MiB with Node) under ~/.local/share/archipelago.
- **C18** · medium · scripts/install-release.mjs:35 — Release archive verification is implemented twice (install-release.mjs `stage()` and cli controller/install.ts `inspectCompanion`), already drifted (name check order), and `verifyRelease` runs the signature check a second time.
- **C19** · medium · packages/archid/src/handover/source.ts:369 — Source Complete never calls `fleet.deactivate()` (adopt does, service.ts:155-157); `Fleet.activate()` is `this.activated ??= this.begin()`, so after a round trip with no daemon restart activate is a no-op: `syncAgents`/`ensureHome` never re-run (Settings lists every agent as not found, main-agent switching disabled), and `recover()` (fleet.ts:265) restarts a tmux server on the replica.
- **C20** · medium · packages/archid/src/gateway/client.ts:158 — The daemon's gateway-over-ssh query re-implements the controller's with looser identity: client.ts:181 skips the machine-id check when the answer carries no id (the controller throws MachineMismatch, connection.ts:44), and the regexes differ.
- **C21** · medium · packages/archid/src/machine.ts:29 — `mintMachineId` writes machine.json with `writeFileSync(…, {flag:'wx'})`, no temp, no fsync; a crash can leave it empty, `read()` then says to delete it, and a new id orphans every ownership record naming the old one; `createDurable` (durable.ts:53) exists for exactly this.
- **C22** · medium · packages/archid/src/handover/destination.ts:650 — The trust-prompt watch loops every 2 s with no bound: for a resumed agent left at its prompt it runs `ps -A -ww`, `tmux list-panes`, re-reads and parses the Claude config synchronously and re-probes agent CLIs once a minute, until answered — also after Complete.
- **C23** · medium · packages/archid/src/linux/setup.ts:56 — The Linux archid unit drops CLAUDE_CONFIG_DIR and CODEX_HOME, which the Mac launchd plist carries (launchdEnv); on a Linux account setting either, archid probes/places sessions under ~/.claude/~/.codex while the agents read the configured folder.
- **C24** · medium · packages/archid/src/uninstall.ts:154 — `archi uninstall` run directly on the Linux machine disables the gateway and archid units and kills every fleet's tmux server without the refusals `host remove` has (owner of a fleet, gateway of fleets, open handover), stranding the fleet.
- **C25** · medium · packages/cli/src/controller/connection.ts:20 (+ helper.ts:101, host.ts:56, route.ts:16, transfer.ts:18, handover-view.ts:40) — Exports with no importer outside their own file: RETRIED, ConnectionInfo, parseControl, StepError, routeFile, MAX_PASSES, issueLine.
- **C26** · medium · packages/archid/src/handover/validate.ts:24 — Manifest path validation duplicated between validate.ts `filesProblem`/`absoluteProblem` and replicas.ts `rootProblem` (137-145) — two trust boundaries from two copies.
- **C27** · medium · packages/archid/src/handover/service.ts:89 — `handover.status` returns `roots` from `SourceJournal.progress`, which nothing writes, and `characters`/`roots` have no reader.
- **C28** · medium · packages/archid/src/store.ts:76 — `Store.replace` is called only from tests.
- **C29** · medium · packages/protocol/src/messages.ts:356 — `HelloResult` (with a speculative `capabilities`) is exported and never used; the daemon writes the hello reply inline.
- **C30** · medium · packages/archid/src/handover/rest.ts:316 — Scrollback capture in the rest is unreachable in production (`SourceDeps.rest` picks no `scrollbackLines`); RestedTerminal's scrollback/class/interrupted/terminated fields are unread.
- **C31** · medium · apps/desktop/mac/Sources/Archipelago/ControllerProcess.swift:221 — Three Swift NDJSON child wrappers (ControllerProcess, HostProcess, Handover.swift's LineChild) with three stop/drain policies.

- **C32** · medium · packages/cli/src/commands/setup.ts:30 (and :159 → packages/archid/src/release.ts:22) — `archi setup` without `--release` on an installed release (the Mac after `pnpm desktop:install`, every Linux companion) throws "this is an installed release, not a checkout", so every place that tells the user to run `archi setup` dead-ends: README, doctor (incl. `--check`), the daemon's missing-agent error at fleet.ts:479, the `agent_hooks_missing` sheet hint and errors.md — also on the local-only path with handover off.
- **C33** · medium · packages/archid/src/handover/destination.ts:843-867 → replicas.ts:286-289 → divergence.ts:109 — If something outside the rested terminals changes a source file mid-transfer (e.g. Finder's `.DS_Store`, not excluded) and the user cancels or aborts before prepare, the root keeps its `receiving` record (sealAs seals nothing without a seal record); the next handover blocks with `destination_diverged` ("changed while this machine did not own the fleet… recover the changes by hand"), and only `--archive` gets past it.

## Low / Nit — validated in groups

### G1 (controller simplifications)
- **L01** packages/cli/src/commands/gateway.ts:20 — eight-way `send()` switch and a second local-authority adapter beside reach.ts `authorityOp`.
- **L02** packages/cli/src/controller/reach.ts:144 — master→connection-info→forward→client written four times (openDaemon, connectRemote, goOnline, endToEnd), cleanup already differs.
- **L03** packages/cli/src/commands/handover.ts:71 — seven fleet.json readers; `gatewayOf` duplicates archid `namedGateway` and shares a name with reach.ts:83's unrelated `gatewayOf`.
- **L04** packages/cli/src/commands/fleet-provision.ts:36 — the installed-or-checkout RunFrom expression spelled three times (+ setup.ts:159).
- **L05** packages/cli/src/commands/handover-view.ts:16 — ARCHIVABLE redeclared though archid replicas.ts:78 exports it.
- **L06** packages/cli/src/commands/fleet-recover.ts:294 — inline writeRoute try/catch duplicates route.ts `rememberOwner`.
- **L07** packages/cli/src/commands/fleet-recover.ts:115 — own controller-journal reader with a comment misdescribing `fileStore`.

### G2 (controller design)
- **L08** packages/cli/src/controller/progress.ts:9 — `configDir()` default for transfer state that production never uses (a caller omitting stateDir would write under ~/.config).
- **L09** packages/cli/src/controller/recovery.ts:39 — ControllerJournal `entries`, `pending`, `error` written and fsynced, never read.
- **L10** packages/cli/src/commands/handover.ts:253 — owner pre-check duplicates preflight's identity check and bypasses the `ssh_interactive` mapping.
- **L11** packages/cli/src/controller/handover.ts:93 — a second retry policy with an opposite-polarity predicate to connection.ts `retryable`.
- **L12** packages/cli/src/controller/host.ts:15 — controller imports from the commands layer (`Check`, `REFUSED`).
- **L13** packages/cli/src/controller/connection.ts:127 — machine-id mismatch thrown as plain SshError, not MachineMismatch, so a handover retries it instead of blocking with identity_mismatch.
- **L14** packages/cli/src/controller/handover.ts:946 — observe() asks each daemon serially and some twice.
- **L15** packages/cli/src/controller/reach.ts:207 — Side.fleetHome getter throws until its daemon answered.

### G3 (controller behaviour)
- **L16** packages/cli/src/controller/handover.ts:546 — a transfer that fails before any entry reports "the transfer ended failed" without `result.failure.error`.
- **L17** packages/cli/src/controller/host.ts:345 — `host add` accepts a far rsync below MIN_RSYNC 3.2.3 (Ubuntu 20.04's 3.1.3) as ready; every handover then blocks with rsync_unsupported.
- **L18** packages/cli/src/controller/handover.ts:783 — after the gateway aborted but a let-go failed, the outcome still offers resume as "goes on".
- **L19** packages/cli/src/controller/handover.ts:100 — daemon blockers cast from wire data (`as Blocker[]`) without schema parse.
- **L20** packages/cli/src/commands/handover.ts:456 — `handover attach`'s terminal menu answers without the run's held choices (--terminate-shells, --interrupt-after, --archive silently dropped).
- **L21** packages/cli/src/commands/handover-view.ts:22 + apps/desktop/web/src/handover.ts:327 — CLI divides bytes by 1024, the sheet by 1000, same KB/MB labels.

### G4 (app behaviour)
- **L22** apps/desktop/web/src/terminals.ts:61 — a term.attach answered after the freeze began still shows a live surface over "Resting for the handover…".
- **L23** apps/desktop/web/src/terminals.ts:67 — a `frozen` attach refusal becomes a sticky terminal error (only `not_owner` retries).
- **L24** apps/desktop/mac/Sources/Archipelago/Handover.swift:206 — a launcher relaying a helper that finished before it listened is reported as exit 1; onMoved never fires for a complete result.
- **L25** apps/desktop/mac/Sources/Archipelago/Handover.swift:244 — attach's no-helper replay is applied line by line, closing and re-attaching terminals.
- **L26** apps/desktop/mac/Sources/Archipelago/ControllerProcess.swift:316 — HostProcess.finish can run before the last stdout chunk is appended (no DispatchGroup join as LineChild has).
- **L27** apps/desktop/mac/Sources/Archipelago/ControllerProcess.swift:277 — HostProcess.cancel waits unbounded on main with no SIGKILL.
- **L28** apps/desktop/mac/Sources/Archipelago/Handover.swift:27 — interruptAfterMs `ms + 999` traps on overflow and rounds sub-second values up (nit).

### G5 (app and release structure)
- **L29** apps/desktop/web/src/handover.ts:239 — blocker-to-choice mapping spelled in three places (web choiceFor, cli handover-view, archid ARCHIVABLE).
- **L30** scripts/bench/handover.mjs:35 — integration/bench/build scripts copy helpers harness.mjs should share.
- **L31** apps/desktop/mac/Sources/Archipelago/ArchiHome.swift:71 — profile name derived several overlapping ways.
- **L32** scripts/release-stage.mjs:159 — release.json always records `agentAdapters: []` though the adapters exist.
- **L33** apps/desktop/mac/Sources/Archipelago/Handover.swift:13 — the same private `matches` helper and machine-name regex in two Swift files (nit).
- **L34** apps/desktop/mac/build.sh:42 — the dev build pins a `file:` companion that the next build deletes; Add machine/Upgrade then fail with ENOENT; README:93 says the clone is only needed to update.
- **L35** .github/workflows/ci.yml:33 — the Swift test target (~65 tests) never runs in CI or `pnpm test`.
- **L36** scripts/release-stage.mjs:77 — signed releases trust the vendor cache for the Node tarball (checked against a cached SHASUMS, no pinned digest) and the built rsync.

### G6 (daemon structure)
- **L37** packages/archid/src/handover/sessions/repair.ts:11 — repairBrief imported only by a test.
- **L38** packages/archid/src/atomic.ts:5 — writeJsonAtomic is a middle man over writeDurable, and jsonfile.ts exports a non-fsync function of the same name.
- **L39** packages/archid/src/handover/destination.ts:877 — ask/serial/processes/realClock/keyOf duplicated between source and destination (and rest).
- **L40** packages/archid/src/handover/divergence.ts:80 — the excluded-by-ancestor walk written three times.
- **L41** packages/archid/src/handover/validate.ts:123 — divergence summary text formatted twice.
- **L42** packages/archid/src/handover/source.ts:577 — source parses fleet.json raw (a ZodError mid-freeze instead of InvalidConfig).
- **L43** packages/archid/src/handover/destination.ts:447 — relaySecret prepare param, path and write step for the later-version phone relay, never sent.
- **L44** packages/protocol/src/state.ts:141 — Character repeats TerminalSlot's fields instead of extending it; `Second` alias used only in a test.
- **L45** packages/archid/src/linux/provision.ts:60 — ensureUnit duplicates setup's writeUnits (and skips the 0700 log dir).
- **L46** packages/archid/src/handover/service.ts:49 — "not implemented yet" fallback for deps production always passes; unused 'journal' authority class.
- **L47** packages/archid/src/handover/startup.ts:24 + api/methods.ts:29 — 'committed-destination' names uncommitted journals; state schema version derived via emptyState() in three places (nits).

### G7 (daemon behaviour)
- **L48** packages/archid/src/config.ts:87 — initConfig/splitLegacy write every schema default into fleet.json, pinning them against later default changes.
- **L49** packages/archid/src/main.ts:79 — the Linux daemon's abstract lock socket name is predictable; another local account can squat it (the security doc lists this as an accepted risk — valid only if that acceptance is wrong).
- **L50** packages/archid/src/profile.ts:12 — seven new reserved profile names orphan existing profiles with those names, with no notice.
- **L51** packages/archid/src/handover/durable.ts:60 — writeDurable leaves a new `.durable-*.tmp` behind on every failed write (state.json now goes through it).
- **L52** packages/archid/src/ownership/guard.ts:83 — a comment says inspect writes probe files; it no longer does (nit).
