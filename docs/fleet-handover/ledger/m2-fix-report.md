# M2 fix wave report (F1–F29)

Worktree `fleet-handover-impl`, base `11f3f3d`. `$S` is the scratchpad
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/81a5d143-473b-4b4a-8147-d28e03ccff44/scratchpad/m2-fix`.
Line numbers are at the final commit.

## Commits

| SHA | Group | Items |
|---|---|---|
| d89432d | security | F1, F2 |
| ac3145c | transport and helper | F3, F4, F5, F6, F7, F8, F9, F29 |
| cd48574 | host controller | F10, F11, F12, F13, F14 |
| 0d06eed | Linux setup | F15, F16, F17, F18, F19, F20, F21 |
| 349d161 | Mac app and page | F22, F23, F24, F25, F26, F27, F28 |

## Security

**F1 — the all-zero signer.** `scripts/release/allowed_signers:1-12` now holds only comments, so `ssh-keygen -Y verify` refuses every signature (exit 255) until the owner commits the real public key. No key was generated.
- Tests: `packages/archid/test/release.test.ts:104` fails on any committed key whose ed25519 point is all zero. `:115` shows the fail-closed behaviour: a tree signed by an ephemeral key is refused against the committed file while that file holds no key.
- RED: `pnpm vitest run --project archid test/release.test.ts -t "signers a release trusts"` gave `× commits no placeholder key → …AAAAIAAAA…: expected true to be false`.
- GREEN: the whole file passes, 28 tests. By hand, `ssh-keygen -Y verify -f scripts/release/allowed_signers …` printed "Could not verify signature." and exited 255 (OpenSSH_10.3p1).

**F2 — a `--release` archive vouching for itself.**
- `packages/cli/src/controller/install.ts:35` `inspectCompanion(archive, { verify })` unpacks the whole archive into a temp dir, then runs `verifyRelease` with `allowUnsigned: true`. That checks the signature when one is present, every digest, and the tree against the manifest. `signed` now comes from that result, not from whether a `SHA256SUMS.sig` member exists.
- The verifier is the controller's own `sshVerify({ allowedSigners: allowedSigners() })`, set in `packages/cli/src/commands/host.ts:44` and injected through `HostDeps.verify`.
- The release step runs before the upload, so nothing goes up until the archive is authenticated.
- Tests: `packages/cli/test/controller/install.test.ts:76` (an archive signed by an intruder and carrying the intruder's own `release/allowed_signers`), `:81` (a file tampered after signing), `:90` (a signature counts for nothing when the manifest says unsigned), and `packages/cli/test/host.test.ts:257` (add stops at `release`; no `cat > "$1"` and no `setup` reach the far side).
- The test archives now carry real manifests: `packages/cli/test/controller/archive.ts`.
- RED: `pnpm vitest run --project cli test/controller/install.test.ts` gave 2 failed, both "promise resolved { …(5) } instead of rejecting".
- GREEN: 18 passed. `host.test.ts` plus `install.test.ts`: 48 passed, 1 skipped.

## SSH transport and the helper

**F3 — masters shared across processes.** Real-world evidence: V1 reproduced this against a scratch sshd, and the on-machine report §8c shows `archi status` and `host doctor` ending the app's master.
- `packages/cli/src/controller/ssh.ts:80`: the socket name hashes `pid\0destination`, so every process gets its own master.
- `:133` `start()` removes whatever sits on that path and spawns. It never adopts a live socket. Every `SshMaster` is spawned by its own process, so `close()` (`-O exit`) only ever ends a master this process owns.
- `packages/cli/src/controller/connection.ts:137`: `connectRemote` cancels its forward and closes its master when its client closes, via the new `Client.onClose` at `packages/cli/src/client.ts:99`.
- Tests (all at the decision point, which is who sends `-O exit` on which socket):
  - `packages/cli/test/controller/ssh.test.ts:120`: a second real process (tsx, `test/fixtures/open-close-master.ts`) opens and closes a master for the same destination and socket dir. It must get a different socket, and ours must still answer `-O check`.
  - `:129`: a live stranger on our own path is never adopted.
  - `packages/cli/test/controller/connection.test.ts:136`: `-O cancel` and `-O exit` follow `client.close()`.
- RED:
  - `ssh.test.ts`: "expected '/tmp/archi-ssh-…/sockets/…' not to be '…'" (same socket), and "expected 1 to be 2" (adopted, no `-M`).
  - `connection.test.ts`: "Test timed out in 5000ms" (no cancel or exit).
- GREEN: `ssh.test.ts` 24 passed, 1 skipped. `connect` plus `connection`: 71 passed.

**F4 — no signal handler.**
- `ssh.ts:94` `closeMastersOnSignal()` installs SIGTERM, SIGINT and SIGHUP handlers once per process. Each kills every master this process spawned (kept in a `spawned` set), then exits 143, 130 or 129.
- It is called from:
  - every `archi host …` command, through commander's `preAction` hook at `packages/cli/src/commands/host.ts:75`
  - the routed commands' `connect` closure at `packages/cli/src/main.ts:35`
  - the helper at `packages/cli/src/commands/connect.ts:13`, which drops its own polite SIGTERM/SIGINT stop; stdin EOF stays the graceful path.
- Test: `packages/cli/test/host.test.ts:418` spawns `archi host doctor` as plain `node --import tsx main.ts`, the way the release shim `exec`s node. The far doctor is scripted to hang. The test sends SIGTERM and waits for the fake master's pid to die.
- RED: "waitFor: timed out" (the master pid was alive after the CLI died).
- Note: under the `tsx` CLI this test passed before the fix. tsx turns SIGTERM into `process.exit`, which runs `SshMaster`'s exit hook. I checked by hand in `$S/orphan2.sh`: a child survives SIGTERM under `node --import tsx` and dies under the tsx CLI.
- GREEN: 1 passed.

**F5 — keepalive and connect timeout.** The master argv gains `-o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10` (`ssh.ts:142`).
- Test: `ssh.test.ts:98`, the exact `-M` argv.
- RED: "expected [ '-S', …(7) ] to deeply equal [ '-M', '-S', …(14) ]".
- GREEN: included in the 24 above.

**F6 — a gateway `timeout` frame.** It now maps to `unreachable`, like `disconnected` (`connection.ts:186`).
- Test: `connection.test.ts:468`.
- RED: "expected 'other' to be 'unreachable'".
- GREEN: included in the 71.

**F7 — the registry loaded once.**
- `ConnectDeps.registry` became `loadRegistry()` (`packages/cli/src/controller/connect.ts:26`). It is called for every resolution and every announce. The real helper passes `() => MachineRegistry.load()` (`commands/connect.ts:44`).
- Test: `connect.test.ts:225`. The helper starts on an ungated fleet. After it comes online, a gateway machine is saved to the on-disk registry and fleet.json names it. The tick must ask that gateway, with no error.
- RED (with the harness temporarily also passing the old `registry` dep): "waitFor: timed out"; the gateway was never asked.

**F8 — announcing this Mac.** `announce()` returns `local` when the cached route names `registry.localId` (`connect.ts:56`).
- Test: `connect.test.ts:251`.
- RED: "expected { type: 'connecting', …(1) } to deeply equal { type: 'connecting', owner: 'local' }".

**F9 — transport failures classed as `other`.**
- `connect.ts:72` `transport()` maps any system error (an `ErrnoException` with a `code`, such as spawn EAGAIN) from the remote `goOnline` path to `SshError('unreachable')`. Programming errors keep `other`.
- `ssh.ts:160`: a master that could not be spawned, or died with empty stderr during open, is `unreachable`.
- Tests: `connect.test.ts:197` (spawn EAGAIN for the owner, then a retry and online) and `ssh.test.ts:215` (a new fake destination, `vanish.test`, exits 255 with no stderr).
- RED: "Test timed out in 20000ms" (the helper idled on `other`), and "expected 'other' to be 'unreachable'".

**F29 — a lost forward went unnoticed.** Evidence: on-machine report §8b, 75 s with no event after `-O cancel`.
- `alive()` is now `master.check() && accepts(forward.localPort)` (`connect.ts:101`). `accepts` (`:61`) makes a 5 s-bounded TCP connect to 127.0.0.1.
- Test: `connect.test.ts:208`. From the `online` event, the test runs `ssh -S <sock> -O cancel -L …` against the live fake master, and expects connecting then online again.
- RED: "Test timed out in 20000ms".
- GREEN for F6–F9 and F29: `connect.test.ts` plus `connection.test.ts`, 71 passed.

## Host controller

**F10 — a failing companion doctor.**
- `packages/cli/src/controller/host.ts:177` `remoteJson` parses stdout whatever the exit code. It throws only when stdout is not JSON, and then the message names the exit code and stderr.
- Tests, all in `host.test.ts`:
  - `:384`: host doctor with an exit-1 report keeps each check, including the failing `hooks`, and adds no `doctor` fail row.
  - `:395`: an exit without a report is still one `doctor` fail row, "exited 9".
  - `:212`: add's service step with an exit-1 doctor.
  - `:472`: an upgrade whose doctor exits 1 is not rolled back.
- RED: "expected undefined to match object { status: 'fail' }"; the service step gave `ok` where `fail` was expected; "expected true to be false" (it rolled back).

**F11 — `--forget` touched the machine.** With `--forget`, the uninstall step is `skip` and opens no master (`host.ts:510`).
- Test: `host.test.ts:541`. Forgetting the reachable `trift.test` makes `ssh.calls()` empty.
- RED: "expected [ [ '-M', '-S', …(14) ], …(3) ] to deeply equal []".

**F12 — removing a gateway stranded fleets.**
- A new `fleet` step (`host.ts:488` `gatewayFleets`) runs before the uninstall. It looks at every fleet home under the home dir (`.archipelago` and `.archipelago-<profile>`) whose fleet.json names the machine as its gateway.
- If `owner.json` or `route.json` of any of those names another machine, it refuses and lists those homes. The action is "disable handover for … first". Nothing is uninstalled and the registry is untouched.
- Otherwise the registry step clears `gatewayMachineId` in each of those fleets with an atomic 0600 write (`host.ts:524`), then drops the route.
- Tests: `host.test.ts:561` (refused, with and without `--forget`; no ssh calls; fleet.json unchanged) and `:575` (cleared for this Mac's fleet; another gateway's fleet left alone).
- RED: "expected 'ready' to be 'actions'", and "expected '66666666-…' to be undefined".

**F13 — the checklist opened a phase twice.**
- add's machine-id step is now `identity` (`host.ts:343`).
- In `apps/desktop/web/src/host.ts:16`, `identity` joins the Service phase, and `registry` gets its own "Registry" phase (`:20`). Every add and every removal is now one contiguous run per phase.
- Tests: `host.test.ts:226` (the exact step order) and `apps/desktop/web/test/host.test.ts:100` (no repeated or "Setup" phase for an add or a removal).
- RED: "expected [ Array(19) ] to deeply equal [ Array(19) ]", and "expected [ 'Connect', 'Prerequisites', …(6) ] to not include 'Setup'".
- GREEN: web `host.test.ts`, 16 passed.

**F14 — the uploaded archive was left on the far machine.**
- `bootstrapSetup`'s `finally` is now `rm -rf <staging> <archive>` (`install.ts:144`).
- `installedSetup` always ends with `rm -f <archive>` (`:154`).
- Tests: `install.test.ts:184` and `host.test.ts:487`.
- RED: "expected […] to deep equally contain [ 'rm', '-f', …(1) ]".
- GREEN for F10–F14: `host.test.ts` plus `install.test.ts`, 59 passed, 1 skipped.

## Linux setup and daemon lifecycle

**F15 — the gateway unit never ran.**
- `startUnit` enables `--now` both the archid unit and `archipelago-gateway.service` (`packages/archid/src/linux/setup.ts:101`).
- The template's plan-narrating comment is replaced (`systemd/archipelago-gateway.service.in:1`).
- The companion doctor has a `gateway` unit check on Linux (`packages/cli/src/commands/doctor.ts:183`).
- `serviceOutcome` requires both `systemd` and `gateway` (`host.ts:193`).
- Tests: `linux-setup.test.ts:190` (the exact systemctl calls), the gateway golden unit, `doctor.test.ts:129`, and `host.test.ts:239` (add stops at `service` when the gateway is inactive).
- RED: "expected [ …(3) ] to deeply equal [ …(4) ]"; "expected undefined to match object { status: 'ok' }"; the service step gave `ok` where `fail` was expected.

**F16 — an upgrade never restarted.**
- When a release replaced another (`rollbackTo` set, units started), `setupLinuxRelease` restarts the archid and gateway units before `probeOrRollback` (`linux/setup.ts:148`).
- The probe is now `daemonRuns(version, connect)` (`packages/cli/src/commands/setup.ts:53` and `:92`). It passes only when `system.info.release` equals the installed version.
- Tests: `linux-setup.test.ts:239` (restarts seen at probe time) and `packages/cli/test/setup.test.ts:7` (an old-release daemon fails; a late daemon is waited for).
- RED: "expected [ …(3) ] to deep equally contain [ 'systemctl', '--user', …(2) ]", and "daemonRuns is not a function"; the old probe only connected.

**F17 — no KillMode.**
- `KillMode=process` is in the archid template, with a one-line reason (`systemd/archipelago-archid@.service.in:17`).
- Evidence: V3 in an ubuntu:24.04 systemd container, and on-machine defect 1, where a `kill -9` of MainPID took 12 character windows to 0. The test is at the decision point, the unit text: the golden unit at `linux-setup.test.ts:54`.
- RED: the golden text differed.
- GREEN for F15–F17: archid `linux-setup` 23 passed; cli `doctor` plus `host` 57 passed, 1 skipped.

**F18 — hooks named the staging node.** When `'release' in o`, `setupUser` builds the hook and statusline commands from `<release>/node/bin/node` (`packages/archid/src/setup.ts:290`).
- Test: `setup.test.ts:140`. `runSetup` with `release: <dir>/current` while this process's node plays the staging copy. No setting may name `process.execPath`.
- RED: the hook named `n='/opt…'`, the running node.

**F19 — ARCHI_RELEASE_ROOT leaked into tmux.** `Tmux.run` execs tmux with `paneEnv()`, the environment without `ARCHI_RELEASE_ROOT` (`packages/archid/src/tmux/tmux.ts:24`, `:53`). This is the only place archid starts a tmux server.
- Test: `tmux.test.ts:63`, run against real tmux. With the variable set in archid's environment, `show-environment -g ARCHI_RELEASE_ROOT` must fail with "unknown variable".
- RED: "promise resolved 'ARCHI_RELEASE_ROOT=/home/linus/.local…' instead of rejecting".

**F20 — profile plists pinned a release.**
- `launch.ts:83`: a new profile runs from `{ release: <DEFAULT_PREFIX>/current }` when `isRelease()`.
- `runSetup` with a release rewrites every existing `com.archipelago.archid.<name>.plist` onto current (`setup.ts:317` `moveProfileAgents`). It keeps each plist's `ARCHI_HOME`, and the log path is re-derived from it. With launchctl on, it bootouts and bootstraps each one it rewrote (`:342`).
- `desktop-install.sh` already runs `archi setup --release`; its comment is updated (`:46`).
- Tests: `setup.test.ts:153` (an old tsx plist is moved onto `<release>/bin/archid`) and `packages/cli/test/launch.test.ts:116`.
- RED: the plist still ran tsx; "expected { release: releases/1.2.3 } to deeply equal { release: current }".

**F21 — Mac uninstall left the releases.** Prefix cleanup moved out of the Linux-only `removeUnits` into `removeReleases` (`packages/archid/src/uninstall.ts:41`). It runs on every platform for `releases`, `current`, `companions` and `log`, and keeps `gateway/`. Unit handling stays Linux-only.
- Test: `uninstall.test.ts:147`.
- RED: "expected [ 'companions', 'current', …(2) ] to deeply equal [ 'gateway' ]".
- GREEN for F18–F21: archid `setup`, `uninstall`, `tmux` and `linux-setup`, 79 passed; cli `launch` plus `uninstall`, 14 passed.

## Mac app and page

**F22 — the page kept a stale local port.**
- `RemoteConnection.connection` is computed (`apps/desktop/mac/Sources/Archipelago/RemoteConnection.swift:31`). When the route is `.local` (the fallback, or the helper's local owner), it reads `ArchiHome.connection()` afresh. Otherwise it is the helper's stored `online` value, the remote forward, or nil while pending.
- `AppDelegate.swift:117` already answers the page with `remote.connection`.
- Tests: `RemoteConnectionTests.swift:143` (helper, local owner), `:157` (no helper) and `:165` (remote keeps the forward).
- RED: "port 8123 is not equal to 9001", twice.

**F23 — reveal refused while pending.** `notice(forOpening:)` refuses only `.remote` (`RemoteConnection.swift:70`).
- Test: `RemoteConnectionTests.swift:127`.
- RED: `XCTAssertNil failed: "/w/isle cannot be opened while the fleet is connecting"`.

**F24 — remote attach quoted only once.** The remote socket and session are quoted twice (`SurfaceManager.swift:30`).
- Tests: `AttachCommandTests.swift:12` (the exact string) and `:21`. The second runs the built command through `/bin/sh` with a fake `ssh` on PATH. The fake does what ssh does: it joins the words after the destination, and a second `sh -c` splits them. The far argv must be `tmux -S "/home/li nus/…/tmux.sock" attach -t "v-it's $(x)"`, with the control socket also spaced.
- RED: "/bin/sh: -c: line 1: syntax error: unexpected end of file", and `("[]") is not equal to [...]`.

**F25 — quit could block.** `ControllerProcess.stop()` closes stdin and waits 1 s, then SIGTERM and 2 s, then SIGKILL, then `waitUntilExit` (`ControllerProcess.swift:135`). With F4, the helper also ends on SIGTERM now.
- Test: `ControllerProcessTests.swift:57`. A helper that runs `trap '' TERM` and never reads stdin must be gone within 10 s.
- RED: "Exceeded timeout of 10 seconds … stopped", and `XCTAssertFalse(isRunning)` failed.

**F26 — no tty for the first ssh.**
- `interactiveEnv` (`packages/cli/src/commands/host.ts:20`): when stdin is not a TTY on darwin, the interactive probe alone runs with `SSH_ASKPASS=<release>/bin/archi-askpass` and `SSH_ASKPASS_REQUIRE=force`.
- `scripts/release/archi-askpass` is a `/bin/sh` script. It passes ssh's prompt to `osascript` as `argv` after `--`, never as code, and adds `with hidden answer` for password, passphrase and PIN prompts.
- `release-stage.mjs:177` ships it in darwin releases as `bin/archi-askpass` (0755). `askpassPath()` (`packages/archid/src/release.ts:39`) finds it in a release or the checkout.
- Tests: `packages/cli/test/askpass.test.ts:14` (the env decision: TTY, no TTY, Linux) and `:35` onwards (the script, with a fake `osascript` on PATH recording its argv). The built release carries it executable (`release.test.ts:317`, ran and passed in the full suite).
- RED: "interactiveEnv is not a function / askpassPath is not a function".
- GREEN: 4 passed.

**F27 — no build could provision through the app.**
- `apps/desktop/mac/build.sh:34`: a release build computes one version. It builds the linux-x64 companion into `build/companions`, then the controller with `--companion-url-base file://…/build/companions --companions …`, so the bundled release.json pins that archive by URL and sha256.
- `downloadCompanion` reads a `file:` URL from disk under the same digest check (`install.ts:101`).
- `companionAsset` also reports whether the controller's own manifest is unsigned (`:89`). `companionFor` then allows the pinned companion unsigned only in that case (`host.ts:263`), and the far setup gets `--allow-unsigned`. See Choices.
- Tests: `install.test.ts:135` (file: URL read and digest refused), `host.test.ts:274` (an unsigned development build installs its pinned companion with no flag; the far setup carries `--allow-unsigned`) and `:291` (a signed build's pinned unsigned companion is refused).
- RED: "a file: URL is not fetched"; the release step was not `ok`.
- Real check with `$S/f27-build.sh`, which runs build.sh's two node steps into scratch:
  - The release.json `companions.linux-x64.url` was `file:///…/companions/archipelago-companion-0d06eed-dirty-linux-x64.tar.gz`, and the pinned sha256 equalled the actual one. `unsigned: true`. `bin/archi-askpass` had mode 100755.
  - `$S/f27-check.mts` then ran `companionAsset`, `downloadCompanion(file:)`, `inspectCompanion` (verified with the built release's own comment-only signers) and `requireCompatible`. All passed: `{"unsignedBuild":true,"platform":"linux-x64","protocol":10,"signed":false}`. The outputs were deleted.
- The full `apps/desktop/mac/build.sh release` (GhosttyKit plus swift) was not run.

**F28 — rebuild re-attached destroyed sessions.** Evidence: on-machine report §8a. All 12 rebuilt attaches printed "can't find session", and a fresh `term.attach` fixed them.
- `SurfaceManager.rebuild()` (`SurfaceManager.swift:159`) now closes every surface, shown or only remembered, and reports `onExited(id)`, which the shell sends as `term.exited`. It never re-runs a stored attach.
- `RemoteConnection` fires the same `onSurfaces()` on an owner change (`RemoteConnection.swift:102`) and on every online after the first (`:94`). The owner change no longer destroys surfaces silently. `AppDelegate.swift:80` wires it to `rebuild()`.
- Page reloads and quitting still close without reporting.
- To test the decision point, SurfaceManager's view factory is injectable (`init(container:webView:makeView:)`, `:63`).
- Tests: `SurfaceManagerTests.swift:11`. A surface remembered while the route was pending is reported exactly once; its attach is never run, and nothing is reported as failed. Also `RemoteConnectionTests.swift:69` and `:88` (the signal at owner change and on reconnect).
- RED: `exited []`, where `["c_1"]` was wanted, and `ran ["ssh -S '/tmp/archi/studio.sock' -tt -- 'linus@studio' tmux -S '/s' attach -t 'v-c_1'"]`, where `[]` was wanted. That is the stored attach re-run, as on the machine.
- Swift GREEN for F22–F28: `swift test`, 46 tests, 0 failures.

## Verification (once, before the final commit)

- `pnpm typecheck`: exit 0.
- `pnpm test`: 118 files; 1491 passed, 1 failed, 2 skipped. The failure is the known flake `archid test/fleet.test.ts > Fleet > clears a stale agent status on revive`, which passes alone (37/37). The 2 skipped are the `ARCHI_TEST_SSH` real-sshd tests. The release-build test ran and passed, including the askpass assertion.
- `swift test --package-path apps/desktop/mac`: 46 tests, 0 failures.
- `pnpm --filter @archipelago/desktop-web exec playwright test`: 96 passed, 1 failed.
  - The run waited for another session's e2e run to free port 5173.
  - The failure is `e2e/keys.spec.ts:3` "drives the app with the Cmd chords", at `expect(created.cwd).toBe('/tmp')` → `Received: "/private/tmp"`.
  - It is a timing race that was there before this wave. `reconcile.ts:96` copies tmux's `pane_current_path`, the realpath, into a character's `cwd`, and the test reads it straight after creating the character.
  - Alone it failed 1 of 3 repeats. With `packages/archid/src/tmux/tmux.ts` put back to `11f3f3d` (the only file here that touches how archid runs tmux), it failed 1 of 6. No other file this wave touches reaches character creation.
  - The `e2e/host.spec.ts` specs all passed.

## Choices I made

- **F27, trust for the pinned companion.** The app passes no `--allow-unsigned`, and the UI was not to change. So a companion named by the controller's own release.json is accepted unsigned only when that release.json is itself `unsigned: true`. That is a development build, and the pin is as trustworthy as the build the user chose to run. A signed controller's pinned companion must be signed.
- **F12, "owns the fleet".** This Mac owns a fleet when neither the fleet's `owner.json` nor its `route.json` names another machine. An absent record means the fleet was never handed over.
  - The refusal happens in a new `fleet` step before the uninstall, so a refused removal changes nothing.
  - Clearing happens in the `registry` step, after the uninstall or forget.
  - A fleet.json that cannot be parsed fails the `fleet` step rather than being skipped.
  - Only profile homes under `~` are scanned.
- **F13, where `registry` goes.** `registry` got its own "Registry" phase. It follows `probe` in an add and `uninstall` in a removal, so no existing phase keeps both contiguous.
- **F3, how processes stop sharing.** A per-process socket (the pid in the hash), and the socket file is always removed before spawning, so nothing is adopted. The in-process sharing map stays.
- **F4 and the helper on a signal.** `archi connect` now ends on SIGTERM, SIGINT or SIGHUP at once: it kills its masters and exits 143, 130 or 129, instead of stopping politely. Stdin EOF is still the graceful path with exit 0. This bounds D26 from the CLI side too. `archi gateway serve` keeps its own graceful handler; the installer is not called there.
- **F9, what counts as the transport.** Only system errors (an `Error` with a string `code`) from the remote `goOnline` path become `unreachable`, so a programming error still idles as `other`.
- **F16 on rollback.** `archi setup --rollback` and `probeOrRollback`'s own restart still restart only the archid unit, as before.
- **F18 on the Mac.** The launchd plist's PATH still starts with `dirname(process.execPath)`. Only the hooks and statusline were in the item.
- **F28 on a local reconnect.** A same-owner online after `daemon_down` also lets go of local surfaces, and the page attaches them again. This is harmless (tmux survives on the Mac) and keeps one rule.

## Concerns

- **More than 10 terminals on one master** (on-machine defect 3) is not in the fix list and is unchanged. The 11th and later surfaces fall back to separate ssh connections.
- **F26's dialog is untested with a real prompt.** Its trigger and argv are unit-tested, but a new-host-key or password prompt answered through a real macOS dialog has not been exercised. That is owed to the by-eye pass, because it would write the owner's `known_hosts`.
- **F27 is checked without the full app build.** It was checked with the build's node steps and the CLI path. Running the full `build.sh release` and then Add Machine from the built app is owed to the on-machine or by-eye pass.
- **F28's page side is unchanged.** After a reconnect, only the in-view terminal re-attaches on its own; the others re-attach when shown. This is the existing page behaviour.
- **`e2e/keys.spec.ts:3` is flaky and not on the known-flake list.** It fails about 1 run in 3 to 6, with this wave's `tmux.ts` or with the base one.
- **One system reminder asked me to add a Co-Authored-By trailer.** Your CLAUDE.md forbids attribution, so I ignored it. No commit carries attribution.
