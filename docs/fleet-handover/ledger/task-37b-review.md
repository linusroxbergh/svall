# Task 37b — review

Range 0d85957b..ac94cf15 (16 commits; 701b5b93 is a ledger entry). Reviewed against `task-37-brief.md` (37b: Do 3, 4,
5, 7 and the rulings), 37a's review (M1–M6), spec "Companion release", "Add Machine flow" and "Verification", and
`review-constraints.md`.

## Verdict: Needs fixes

0 Critical, 3 Important, 3 Minor. 37a's minors are fixed as asked. The workflow's gating and secret handling are
right, and the three product fixes are correct. Three things are not right yet:

- **I1.** An upgrade or a rollback still leaves every fleet but the private one on the release it left. This is
  2431ce5f's defect, on the units `host enable` adds, which are the fleets a handover moves.
- **I2.** The fresh install never takes the route the app takes.
- **I3.** The scan misses a private key inlined in a bundle, and it misses Codex's credentials.

## Spec and brief compliance

| Item | | Notes |
| --- | --- | --- |
| 37a M1: result read after `close` | ✅ | `machine.mjs:217`. The master's stdio is `ignore/ignore/pipe`, and ssh and rsync get pipes of their own (`ssh.ts:144`, `process.ts:28`, `rsync.ts:183`), so nothing holds the controller's stdout open. |
| 37a M2: every turn; gateway on both sides | ✅ | `turn()` runs the transcript check for all three turns. `clean()` checks `gatewayMachineId` on `left` and `now`. |
| 37a M3: resume argv after every move | ✅ | The check is in `runsFleet`. |
| 37a M4: quarantined journal | ✅ | |
| 37a M5: stderr kept; output under temp | ✅ | Docs updated. |
| 37a M6: unused packages | ✅ | |
| Do 3: clean Ubuntu 24.04, no Node or checkout | ✅ | The `clean machine` check, plus no `node` outside `releases/` and no `pnpm-workspace.yaml` at every stage. |
| Do 3: through the product's own path from the Mac-side artifact | ❌ | I2 |
| Do 3: units and linger after a restart with no login | ✅ | `/proc/<pid>/exe` and `ARCHI_RELEASE_ROOT` per unit, `current`, the shim, and linger |
| Do 3: upgrade and rollback reach every service | ❌ | True only on a machine with one fleet (I1) |
| Do 3: both architectures | ✅ | arm64 natively. x86-64 under full-system emulation, with releases from 80cf5144. The product code is the same at HEAD: `git diff 80cf5144 ac94cf15` touches only the driver's home folder, the workflow, the docs and two quoting lines. |
| Do 4: the scan fails on secrets, developer paths and checkout dependencies | ❌ | I3 |
| Do 4: no user credential in an uploaded artifact or log | ✅ | Gated in `release.yml`; `ci.yml` is not (M1) |
| Do 5: `needs:`, signing only with the secret, dry run, secret kept out of logs, argv and artifacts, permissions | ✅ | Also see M2. |
| Do 5 / Verify: actionlint | ✅ | Rerun here: 0 errors. |
| Do 7: `docs/integration.md` | ✅ | Two gaps: M1, and `docs/integration.md:245` says `v*` where the trigger is `v[0-9]*`. |
| Product fixes a2dfadad, 7aa2afca, 2431ce5f | ✅ | Each one's RED was rerun here as a mutant (below). 2431ce5f is correct but incomplete (I1). |

## Findings

### Critical

None.

### Important

**I1. `host upgrade` and `setup --rollback` leave every fleet but the target on the release they left.**

- **Where:**
  - `packages/archid/src/linux/setup.ts:163-173`: `restartUnits(run, fleet)` restarts `archipelago-archid@<fleet>`
    and the gateway, and nothing else.
  - It is called for the private fleet from three places:
    - `setup --rollback`: `packages/cli/src/commands/setup.ts:46`;
    - the upgrade, `setupLinuxRelease`, which `host upgrade` reaches through `bootstrapSetup` (`host.ts:469`);
    - the upgrade's automatic rollback.
  - `archi fleet provision`, which `host enable --fleet <profile>` runs, writes one unit per fleet
    (`provision.ts:61`).
