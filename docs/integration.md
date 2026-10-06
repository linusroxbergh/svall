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
| `--keep` | Leave the containers running afterwards, to look around with `docker exec -it -u svall svall-local bash -l`. |
| `--prefix <name>` | Name the containers `<name>-local` and `<name>-remote` and the network `<name>-it` (default `svall`), so another run can share the Docker host. The handover benchmark uses `svall-bench`. |

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

| | `svall-local` | `svall-remote` |
| --- | --- | --- |
| Plays | the controller's machine | the companion machine and gateway |
| Installed by | `svall setup --release <archive>` | `svall host add remote --release <archive>` from local |
| Runs | svalld and the controller (`svall handover …`) | svalld and the gateway, as systemd user units with linger |

- **One account.** Both machines have `svall` with home `/home/svall`. Local reaches remote with its own key, made
  when the run starts.
- **Node.** Neither machine has Node on PATH. The release brings its own. The harness keeps a copy of the release's
  node at `/opt/it/node`, which the mocked agents and the in-machine checks run on.
- **Tailscale.** The containers have no tailnet, so `tailscale` is a double that answers its version and nothing else.
- **Mocked Claude.** `scripts/integration/claude.mjs` is the hook-speaking Claude the on-machine passes used. It posts
  its hooks to `$SVALL_HOME/hooks.sock`, keeps a Claude Code 2.1.x transcript, and resumes only a session whose
  transcript is under its cwd's slug.
  - `~/.local/bin/claude` execs node on it, so `ps` shows `node …/claude.mjs`, which the rest classifier reads as
    Claude.
  - There is no Codex, so `host add` advises installing it.
- **Mocked OpenCode.** `scripts/integration/opencode.mjs` answers as OpenCode 2.0.22: `--version`, `auth list`, and
  `session export|import|delete --standalone`, where an import of an id it already holds says so on stderr and exits
  0. It keeps each session as a JSON file under `~/.local/share/opencode/mock-sessions`, where the real one keeps its
  database.
  - `~/.local/bin/opencode` execs node on it as `opencode`, and it sets its process title to `opencode <args>`, so `ps`
    reads it as the native binary, launch flags and all.
  - In a terminal, `opencode --standalone [-s <id>]` runs a private `serve --stdio` server in a group of its own and
    posts the hook lines Svall's plugin would. `-s` on an id it does not hold starts an empty session, as the real
    one does.

### What it checks

1. **Provisioning.**
   - `svall setup` starts the daemon unit.
   - Every `host add` step is `ok`. The only warnings allowed are tmux 3.4 and the missing Codex.
   - `handover.enabled` is turned on, and `host enable` makes remote the gateway.
2. **The fixture.** Repo `~/src/app` has:
   - a linked worktree `~/src/app-wt`;
   - staged, unstaged and untracked changes in both;
   - a stash;
   - an ignored `data/` of 16 MiB;
   - a default-excluded `node_modules/`.

   A mocked-Claude character runs in the worktree, a mocked-OpenCode character `oc` in the main checkout, each with
   one turn, and a shell character runs in the main checkout.
