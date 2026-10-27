# Integration runs

The unit suites (`pnpm test`) drive robot moves against fakes on one disk, and
`packages/svalld/test/placement/faults.test.ts` crashes either daemon on both edges of every step of a move, of the
worker's outbox and of the home's apply of it. The runs below drive Svall on real machines: Linux containers with real
sshd, tmux, Git and systemd.

## Robot placement between two machines

`pnpm integration:placement` (`scripts/integration/robot-placement.mjs`) moves robots between two Ubuntu 24.04
containers, a home and the worker `svall host add` makes of the other, and checks every step on both.

### Run it

It needs Docker and the checkout's own `pnpm install`. On a Mac, colima or Docker Desktop both work:

```sh
colima start                                   # if Docker is not already running
pnpm integration:placement --out /tmp/robot-placement
```

| Option | What it does |
| --- | --- |
| `--archive <file>` | Use this companion archive instead of building one from the checkout. |
| `--image <tag>` | Use this machine image instead of building one from `scripts/integration/Dockerfile`. |
| `--out <dir>` | Where the logs go (default a new folder under the system temp folder, named when the run starts). |
| `--steps <spec>` | `all` (default) or a list of step numbers such as `1,5`. The fixture always runs, and a step also runs the steps whose robots it works with. |
| `--scenarios <spec>` | The faults of step 5: `all` (default), `none`, `kill`, `drop`, or a list such as `kill@rest,drop@commit`. |
| `--keep` | Leave the containers running afterwards, to look around with `docker exec -it -u svall svall-local bash -l`. |
| `--prefix <name>` | Name the containers `<name>-local` and `<name>-remote` and the network `<name>-it` (default `svall`), so another run can share the Docker host. |

The script builds the companion archive for the Docker host's architecture (`scripts/build-companion.mjs`), and
`apps/desktop/web/dist-mobile` first if it is missing. It exits 0 when every check passed. Each step prints `PASS`, or
one `FAIL` line per failed check, and the run stops at the first failed step. The output folder holds `run.log`, every
docker command and its output; a `.summary.json` per move step 5 drives, with the fault, the phase it landed at and the
result; `home-down.watch.ndjson`, the robot as the home's API showed it while it came back in step 4; and the tail of
each machine's daemon and unit logs.

### The machines

| | `svall-local` | `svall-remote` |
| --- | --- | --- |
| Plays | the home, as a Mac | the worker |
| Installed by | `svall setup --release <archive> --allow-unsigned` | `svall host add remote --ssh svall@svall-remote --release <archive> --allow-unsigned` from local |
| Runs | the fleet's svalld as a systemd user unit, and every `svall` the run types | `svalld --worker` as a systemd user unit with linger, and the bare repository both machines fetch from |

- **Two homes.** The account is `svall` on both, at `/Users/svall` on local, as on a Mac, and `/home/svall` on remote,
  so each move relocates every path from one home to the other. Local reaches remote with its own key, made when the
  run starts.
- **Node.** Neither machine has Node on PATH. The release brings its own. The harness keeps a copy of the release's
  node at `/opt/it/node`, which the mocked agents and the in-machine checks (`scripts/integration/machine.mjs`) run on.
- **Tailscale.** The containers have no tailnet, so `tailscale` is a double that answers its version and nothing else.
- **Mocked Claude.** `scripts/integration/claude.mjs` is a hook-speaking Claude. It posts its hooks to
  `$SVALL_HOME/hooks.sock` and keeps a Claude Code 2.1.x transcript. As Claude Code does after its folder moved, it
  resumes a session from the transcript under its cwd's slug, or else the newest of that id in another project folder.
  `~/.local/bin/claude` execs node on it, so `ps` shows `node …/claude.mjs`, which the rest classifier reads as
  Claude. There is no Codex or `gh`, so `host add` advises installing them.
