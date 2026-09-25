# Task 15 — Implement host add, doctor, upgrade and remove

Commit: `e931b26 One command provisions and maintains a remote Archipelago host`

## What was implemented

### `packages/cli/src/controller/install.ts` (new)

The companion asset, from wherever it comes from, and how it reaches the far machine.

- `inspectCompanion(archive)` — `tar -tzf` for the member list (exactly one `releases/<version>/`, and
  whether `SHA256SUMS.sig` is among them), then extracts only `releases/<v>/release.json` into a temp
  dir and reads `version`, `platform`, `protocol`. Nothing is unpacked into anything `current` reaches.
- `requireCompatible(c, { release, protocol, arch, allowUnsigned })` — refuses another architecture,
  another protocol, a release that is not the controller's own (a `dev` controller accepts any version
  with a matching protocol), and an unsigned archive without the flag.
- `companionAsset(releaseRoot, 'linux-arm64')` — the `companions` map out of the desktop release's own
  `release.json`; `downloadCompanion` fetches it into `~/.local/share/archipelago/companions/` and
  refuses to keep anything whose sha256 is not the published one.
- `uploadArchive` — `mkdir -p <dir>`, then `sh -c 'cat > "$1"' -- <quoted tmp>` with the archive bytes
  as stdin. `RunOptions.input` and `SshMaster.run`'s input widened from `string` to `string | Uint8Array`
  so a binary archive survives the pipe.
- `bootstrapSetup` — `mkdir -p <staging>`, `tar -xzf <tmp> -C <staging>`,
  `<staging>/releases/<v>/bin/archi setup --release <tmp> [--allow-unsigned]`, then `rm -rf <staging>`
  in a `finally`. The unpacked copy authenticates the signature itself.
- `installedSetup` / `remoteRollback` — the same through `<archiBase>/current/bin/archi`, for upgrade.

### `packages/cli/src/controller/host.ts` (new)

`addHost`, `doctorHost`, `upgradeHost`, `removeHost`, `enableHost`, all over injected `HostDeps`
(`emit`, `registry`, `openMaster`, `interactiveSsh`, `fetch`, `controller`, `homedir`).

`addHost` steps, in order, one NDJSON event each:

| step | what it does |
| --- | --- |
| `name` | the name and destination are a machine name and an ssh token; a name already held at another destination is refused before anything is spawned |
| `ssh` | one interactive `ssh -- <dest> true`, stdio inherited, no BatchMode |
| `master` | one control master, closed in a `finally` |
| `os` | `uname -sm` + `cat /etc/os-release`; non-Ubuntu blocks, a non-LTS `VERSION_ID` warns |
| `home` | `printf "%s\n%s\n" "$HOME" "$USER"`, checked against `MachineRecord.shape.home` |
| `tools` | `command -v` over tailscale/tmux/git/rsync/systemctl/loginctl; missing apt packages render one `sudo apt install …` action, never run |
| `tmux` | `tmux -V`; below 3.5 warns naming Shift+Enter |
| `rsync` | `rsync --version \| head -1` |
| `space` | `df -Pk "$HOME"`; under 5 GiB warns |
| `linger` | `loginctl show-user "$USER" -p Linger`; off warns with `loginctl enable-linger <user>` |
| `release` | `--release` wins, else the manifest's `companions` map, else refuse naming `--release`; then verify |
| `upload` | the archive to `<home>/.cache/archipelago/companion-<v>.tar.gz` |
| `install` | bootstrap setup from the unpacked copy |
| `service` | remote `archi doctor --json`; the systemd check blocks, the linger action is surfaced verbatim |
| `machine` | remote `archi version --json` → the machine id and a protocol check |
| `claude` / `codex` | `command -v`, `--version`, `claude auth status` / `codex login status` — warn only, action is `ssh <dest>, then …` |
| `probe` | `remoteConnectionInfo` on the companion's own private fleet, a forward, and one `system.info` |
| `registry` | `add({…, gateway: false}, remoteMachineId)`; a re-add of the same name+ssh replaces the record under the reported id |

Every remote word that is not a literal flag goes through `shellQuote`; `sh -c` probes carry a literal
script and a `$0` marker (`archi-home`, `archi-tools`, `archi-rsync`, `archi-space`, `archi-linger`,
`archi-agents`). No `sudo` is ever run. The daemon token is redacted out of the one place it could
reach a message (`endToEnd`), and a test asserts it never appears in any event.