3. **local → remote, then remote → local**, each with a turn on the new owner, all through the controller on local.
   Each handover checks:
   - **The manifest:** four roots (the two checkouts, mission control's folder and the agent profiles) and two
     sessions, Claude's and OpenCode's, no blockers, and each root and session verified in full.
   - **Git:** on the new owner, each checkout's HEAD, branch, `status --porcelain=v2`, index (`ls-files --stage`),
     stash, worktree list, refs and `fsck` equal the source's before the handover. Every file of both working
     trees, ignored ones included, has the same content and mode. `node_modules/` never reaches remote.
   - **The state:** the same characters, names, cwds and islands, and the shell character's terminal runs bash.
   - **The agents:** Claude runs as `claude --resume <its session id>` and OpenCode as
     `opencode --standalone -s <its session id>`, each in its cwd, under the same session id and pid the state records. Claude's transcript is identical, and the
     next turn appends to the same file. OpenCode runs one private server, and holds its session with the same
     messages, in the terminal's folder, never as an empty session a resume made up; the next turn adds to it.
   - **Ownership:** the new owner's daemon owns the fleet at the next generation and is not frozen. The old one is
     fenced to the new owner and runs no agent, OpenCode server or window: it has stopped the fleet's tmux server.
     The gateway's record names the new owner with no transaction. No handover journal is left on either machine or
     in the controller.
4. **Faults.** A fault at each boundary, in both directions. After each, `svall handover status` must offer what the
   spec says, and the harness takes that action: `--abort` before the commit, `--resume` after it. Then every check
   of step 3 runs against the owner the fleet should have. Before recovering, the harness also snapshots both
   machines where the fault left them.

| Boundary | Faults | The fault lands when | Commit | Checked where it stopped |
| --- | --- | --- | --- | --- |
| before Freeze | kill, drop | the ssh carrying the gateway's Begin appears | pre | Begin landed (kill); the source never froze, and its agents keep their pids through the abort |
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
- **Post-commit, after the resume:** the destination runs the fleet with each agent resumed under its session id, and
  the source never runs a terminal or an agent again.

### The CI job

`.github/workflows/ci.yml` job `integration` runs `scripts/integration/fleet-handover.sh` on `ubuntu-24.04`, which is
x86-64, so every check above also runs on x86-64 Ubuntu. When it fails, it scans the output folder with
`release-scan.mjs --secrets-only` and uploads it only if the scan passed. The job has not run yet: Actions jobs do
not start on this repository (billing), so its first run on GitHub is owed.

The script runs the machines on the Docker host's own architecture: arm64 on an Apple Silicon Mac, x86-64 on the
runner. It cannot run under user-mode emulation, such as Docker's qemu binfmt on an arm64 host. There every process
reads as `qemu-x86_64`, so the rest classifier finds every terminal busy and preflight blocks. An x86-64 run needs an
x86-64 Docker host, such as a full-system x86-64 VM (see [x86-64 on an Apple Silicon Mac](#x86-64-on-an-apple-silicon-mac)).

### What this run does not cover

- **Mac ↔ Linux.** The controller here runs from the Linux companion build, and GitHub's macOS runners cannot run Linux
  containers. The Mac's bundled rsync 3.4.4 and launchd, and Mac-to-Linux paths, are covered by the supported-host run
  on the real machines (Task 37c).
- **The app's helper.** The harness runs `svall handover` in the foreground with `--json`, not the app's
  `--detach` and `attach`.
- **Real agents.** Real Claude Code, Codex and OpenCode need logins. The mocked Claude speaks the same hooks and
  transcript layout, and the live probes cover the real Claude and Codex CLIs
  (`packages/svalld/test/handover/sessions-live.test.ts`). Nothing runs a real OpenCode's export and import; the mock
  starts its session at launch, where the real one does at the first prompt.
- **Tailscale.** The containers talk over the docker network.
- **Fresh installs.** Installing on a clean machine with no Node, `host upgrade` and `setup --rollback` are the
  fresh-install run's, below. `host upgrade --rollback` runs in neither.

## Fresh installs

`scripts/integration/fresh-install.sh` provisions a clean Ubuntu 24.04 machine as a user does: with the controller
the Mac app carries, from the companion archive that controller's manifest pins. It gives the machine a second fleet,
then upgrades it to a second release and rolls it back.

### Run it

```sh
colima start                                   # if Docker is not already running
scripts/integration/fresh-install.sh --out /tmp/fresh-install
```

| Option | What it does |
| --- | --- |
| `--release <dir>`, `--upgrade <dir>` | Use these two releases, each a folder `scripts/release-build.sh` wrote, instead of building both from the checkout. Only macOS builds them, so elsewhere both are needed. A release built with `--url-base http://127.0.0.1:<port>/<path>` is served from its folder and downloaded; any other is installed by path. |
| `--out <dir>` | Where the logs go (default a new folder under the system temp folder). |
| `--keep` | Leave the machine running, and the controller's home and ssh files in place. |

Without `--release`, the script builds the checkout twice with `scripts/release-build.sh`: as its `git describe`
name and as that name with `-next`, each pinning its companions on a free loopback port, so both are downloaded. The
machine runs on the Docker host's own architecture, as the handover run's do. It exits 0 when every check passed, and
prints `PASS` or its `FAIL` lines per step, like the handover run. The output folder holds `run.log`, the NDJSON of
`host add`, `host enable` and `host upgrade`, the JSON of the rollback and of each `host doctor`, a `.machine.json` per
stage with what the checks read on the machine, `served.log` with each download, and `machine.log` with the units'
logs.

### What it checks

1. **The controller the app carries.** Each release folder holds the controller tree, packed as
   `svall-controller-<version>-darwin-<arch>.tar.gz`, and the companion archives. The run unpacks the tree and
   checks that its manifest pins this architecture's companion archive by name and digest.
   - On a Mac the tree runs through its own shim and Node.
   - A Linux runner cannot run the Mac's Node, so there the tree's `lib/svall.mjs` runs on the runner's Node 24,
     with `SVALL_RELEASE_ROOT` at the tree: the same code, manifest and signers.
2. **A clean machine.** It is the `machine` stage of `scripts/integration/Dockerfile`: systemd, sshd, tmux 3.4, Git,
   rsync and the `tailscale` double, and no Node.
   - The run makes one account whose home is the controller's home, a folder of its own under `/var/tmp` on both. It
     is short enough for the gateway's socket path, which holds at most 108 bytes, and outside `/tmp`, which the
     machine empties when it starts again.
   - The account logs in with a key made for the run, and lingering is off.
   - No `node` exists anywhere on the machine, and the home holds only Ubuntu's skeleton.
   - ssh from the host reads only the run's own files. A wrapper first on the controller's PATH runs ssh with `-F` on
     a config that names the run's key and known_hosts, and no agent.
3. **`svall host add`** from the first release.
   - A release whose manifest pins its companion on this host's loopback takes the app's route: no `--release`, so
     the controller looks the companion up in its manifest, downloads it from the run's server, checks its digest and
     caches it. The release step names that URL, and the cached file is the pinned companion.
   - Any other release is installed by path, with `--release` and `--allow-unsigned` only for an unsigned build.
   - Every step is `ok`, except the advice a fresh machine gets: tmux 3.4, Claude Code, Codex and OpenCode not
     installed, and lingering off, which both the linger and the service steps name.
   - The result lists exactly four things to do: the lingering command and the three installs.
4. **Lingering, as host add asks, and a second fleet.** The run turns lingering on, then runs `svall host enable
   --fleet work` from a controller-side fleet `work`: the machine provisions its own copy under
   `svall-svalld@work.service`.
5. **A restart with no login.**
   - All three units, the private and `work` fleets' svalld and the gateway, are active and enabled.
   - Each runs the release's own Node (`/proc/<pid>/exe`), with `SVALL_RELEASE_ROOT` at `releases/<version>`.
   - `current` and `~/.local/bin/svall` lead to that release.
   - There is no `node` outside the releases and no `pnpm-workspace.yaml` anywhere.
   - `svall host doctor` fails nothing, and its systemd, gateway, linger, svalld, release and home checks are `ok`.
6. **`svall host upgrade`** from the second release's controller, by the same route rule as step 3: every step is
   `ok`, there is no rollback, and step 5's checks pass against the second release, with both releases kept.
7. **`svall setup --rollback`**, run over ssh on the machine: `current` goes back to the first release, all three
   units restart, setup itself finds each fleet's daemon answering from that release, and step 5's checks pass
   against the first release. `host doctor` from the first release's controller agrees.

### x86-64 on an Apple Silicon Mac

Neither run works under Docker's user-mode emulation (see above). A full-system x86-64 VM runs both, slowly:

```sh
brew install qemu lima-additional-guestagents
colima start -p x64 --arch x86_64 --vm-type qemu --cpus 8 --memory 8
DOCKER_CONTEXT=colima-x64 scripts/integration/fresh-install.sh --out /tmp/fresh-install-x64
DOCKER_CONTEXT=colima-x64 scripts/integration/fleet-handover.sh --scenarios kill --out /tmp/fleet-handover-x64
colima delete -p x64
```

## Release builds and the archive scan

`scripts/release-build.sh --out <dir> --version <id> --url-base <url>` builds what a release publishes, on macOS
only, as the controller build is:

- the phone bundle, then both companion archives;
- the controller tree, whose manifest names each companion at `<url>/<archive>` with its digest, packed as
  `svall-controller-<id>-darwin-<arch>.tar.gz`.

With `SVALL_RELEASE_KEY` set, every manifest is signed; without it, every manifest is marked unsigned. The script
ends by scanning the three archives, and a hit fails it.

`scripts/release-build.sh --sign <key> --out <dir>` signs, in place, the archives a build without the key left in
`<dir>`. It takes no `--version` or `--url-base`. It signs the companions first, as the controller's manifest pins
their archives' digests. Each archive is checked as an installer checks an unsigned one, loses its unsigned mark, and
is signed and packed again.

`scripts/release-scan.mjs [--secrets-only] <archive or folder>...` exits 1 on any of:

- **Secrets:** private keys, including one inlined in a bundle with escaped line breaks; Anthropic, OpenAI, GitHub,
  AWS, Slack, Google, npm and Tailscale keys; and JWTs, such as Codex's login tokens. Files named like credentials
  count too, such as `.credentials.json`, Codex's `auth.json`, `id_ed25519`, `*.pem`, `.npmrc` and `.env`. The report
  names the rule, never the secret.
- **Developer paths:** any `/Users/` path, and the builder's home, checkout and temp folder. A folder of one
  component, such as `/tmp`, names nobody and is not looked for. In `node/`, the upstream runtime whose digest the
  build checked, only the builder's own paths count, as Node's own builds carry their build machine's `/Users/admin`.
- **Checkout dependencies:**
  - a module the bundles or hooks import or require that is not a Node builtin and not inside the release, including
    one a dependency only tries for, as Node would look for it in every folder above the release;
  - a link out of the release;
  - a `node_modules` or `.git` folder.

`--secrets-only` is for logs, which name their machine's paths by design: it keeps the secrets rules, file names
included, and drops the rest.

## The release workflow

`.github/workflows/release.yml` runs on a tag `v[0-9]*`:

| Job | Runner | What it does |
| --- | --- | --- |
| `key` | `ubuntu-24.04` | Checks the key before anything is built: an OpenSSH key without a passphrase whose public half is in `scripts/release/allowed_signers`. Says whether the tag is signed. |
| `build` | `macos-latest` | Needs `key`, and never holds the key. Runs `release-build.sh` twice: for the tag, and as `<tag>-next`, the release the fresh installs upgrade to, which is never published and pins its companions at `http://127.0.0.1:8765/upgrade`. Restores no cache on a signed tag, so a signed release builds its own rsync. Passes both to the other jobs as workflow artifacts, kept for one day. |
| `sign` | `macos-latest` | Runs only with the key. Signs both builds' archives with `release-build.sh --sign` and puts them back in place of the unsigned ones. |
| `integration` | `ubuntu-24.04` (x64), `ubuntu-24.04-arm` (arm64) | Needs `build`, and `sign` unless a run without the key skips it. Runs `fleet-handover.sh` with the release's own companion for that architecture. |
| `fresh-install` | the same two | Needs `build`, and `sign` unless a run without the key skips it. Runs `fresh-install.sh` with both releases. `host add` installs the tag's companion by path, as its GitHub URL does not resolve before publish; `host upgrade` downloads the `-next` companion from the run's loopback server, as the app does. |
| `publish` | `ubuntu-24.04` | Needs `key` and the two test jobs. With the key, it lists every archive in `SHA256SUMS`, signs that with `ssh-keygen -Y sign`, checks the signature against the committed `scripts/release/allowed_signers`, and creates the GitHub release with the archives, `SHA256SUMS` and its signature. Without the key, or for a tag with a `-`, it notes that the dry run passed, and uploads nothing. |

- **Signing.** The `SVALL_RELEASE_KEY` secret holds the private key. Only one step in each of the `key`, `sign` and
  `publish` jobs names it, never one in `build`, so nothing `pnpm install` or the bundlers run can read it. Each such
  step writes it to a 0600 file and deletes it when the step ends. The `sign` job signs the manifests inside the
  archives before any other job takes them, so the archives the jobs test are the ones published. Every action runs
  at a pinned commit.
- **The signers.** Before the first signed tag, `scripts/release/allowed_signers` needs the key's public half, as
  its header says. The `key` job checks that first and fails at once, naming the file, when the key is not there or
  is not an OpenSSH key without a passphrase.
- **Dry run.** A tag in a repository without the secret builds, hands over and fresh-installs everything, and
  uploads nothing. A tag with a `-`, such as `v1.0.0-test1`, does the same, signed when the secret is there.
- **Logs.** A failed job's logs are scanned with `--secrets-only` before they are uploaded, and a hit keeps them back.

### What only a real runner can prove

Actions jobs do not start on this repository (billing), so these steps have run only as the local scripts they call:

- the upload: `gh release create` with the job's token, and a signed tag end to end;
- the native x86-64 and arm64 Linux runners;
- workflow artifacts passing from the macOS jobs to the Linux jobs;
- the `sign` job's upload over the build's artifacts, and the test jobs running when a run without the key skips it;
- the fresh-install job's server on the runner's `127.0.0.1:8765`, which needs nothing else listening there;
- the Mac controller's `svall.mjs` on a Linux runner's Node, which has run only on a Mac's Node;
- the build on a macOS runner, with the runner's `strip` and an rsync build on a cache miss.

## Tests that need rsync

`packages/cli/test/controller/rsync.test.ts` and `transfer.test.ts` drive the pinned rsync under `vendor/rsync`, or
`SVALL_TEST_RSYNC`. `packages/svalld/test/handover/manifest.test.ts` drives the `rsync` on PATH. Without an rsync
they skip what needs it. The CI test job builds the pinned rsync with `scripts/build-controller.mjs`, caches it, and
sets `SVALL_REQUIRE_RSYNC=1`, so a missing rsync fails those files instead.
