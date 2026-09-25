# M2 intent — plan Delivery rules, M2 milestone, Tasks 12–18, and the controller rulings that amend them
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

## Milestones

- **M0 — Tasks 1–4: risks retired.** Real fixtures prove the four fragile assumptions or the spec
  and plan are amended before product code commits to them.
- **M1 — Tasks 5–11: identity and fencing.** Existing fleets migrate; a non-owner or frozen daemon
  cannot mutate state, files or tmux.
- **M2 — Tasks 12–18: published remote fleet.** A clean supported Ubuntu account is provisioned and
  the Mac app can use its API and terminals without a source checkout.
- **M3 — Tasks 19–29: transactional handover.** Both directions preserve repositories, worktrees,
  sessions and state, with safe abort/resume at every boundary.
- **M4 — Tasks 30–33: stable phone.** The installed phone app and push subscription survive both
  ownership changes.
- **M5 — Tasks 34–35: ports.** Remote listeners appear and forward through the desktop SSH master.
- **M6 — Tasks 36–39: hardening and release.** Fault injection, fresh-machine CI, docs and feature
  rollout meet the release gate.

### Task 12: Build reproducible Mac controller and Linux companion artifacts

**Depends on:** M1 and Task 4 decisions

**Files:**

- Create: `scripts/build-controller.sh`, `scripts/build-companion.sh`,
  `scripts/release-manifest.mjs`
- Create: `packages/archid/src/release.ts`
- Modify: root/package package manifests, `apps/desktop/mac/build.sh`,
  `scripts/desktop-install.sh`, `packages/archid/src/setup.ts`,
  `packages/archid/src/api/bundle.ts`, `packages/archid/src/mobile.ts`,
  `packages/cli/src/main.ts`, `.gitignore`
- Create: `packages/archid/test/release.test.ts`

**Steps:**

- [x] Turn the Task 4 spike into production builds: esbuild bundles per entry point
  (`--external:bufferutil --external:utf-8-validate` and a `createRequire` banner), the pinned Node
  22 LTS tarball whose SHA-256 is checked against `nodejs.org`'s `SHASUMS256.txt` before it is
  staged, phone assets, templates, and a machine-readable release manifest. Archive layout
  `releases/<version>/{bin,lib,node,hooks,home,web-mobile,licenses}`.
- [x] Ship the licence of everything the archive redistributes: Archipelago's, Node's, and one per
  package esbuild inlined, collected by mapping the metafile's inputs to `node_modules/<pkg>/LICENSE*`
  so a new dependency cannot be forgotten.
- [x] Build architecture-specific archives in a clean staging directory; include no source checkout,
  node_modules, tests, credentials or developer absolute paths. Prune `node/include` and
  `node/lib/node_modules` from the runtime, and tar with `--no-xattrs` under `COPYFILE_DISABLE=1`
  so macOS writes neither Apple extended headers nor AppleDouble members.
- [x] Give every artifact release/protocol/state/transfer/authority and agent-adapter versions.
- [x] Generate SHA-256 digests over every staged file and detached-sign the manifest with
  `ssh-keygen -Y sign -n archipelago-release`; verify with `ssh-keygen -Y verify` against a pinned
  allowed-signers entry, and make the verifier injectable so tests use an ephemeral key.
- [x] Replace the `import.meta.url` climbs with `release.ts`: `releaseRoot()` reads
  `ARCHI_RELEASE_ROOT` exported by the `bin/` shims and falls back to the repository layout for
  `pnpm archid`. `hooksDir()`, `homeTemplateDir()` and `mobileDistDir()` come from it, and
  `setup.ts`, `api/bundle.ts` and `mobile.ts` become its callers. A published release must not
  reach for the repository or run `pnpm` to build the phone bundle.
- [x] Add a real `archi version` command reporting the release, protocol and runtime versions with
  `--json`; a bare positional must not swallow it as a profile name.
