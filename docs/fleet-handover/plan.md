# Fleet Handover Implementation Plan

> **For agentic workers:** Execute this plan in order. Checkbox state is the handoff record. Do not
> begin a task whose `Depends on` tasks are incomplete. Keep each task's tests green and use the
> suggested commit boundary before moving on.

**Goal:** A published Svall app can provision a user-owned Ubuntu machine whose account has the
Mac's home path, view a fleet there, transactionally hand the complete fleet between the Mac and that
machine, keep one writable owner, and resume Claude/Codex conversations. A stable phone URL (Phase E)
and remote port forwarding (Phase F) come after version 1.

**Architecture:** The Mac app/CLI is the attended controller; svalld on either machine is the current
owner; the Linux companion is also a permanent gateway and ownership authority. The controller uses
SSH tunnels for desktop API and tmux access, rsync for verified replicas, and a generation-based
prepare/commit/activate transaction for handover. Paths are identical on both machines, so nothing
the fleet records is rewritten. Durable journals make every pre-commit operation abortable and every
post-commit operation destination-only.

**Tech stack:** TypeScript, Node 22, zod, vitest, React, Zustand, Swift/AppKit/WebKit, GhosttyKit,
tmux 3.5+, Git, rsync, OpenSSH, systemd user services, Tailscale Serve, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-fleet-handover-design.md`

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
pnpm vitest run --project svalld
pnpm vitest run --project cli
pnpm vitest run --project @svall/desktop-web
pnpm typecheck
pnpm test
pnpm --filter @svall/desktop-web exec playwright test
swift test --package-path apps/desktop/mac
```

Tests that need tmux, sshd, systemd, Tailscale or real agent CLIs are marked integration/manual and
must skip with a named reason when their prerequisite is absent. They must not silently pass.

## Milestones

- **M0 — Tasks 1–4: risks retired.** Real fixtures prove the four fragile assumptions or the spec
  and plan are amended before product code commits to them.
- **M1 — Tasks 5–11: identity and fencing.** Existing fleets migrate; a non-owner or frozen daemon
  cannot mutate state, files or tmux.
- **M2 — Tasks 12–18: published remote fleet.** A clean supported Ubuntu account is provisioned and
  the Mac app can use its API and terminals without a source checkout.
- **M3 — Tasks 19–29: transactional handover.** Both directions preserve repositories, worktrees,
  sessions and state, with safe abort/resume at every boundary.
- **M3b — Tasks 40–42: same paths and main's newer data.** The rebased branch hands a fleet over
  with nothing rewritten, carries entity docs, and holds one daemon per fleet on Linux; real Claude
  and Codex resume both ways.
- **M6 — Tasks 36–39: hardening and release.** Fault injection, fresh-machine CI, docs and feature
  rollout meet the release gate.

After version 1:

- **M4 — Tasks 30–33: stable phone.** The installed phone app and push subscription survive both
  ownership changes.
- **M5 — Tasks 34–35: ports.** Remote listeners appear and forward through the desktop SSH master.

Order: M0–M3, M3b, M6, then M4 and M5.

## Planned file map

Protocol:

- `packages/protocol/src/state.ts`, `migrate.ts`, `messages.ts`, `index.ts`
- new `packages/protocol/src/handover.ts`
- tests under `packages/protocol/test/`

Daemon and gateway:

- `packages/svalld/src/config.ts`, `paths.ts`, `store.ts`, `main.ts`, `fleet.ts`, `terminals.ts`
- new `packages/svalld/src/ownership/`
- new `packages/svalld/src/handover/`
- new `packages/svalld/src/gateway/`
- new agent adapters under `packages/svalld/src/handover/sessions/`
- tests under `packages/svalld/test/handover/` and `packages/svalld/test/gateway/`

Controller and CLI:

- new `packages/cli/src/controller/`
- new `packages/cli/src/commands/host.ts`, `handover.ts`, `forward.ts`
- `packages/cli/src/main.ts`, `client.ts`, `target.ts`, `launch.ts`, setup/doctor commands
- tests under `packages/cli/test/controller/`

Mac app and web UI:

- new Swift `ControllerProcess.swift`, `MachineRegistry.swift`, `SSHManager.swift`,
  `RemoteConnection.swift`
- `SvallHome.swift`, `Bridge.swift`, `SurfaceManager.swift`, `AppDelegate.swift`, `Package.swift`
- new web `HostSetup.tsx`, `HandoverSheet.tsx`, `handover.ts`, `ports.ts`
- `Corner.tsx`, `SettingsCard.tsx`, `bridge.ts`, `store.ts`, `api.ts`, `styles.css`

Packaging and operations:

- new `scripts/build-controller.sh`, `scripts/build-companion.sh`, `scripts/release-manifest.mjs`
- new systemd templates under `packages/svalld/systemd/`
- `.github/workflows/ci.yml` and a new release workflow
- `README.md`, `apps/desktop/mac/SMOKE.md`

---

# Phase A — validation spikes

These tasks produce checked-in, sanitized fixtures and executable probes. They do not alter the
normal daemon path. A failed spike is a design result, not an invitation to hide a limitation.

### Task 1: Prove Claude session portability

**Depends on:** none

**Files:**

- Create: `packages/svalld/test/fixtures/handover/claude/README.md`
- Create: `packages/svalld/test/handover/claude-portability.test.ts`
- Create: `scripts/probe-claude-handover.mjs`
- Modify if required: fleet handover spec and this plan

**Steps:**

- [x] Record the exact supported Claude Code version and create a throwaway session in a temporary
  home, including one tool call, one cwd change and one subagent/sidechain when supported.
- [x] Inventory the session JSONL, project slug, sidecars and every absolute path without copying
  credentials or real conversation data into the repository.
- [x] Copy the session to a second temporary home with a different username/path, rewrite only the
  required fields, and run `claude --resume <id>` interactively against the copied session.
- [x] Reduce the result to a sanitized fixture that preserves structural variants and path fields.
- [x] Write a vitest probe that discovers the required files from `transcriptPath`, rewrites the
  fixture, and asserts no source-home path remains in classified path fields.
- [x] Document the supported version range and the exact login/hook check commands discovered by
  the probe. If resume cannot be made deterministic, change the product contract before Task 22.

**Verify:** `pnpm vitest run --project svalld test/handover/claude-portability.test.ts`

**Commit:** `A fixture proves a Claude session can cross homes`

### Task 2: Prove Codex session portability

**Depends on:** none

**Files:**

- Create: `packages/svalld/test/fixtures/handover/codex/README.md`
- Create: `packages/svalld/test/handover/codex-portability.test.ts`
- Create: `scripts/probe-codex-handover.mjs`
- Modify if required: fleet handover spec and this plan

**Steps:**

- [x] Create a throwaway Codex session under a temporary `CODEX_HOME`, including a tool call and cwd
  metadata, then locate it from the session id and hook-provided `transcriptPath`.
- [x] Copy it to a second home/path and prove `codex resume <id>` finds the moved rollout.
- [x] Identify every path-bearing session metadata field and any date/index files required for id
  lookup. Do not assume the rollout alone is sufficient.
- [x] Sanitize a representative fixture and add tests for discovery, rewrite and unsupported shapes.
- [x] Record the supported Codex version range and exact login/hook checks. Amend the design if an
  exact-session resume cannot be supported without copying credentials.

**Verify:** `pnpm vitest run --project svalld test/handover/codex-portability.test.ts`

**Commit:** `A fixture proves a Codex session can cross homes`