- **The fixture.** Repo `~/src/app` on local, whose remote is a bare repository on remote, with a stash, a linked
  worktree `~/src/app-wt` holding staged, unstaged, untracked and `.env` changes, main with changes of its own and an
  ignored `node_modules/`, and a worktree `~/src/app-faults` with a commit not on the remote. Three Claude robots run
  in them: `agent` in `app-wt`, `kanban` on main and `faults` in `app-faults`.

### What it checks

1. **Move the dirty robot.** `agent` moves to remote. The sheet says `.env stays here` and that remote clones the
   repository. On remote the worktree has the branch, commits, index, status and files the Mac's had, without `.env`,
   and the agent resumes its session there; the Mac's worktree is kept as it was and locked `moved to remote <move
   id>`, and the stash stays on the Mac. A turn on remote reaches the home's state and transcript.
2. **Move the robot on main.** `kanban` moves, and the move converts main into a worktree on a new branch `kanban`,
   staged and unstaged apart, leaving main clean with its stash; `node_modules` is named and never travels.
3. **Worker restart.** A restart of the worker's unit keeps each agent's process. One that stops tmux too, as a
   reboot does, leaves the robots dormant with their resume commands, and a revive from the home starts them there.
4. **Home down during work.** With the home's unit stopped, two turns typed on remote wait in its outbox. Once the
   home starts, it takes each once and in order, from its first answer on.
5. **The fault matrix**, below.
6. **Return through a dirty Mac worktree.** A return refuses an edit made on the Mac since the move, with its exact
   sentence. Once it is undone, `agent` comes back with the worker's commit and changes, `.env` still on the Mac, the
   Mac's worktree unlocked, the worker's locked, and the session as the worker left it.
7. **A reviewer started while the Mac sleeps.** With the home stopped, `svall` on remote, as `kanban`'s agent would
   run it there, starts a reviewer and four more robots and refuses a sixth, and the worker journals each; the home
   applies them in order once it is back, each in a cell of its own.
8. **The scribe over a robot on the worker.** A sweep from the home notes `kanban`, read on remote.
9. **A docs conflict.** `kanban`'s notes changed on both machines while apart keep the Mac's text, with remote's as a
   conflict copy named in the robot's note.
10. **Files over the link.** The home reads `kanban`'s branch, changed files and a file on remote, and a write is
    refused read-only.
11. **A delete while the worker is down.** With remote stopped, `kanban` keeps the last screen remote sent, and the
    home closes the reviewer at once. Once remote is back the reviewer's window is gone, neither state holds it, and
    its worktree is locked `closed robot <id>`.
12. **The agent setup mirror.** The home's Claude has two MCP servers with keys and one that reads a variable. One
    key is ticked for remote and the variable set there with `svall worker env`; a robot moves there; the key is
    unticked while it runs. No file on remote ever holds a key not ticked.

Steps 1, 2, 5 and 6 also check that the bare repository on remote is untouched: a move never pushes.

### The fault matrix

Step 5 moves `faults` out to remote and back with a fault at each phase of a move, in both directions: 6 phases, 2
faults and 2 directions, 24 moves. Before each, `faults` is moved to the side the move starts from.

| Phase | Commit | A fault there ends the move |
| --- | --- | --- |
| `rest` | pre | aborted: the robot runs where it was |
| `bundle` | pre | aborted |
| `prepare` | pre | aborted, but a drop on the way back, where the prepare is this Mac's own, ends done |
| `commit` | post | done: the robot runs on the destination |
| `activate` | post | done |
| `release` | post | done |

- **Home kill.** The trigger stops the home's daemon at the first write of the move's journal at that phase, then
  SIGKILLs it; systemd starts it again, and the move goes on from its journal.
- **Link drop.** A root agent on remote (`machine.mjs link`) drops every packet to and from port 22 with iptables, and
  the harness restores the link once the move's `svall` gives up or ends.
- **The trigger.** `machine.mjs drive` runs `svall robot move` on local and watches `journal/moves` there, stopping the
  daemon at each journal write until it has read the phase, so the fault lands at that phase.
- **Afterwards**, once the move has ended, by itself or after `--retry` or a restart: both journals end `done` or
  `aborted` as above; the robot runs on one machine alone, with one agent on its session and one window, and both
  machines' records agree. An aborted move leaves the source's worktree unlocked and as it was, and no worktree of
  the move on the destination.

### The CI job

`.github/workflows/ci.yml` job `placement` runs `pnpm integration:placement` on `ubuntu-24.04`, which is x86-64. When
it fails, it scans the output folder with `release-scan.mjs --secrets-only` and uploads it only if the scan passed.
Actions jobs do not start on this repository (billing), so the job has not run on GitHub.

The run uses the Docker host's own architecture: arm64 on an Apple Silicon Mac, x86-64 on the runner. It cannot run
under user-mode emulation, such as Docker's qemu binfmt on an arm64 host. There every process reads as
`qemu-x86_64`, so the rest classifier finds every terminal busy and every move refuses. An x86-64 run needs an x86-64
Docker host, such as a full-system x86-64 VM (see [x86-64 on an Apple Silicon Mac](#x86-64-on-an-apple-silicon-mac)).

### What this run does not cover

- **Mac ↔ Linux.** The home here runs the Linux companion build, and GitHub's macOS runners cannot run Linux
  containers. The Mac's launchd, the app and Mac-to-Linux paths are covered by a manual run on real machines.
- **Real agents.** Real Claude Code, Codex and OpenCode need logins. The mocked Claude speaks the same hooks and
  transcript layout; `pnpm compat` checks each new release's session layout and flags.
- **Other agents' moves.** The run moves Claude robots only: the mocked OpenCode (`scripts/integration/opencode.mjs`)
  answers just the version and login probes, and `packages/svalld/test/placement/move.test.ts` moves an OpenCode
  session against fakes.
- **Tailscale.** The containers talk over the docker network.
- **Fresh installs.** Installing on a clean machine with no Node, `host upgrade` and `setup --rollback` are the
  fresh-install run's, below. `host upgrade --rollback` runs in neither.

## Fresh installs

`scripts/integration/fresh-install.sh` provisions a clean Ubuntu 24.04 machine as a user does: with the controller
the Mac app carries, from the companion archive that controller's manifest pins. `host add` makes the machine a worker
of the controller's fleet, then the run upgrades it to a second release and rolls it back.

### Run it

```sh
colima start                                   # if Docker is not already running
scripts/integration/fresh-install.sh --out /tmp/fresh-install
```

| Option | What it does |
| --- | --- |
| `--release <dir>`, `--upgrade <dir>` | Use these two releases, each a folder `scripts/release-build.sh` wrote, instead of building both from the checkout. Only macOS builds them, so elsewhere both are needed. A release built with `--url-base http://127.0.0.1:<port>/<path>` is served from its folder and downloaded, one built with `--url-base companions` carries its companions as Svall.app does, and any other is installed by path. |
| `--out <dir>` | Where the logs go (default a new folder under the system temp folder). |
| `--keep` | Leave the machine running, and the controller's home and ssh files in place. |