- [x] Bundle matching production `archi` and `archid`, phone assets and the pinned macOS runtime
  inside `Archipelago.app`, together with the bundled rsync 3.x Task 23 requires. Install them into
  the per-user releases/current layout and point launchd plus CLI shims at `current`, never at the
  repository or `tsx`.
- [x] Make developer `desktop:install` exercise the same installed-runtime layout while retaining an
  explicit source-tree dev command for `pnpm archid` and `desktop:dev`.
- [x] Add reproducibility tests that compare archive file lists/modes and run `archi version --json`
  from an unpacked clean artifact.

**Verify:** build both host artifacts locally where possible, run
`pnpm vitest run --project archid test/release.test.ts`, and inspect archives for source paths.

**Commit:** `Published builds carry a versioned controller and companion`

### Task 13: Implement Linux systemd installation and daemon setup

**Depends on:** Task 12

**Files:**

- Create: `packages/archid/systemd/archipelago-gateway.service.in`,
  `archipelago-archid@.service.in`
- Create: `packages/archid/src/linux/setup.ts`, `service.ts`
- Modify: setup/paths/tmux config modules
- Test: `packages/archid/test/linux-setup.test.ts`

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
- [x] Add uninstall that stops/removes only Archipelago units/releases and keeps fleet data unless
  explicit purge is requested.

**Tests:** golden units, escaping spaces, named fleets, repeat setup, rollback symlink, missing
systemd/linger, Linux tmux config.

**Verify:** `pnpm vitest run --project archid test/linux-setup.test.ts`; manual clean Ubuntu install.

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

**Commit:** `One command provisions and maintains a remote Archipelago host`

### Task 16: Add gateway authority compare-and-swap service

**Depends on:** Tasks 9, 13, 15

**Files:**

- Create: `packages/archid/src/gateway/authority.ts`, `server.ts`, `client.ts`, `bin.ts`
- Create: `packages/archid/test/gateway/authority.test.ts`, `server.test.ts`
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
- [x] Expose the authority through a mode-0600 local Unix socket and an `archi gateway owner` SSH
  command. Do not bind it to the tailnet.
- [x] Finish `host enable` by creating the absent generation-zero authority record with the invoking
  Mac as owner; treat an existing record as idempotent only when fleet and owner ids match.
- [x] Quarantine malformed records and refuse ownership changes until repaired.

**Verify:** `pnpm vitest run --project archid test/gateway/authority.test.ts test/gateway/server.test.ts`

**Commit:** `The gateway is the durable authority for fleet ownership`

### Task 17: Add remote routing to the Mac app

**Depends on:** Tasks 14–16

**Files:**

- Create: Swift `ControllerProcess.swift`, `MachineRegistry.swift`, `SSHManager.swift`,
  `RemoteConnection.swift`
- Modify: `ArchiHome.swift`, `Bridge.swift`, `AppDelegate.swift`, `Package.swift`
- Add Swift tests for parsing/process lifecycle

**Steps:**

- [x] Resolve current owner through the bundled helper/gateway on launch; fall back to a cached route
  only under the spec's generation rule.
- [x] Replace synchronous `ArchiHome.connection()` with an asynchronous connection manager that can
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

**Verify:** `pnpm vitest run --project @archipelago/desktop-web && pnpm --filter @archipelago/desktop-web exec playwright test e2e/host.spec.ts`

**Commit:** `A published app can add and inspect its Linux machine`

**M2 gate:** Provision a clean supported Ubuntu x86-64 account from the built app, with no checkout,
Node or pnpm. Create a remote-only test fleet, open twelve terminal surfaces, drop/reconnect SSH, and
verify the daemon survives logout and Mac app exit. Repeat artifact installation on arm64 CI/manual
hardware before release, even if daily development uses one architecture.

---

# Phase D — transfer inventory and transactional handover