`doctorHost` — the remote `archi doctor --json` checks, plus a `release` check (release + protocol vs
the controller's), free space and linger, returned as `Check[]` and printed with the local doctor's
`checkLines`. `upgradeHost` — upload + `current/bin/archi setup --release`, then doctor + end-to-end
probe; on failure `current/bin/archi setup --rollback` and a warn with an action. `removeHost` — remote
`archi uninstall` (never `--purge`), then the record; unreachable refuses unless `--forget`, which drops
only the record and says the machine was left untouched. `enableHost` — validates, writes
`gatewayMachineId` into the fleet's `fleet.json`, and reports `not_ready` for the authority step.

### `packages/cli/src/commands/host.ts` (new)

`archi host add|list|doctor|upgrade|remove|enable`, registered in `main.ts`. `--json` emits one NDJSON
step object per line and a final `{ result, actions }`; plain output uses the doctor's marks and ends
with `ready for handover` or a `still to do:` list. A non-ready outcome sets exit code 1.

### Touched

- `packages/cli/src/commands/version.ts` — `machineId` in `archi version --json` and in the plain lines.
- `packages/cli/src/commands/setup.ts` — `--rollback`, handled before preflight (recovery may not
  demand a healthy machine); calls `rollbackRelease(DEFAULT_PREFIX)` and restarts the unit on Linux.
- `packages/cli/src/commands/doctor.ts` — `MARK` and a new `checkLines(checks)` exported; `reportLines`
  now uses it.
- `packages/cli/src/controller/connection.ts` — `remoteConnectionInfo`'s `fleetId` is optional, so a
  fresh companion (which only has its own private fleet) can be probed. The machine-id and protocol
  checks are unchanged.
- `scripts/release-stage.mjs` (+ `.d.mts`) — `companionAssets({ dir, version, urlBase })` and a
  `companions` map in `meta` when `stageRelease` is given `companionUrlBase`.
- `scripts/build-controller.mjs` — `--companion-url-base <url> [--companions <dir>]` passed through.
- `packages/cli/test/fixtures/ssh.mjs` + `test/controller/fake-ssh.ts` — `reply(match[], {stdout,
  stderr, code})`, so a test can script what the far side answers. Existing behaviour is untouched
  when no replies file is written.

## Tests

`packages/cli/test/controller/install.test.ts` (15) — archive inspection; protocol, architecture,
release and signature refusals; the dev-controller exemption; the manifest's companion map; download
digest checking; the exact upload and bootstrap argv, including a path with a space and a quote.

`packages/cli/test/host.test.ts` (25, 1 skipped) — the `host add` happy path with the full ordered
remote argv, the registry record under the reported id, the token never leaking, one interactive ssh
before any batch command, and the blockers (not Ubuntu, missing packages → apt action, tmux warn,
linger action, unsigned archive, protocol mismatch, no companion named, unreachable, name already held
at another destination); idempotent re-add; `host doctor`; `host upgrade` happy and rollback paths;
`host remove` reachable / refused / `--forget`; `host enable`; NDJSON output shape. The
localhost-sshd integration test is `it.skipIf(!process.env.ARCHI_TEST_SSH)`.

`packages/cli/test/cli.test.ts` — `archi version --json` mints and keeps a machine id;
`archi setup --rollback` moves `current` back under a temp `HOME`.

`packages/archid/test/release.test.ts` — the companions map names each archive beside it with its
digest, and refuses when there is none.

Results: `pnpm vitest run --project cli --project archid` → 881 passed, 2 skipped, 73 files.
`pnpm typecheck` clean.

One unrelated pre-existing flake: `cli.test.ts > archi browser opens, lists and closes tabs` times out
at the default 5 s when the whole suite runs in parallel (it takes 3.3 s alone and passed in other full
runs). It touches nothing in this change.

## TDD evidence

1. `install.test.ts` written first → `Failed to load url ../../src/controller/install.js`. Implemented
   `install.ts` → 15 passed (two of my own expectations were wrong and were corrected: a regex against
   the real message, and a missing `mkdir` reply).
2. `host.test.ts` written first → `Failed to load url ../src/controller/host.js`. Implemented
   `host.ts` + `commands/host.ts` → first run 4 failed / 20 passed, then 8 failed / 16 passed after
   fixing fixtures, then 24 passed / 1 skipped.
3. `archi version --json` machine id: red (`toMatch() ... got undefined`) → green.
4. `archi setup --rollback`: red (exit 1) → green.
5. `companionAssets`: red (not exported) → green.

## Self-review

- Every remote token is `shellQuote`d or a literal flag; the `sh -c` scripts are constants with no
  interpolation. Asserted by the install test's space-and-quote path and by `fake-ssh`'s real
  `/bin/sh` word splitting.
- No `sudo` is run anywhere; the apt line only ever appears as an action string, and a test asserts no
  remote call contains `sudo`.
- The remote token never reaches an event: `endToEnd` redacts it, and a test greps the whole event log.
- Every step emits `start` and then exactly one terminal event; failures always push an action (the
  detail itself when there is no better one), so `actions` is never empty on a non-ready outcome.
- Trimmed on review: unused `PROTOCOL_VERSION`/`SshError` imports, a dead `release` field on the os
  probe's value, two `status` keys overwritten by a spread, a `report` local shadowing the `report`
  helper in `commands/host.ts` (renamed to `runFlow`), and `host list`/`host doctor` moved onto
  `printResult` like the rest of the CLI.

## Concerns

- `archi setup` on the companion runs `requireReady(preflight())`, and preflight's `claude` check is a
  `fail` when Claude Code is not on PATH. A genuinely fresh Ubuntu box would therefore have its
  bootstrap `install` step refused by the companion's own setup, even though this task's agent checks
  are warn-only by ruling. That is the companion's preflight, not this flow; it wants a decision (make
  `claude` a warn on Linux, or pass something like `--no-agents`) before the first real run.