### Task 3: Prove linked-worktree reconstruction

**Depends on:** none

**Files:**

- Create: `packages/svalld/test/handover/worktree-portability.test.ts`
- Create: `scripts/probe-worktree-handover.mjs`

**Steps:**

- [x] Build a fixture repository with a main checkout, one nested worktree, one sibling worktree,
  staged/unstaged/untracked changes, a stash and an unused registered worktree.
- [x] Copy the common Git directory and used worktrees to different home prefixes.
- [x] Rewrite `.git` and `.git/worktrees/*/gitdir`, remove only unused registrations from the copied
  metadata, run `git worktree repair`, and prove every used checkout has the same HEAD, index and
  porcelain status.
- [x] Add a submodule fixture and verify that a character inside it is inventoried as its own graph.
- [x] Turn the successful commands and invariants into a test helper for Task 21.

**Verify:** `pnpm vitest run --project svalld test/handover/worktree-portability.test.ts`

**Commit:** `A fixture proves linked worktrees can move safely`

### Task 4: Prove release packaging and stable relay assumptions

**Depends on:** none

**Files:**

- Create: `scripts/spikes/build-companion.mjs`
- Create: `packages/svalld/test/gateway/relay-contract.test.ts`
- Create: `docs/superpowers/plans/fleet-handover-spike-results.md`
- Modify if required: fleet handover spec and this plan

**Steps:**

- [x] Bundle the current CLI/daemon to production JavaScript and run it with a pinned Node runtime in
  a clean Ubuntu container without pnpm or the repository.
- [x] Verify native architecture naming, executable permissions, hook template lookup and mobile
  asset lookup from an installed release directory.
- [x] Put a test WebSocket behind a path-based `tailscale serve` mapping on an available tailnet
  machine, verify identity headers and a `/f/<fleetId>/` PWA scope, and record the manual evidence.
- [x] Prove an owner can establish an outbound authenticated WSS connection to the gateway and that
  bidirectional RPC/terminal-sized frames survive it.
- [x] Record decisions on bundler, Node source/license inclusion, archive layout, release signature,
  Tailscale Serve invocation and relay framing. Update Tasks 12 and 30 with any changed paths.

**Verify:** run the spike script in a clean container and
`pnpm vitest run --project svalld test/gateway/relay-contract.test.ts`

**Commit:** `The release and relay assumptions have executable probes`

**M0 gate:** Review `fleet-handover-spike-results.md`. All four product promises have a proven path,
or the spec and remaining tasks have been narrowed. Delete no fixture merely because a later agent
version changes; add a versioned adapter fixture instead.

---

# Phase B — identity, schemas and ownership fencing

### Task 5: Add fleet and machine identity plus configuration schemas

**Depends on:** M0

**Files:**

- Create: `packages/protocol/src/handover.ts`
- Modify: `packages/protocol/src/state.ts`, `index.ts`
- Create: `packages/protocol/test/handover.test.ts`
- Modify: `packages/svalld/src/config.ts`, `paths.ts`
- Create: `packages/svalld/test/config-migration.test.ts`

**Interfaces:** `MachineId`, `FleetId`, `FleetConfig`, `NodeConfig`, `MachineRecord`, `PathRootMap`,
`OwnerRecord`, `TransactionRecord`; `resolvePaths` gains fleet/node/owner/journal/replica paths.

**Steps:**

- [x] Add UUID-shaped branded zod schemas and ownership/transaction schemas from the spec.
- [x] Split existing config fields: portable home/default/scribe/linear/mobile/handover policy into
  `fleet.json`; host/port/shell into `node.json`.
- [x] Write a one-time migration from `config.json` that backs up the exact original, writes both new
  files atomically, preserves unknown-key failure behavior, and is idempotent after interruption.
- [x] Generate a fleet id for every existing profile without changing its profile name/home.
- [x] Keep a composite runtime config API temporarily so existing Fleet/Mobile callers can migrate
  task-by-task rather than in one unsafe edit.
- [x] Change Settings “Fleet config” to target `fleet.json`; expose `node.json` through diagnostics,
  not the ordinary portable settings button.

**Tests:** defaults, malformed legacy config, partial migration, permissions, private/named fleets,
unknown keys, id stability across restart.

**Verify:** `pnpm vitest run --project protocol && pnpm vitest run --project svalld test/config-migration.test.ts && pnpm typecheck`

**Commit:** `Every fleet and machine setting has a portable home`

### Task 6: Add the machine registry and named path roots

**Depends on:** Task 5

**Files:**

- Create: `packages/cli/src/controller/registry.ts`, `paths.ts`
- Create: `packages/cli/test/controller/registry.test.ts`, `paths.test.ts`
- Modify: `packages/cli/src/target.ts`

**Interfaces:** `MachineRegistry.load/save`, `localMachine`, `resolvePortablePath`,
`mapPortablePath`, longest-boundary root matching, global machine id file.

**Steps:**

- [x] Store the local machine identity and controller registry under
  `~/.config/svall/`, mode 0600, with atomic writes and schema validation.
- [x] Auto-create the local record with `home`; add CRUD for validated remote names and ids.
- [x] Implement lexical normalization, component-boundary matching and realpath containment.
- [x] Represent portable paths as `{ root, relative }`; reject NUL/newline, `..`, missing roots and
  symlink escapes for cwd/transfer roots.
- [x] Add a destination filesystem probe for writable roots, case sensitivity, unsupported
  collisions and free-space reporting.
- [x] Keep `local` as a controller alias resolved to the invoking machine id; never serialize it as
  ownership.

**Tests:** prefix confusion (`/home/a` vs `/home/ab`), longest root, spaces/unicode, symlink escape,
case collisions, missing destination root, corrupt registry recovery.

**Verify:** `pnpm vitest run --project cli test/controller/registry.test.ts test/controller/paths.test.ts`

**Commit:** `The controller knows machines by stable identity and named roots`

### Task 7: Make both terminal slots resumable in state schema v7

**Depends on:** Task 5

**Files:**

- Modify: `packages/protocol/src/state.ts`, `migrate.ts`
- Modify: `packages/svalld/src/reconcile.ts`, `fleet.ts`
- Modify: CLI/web selectors that assume `second.tmux` is required
- Test: `packages/protocol/test/migrate.test.ts`, `packages/svalld/test/reconcile.test.ts`,
  `fleet.test.ts`, affected web tests

**Steps:**

- [x] Introduce one terminal-slot shape with cwd, optional tmux ids, optional agent, unread and
  optional revive metadata; adapt Character primary fields without forcing an all-at-once UI model
  rewrite.
- [x] Make a second terminal dormant rather than deleting its record when its window disappears.
- [x] Capture the second pane cwd during reconciliation and generate its agent resume command.
- [x] Add migration v6→v7 that keeps existing characters and treats an absent second as absent.
- [x] Update revive/close/read/run/seen paths for dormant secondary terminals.
- [x] Ensure imported state can contain no tmux ids while preserving both sessions.

**Verify:** `pnpm vitest run --project protocol --project svalld && pnpm vitest run --project @svall/desktop-web && pnpm typecheck`

**Commit:** `Both terminals survive as resumable character state`

### Task 8: Add ownership and handover protocol types

**Depends on:** Tasks 5, 7

**Files:**

- Modify: `packages/protocol/src/handover.ts`, `messages.ts`
- Test: `packages/protocol/test/messages.test.ts`, `handover.test.ts`