## Controller rulings (binding amendments, from the SDD ledger)
M1: Ruling: machine-local scaffolding (hook scripts, tmux.conf, token, mobile key, vapid, port file) may be written on a replica because the read-only API needs them; the one fleet-data write, Store.load's schema-migration persist, stays until Task 26, whose prepare step validates and rewrites the snapshot at v7 before any replica reads it — costs one stray rewrite if a v6 state.json is ever hand-copied onto a replica.
M1: Ruling: a quarantined journal surrenders durably only when a gateway is configured; on a standalone fleet it holds the daemon read-only for this process only, so the next start (broken journal already moved aside) is writable again — without a gateway no handover can be in flight — costs a stricter reading of "never silently make the fleet writable" that the spec applies to gatewayed fleets.
M1: Ruling: F9 (mapPortablePath containment) is a carried obligation for the first destination-write caller, because a remote destination cannot be realpath'd from the controller and the check belongs beside the probe — costs a reminder in the Task 23 dispatch.
Task 12: Ruling: the Mac runtime is the pinned Node 22 LTS darwin tarball verified against SHASUMS256.txt like Linux; rsync 3.x for the Mac is built from the pinned upstream source tarball (sha256-verified) with the optional compression/openssl libraries disabled and cached under vendor/ — no supported macOS ships rsync 3 and Homebrew is not a dependency the app may assume — costs build time on a clean machine.
Task 12: Ruling: release signing uses an ed25519 key at $ARCHI_RELEASE_KEY with the public half committed in scripts/release/allowed_signers; a build without the key writes an unsigned manifest and the installer refuses it unless --allow-unsigned (dev only) — keeps signing off the developer's laptop by default — costs a flag on dev installs.
Task 12: Ruling: the app bundle carries the Mac release tree under Contents/Resources/release/; scripts/desktop-install.sh and `archi setup` install it into ~/.local/share/archipelago/releases/<version> + current via the shared installer, and launchd/~/.local/bin/archi point at current; a published app's first-run self-install is Task 39's — Task 12's file list names no Swift beyond build.sh — costs nothing.
Task 12: Ruling: the release version is `git describe --tags --always --dirty` at build time, written into release.json and read by releaseVersion() from the release root; the source tree reports 'dev' — costs nothing.
Task 13: Ruling: tmuxConfText omits extended-keys-format when the local tmux is older than 3.5 so source-file exits 0 on Ubuntu 24.04; Shift+Enter is the only loss and doctor already warns — the spike measured 3.4 rejecting exactly that line — costs nothing.
Task 12: Ruling: agentAdapters ships as [] until Task 22 registers adapters — an empty list is the truthful capability set and a compatibility check that agrees on "none" is correct — costs nothing.
Task 12: Ruling: the shims resolve the release directory with `pwd -P` so a running process keeps reading its own release across an in-place upgrade — a daemon must not read assets from a bundle it is not executing — costs nothing.
Task 13: Ruling: the Linux setup writes exactly two user units, archipelago-gateway.service (one per machine) and archipelago-archid@.service (instance = fleet profile), rendered from the templates with absolute `current` paths; `archi setup` on Linux is the entry point (no launchd), and `archi setup --release` installs the archive via scripts/install-release.mjs as on the Mac — the spec names both units and the Mac already owns the setup verb — costs nothing.
Task 14: Ruling: runs in parallel with Task 13 on branch fleet-handover-task14 (worktree .claude/worktrees/fleet-handover-task14, from 2af5f28) because their files are disjoint; its commits are cherry-picked onto fleet-handover-impl after review — saves wall-clock, costs a cherry-pick.
Task 14: Ruling: the companion's connection description is `archi connection-info --json` → { fleetId, machineId, release, protocol, host, port, token }; the token travels only inside the SSH channel and the controller validates fleetId/machineId/release before using it, never caching it to disk — the spec forbids the token on the tailnet, SSH is not the tailnet — costs nothing.
Task 14: Ruling: gateway-record routing is a hook `resolveOwner(fleet)` that returns local until Task 16/17 fill it; `--host <name|local>` is the explicit route now; ungated local fleets never touch SSH — the gateway does not exist yet — costs nothing.
Task 14: Ruling: remote tokens are POSIX single-quoted by a helper before they reach ssh's remote command line, and MachineRecord.archiBase/home only require an absolute path without NUL, newline or a `..` component — the app must work for any user's home directory, so safety comes from quoting, not from restricting paths — costs one quoting helper; round-1 re-review folded into round 2's.
Task 15: Ruling: `host add` finds the companion archive from `--release <archive>`, else from a `companions` map in the Mac release.json (url + sha256, filled by the build only when given a base URL, cached under ~/.local/share/archipelago/companions/), else refuses naming `--release` — the release workflow that publishes archives is Task 37 — costs nothing.
Task 15: Ruling: first install bootstraps by streaming the archive over the master to a remote temp file, unpacking it to a remote staging dir with tar, and running the unpacked copy's own `bin/archi setup --release <archive>`, which verifies and installs it properly; upgrades use `<archiBase>/current/bin/archi` — the installer is JavaScript inside the archive and no Node exists on a clean host — costs one extra unpack on first install.
Task 15: Ruling: the remote machine id is read from `archi version --json`, which gains a `machineId` field (minting it on first call) — connection-info needs a running daemon and setup does not — costs one field.
Task 15: Ruling: the only interactive ssh is the first host-key/auth probe (stdio inherited, no BatchMode); package installs, linger and agent logins are offered as an exact `ssh <dest>` command plus the commands to run, never spawned — the spec forbids sudo and credential copying — costs nothing.
Task 16: Ruling: runs in parallel with Task 15 on branch fleet-handover-task16 (worktree .claude/worktrees/fleet-handover-task16, from 927ee33), scoped to packages/archid (gateway/*, exports, tests); the `archi gateway serve|owner` CLI wrappers and the `host enable` authority creation follow in a second dispatch once Task 15's host.ts has landed — disjoint files now, one small follow-up later.
Task 16: Ruling: authority records live at <prefix>/gateway/fleets/<fleetId>.json (prefix = ~/.local/share/archipelago), durable 0600, one in-process mutex per fleet; the Unix socket is <prefix>/gateway/authority.sock in a 0700 dir with the socket chmod 0600, JSON-lines `{ id, op, params }` → `{ id, result }` | `{ id, error: { code, message } }` — the spec names a local Unix socket and the gateway is one process — costs nothing.
Task 17: Ruling: the Mac app never speaks SSH itself; it spawns the bundled helper `<app>/Contents/Resources/release/bin/archi connect --json [-p profile]` (a new CLI command Task 17 adds) which resolves the owner, opens the master + forward for a remote owner, prints one NDJSON status stream (connecting / online { host, port, token, remote? } / error { kind } / owner-changed) and holds the master until its stdin closes; `ControllerProcess.swift` owns that child for the window's lifetime — the spec says the app invokes the bundled controller helper and reads NDJSON — costs one long-lived child per window.
Task 17: Ruling: a remote connection's `online` event carries `remote: { name, destination, controlSocket }`; SurfaceManager builds `ssh -S <controlSocket> -tt -- <destination> tmux -S <socket> attach -t <session>` for a remote attach and the unchanged local command otherwise; the token lives only in the helper's stdout, the app's memory and the bridge message — never in logs or preferences — as the spec's connection section requires — costs nothing.
Task 17: Ruling: Finder reveal/open-folder for a remote path answers with a new FromShell `notice { text }` the page shows as a toast; the Swift package gains a test target (`Tests/ArchipelagoTests`, `@testable import`) for NDJSON parsing and command building — the bridge has no reply channel today and the mac package has no tests — costs a Package.swift edit.
Task 15: Ruling: the companion's own `archi setup` treats a missing Claude Code as a warning on Linux (the agent checks are warn-with-action by the spec's Add Machine flow and a fresh Ubuntu box has no agent yet); the Mac keeps its fail — carry into the Task 15 review/fix round — costs nothing.
Task 16: Ruling: the restart-surviving quarantine is fixed inside Task 16's fix loop, not the CLI follow-up — the follow-up's `host enable` owner.create builds directly on it and ownership/state.ts already shows the durable-sentinel pattern — costs one fix round now instead of a larger one later.
Task 17: Ruling: split into 17a (packages/cli: `archi connect --json`, resolveOwner, route cache, connection-info generation; branch fleet-handover-task17a from 15c5240) and 17b (apps/desktop/mac; branch fleet-handover-task17 from 15c5240), run in parallel against task-17-contract.md because the file sets are disjoint; the only shared file with a possible 16b fix round is packages/cli/src/main.ts (one registration line) — costs a trivial cherry-pick conflict at worst.
Task 17: Ruling: the cached route is <fleetHome>/controller/route.json {ownerMachineId, generation, at} and `archi connection-info --json` gains an optional `generation` so the spec's "same cached generation" check has something to compare — costs one field.
Task 17: Ruling: the app falls back to today's port/token file read when no helper binary exists (no ARCHI_HELPER, no bundled release), so a dev build keeps working — costs one branch in Swift.
Task 17: Ruling: the web side of `connectionState`/`notice` is Task 18's; 17b only sends them.
Task 17: Ruling: bridge wire names are `connection.state` and `notice`, recorded in task-17-contract.md for Task 18 — costs nothing.
Task 17: Ruling: `error.kind` is the SshErrorKind verbatim plus `daemon_down`; the contract's `mismatch` was a naming slip and is struck — the Swift side decodes kind as an open string — costs nothing.
Task 18: Ruling: runs on fleet-handover-impl now (BASE dbf0062) in parallel with Task 17a's review on its own branch — Task 18 touches apps/desktop/web and the Swift bridge/controller-process files, 17a only packages/cli; a cli change Task 18 needs is reported, not made — costs nothing if the sets stay disjoint.
Task 18: Ruling: `handover.enabled` is a boolean (default false) inside fleet.json's existing `handover` object in FleetConfig (packages/protocol/src/handover.ts), reaching the page through the existing fleet-config exposure; the CLI ignores it — the spec keeps portable behavior in fleet.json and Task 39 removes the flag from one place — costs one schema field.
Task 17a: Ruling: only `unreachable`/`daemon_down` retry; every other kind is emitted once and the helper idles until stdin EOF — the contract's "keeps retrying" meant transport, and an auth retry loop trips fail2ban — recorded in task-17-contract.md; costs a window reopen after the user fixes the cause.
Task 18: Ruling (corrects the earlier one): `handover.enabled` already existed in FleetConfig since f32264c and no fleet config reaches the page, so the flag travels on `shell.info` as `handoverEnabled`, read by ArchiHome from the fleet home's fleet.json when the page asks for its connection — an existing channel, no archid/protocol change; costs a page reload after editing fleet.json.
Task 17a: Ruling: the re-review's Minor "dead master then moved owner emits no owner-changed" is promoted into the fix loop — 17b's RemoteConnection treats an `online` without `owner-changed` as a rebuild and re-attaches to the old owner's tmux socket path, the exact case Task 29's automatic owner reconnect builds on — costs one small fix now.
Task 17a: Ruling: the appended retry policy binds over the contract body's "local error → exit 1": `daemon_down` retries for a local owner too and every other kind idles until stdin EOF regardless of owner — a daemon still starting under launchd would otherwise leave the window dead, and the Swift side reports a child exit as `other`, masking the real error — costs one branch in connect.ts.
Task 17a: Ruling: a far `connection-info` exit of 126/127 (archi missing or not executable) is `version`, not `daemon_down` — a permanent install fault must not retry every 16 s, same class as the open finding — costs one mapping.
Task 18: Ruling: `enable` stays — spec Add Machine step 10 creates the gateway authority record per enabled fleet; it is relabelled to what it does and the shell supplies the fleet instead of the page deriving a profile — costs one label and one argv source.
Task 18: Ruling: Remove confirms before running like Forget (one-click remote uninstall); the cancel test gets a child that would outlive it (a test that passes without the behavior is Important by the rubric); token masking covers ?token=/&token=/ARCHI_TOKEN= and the stderr tail keeps whole lines and drains at exit (the brief's "actionable stderr without leaking tokens"); "ready for handover" only after a clean add or an all-ok doctor — costs one fix round.
Task 18: Ruling: the orphaned `ssh -M -N` after Stop (SIGTERM kills node before SshMaster's exit hook) is fixed in the CLI with a signal handler, carried to the M2 fix wave after the 17a cherry-pick — packages/cli is 17a's branch until then — costs a leaked master per cancelled op until the gate.
Task 17a: Ruling: the implementer's three concerns are folded into round 2 before its re-review — after a permanent gateway failure the helper stops asking the gateway for the process lifetime (the tick checks only the cached owner's liveness and generation); gateway `disconnected` is `unreachable`; classifySsh maps "Connection to X closed by remote host"/non-preauth "Connection closed by" to `unreachable` — a refused key knocked every 30 s trips fail2ban, and transient drops must not idle the helper — costs an ownership change noticed via the far side's generation rather than the gateway.
Task 18: Ruling: a doctor `skip` counts as ok and `warn` does not — skip means not applicable, warn carries a remaining action (spec: "Ready for handover or a list of concrete remaining actions") — costs nothing; implementer resumed for it before the re-review.
Task 17a: Ruling: fix round 3 also covers the far connection-info's empty-stderr 255 (same classifyExit change) and memoizes only an SshError with a non-retried kind — a spawn rejection or writeRoute throw is transient — costs nothing.
M2: Ruling (his answer 2026-09-22): the M2 on-machine pass uses a throwaway user `archi-m2` on linus-vault, created over ssh with sudo, his Mac key authorized, linger enabled; host add driven from the release build in a temp HOME; never his account, fleet or tailscale serve; user deleted afterwards; the by-eye GUI part (twelve terminals, SSH drop/reconnect) is his.

## Task 17 contract
# Task 17 contract: the `archi connect --json` helper and the Mac app

Task 17 is split in two dispatches on disjoint files. Both build against this contract; neither
may change it without the controller. 17a is `packages/cli` (branch fleet-handover-task17a);
17b is `apps/desktop/mac` (branch fleet-handover-task17). Neither touches the other's tree.

## The helper (17a builds it, 17b spawns it)

Command: `archi connect --json [-p <profile>]` (new `packages/cli/src/commands/connect.ts`,
registered in `main.ts`). Same profile/home resolution as every other `archi` command.
Stdout is NDJSON, one object per line, `type` discriminated:

- `{"type":"connecting","owner":"local"}` or `{"type":"connecting","owner":"<machine name>"}`
- `{"type":"online","host":"127.0.0.1","port":<n>,"token":"<t>"}` for a local owner;
  for a remote owner the same plus `"remote":{"name":"<machine name>","destination":"<ssh dest>",
  "controlSocket":"<path of the SshMaster control socket>"}`. `port` is the local forward port.
- `{"type":"error","kind":"unreachable"|"auth"|"daemon_down"|"mismatch"|"other","message":"<text>"}`
  `kind` values are the existing `SshErrorKind`s plus `daemon_down` (local daemon not up).
  After an `error` for a remote owner the helper keeps retrying with the existing `withReconnect`
  backoff and emits `connecting` again before each attempt. For a local owner an `error` is
  followed by exit code 1.
- `{"type":"owner-changed","owner":"<name or local>"}` when a re-resolution finds a different
  owner than the one currently online: the helper closes the old master/forward, emits this, then
  `connecting` → `online` for the new owner.

Lifecycle: the helper holds its master and forward until its stdin reaches EOF, then closes both
and exits 0. It re-resolves the owner on every reconnect attempt and every 30 s while online.
The token appears only on stdout; never in logs, never on disk, never in argv.

Owner resolution (`resolveOwner(fleetHome)` in `controller/connection.ts`, replacing the stub):
1. fleet.json without `gatewayMachineId` → local.
2. Otherwise the gateway is the registry machine with that id; over its SSH master run
   `archi gateway owner get --fleet <fleetId>` (Task 16b). The record's `ownerMachineId`:
   equal to this Mac's machine id → local; otherwise the registry machine with that id → that
   machine (a gateway record naming an unregistered machine is `error` kind `other`).
   `not_found` → local. `authority_corrupt` → `error` kind `other` with the message.
3. Gateway unreachable → the cached route (below) may be used only when that route's daemon
   reports the same generation; otherwise `error` kind `unreachable`.

Cached route: `<fleetHome>/controller/route.json` (0600, atomic write) =
`{ "ownerMachineId": "<id>", "generation": <n>, "at": "<iso>" }`, written whenever the gateway
answered. To check it, `archi connection-info --json` gains an optional `generation` field (the
daemon's cached owner record generation; absent when the daemon runs standalone) — for the local
route the controller reads the same cache file the daemon writes.

## The Mac app (17b)

- `ControllerProcess.swift` spawns the helper with executable + argv (`Process`, no shell), reads
  stdout line by line, decodes the events above, and owns the child for the window's lifetime:
  closing the window or quitting closes the child's stdin and waits briefly; a child exit while
  the window is open is an `error` kind `other` to the page.
- Helper location: `ARCHI_HELPER` env var if set (dev), else
  `Bundle.main.resourcePath + "/release/bin/archi"`. If neither exists, keep today's behavior
  (`ArchiHome.connection()` reading the port/token files) so a dev build without a bundled release
  still works — the local-only experience must keep working throughout.
- `Bridge.swift`: `FromShell.connection` carries the same fields as today; add
  `FromShell.connectionState(state: "connecting"|"online"|"error"|"owner-changed", owner: String,
  kind: String?, message: String?)` and `FromShell.notice(text: String)`. The web side of
  `connectionState`/`notice` is Task 18's; 17b only sends them.
- `SurfaceManager`: when the current connection is remote, the attach command is
  `ssh -S <controlSocket> -tt -- <destination> tmux -S <socket> attach -t <session>` with every
  word passed through the existing `sh()` quoting; local attach is unchanged. After the helper
  emits a new `online` for the same owner (reconnect), visible surfaces are rebuilt; on
  `owner-changed`, old surfaces are closed first.
- Finder reveal / open-folder for a path while the connection is remote sends
  `FromShell.notice(text: "…is on <machine name>; open it there")` and does nothing else.
- `Package.swift` gains `.testTarget(name: "ArchipelagoTests", dependencies: ["Archipelago"],
  path: "Tests/ArchipelagoTests")`; tests cover NDJSON event decoding (every type above, unknown
  type ignored, malformed line ignored), the attach command for local vs remote, and the helper
  lifecycle (a fake helper script that prints events and exits on stdin EOF).
  `swift test --package-path apps/desktop/mac` is the verify command.

## Wire names (fixed after 17b landed)
The bridge JSON `type` for `FromShell.connectionState` is `connection.state` and for `FromShell.notice` is `notice`; Task 18 matches these.

## error.kind (fixed after 17a landed)
`kind` is the SshErrorKind emitted verbatim (`unreachable`, `auth`, `host_key`, `version`, `other`, …) plus `daemon_down`; there is no `mismatch` kind. Consumers treat `kind` as an open string.

## Retry policy (fixed after the 17a review)
Only `unreachable` and `daemon_down` are retried with backoff. Any other kind (`auth`, `host_key`, `version`, `other`, a missing registry destination, an unparseable fleet.json) is emitted once as `error` and the helper then idles — no retries, no re-resolution tick — until stdin EOF (exit 0). The Mac shows the error; the user fixes the cause and reopens the window. A dead master while online is detected by `SshMaster.check()` on each 30 s tick and handled as a reconnect (close, `connecting`, retry).
