# Task 37b report: fresh installs, the release scan and the release workflow

Status: **DONE_WITH_CONCERNS**

- **37a's minors.** M1–M6 are fixed, one commit each. The full 37a harness, every scenario, passed again on arm64
  and, for the first time, on x86-64 (a full-system emulated VM): 20 handovers each.
- **Fresh installs.** `scripts/integration/fresh-install.sh` provisions a clean Ubuntu 24.04 machine as a user does:
  `host add` from the Mac controller tree, with the companion archive that tree pins. Then lingering, a restart
  with no login, `host upgrade` to a second release and `setup --rollback` back. It passes on arm64 (native) and on
  x86-64 (full-system emulation), and with signed releases.
- **Scans.** `scripts/release-scan.mjs` fails on secrets, developer paths and checkout dependencies. It found one real
  leak, now fixed. `scripts/release-build.sh` builds a release and scans it last.
- **Workflow.** `.github/workflows/release.yml` runs on a tag. It builds on macOS, then runs the integration and
  fresh-install jobs on x64 and arm64 Linux, and publishes signed artifacts only after all of them passed. Without
  the secret, a tag is a dry run.
- **Defects.** Three product defects were found and fixed, each with a failing test or run first:
  - the controller's rsync named the build machine's temp folder;
  - `host add` listed the lingering command twice;
  - a rollback left the gateway on the release it went back from.
- **Concerns.** No GitHub run (billing). The Linux runners' path for the Mac controller has run only on a Mac's
  Node. Two Homebrew packages are left installed. Details below.