**Interfaces:** `system.info`, `ownership.get`, `handover.preflight/freeze/prepare/activate/abort/status`,
handover events, blocker/warning/entity schemas, manifest summary; `PROTOCOL_VERSION` 9→10.

**Steps:**

- [x] Encode every wire request/result from the spec with discriminated phase/error types.
- [x] Keep full transfer manifests off ordinary events; events carry ids, phases and byte counts.
- [x] Add server wait budgets for freeze/prepare/activate, while controller transfers remain outside
  daemon RPC timeouts.
- [x] Add handshake capability fields without weakening rejection of incompatible protocol.
- [x] Add compile-time exhaustive tests for the event unions and malformed generations/UUIDs.

**Verify:** `pnpm vitest run --project protocol && pnpm typecheck` (handlers intentionally land in
Task 11; if the methods table requires exhaustive handlers, add temporary explicit `not_ready`
handlers rather than weakening the type).

**Commit:** `The protocol names ownership and every handover phase`

### Task 9: Add durable Store replacement and transaction journals

**Depends on:** Task 8

**Files:**

- Modify: `packages/svalld/src/store.ts`
- Create: `packages/svalld/src/handover/journal.ts`, `durable.ts`
- Test: `packages/svalld/test/store.test.ts`, `handover/journal.test.ts`

**Interfaces:** `Store.replace(snapshot)`, `DurableJson<T>`, `HandoverJournal`, prepared-state path,
fault-injectable write stages.

**Steps:**

- [x] Add validated whole-snapshot replacement that emits one correct JSON patch, persists before
  listeners run, and never merges stale destination entities.
- [x] Implement durable JSON writes: exclusive temp, chmod, write, fsync file, rename and fsync
  parent directory where supported. Clean only temp files proven to belong to a completed write.
- [x] Define source/destination journal schemas with transaction id, generation, role, phase,
  manifest digest, stopped terminal ids and error/progress details.
- [x] Store prepared state separately from active `state.json`; promote only after committed
  authority is confirmed.
- [x] On startup, load and surface a valid journal; quarantine a malformed journal without silently
  making the fleet writable.
- [x] Add injected failures after every durability boundary and prove each restart state.

**Verify:** `pnpm vitest run --project svalld test/store.test.ts test/handover/journal.test.ts`

**Commit:** `Fleet snapshots and handover journals survive process death`

### Task 10: Implement local ownership state and the complete mutation fence

**Depends on:** Tasks 8, 9

**Files:**

- Create: `packages/svalld/src/ownership/state.ts`, `guard.ts`
- Modify: `packages/svalld/src/api/methods.ts`, `server.ts`, `main.ts`, `fleet.ts`, `terminals.ts`
- Modify: workspace and scribe/background entry points
- Create: `packages/svalld/test/ownership.test.ts`

**Interfaces:** `OwnershipState.assertOwner(kind)`, `freeze`, `surrender`, `unfreeze`,
`installCommitted`; error codes `not_owner`, `frozen`, `handover_committed`.

**Steps:**

- [x] Classify every RPC method as read-only, mutation, terminal creation or transaction-internal in
  one exhaustive table; CI fails when a new method lacks a classification.
- [x] Guard all fleet, browser, filesystem, terminal and configuration mutations before side effects.
- [x] Stop scribe, link refresh, reconciliation writes and other background writers while frozen;
  queue only derived refresh work that is safe to recompute after unfreeze.
- [x] Refuse `term.attach`, `term.open`, revive and second-terminal creation on non-owners.
- [x] Persist surrendered/frozen state before acknowledging Freeze so a stale source starts
  read-only without the gateway.
- [x] Let read-only diagnosis work on inactive replicas without causing reconciliation to mutate the
  imported snapshot.
- [x] Add a test that enumerates the methods table and invokes every classified mutation against
  inactive and frozen contexts.

**Verify:** `pnpm vitest run --project svalld test/ownership.test.ts test/api.test.ts && pnpm typecheck`

**Commit:** `Only the current unfrozen owner can change a fleet`

### Task 11: Wire the ownership and handover daemon surface

**Depends on:** Tasks 9, 10

**Files:**

- Create: `packages/svalld/src/handover/service.ts`
- Modify: `packages/svalld/src/api/methods.ts`, `server.ts`, `main.ts`
- Modify: `packages/svalld/src/bin.ts`
- Test: `packages/svalld/test/handover/service.test.ts`, `api.test.ts`, `daemon.test.ts`

**Steps:**

- [x] Add `system.info` and `ownership.get` with real machine/fleet/release/schema capability data.
- [x] Add handover handlers delegating to a service with injected planner/session/authority deps;
  phases not implemented until later return typed `not_ready`, never fake success.
- [x] Broadcast ownership/handover entity events from journal changes.
- [x] Start an existing owner normally; start an inactive replica without Fleet reconciliation or
  tmux window adoption.
- [x] On a source journal, remain frozen until controller resume/abort. On a destination committed
  journal, allow only activation retry.
- [x] Preserve local daemon startup and existing API tests when no fleet/gateway record exists by
  initializing existing fleets as local generation-zero owners during migration.

**Verify:** `pnpm vitest run --project svalld && pnpm typecheck`

**Commit:** `svalld exposes ownership without changing local fleets`

**M1 gate:** Run `pnpm test && pnpm typecheck`. Start an existing private and named fleet by hand,
confirm state migration/backup, then use a test owner file to prove inactive and frozen daemons reject
every mutation and start no tmux windows.

---

# Phase C — published companion and remote viewing

### Task 12: Build reproducible Mac controller and Linux companion artifacts

**Depends on:** M1 and Task 4 decisions

**Files:**

- Create: `scripts/build-controller.sh`, `scripts/build-companion.sh`,
  `scripts/release-manifest.mjs`
- Create: `packages/svalld/src/release.ts`
- Modify: root/package package manifests, `apps/desktop/mac/build.sh`,
  `scripts/desktop-install.sh`, `packages/svalld/src/setup.ts`,
  `packages/svalld/src/api/bundle.ts`, `packages/svalld/src/mobile.ts`,
  `packages/cli/src/main.ts`, `.gitignore`
- Create: `packages/svalld/test/release.test.ts`

**Steps:**

- [x] Turn the Task 4 spike into production builds: esbuild bundles per entry point
  (`--external:bufferutil --external:utf-8-validate` and a `createRequire` banner), the pinned Node
  22 LTS tarball whose SHA-256 is checked against `nodejs.org`'s `SHASUMS256.txt` before it is
  staged, phone assets, templates, and a machine-readable release manifest. Archive layout
  `releases/<version>/{bin,lib,node,hooks,home,web-mobile,licenses}`.
- [x] Ship the licence of everything the archive redistributes: Svall's, Node's, and one per
  package esbuild inlined, collected by mapping the metafile's inputs to `node_modules/<pkg>/LICENSE*`
  so a new dependency cannot be forgotten.
- [x] Build architecture-specific archives in a clean staging directory; include no source checkout,
  node_modules, tests, credentials or developer absolute paths. Prune `node/include` and
  `node/lib/node_modules` from the runtime, and tar with `--no-xattrs` under `COPYFILE_DISABLE=1`
  so macOS writes neither Apple extended headers nor AppleDouble members.
- [x] Give every artifact release/protocol/state/transfer/authority and agent-adapter versions.
- [x] Generate SHA-256 digests over every staged file and detached-sign the manifest with
  `ssh-keygen -Y sign -n svall-release`; verify with `ssh-keygen -Y verify` against a pinned
  allowed-signers entry, and make the verifier injectable so tests use an ephemeral key.