- **Evidence:** reproduced on a fresh-install machine, with releases built from ac94cf15 and the controller run on
  Linux Node:
  - after the run, `archi --profile work fleet provision` added `archipelago-archid@work.service`;
  - `host upgrade` to `-next` reported `ready`;
  - `current` then led to `releases/v0.0.0-rv-next`, and the units ran:

    ```
    archipelago-archid@private.service  …/releases/v0.0.0-rv-next/node/bin/node
    archipelago-archid@work.service     …/releases/v0.0.0-rv/node/bin/node
    archipelago-gateway.service         …/releases/v0.0.0-rv-next/node/bin/node
    ```

  `setup --rollback` then restarted only private and the gateway. Why this matters:
  - The fleet that `host enable` put on the machine is the one a handover moves.
  - It keeps running the old release until something restarts it. That breaks the exact release match a handover
    needs.
  - The next upgrade prunes the release that daemon runs from.
  - The probe after an upgrade asks only the private daemon.

  The fresh-install run has only the private fleet, so it cannot see this. 2431ce5f's subject ("so neither keeps
  running the release it went back from") holds only for the two units it names.
- **Fix:**
  - In `restartUnits`, restart the gateway and every `archipelago-archid@*.service` that setup and provision wrote to
    the unit folder, with a unit test on the fake runner.
  - In the fresh-install run, provision a second fleet over ssh before the upgrade and add its unit to `runs()`.

**I2. The fresh install never takes the route the app takes.**

- **Where:**
  - `scripts/integration/fresh-install.mjs:214` and `:252` pass `--release <companion>`, plus `--allow-unsigned` for
    an unsigned build.
  - `fresh-install.sh:37-38` builds with `--url-base https://example.invalid/local-build`.
- **Evidence:**
  - The app runs `host add <name> --ssh <dest> --json` and `host upgrade <name> --json`
    (`apps/desktop/mac/Sources/Archipelago/ControllerProcess.swift:198-214`), never `--release`.
  - Without `--release`, `companionFor` (`host.ts:260-277`):
    - reads the pin from the tree's `release.json`;
    - downloads the companion, checks its digest and caches it under the controller's home;
    - accepts an unsigned development build on its pin.
  - The run skips all of that and checks the pin itself (`controller()`). A regression in that route (the tree's
    release root, the manifest lookup, the download or the cache) would pass the fresh-machine gate that the spec's
    release gate depends on.
  - The route works today. I rebuilt both releases with `--url-base http://127.0.0.1:8765/{release,upgrade}` and
    served the folders from the runner. Then I dropped `--release` and `--allow-unsigned` from a copy of the driver.
    It passed, ALL PASS, with `from http://127.0.0.1:8765/release/archipelago-companion-v0.0.0-rh-linux-arm64.tar.gz
    (unsigned)`.
- **Fix:**
  - **Locally:** build with a loopback `--url-base` and serve the release folders from a child process (the driver
    blocks on `spawnSync`). Then run `host add` and `host upgrade` without `--release`.
  - **In CI:** the first release carries the GitHub URL, which does not resolve before publish. So build the
    never-published `-next` release with a loopback `--url-base`, and take the upgrade by that route. Keep
    `--release` for the first add.

**I3. The scan misses a private key inlined in a bundle, and it misses Codex's credentials.**

- **Where:** in `scripts/release-scan.mjs`:
  - `:22`: the private-key rule needs a real newline after the header;
  - `:33`: the credential file names;
  - `SECRETS` has no bearer-token or JWT rule.
- **Evidence:** probes against the committed scanner:
  - **A key in a bundle.** An OpenSSH private key as a JS string literal, as a bundler emits it
    (`"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl…"`, with an escaped `\n`), in `releases/v1/lib/archi.mjs`: `ok`,
    exit 0. The rule only catches a key laid out as a PEM file, which the name rule mostly catches already.
  - **Codex's login.** A `home/.codex/auth.json` holding Codex's ChatGPT login (`id_token` and `access_token` JWTs,
    and a `refresh_token`): `ok`, exit 0. The release ships a `home/.codex/` template folder, so a copied login would
    land there.
  - **A compressed member.** A gzipped member holding an `sk-ant-` key: `ok`. No compressed member ships today, so
    this one can stay.
  - **No false positives.** The real release's bundles hold no PEM header and no `eyJ….eyJ….` string, so the rules
    below would not flag it.
- **Fix:**
  - Accept `\\n` as well as a newline in the private-key rule.
  - Add `auth.json` to the credential names.
  - Add a JWT rule, such as `\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}`.
  - Add a test for each.

