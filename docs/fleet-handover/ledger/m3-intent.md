# M3 intent — plan Delivery rules, M3 milestone, Tasks 19–29, and the controller rulings that amend them
## Delivery rules

- This is one implementation plan for the whole feature. The milestone gates are mandatory; a later
  phase may remain on the same branch, but it does not start until the earlier gate passes.
- Work in a dedicated worktree. Preserve unrelated dirty files in the main checkout.
- Write the failing test first whenever the task changes executable behavior.
- Use dependency injection for filesystem, process, SSH, rsync, clock and authority operations so
  failure paths are deterministic in unit tests.
- Never run rsync `--delete` against a path that is neither absent/reserved by the transaction nor
  represented by a matching replica record.
- Never activate a destination terminal before the authority Commit.
- Never automatically reactivate the source after Commit.
- Spawn subprocesses with executable plus argv. Shell interpolation is forbidden for SSH, rsync,
  Git, tmux, systemctl and agent commands.
- Persistent JSON writes use a same-directory temporary file, `fsync` where durability matters,
  rename, and mode 0600 for ownership, journal, registry and secret files.
- Keep the existing local-only experience working throughout. New UI stays behind
  `handover.enabled` until the release gate in Task 39.
- Bump the RPC protocol once when the new wire surface lands. During development all components use
  the same checkout; published handover later requires an exact companion release match.
- Commit subjects follow the repository style: one plain sentence, no attribution lines.

## Verification commands

Use the narrow command in each task, then run the milestone command at its gate:

```bash
pnpm vitest run --project protocol
pnpm vitest run --project archid
pnpm vitest run --project cli
pnpm vitest run --project @archipelago/desktop-web
pnpm typecheck
pnpm test
pnpm --filter @archipelago/desktop-web exec playwright test
swift test --package-path apps/desktop/mac
```

Tests that need tmux, sshd, systemd, Tailscale or real agent CLIs are marked integration/manual and
must skip with a named reason when their prerequisite is absent. They must not silently pass.


## Milestones
- **M3 — Tasks 19–29: transactional handover.** Both directions preserve repositories, worktrees,
  sessions and state, with safe abort/resume at every boundary.
- **M4 — Tasks 30–33: stable phone.** The installed phone app and push subscription survive both
  ownership changes.

# Phase D — transfer inventory and transactional handover

### Task 19: Build the immutable transfer manifest and path classifier

**Depends on:** M2, Tasks 6–8

**Files:**

- Create: `packages/archid/src/handover/manifest.ts`, `portable-path.ts`, `inventory.ts`, `hash.ts`
- Create: `packages/archid/test/handover/manifest.test.ts`, `inventory.test.ts`
- Modify: protocol handover schemas if spike fixtures require versioned fields

**Interfaces:** `TransferManifestV1`, `TransferRoot`, `TransferFile`, `PathClassification`,
`buildInventory(state, configs, machineMaps)`; stable canonical JSON digest.

**Steps:**

- [x] Centralize the registry of every absolute protocol/config path field and classify it portable,
  machine-local or forbidden. Add a schema-walk test that fails on an unclassified future path.
- [x] Inventory state snapshot, fleet config, Git graphs, non-Git cwd roots, mission-control cwd,
  uncovered file/folder context refs and exact session artifacts.
- [x] Fold nested roots without losing a separate Git-worktree transformation step.
- [x] Expand excludes deterministically; make custom excludes additive unless defaults are explicitly
  disabled. Flag repository `.env` and optional fleet `.env` in warnings.
- [x] Stream SHA-256 content manifests with mode, size and mtime; exclude host-local cache paths from
  both copy and divergence comparison.
- [x] Produce canonical JSON/digest independent of object insertion order and source traversal order.
- [x] Estimate transfer bytes/free-space need and reject control-character paths unsupported in v1.

**Verify:** `pnpm vitest run --project archid test/handover/manifest.test.ts test/handover/inventory.test.ts`

**Commit:** `A handover begins with one immutable transfer manifest`

### Task 20: Implement safe destination replica records and divergence checks

**Depends on:** Task 19

**Files:**

- Create: `packages/archid/src/handover/replicas.ts`, `divergence.ts`
- Create: `packages/archid/test/handover/replicas.test.ts`, `divergence.test.ts`
- Modify: `packages/archid/src/paths.ts`

**Steps:**

- [x] Store replica records outside repositories, keyed by fleet id plus canonical-path hash, and
  include canonical path, generation, manifest digest and content baseline.
- [x] Reserve absent destination roots for a transaction using an exclusive record before creating
  them. Refuse an existing unowned path even when it looks like the same Git repository.
- [x] Compare an inactive replica to its sealed baseline and list added/removed/changed paths with a
  bounded preview.
- [x] Ignore configured host-local caches but not arbitrary ignored Git files.
- [x] Implement explicit archive-to-timestamped-sibling with collision checks and report the recovery
  path; never call it from non-interactive handover without the flag naming that root.
- [x] Seal new replica records only at transaction Complete; partial ones retain transaction id.

**Verify:** `pnpm vitest run --project archid test/handover/replicas.test.ts test/handover/divergence.test.ts`

**Commit:** `Inactive replicas cannot be overwritten without proving their baseline`

### Task 21: Implement Git graph inventory, rewrite and validation

**Depends on:** Tasks 3, 19, 20

**Files:**

- Create: `packages/archid/src/handover/git-graph.ts`, `git-repair.ts`
- Create: `packages/archid/test/handover/git-graph.test.ts`, `git-repair.test.ts`
- Reuse/refactor: `packages/archid/src/links/git.ts`

**Steps:**

- [x] Convert Task 3's probe helper into typed production discovery using absolute
  `--show-toplevel/--git-common-dir/--git-dir` and porcelain worktree listing.
- [x] Associate characters with used worktrees and include main/common roots even when no character
  stands in the main checkout.
- [x] Detect nested worktrees and submodules without copying a filesystem subtree twice.
- [x] Rewrite copied worktree gitfiles and common-dir registrations through named path mappings;
  prune destination-copy registrations outside the transfer manifest while retaining branch refs.
