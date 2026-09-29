# Deferred-minor triage — ledger docs/fleet-handover/ledger/progress.md at 3915b6d2

Paths are relative to the repo root in the snapshot. One row per item or group of near-duplicates. Classes: fixed, obsolete, must-fix, follow-up, accept.

## Must-fix

| Ledger line | Item | Class | Evidence |
|---|---|---|---|
| 132 | `archi setup` without `--release` throws on an installed release | must-fix | `packages/cli/src/commands/setup.ts:30` (runFrom) and `:159` (`--check`) call `repoRoot()`, which throws "this is an installed release, not a checkout" whenever ARCHI_RELEASE_ROOT is set (`packages/archid/src/release.ts:22`). After `pnpm desktop:install` the Mac's `~/.local/bin/archi` is a link into the release (`scripts/desktop-install.sh:125`, `packages/archid/src/setup.ts:414-415`), and that shim exports ARCHI_RELEASE_ROOT (`scripts/release-stage.mjs:178-180`). Every Linux companion is a release too. Every "run archi setup" remedy then fails: README.md:380 ("you can also run on its own", `--check`), `packages/cli/src/commands/doctor.ts:227,279,320,352`, the daemon's missing-agent error `packages/archid/src/fleet.ts:479`, the sheet's `agent_hooks_missing` hint (`apps/desktop/web/src/handover.ts:311-312`, `packages/archid/src/handover/sessions/registry.ts:204`) and `docs/remote-machines/errors.md:74`. This breaks the local-only path with the flag off. No test runs a bare setup on a release. |
| 602 (a) | After an abort before prepare, a root whose source changed mid-transfer blocks the next handover as `destination_diverged` with a false "changed while this machine did not own the fleet" | must-fix | `packages/archid/src/handover/destination.ts:843-867` `discard`/`sealAs` seals nothing when no seal record exists (any abort or cancel before prepare), so the root keeps its `receiving` record. The next claim takes `replicas.ts:286-289` with `accepted = [baseline, incoming]`, and the frozen manifest's incoming does not match the newer copy the transfer landed (passes verify against the previous scan, not the manifest). The result is `divergence.ts:109`: "…changed while this machine did not own the fleet… Recover the changes by hand, or archive it". Trigger: any file written during a transfer by something outside the rested terminals (Finder `.DS_Store` is not excluded, `inventory.ts:35`; editor autosave), then Cancel or Abort before prepare. Only `--archive` gets past it. The ledger notes the spec wants the partial copy left marked for a later resume. |

## All items