Without `--release`, the script builds the checkout twice with `scripts/release-build.sh`: as its `git describe`
name, carrying its companions as Svall.app does, and as that name with `-next`, pinning its companions on a free
loopback port, so `host add` takes the app's route and `host upgrade` downloads. The machine runs on the Docker host's
own architecture, as the placement run's do. It exits 0 when every check passed, and prints `PASS` or its `FAIL` lines
per step, like the placement run. The output folder holds `run.log`, the NDJSON of `host add` and `host upgrade`, the
JSON of the rollback and of each `host doctor`, a `.machine.json` per stage with what the checks read on the machine,
`served.log` with each download, and `machine.log` with the units' logs.

### What it checks

1. **The controller the app carries.** Each release folder holds the controller tree, packed as
   `svall-controller-<version>-darwin-<arch>.tar.gz`, and the companion archives. The run unpacks the tree and
   checks that its manifest pins this architecture's companion archive by name and digest.
   - On a Mac the tree runs through its own shim and Node.
   - A Linux runner cannot run the Mac's Node, so there the tree's `lib/svall.mjs` runs on the runner's Node 24,
     with `SVALL_RELEASE_ROOT` at the tree: the same code, manifest and signers.
2. **A clean machine.** It is the `machine` stage of `scripts/integration/Dockerfile`: systemd, polkit, sshd, tmux
   3.4, Git and the `tailscale` double, and no Node.
   - The run makes one account whose home is the controller's home, a folder of its own under `/var/tmp` on both. It
     is short enough for the fleet's socket paths, which hold at most 107 bytes, and outside `/tmp`, which the
     machine empties when it starts again.
   - The account logs in with a key made for the run, and lingering is off.
   - No `node` exists anywhere on the machine, and the home holds only Ubuntu's skeleton.
   - ssh from the host reads only the run's own files. A wrapper first on the controller's PATH runs ssh with `-F` on
     a config that names the run's key and known_hosts, and no agent.
