# Integration runs

The unit and fault suites (`pnpm test`, `pnpm test:faults`) drive the handover against fakes and one shared disk. The
integration run below drives it on real machines: two Linux containers with real sshd, rsync, tmux, Git and systemd.

## Fleet handover between two machines

`scripts/integration/fleet-handover.sh` hands a fleet between two Ubuntu 24.04 containers and checks every step.

### Run it

It needs Docker and the checkout's own `pnpm install`. On a Mac, colima or Docker Desktop both work:

```sh
colima start                                   # if Docker is not already running
scripts/integration/fleet-handover.sh --out /tmp/fleet-handover
```

Options:

| Option | What it does |
| --- | --- |
| `--archive <file>` | Use this companion archive instead of building one from the checkout. |
| `--out <dir>` | Where the logs go (default a new folder under the system temp folder, named when the run starts). |
| `--scenarios <spec>` | `all` (default), `none` (the clean round trip only), `kill`, `drop`, or a list such as `kill@begin,drop@transfer`. |
| `--keep` | Leave the containers running afterwards, to look around with `docker exec -it -u archi archi-local bash -l`. |

The script builds the companion archive for the Docker host's architecture (`scripts/build-companion.mjs`), and
`apps/desktop/web/dist-mobile` first if it is missing. It builds the image from `scripts/integration/Dockerfile`, then
runs `scripts/integration/fleet-handover.mjs`. A full run takes about 15 minutes on an M-series Mac. The kill
scenarios take seconds each. Each drop scenario waits out the controller's ssh timeouts, one to two minutes.

It exits 0 when every check passed. Each step prints `PASS`, or one `FAIL` line per failed check, and the run stops at
the first failed step. The output folder holds:

- `run.log`: every docker command and its output;
- one `.ndjson` per handover: the controller's event stream, and a `.stderr` beside it when the controller wrote any;
- a `.summary.json` per handover: the fault, when it landed, and the result;
- a `.stopped.json` per fault: both machines' snapshots right after it;
- a `.recovery.ndjson` per fault: the `status` and the action taken;
- the tail of each machine's daemon and gateway logs.

### The machines

| | `archi-local` | `archi-remote` |
| --- | --- | --- |
| Plays | the controller's machine | the companion machine and gateway |
| Installed by | `archi setup --release <archive>` | `archi host add remote --release <archive>` from local |
| Runs | archid and the controller (`archi handover …`) | archid and the gateway, as systemd user units with linger |

- **One account.** Both machines have `archi` with home `/home/archi`. Local reaches remote with its own key, made
  when the run starts.
- **Node.** Neither machine has Node on PATH. The release brings its own. The harness keeps a copy of the release's
  node at `/opt/it/node`, which the mocked agent and the in-machine checks run on.
- **Tailscale.** The containers have no tailnet, so `tailscale` is a double that answers its version and nothing else.
- **Mocked Claude.** `scripts/integration/claude.mjs` is the hook-speaking Claude the on-machine passes used. It posts
  its hooks to `$ARCHI_HOME/hooks.sock`, keeps a Claude Code 2.1.x transcript, and resumes only a session whose
  transcript is under its cwd's slug.
  - `~/.local/bin/claude` execs node on it, so `ps` shows `node …/claude.mjs`, which the rest classifier reads as
    Claude.
  - There is no Codex, so `host add` advises installing it.

### What it checks

1. **Provisioning.**
   - `archi setup` starts the daemon unit.
   - Every `host add` step is `ok`. The only warnings allowed are tmux 3.4 and the missing Codex.
   - `handover.enabled` is turned on, and `host enable` makes remote the gateway.
2. **The fixture.** Repo `~/src/app` has:
   - a linked worktree `~/src/app-wt`;
   - staged, unstaged and untracked changes in both;
   - a stash;
   - an ignored `data/` of 16 MiB;
   - a default-excluded `node_modules/`.

   A mocked-Claude character runs in the worktree with one turn, and a shell character runs in the main checkout.