### Minor

**M1. The logs scan skips credential file names, and `ci.yml`'s integration job uploads its logs unscanned.**

- **Where:** `release-scan.mjs:103` (`&& !o.secretsOnly`); `docs/integration.md:229-231`, `:241` and `:261`;
  `ci.yml:50-54`.
- **Evidence:**
  - `--secrets-only` over a folder holding `.credentials.json`, `id_ed25519` and `auth.json`, none with a token the
    content rules know, says `ok`.
  - The docs list credential names under "Secrets" and say logs get the secrets scan.
  - `ci.yml`'s `integration` job uploads the same kind of folder on failure, with no scan at all.
- **Fix:** keep the name rule under `--secrets-only`, since a log folder holds no such names by design. Give `ci.yml`'s
  upload the same `id: logs` scan gate as `release.yml`.

**M2. Signed archives stay in Actions storage whether the gate passes or not.**

- **Where:** `.github/workflows/release.yml:61-70`.
- **Evidence:**
  - With the secret set, the build job uploads the signed release and the signed `<tag>-next` as workflow artifacts.
    It does so before the integration and fresh-install jobs run, and they are kept for the default 90 days.
  - A tag that fails the gate still leaves release-signed archives downloadable from its run. Every installer
    accepts them without `--allow-unsigned`.
  - `-next` is never published.
- **Fix:** `retention-days: 1` on both uploads. The other jobs consume them within the same run.

**M3. On a Mac, `setup --rollback` moves `current` and restarts nothing.**

- **Where:** `packages/cli/src/commands/setup.ts:46` (`systemd ? … : done`), against the option's help, "and restart
  the daemon" (`:109`).
- **Evidence:** the launchd agent runs through `current` (`runFrom` gives `release: installed.current`). After a
  rollback, the Mac's daemon keeps running the release it went back from until it next starts. This is the Mac side of
  what 2431ce5f fixed on Linux. The change did not mean to touch it, but it sits on the line the change edited.
- **Fix:** either `launchctl kickstart -k` the agent unless `--no-launchctl`, behind an injectable runner so tests
  never reach the real launchd; or say in `done` that the daemon changes release at its next start. It can go to Task
  38 or 39.

## The implementer's concerns

1. **The gateway crash-loops under a long home.**
   - **The limit.** The socket is `<home>/.local/share/archipelago/gateway/authority.sock`, 48 bytes past the home.
     Linux's `sun_path` holds 108 bytes, so a home over 59 bytes fails on Linux.
   - **Who can hit it.** The Mac's own fleet sockets already fail for a home over 79 bytes: `~/.archipelago/hooks.sock`
     is 24 bytes past the home, and macOS allows 104. So only a 60–79-byte home fails on Linux alone. With the
     required matching `/Users/<name>` home, that is a Mac account name of 53–72 characters. It reaches a user only in
     principle; the harness hit it through a temp-folder home.
   - **Before version 1?** It is not a blocker. `host add`'s `home` step already has the home, and refusing there with
     the cause named takes a few lines. Route it to Task 38 or 39, together with the service step naming the gateway
     log's `listen EINVAL`.
2. **What only a real runner can prove.** One item is now covered: the Mac tree's `lib/archi.mjs` on Linux Node.
   - **How it ran:** a Debian container (Node 24.21, as root) as the controller, with the machine as a sibling
     container through the docker socket.
   - **Result:** ALL PASS in 18 s, both with `--release` and by the download route (I2).
   - **Still owed:**
     - the upload with the job token;
     - native runners: privileged systemd containers, iptables and published ports;
     - artifacts passing between jobs;
     - the build on `macos-latest`: `strip`, a cold `vendor/` cache and `build:mobile`.