- [x] Replace the `import.meta.url` climbs with `release.ts`: `releaseRoot()` reads
  `SVALL_RELEASE_ROOT` exported by the `bin/` shims and falls back to the repository layout for
  `pnpm svalld`. `hooksDir()`, `homeTemplateDir()` and `mobileDistDir()` come from it, and
  `setup.ts`, `api/bundle.ts` and `mobile.ts` become its callers. A published release must not
  reach for the repository or run `pnpm` to build the phone bundle.
- [x] Add a real `svall version` command reporting the release, protocol and runtime versions with
  `--json`; a bare positional must not swallow it as a profile name.
- [x] Bundle matching production `svall` and `svalld`, phone assets and the pinned macOS runtime
  inside `Svall.app`, together with the bundled rsync 3.x Task 23 requires. Install them into
  the per-user releases/current layout and point launchd plus CLI shims at `current`, never at the
  repository or `tsx`.
- [x] Make developer `desktop:install` exercise the same installed-runtime layout while retaining an
  explicit source-tree dev command for `pnpm svalld` and `desktop:dev`.
- [x] Add reproducibility tests that compare archive file lists/modes and run `svall version --json`
  from an unpacked clean artifact.

**Verify:** build both host artifacts locally where possible, run
`pnpm vitest run --project svalld test/release.test.ts`, and inspect archives for source paths.

**Commit:** `Published builds carry a versioned controller and companion`

### Task 13: Implement Linux systemd installation and daemon setup

**Depends on:** Task 12

**Files:**

- Create: `packages/svalld/systemd/svall-gateway.service.in`,
  `svall-svalld@.service.in`
- Create: `packages/svalld/src/linux/setup.ts`, `service.ts`
- Modify: setup/paths/tmux config modules
- Test: `packages/svalld/test/linux-setup.test.ts`

**Steps:**

- [x] Render user units with absolute `current` paths, fleet home argument, resolved PATH, HOME/LANG,
  restart policy and append-only logs.
- [x] Make setup idempotently install hooks/templates/config, daemon profile units and the one global
  gateway unit without writing launchd files.
- [x] Remove `pbcopy` from Linux tmux config and keep all shared tmux behavior identical.
- [x] Install a release by unpacking into `releases/<version>/` named by the archive itself,
  verifying every `SHA256SUMS` line and the signature before anything is activated, then renaming a
  temporary symlink over `current`. Keep the previous release as the rollback target. Task 4's
  `scripts/spikes/install-release.mjs` is the working shape.
- [x] Add `systemctl --user daemon-reload/enable --now/status` wrappers with structured errors.
- [x] Detect linger with `loginctl show-user`; report the exact action but never assume sudo.
- [x] Add uninstall that stops/removes only Svall units/releases and keeps fleet data unless
  explicit purge is requested.

**Tests:** golden units, escaping spaces, named fleets, repeat setup, rollback symlink, missing
systemd/linger, Linux tmux config.

**Verify:** `pnpm vitest run --project svalld test/linux-setup.test.ts`; manual clean Ubuntu install.

**Commit:** `The companion installs as persistent Linux user services`

### Task 14: Implement SSH control-master transport

**Depends on:** Tasks 6, 12

**Files:**

- Create: `packages/cli/src/controller/process.ts`, `ssh.ts`, `connection.ts`
- Create: `packages/cli/test/controller/ssh.test.ts`, `connection.test.ts`
- Modify: `packages/cli/src/client.ts`

**Interfaces:** `SshMaster.open/close/run/forward/cancelForward`, `remoteConnectionInfo`,
`Client.connectEndpoint`; hashed short control sockets under a mode-0700 temp dir.

**Steps:**

- [x] Build an argv-only process runner with bounded stdout/stderr, timeout, cancellation and redacted
  diagnostics.
- [x] Open/check/exit a ControlMaster, handling concurrent open races and stale socket cleanup.
- [x] Execute the companion's connection-info command over SSH and validate fleet/machine/release ids
  before reading its token response.
- [x] Forward remote loopback API to a kernel-selected local port and connect the existing Client to
  that explicit endpoint without caching the token to disk.
- [x] Route ordinary CLI commands through the gateway's current-owner record when a fleet has a
  gateway, retain `--host <name|local>` as an explicit diagnostic override, and keep ungated local
  fleets on the existing direct path.
- [x] Reconnect master and forward after loss with bounded backoff; distinguish auth, host-key,
  version and daemon-down errors.
- [x] Test malicious names/paths as data, never command text, using a fake ssh executable that logs
  argv.

**Verify:** `pnpm vitest run --project cli test/controller/ssh.test.ts test/controller/connection.test.ts`

**Commit:** `The controller reaches a remote daemon through one SSH master`

### Task 15: Implement host add, doctor, upgrade and remove

**Depends on:** Tasks 13, 14

**Files:**

- Create: `packages/cli/src/controller/install.ts`, `host.ts`
- Create: `packages/cli/src/commands/host.ts`
- Modify: `packages/cli/src/main.ts`, doctor/uninstall formatting
- Create: `packages/cli/test/controller/install.test.ts`, `packages/cli/test/host.test.ts`

**Steps:**

- [x] Add `host add/list/doctor/upgrade/remove`, `host enable <name> --fleet <profile>` and NDJSON
  output used by the app.
- [x] Run one interactive SSH probe for host-key/auth establishment, then require batch mode for all
  automated operations.
- [x] Probe OS/arch/home/Tailscale/tmux/Git/rsync/systemd/space; render actionable blockers.
- [x] Download or locate the exact companion asset, verify signed manifest/digest, upload to a temp
  path, install atomically and start/verify gateway service.
- [x] Open an interactive terminal for explicit package installation, linger and agent login/trust;
  never copy credentials or silently run sudo.
- [x] Upgrade by installing a new release, switching `current`, restarting and probing; rollback the
  symlink and restart when the probe fails.
- [x] Remove registry routes only after remote uninstall succeeds or the user explicitly chooses
  “forget unreachable host.” Never delete fleet replicas by default.

**Verify:** CLI unit tests plus a localhost-sshd integration test; `pnpm typecheck`.

**Commit:** `One command provisions and maintains a remote Svall host`

### Task 16: Add gateway authority compare-and-swap service

**Depends on:** Tasks 9, 13, 15

**Files:**

- Create: `packages/svalld/src/gateway/authority.ts`, `server.ts`, `client.ts`, `bin.ts`
- Create: `packages/svalld/test/gateway/authority.test.ts`, `server.test.ts`
- Modify: companion package exports/bin wiring

**Interfaces:** `owner.create/get/begin/ready/commit/abort/complete`; Unix-socket JSON protocol;
atomic per-fleet record and serialized compare-and-swap.

**Steps:**

- [x] Implement pure transition functions first and table-test every valid/invalid phase/generation.
- [x] Serialize mutations per fleet and persist the result before acknowledging.
- [x] Permit create only when fleet id is absent; begin only from current owner/generation; ready only
  with source-freeze proof plus destination prepared digest; commit only from ready.
- [x] Make abort pre-commit only and complete committed only; idempotently return the same record for
  a repeated identical request.
- [x] Expose the authority through a mode-0600 local Unix socket and an `svall gateway owner` SSH
  command. Do not bind it to the tailnet.
- [x] Finish `host enable` by creating the absent generation-zero authority record with the invoking
  Mac as owner; treat an existing record as idempotent only when fleet and owner ids match.