3. **local → remote, then remote → local**, each with a turn on the new owner, all through the controller on local.
   Each handover checks:
   - **The manifest:** four roots (the two checkouts, mission control's folder and the agent profiles) and one
     session, no blockers, and each root and session verified in full.
   - **Git:** on the new owner, each checkout's HEAD, branch, `status --porcelain=v2`, index (`ls-files --stage`),
     stash, worktree list, refs and `fsck` equal the source's before the handover. Every file of both working
     trees, ignored ones included, has the same content and mode. `node_modules/` never reaches remote.
   - **The state:** the same characters, names, cwds and islands, and the shell character's terminal runs bash.
   - **The agent:** it runs as `claude --resume <its session id>` in its cwd, under the same session id and pid the
     state records. The transcript is identical, and the next turn appends to the same file.
   - **Ownership:** the new owner's daemon owns the fleet at the next generation and is not frozen. The old one is
     fenced to the new owner, with no windows but `_keep` and no agent. The gateway's record names the new owner with
     no transaction. No handover journal is left on either machine or in the controller.
4. **Faults.** A fault at each boundary, in both directions. After each, `archi handover status` must offer what the
   spec says, and the harness takes that action: `--abort` before the commit, `--resume` after it. Then every check
   of step 3 runs against the owner the fleet should have. Before recovering, the harness also snapshots both
   machines where the fault left them.

| Boundary | Faults | The fault lands when | Commit | Checked where it stopped |
| --- | --- | --- | --- | --- |
| before Freeze | kill, drop | the ssh carrying the gateway's Begin appears | pre | Begin landed (kill); the source never froze, and its agent keeps its pid through the abort |
| during transfer | kill, drop | the first rsync that copies appears | pre | the source is frozen and its agents rested |
| after Ready | kill, drop | the ssh carrying Ready appears | pre | Ready landed (kill); the source is frozen |
| right after Commit | kill | the ssh carrying Commit appears | post | the gateway committed; neither machine runs the fleet |
| during activation | kill, drop | the controller reports `activate` | post | the gateway committed; the source runs nothing |

Every pre-commit stop is also checked for a gateway that has not committed and a destination that runs nothing.

- **Controller kill.** A SIGKILL of the controller alone. The ssh already carrying a gateway operation lands it, as it
  does when a helper dies mid-call, so the boundary is exact. During the transfer the kill takes the controller's whole
  session, rsync and ssh with it, as a crash would.
- **Link drop.** A root agent on remote (`machine.mjs link`) drops every packet to and from port 22 with iptables. The
  controller runs on until it gives up with an `interrupted` result. The harness then restores the link.
- **No drop right after Commit.** A drop there races the commit's own packets, so where it lands is not
  deterministic. The drop during activation is the post-commit drop.
- **The triggers.** They run inside local, beside the controller: `machine.mjs drive` polls `/proc` for the
  controller's session every 2 ms and reads its event stream.
- **Pre-commit, after the abort:** the source runs the fleet as before, the destination runs nothing, and the
  gateway has no transaction.
- **Post-commit, after the resume:** the destination runs the fleet with the agent resumed under its session id, and
  the source never runs a terminal or an agent again.

### The CI job

`.github/workflows/ci.yml` job `integration` runs `scripts/integration/fleet-handover.sh` on `ubuntu-24.04`, which is
x86-64, so every check above also runs on x86-64 Ubuntu. It uploads the output folder when it fails. The job has not
run yet: Actions jobs do not start on this repository (billing), so its first run on GitHub is owed.

The script runs the machines on the Docker host's own architecture: arm64 on an Apple Silicon Mac, x86-64 on the
runner. It cannot run under user-mode emulation, such as Docker's qemu binfmt on an arm64 host. There every process
reads as `qemu-x86_64`, so the rest classifier finds every terminal busy and preflight blocks. An x86-64 run needs an
x86-64 Docker host.

### What this run does not cover

- **Mac ↔ Linux.** The controller here runs from the Linux companion build, and GitHub's macOS runners cannot run Linux
  containers. The Mac's bundled rsync 3.4.4 and launchd, and Mac-to-Linux paths, are covered by the supported-host run
  on the real machines (Task 37c).
- **The app's helper.** The harness runs `archi handover` in the foreground with `--json`, not the app's
  `--detach` and `attach`.
- **Real agents.** Real Claude Code and Codex need logins. The mocked Claude speaks the same hooks and transcript
  layout, and the live probes cover the real CLIs (`packages/archid/test/handover/sessions-live.test.ts`).
- **Tailscale.** The containers talk over the docker network.
- **Fresh installs.** Installing on clean x86-64 and arm64 machines with no Node, `host upgrade` and
  `setup --rollback` are Task 37b's.

## Tests that need rsync

`packages/cli/test/controller/rsync.test.ts` and `transfer.test.ts` drive the pinned rsync under `vendor/rsync`, or
`ARCHI_TEST_RSYNC`. `packages/archid/test/handover/manifest.test.ts` drives the `rsync` on PATH. Without an rsync
they skip what needs it. The CI test job builds the pinned rsync with `scripts/build-controller.mjs`, caches it, and
sets `ARCHI_REQUIRE_RSYNC=1`, so a missing rsync fails those files instead.