3. **`svall host add`** from the first release.
   - A release whose manifest pins its companion on this host's loopback takes no `--release`: the controller looks
     the companion up in its manifest, downloads it from the run's server, checks its digest and caches it. The
     release step names that URL, and the cached file is the pinned companion.
   - A release that carries its companions, as Svall.app does, takes the same route from its own tree: the release step
     names the companion's `file:` URL inside it.
   - Any other release is installed by path, with `--release` and `--allow-unsigned` only for an unsigned build.
   - Whichever route, the release step says whether the release is signed, as its manifest does.
   - Every step is `ok` but the advice a fresh machine gets: Claude Code, Codex, OpenCode and `gh` not installed,
     `versions` skipped with no agent to compare, and `mirror:unchecked`, as no daemon runs on the controller. The
     linger step turns lingering on, and the tmux step finds the release's own.
   - The enrol step makes the machine a worker of the controller's private fleet, whose `fleet.json` the run writes
     first, as Svall's first start does.
   - The JSON result's `actions` are exactly the three installs, the things the text line `fresh has 3 things to fix`
     counts, and its `setup` the one `mirror:unchecked` row; `gh` is advice and counts for none.
4. **A restart with no login.**
   - The private fleet's svalld unit, which runs the worker, is active and enabled.
   - It runs the release's own Node (`/proc/<pid>/exe`), with `SVALL_RELEASE_ROOT` at `releases/<version>`.
   - `current` and `~/.local/bin/svall` lead to that release.
   - There is no `node` outside the releases and no `pnpm-workspace.yaml` anywhere.
   - `svall host doctor` fails nothing, and its systemd, worker, linger, svalld, release and home checks are `ok`.
     The release check names the release the machine runs and whether the machine reports it signed, as the
     manifest does.
5. **`svall host upgrade`** from the second release's controller, by the same route rule as step 3: every step is
   `ok` but enrol, which finds the machine this fleet's worker already, there is no rollback, and step 4's checks pass
   against the second release, with both releases kept.
6. **`svall setup --rollback`**, run over ssh on the machine: `current` goes back to the first release, the unit
   restarts, setup itself finds the fleet's daemon answering from that release, and step 4's checks pass against the
   first release. `host doctor` from the first release's controller agrees.

### x86-64 on an Apple Silicon Mac

The fresh-install run does not work under Docker's user-mode emulation (see above). A full-system x86-64 VM runs it,
slowly:

```sh
brew install qemu lima-additional-guestagents
colima start -p x64 --arch x86_64 --vm-type qemu --cpus 8 --memory 8
DOCKER_CONTEXT=colima-x64 scripts/integration/fresh-install.sh --out /tmp/fresh-install-x64
colima delete -p x64
```