- [x] Quarantine malformed records and refuse ownership changes until repaired.

**Verify:** `pnpm vitest run --project svalld test/gateway/authority.test.ts test/gateway/server.test.ts`

**Commit:** `The gateway is the durable authority for fleet ownership`

### Task 17: Add remote routing to the Mac app

**Depends on:** Tasks 14–16

**Files:**

- Create: Swift `ControllerProcess.swift`, `MachineRegistry.swift`, `SSHManager.swift`,
  `RemoteConnection.swift`
- Modify: `SvallHome.swift`, `Bridge.swift`, `AppDelegate.swift`, `Package.swift`
- Add Swift tests for parsing/process lifecycle

**Steps:**

- [x] Resolve current owner through the bundled helper/gateway on launch; fall back to a cached route
  only under the spec's generation rule.
- [x] Replace synchronous `SvallHome.connection()` with an asynchronous connection manager that can
  emit connecting/online/error/owner-changed states to the page.
- [x] Own the viewer SSH master and API forward for the window lifetime; never expose remote tokens in
  logs or persistent preferences.
- [x] Extend `WebAttach`/SurfaceManager route context so remote terminal commands use `ssh -S … -tt`
  while local ones remain unchanged.
- [x] Rebuild visible surfaces after SSH reconnection and close old surfaces during owner change.
- [x] Disable Finder reveal/open-folder for remote paths and return an explanatory bridge result.

**Verify:** `swift test --package-path apps/desktop/mac`, existing desktop smoke, manual SSH drop.

**Commit:** `The Mac window follows a fleet to its remote owner`

### Task 18: Add host setup and remote-state UI

**Depends on:** Tasks 15, 17

**Files:**

- Create: `apps/desktop/web/src/HostSetup.tsx`, `host.ts`
- Modify: `bridge.ts`, `store.ts`, `SettingsCard.tsx`, `Corner.tsx`, `styles.css`
- Modify: Swift bridge/controller process handling
- Test: web unit tests and `apps/desktop/web/e2e/host.spec.ts`

**Steps:**

- [x] Add typed bridge messages to start/cancel host operations and stream NDJSON step events.
- [x] Build Add Machine as an attended checklist: connect, prerequisites, companion, service, agent
  logins and final probe. Preserve actionable stderr without leaking tokens.
- [x] Show owner machine in the corner and window title; no badge for local owner.
- [x] Render reconnect/offline/version-mismatch states without losing loaded fleet state.
- [x] Add doctor/upgrade/remove actions and confirmation before forgetting an unreachable host.
- [x] Keep all controls behind `handover.enabled`; direct CLI remains available to developers.

**Verify:** `pnpm vitest run --project @svall/desktop-web && pnpm --filter @svall/desktop-web exec playwright test e2e/host.spec.ts`

**Commit:** `A published app can add and inspect its Linux machine`

**M2 gate:** Provision a clean supported Ubuntu x86-64 account from the built app, with no checkout,
Node or pnpm. Create a remote-only test fleet, open twelve terminal surfaces, drop/reconnect SSH, and
verify the daemon survives logout and Mac app exit. Repeat artifact installation on arm64 CI/manual
hardware before release, even if daily development uses one architecture.

---

# Phase D — transfer inventory and transactional handover

### Task 19: Build the immutable transfer manifest and path classifier

**Depends on:** M2, Tasks 6–8

**Files:**

- Create: `packages/svalld/src/handover/manifest.ts`, `portable-path.ts`, `inventory.ts`, `hash.ts`
- Create: `packages/svalld/test/handover/manifest.test.ts`, `inventory.test.ts`
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

**Verify:** `pnpm vitest run --project svalld test/handover/manifest.test.ts test/handover/inventory.test.ts`

**Commit:** `A handover begins with one immutable transfer manifest`

### Task 20: Implement safe destination replica records and divergence checks

**Depends on:** Task 19

**Files:**

- Create: `packages/svalld/src/handover/replicas.ts`, `divergence.ts`
- Create: `packages/svalld/test/handover/replicas.test.ts`, `divergence.test.ts`
- Modify: `packages/svalld/src/paths.ts`

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

**Verify:** `pnpm vitest run --project svalld test/handover/replicas.test.ts test/handover/divergence.test.ts`

**Commit:** `Inactive replicas cannot be overwritten without proving their baseline`

### Task 21: Implement Git graph inventory, rewrite and validation

**Depends on:** Tasks 3, 19, 20

**Files:**

- Create: `packages/svalld/src/handover/git-graph.ts`, `git-repair.ts`
- Create: `packages/svalld/test/handover/git-graph.test.ts`, `git-repair.test.ts`
- Reuse/refactor: `packages/svalld/src/links/git.ts`

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

**Verify:** Task 3 fixture plus `pnpm vitest run --project svalld test/handover/git-graph.test.ts test/handover/git-repair.test.ts`

**Commit:** `Git repository graphs arrive with every used worktree intact`

### Task 22: Implement versioned agent-session adapters

**Depends on:** Tasks 1, 2, 19

**Files:**

- Create: `packages/svalld/src/handover/sessions/types.ts`, `registry.ts`, `claude.ts`, `codex.ts`
- Create: `packages/svalld/test/handover/sessions.test.ts`
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

- Create: `packages/svalld/src/handover/processes.ts`, `rest.ts`
- Modify: tmux wrapper to expose pane pid/current command/client detach
- Modify: `packages/svalld/src/fleet.ts`, `terminals.ts`
- Create: `packages/svalld/test/handover/processes.test.ts`, `rest.test.ts`

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

**Verify:** `pnpm vitest run --project svalld test/handover/processes.test.ts test/handover/rest.test.ts`

**Commit:** `Handover rests agents and refuses unapproved shell processes`

### Task 25: Implement source freeze, abort and export service

**Depends on:** Tasks 19, 22, 24

**Files:**

- Modify: `packages/svalld/src/handover/service.ts`
- Create: `packages/svalld/src/handover/source.ts`
- Create: `packages/svalld/test/handover/source.test.ts`

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

**Verify:** `pnpm vitest run --project svalld test/handover/source.test.ts test/ownership.test.ts`

**Commit:** `A source fleet freezes and aborts without losing its crew`

### Task 26: Implement destination prepare and post-commit activation

**Depends on:** Tasks 20–22

**Files:**

- Create: `packages/svalld/src/handover/destination.ts`, `validate.ts`
- Modify: `packages/svalld/src/handover/service.ts`, `store.ts`, `fleet.ts`
- Create: `packages/svalld/test/handover/destination.test.ts`

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

**Verify:** `pnpm vitest run --project svalld test/handover/destination.test.ts test/fleet.test.ts`

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

- [x] Add `svall handover <host|local>`, `status`, `--resume`, `--abort`,
  `--interrupt-after`, `--terminate-shells`, per-root archive approval and `--json` NDJSON.
- [x] Resolve `local` to invoking machine id and reject handover to current owner.
- [x] Print blockers before Begin; in noninteractive mode exit nonzero rather than prompting.
- [x] In interactive mode render wait/interrupt/terminate/archive choices with exact affected
  characters/paths.
- [x] Add `fleet recover --force-owner` only through gateway access, show all journals/generations,
  require typed fleet name/id confirmation, and write a recovery audit record.
- [x] Ensure Ctrl-C follows Task 27 semantics and reports how to resume.

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

- [x] Add bridge commands to start/observe/cancel a detached helper transaction and to reconstruct
  it from journaled NDJSON after app relaunch.