Commits (BASE 2bd314ad; `701b5b93` is the orchestrator's ledger entry):

| Commit | Subject |
| --- | --- |
| `0d85957b` | The integration driver takes a handover's result only once the controller's output has been read to its end |
| `ee27bda1` | The integration run checks that every turn appends to the agent's one transcript, and that both machines name the same gateway |
| `ffb557cb` | The integration run checks that the agent runs resumed under its session id after every handover, abort and resume |
| `bb565ccb` | The integration run counts a journal the daemon set aside as unreadable as a journal left behind |
| `99323455` | The integration run keeps the controller's stderr with its logs, and writes them to a temp folder unless told where |
| `ac9ba112` | The integration machines install only the packages a handover uses |
| `5be9586d` | A release scan fails on a secret, a developer path or a checkout dependency in any release archive or tree |
| `a2dfadad` | The controller release carries its rsync without the debug map that named the build machine's temp folder |
| `6621aaa1` | The integration drivers share one module for the run log, docker and the checks a step collects |
| `ae989874` | One script builds the controller and both companion archives of a release into one folder and scans them |
| `7aa2afca` | Host add lists the lingering command once, though both its linger and service steps name it |
| `2431ce5f` | A rollback restarts the gateway with the daemon, so neither keeps running the release it went back from |
| `80cf5144` | The fresh-install run adds a clean Ubuntu machine from the controller the app carries, upgrades it and rolls it back, checking what its units run each time |
| `f40d2ecc` | The release and fresh-install scripts pass shellcheck |
| `636d03bd` | A release tag builds, hands over, fresh-installs on both architectures and publishes signed artifacts only after all of it passed |
| `1a67128b` | The integration docs say how to run the fresh-install run, the release build and its scan, what the release workflow does, and what only a real runner can show |
| `ac94cf15` | The fresh-install run keeps the account's home under /var/tmp, which a Linux machine does not empty when it restarts |

## 37a's M1–M6

| | Finding | Fix | Commit |
| --- | --- | --- | --- |
| M1 | `drive` could read the result before the controller's stdout was read to its end. | `exited` resolves on `close`, not `exit`. Nothing the controller spawns inherits that pipe: ssh and rsync get pipes of their own, and the master gets `ignore`. | `0d85957b` |
| M2 | Only the turn on remote checked the transcript, and the claim that both machines name the gateway was not checked. | The check moved into `turn()`, so every turn checks it: the fixture's first, the one on remote and the one after the return. It needs one transcript file, the same name as before, and exactly 2 more records. `clean()` now checks `gatewayMachineId` in both machines' fleet.json. | `ee27bda1` |
| M3 | The `--resume <sessionId>` argv check ran only in `clean()`. | It moved into `runsFleet`, so it runs after every clean handover, abort and resume. | `ffb557cb` |
| M4 | `noJournals` missed a quarantined journal. | Its check also requires `!handover.quarantined`. | `bb565ccb` |
| M5 | The controller's stderr was not kept, and the default `--out` was `./integration-logs` in the checkout. | `drive()` copies `<label>.stderr` next to the `.ndjson` when it is not empty. Without `--out`, the logs go to a new `fleet-handover-*` folder under the system temp folder, and the run names it. The docs were updated. | `99323455` |
| M6 | `socat` and `xz-utils` were installed but never used. | Both are dropped. | `ac9ba112` |

The reruns below check M1–M4:

- all 20 summaries hold a result read after `close`;
- every turn's transcript check passed;
- the resume check passed after every recovery;
- no journal was left.

For M5, none of the 40 controllers in the reruns wrote to stderr. The `.stderr` files in the machines are all empty,
so no copy was made.

## What each new script and job does

| File | What it does |
| --- | --- |
| `scripts/release-scan.mjs` (+ `.d.mts`, `test/release-scan.test.ts`) | Scans archives (unpacked to a temp folder) or folders, and exits 1 on a hit. Each hit names the file and the rule, never the secret. **Secrets:** private keys, and Anthropic, OpenAI, GitHub, AWS, Slack, Google, npm and Tailscale keys, plus credential file names (`.credentials.json`, `id_*`, `*.pem`/`.key`/`.p12`, `.npmrc`, `.netrc`, `.env`, `.git-credentials`). **Developer paths:** any `/Users/…`, and this builder's `$HOME`, checkout and temp folder. A folder of one component (`/tmp`, `/root`) is skipped. `node/`, the runtime whose digest the build checked against nodejs.org, is held only to the builder's own paths, as Node's darwin binary carries `/Users/admin/build/ws/…`. **Checkout dependencies:** an import, require or dynamic import in our `.mjs`/`.js` that is not a Node builtin, not inside the release, and not one of the three optional modules the bundles fall back from (`bufferutil`, `utf-8-validate`, `supports-color`); a symlink out of the release; a `node_modules` or `.git` folder. `--secrets-only` is for logs. A scan of the release takes 1.7 s. |
| `scripts/release-build.sh --out --version --url-base` | Builds `build:mobile`, both companions, and the controller tree whose manifest pins each companion by URL and digest. Packs the tree as `archipelago-controller-<v>-darwin-<arch>.tar.gz`, then scans the three archives. `ARCHI_RELEASE_KEY` signs, as before. macOS only. About 24 s. |
| `scripts/integration/harness.mjs` | What both drivers share, moved out of `fleet-handover.mjs` unchanged: `flags`, the run log, `say`, `docker`, `check`/`step`, and `booted` (whose wait is 300 s, for emulated machines). |
| `scripts/integration/Dockerfile` | Split into a `machine` stage (systemd, sshd, the tools, the `tailscale` double, no account) and the handover run's last stage, which adds the `archi` account with linger on. |
| `scripts/integration/fresh-install.sh` | Takes the docker host's architecture. Unless `--release` and `--upgrade` are given, builds both releases with `release-build.sh` (`<describe>` and `<describe>-next`). Builds the `machine` stage and runs the driver. |
| `scripts/integration/fresh-install.mjs` | The steps and checks in `docs/integration.md` "Fresh installs". In short: the tree pins the companion (name and sha256). A clean machine gets an account at the controller's home (`/var/tmp/h*`, key login, linger off, no `node` anywhere). ssh reads only the run's own files. `host add` has exact expected advice, and the three actions exactly. Linger goes on, then a restart with no login. Both units must be active and enabled, each running `releases/<v>/node/bin/node` with `ARCHI_RELEASE_ROOT=releases/<v>`, with `current` and the shim on `<v>` and no other node or checkout. `host doctor` fails nothing and six named checks are ok. `host upgrade` passes the same checks on the second release. `setup --rollback` over ssh passes them on the first. On a Mac the tree runs through its own shim and Node. On a Linux runner its `lib/archi.mjs` runs on the runner's Node, with `ARCHI_RELEASE_ROOT` at the tree. |
| `.github/workflows/release.yml` | On `v[0-9]*` tags. **build** (macos-latest) writes the secret to a 0600 file only when present, runs `release-build.sh` for the tag and for `<tag>-next`, deletes the key, and uploads both as workflow artifacts. **integration** (matrix: ubuntu-24.04 x64, ubuntu-24.04-arm arm64) runs `fleet-handover.sh --archive` on the release's own companion. **fresh-install** (same matrix) runs `fresh-install.sh --release --upgrade`. On failure, both scan their logs `--secrets-only` and upload them only if that passed. **publish** `needs: [build, integration, fresh-install]` and has `contents: write`. With the key it writes `SHA256SUMS` over the archives, signs it with `ssh-keygen -Y sign -n archipelago-release`, verifies it against the committed `allowed_signers`, and runs `gh release create --verify-tag`. Without the key, it prints a dry-run notice and the digests. |

`ci.yml` is unchanged.

## Runs

All runs were local, on this Mac. Colima's default profile (arm64, 2 CPUs, 2 GiB) was stopped when the task began;
I started it. For x86-64, the `x64` profile ran on full-system qemu (8 CPUs, 8 GiB).

`$SP` is
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad`.

### Fresh install, upgrade and rollback

| Run | Command | Result |
| --- | --- | --- |
| arm64 run1 | `fresh-install.sh --release $SP/fi/rel-arm1 --upgrade $SP/fi/upg-arm1 --keep` | FAIL at host add: the gateway crash-looped with `listen EINVAL` on `…/gateway/authority.sock`. The home under the realpath'd temp folder made the socket path 130 bytes (the limit is 108). **Harness fix:** a short home. |
| arm64 run2 | same, short home | FAIL at host add: `actions` listed the lingering command twice (defect 2 below). |
| arm64 run3 | rebuilt with `7aa2afca` | host add PASS. FAIL reading `host doctor --json`, which is pretty-printed. **Harness fix:** parse the whole output. |
| arm64 run4 | same | host add, linger and restart, and upgrade PASS. **FAIL at rollback:** `archipelago-gateway.service runs fi2: exe …/releases/fi2-next/node/bin/node` (defect 3 below). |
| **arm64** | `scripts/integration/fresh-install.sh --out $SP/fi/arm64-full`, which built both releases from `2431ce5f` with the driver not yet committed (`2431ce5f-dirty`) | **ALL PASS**. 69 s in all, 18.8 s of it the run. |
| arm64, host Node | the driver with `native: false` forced in a scratch copy, releases `80cf5144` | **ALL PASS** in 15.5 s: the Mac tree's `archi.mjs` on this Mac's Node 24.18, which is the Linux runners' path |
| **x86-64** | `DOCKER_CONTEXT=colima-x64 fresh-install.sh --release $SP/fi/rel --upgrade $SP/fi/upg --out $SP/fi/x64-full` (`80cf5144`) | **ALL PASS** in 129.7 s. Host add took 42 s, the upgrade 51 s. `uname -m` was `x86_64`, and every unit ran `releases/80cf5144/node/bin/node`. |
| arm64, signed | releases built with a throwaway ed25519 key that a temporary `allowed_signers` pinned (restored before the run) | **ALL PASS**. `release` said `…for linux-arm64 from the archive you named`, with no "(unsigned)". `--allow-unsigned` appears 0 times in run.log. |
| arm64, key not pinned | a release signed by that key, but built with the committed (comment-only) `allowed_signers` | **FAILED as it should**, at host add `release`: `SHA256SUMS is not signed by archipelago-release: … ssh-keygen -Y verify …`. The publish job would never run. |
| arm64, `/var/tmp` home | after `ac94cf15` | **ALL PASS** in 18.8 s |

- **Why `/var/tmp`.** A container test showed `/tmp` is emptied when the machine boots (`D /tmp` in tmpfiles),
  while `/var/tmp` survives. On a Linux runner, `os.tmpdir()` is `/tmp`, so the account's home would have vanished
  at the restart step.
  - The x86-64 fresh install ran before this move, with its home under this Mac's per-user temp folder. The move
    changes only where the home is, and the arm64 rerun after it passed.
- **What each run leaves.** Each output folder holds `run.log`, `host-add.ndjson`, `host-upgrade.ndjson`,
  `rollback.json`, three `.machine.json` and three `.doctor.json` files, and `machine.log`.
- **What a passing host add looks like.** From arm64-full:
  - every step `ok`, except `tmux` (3.4) warn, `linger` warn and `service` warn (both naming
    `ssh fresh, then loginctl enable-linger archi`), and `claude` and `codex` warn ("not installed");
  - `actions: [lingering, install Claude Code, install Codex]`;
  - after the rollback, `done` held `current -> …/releases/2431ce5f-dirty` and restarts of both units.

### The 37a harness rerun

| Run | Command | Result |
| --- | --- | --- |
| **arm64, every scenario** | `DOCKER_CONTEXT=colima scripts/integration/fleet-handover.sh --archive $SP/fi/rel/archipelago-companion-80cf5144-linux-arm64.tar.gz --out $SP/it37b/full-arm64` | **ALL PASS**, 20 handovers in 798.8 s, generation 8 at the end. Every row matched 37a's table: kills landed at 761–2466 ms, drops gave up after 61–108 s, pre-commit rows aborted and post-commit rows resumed. |
| **x86-64, every scenario** | `DOCKER_CONTEXT=colima-x64 scripts/integration/fleet-handover.sh --archive $SP/fi/rel/archipelago-companion-80cf5144-linux-x64.tar.gz --out $SP/it37b/full-x64` | **ALL PASS**, 20 handovers in 2499.7 s (2510 s with the image build), generation 8 at the end. Every stop, `status` offer and recovery matched the arm64 run's, row for row. Kills landed at 12.6–35.0 s, and drops gave up after 85.6–130.9 s. |

This is the first x86-64 run of the harness. The setup, `host add` and `host enable` took 116 s. A clean handover
took 41–68 s, against 3 s natively.

### Scans

| Run | Result |
| --- | --- |
| RED: `node scripts/release-scan.mjs <probe companions x64, arm64> <probe controller tree>` before `a2dfadad` | FAIL: `m/releases/probe1/bin/rsync: developer path (/private/var/folders/qy/…/T/archi-rsync-C3m6lI/, and 251 more)`. These are Mach-O debug-map entries (`N_OSO`) for each `.o` file. The companions passed. |
| GREEN: controller rebuilt after `a2dfadad`, then scanned | ok, 117 files. `rsync --version` gave 3.4.4, and a copy with `--info=progress2` worked. |
| Every `release-build.sh` run (12 builds) | ok on every archive: 114 files per companion, 117 per controller, and 115/118 when signed. |
| Planted hits: a real x64 companion with an `sk-ant-oat01-…` string in `lib/archid.mjs`, the checkout path in `hooks/agent-hook.mjs` and a `lib/deps` symlink to the checkout's `node_modules`, plus a controller with an ed25519 private key at `release/signing-key` | **FAIL, exit 1**, with four hits: `Anthropic key (sk-ant… (52 characters))`, `developer path`, `link out of the release`, `private key`. The untouched arm64 companion in the same call was ok. |
| `release-scan.mjs --secrets-only` over the fresh-install output folders | ok. Without `--secrets-only`, the same folders fail on their paths, as they should. |
| `test/release-scan.test.ts` | 12 passed. Each of 5 mutants of the scanner fails 1–9 of them: no `node/` exemption, no link-escape check, no optional-module list, no short-path guard, and an OpenAI rule that also matches `sk-ant-`. |

### The publish step's signing, and the checks

- **Signing.** The publish step's shell ran in an `archi-it:machine` container (GNU coreutils, OpenSSH 9.6) against
  the signed archives:
  - `sha256sum`, then `ssh-keygen -Y sign`, then `-Y verify` against the pinned signers: `Good "archipelago-release"
    signature`;
  - against the committed `allowed_signers`: `Could not verify signature`, exit 255, which stops the step before
    `gh release create`.
- **actionlint** 1.7.12 (`rhysd/actionlint` image) on `ci.yml` and `release.yml`: 0 errors.
- **shellcheck** 0.11.0 on `release-build.sh`, `fresh-install.sh` and `fleet-handover.sh`: SC1007 on the two new
  scripts, fixed in `f40d2ecc`, then clean.
- **`pnpm typecheck`**: clean.
- **vitest.** `ARCHI_REQUIRE_RSYNC=1 pnpm test --project cli --project archid --project scripts` gave 121 files passed
  and 1 skipped, 3470 tests passed and 5 skipped.
- **Lint.** eslint `no-undef` and `no-unused-vars` over `scripts/integration/*.mjs` and `release-scan.mjs`: clean.
- **Action tags.** `actions/download-artifact@v8` exists, checked through GitHub's API. The other tags are the ones
  37a checked.

## Defects found and fixed

1. **The controller's rsync named the build machine's temp folder** (`a2dfadad`).
   - Found by the scan (RED above): 252 debug-map paths under `/private/var/folders/…/T/archi-rsync-*`.
   - `build-controller.mjs` now runs `strip -S` on the staged `bin/rsync`.
   - The cached `vendor/rsync` binary stays as it was, so no cache key changed. GREEN is the rescan.
2. **`host add` listed the lingering command twice** (`7aa2afca`).
   - Found by fresh-install run2: both the `linger` and the `service` step return the same action.
   - `Runner` now adds an action only once.
   - RED: the tightened `host.test.ts` case ("surfaces the enable-linger command…") with `toEqual` got the
     action twice. GREEN: 57 passed.
3. **A rollback left the gateway on the release it went back from** (`2431ce5f`).
   - Found by fresh-install run4: after `setup --rollback`, archid ran the old release, and the gateway still ran
     `releases/fi2-next`.
   - `probeOrRollback`, the upgrade's automatic rollback, had the same gap: the gateway had just been restarted onto
     the failing release and stayed there.
   - New `restartUnits(run, fleet)` restarts archid and the gateway. `setupLinuxRelease`, `probeOrRollback` (now
     given `fleet`) and `archi setup --rollback` all use it.
   - RED: 2 failed in `linux-setup.test.ts` (`restartUnits is not a function`, and one restart call where two were
     expected). GREEN: 26 passed, and the fresh-install run passed.

The harness fixes made while building the run are in its first commit or in `ac94cf15`: the short home, parsing the
pretty-printed JSON, and `/var/tmp`.

## What only a real runner can prove

Actions jobs never start on this repository (billing), so every job here has run only as the local script it calls.
Owed to a first real tag:

- the upload: `gh release create` with the job token, `contents: write`, and a signed tag end to end in CI (the
  signed path ran locally, as above);
- the native `ubuntu-24.04` (x86-64) and `ubuntu-24.04-arm` runners: privileged systemd containers, iptables and
  published ports (x86-64 ran here only in emulation);
- workflow artifacts passing from the macOS job to the Linux jobs (`upload-artifact@v7`, `download-artifact@v8`);
- the Mac controller's `archi.mjs` on a Linux runner's Node, which has run only on a Mac's Node;
- `release-build.sh` on `macos-latest`: its `strip`, a cold `vendor/` cache (rsync from samba.org, Node from
  nodejs.org), and `build:mobile` on a fresh checkout.

## Concerns and observations

1. **No GitHub run.** See the previous section.
2. **Homebrew packages left installed.**
   - `qemu` 11.1.1 stays installed, as ruled.
   - So does `lima-additional-guestagents` 2.2.0. The ruling did not name it, but colima's x86_64 profile cannot
     start without it ("guest agent binary could not be found for Linux-x86_64"). `brew uninstall
     lima-additional-guestagents qemu` undoes both.
   - The `x64` profile was deleted. Its first start failed to forward the docker socket, and a stop and start fixed
     it.
3. **The gateway cannot start under a home longer than about 60 bytes.** Its socket path passes the 108-byte limit,
   and it crash-loops on `listen EINVAL`.
   - `host add`'s service step then shows only `activating (auto-restart)`, and nothing names the cause.
   - A real Mac home (`/Users/<name>`) never gets close, but a message would help. For Task 38/39.
4. **Copy on Linux.**
   - The companion's doctor tells a Linux machine to `brew install gh`.
   - `host add`'s install step shows setup's last line, here a `! path … not on PATH` warning (ledger m7).
   - For Task 39.
5. **The first signed tag needs `scripts/release/allowed_signers` to pin the key.** Without that, the fresh-install
   jobs fail and nothing is published, as shown with an unpinned key. The key would be read from the release's own
   file; the far-side check itself is Task 38's (m6), and is unchanged.
6. **What the upgrade proves.** The second release is the same commit under a `-next` name. The run proves the swap,
   the restarts and the rollback, not a change in behaviour between two releases.
7. **What the workflow leaves out.**
   - It builds only a darwin-arm64 controller (`macos-latest`), though `pins.json` also lists darwin-x64 Node.
   - It does not run the unit suites; `ci.yml`'s test job does, and it is still `workflow_dispatch` only.
   - The integration job is a matrix over both architectures, which doubles its time.
8. **Emulated x86-64 is slow.** It is 7–20× slower than native: host add took 42 s against 6 s, and a clean handover
   41–68 s against 3 s. It is fine for one run, not for iterating.
9. **Left in place.**
   - `archi-it:latest` and `archi-it:machine` are in the default colima VM. `rhysd/actionlint` was removed.
   - Colima's default profile is stopped again, and the docker context is `desktop-linux`.
   - The scratch build trees and the throwaway signing key were deleted. The run folders under `$SP/fi` and
     `$SP/it37b` are kept.