| Ledger line | Item | Class | Evidence |
|---|---|---|---|
| 48 | atomic.ts temp opened without 'wx' | fixed | `packages/archid/src/atomic.ts:5-7` → `writeDurable`, whose temp opens with 'wx' (`handover/durable.ts:17,62-64`) |
| 48 | atomic.ts duplicates setup.ts writeFileAtomic | fixed | no `writeFileAtomic` left in src; both write through `handover/durable.ts` |
| 48 | machine.ts had no caller; mkdir leaves an existing 0755 dir as it is | accept | now called (`cli/src/controller/registry.ts:55`, `archid/src/main.ts`); `machine.ts:25` still leaves an existing dir's mode alone, but machine.json itself is 0600 (`:29`) |
| 48 | ArchiHome.swift seeds `{}` into fleet.json | fixed | `ArchiHome.swift:22-25` returns the path only if the file exists (M1 F2) |
| 48 | Config.id is a fresh uuid per parse; two concurrent first loads mint two ids | accept | `archid/src/config.ts:18`; `initConfig` writes fleet.json once (`:86-88`); the race needs two processes starting on a brand-new home at the same moment |
| 48 | test gaps (httpsPort, existing .bak, corrupt fleet.json beside config.json) | fixed | `archid/test/config-migration.test.ts:99-147`, `config.test.ts` httpsPort |
| 57 | auto-created local record bypasses MachineRecord.parse; a `-N` suffix can pass 32 chars → recover on every load | follow-up | `registry.ts:25-31` slices the base to 32 and then appends `-N`; `localRecord` (`:33-42`) is never parsed; a too-long name fails `Registry.parse` on the next load, and `:62-65` renames machines.json aside, dropping every machine. Needs a hostname of 31+ chars plus a name clash |
| 57 | probeRoots reports a false clean when its write fails | obsolete | path roots removed in Task 41a; no `probeRoots` in src |
| 57 | realish swallows ELOOP/EACCES | obsolete | gone with path roots |
| 57 | target.test tautology; Target.machineId has no producer | fixed | `cli/src/target.ts` has no machineId (M1 F11) |
| 57 | load saves implicitly, add/rename/remove do not | accept | callers save explicitly (`controller/host.ts:383,603,687`) |
| 57 | rename to its own name throws | follow-up | `registry.ts:103-107` still does this, and `rename` has no caller: delete it |
| 57 | registry throws bare Error vs PathRootError | obsolete | PathRootError is gone |
| 57 | tests hardcode /tmp; afterEach clobbers ARCHI_CONFIG_DIR | accept | `cli/test/controller/registry.test.ts:10-11`, on purpose |
| 57 | unsupported file names left to preflight | fixed | `archid/src/handover/inventory.ts:204` `path_unsupported` |
| 68 | FleetStateV6 half-frozen | obsolete | `protocol/src/migrate.ts` salvage + liftV8; no V6 schemas left |
| 68 | Second comment says it goes dormant when its window is gone | accept | `protocol/src/state.ts:137`; `reconcile.ts:40-43` deletes a plain second. Comment only |
| 68 | resumed-session status reset duplicated in doRevive/doOpenSecond | accept | `fleet.ts:757,789` |
| 68 | tick overwrites second.cwd unconditionally | accept | `reconcile.ts:48`; a second has no hook-driven cwd to protect |
| 68 | markSeen on a dormant second does not throw | accept | ruled "leave" |
| 68 | isDormant widened | obsolete | no isDormant left |
| 68 | no test reopens a plain dormant second | obsolete | a plain second is deleted, never dormant (`reconcile.ts:40-43`) |
| 75 | phase shadowing, HelloResult unused, Generation/platform spelled twice, no companion types, bare z.string ids, Warning = Blocker, 5 codes unparsed in tests | accept | `protocol/src/handover.ts:18-27,59,140,328,369`, `messages.ts:356`; type hygiene only |
| 75 | TransferManifest invented | obsolete | replaced by TransferManifestV1 |
| 85 | Store.replace has no zero-ops guard | accept | `store.ts:76-81` |
| 85 | promote fsyncs only state.json's dir; double-writes state.json | fixed | `store.ts:92-98` renames, syncs both dirs, publishes without a rewrite |
| 85 | cleanup's sibling-newer rule can delete another process's temp; EPERM in the dir-fsync swallow list | accept | `durable.ts:29,113-124`; worst case ENOENT for the other writer |
| 85 | journal duplicates stages merge; test nits (equal payloads, both clauses, failAfter fd leak) | accept | test and dedupe only |
| 85 | atomic.ts/store.ts import from src/handover/ | accept | `atomic.ts:1` |
| 85 | on persist failure, a mutation recording a world side effect is forgotten | accept | `store.ts:112-115`; reconcile re-attaches live windows |
| 96, 106 | owner.json fleetId never compared with fleet.json's id | follow-up | `ownership/state.ts:28-33` trusts any readable owner.json; one copied from another fleet's home would be taken as this fleet's |
| 96 | unreadable owner.json demoted for good; its rename is unguarded | accept | a gateway record now outranks NO_OWNER (`state.ts:60-63`, `startup.ts:65-91`); the rename at `:38` stays unguarded |
| 96 | migration persist and machine-local writes on a replica before ownership is known | accept | M1 ruling (ledger 113) |
| 96 | record() returns the live object; guardMethod fails open on an undefined class; no frozen-gate test | accept | `state.ts:52-54`; `guard.ts:10` Record<MethodName,…> is enforced by typecheck |
| 98 | activate() memoises a rejected begin | fixed | `fleet.ts:121-124` clears it on rejection |
| 98, 434 | fleet.settle() unbounded and ignores cancellation | accept | `fleet.ts:157-160`; what it waits on has its own timeouts (`links/git.ts:16`, gh 10 s, `scribe/child.ts:21`) |
| 106 | enterStartupMode falls through when mode and journal disagree | accept | `startup.ts:19-27` derives mode from the journal, so the mismatch cannot happen |
| 106 | hold() has no release | fixed | `state.ts:79-81` `unhold`; `destination.ts:499,852` |
| 106 | quarantined journal invisible to handover.status | fixed | `protocol/src/messages.ts:308` `quarantined` |
| 106 | startedAt falls back to updatedAt; platform() maps non-linux to darwin; standalone repair on EACCES/EIO; vacuous listWindows asserts | accept | `service.ts:86`; `api/methods.ts:25`; standalone only |
| 106 | seven unused HandoverDeps | fixed | `service.ts:15-31` (M1 F10) |
| 106 | a source journal at 'aborted' maps to frozen-source; abort must close it before unfreezing | fixed | `source.ts:536-539` closes the journal before `unfreeze` |
| 114, 116, 120 | F9 mapPortablePath containment carried to the first destination writer | obsolete | removed with path roots (41a); claims write to the real path the destination proves (`replicas.ts:268-272`) |
| 120 | unhold needed before activation | fixed | `destination.ts:499,852` |
| 120 | a standalone frozen-source journal surrenders durably | obsolete | a standalone fleet cannot begin a handover (`source.ts:485-487`) |
| 119 | EEXIST re-read of a zero-byte machine.json not retried | accept | `machine.ts:31-32`; first mint only |
| 119 | standalone take-back overwrites a readable owner.json without a .broken copy | accept | `state.ts:34-35` logs the old owner id |
| 119 | Fleet-config button is a silent no-op when fleet.json is absent | accept | `ShellRouter.swift:266-269` logs; the daemon writes fleet.json on start |
| 132 | installer tarball branch untested | fixed | `cli/test/controller/install.test.ts:40,109,118` |
| 132 | extraction precedes version-token validation | fixed | `install-release.mjs:43-48`: `archiveRelease` member check (`release-manifest.mjs:97-112`) and signature before the full unpack |
| 132 | options(argv) duplicated; reproducibility test compares fixtures; empty node/lib survives pruning | accept | cosmetic |
| 132 | old releases never pruned | follow-up | `install-release.mjs:55-110` keeps every release, each with its own Node runtime |
| 132 | a same-version replace names the overwritten dir as rollbackTo | accept | `install-release.mjs:62,107`; dev rebuilds only |
| 132 | `archi setup` without --release throws on a release | must-fix | see the Must-fix section |
| 145 | unit Description takes the fleet name raw; After=network.target inert; flag spelled --no-launchctl on Linux | accept | `archid/systemd/*.in`; `cli/src/commands/setup.ts:122`; profile names are validated |
| 145 | only the private fleet gets a unit | fixed | `archid/src/linux/provision.ts`, `cli/src/commands/fleet-provision.ts`; `linux/setup.ts:170-182` restarts every unit |
| 145 | no re-probe after rollback; tmux.conf written only when absent; 3.4 conf on a Mac | accept | `linux/setup.ts:204-209`; `archid/src/setup.ts:238`; the daemon rewrites tmux.conf on start |
| 147 | each reconnect attempt leaks a forward | fixed | `controller/connection.ts:158-163` cancels the forward |
| 147 | SIGTERM/SIGHUP leave the master to ControlPersist | fixed | `controller/ssh.ts:102-111`, `ControlPersist=no` at `:149` |
| 147 | ssh timeout reported as daemon_down | fixed | `ssh.ts:40-45` classifyExit: a null code is unreachable |
| 147 | remote stderr slice not redacted | accept | `connection.ts:122`; the token travels on stdout only |
| 147 | fake ssh swallows `--` | fixed | Task 14 round 3 |
| 147, 155 | open() polls -O check at 100 ms, and re-checks on every call | accept | `ssh.ts:12,165-172,127` |
| 147 | process.ts slices at a byte boundary; sleep defined twice; host/release parsed but unused | accept | `process.ts:31-35`; `connection.ts:135-139` checks machineId and protocol |
| 155 | two open() calls on a dead cached master can both spawn -M | accept | `ssh.ts:121-139`; per-process sockets (`:88-89`) keep it inside one process |
| 156 | archid setup.ts has a private shq | accept | `archid/src/setup.ts:412` |
| 179 | quarantine rename swallowed; fs not injected; pending map never drops; no backpressure; clearStaleSocket TOCTOU; bin main untested; abort/complete of a never-seen tx id succeed | accept | `gateway/authority.ts:165,174,214,267-274,292-296`; one gateway unit per machine; idempotent retries |
| 182 | pick() cast; digest test title; `archi version` mints machine.json; `host add local` message; archive buffered twice; cache name from URL basename; missing test; serviceOutcome regexes prose; host.ts size | accept | `controller/host.ts:212-213,291-294,466`; `install.ts:101,105-109,130`; the URL comes from the release's own release.json |
| 182 | setup --rollback restarts only on Linux, before the PRIVATE guard | fixed | `cli/src/commands/setup.ts:56-64` kickstarts the launchd agents on a Mac; `current` is machine-wide |
| 188 | serviceOutcome shows the linger action twice | fixed | 7aa2afca; `host.ts:203-215` |
| 192, 197 | ssh.test real-sshd case ran under the fake | fixed | closed by 16b (ledger 197) |
| 205, 276 | authority step label; raw ssh message as action; untested branches; `gateway owner` usage; timeout dup; gateway prefix env; client codes outside AUTHORITY_ERROR_CODES | accept | `gateway/bin.ts:8` default equals the install prefix; `service.ts:34` handles disconnected/timeout |
| 211 | quit has no SIGKILL escalation | fixed | `ControllerProcess.swift:140-143` |
| 211, 215 | stdout/termination race; handler not torn down if run() throws; stderr inherited; owner-changed page notice; isHere side effect; partial-line test; -p redundant; SurfaceManager untestable | accept | `ControllerProcess.swift:115-131` |
| 223 | bare catch on the tick | fixed | `controller/connect.ts:123-129` re-throws everything but retryable |
| 223 | waitOr .then per retry | obsolete | code restructured, no waitOr |
| 223, 234 | askGateway archiBase check; route.json fsync each answer; online after stop; test gaps; blank lines; size; banner says "not reachable" for a gateway failure | accept | `connect.ts:186-193`; `route.ts:27-29`; web `host.ts:87-89` appends the real message |
| 239 | orphaned ssh -M after Stop | fixed | `ssh.ts:102-111`; `commands/host.ts:75` |
| 240 | CLI final line; regexes in three places; host runner in ControllerProcess; reload desync | accept | web `host.ts:72-73` |
| 240 | no machine list in the Machines panel | follow-up | `web/src/HostSetup.tsx:91-142` has name/ssh inputs only, so users must remember registry names |
| 241 | no tty for host add from the app | fixed | askpass (`commands/host.ts:20-31`, `scripts/release/archi-askpass`) |
| 249 | fleetProfile maps .archipelago-private; HostProcess.finish drain race | accept | `ArchiHome.swift:83-85`; archi never creates that home |
| 257 | spawn rejections and empty-stderr master deaths are `other` | fixed | `connect.ts:71-75`; `ssh.ts:169` |
| 259 | afterEach swallows; alive() holds a stale connection | fixed | `connect.ts:101` also checks the forward's port |
| 270 | 17a minors folded into the M2 wave | fixed | M2 F9 |
| 275 | surfaces past MaxSessions | accept | documented, `docs/remote-machines/handover.md` known limitations |
| 283 | rollback restarts archid, not the gateway | fixed | `linux/setup.ts:170-182,209` restartUnits covers every unit; `cli/src/commands/setup.ts:62-63` |
| 284 | a cancelled Add Machine leaves the interactive ssh and its askpass dialog alive | follow-up | `commands/host.ts:28` spawns it outside `spawned`; `ssh.ts:105-108` kills only masters |
| 285, 609 | a master orphaned by SIGKILL/OOM is never reaped | accept | documented, handover.md "A controller killed outright…" |
| 286 | `archi doctor` on an unmanaged Linux checkout fails the gateway row | accept | `doctor.ts:279,369`; Linux dev homes only |
| 287 | pre-F19 tmux servers keep ARCHI_RELEASE_ROOT | accept | `tmux.ts:26` strips it for new servers; only pre-wave test boxes affected |
| 288 | F12's refusal names "disable handover" | fixed | `host.ts:559-566` names `archi handover local` |
| 289 | page's re-show attach to the old owner fails for good | fixed | web `terminals.ts:61-67` retries not_owner once online (the handover_committed residual is under 509) |
| 290 | rollback checklist order | fixed | web `host.ts:18-19` puts rollback in the probe phase |
| 292 | dead forward ends the master; cgroup "left-over process" log; routed status logs in twice; install ok with warning; >10 sessions not re-run | accept | operational only |
| 295 | connectRemote never releases a failed attempt's master ref | accept | `connection.ts:152-165`; the process's exit hook reaps it (`ssh.ts:162-163`) |
| 304 | Git roots from repo fields; transcript destinationPath; one-at-a-time hashing | fixed | discoverGit (`git-graph.ts`); same home path makes destinationPath obsolete; 38b 0145948c hashes eight at once |
| 306 | --terminate-shells help must say it ends unsettled agents | fixed | `commands/handover.ts:595` |
| 312 | rsync specials/devices; .git protect rule; Linux rsync parity; destination path re-validation | fixed | `rsync.ts:123`; `inventory.ts:44`; 37a containers run rsync 3.2.7; M3 F2 |
| 312 | directories, empty dirs and dir modes not recorded | accept | accepted in 38b |
| 313 | excludeMatcher `dir/***` and backslashes; `.env.example` warns; `.env` file root; shared settle/CONTROL; test nits; writeManifest check-then-rename | accept | `inventory.ts:69,92-104` (rsync reads the patterns itself); `manifest.ts:40,304-312` runs inside serial() |
| 313 | buildInventory reaches real fs via resolvePortablePath | obsolete | resolvePortablePath is gone |
| 318 | "Continue waiting" for a blocked agent | fixed | CLI prompter loop `commands/handover.ts:257-263`; sheet decisions |
| 318 | interruptAfterMs not clamped against waitMs | follow-up | `rest.ts:72,175-181`: `--interrupt-after 5m` returns `agent_working` at the 3-minute wait and never interrupts |
| 319 | main slot never takes the pane path; a window closed during the wait is missing from stoppedTerminals | accept | edge cases, fail closed |
| 325 | home.cwd inside handover/ or replicas/; symlink target UTF-8 | accept | secrets unreachable |
| 328 | Codex tool-command rows modelled | fixed | confirmed by the real capture (ledger 356) |
| 333 | destination fleet-home overlap through a symlink only lexical | fixed | destination checks by real path at claim (`replicas.ts:268-272`) |
| 333 | `<fleetHome>/home` symlinked to keys carries keys | accept | contrived |
| 342, 346 | statusline not recognised on named profiles or under /bin/sh | accept | fails closed (a terminate prompt) |
| 345 | SIGKILL to a stored pgid can hit a reused one | accept | `rest.ts:263-271`; needs a pid wraparound within 10 s |
| 347 | terminate misses Codex's own-group helpers | fixed | Task 25 ruling and live check (ledger 392, 420) |
| 350 | `.git` compared byte for byte (index, FETCH_HEAD) | fixed | `divergence.ts:16-22,48`: index compared by what it stages, volatile paths ignored |
| 350 | source must seal at Complete | fixed | `source.ts` runComplete → `seal` |
| 350 | replacing a record is exclusive within one daemon only | accept | one daemon per fleet home (Task 42 lock) |
| 355 | Codex trust prompt | fixed | `codex_trust` warning + activation readiness (M3 Q1–Q2) |
| 355 | Claude version cap at 2.1.280 | obsolete | 41b removed the version maximum |
| 355 | bwrap sandbox on linus-vault; no hooks there | accept | environment |
| 355, 379 | agentAdapters []; probe/installSession wiring | fixed | wired in Tasks 25/26 |
| 361 | archiving a file root uses link+unlink (fails on exFAT/SMB) | accept | `replicas.ts:404-411` fails loudly |
| 361 | inline lists; double hashing | accept | accepted in 38b |
| 372 | claim excludes = rsync excludes, no --delete-excluded, seal shape | fixed | `rsync.ts:123-129`; `transfer.ts:286` |
| 380 | walkJson newline; Codex rewrite spec; repair brief | obsolete | 41b copies sessions byte for byte |
| 380 | scanSession symlink swap; chmod-000 test; one-turn live probe | accept | real sessions ran in M3b/37c |
| 383 | tool-results references keep the source path | accept | documented known limitation (handover.md) |
| 386 | same-path trackedFileBackups | obsolete | file-history not carried; same home path |
| 386 | installSession does not require the transcript; writeDurable mkdirs itself | accept | `durable.ts:61` |
| 398 | a throwing progress write kills the controller | accept | `transfer.ts:321-324` → `progress.ts:64-76`; fails closed, resumable |
| 398 | rsync tests skip silently | fixed | ARCHI_REQUIRE_RSYNC (37a a1dd62b4) |
| 398 | pathProblem accepts `/`; writeFilter error reads as refused; short .env values unredacted | accept | `transfer.ts:120-121`; the claim path is checked by the destination |
| 402, 409, 410 | discoverGit wiring; seal the verified scan; gitdir filter rules | fixed | `source.ts`; `transfer.ts:286` filterRules(excludes, rootKind, keep) |
| 406, 412 | bare-repo cwd → worktree_unresolved; host-named origins; missing-commit HEAD message; GIT_DIR_ENTRIES gaps; anchored excludes; test/structure nits | accept | `git-graph.ts:127,179,237`; `inventory.ts:47-54`; fail closed |
| 406 | tests read the global git config (git-repair.test) | obsolete | git-repair deleted (41b) |
| 407 | seal after repair | obsolete | no repair (`git-import.ts`) |
| 415 | pull blames the source; pull needs an extra pass; far rsync probe ignores cancel, unredacted; unreadable file → external_writer | accept | an unreadable file is caught at freeze by the full manifest |
| 415 | SshMaster.run falls back to a direct connection | fixed | `ssh.ts:56-60,188` `archi-remote.invalid` |
| 434 | refused Abort cancels the freeze; retried abort asks again; stuck between fence and rest; error reuse; 0/0 progress; home root trust; duplicates; test nits | accept | the controller aborts at the gateway first; the destination checks home (41a M1) |
| 435 | tight timeouts; owner.abort order; launchd ssh authority | fixed | 38b timeouts; M3 on-machine passes |
| 438, 448, 451, 461 | symlinked path roots / real-spelled cwds | obsolete | path roots removed; real-path roots + `path_symlinked` (41a) |
| 441, 448 | handover.json FIFO/symlink/size; `.archipelago` link | fixed | M3 F21 (C3); 21b 06bf5d9 |
| 446, 474, 457 | claim RPC, staging, Complete, 8 MiB, remote fleet home, relayed rest events, prepare wire | fixed | `connection.ts:62-63` fleetHome; Task 27 parts; C9, C11 |
| 474 | no relay secret at prepare | obsolete | Phase E deferred |
| 456 | pushContact/scribe runner keep startup copies | accept | Phase E |
| 456 | SessionStart waits hold pool slots | accept | readiness reworked (Q1, M3b R2) |
| 456 | retry with the same landed digest; missing placement as internal; sealAborted | fixed | M3 F22 (C4) |
| 456 | untested hold removal; duplicated helpers; duplicate landed ids | accept | |
| 465 | restedBy vs stoppedTerminals; mobile.get and pusher startup copies | accept | fails closed; Phase E |
| 469 | pusher sends to subscriptions whose login was removed | follow-up | pre-existing on main; Phase E deferred |
| 479 | C5–C11 items | fixed | M3 fix wave F23–F29 |
| 479 | handover.inspect read-class but writes probes | fixed | `guard.ts:84` app-only; 41a F1 read-only folder check |
| 479 | masterFor in-flight sharing; RootProbe.collisions; git --version per call; recovery.test naming; differences() scope | accept | |
| 480 | M3 real-handover checklist | fixed | M3 A/A2 passes |
| 480, 580 | controller on the gateway machine | accept | ruled unsupported (ledger 580) |
| 484 | cancel during a lost Begin; backoff not cancellable | fixed | 23070d66; C10 |
| 484 | "Ready recorded" test | accept | |
| 492 | upgrade checklist order | fixed | web `host.ts:18-19` |
| 509 | sheet edge states: handover_committed/frozen not retried, detached with no badge, attach exit 0 mid-run, blocked after close, second launch dropped | follow-up | web `terminals.ts:67` retries not_owner only; `Handover.swift:187` drops a launch while one is live |
| 510 | tokenise .ho-* on rebase | fixed | done in the squash rebase; the tokens guard passes |
| 511, 523, 527, 538 | C12, C13, C14, C15 | fixed | M3 F30–F32, F14 |
| 516 | --confirm on a TTY; adoptAtStart before teardown; supersede crash re-revives; actions list machines that never held the fleet; no audit for a lost force answer; setGateway drops unknown keys; unreadable controller journal shown absent | accept | `config.ts:127`; `host.ts:599-601`; disaster-recovery edge cases |
| 516 | no risk line when forcing the destination of an unfinished handover | follow-up | the destination runs its pre-handover state and the prepared state is discarded, with no warning |
| 516 | archiExe copies, fleet-recover adapters | fixed | C11 |
| 517 | recover --gateway leaves the phone relay behind | obsolete | no relay exists (Phase E deferred) |
| 518 | gated daemon start waits up to 10 s | fixed | Part B C4 passed |
| 522 | second Ctrl-C with no result; Ctrl-C during owner lookup; pre-checks repeated; runHandover size; HelperServer.record swallows; status/attach shadow host names | accept | |
| 527 | helper races between the status probe and attach | accept | one spawn wide |
| 534 | "Stopped before it began" keyed on phase; commander usage stderr-only | accept | `handover-view.ts:215` |
| 534 | two-starts test in one process | fixed | c30183eb |
| 543 | clock step vs lstart; same-pid re-check; ps failure | accept | |
| 561 | R1–R4 | fixed | ledger 571 |
| 562 | the owner pre-check opens the gateway master before start() | accept | `commands/handover.ts:251-253`; nothing rests; message quality only |
| 563 | mayTakeBack skips the gateway when fleet.json names none | accept | `source.ts:465-467`; host remove refuses open handovers (`host.ts:548-553`) |
| 564 | dangling-link check cost | fixed | 38b 84532f80 |
| 565 | destination's own gateway route first used at claim | accept | fails before commit with abort available |
| 572, 573 | a launcher relays another run's result; too_large offers resume; unparseable journal read as absent | accept | |
| 588 | FarCopy cast; holding() hashes unrecorded roots in serial; probe leftovers | accept | `host.ts:641-663`; `replicas.ts:293-299`; `git-import.ts:16` |
| 588, 602 | dirty-unused-worktree blocker text untrue after O6 | follow-up | `git-graph.ts:236` says a handover back drops the registration, which O6 no longer does |
| 588 | agentChecks on the login PATH; protocol bump | fixed | `host.ts:222-226` unitPath; PROTOCOL_VERSION 17 |
| 598 | lostCommits `stop`; loose rejects test | accept | |
| 602 | abort during Transfer leaves the landed copy unrecorded → false destination_diverged | must-fix | see the Must-fix section |
| 602, 678 | Linux → Mac return leaves Mac symlinks at 0777 | accept | `rsync.ts:123` -p; git ignores link modes |
| 602 | symlinked-root cwd spelled two ways | obsolete | real-path roots (41a) |
| 602 | deluser leaves tmux.sock | accept | test environment |
| 610 | status says "no handover of this fleet is open anywhere" when it could not ask the gateway | follow-up | `controller/recovery.ts:189` |
| 610 | cached committed block after Complete | accept | fence message still accurate |
| 617 | agent outliving tmux; two slot writers; positional optionals; journal lookup repeated; P5 swallows all; zombie test daemon | accept | |
| 622, 635 | window closed at a SessionStart timeout; double NOTICE; trust over-warn; notice placement; look throw; trusts() real fs; flakes | accept | readiness rules (Q1, M3b R2) |
| 640 | Linux daemon lock | fixed | Task 42; `archid/test/home-lock.test.ts` |
| 642 | entity docs and agent.pid | fixed | Task 42 docs root; pid stripped at export |
| 660 | smoke D1–D5 | fixed | F8–F11; Task 42 |
| 667, 746 | e2e and transfer.test flakes | accept | |
| 670 | tmux 3.4 escapes in pane paths | fixed | `tmux.ts:59-74` |
| 674 | N1/N2 | fixed | R5/R6 |
| 677 | a round trip drops the Mac's own Codex `-p` profile | follow-up | `dormancy.ts:38,84` strips it at import, so it cannot come back |
| 680, 684 | install line echoes setup's last line | accept | `host.ts:493`; the probe and rollback steps state the real outcome |
| 680, 684 | flags lost on a daemon death mid-wake; rollback leaves the gateway newer | fixed | ed25ada8 + 36a M3; c90f2c85/2431ce5f |
| 683 | m6 far-side verification | fixed | 38a 53051df9 |
| 689, 692, 694 | 41a review and round items | fixed | 41a rounds 1–2 |
| 692 | exact-string home comparison | accept | fails closed |
| 699 | G1 case folding reads false for letterless folders → misleading external_writer | follow-up | rare Linux → Mac case clash |
| 699 | G2 permission test skips under root | accept | |
| 711 | M5 regular file where a session folder belongs | accept | refused at prepare |
| 717 | m1 test gaps; m2 lock-name squatting; m4 symlink guard text; m5 scan escape | accept | squatting accepted in `docs/security/fleet-handover.md` |
| 717 | m3 agent-profiles/ seeded before the fleet arrives blocks the first handover as occupied | follow-up | a fresh companion's standalone start seeds profiles, then `host enable` rekeys; users whose Mac profiles differ from the bundled set need `--archive` on their first move (seen at M3b) |
| 717 | m6 README Owed list stale | fixed | refreshed (ledger 720) |
| 730, 738 | in-memory trust watch; managed settings; slow-Claude notice; 4-line comment | accept | |
| 738 | n1 a pane's /etc/profile can put a real claude ahead of the test doubles | follow-up | test hygiene: tests must never run the owner's agent CLIs (ledger 733) |
| 751 | G3 island y after Linux → Mac | accept | main's start-up layout step |
| 753 | stale revive on a running terminal; supersede without a failpoint | accept | |
| 768 | ledger 479/484/534 carried into 36b | fixed | 23070d66, c30183eb |
| 780, 781 | two controllers drive one handover; orphaned Begin after abort | accept | documented, handover.md:268-273 |
| 780 | lock race test timing; prepare does not ask the gateway | accept | |
| 788 | vacuous `aborted` check | accept | |
| 788 | an abort rebuilt with only the source unreachable reports aborted while the source stays frozen | follow-up | a second abort frees it; needs a lost journal plus an unreachable source |
| 795, 797 | 37a M1–M6 | fixed | 37b first commits |
| 799 | no GitHub run; qemu left installed; first signed tag needs the key | accept | owed to the owner |
| 799 | gateway crash-loops on a long home | fixed | 730a1c4f `socketTooLong` (`gateway/authority.ts:20-25`) |
| 808 | a live terminal keeps its carried revive until restart | accept | `reconcile.ts:21-24` rebuilds revive when the terminal dies |
| 812 | an upgrade starts a daemon the user disabled; the key guard ignores the signer name | accept | |
| 821, 852 | symlink swap mid-transfer; lock squatting; licence items | accept | accepted risks and owner decisions |
| 835 | N1 recovery under a new user name; N2 messages lack enable | fixed | handover.md:249-262; `inventory.ts:196`, `host.ts:450` |
| 851 | only the opt-in GNU tar test guards the second far verify | follow-up | set ARCHI_TEST_GNU_TAR in CI's integration job |
| 867 | no committed test of the name count for links or single-file roots | follow-up | test gap |

## Matched lines that are not deferred items

303, 310, 324, 378, 401, 443, 454 (rulings whose work was done in the same fix loop); 359, 404 (Important findings fixed in their rounds); 473, 493–495, 548, 557, 577, 775, 841 (dispatch lines naming obligation files); 579, 581, 601, 606, 625, 626, 760, 807 (on-machine reports; defects fixed in their waves); 658, 676 (rulings).