- [x] Render the five sections—checks, resting, transfer, verify/commit, resume—with stable entity
  rows and byte progress.
- [x] Before Commit show Abort; after Commit show destination Retry and never rollback language.
- [x] Present explicit interrupt/terminate/archive decisions and explain their consequences.
- [x] Close terminal surfaces at source freeze, retain selected character/card/panes locally, then
  resolve owner and reconnect after activation.
- [x] Show per-character dormant resume errors without hiding a successful fleet move.
- [x] Prevent accidental dismissal during an active decision; quitting the app detaches but does not
  signal abort.

**Verify:** web unit tests, Playwright handover fixture, manual real SSH handover in both directions.

**Commit:** `The handover sheet carries the fleet through every durable phase`

**M3 gate:** With real tmux/Git/SSH and mocked agents, hand twelve characters and at least three Git
graphs—including nested and sibling worktrees—in both directions. Inject a disconnect/process kill
at every phase. Before Commit only the source may revive; after Commit only the destination may
activate. Compare source/destination file manifests, Git indexes/status/stashes and state snapshots.
Then repeat with one supported real Claude session and one supported real Codex session.

---

# Phase D2 — same paths and main's newer data

### Task 40: Rebase the branch and smoke the rebased build

**Depends on:** M3

**Steps:**

- [x] Rebase `experimental-remote-sessions` onto main. Keep `handover.enabled` off by default and set
  `PROTOCOL_VERSION` above main's.
- [x] Check whether the M3 environment is still up: the `svall-m3` user on test-server, and the Mac
  temp HOME `/private/tmp/claude-502/m3h2`, which holds a copied Codex `auth.json`. Reuse or remove
  it; anything on test-server needs the owner's yes.
- [x] Run one Mac→Linux→Mac round trip with mocked agents and one real Codex session on the rebased
  build, following `ledger/m3-onmachine-brief.md`.

**Verify:** the verification commands above, then the round trip's report in the ledger.

**Commit:** `The fleet handover branch runs on current main`

### Task 41: Require the same home path and copy what the fleet records unchanged

**Depends on:** Task 40

**Files:**

- Modify: `packages/cli/src/controller/registry.ts`, `paths.ts`, `host.ts`, `handover.ts`, `reach.ts`
- Modify: `packages/svalld/src/handover/inventory.ts`, `portable-path.ts`, `source.ts`,
  `destination.ts`, `validate.ts`, `probe.ts`, `git-graph.ts`
- Modify: `packages/svalld/src/handover/sessions/claude.ts`, `codex.ts`, `records.ts`, `registry.ts`
- Modify: `packages/protocol/src/handover.ts`, `messages.ts`
- Delete: `packages/svalld/src/handover/git-repair.ts` and its test

**Steps:**

- [x] Probe first: copy one real Claude session and one real Codex rollout unchanged into a
  test-server throwaway account whose home is the Mac's home path, and resume each there. The
  account needs the owner's yes. If either resume fails, stop and amend the spec.
- [x] Block Add Machine and preflight when the destination's home differs from the source's, naming
  the commands that create an account with a matching home. A root outside home needs its parent
  present on the destination.
- [x] Remove named path roots: `pathRoots` in the registry and machine records, `{ root, relative }`
  portable paths, and the state path rewrite. State paths travel as they are.
- [x] Record and copy each transfer root at its real path; block a cwd whose real path differs from
  the recorded one.
- [x] Git import prunes unlisted registrations, then validates. Remove the gitfile rewrite and the
  `git worktree repair` step.
- [x] Session adapters copy files byte for byte: remove path rewriting, the record and attachment type
  lists, and the version maximum. Keep file discovery, a minimum version and the missing-file
  blocker.

**Tests:** a destination with a different home blocks at Add Machine and at preflight; a symlinked cwd
blocks; the Task 3 worktree fixture validates without repair; the Claude and Codex fixtures resume
after an unchanged copy; a session written by a CLI newer than every fixture is accepted.

**Verify:** `pnpm vitest run --project protocol --project svalld --project cli`, `pnpm typecheck`.

**Commit:** `A fleet moves between machines with the same home path, and nothing it records is rewritten`

### Task 42: Carry main's newer fleet data and fence the Linux daemon

**Depends on:** Task 41

**Steps:**

- [x] Add the fleet's entity docs (fleet, island, character and repo docs under the fleet home) to the
  inventory. Repo-doc keys hash the repo's absolute path, which no longer changes.
- [x] Strip `agent.pid` and `second.agent.pid` from the exported snapshot.
- [x] Extend the path-field classification test to process-bound fields such as pids and tmux ids,
  and to every entry in the fleet home, so an unclassified one fails CI.
- [x] Make the single-daemon lock hold on Linux: `lockHome` in `packages/svalld/src/main.ts` passes
  macOS's `O_EXLOCK`, which Linux ignores.

**Tests:** a moved fleet's entity docs are found by the same keys on the destination; a live stale
pid on the destination cannot make the reducer ignore a new session; a second daemon for the same
fleet refuses to start on macOS and on Linux (test-server or an `ubuntu:24.04` container).

**Verify:** `pnpm vitest run --project svalld`, then the Linux lock test.

**Commit:** `A moved fleet brings its docs and leaves its pids, and one daemon holds it on Linux`

**M3b gate:** On the rebased build, with a test-server account whose home is the Mac's, hand a fleet
with mocked agents, one real Claude session and one real Codex session Mac→Linux→Mac. Both
conversations resume under their original session ids, entity docs arrive, and a second daemon on
Linux refuses to start. The real-Claude run needs the owner for the Mac keychain. Then the owner's
by-eye pass in the built app: Add Machine, the handover sheet, and terminal re-attach after an SSH
drop.

---

# Phase E — stable phone gateway (after version 1)

Phases E and F start after the M6 release gate. When they do, Task 37 gains a CI job for the relay
through a TLS/Tailscale-header test proxy, and Tasks 38 and 39 gain their phone and port items.

### Task 30: Serve path-scoped fleet PWAs from the gateway

**Depends on:** M3 and Task 4 relay decisions

**Files:**

- Create: `packages/svalld/src/gateway/http.ts`, `mobile-assets.ts`, `fleet-routes.ts`
- Modify: mobile Vite config/service worker/manifest generation
- Modify: existing `packages/svalld/src/mobile.ts`
- Create: `packages/svalld/test/gateway/mobile-assets.test.ts`

**Steps:**

- [ ] Move production mobile assets into the companion/gateway release; remove runtime pnpm builds
  from published `mobile on`.
- [ ] Serve each fleet under `/f/<fleetId>/` with correct base URLs, manifest `start_url/scope`, icons
  and service-worker registration confined to that path. Tailscale Serve strips its mapping prefix
  before proxying, so every absolute URL the gateway emits comes from a configured public base, not
  from `req.url`.
- [ ] Configure one Tailscale Serve HTTPS mapping for the gateway service rather than one special port
  per fleet: `tailscale serve --bg --yes --set-path <path> http://127.0.0.1:<port>`, removed with
  `tailscale serve --https=443 --set-path <path> off`, never the bare `--https=443 off` that drops
  every handler on the port.
- [ ] Add gateway fleet-route records with enabled/name/login policy/current generation; update them
  from authenticated controller/owner channels only.
- [ ] Keep legacy owner-local mobile serving available during migration but prevent both URLs being
  presented as canonical after gateway enablement.
- [ ] Return a stable offline shell when no owner relay is connected.

