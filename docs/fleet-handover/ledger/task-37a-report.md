# Task 37a report: the two-machine integration harness and its CI job

Status: **DONE_WITH_CONCERNS**

- **Built.** A fleet is handed between two Ubuntu 24.04 containers with real systemd, sshd, rsync 3.2.7, tmux 3.4 and
  Git 2.43. Remote is provisioned by `archi host add` from the companion archive built from the checkout. The fleet
  goes local → remote → local, and every step is checked.
- **Faults.** The controller is killed and the ssh link dropped at five boundaries, in both directions: 18 fault
  runs. After each, the harness takes the action `archi handover status` offers.
- **Results.** Every run passed, on arm64. No product defect was found. Two mutants of the release show the checks
  bite.
- **The rsync minor is closed.** The rsync-dependent test files fail instead of skipping when `ARCHI_REQUIRE_RSYNC`
  is set, and CI builds the pinned rsync and sets it.
- **Concerns.** x86-64 was not run locally, as user-mode emulation cannot run it. No GitHub run has happened
  (billing).

Commits (BASE 654b017d; 36b's `60fcbf79`/`69c6fb1c` landed in between):

| Commit | Subject |
| --- | --- |
| `a1dd62b4` | The rsync-dependent test files fail instead of skipping when ARCHI_REQUIRE_RSYNC is set and no usable rsync is there |
| `12d65dd3` | The fleet handover integration run hands a fleet between two Linux containers over real sshd, rsync, tmux, Git and systemd, and kills the controller or drops the ssh link at each boundary |
| `b81a0337` | The fleet handover integration run builds for the docker host's own architecture, as under user-mode emulation every process reads as qemu |
| `fd777997` | CI runs the fleet handover integration job on Linux, and its test job builds the pinned rsync and requires it |
| `51088ca6` | The integration run checks that a destination whose controller died at Commit waits for the resume, and that a Begin cut off by a dropped link never froze the source |
| `da059e2a` | The integration docs say how to run the fleet handover run, what it and each CI job check, and what they leave to the real machines |

## What the script and the job do

`scripts/integration/` holds five files:

| File | Role |
| --- | --- |
| `fleet-handover.sh` | The entry point, which every CI job and local run calls. It checks docker and takes the docker host's architecture. It builds the companion (`scripts/build-companion.mjs --arch <arch>`, and `build:mobile` first if `dist-mobile` is missing) unless `--archive` names one. It builds the image, then runs the driver. |
| `Dockerfile` | Ubuntu 24.04 with systemd as PID 1, sshd, rsync, tmux, Git, iptables and a `tailscale` double that answers its version, as `test/isolate.ts`'s does; `host add` requires the tool. It has one account `archi` at `/home/archi`, key logins only, with linger on. No Node. |
| `fleet-handover.mjs` | The host-side driver, run through `docker exec`. It holds the steps and the checks. |
| `machine.mjs` | The in-machine half, run on the release's own node copied to `/opt/it/node`. `snap` prints one machine's state as JSON. `drive` runs `archi handover … --json` and lands the fault. `link` is a root agent on remote that drops and restores port 22 with iptables. |
| `claude.mjs` | The hook-speaking mocked Claude from the on-machine passes (m3bg `bin/claude`), promoted with only its header comment rewritten. `~/.local/bin/claude` execs node on it, so `ps` reads `node …/claude.mjs`. |

No Codex mock was promoted. The only one, `packages/archid/test/fixtures/bin/codex`, writes its rollout under
`$ARCHI_HOME/fake-codex` rather than Codex's home, so a handover could not carry it.

### The run, step by step

1. **Two machines.** A docker network and two privileged containers (`--cgroupns=private`, tmpfs `/run`), waited on
   until `systemctl is-system-running` says `running`.
   - Local gets an ed25519 key made for this run. Remote authorises it, and local's `known_hosts` comes from
     `ssh-keyscan`.
   - The link agent is started on remote.
2. **Install.**
   - Local: `archi setup --release <archive> --allow-unsigned`, run from the unpacked archive.
   - `archi host add remote --ssh archi@archi-remote --release <archive> --allow-unsigned --json`. Every step must be
     `ok`. The only warnings allowed are tmux 3.4 and "codex is not installed". Twelve named steps must be present.
   - `handover.enabled` is set in local's fleet.json, and the unit restarted.
   - `archi host enable remote --fleet private` must end `ready`.
3. **Fixture.**
   - Repo `~/src/app`: a committed `.gitignore`, a stash, a staged change, an unstaged change, an untracked file,
     8 × 2 MiB of ignored `data/`, and a default-excluded `node_modules/`.
   - Linked worktree `~/src/app-wt` on branch `feature`: staged, unstaged and untracked changes of its own.
   - Island `integration`, with two characters: `agent`, a mocked Claude in the worktree with one turn, and `shell`,
     a plain shell in the main checkout.
4. **local → remote**, then a turn on remote through local's `archi`, then **remote → local** and a turn on local.
   Each handover is checked for:
   - **The manifest.** The preflight names exactly the four roots and one session, `agent`'s, with no blockers. Every
     root and session has a `verify` row with `done === total`.
   - **Git on the new owner, against the source before the handover.** For both checkouts: HEAD, branch,
     `status --porcelain=v2 --branch --untracked-files=all`, `ls-files --stage`, the stash list with hashes, the
     worktree list, every ref, and a clean `fsck`. Every file of both working trees is hashed with its mode, ignored
     `data/` included and `node_modules/` left out, and `node_modules` must not exist on remote.
   - **The state.** The same character ids, names, cwds and islands. The shell's window runs bash.
   - **The agent.**
     - It runs as `node /opt/it/claude.mjs --resume <sessionId>` in `~/src/app-wt`, and is the only mocked agent on
       that machine.
     - The state names the same session id, and the pid it records is that process.
     - The transcript files match byte for byte.
     - The turn after the move appends 2 records to the same file.
   - **Ownership.**
     - The new owner's `ownership.get` names it at g+1, not frozen.
     - The old owner's names the new owner at g+1, with only `_keep` in tmux and no mocked agent.
     - The gateway's record (`archi gateway owner get` on remote) names the new owner at g+1 with no transaction.
     - `handover.status` shows no transaction on either daemon, and the controller has no `handover.json`.
     - fleet.json keeps the fleet id and names remote as gateway on both sides.
5. **Faults.** Each is followed by a snapshot of both machines, then `status`, then `--abort` (pre-commit) or
   `--resume` (post-commit). After that, step 4's owner checks run against the machine that should own the fleet, and
   the "holds nothing" checks against the other.

| Boundary | Faults | Trigger (in local, polling `/proc` every 2 ms) | Checked where it stopped |
| --- | --- | --- | --- |
| before Freeze | kill, drop | the ssh carrying `gateway owner 'begin'` appears | nothing committed and the destination idle. Kill: Begin landed (`preparing`). Both: the source never froze, and its agent keeps its pid through the abort |
| during transfer | kill (whole session), drop | the first `rsync … --info=progress2` appears | nothing committed; the source frozen, its agent rested |
| after Ready | kill, drop | the ssh carrying `'ready'` appears | nothing committed; the source frozen. Kill: Ready landed (`ready-to-commit`) |
| right after Commit | kill | the ssh carrying `'commit'` appears | committed at g+1; source down; the destination not activated until the resume |
| during activation | kill, drop | the event `handover.changed activate` | committed at g+1; source down |

- **What a kill takes.** A kill at a gateway operation is a SIGKILL of the controller alone, and the orphaned ssh lands
  the operation. The driver waits for that ssh to exit, so each of these boundaries is exact. During the transfer the
  kill takes the whole process session.
- **How a drop runs.** It stops every packet to and from port 22 on remote, INPUT and OUTPUT. The controller runs
  until it gives up (capped at 300 s, never reached). Then the link is restored.
- **No drop right after Commit.** A drop there races the commit's own packets. The activation drop is the post-commit
  drop.

The **CI job** is `integration` in `.github/workflows/ci.yml`, on `ubuntu-24.04` (x86-64):

- It runs checkout, pnpm, Node 24, `pnpm install --frozen-lockfile`, then `scripts/integration/fleet-handover.sh
  --out $RUNNER_TEMP/fleet-handover`.
- It uploads that folder only on failure.
- The trigger stays `workflow_dispatch`.

The **test job** (macOS) now does four new things:

- caches `vendor/rsync` and `vendor/node`, keyed on `pins.json`;
- runs `build:mobile`, then `node scripts/build-controller.mjs --out $RUNNER_TEMP/controller`, which builds the pinned
  rsync 3.4.4 into `vendor/rsync` on a cache miss;
- runs `pnpm test` with `ARCHI_REQUIRE_RSYNC=1`;
- has a timeout of 30 minutes, up from 20.

Documentation: `docs/integration.md`.

## Runs

All runs were local, arm64, under colima: 2 CPUs and 2 GiB. Colima was stopped when the task began; I started it
and stopped it at the end. `$SP` is
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad/it`.
Each run's folder holds `run.log` and per-handover `.ndjson`, `.summary.json`, `.stopped.json` and
`.recovery.ndjson`.

### The canonical run: every scenario, through the wrapper

**`scripts/integration/fleet-handover.sh --out $SP/full-arm64`** at `fd777997`: companion `fd777997-linux-arm64`,
**ALL PASS**, 20 handovers in 798.7 s (plus about 15 s of build). Output is `$SP/full-arm64.out`.

| # | Scenario | Controller result | Controller ms | Fault at ms | Where it stopped | status offered | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | clean local → remote | complete g1 | 3,258 | | | | |
| 02 | clean remote → local | complete g2 | 2,973 | | | | |
| 03 | kill@begin L→R | killed | 1,041 | 960 | gateway preparing; source not frozen, agent same pid | open, resume/abort | abort: aborted |
| 04 | drop@begin L→R | interrupted begin, 3 retries | 108,187 | 1,005 | gateway preparing; source not frozen | open, resume/abort | abort: aborted |
| 05 | kill@transfer L→R | killed (session) | 1,814 | 1,793 | preparing; source frozen, 0 agents | open, resume/abort | aborted |
| 06 | drop@transfer L→R | interrupted transfer (rsync 255) | 60,688 | 1,511 | preparing; source frozen | open, resume/abort | aborted |
| 07 | kill@ready L→R | killed | 2,519 | 2,436 | ready-to-commit; source frozen | open, resume/abort | aborted |
| 08 | drop@ready L→R | interrupted ready, 3 retries | 99,307 | 2,348 | ready-to-commit; source frozen | open, resume/abort | aborted |
| 09 | kill@commit L→R | killed | 2,646 | 2,544 | committed g3; source frozen; destination 0 agents | committed, resume | resume: complete |
| 10 | kill@begin R→L | killed | 850 | 749 | preparing; source not frozen | open, resume/abort | aborted |
| 11 | drop@begin R→L | interrupted begin, 3 retries | 107,482 | 692 | preparing; source not frozen | open, resume/abort | aborted |
| 12 | kill@transfer R→L | killed (session) | 1,342 | 1,321 | preparing; source frozen | open, resume/abort | aborted |
| 13 | drop@transfer R→L | interrupted transfer | 61,360 | 1,309 | preparing; source frozen | open, resume/abort | aborted |
| 14 | kill@ready R→L | killed | 2,023 | 1,941 | ready-to-commit; source frozen | open, resume/abort | aborted |
| 15 | drop@ready R→L | interrupted ready, 3 retries | 98,472 | 2,016 | ready-to-commit; source frozen | open, resume/abort | aborted |
| 16 | kill@commit R→L | killed | 2,181 | 2,098 | committed g4; destination 0 agents | committed, resume | complete |
| 17 | kill@activate L→R | killed | 2,595 | 2,590 | committed g5; destination 1 agent | committed, resume | complete |
| 18 | kill@activate R→L | killed | 1,964 | 1,959 | committed g6; destination 0 agents | committed, resume | complete |
| 19 | drop@activate L→R | interrupted activate, 3 retries | 99,431 | 2,670 | committed g7; destination 1 agent | committed, resume | complete |
| 20 | drop@activate R→L | interrupted activate ("the gateway could not say who owns this fleet") | 69,116 | 2,073 | committed g8; destination 0 agents | committed, resume | complete |

After each row, every check of step 4 passed against the machine that should own the fleet. The fleet ended on local
at generation 8.

### The other runs

| Run | Command (driver form: `node scripts/integration/fleet-handover.mjs --archive <archive> …`) | Result |
| --- | --- | --- |
| manual bring-up | the steps by hand in two containers, at `654b017d` | host add `actions` (codex only); handovers local → remote (complete g1, ~3 s), remote → local (g2), and kill@begin then `--abort` by hand. Found the `tailscale` requirement, now the image's double. |
| run1 | `--archive …654b017d-linux-arm64.tar.gz --out $SP/run1 --scenarios kill@begin --keep` | ALL PASS, 37 s, after two harness fixes (a shell line break, and waiting for the restarted daemon's port) |
| run2 | same archive, `--scenarios kill --keep` | ALL PASS, 70.6 s: the 10 kill scenarios, both directions |
| run3 | `--scenarios drop@begin,drop@transfer` | stopped by me. The driver's 300 s cap timer kept it alive after the controller exited, a harness bug fixed before `12d65dd3`. Both scenarios had passed their checks. |
| run4 | same archive, `--scenarios drop --keep` | ALL PASS, 739 s: the 8 drop scenarios, both directions |
| mutant no-resume | `--archive <archive whose archid starts claude without --resume> --scenarios none` | **FAILED as it should**: `remote session id: 316ccb3d… vs 0a0a9e4b…` and `resumed: ["/opt/it/node/bin/node","/opt/it/claude.mjs"]` |
| mutant no-revive | `--archive <archive whose source never reopens rested terminals> --scenarios kill@transfer` | **FAILED as it should**: after the abort, `source windows`, `source shell`, `source one agent process` and `source agent pid` |
| x64 probe | `DOCKER_DEFAULT_PLATFORM=linux/amd64`, x64 companion, image built for amd64, `--scenarios none` | **Not runnable.** Under qemu-user every process's argv starts `/usr/bin/qemu-x86_64`. The rest classifier then reads every terminal as busy, and preflight blocks with `shell_busy` for both characters. systemd also boots `degraded`: 7 boot units cannot set up credentials. |
| recheck | `scripts/integration/fleet-handover.sh --scenarios kill@begin,drop@begin,kill@commit --out $SP/recheck` at `51088ca6` | ALL PASS, 264.6 s, with the checks `51088ca6` added |

- **The mutants.** Each was built by copying the staged release and patching one line of `lib/archid.mjs`:
  `reviveCommand` without `--resume`, or `Source.revive` returning at once. The release manifest was rewritten with
  `writeManifest`, then re-tarred. The builder is `$SP/mutate.mjs` (scratch, not committed).
- **Other checks.**
  - `pnpm typecheck`: clean.
  - `actionlint` 1.7.12 (`rhysd/actionlint` image, with its shellcheck) on `.github/workflows/ci.yml`: 0 errors.
  - `shellcheck scripts/integration/fleet-handover.sh`: clean.
  - `node --check` on the three `.mjs` files.
  - `node scripts/build-controller.mjs --out $SP/controller`: builds darwin-arm64 with rsync 3.4.4, the step CI runs.
- **The rsync flag, RED and GREEN.**
  - Before `a1dd62b4`: `ARCHI_REQUIRE_RSYNC=1 ARCHI_TEST_RSYNC=/nonexistent/rsync pnpm test
    packages/cli/test/controller/rsync.test.ts packages/cli/test/controller/transfer.test.ts` gave 2 files passed,
    41 passed and 14 skipped, exit 0.
  - After: the same command gives 2 files failed, each with `Error: no rsync 3 at /nonexistent/rsync …`.
  - `manifest.test.ts` with the flag and a PATH of only Node's bin fails with `Error: no rsync on PATH`.
  - With the flag and vendor/rsync present, all three files: 77 passed and 1 skipped (the live `ARCHI_TEST_SSH`
    test).
  - Without the flag and a missing rsync: 41 passed and 14 skipped, as before.
- **The cli and archid projects**, as CI runs them: `ARCHI_REQUIRE_RSYNC=1 pnpm test --project cli --project archid`
  gave 118 files passed and 1 skipped, 3431 tests passed and 5 skipped, exit 0.

## Defects found and fixed

- **Product:** none. Every handover, abort and resume did what the spec says, on real transports, in both
  directions.
- **Tests:** the Task 23 minor. The rsync-dependent test files skipped silently without an rsync; they now fail when
  `ARCHI_REQUIRE_RSYNC` is set, which CI sets (`a1dd62b4`, with the RED and GREEN above).

The harness bugs found while building it were fixed before its first commit.

## What CI cannot run here, and why

- **No GitHub run yet.** Actions jobs do not start on this repository (billing). The job's first real run is owed.
  What only that run can show:
  - privileged systemd containers with `--cgroupns=private` on the `ubuntu-24.04` image;
  - iptables inside them;
  - the x86-64 companion end to end (see the next item);
  - the test job's first rsync build from samba.org on a cache miss.
  - The action tags `actions/cache@v6` and `actions/upload-artifact@v7` were checked against GitHub's API; the others
    are the ones the workflow already used.
- **x86-64 locally.** Colima's arm64 VM runs amd64 containers only under qemu-user, and there the product sees every
  process as `qemu-x86_64`, so the run cannot pass. A full x86-64 VM needs Homebrew's qemu, which is not installed, and
  I did not install it on the owner's Mac. The CI job on x86-64 is where this runs. linus-vault, which is x86-64, is
  37c's.
- **Mac ↔ Linux.** The controller runs from the Linux companion here. The Mac's bundled rsync, launchd, the app, the
  detached helper (`--detach`/`attach`) and Mac-to-Linux transfers are 37c's to cover on the real machines. Running
  the controller on Linux needed no product change: `resolveRsync` falls back to the system rsync 3.2.7, and
  `host add` and `host enable` work unchanged.
- **Real agents and Tailscale** are not in the containers. The mock speaks the same hooks and transcript layout.

## Concerns and observations

1. **A SIGKILLed controller leaves its ssh master running.** `SshMaster` ends its `ssh -M -N` on the process's exit
   and signal handlers, which a SIGKILL skips. The orphan keeps its connection, kept alive by `ServerAliveInterval`,
   and its socket under `$TMPDIR/archi-<uid>/` until the link drops. Every killed helper leaks one. It is harmless to
   correctness, since each process hashes its own pid into its socket name, but it accumulates. Seen after every
   kill scenario.
2. **Slow to give up after a drop.** A dropped link takes the controller 49–108 s to report `interrupted`: gateway
   operations time out at 30 s, then retries, and the master's keepalive ends at 45 s. During that time the sheet
   shows retries only. The retries after the master died go out as direct ssh connections, since `ssh -S` falls back
   when its socket is gone (already ledgered under Task 23).
3. **Activating into the controller's own machine waits for the gateway.** When the link drops right after Commit and
   the destination is local (row 20), activation waits: the destination confirms the commit with the gateway, which
   it cannot reach. The fleet then runs on neither machine until the link returns. The resume then activates it.
   This is what the spec asks, but the sheet's wording for it may deserve a look in Task 39.
4. **Resume can race an activation already under way.** After a kill during activation, the destination's journal
   moved from `prepare` to `activate` between the stopped snapshot and `status` (row 18). The daemon was still
   serving the dead controller's activate call. The resume that followed completed in all 4 kill-at-activate runs
   (run2, the full run, both directions). It is not proven safe against every interleaving.
5. **The drop boundaries are less exact than the kill ones.** A Begin or Ready request may or may not reach the
   gateway before the drop. The harness checks only what is certain there: nothing committed, and at Begin no freeze.
   In every run both had landed.
6. **The test job is heavier.** It now builds the Mac controller, about a minute cached plus the rsync compile on a
   miss, and its timeout rose to 30 minutes.
7. **What was left behind.** The image `archi-it:latest` stays in colima's VM to speed the next run. The scratch
   images `archi-it:dev`, `archi-it:amd64` and `rhysd/actionlint` were removed, along with every container and the
   network. The amd64 variant of `ubuntu:24.04` pulled for the x64 probe is still in colima's image store: docker
   removes it only with `--force` on the shared tag. The docker context is back on `desktop-linux`, and colima is stopped.