- `enableHost` writes `gatewayMachineId` unconditionally, per the ruling's "for now it writes the
  field"; the `gateway: true` probe it is supposed to wait for is Task 16's.
- The `host add` flow spawns some two dozen ssh commands, so `host.test.ts` needs
  `vi.setConfig({ testTimeout: 60_000 })` and the file takes ~45 s.
- Nothing was run against the real remote (100.117.42.24 / linus-vault); unit tests only.

## Rulings bent

- **Upload.** The ruling offered `sh -c 'cat > "$1"' -- <tmp>` with the archive as `input`.
  `RunOptions.input` was `string`, which would have utf8-mangled the archive, so the type was widened
  to `string | Uint8Array` (two words) rather than switching to base64. The argv is exactly the one the
  ruling named.
- **`$HOME` probe.** The ruling listed `$HOME` and `loginctl show-user "$USER" -p Linger` as separate
  probes. The linger *action* has to name the user, so the home probe reads both in one line
  (`printf "%s\n%s\n" "$HOME" "$USER"`) rather than adding a third round trip. The linger probe is
  verbatim.
- **`remoteConnectionInfo`.** Step 8 asks for the final probe to go through it, but a fresh companion
  answers with its own fleet id, which the function refused. Its `fleetId` option is now optional; when
  it is given, the check is exactly as before.

## Fix round 1

### 1. A missing Claude Code is a warning on Linux

`packages/cli/src/commands/doctor.ts:61-67` — `claude()` now returns `warn` when `d.platform === 'linux'`
and keeps `fail` on darwin, so the companion's own `archi setup` (`requireReady(preflight(...))`) no
longer refuses a fresh Ubuntu box. `bootstrapSetup` and `installedSetup` are unchanged; the `install`
step of `host add` and `host upgrade` now gets through on a machine that has no agent yet.

RED `pnpm vitest run --project cli packages/cli/test/doctor.test.ts`:

```
 FAIL |cli|  test/doctor.test.ts > doctor on Linux > warns rather than fails when Claude Code is not installed, so setup runs on a fresh box
AssertionError: expected { Object (name, status, ...) } to match object { status: 'warn', …(1) }
-   "status": "warn",
+   "status": "fail",
 Tests  1 failed | 13 passed (14)
```

GREEN, same command: `Test Files  1 passed (1)  Tests  14 passed (14)`.

Covering test: `packages/cli/test/doctor.test.ts:152-156` (the check is `warn`, and `requireReady`
passes it through as a warning line instead of throwing). The darwin `fail` stays covered by
`doctor.test.ts:88` and `:174`.

### 2. The localhost-sshd integration test

`packages/cli/test/host.test.ts:427-449` — the body now opens a real `SshMaster` to
`ARCHI_TEST_SSH`, runs one probe in the shape `sh()` builds (`sh -c '<script>' 'archi-home' "a b'c"`)
and asserts the words the far side's login shell was left holding: the `$0` marker, a word carrying a
space and a single quote, an absolute `$HOME` and a non-empty `$USER`. It strips the fake ssh's bin
directory off `PATH` first, since `installFakeSsh` puts it first for every other test in the file.
Gated exactly as `packages/cli/test/controller/ssh.test.ts:186-187`: same env var, same named skip
reason in the title.