**Verify:** gateway asset tests plus mobile build; manual Add to Home Screen from the gateway URL.

**Commit:** `The gateway gives every fleet one stable phone origin`

### Task 31: Implement the authenticated owner relay and phone RPC proxy

**Depends on:** Tasks 16, 30

**Files:**

- Create: `packages/svalld/src/gateway/relay-server.ts`, `relay-protocol.ts`
- Create: `packages/svalld/src/relay/client.ts`
- Modify: `packages/svalld/src/main.ts`, `api/server.ts`, phone viewer handling
- Create: `packages/svalld/test/gateway/relay.test.ts`, `packages/svalld/test/relay-client.test.ts`

**Interfaces:** multiplexed frames for register/RPC/response/event/terminal/heartbeat; fleet relay
secret; signed/contained viewer identity; one active relay matching authority generation.

**Steps:**

- [ ] Generate the relay secret on first gateway mobile enable, store it mode 0600 and provision it
  to current/future owners outside portable state and rsync. Derive the viewer-identity signing key
  from it rather than adding a second provisioned secret.
- [ ] Have an owner connect outbound over WSS, authenticate fleet/machine/generation and reject a
  second owner or stale generation.
- [ ] Authenticate phone requests only through Tailscale Serve identity, enforce `mobile.logins`,
  and strip/ignore client-supplied identity headers.
- [ ] Proxy the existing mobile RPC surface and terminal binary/base64 stream with request ids,
  cancellation, backpressure limits and disconnect cleanup.
- [ ] On the owner, trust forwarded login only inside the authenticated relay context; ordinary API
  sockets cannot claim it. Task 4's contract test covers the gateway side only, so this needs its
  own test: an ordinary API socket presenting a relay-shaped identity frame must be refused.
- [ ] Heartbeat/reconnect with bounded backoff; show the stable offline page rather than redirecting
  to an owner-specific origin.

**Verify:** relay contract/unit tests, mobile terminal e2e through gateway, stale-generation attack
test.

**Commit:** `The phone securely follows the current fleet owner`

### Task 32: Move push identity and notifications to the gateway

**Depends on:** Task 31

**Files:**

- Move/refactor: `packages/svalld/src/push/` into gateway-owned services where appropriate
- Modify: gateway paths/main/relay event handling and mobile push client
- Create: `packages/svalld/test/gateway/push.test.ts`

**Steps:**

- [ ] Store VAPID key and subscriptions under gateway fleet data, preserving endpoint/status/login
  fields and mode 0600.
- [ ] Keep the phone public key and subscribe/get/unsubscribe RPCs at the stable gateway origin.
- [ ] Forward owner state/status events with generation/session identity; gateway derives blocked/done
  pushes and deduplicates across relay reconnect/handover.
- [ ] Migrate a legacy subscription only by asking the phone to subscribe at the new stable origin;
  never copy a subscription tied to a different origin and claim it works.
- [ ] Ensure an inactive/old owner cannot emit pushes after gateway Commit.
- [ ] Keep push delivery independent of a currently open phone WebSocket.

**Verify:** gateway push tests with fake sender, handover/reconnect dedup test, manual lock-screen push.

**Commit:** `Push subscriptions stay with the fleet gateway`

### Task 33: Finish mobile migration UI and end-to-end coverage

**Depends on:** Tasks 30–32

**Files:**

- Modify: desktop/mobile settings panels, `Mobile.tsx`, mobile boot/routing/service worker
- Modify: CLI mobile command
- Create/modify: `apps/desktop/web/e2e/phone-handover.spec.ts`, svalld mobile tests
- Modify: README/SMOKE draft sections

**Steps:**

- [ ] Make `mobile on` provision the stable gateway route and show its URL/QR; explain that the
  gateway is required and report owner relay status separately from serving status.
- [ ] Offer a one-time migration notice for users with the old owner-specific PWA.
- [ ] Preserve fleet label/icons and subscription UI under the path-scoped scope.
- [ ] Test owner local, owner gateway, handover both ways, owner offline, gateway restart and relay
  reconnect without changing the URL.
- [ ] Test login allowlist enforcement and concurrent phones through the proxy.

**Verify:** all mobile unit/e2e tests and manual PWA/push acceptance.

**Commit:** `The fleet phone app keeps its URL through handover`

**M4 gate:** Install the PWA once, subscribe to blocked/done, hand the fleet Mac→gateway→Mac, and
prove the same URL, service-worker scope and push subscription still work. Turn off the owner and
verify the same URL shows offline; restart it and verify automatic recovery.

---

# Phase F — remote port discovery and forwarding (after version 1)

### Task 34: Discover and attribute remote listening ports

**Depends on:** M3

**Files:**

- Create: `packages/svalld/src/ports/discover.ts`, `process-tree.ts`, `service.ts`
- Modify: protocol messages/events, daemon main/viewer lifecycle, `char.show`
- Create: `packages/svalld/test/ports.test.ts`, protocol tests

**Steps:**

- [ ] Parse `ss -ltnpH` through fixtures for IPv4/IPv6/wildcard/loopback and missing PID metadata.
- [ ] Attribute a listener only when its PID is in a live pane's process tree; deduplicate the same
  socket seen through multiple address rows.
- [ ] Sample only while a desktop viewer requests port discovery; debounce events and clear vanished
  processes/owner changes.
- [ ] Keep ports runtime-only rather than durable FleetState; expose them in `char.show` from the
  runtime service.
- [ ] Add `ports.changed` event and a manual-port validation path for missed/containerized listeners.

**Verify:** `pnpm vitest run --project protocol --project svalld` focused on port tests.

**Commit:** `svalld attributes live listening ports to their characters`

### Task 35: Forward ports through SSH and expose honest URL mappings

**Depends on:** Tasks 14, 34

**Files:**

- Create: `packages/cli/src/controller/forwards.ts`, `packages/cli/src/commands/forward.ts`
- Create: `apps/desktop/web/src/ports.ts`
- Modify: Swift SSH manager/bridge, character cards/strips/browser URL opening, styles
- Test: CLI/web/Swift tests and `apps/desktop/web/e2e/ports.spec.ts`

**Steps:**

- [ ] Add/cancel forwards through the existing SSH master, binding only `127.0.0.1`; share a tunnel
  for duplicate remote ports.
- [ ] Prefer the same local number, fall back to a kernel-selected free port and retain the mapping
  across SSH master reconnect within the app session.
- [ ] Render `:remote` or `:remote → :local` chips and open the mapped local address.
- [ ] Rewrite known in-app localhost links when opening them; never claim an external literal URL
  works after a collision.
- [ ] Add `svall forward <char> <port>` and `--list`; define CLI lifetime/Ctrl-C cleanup when no app
  master owns the tunnel.
- [ ] Clear mappings on owner change/process disappearance and recreate only still-live listeners.

**Verify:** unit tests plus a real remote HTTP server, collision, SSH drop and cleanup acceptance.

**Commit:** `Remote character ports open through the desktop SSH connection`

**M5 gate:** Start two remote servers, including one colliding with a local listener. Both chips open
the intended server, the collision is visibly remapped, SSH reconnect restores mappings, and owner
handover clears obsolete ports rather than forwarding dead processes.

---

# Phase G — hardening, release and rollout

### Task 36: Add systematic fault injection and single-owner model tests

**Depends on:** M3b

**Files:**

- Create: `packages/svalld/test/handover/faults.test.ts`
- Create: `packages/cli/test/controller/faults.test.ts`
- Create: `packages/svalld/src/handover/failpoints.ts` enabled only in tests/dev