- [x] Run worktree repair and compare HEAD, branch, porcelain-v2 status, staged blob ids and stash
  refs to the source manifest.
- [x] Surface detached heads, locked worktrees and missing registered roots as explicit supported
  states or blockers—never silently normalize them.

**Verify:** Task 3 fixture plus `pnpm vitest run --project archid test/handover/git-graph.test.ts test/handover/git-repair.test.ts`

**Commit:** `Git repository graphs arrive with every used worktree intact`

### Task 22: Implement versioned agent-session adapters

**Depends on:** Tasks 1, 2, 19

**Files:**

- Create: `packages/archid/src/handover/sessions/types.ts`, `registry.ts`, `claude.ts`, `codex.ts`
- Create: `packages/archid/test/handover/sessions.test.ts`
- Add versioned sanitized fixtures produced by Tasks 1–2

**Interfaces:** `SessionAdapter.supports/discover/rewrite/validate`; adapter registry keyed by agent
kind and tested CLI version range; session manifest entries separate from repository roots.

**Steps:**

- [x] Implement exact-path discovery from the character's recorded `transcriptPath`, honoring
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME` at both ends.
- [x] Include only session-specific JSONL/sidecars/subagent data proven by spikes; do not mirror whole
  user project/session directories.
- [x] Rewrite only adapter-known path-bearing fields and fail closed on a structurally new variant.
- [x] Place artifacts in the destination CLI's expected id lookup layout and update imported
  `agent.transcriptPath` before activation.
- [x] Add preflight capability/version/login/hook checks and missing-transcript blockers.
- [x] Add a distinct repair API that can generate a new-session brief later; do not use it in normal
  handover or claim it is the same conversation.

**Verify:** all versioned fixture tests plus optional real-agent integration probes gated by env.

**Commit:** `Supported agent conversations have versioned handover adapters`

### Task 23: Implement the controller rsync engine and progress journal

**Depends on:** Tasks 14, 19, 20

**Files:**

- Create: `packages/cli/src/controller/rsync.ts`, `transfer.ts`, `progress.ts`
- Create: `packages/cli/test/controller/rsync.test.ts`, `transfer.test.ts`
- Modify: artifact build to include the bundled macOS rsync 3.x

**Steps:**

- [x] Pin/verify a compatible rsync feature set, including protected remote arguments; use the
  bundled Mac binary. Task 4 measured macOS openrsync rejecting `--info=progress2`,
  `--protect-args` and `-s`, splitting remote paths on spaces, and mangling non-ASCII names in
  `--itemize-changes` output, so the system binary is a fallback the doctor flags rather than a
  supported configuration.
- [x] Support local→remote and remote→local from the Mac controller using the same SSH control
  socket and explicit source/destination roles.
- [x] Generate exclude files in transaction temp storage and pass paths/remote shell as argv-safe
  data. Redact `.env` and tokens from logs.
- [x] Allow `--delete` only after the destination reservation/replica proof from Task 20.
- [x] Parse item/byte progress into durable per-root events without treating stderr warnings as
  success; preserve exit codes and partial progress for resume.
- [x] Run a verification pass and re-hash source/target. Retry a changing source at most three times,
  then return an external-writer blocker.
- [x] Make cancellation stop child processes but leave replica/journal data resumable.

**Tests:** spaces/unicode, hostile-looking names, excluded caches, partial exit, disconnect/resume,
source mutation, destination reservation, both transfer directions.

**Verify:** `pnpm vitest run --project cli test/controller/rsync.test.ts test/controller/transfer.test.ts`

**Commit:** `The Mac mirrors a verified fleet replica in either direction`

### Task 24: Classify and rest every terminal safely

**Depends on:** Tasks 7, 10

**Files:**

- Create: `packages/archid/src/handover/processes.ts`, `rest.ts`
- Modify: tmux wrapper to expose pane pid/current command/client detach
- Modify: `packages/archid/src/fleet.ts`, `terminals.ts`
- Create: `packages/archid/test/handover/processes.test.ts`, `rest.test.ts`

**Interfaces:** `ProcessTable`, terminal classifications `agent-ready/agent-working/agent-blocked/
shell-ready/foreground`, explicit choices and settle result.

**Steps:**

- [x] Build a portable process tree snapshot from `ps` output keyed by tmux pane pid; keep parsing
  isolated and fixture-tested for macOS/Linux shapes.
- [x] Classify both terminal slots using agent hook status plus actual foreground descendants.
- [x] Recheck classifications after Freeze, before any interrupt or kill.
- [x] Wait for working agents with events; blocked agents require answer/interrupt/cancel choice.
- [x] Send Escape only for explicit interrupt policy, then wait for hook/process confirmation.
- [x] Terminate a foreground shell only for explicit per-terminal/global choice; record what was
  terminated in the journal.
- [x] Detach external tmux viewers, kill windows only after every chosen terminal settled, capture
  cwd/optional scrollback, and mark both slots dormant with resume commands.
- [x] Abort before killing anything when the post-freeze recheck discovers an unapproved blocker.

**Verify:** `pnpm vitest run --project archid test/handover/processes.test.ts test/handover/rest.test.ts`

**Commit:** `Handover rests agents and refuses unapproved shell processes`

### Task 25: Implement source freeze, abort and export service

**Depends on:** Tasks 19, 22, 24

**Files:**

- Modify: `packages/archid/src/handover/service.ts`
- Create: `packages/archid/src/handover/source.ts`
- Create: `packages/archid/test/handover/source.test.ts`

**Steps:**

- [x] Preflight without mutation: source ownership/version/path/agent/process/Git checks and stable
  blocker codes used by CLI/UI. Task 27 composes these with destination replica/space checks.
- [x] Freeze only for an authority Begin record naming this source/destination/generation.
- [x] Persist surrendered ownership and source journal before returning the immutable manifest.
- [x] Stop background writers, rest chosen terminals and emit per-character progress.
- [x] On pre-commit abort, prove authority still names source at generation, clear surrender, revive
  only terminals handover stopped, restart background work and close the journal.
- [x] Refuse abort when authority is committed or unreachable with a local ready/committed journal.
- [x] Make repeated Freeze/Abort calls idempotent by transaction id.

**Verify:** `pnpm vitest run --project archid test/handover/source.test.ts test/ownership.test.ts`

**Commit:** `A source fleet freezes and aborts without losing its crew`

### Task 26: Implement destination prepare and post-commit activation

**Depends on:** Tasks 20–22

**Files:**

- Create: `packages/archid/src/handover/destination.ts`, `validate.ts`
- Modify: `packages/archid/src/handover/service.ts`, `store.ts`, `fleet.ts`
- Create: `packages/archid/test/handover/destination.test.ts`

**Steps:**

- [x] Accept Prepare only on the named inactive destination, matching transaction/generation and
  manifest digest.
- [x] Rewrite every registered state path, remove tmux ids, install destination transcript paths and
  validate schema/Git/session/replica state without changing active `state.json` or starting tmux.
- [x] Write prepared state/journal durably, provision the relay secret if present, then return the
  proof used by `owner.ready`.
- [x] Accept Activate only after querying/validating committed authority at generation `g+1`.
- [x] Promote prepared state atomically, replace the Store, then revive terminals with bounded
  concurrency. Record each success/error without rolling ownership back.
- [x] Make activate retry skip already-live matching windows and retry only failed/dormant slots.
- [x] Leave plain shells at mapped cwd with a clear restart notice; wait for matching agent
  SessionStart when resuming and report timeout as a character error.

**Verify:** `pnpm vitest run --project archid test/handover/destination.test.ts test/fleet.test.ts`

**Commit:** `A committed destination activates the prepared fleet exactly once`

### Task 27: Implement the end-to-end controller transaction

**Depends on:** Tasks 16, 23, 25, 26

**Files:**

- Create: `packages/cli/src/controller/handover.ts`, `recovery.ts`, `events.ts`
- Create: `packages/cli/test/controller/handover.test.ts`, `recovery.test.ts`

**Steps:**

- [x] Implement Begin→Freeze→Transfer→Verify→Prepare→Ready→Commit→Activate→Complete exactly in
  spec order, checking returned ids/generations/digests at every boundary.
- [x] Persist a controller journal containing routes and progress but no API/relay tokens.
- [x] Define cancellation semantics: before Freeze cancel cleanly; after Freeze call safe Abort;
  after Commit cancel only detaches the observer while activation continues/retries.
- [x] Reconstruct status from controller/source/destination/gateway journals and choose the only safe
  resume action.
- [x] Treat an unknown Commit response as “query authority,” never “abort source.”
- [x] Complete only after destination state is active. Updating the source's cached owner is best
  effort rather than a prerequisite because its surrendered journal already fences it.
- [x] Add table-driven fake-dependency tests for controller death/network failure after every await.

**Verify:** `pnpm vitest run --project cli test/controller/handover.test.ts test/controller/recovery.test.ts`

**Commit:** `The controller advances one recoverable handover transaction`

### Task 28: Add handover CLI, status, resume and disaster recovery

**Depends on:** Task 27

**Files:**

- Create: `packages/cli/src/commands/handover.ts`, `fleet-recover.ts`
- Modify: `packages/cli/src/main.ts`, output formatting, target routing
- Create: `packages/cli/test/handover.test.ts`, `fleet-recover.test.ts`

**Steps:**

- [ ] Add `archi handover <host|local>`, `status`, `--resume`, `--abort`,
  `--interrupt-after`, `--terminate-shells`, per-root archive approval and `--json` NDJSON.
- [ ] Resolve `local` to invoking machine id and reject handover to current owner.
- [ ] Print blockers before Begin; in noninteractive mode exit nonzero rather than prompting.
- [ ] In interactive mode render wait/interrupt/terminate/archive choices with exact affected
  characters/paths.
- [ ] Add `fleet recover --force-owner` only through gateway access, show all journals/generations,
  require typed fleet name/id confirmation, and write a recovery audit record.
- [ ] Ensure Ctrl-C follows Task 27 semantics and reports how to resume.

**Verify:** `pnpm vitest run --project cli test/handover.test.ts test/fleet-recover.test.ts && pnpm typecheck`

**Commit:** `The CLI can hand over, resume and safely recover a fleet`

### Task 29: Add the handover sheet and automatic owner reconnect

**Depends on:** Tasks 18, 28

**Files:**

- Create: `apps/desktop/web/src/HandoverSheet.tsx`, `handover.ts`
- Modify: `Corner.tsx`, `store.ts`, `bridge.ts`, `selectors.ts`, `styles.css`
- Modify: Swift `ControllerProcess.swift`, `AppDelegate.swift`, remote connection manager
- Test: web unit tests and `apps/desktop/web/e2e/handover.spec.ts`

**Steps:**

- [ ] Add bridge commands to start/observe/cancel a detached helper transaction and to reconstruct
  it from journaled NDJSON after app relaunch.
- [ ] Render the five sections—checks, resting, transfer, verify/commit, resume—with stable entity
  rows and byte progress.
- [ ] Before Commit show Abort; after Commit show destination Retry and never rollback language.
- [ ] Present explicit interrupt/terminate/archive decisions and explain their consequences.
- [ ] Close terminal surfaces at source freeze, retain selected character/card/panes locally, then
  resolve owner and reconnect after activation.
- [ ] Show per-character dormant resume errors without hiding a successful fleet move.
- [ ] Prevent accidental dismissal during an active decision; quitting the app detaches but does not
  signal abort.

**Verify:** web unit tests, Playwright handover fixture, manual real SSH handover in both directions.

**Commit:** `The handover sheet carries the fleet through every durable phase`

**M3 gate:** With real tmux/Git/SSH and mocked agents, hand twelve characters and at least three Git
graphs—including nested and sibling worktrees—in both directions. Inject a disconnect/process kill
at every phase. Before Commit only the source may revive; after Commit only the destination may
activate. Compare source/destination file manifests, Git indexes/status/stashes and state snapshots.
Then repeat with one supported real Claude session and one supported real Codex session.

---


## Controller rulings (binding; from the ledger, M2 carries through Task 29)
M2: Ruling: the surfaces past sshd's MaxSessions (10) print one "Session open refused by peer" line and ride their own logins, and a full master turns the helper's tick into a full login — functional, cosmetic; carried to Task 38 (performance audit: a surface-master pool) — costs one stray line in terminals 11+.
M2: parked — rollback (probeOrRollback, setup --rollback) restarts archid but not the gateway, leaving the gateway on the rejected release until its next restart — Ruling: real, minor, nothing in Phase D builds on it; final review triages (one restartUnit per path).
M2: parked — a cancelled Add Machine leaves the interactive ssh child and its askpass dialog alive (F4 kills only spawned masters) — Ruling: real, minor; final review.
M2: parked — per-process sockets mean a master orphaned by SIGKILL/OOM is never reaped (ServerAlive keeps it while the link lives) — Ruling: rare after F4; final review.
M2: parked — `archi doctor` on an unmanaged Linux checkout always fails on the new gateway row (doctor.ts:183) — Ruling: affects Linux dev homes only; final review (skip the row when systemd is "not managed").
M2: parked — tmux servers started before F19 keep ARCHI_RELEASE_ROOT and now survive restarts (KillMode=process) — Ruling: only boxes installed before this wave; final review (set-environment -gu after ensureServer).
M2: parked — F12's refusal action names "disable handover", which has no command or UI — Ruling: the refusal is correct (a remotely owned fleet cannot drop its gateway); Task 28's CLI must give it a real next step — carry into Task 28's dispatch.
M2: parked — connectRemote (connection.ts:131-145) never releases a failed attempt's SshMaster.open ref, so after a retry closing the client sends no -O exit and an all-failed connect never closes its master — Ruling: real, low (the CLI process reaps its masters on exit via F4); final review.
Task 19: Ruling: archid cannot import cli (R2), so buildInventory takes machine path maps as plain data from its caller; session artifacts in Task 19 are each slot's recorded `agent.transcriptPath` (spec "Agent sessions": the manifest uses the recorded transcriptPath) — sidecars and path rewriting are Task 22's adapters, which extend those entries; Git roots are identified and marked for Task 21's worktree transformation, not rewritten — costs nothing if Task 21/22 need a field added.
Task 24: Ruling: runs in parallel with Task 19 on branch fleet-handover-task24 (worktree .claude/worktrees/fleet-handover-task24 from 1168d22) — its files (handover/processes.ts, rest.ts, tmux wrapper, fleet.ts, terminals.ts, tests) are disjoint from Task 19's (handover/manifest.ts, portable-path.ts, inventory.ts, hash.ts, protocol handover schemas); Task 24 keeps its types in archid and makes no protocol change (Task 25/29 lift them to the wire if needed); cherry-picked onto impl after review — costs a possible trivial conflict in packages/archid exports.
Task 19: Ruling: a cwd, home cwd or context folder that is itself a declared path root is mapped, not carried as content — a shell at `~` must not copy the home directory — costs nothing; `file:` browser tabs count as file context refs.
Task 19: Ruling: folded into fix round 1 — a carried root holding either machine's fleet home (other than home.cwd) is a blocker (token/owner.json/node.json/mobile-key/.env would land on the destination's fleet home); symlink targets get the control-character check; a file root's last component is matched as a file in the fold check — each a few lines in code the round touches — costs nothing.
Task 19: Ruling: the path-field registry walks FleetState, FleetConfig, NodeConfig, MachineRecord and TransferManifestV1, not RPC params/results/events — only state, config and the manifest cross machines — costs a registry entry if a future RPC carries a path across.
Task 24: Ruling: folded into fix round 1 — see through an npm-installed Codex wrapper (fixture captured read-only on linus-vault, Codex 0.156.1); agent classes require the pane's actual foreground agent process (a stale record must not rest or Escape a user's job); scrollback capture failures don't fail a settled rest and ps/tmux calls get bounded injectable timeouts; ps runs only on the poll, store wakes reclassify from state — safety and a hung-freeze risk — costs one larger round.
Task 19: fix round 1 implementer DONE_WITH_CONCERNS at 91f9941 (focused 37, archid 814, protocol 106, typecheck clean; GIT_KEEP_RULES exported; overlap with a fleet home blocks in either direction — Ruling: accepted, a cwd inside the fleet home would overwrite the destination's hooks/journal/replicas). Scoped re-review dispatched (opus).
Task 19: Ruling: three re-review minors promoted into fix round 2 — the fleet-home check is lexical, so a cwd symlinked to ~/.archipelago carried `token` (compare real paths); the `home` exemption covers only the exact home.cwd, so a note inside mission control's home blocks the handover; `entry: 'file'` is assumed for every file: URL/file ref, so an explicitly referenced directory named build is folded and never carried — a token leak plus two wrong outcomes in the same function — costs one small round.
Task 24: Ruling: promoted into fix round 2 — see-through descends only from a `node` launcher (a `claude mcp serve` child otherwise reads as the agent and a running Bash tool is missed); each slot is marked dormant carrying its agent as soon as its own kill-window returns (a late SessionEnd otherwise loses the session ids and abort revives a plain shell); Archipelago's own hook/statusline children (by the marker setup writes) are not tool commands — Claude skips its Stop hook on interrupt, so the process tree is the only confirmation and a 17 h statusline child made every interrupted Claude unsettled; blocker code after a failed terminate by class; boundBy clears its timer and kills a timed-out child — the Interrupt-and-carry path is unusable for Claude otherwise — costs one round.
Task 20 and Task 22: Ruling: run in parallel — Task 20 on fleet-handover-impl (BASE e5a0efb: handover/replicas.ts, divergence.ts, archid paths.ts), Task 22 on branch fleet-handover-task22 (worktree .claude/worktrees/fleet-handover-task22 from e5a0efb: handover/sessions/*); the only possible overlap is protocol handover.ts (Task 22 may extend the manifest's session entries additively), resolved at cherry-pick — costs a possible trivial conflict.
Task 22: Ruling: real-agent probes run on this Mac and on linus-vault under his logged-in accounts (he set them up for this), gated by env like the M0 probes; the real check resumes on linus-vault a Mac-started session under his other Claude subscription, both directions for Claude and Codex; Mac Claude 2.1.280 / Codex 0.155.1, remote Claude 2.1.251 / Codex 0.156.1 must all be supported versions — costs a few small agent turns on his accounts.
Task 24: fix round 2 implementer DONE_WITH_CONCERNS at 7e5226e (focused 47, archid 823+1 skip, typecheck clean). Ruling: a user's own lingering hook child (no Archipelago marker) still keeps an interrupted Claude unsettled — fails closed (the user can choose terminate); Task 29's sheet names the lingering process — costs a terminate choice in that case. A kill-window that times out after tmux already closed the window can still lose that one slot's agent to a late SessionEnd — accepted, narrow.
Task 24: Ruling: promoted into fix round 3 — the hook/statusline marker is a bare filename matched anywhere in argv, so a tool command naming agent-hook.mjs/claude-status.mjs is dropped and an interrupted Claude "settles" while it runs (anchor to the installed command); a node-run Claude still descends into a `claude mcp serve` child; Terminate and carry signals only the agent's own group, so its tool commands in their own sessions keep writing into the source after the snapshot (signal their groups too, journaled first) — all three fail open against "failure to settle is a blocker" — costs one round.
Task 24: fix round 3 implementer DONE_WITH_CONCERNS at 8db3e20 (focused 52, archid 828+1 skip, typecheck clean; ProcessTable.read({signal?, scripts?}), new ProcessTable(rows, scripts?), ProcessTable.alive(group)). Ruling: named-profile fleets don't recognise the statusline as Archipelago's because Claude's global settings point at ~/.archipelago/hooks — fails closed (a terminate choice when a long-lived statusline child lingers); carried to the final review — costs a terminate prompt in that case.
Task 24: parked — SIGKILL goes to pgids stored at terminate time and checked by alive() up to 10 s later, so a pgid reused in that window gets SIGKILL — Ruling: real, needs a pid wraparound in 10 s; final review (keep each group's (pid,args) and kill only groups still holding one).
Task 24: parked — a statusline run under /bin/sh or bash 3.2 stays `<shell> -c n=…` (no exec) and isn't recognised, so it counts as a tool command — Ruling: fails closed; final review (accept -lc and the statusCommand shape).
Task 20: Ruling: seal(..., 'source') stays (reviewer flagged it as an extra) — without it the return trip finds the original source copy destination_occupied; the spec's replica rule applies to every root a machine keeps inactive — costs one small function if the spec owner reads it narrower.
Task 23: Ruling: runs in parallel on branch fleet-handover-task23 (worktree .claude/worktrees/fleet-handover-task23 from 9c939f6) — its files (cli/controller/rsync.ts, transfer.ts, progress.ts, tests) are disjoint from Task 20's fix (archid replicas) and Task 22 (archid sessions); cherry-picked onto impl after review — costs a possible trivial conflict.
Task 23: Ruling: the engine takes transfer entries as data (root or exact file: source path, destination path, excludes, the destination's claim for that root); building entries from the manifest, Task 22's session adapters and the destination's claim RPC is Task 26/27's — keeps Task 23 free of Task 22 code and new RPCs — costs an adapter layer in Task 27.
Task 23: Ruling: `--delete` only for a root entry carrying an ok destination claim, and every write goes to the path that claim returned (the destination daemon checked it by real path) — this discharges M1 F9 for writes; the engine never writes to a destination path it mapped itself — costs nothing.
Task 23: Ruling: controller progress is advisory (sheet/CLI display and skipping a root only when its verification still matches); correctness on resume comes from re-running rsync and the verification pass, since the spec says resume reconstructs from the three journals — costs re-checking finished roots on resume.
Task 23: Ruling: an env-gated real-remote rsync test may write into a `mktemp -d` under /tmp on linus-vault (ARCHI_TEST_SSH=100.117.42.24), removed in teardown — transient scratch, not a persistent change; never his home, fleet or services — costs nothing.
Task 21: Ruling: runs in parallel on branch fleet-handover-task21 (worktree .claude/worktrees/fleet-handover-task21 from af58572) while Task 22's review loop and Task 23 run; both 21 and 22 may touch inventory.ts/manifest.ts/protocol handover.ts, so their cherry-picks onto impl may conflict and the controller resolves them mechanically, re-running typecheck and archid after — costs a conflict resolution.
Task 21: Ruling: the Git steps must hold on linus-vault's git 2.43.0 as well as the Mac's (the spike measured 2.55 on macOS only); an env-gated test runs the fixture there in a `mktemp -d` under /tmp, removed in teardown — costs nothing.
Task 22: Ruling: promoted into fix round 1 — installSession accepts any relative path under the agent home, so a manifest naming CLAUDE.md/skills/hooks.json writes there if absent (fails open against the spec's machine-local rule); limit to the adapter's session layout — costs a few lines in the function the round already touches.
Task 22: Ruling: drop file-history (unproven, reaches machine-local files; /rewind to pre-handover checkpoints is not carried); allow-list subagents/*.jsonl|*.meta.json, carry tool-results/* verbatim if a read-only survey of real sessions confirms they are session-specific output, fail closed on any other kind under <id>/ — stop for a ruling if that blocks >5% of recent real sessions — costs /rewind history across a handover.
Task 22: Ruling: tool-results files are carried verbatim and the transcript's references to them (inside tool output text the model saw) keep the source path, so re-reading a full saved output after handover fails and the model has only the preview — rewriting message text is outside "adapter-known path-bearing fields" — costs a re-run of that tool on the destination; Task 39 docs name it.
Task 22: Ruling: a session holding an unknown file kind (e.g. a classifier error dump, 0.5% of recent sessions) blocks until the user removes it — fails closed as the brief requires; Task 29's sheet must name the file — costs a manual delete in rare cases.
Task 25: Ruling: runs on fleet-handover-impl (BASE bdc2744) while Task 21 (own worktree) and Task 23's review run — Task 25's files (handover/service.ts, source.ts, tests) are disjoint from Task 21's (git-graph/git-repair/links/divergence, small inventory edits); Task 21's Git blockers reach source preflight through buildInventory/buildManifest once it is cherry-picked — costs a possible trivial conflict in inventory callers.
Task 25: Ruling: terminate must leave none of the agent's tree behind, including Codex's own-group helpers on the terminal (node_repl, codex-code-mode-host) — fixture-tested; a live check is optional, one small Codex turn on this Mac, cleaned up — costs a small real-agent probe.
Task 23: Ruling: a pass is stable when two consecutive source re-scans are equal and the checksum dry run is clean; the per-root outcome returns the verified scan, and Task 26/27 seal and accept that scan instead of the frozen manifest's file list (the manifest digest stays the transaction's identity) — the spec wants passes that converge once the writer stops — costs Task 26/27 accepting a per-root file list beside the manifest.
Task 23: Ruling: promoted — the ssh placeholder host `archi-remote` could resolve through MagicDNS/search domains when the master is gone, pushing fleet files to an unintended host; use `archi-remote.invalid` — costs nothing.
Task 23: Ruling: `external_writer` joining HandoverIssueCode stays within the single handover protocol bump (Task 8, R9) — all components share one checkout during development — costs nothing.
Task 21: Ruling: an unused registered worktree (not carried, its registration pruned on the destination, so the round trip's --delete removes it from the original .git) blocks preflight when it holds work referenced nowhere else — a detached HEAD not reachable from any ref, or a non-clean status; a clean one stays a `worktree_unused` warning (branch refs and stash live in the common dir) — silent loss of detached commits or staged work on the return trip is what the spec forbids — costs tidying an unused worktree before some handovers.
Task 21: Ruling: unused registrations — directory present: block on non-clean status or a detached HEAD no ref contains; directory gone and unlocked (prunable): block only on an unreachable detached HEAD; directory gone and locked: block (unreadable, and the lock says keep) — stale registrations from a deleted folder are common and must not block on status — costs a blocker for locked worktrees on unmounted media.
Task 26: Ruling: runs on branch fleet-handover-task26 (worktree .claude/worktrees/fleet-handover-task26 from 1ac6d5c) while Task 25's review/fix loop holds impl; both touch handover/service.ts, so the cherry-pick may conflict there and the controller resolves it — costs a conflict resolution, saves the Task 25 review's wall-clock.
Task 26: Ruling: Prepare takes, per root, the verified scan the controller's transfer returned (Task 23) and validates landed files against it, not the manifest's file list; the destination seals with a scan taken after Git repair (Task 21) — the manifest digest stays the transaction's identity — costs a prepare-param field (within the single protocol bump).
Task 26: Ruling: Archipelago never writes the destination's Codex config to pre-trust a folder; a Codex resume that times out waiting for SessionStart names Codex's trust prompt as the likely cause, and a later matching SessionStart clears the character's resume error (the warning itself belongs to preflight, Task 27) — writing a user's global agent config is machine-local territory — costs one answer in the terminal on the first Codex resume.
Task 25: Ruling: both — a pre-rest names-and-existence pass (no hashing) so a freeze-time blocker releases without killing a window, and a post-rest blocker revives exactly stoppedTerminals and releases — costs a second scan pass at freeze.
Task 25: Ruling: platform check built now (handover.json { platforms } → platform_unsupported; Xcode heuristics on a Linux destination → platform_heuristic warning); an optional character "Keep on this machine" field via the existing update RPC and the character_pinned blocker in this round; CLI setter Task 28, UI toggle Task 29 — the spec lists both blockers and only the source can check them — costs an additive state field.
Task 25: Ruling: promoted — mayTakeBack must refuse on any open transaction from this machine past preparing, not only this one (fails open against the single-owner invariant; costs nothing).
Task 25: Ruling: discoverGit wiring into source.ts moves from Task 26's obligations into this round (source.ts is Task 25's file and Task 21 is now on impl) — Task 26 told to skip it — costs nothing.
21b: Ruling: dispatch the symlinked path-root fix (Task 21 carried) and the handover.json read hardening (Task 25 minors: symlink/FIFO/unbounded read, ENOTDIR false blocker) now as one small follow-up on impl while Task 26 runs on its branch — the path-root bug blocks real layouts (~/code → /Volumes) and /tmp test fixtures that Task 26/27 will use, and the FIFO case hangs a frozen fleet — costs one small review.
Task 26: Ruling: activation revives only the terminals the handover rested (a marker rest writes into each dormant slot it creates, carried in the snapshot, or stoppedTerminals in the manifest); a character dormant before freeze stays dormant — mirrors the spec's abort rule; normal startup never auto-revives — costs a small source-side marker.
Task 26: Ruling: promoted — the activate pool's Promise.all can release the serial queue while workers run, so a retry can resume one session twice (fails open against "exactly once"); settle every worker first.
Task 26: Ruling: promoted into round 2 — a phone socket admitted before activation by the destination's stale login list keeps read and write access after adopt (identity checked only at upgrade), so a login removed in the imported fleet.json keeps writing until its socket drops — fails open on who may mutate; close phone viewers the imported list no longer admits — costs a few lines. The two stale "starts every terminal" doc comments ride along (the round touches destination.ts anyway).
Task 27: Ruling: Task 27 may add the archid RPCs the controller needs and nothing exposes yet — the destination replica claim and a destination/source Complete that seals and closes the journals — beside Task 26's prepare/activate in the handover service; the plan's file list names only cli, but the controller cannot reach ReplicaStore otherwise — costs archid edits in a cli task.
Task 27: Ruling: source Complete stays best effort — if the source is unreachable at Complete the gateway is still cleared and the outcome is `complete` with pending: ['source'], finished by a later resume; the unsealed source roots then block a return trip (fails closed) until that resume runs — the spec makes the source's cached-owner update best effort because its surrendered journal fences it, and holding the gateway transaction open would block every future handover on one unreachable machine — costs a resume before the return trip in that case.
Task 27: Ruling: promoted into fix round 1 — a cancel is not honoured before the next step is sent (raceCancel gets an already-issued call): a cancel during destination system.info still sends Freeze, which rests (interrupts agents) and then revives; commit() re-sends Commit after a cancel when the first attempt's fate was unknown — fails open against the user's cancel (the brief: before Freeze cancel cleanly) — check the signal before issuing each step and never re-commit once cancelled.
Task 28: Ruling: split into 28a (the `archi handover` commands, helper, keep-here setter, F12/H1–H4 paths; on impl) and 28b (`fleet recover --force-owner` with the gateway's forced write and daemon adoption; branch fleet-handover-task28b) run in parallel — their files are disjoint except one main.ts line pair — costs a mechanical cherry-pick conflict.
Task 28: Ruling: 28b builds the spec's "on daemon start, a reachable gateway record always wins" (never built; daemons trust owner.json and journals only) plus an on-demand adopt RPC, because a forced record that no daemon reads is not a recovery and a lost owner coming back would split the brain — costs archid edits in a CLI task, within the single protocol bump.
Task 28/29: Ruling: the helper↔app surface is fixed in task-28-29-contract.md before either starts: `--detach` launcher, `attach` over a 0600 Unix socket (NDJSON both ways: events out; `choose`/`cancel` in), a scrubbed events file for relaunch, `handover.status`/`handover.detached` events, daemon rest/activate events relayed; the live socket is the single-controller lock — a decision after an app relaunch needs a channel stdin cannot give, and Swift then only ever spawns processes — costs a socket server in the CLI.
Task 29: Ruling: runs in parallel with 28a/28b on branch fleet-handover-task29 against the contract (web + Swift only) — as 17a/17b did — costs contract drift found at the M3 gate.
M2: Ruling: the upgrade-rollback checklist order (carried to Task 28) moves to Task 29 — the mapping lives in web host.ts, which only Task 29 touches — costs nothing.
Task 28/29: Ruling: contract amended — `--archive` takes the root id a blocker's entity names (blockers carry no path), `--interrupt-after` accepts `0`, `<n>s`, `<n>m` (the app sends `0s`); 28a told mid-task — costs nothing.
Task 28b: Ruling (implementer concern 1, joins the fix round whatever the review says): a reachable gateway record wins over a daemon's cache when its generation is higher, or equal with a different owner while no handover journal is open on that daemon; a lower generation is ignored (a stale gateway never rolls ownership back). A gated fleet (fleet.json names a gateway) with no owner.json starts owning nothing until the gateway names it — a destination daemon started before its first handover would otherwise self-appoint at g0 beside the real owner — amends Task 11's "absent owner.json → local g0 owner" for gated fleets only — costs a read-only start for a gated fleet whose owner.json was deleted while its gateway is unreachable.
Task 28/29: Ruling: only the controller emits `handover.changed`; daemons' `handover.entity` rows are relayed, their `handover.changed` are not — the controller's phase is the one the sheet can trust to move forward, and the daemons' phases duplicate it out of order — contract amended; joins 28a's fix round; Task 29 checked against it at review — costs nothing.
Task 29: Ruling: promoted into round 1 — `superseded` reopens the sheet each launch with no action (same class as the Important; the contract names --forget as its exit); and a pending decision clears only on the app's own answer, a controller handover.changed or a result, never on a relayed entity row (relay order is not guaranteed) — costs a few lines.
Task 28b: Ruling: promoted into round 1 — the floor ignoring an open transaction's g+1 plus "recovered"/exit 0 when the chosen owner did not adopt (a disaster-recovery command claiming a recovery that did not happen), and `--gateway` accepted while the current gateway answers `refused` (two live authorities) — costs a few lines each.
Task 28a: review at 9412878 — Needs fixes: 3 Important, all contract breaks (daemon handover.changed relayed; interactive attach cancels on stdin EOF; a --detach launcher with bad arguments prints no handover.result). ⚠️ resolved: `names` on handover.preflight — Ruling: kept as an optional additive field, documented in the contract; the sheet showing names instead of ids → M3 fix wave — costs nothing. ⚠️ confirmed as a gap: no test proves the route cache a real handover writes (obligation 10) → joins the round.
Task 28a: Ruling: promoted into round 1 — the lock races (a reader's settle() can unlink a live helper's socket, after which a second controller starts: the contract's single-controller lock fails open) and unredacted verdict errors in status/attach (a daemon error may carry its token) — costs a lock file and two redactions.
Task 29: Ruling: contract amended — the controller emits `handover.changed` for the current phase again once a `handover.blocked` decision is answered (a reattached stream otherwise shows an answered decision pending for a whole rest or copy, the sheet undismissable), and `--forget` removes the events file with the journal (a later launch otherwise replays the superseded run) — both CLI-side, sent into 28a's open round 1 — costs a few lines.
Task 28a: Ruling: the prepare decision's missing phase re-emit (re-review out-of-scope) joins round 2 — the amended contract says every answered decision re-emits — costs one line. Contract amended: handover.lock is the single-controller lock, only its holder removes a stale socket, a gone holder never blocks.
Task 28b: carried → M3 fix wave (Ruling: each needs a failed relay plus a restart, or a caller naming an unregistered gateway; the only shipped caller names a registry machine — costs a text change and a route check later): a held-back owner takes the forced record at its next daemon start regardless, and the message doesn't warn to stop the running machine first; a daemon's adopt falls back to the relayed record when the caller names a gateway it has no route to (treat "no route in an existing registry" as a refusal); fleet-recover classes an alive gateway machine with its authority socket down as unreachable, allowing --gateway (a second authority if it restarts).

## Helper ↔ app contract (Tasks 28/29)
# Task 28 ↔ 29 contract: the `archi handover` helper and the Mac app

28a builds the helper (`packages/cli`, on fleet-handover-impl). 29 spawns it and renders it
(`apps/desktop/web`, `apps/desktop/mac`, on its own branch). Neither changes this contract without
the controller; a gap either side finds is reported, not patched on the other's tree.

## Commands

Global `-p/--profile <name>` and `--json` apply to every form, resolved like every other `archi` command.

- `archi handover <host|local> [--interrupt-after <duration>] [--terminate-shells] [--archive <path>]... [--detach]` — start.
- `archi handover --resume [--detach]`, `archi handover --abort [--detach]`.
- `archi handover --forget` — drops a controller journal the gateway has superseded, and the events file with it (see task-28a-carried.md 8).
- `archi handover status` — read-only.
- `archi handover attach` — follow and steer the live helper.

`local` is this machine's stable id. `--archive <root>` takes the root id a blocker's `entity`
names (`kind: "root"`), and fills `HandoverChoices.archiveRoots`. `--interrupt-after` accepts at
least `0`, `<n>s` and `<n>m`; the app sends `0s` for Interrupt and carry.

## Output

With `--json`, stdout carries one `HandoverEvent` per line (`packages/cli/src/controller/events.ts`),
in order, and nothing else; diagnostics go to stderr. A run's last line is `handover.result`, whose
`data` is the `Outcome`. No token appears on stdout, stderr, in the events file or the log.

Added to the vocabulary:

- `{"event":"handover.status","data":<Verdict> & {"helper"?:{"pid":<n>}}}` — `status`'s one line, and
  `attach`'s last line when no helper is live. `Verdict` is `recovery.ts`'s, `safe` saying what
  may follow; `standing: "superseded"` means `--forget` is the way out.
- `{"event":"handover.detached","data":{"pid":<n>}}` — the only stdout line of a `--detach` launcher.
- `handover.preflight`'s `data` may carry `names: { characters: { <id>: <name> }, roots: { <id>: <destination path> } }`,
  for rows and blockers that name entities only by id.

The daemons' own `handover.entity` events (the source's per-character rest rows during `freeze`,
the destination's per-character results during `activate`) are relayed into the stream in the shape
they arrive in, so the sheet has stable character rows while resting. Only the controller emits
`handover.changed`; its phases move forward, and it emits `handover.changed` for the current phase
again once a `handover.blocked` decision is answered, so a replayed stream shows the decision closed.

## Detached helper (the app's path)

`--detach` makes the command a launcher: it starts the transaction in a child in its own session
(stdin and stdout closed, stderr to `<fleetHome>/controller/handover.log`, mode 0600), waits until
the child's control socket accepts, prints `handover.detached` and exits 0. If the child cannot
start (another helper is live, the fleet has no gateway, bad arguments), the launcher prints a
`handover.result` naming why and exits nonzero. The child never cancels for want of an audience: a
decision it needs waits until an attached client answers it.

Quitting the app kills nothing but its `attach` process; the helper goes on.

## Events file and control socket

The helper appends every event it emits to `<fleetHome>/controller/events.ndjson` (mode 0600,
scrubbed like the journal, truncated when a new start/resume/abort begins). It listens on a Unix
socket, mode 0600 in a 0700 directory, at `<fleetHome>/controller/handover.sock` — or, when that
path is too long for a Unix socket, at a hashed path under a 0700 `$TMPDIR` directory, as the ssh
control sockets are. `<fleetHome>/controller/handover.lock` (0600, holding the helper's pid) is the single-controller lock:
the helper takes it before it listens and holds it for its life; start, `--resume`, `--abort` and
`--forget` refuse while a live holder has it, naming `archi handover attach`. Only the lock's holder
removes a stale socket; readers only probe. A holder that is gone (killed, or the machine rebooted)
never blocks the next start.

Socket protocol, NDJSON both ways. Helper → client: every event of this run so far, then each new
one, ending with `handover.result`, then the helper closes the socket. Client → helper:

- `{"choose":<HandoverChoices>}` — answers the pending decision (the last event was
  `handover.blocked`), or, while Freeze is still waiting on agents, asks it again with these choices
  (Task 27's `choose()`: "Interrupt and carry" mid-rest).
- `{"cancel":true}` — exactly Ctrl-C (Task 27's `cancel()`): before Freeze a clean stop, after Freeze
  a safe abort, after Commit only the watcher lets go and the move goes on.

Unknown or malformed lines are ignored. Several clients may attach; each gets the whole stream.

## `archi handover attach`

Connects to the live helper and relays: socket → stdout, stdin → socket. Stdin reaching EOF ends
`attach` (exit 0) and never touches the helper. When no helper is live it prints the events file's
lines, then one `handover.status`, and exits 0. Without `--json` it renders the same stream as the
foreground command would.

## Exit codes

0 when the command did what it was asked (a start or `--resume` that completed, an `--abort` that
aborted, `status`, `attach`, `--forget`, a launcher that detached); 1 otherwise, including blockers
before Begin in a non-interactive run.

## What the app does with it (Task 29)

- Start: spawn `archi [-p P] handover <dest> --json --detach [...]`, then `archi [-p P] handover attach --json`.
- Observe: read `attach`'s stdout lines. Answer a decision or cancel by writing a control line to its stdin.
- Relaunch: spawn `attach --json`; a live helper replays the run, otherwise the events file plus
  `handover.status` rebuild the sheet, whose Resume/Abort run `--resume --json --detach` /
  `--abort --json --detach` and attach again.
- Close terminal surfaces on `handover.changed` → `freeze`; after `handover.result` `complete`
  (also `detached` then a later `complete`), resolve the owner and reconnect through the existing
  `archi connect --json` helper (task-17-contract.md).