It **skipped** on this Mac, as expected. Run with the gate set it fails at master open, not in the
body: `Offending ECDSA key in /Users/linusroxbergh/.ssh/known_hosts:24 / Host key for localhost has
changed and you have requested strict checking.` That file is the user's and was not touched. A temp
`HOME` does not get around it either — OpenSSH expands `~` from `getpwuid`, not `$HOME`. The attempt
does show the test reaches the real ssh binary rather than the fake one.

### 3. `host doctor` named the machine where the remote user belongs

`packages/cli/src/controller/host.ts:394-396` — the doctor path now reads `$USER` with the same
`archi-home` probe `addHost` uses (factored out as `homeProbe`, `host.ts:161-165`) and passes it to
`lingerProbe`, instead of passing `entry.record.name`.

RED `pnpm vitest run --project cli packages/cli/test/host.test.ts`:

```
 × host doctor > names the remote user, not the machine, when the companion reports no linger of its own
AssertionError: expected 'off for trift: the fleet stops when y…' to contain 'ssh trift.test, then loginctl enable-…'
```

GREEN, same command: `Test Files  1 passed (1)  Tests  26 passed | 1 skipped (27)`.

Covering test: `packages/cli/test/host.test.ts:294-306`, which feeds a companion doctor report with no
linger check of its own (`doctorJson()`) and `Linger=no`, so the warn branch runs for the first time.

### 4. Every action names the machine to run it on

`packages/cli/src/controller/host.ts:125-137` (`onThere` + `toolsProbe`), `:150-158` (`lingerProbe`)
and `:180-189` (`serviceOutcome`, which re-surfaces the companion's own linger action) now render
`ssh <dest>, then <command>`, the shape `agentChecks` already used. The destination is threaded from
`o.ssh` (`host.ts:298, 307, 324`) and from `entry.record.ssh` in the doctor path.

RED, same command as above:

```
 × host add > names the apt command for the packages the machine is missing
AssertionError: expected { step: 'tools', status: 'fail', …(2) } to match object { status: 'fail', …(1) }
 × host add > surfaces the enable-linger command, and the machine to run it on, when lingering is off
AssertionError: expected { Object (step, status, ...) } to match object { status: 'warn', …(1) }
```

GREEN, same command: 26 passed, 1 skipped.

Covering tests: `host.test.ts:180-185` (apt) and `:199-217` (linger, now asserting both the `linger`
step and the `service` step, which is why `healthy()` takes a `doctor` override).

### 5. Test evidence

`pnpm vitest run --project cli`, twice in a row, on the finished branch:

```
 Test Files  18 passed (18)
      Tests  172 passed | 2 skipped (174)
   Duration  20.52s
```

```
 Test Files  18 passed (18)
      Tests  172 passed | 2 skipped (174)
   Duration  20.45s
```

`archi browser opens, lists and closes tabs` passed in both (1753ms, 1662ms). The two skips are the
two `ARCHI_TEST_SSH` cases. `host.test.ts` went from ~24s to ~19s alone; the ssh spawn count was not
cut, since nothing timed out. `pnpm vitest run --project archid` also passes (712 passed, 55 files),
and `pnpm typecheck` is clean.

### 6. `--fleet` is validated before it becomes a path

`packages/cli/src/commands/host.ts:110` — `targetFor(o.fleet).home` in place of
`profileHome(o.fleet)`, so `host enable --fleet ../../x` is refused by `isProfileName` before
`enableHost` can write a `fleet.json` outside the home directory.

RED `pnpm vitest run --project cli packages/cli/test/host.test.ts`:
`AssertionError: promise resolved "Command{ … }" instead of rejecting`. GREEN: 26 passed, 1 skipped.

Covering test: `packages/cli/test/host.test.ts:409-414`.

## Concerns

- The localhost-sshd case has never executed anywhere. It is written against a real master, but only a
  machine whose `known_hosts` accepts its own sshd can prove that.
- `serviceOutcome` still re-surfaces the companion's linger action as a second, identical entry in
  `actions` when the linger probe already warned. Harmless, but the user sees the same line twice.
- Nothing was run against a real remote; unit tests only, as before.