**Steps:**

- [x] Enumerate failpoints before/after every authority write, local journal write, terminal kill,
  rsync root, verification, prepared-state write, Commit response, state promotion and activation.
- [x] For each failpoint restart controller/source/destination/gateway from disk and derive the legal
  action. Assert at most one side can create/input/attach a terminal.
- [x] Add concurrent Begin/Resume/Abort calls and duplicate/reordered response tests.
- [x] Add gateway loss before Begin, during Freeze, after Ready, after Commit and during Complete.
- [x] Add stale source cache plus surrendered journal startup test—the highest-risk split-brain case.
- [x] Make the failpoint list exhaustive through a registry so new transaction boundaries require a
  test case.

**Verify:** focused fault suites repeated with randomized failpoint order, then `pnpm test`.

**Commit:** `Failure injection proves the fleet keeps one writable owner`

### Task 37: Add real two-machine integration and fresh-install CI

**Depends on:** Task 36

**Files:**

- Create: `scripts/integration/fleet-handover.sh`, fixture fake agents, sshd setup
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`
- Create: integration documentation under `docs/`

**Steps:**

- [x] Run local↔Ubuntu handover with isolated homes, real sshd/rsync/tmux/Git and fake hook-speaking
  agents in CI; assert manifests, worktree indexes, state and ownership records.
- [x] Run controller-kill/network-drop scenarios at representative pre/post-commit boundaries.
- [x] Build and install companion archives into clean x86-64 and arm64 environments with no Node or
  checkout; verify systemd units and upgrade/rollback.
- [x] Cache no user credentials in artifacts/logs and scan release archives for secrets/source paths.
- [x] Upload signed manifests/artifacts only after all architecture and integration jobs pass.

**Verify:** release workflow dry run from an unsigned test tag and manual supported-host run.

**Commit:** `Release CI installs and hands over a fleet on clean machines`

### Task 38: Security, performance and destructive-operation audit

**Depends on:** Tasks 36, 37

**Files:**

- Modify implementation/tests wherever audit finds issues
- Create: `docs/security/fleet-handover.md`
- Create: performance fixture/benchmark script

**Steps:**

- [x] Threat-model SSH aliases, remote argv, malicious repository file names, symlinks, stale
  authority and destination-path confusion.
- [x] Verify tokens/secrets never enter argv, logs, NDJSON, state, manifests or repository roots.
- [x] Audit every delete/rename/archive target back to a validated registry/manifest record and add a
  regression test for each destructive path.
- [x] Benchmark first and incremental transfer on small, large-file and many-file repositories;
  bound hashing memory and event volume.
- [x] Verify terminal backpressure and API payload limits under large output.
- [x] Confirm licenses/notices for bundled Node, rsync/bundler outputs and other release contents.
- [x] Review service permissions, file modes, Tailscale exposure and uninstall retention.

**Verify:** security regression suite, benchmark recorded in the doc, archive/license inspection.

**Commit:** `Fleet handover is bounded, auditable and safe around user data`

### Task 39: Documentation, migration, smoke test and feature rollout

**Depends on:** Task 38

**Files:**

- Modify: `README.md`, `apps/desktop/mac/SMOKE.md`
- Create: published setup/troubleshooting/recovery docs
- Modify: settings/first-run copy and release notes
- Remove feature gate only at final step

**Steps:**

- [x] Document supported hosts, Add Machine prerequisites including the same home path,
  data/secrets transferred, agent-version support and process restart semantics.
- [x] Document every blocker/error code with safe recovery, including destination divergence,
  pre-commit abort, post-commit activation retry and force-owner disaster recovery.
- [x] Add migration notes for `config.json`, source-checkout CLI shims and named fleets; prove
  downgrade behavior or state clearly when downgrade requires restoring backup.
- [x] Expand SMOKE with provisioning, both handover directions, worktrees, agent resume, foreground
  blocker and network failure.
- [x] Run the complete manual acceptance from the spec on release artifacts, not the source checkout.
- [ ] Remove `handover.enabled` only after M0–M3b and M6 evidence is attached to the release; keep a
  remote kill switch only if it does not make an owner dependent on a cloud service.

**Verify:** `pnpm test && pnpm typecheck && pnpm --filter @svall/desktop-web exec playwright test`,
Swift tests/build, release workflow, full manual smoke.

**Commit:** `Fleet handover is documented and ready for published use`

**M6 release gate:** Ship only when all of the following are true:

- fault injection has no path to two writable owners;
- source/destination divergence cannot be silently overwritten;
- all Claude/Codex fixtures, live probes and manual sessions resume in both directions;
- linked worktrees retain HEAD, branch, index, stash and working changes;
- fresh companion provisioning passes on every advertised Ubuntu architecture;
- remote terminal reconnect behavior passes smoke;
- release archives contain no checkout dependency, credential or developer path;
- the direct local-only app remains green and requires no gateway until the user enables handover.

---

# Cross-task acceptance matrix

The implementing worker keeps this table current as tasks land. A ✓ means the coverage is required,
not that it has already passed:

| Scenario | Unit | Integration | Manual | Owning task |
|---|---:|---:|---:|---:|
| Legacy config/state migration | ✓ | ✓ | ✓ | 5, 7 |
| Inactive/frozen mutation fence | ✓ | ✓ | ✓ | 10, 11 |
| Clean Ubuntu provisioning | ✓ | ✓ | ✓ | 12–15, 37 |
| Remote API/tmux reconnect | ✓ | ✓ | ✓ | 14, 17 |
| Same home path/symlink/case safety | ✓ | ✓ |  | 19, 41 |
| Entity docs travel, pids stay | ✓ | ✓ | ✓ | 42 |
| One daemon per fleet on Linux | ✓ | ✓ |  | 42 |
| Destination divergence/archive | ✓ | ✓ | ✓ | 20 |
| Linked worktrees/submodules | ✓ | ✓ | ✓ | 3, 21 |
| Claude/Codex exact resume | ✓ | optional real | ✓ | 1, 2, 22, 41 |
| Foreground process blocker | ✓ | ✓ | ✓ | 24, 25 |
| Abort before Commit | ✓ | ✓ | ✓ | 25, 27 |
| Crash/unknown response after Commit | ✓ | ✓ | ✓ | 26–28, 36 |
| App closes/reopens mid-move | ✓ | ✓ | ✓ | 27–29 |
| Stable phone URL and push (after v1) | ✓ | ✓ | ✓ | 30–33 |
| Port collision/reconnect (after v1) | ✓ | ✓ | ✓ | 34, 35 |
| Signed upgrade and rollback | ✓ | ✓ | ✓ | 12, 15, 37 |
| Force-owner disaster recovery | ✓ | ✓ | ✓ | 16, 28 |

# Final implementation handoff

Before calling the plan complete:

- [ ] Every task checkbox and milestone gate has evidence or an explicit follow-up issue.
- [ ] The final protocol/state/transfer/authority versions are recorded in the release manifest.
- [ ] The spec matches implemented behavior; discovered constraints are not left only in code.
- [ ] Temporary spike scripts are either promoted to maintained diagnostics or clearly marked manual.
- [ ] Test fixtures contain no user conversation, credentials, machine names or absolute home paths.
- [ ] `git status` contains only intended feature files; unrelated user changes remain untouched.
- [ ] The release artifacts, not merely the source tree, pass the published installation and full
  handover smoke test.