## Release builds and the archive scan

`scripts/release-build.sh --out <dir> --version <id> --url-base <url>` builds what a release publishes, on macOS
only, as the controller build is:

- the phone bundle, then both companion archives;
- the controller tree, whose manifest names each companion at `<url>/<archive>` with its digest, packed as
  `svall-controller-<id>-darwin-<arch>.tar.gz`.

With `SVALL_RELEASE_KEY` set, every manifest is signed; without it, every manifest is marked unsigned. A key
`scripts/release/allowed_signers` does not list stops the build before anything is built. The script ends by scanning
the three archives, and a hit fails it.

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
| `tmux` | `ubuntu-24.04` (x64), `ubuntu-24.04-arm` (arm64) | Builds the tmux each Linux companion carries, in an Ubuntu 22.04 container on its own architecture. |
| `build` | `macos-latest` | Needs `key` and `tmux`, and never holds the key. Runs `release-build.sh` twice: for the tag, and as `<tag>-next`, the release the fresh installs upgrade to, which is never published and pins its companions at `http://127.0.0.1:8765/upgrade`. Restores no cache on a signed tag, so a signed release downloads its own pinned Node. Passes both to the other jobs as workflow artifacts, kept for one day. |
| `sign` | `macos-latest` | Runs only with the key. Signs both builds' archives with `release-build.sh --sign` and puts them back in place of the unsigned ones. |
| `fresh-install` | `ubuntu-24.04` (x64), `ubuntu-24.04-arm` (arm64) | Needs `build`, and `sign` unless a run without the key skips it. Runs `fresh-install.sh` with both releases. `host add` installs the tag's companion by path, as its GitHub URL does not resolve before publish; `host upgrade` downloads the `-next` companion from the run's loopback server. |
| `publish` | `ubuntu-24.04` | Needs `key` and `fresh-install`. With the key, it lists every archive in `SHA256SUMS`, signs that with `ssh-keygen -Y sign`, checks the signature against the committed `scripts/release/allowed_signers`, and creates the GitHub release with the archives, `SHA256SUMS` and its signature. Without the key, or for a tag with a `-`, it notes that the dry run passed, and uploads nothing. |

- **Signing.** The `SVALL_RELEASE_KEY` secret holds the private key. Only one step in each of the `key`, `sign` and
  `publish` jobs names it, never one in `build`, so nothing `pnpm install` or the bundlers run can read it. Each such
  step writes it to a 0600 file and deletes it when the step ends. The `sign` job signs the manifests inside the
  archives before any other job takes them, so the archives the jobs test are the ones published. Every action runs
  at a pinned commit.
- **The signers.** `scripts/release/allowed_signers` lists the release key and its offline backup. The `key` job
  fails at once, naming the file, when the secret is not an OpenSSH key without a passphrase or its public half is not
  listed there. See [Release integrity](security/workers.md#release-integrity) for retiring a key.
- **Dry run.** A tag in a repository without the secret builds and fresh-installs everything, and
  uploads nothing. A tag with a `-`, such as `v1.0.0-test1`, does the same, signed when the secret is there.
- **Logs.** A failed job's logs are scanned with `--secrets-only` before they are uploaded, and a hit keeps them back.

### What only a real runner can prove

Actions jobs do not start on this repository (billing), so these steps have run only as the local scripts they call:

- the upload: `gh release create` with the job's token, and a signed tag end to end;
- the native x86-64 and arm64 Linux runners;
- workflow artifacts passing from the macOS jobs to the Linux jobs;
- the `sign` job's upload over the build's artifacts, and the fresh-install job running when a run without the key skips it;
- the fresh-install job's server on the runner's `127.0.0.1:8765`, which needs nothing else listening there;
- the Mac controller's `svall.mjs` on a Linux runner's Node, which has run only on a Mac's Node;
- the build on a macOS runner, which downloads the pinned Node on a cache miss.