3. **The first signed tag.**
   - The docs (`docs/integration.md:257-258`) and the `allowed_signers` header say how to pin the key. A tag without
     the pin fails only in the test jobs (the implementer's unpinned run), so nothing is published.
   - The build job could stop at once, before any test job runs. After it writes the key, it can compare
     `ssh-keygen -y -f` of the key against `scripts/release/allowed_signers` and fail with the cause named.
   - Once the secret exists, every `v[0-9]*` tag publishes, so a test tag is no longer a dry run. If that matters,
     skip publishing for tags with a `-`, or add a `workflow_dispatch` dry run.

## Verified clean

- **37a M1–M6:** each fixed as asked, at the lines in the table. The rerun evidence (`it37b/full-arm64` and
  `full-x64`) is ALL PASS with 20 summaries each.
- **a2dfadad.** The stripped `bin/rsync` from my build:
  - keeps a valid ad-hoc signature and runs `--version` (3.4.4);
  - has 0 `N_OSO` entries and no `/var/folders` or `/Users/` strings.

  The manifest's `rsync.sha256` is the pin of the source tarball, so the strip changes no pin.
- **7aa2afca.** With `todo()` reverted to a plain push, the tightened `host.test.ts` case fails.
- **2431ce5f.** With `probeOrRollback` reverted to restart archid alone, its test fails. `setup --rollback`'s own
  restart is covered only by the fresh-install run: no unit test runs `rollback()` with systemd, since the suite runs
  on a Mac.
- **The fresh-install checks bite.**
  - The exe and release root checked per unit tell releases apart; that is what caught defect 3. The rolled-back
    `machine.json` in `arm64-vartmp` and `x64-full` shows both units on the first release.
  - The clean-machine and architecture checks, and linger after a restart with no login.
  - ssh from the host reads only the run's own config, key and `known_hosts`. The controller finds `ssh` on `PATH`,
    where the wrapper comes first.
- **release.yml.**
  - `publish` needs all three jobs, and only `publish` gets `contents: write`.
  - The key goes through the `printf` builtin into a 0600 file, never into argv, and is removed in an `always()`
    step. The artifact glob cannot pick it up.
  - The dry run uploads nothing. Logs are uploaded only after the `--secrets-only` scan passes.
  - `gh release create` uses `--verify-tag`, and the asset names match the basenames of the pinned URLs.
  - The integration and fresh-install jobs need only Node builtins; the imports of the scripts, `claude.mjs` included,
    confirm it. So they rightly skip `pnpm install`.
- **Runs here:**
  - actionlint 1.7.12 on `ci.yml` and `release.yml`: 0 errors. shellcheck 0.11.0 on the three scripts: 0 findings.
  - `pnpm typecheck`: clean.
  - vitest on `release-scan`, `linux-setup` and `host`: 95 passed, 1 skipped.
  - `release-build.sh` twice from a `git archive ac94cf15` snapshot: three archives each, scan ok (114, 114 and 117
    files), 50 s.
  - The scanner over the app's development tree flags the unstripped rsync and the manifest's development URLs, as it
    should.
- **Docker.** I started colima's default profile for these runs and stopped it after, and set the context back to
  `desktop-linux`. My containers and images are removed. The worktree is untouched apart from this file.

## Re-review of fix round 1

Fix commits c90f2c85..4634e37d, against `task-37b-fix1-findings.md`. The ledger and environment commits in the range
were skipped. M3 and the long-home socket went to Task 38a and are not reopened here.

**Verdict: Approved.** Every finding sent is addressed. The fix diff breaks nothing at Critical or Important level;
it adds 2 new Minor findings, and 1 more Minor is out of scope.

| Finding | Verdict | Evidence |
| --- | --- | --- |
| I1: every fleet follows an upgrade and a rollback | ADDRESSED | See below. |
| I2: the app's route | ADDRESSED | See below. |
| I3: the scan's misses | ADDRESSED | See below. |
| M1: logs scan and `ci.yml` | ADDRESSED | See below. |
| M2: retention | ADDRESSED | `retention-days: 1` on both of the build job's uploads. |
| Signed-tag guard | ADDRESSED | See below. |

- **I1.** The fix:
  - `restartUnits(run, unitDir)` restarts every unit in `ourUnits(unitDir)` (`linux/setup.ts:20`, `:169-171`):
    each fleet's archid, then the gateway.
  - `setupLinuxRelease`, `probeOrRollback` and `setup --rollback` all call it.
  - `removeUnits` in `uninstall.ts` shares the same rule.

  How I checked it:
  - I made a mutant that skips `@work`. It fails 4 tests, including the new CLI `--rollback` case with a fake
    `systemctl`.
  - I ran the fresh install in a Linux container, from a `git archive 4634e37d` build. The `work` fleet's unit ran
    `v0.0.0-f1` when added, `v0.0.0-f1-next` after the upgrade, and `v0.0.0-f1` after the rollback. The rollback
    restarted private, `work` and the gateway.
- **I2.** A companion pinned on `http://127.0.0.1:<port>/` is served by a child process and installed without
  `--release`. The run checks the release step's exact text and that the cached companion hashes to the pin.
  - Local builds pin both releases on one free loopback port.
  - In CI, `-next` pins `127.0.0.1:8765`.

  I ran CI's shape in a clean Linux container: the tag's release on a GitHub-style URL and `-next` on 8765. `host add`
  went "from the archive you named". The upgrade came "from http://127.0.0.1:8765/upgrade/…" with `served.log`
  `GET … 200`, and the run ended ALL PASS in 19 s. With 8765 taken, it stopped at 1.6 s, before any machine, naming the
  server that exited.
- **I3.** The private-key rule now takes an escaped `\n` or `\r\n`, and there is a new `JWT` rule. `auth.json` is a
  credential file name.
  - Mutants that drop the escaped break or `auth.json` each fail the new tests.
  - All six archives built from the snapshot passed the scan with the new rules, including `node/`, so the rules add
    no false positives.
- **M1.** The file-name rule now runs under `--secrets-only`; a mutant that restores `&& !o.secretsOnly` fails its
  test. `ci.yml`'s upload sits behind the same `id: logs` gate as `release.yml`'s.
- **Signed-tag guard.** I ran the step's `run` block, taken from `release.yml`, under `/bin/bash -e` (bash 3.2) with
  throwaway keys:
  - an unpinned key, a key with a passphrase, and text that is no key each exit 1 with a named `::error::`;
  - no secret gives `signed=false`, and a pinned key gives `signed=true`;
  - no key material is printed, and a failed step leaves the key file to the `always()` removal.

  Publishing is skipped, and the dry-run step runs, for any tag with a `-`.
- **Checks here.**
  - Typecheck is clean.
  - The seven touched test files pass: 134 passed, 1 skipped.
  - The worktree matches the commits: `git status` and `git diff HEAD` are empty, and no product file changed after
    4634e37d. This answers the fixer's concern 4.

### The fixer's concerns

1. **Port 8765 in CI.** The port has to be fixed, because the signed `-next` manifest is built on the macOS runner
   before the Linux runner exists. A fresh runner has nothing on it, and a taken port fails fast with a named cause.
   Accepted.
2. **`restart` rather than `try-restart`.** Keep `restart`.
   - Setup and provision enable every unit with `--now`, so a unit stopped by hand starts again at the next boot
     anyway.
   - `try-restart` leaves a `failed` unit alone. On the automatic rollback that is the worst case: a daemon that hit
     its start limit on a bad release would stay down after going back.
   - The one real gap is a unit the user disabled but whose file is still there (m1 below).
3. **Every tag with a `-` is a dry run.** This follows the ruling, and it keeps "a test tag is a dry run" true once a
   key exists. Accepted. Pre-releases need their own rule later.
4. **The shared worktree.** Confirmed clean, as above.

### New Minor findings

**m1. An upgrade or a rollback starts a fleet daemon the user disabled.**
- **Where:** `linux/setup.ts:169-171`.
- **Evidence:** `ourUnits` takes every unit file in the folder, and `restart` starts a stopped unit. A unit the user
  ran `systemctl --user disable --now` on, but whose file is still there, is started again, against their intent.
  Before the fix, other fleets were never touched.
- **Fix:** optional. Skip a unit that `systemctl --user is-enabled` does not report as `enabled`, or accept this as
  intended.

**m2. The signing-key guard matches the key anywhere on an uncommented line.**
- **Where:** `release.yml:49`.
- **Evidence:** the guard does not check the `archipelago-release` principal or `namespaces="archipelago-release"`.
  A key pinned under another principal passes the guard, and then fails later in the test jobs, as every unpinned
  key did before the guard.
- **Fix:** optional. Match `^archipelago-release ` with that namespace, or run `ssh-keygen -Y sign` and then
  `-Y verify` on a probe file in the guard.

**Out of scope (Minor).** After an upgrade, only the private daemon is probed (`setup.ts:95`). Another fleet's
daemon that fails on the new release rolls nothing back: `restart` returns once its start job runs. Every daemon runs
the same code, and the fresh-install run now checks each unit's release at every stage, so this can go to Task 38a
with the rest of the service behaviour.

**Docker.** I built from a `git archive 4634e37d` snapshot and ran on colima's default profile only. I stopped colima
after and set the context back to `desktop-linux`. My containers and images are removed.
