# Fleet handover

## Status

Implementation-ready design for moving a fleet between the Mac running the Archipelago desktop
app and a user-owned, always-on Linux machine reached over Tailscale and SSH.

Version 1 deliberately supports one Mac and one Linux gateway per fleet. The data model and
ownership protocol use stable machine ids and can add more machines later, but remote-to-remote
handover is not part of the first release.

## Product contract

A handover checkpoints a fleet, transfers its durable state, and resumes it on another machine.
It preserves:

- islands, characters, placement, notes, instructions, links and browser tab URLs;
- tracked, untracked, ignored and staged working-tree changes, subject to configured excludes;
- linked Git worktrees and their indexes;
- supported Claude Code and Codex conversations;
- the selected character and open card in the Mac that initiated the handover;
- a stable phone URL and push subscription through the Linux gateway.

A handover does **not** migrate a running Unix process. A build, REPL, server, foreground shell
command or in-flight agent tool is allowed to finish, explicitly interrupted, or reported as a
blocker. Resumed agents keep their conversation and working files, but start as new processes.
Plain shells reopen in their previous directory with a notice that the process was restarted.

Only one machine may execute or mutate a fleet at a time. A failed handover must result in either:

- the source still owning and being able to resume the fleet; or
- the destination owning the fleet, with individual characters available for retry.

It must never automatically revive both sides.

## User story

Five islands, twelve characters and four agents are active on the Mac. The user presses
`Handover`, chooses the Linux machine `trift`, and sees a preflight report. Two agents finish their
turns. One is interrupted after the user chooses **Interrupt and carry**. A shell running a build
blocks the move until the build finishes.

Archipelago freezes mutations, mirrors six repository graphs, transfers the exact agent sessions,
validates the destination, commits ownership, and resumes the characters on `trift`. The window
reconnects through SSH and redraws the same map with the same character selected. A failed
character resume stays dormant with a Retry action; it does not roll ownership back.

The phone continues to use the URL it was given when `trift` was added. The gateway relays the
phone to whichever machine owns the fleet, so push subscriptions and the installed home-screen app
do not change. When the Mac sleeps, the fleet continues on `trift`.

In the morning, running `archi handover local` on the Mac or choosing **This Mac** in the app pulls
the fleet back. Here `local` means the stable id of the machine running the command, never “the
source daemon's current machine.”

## Supported environment

The first published release supports:

- macOS 15 or newer for the desktop app and local owner;
- the Ubuntu LTS releases and architectures named in the desktop release manifest for the gateway
  and remote owner; the initial manifest covers x86-64 and arm64;
- Tailscale on both machines;
- OpenSSH access from the Mac to the Linux account, including Tailscale SSH;
- systemd user services on Linux;
- tmux 3.x and Git on both machines; tmux 3.5 or newer is recommended, because Shift+Enter needs
  its `extended-keys-format`, and Ubuntu 24.04 ships 3.4;
- rsync 3.x on both machines. Linux distributions ship it; macOS ships openrsync, which cannot
  protect remote arguments or report byte progress, so the desktop release bundles its own rsync
  and the system binary is only a fallback the doctor flags;
- explicitly tested Claude Code and Codex CLI versions.

The Mac app is distributed as a signed and notarized direct download. Mac App Store distribution,
whose sandbox is incompatible with the required SSH, subprocess and filesystem integration, is not
part of this design.

---

# Architecture

## Roles

Three roles take part. Two may be on the same Linux process in the implementation, but they remain
separate concepts.

**Controller** — the Mac app or Mac `archi` CLI that the user invoked. It owns the SSH connection,
performs transfers and advances the transaction. Handover is therefore an attended operation and
does not require the Linux machine to SSH back into the Mac.

**Owner** — the machine whose archid may run tmux windows and accept fleet mutations.

**Gateway** — the always-on Linux companion. It is the authority for ownership generations, the
stable phone endpoint and the store for phone push subscriptions. A handover cannot commit while
the gateway is unavailable; the current owner may continue working.

The gateway is not a cloud service. It runs only on the user's machine and is reachable only over
their tailnet and SSH.

## Stable identities

Setup creates a random UUID for every Archipelago installation and every fleet:

```text
MachineId = UUID
FleetId   = UUID
```

Names such as `trift` and `local` are presentation and routing aliases. Ownership records contain
only ids. Renaming a host cannot change ownership.

The controller's machine registry lives at `~/.config/archipelago/machines.json` and contains no
fleet API tokens:

```json
{
  "machines": {
    "9b4d...": {
      "name": "trift",
      "ssh": "trift",
      "platform": "linux",
      "arch": "arm64",
      "home": "/home/linus",
      "archiBase": "/home/linus/.local/share/archipelago",
      "pathRoots": { "home": "/home/linus" },
      "gateway": true
    }
  }
}
```

The local machine has the same record shape, with an implicit direct route rather than `ssh`.
Machine names are unique within the controller registry and match `[a-z][a-z0-9-]{0,31}`.

## Configuration split

The existing `config.json` mixes fleet policy with machine settings. Before handover, it is split
and migrated:

- `fleet.json` is portable and moves with the fleet;
- `node.json` is machine-local and never moves;
- `machines.json` is controller-local routing data and never moves;
- credentials and phone subscriptions remain in mode-0600 stores described below.

`fleet.json` contains the fleet id and portable behavior:

```json
{
  "id": "42aa...",
  "gatewayMachineId": "9b4d...",
  "home": { "cwd": "~/.archipelago/home", "command": "claude --model sonnet" },
  "defaultCwd": "~",
  "scribe": { "agent": "claude", "model": "sonnet" },
  "mobile": { "enabled": true, "logins": ["you@example.com"] },
  "handover": {
    "exclude": [],
    "excludeDefaults": true,
    "transferFleetEnv": false
  }
}
```

`handover.exclude` adds to the default list. It does not replace it. Setting
`excludeDefaults: false` is the explicit way to replace the defaults.

`node.json` contains the loopback port, shell and service-local options:

```json
{ "host": "127.0.0.1", "port": 47800, "shell": "/bin/zsh" }
```

`FleetState.home` and `FleetState.defaultCwd` remain in the API snapshot during migration for UI
compatibility, but `fleet.json` is authoritative. Daemon startup must no longer silently replace an
imported value from an unrelated destination config.

## Ownership authority

The gateway stores one atomically written record per fleet:

```ts
type OwnerRecord = {
  fleetId: string;
  generation: number;
  ownerMachineId: string;
  transaction?: {
    id: string;
    fromMachineId: string;
    toMachineId: string;
    phase: 'preparing' | 'ready-to-commit' | 'committed';
    startedAt: number;
  };
};
```

Every owner stores a cached copy beside its fleet state. The gateway changes the record only with a
compare-and-swap over the expected generation and owner. There is at most one open transaction per
fleet.

An owner may continue at its cached generation while the gateway is temporarily unreachable only
when it has no unresolved local handover journal. Freeze durably marks the local ownership
certificate surrendered before acknowledging the controller, and the gateway refuses Commit
without that acknowledgement. A surrendered or frozen source therefore starts read-only when the
gateway is unreachable, even if its cached owner record is old. When there is no transaction, no
other machine can commit without both the gateway and a durable source freeze.

On daemon start, a reachable gateway record always wins. If the gateway is permanently lost,
recovery requires
`archi fleet recover --force-owner <machine>` and presents the generations and risks before writing
a new authority; it is never automatic.

On app or CLI launch, the controller asks the gateway for the current owner, then opens either the
local direct connection or the owner's SSH route. If the gateway is temporarily unavailable, it may
use a cached route only when that route's daemon reports the same cached generation.

The owner check covers every mutating operation, including:

- island and character creation, update, movement and deletion;
- character run, answer, revive, second terminal and terminal input;
- browser tab mutations;
- filesystem writes;
- scribe and background metadata updates;
- handover and mobile configuration changes.

Read-only state, transcript, repository and terminal-screen reads remain available on an inactive
replica for diagnosis. `term.attach`, `term.open` and any method that can create a tmux session are
owner-only.

## Local and remote connections

archid remains bound to `127.0.0.1` on every machine. A remote connection uses an SSH tunnel; the
daemon API token is never sent directly across the tailnet.

The controller asks the companion over SSH for a JSON connection description containing the
loopback port, protocol version, release version and fleet id. It opens one control master:

```text
ssh -M -S <short-control-socket> -N \
  -L 127.0.0.1:<local-port>:127.0.0.1:<remote-port> <ssh-destination>
```

The app and CLI then connect to `ws://127.0.0.1:<local-port>`. The control socket is a hash under a
mode-0700 directory in `$TMPDIR`, keeping it below the Unix socket path limit. Commands are spawned
with argv arrays, never interpolated through a shell.

`term.attach` continues to return only `{ socket, session }`. The Mac native layer already knows
whether the active connection is remote and builds either:

```text
tmux -S <socket> attach -t <session>
```

or:

```text
ssh -S <control-socket> -tt <ssh-destination> \
  tmux -S <socket> attach -t <session>
```

The remote daemon does not attempt to guess the caller's SSH alias. Dropped SSH connections leave
tmux untouched; the app re-establishes the master, API forward and visible terminal surfaces.

---

# Published remote setup

## Companion release

The signed desktop bundle contains production `archi` and `archid` JavaScript, the phone assets and
a pinned macOS Node runtime. Its installer places that runtime under the same per-user
`releases/<version>` plus atomic `current` layout used on Linux, points launchd and
`~/.local/bin/archi` at `current`, and keeps the previous release for rollback. Neither ordinary Mac
use nor remote setup depends on the source checkout.

Every desktop release publishes the Linux companion archives named in its release manifest. An
archive contains:

- bundled production JavaScript for `archi` and `archid` with a pinned Node runtime;
- the phone bundle and gateway service;
- hook and mission-control templates;
- the licences of everything it redistributes, including the Node runtime's;
- its release manifest and checksum.

The manifest lists a SHA-256 digest for every file in the archive and is detached-signed with the
release signing identity using `ssh-keygen -Y sign`. Installers verify it with `ssh-keygen -Y
verify` against a pinned allowed-signers entry before the archive is unpacked.

The remote machine does not need a repository clone, pnpm, Node, Xcode, Zig or Ghostty. The Mac app
downloads the companion matching its own release from the same signed release manifest, verifies
the digest, and uploads it over SSH. A development build may instead upload the current workspace
artifact explicitly.

Releases install without root under:

```text
~/.local/share/archipelago/releases/<version>/
~/.local/share/archipelago/current -> releases/<version>
~/.local/bin/archi -> ../share/archipelago/current/bin/archi
```

Changing `current` is atomic. The previous release remains available for rollback until the next
successful upgrade.

## Add Machine flow

`Add machine` in the app invokes the bundled controller helper, so it and
`archi host add <name> --ssh <destination>` run the same implementation:

1. Open an interactive SSH connection so the user can verify a new host key and complete any SSH
   authentication.
2. Read the remote home, OS and architecture; require a supported Ubuntu release.
3. Check Tailscale, tmux, Git, rsync and systemd user services. A tmux older than 3.5 is a warning
   naming the Shift+Enter limitation, not a blocker. Missing system packages are shown with a
   copyable apt command. Archipelago runs it only in an interactive terminal after the user
   explicitly approves sudo.
4. Upload and verify the matching companion release.
5. Install `archipelago-gateway.service` and an `archipelago-archid-<fleet>.service` template as
   systemd user units. Units use absolute paths through `current`, a resolved PATH, `Restart=always`
   and logs under the Archipelago data directory.
6. Enable and start the gateway. If user lingering is disabled, show the exact
   `loginctl enable-linger <user>` action and verify it after the user completes it.
7. Create the stable machine id and add the controller registry entry.
8. Check Claude Code and Codex installation, supported versions, login and Archipelago hooks. The
   user completes agent login and Codex hook trust in an offered SSH terminal; credentials are
   never copied from the Mac.
9. Run an end-to-end probe: gateway authority, API tunnel, temporary tmux window, path mapping,
   free space and phone relay.
10. For each existing local fleet the user enables for this machine, create the gateway's initial
    authority record with the local machine as generation-zero owner. Creation is allowed only when
    no record for that fleet id exists.

Setup finishes with either **Ready for handover** or a list of concrete remaining actions. Repeated
setup is idempotent. `archi host doctor trift`, `archi host upgrade trift` and
`archi host remove trift` expose diagnosis, version upgrade/rollback and uninstall.

## Compatibility

Connection and handover negotiate:

- desktop/companion release version;
- RPC protocol version;
- fleet state schema version;
- transfer-manifest version;
- gateway authority version;
- installed Claude Code and Codex versions and their session-adapter versions.

Ordinary remote viewing may allow a documented compatible version range. A handover requires an
exact companion release match and a supported agent-session adapter. The app offers to upgrade the
companion before preflight; it never starts a transfer across an incompatible pair.

---

# Transfer model

## Path roots

Paths are mapped through named roots, not string replacement on an arbitrary prefix. Every machine
automatically defines `home`; users may add matching roots such as `work` for an external disk:

```json
// Mac
{ "pathRoots": { "home": "/Users/linus", "work": "/Volumes/work" } }

// trift
{ "pathRoots": { "home": "/home/linus", "work": "/srv/work" } }
```

The longest matching source root produces `{ root: "work", relative: "repo/src" }`, which resolves
under the destination's `work` root. Matches require a path-component boundary. Both the lexical
path and its real path must stay inside a declared root; a symlink that escapes is copied as a
symlink but cannot be used as a character cwd or transfer root.

A missing destination root blocks preflight. Preflight also detects case-folding collisions,
unsupported file names, broken destination symlinks and insufficient space.

The state path rewrite includes:

- character and second-terminal cwd;
- `repo.root` and `repo.mainRoot`;
- `home.cwd` and `defaultCwd`;
- file and folder context refs, including `file:` browser URLs;
- `agent.transcriptPath` and second-agent transcript paths;
- any future protocol field registered with the central path-field table.

Tests require every absolute path field in the protocol schema to be registered as portable,
machine-local or forbidden. Adding an unclassified path fails CI.

## Transfer inventory

Preflight creates an immutable, versioned manifest containing:

- the source fleet generation and complete state snapshot;
- the portable `fleet.json`;
- repository graphs described below;
- non-repository character cwd roots;
- `home.cwd`;
- file or folder context refs not already covered by another root;
- exact agent-session files and required sidecars;
- excludes, modes, sizes and destination paths;
- source and destination machine ids and path-root mappings.

Nested filesystem roots are folded so a file is sent once. A context item outside a declared path
root blocks rather than becoming a rewritten reference to a file that was never transferred.

The fleet's own `.env`, used for scribe credentials, transfers only when
`handover.transferFleetEnv` is true. Repository `.env` files are working-tree data and transfer by
default. The first transfer to a host calls this out explicitly because it may copy secrets.

Default excludes are:

```text
node_modules/
.venv/
__pycache__/
dist/
build/
target/
.next/
*.tsbuildinfo
```

Excluded platform caches stay destination-local and are never used in source verification.

## Git repository graphs

For every character in Git, preflight records:

```text
git rev-parse --path-format=absolute \
  --show-toplevel --git-common-dir --git-dir
git worktree list --porcelain
```

The repository graph contains the common directory/main checkout and every worktree used by a fleet
character. A used worktree outside the main checkout is a separate transfer root and must still be
inside a declared path root. Registered worktrees unused by the fleet retain refs but are not made
live on the destination.

Transfer carries the common Git directory, per-worktree index and metadata, and every used working
directory. On the destination the importer:

1. removes worktree registrations not present in the manifest from the destination copy without
   removing their branch refs, before anything else touches the graph;
2. rewrites each worktree's `.git` file to its mapped git dir and rewrites `.git/worktrees/*/gitdir`
   entries for transferred worktrees, as a belt-and-braces step;
3. runs `git worktree repair` for the mapped paths, which must report nothing left to fix given
   step 2 already ran;
4. verifies `git worktree list`, `git status` and staged changes against the manifest.

The importer never runs `git worktree prune` to drop unlisted registrations: at import time no
registration resolves yet, so prune removes the whole `.git/worktrees` directory instead of the
entries the manifest omits. Step 1 must run before step 3, because `git worktree repair` rewrites
any registration it can still reach, including one still live on the source machine, and pointing
that rewrite at the destination corrupts the machine being migrated from.

Submodules remain their own repository graph when a character works inside one. Otherwise their
working directories and gitlink state travel with the containing graph. A submodule's `origin`
remote is not rewritten by this flow; an origin URL naming the source machine is reported to the
user as a warning. Git validation failure prevents commit.

## Destination replicas and divergence

Archipelago stores a mode-0600 replica record under its machine data directory for each destination
transfer root. The record is keyed by fleet id and a hash of the canonical destination path and
contains that path, the received generation and a content manifest. No marker is written inside a
repository. `rsync --delete` is permitted only when the destination is absent and reserved by the
current transaction, or when it has a matching replica record. It never mirrors over an arbitrary
pre-existing folder.

Before updating a replica, Archipelago compares it with the last received manifest. Changes made
while that machine did not own the fleet block the handover. The user may:

- cancel and recover the changes manually;
- choose another path mapping; or
- explicitly archive the divergent destination root and continue.

Archiving renames the root to a timestamped sibling and reports the recovery path. Handover never
silently deletes destination-only work.

Rsync runs incrementally over SSH with argv-safe arguments. A partial transfer leaves an inactive,
transaction-marked replica which `--resume` can continue cheaply. The source remains authoritative
until ownership commits.

After the main pass, the controller re-scans source state and file manifests and runs a verification
pass. App/API writes and background jobs are frozen, but external editors cannot be locked; detected
source changes cause another pass. After three unstable passes the handover stops and asks the user
to close the external writer.

## Agent sessions

The manifest uses the recorded `agent.transcriptPath`; it does not derive a directory by replacing
characters in cwd. It honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME` on both machines.

For Claude Code, the versioned adapter transfers the session JSONL plus session-specific sidecars
and subagent data, places them under the destination project slug, and rewrites the path-bearing
fields known for that supported Claude release. It does not copy every unrelated session from the
project directory.

For Codex, the adapter transfers the rollout file, which is all the destination needs: it finds the
session by scanning `sessions/` for the id and rebuilds its own thread index from the rollout.
Session ids remain unchanged, but path-bearing session metadata is rewritten and validated for the
supported Codex release.

The imported `agent.transcriptPath` always points at the destination file before activation.
Preflight blocks unsupported agent versions or a session whose required file is missing. A separate
repair action may start a fresh agent with a generated transcript summary, but this is visibly a new
session and is never the automatic handover path.

Global agent credentials, user-wide skills, MCP configuration and shell dotfiles are machine-local.
Host doctor checks installation, login and hooks, and preflight reports material configuration
differences. Repository and project-local instructions travel with their filesystem roots.

## Terminal records

Protocol schema v7 makes both terminal slots explicitly resumable. A terminal record has its cwd,
optional live tmux ids, optional agent, and optional revive command. A second terminal no longer
disappears merely because its tmux window is absent.

Before export, all `tmux.windowId` and `paneId` fields are removed. For a supported agent,
`revive.command` is `claude --resume <id>` or `codex resume <id>`. A plain shell has no command and
reopens at its mapped cwd. Archipelago may save terminal scrollback for diagnosis, but it is not
replayed as process state.

---

# Handover transaction

## Preflight blockers

Preflight is read-only and runs before any terminal is interrupted. It blocks when:

- source, destination or gateway identities/generations disagree;
- another transaction is open;
- release, protocol, schema or agent adapters are incompatible;
- a required agent CLI is absent, logged out or missing hooks;
- a transfer root or cwd has no destination path root;
- a character is marked **Keep on this machine**;
- a foreground shell process is still running;
- a worktree graph cannot be reconstructed and validated;
- destination files diverged from the last replica manifest;
- a destination path already exists without a matching replica marker;
- the destination lacks space or has a path/case collision;
- a required transcript is absent;
- SSH is not non-interactive after the controller's initial authenticated connection.

Platform dependence is explicit rather than guessed. A character can be marked **Keep on this
machine**, and a repository may contain `.archipelago/handover.json` with supported destination
platforms. Heuristics such as Xcode projects produce warnings, not silent policy.

## Resting characters

After successful preflight, the controller opens an authority transaction and asks the source to
freeze. Freeze rejects every mutating RPC, stops scribe/background state changes, closes new attach
requests and snapshots the known character set.

Freeze repeats the process-tree and source-path checks because work may have started after
preflight. A newly discovered blocker leaves the source frozen only long enough to abort the open
transaction and then returns it to normal ownership without killing a window.

Each primary and second terminal is classified:

- `idle` or `done` agent: ready;
- `working` agent: wait for `done`, `idle` or `blocked`;
- `blocked` agent: the user may answer it, choose **Interrupt and carry**, or cancel;
- plain shell at its prompt: ready;
- shell with a foreground process: blocker until it exits or the user chooses **Terminate and
  carry**.

There is no automatic thirty-second Escape. The sheet offers **Continue waiting**,
**Interrupt and carry**, and **Cancel**. CLI automation opts in with
`--interrupt-after <duration>` and `--terminate-shells`; without them it exits with blockers.

After an interrupt, Archipelago waits for the agent hook or process tree to confirm rest. Failure to
settle is a blocker unless the user explicitly terminates that terminal. Only then are tmux windows
killed and terminal records made dormant.

## State machine

The controller executes these durable steps:

1. **Begin.** Gateway compare-and-swaps an ownership transaction at generation `g`.
2. **Freeze.** Source fences mutations, rests terminals, writes its transaction journal and returns
   the immutable transfer manifest.
3. **Transfer.** Controller rsyncs roots and exact session files. Progress is recorded per root.
4. **Verify.** Controller performs the final source pass; destination validates paths, Git,
   transcripts and state schema without starting a window.
5. **Prepare.** Destination writes the rewritten state to a transaction-specific prepared file,
   validates it again, writes its prepared journal for generation `g + 1`, and the gateway records
   the transaction as `ready-to-commit`. The active `state.json` is not replaced yet.
6. **Commit.** Gateway compare-and-swaps owner from source at `g` to destination at `g + 1`. This is
   the point of no automatic return.
7. **Activate.** Destination confirms the committed authority record, atomically promotes the
   prepared file to `state.json`, replaces the in-memory Store, then starts terminal windows with
   bounded concurrency and reports each result. Source records itself inactive.
8. **Complete.** Gateway clears the transaction while retaining owner and generation. Replica
   manifests are sealed at generation `g + 1`.

State import is a validated replacement, not a merge. Character and island deletions on the source
therefore remain deleted.

Source, destination and gateway journals are written atomically and contain enough information for
a new controller process to resume. Steps are idempotent under the same transaction id.

## Failure and recovery

Before Commit:

- no destination tmux window may exist;
- `archi handover --resume` continues Transfer or Verify;
- `archi handover --abort` clears the gateway transaction, discards the prepared state, unfreezes
  the source and revives only terminals that handover stopped;
- partially mirrored destination files remain transaction-marked and inactive for a later resume.

At or after Commit:

- abort to the source is refused;
- the source remains fenced even if it missed the commit response;
- restart checks the gateway and learns the committed generation;
- activation is retried only on the destination;
- characters that fail to resume remain dormant with their transcript and a visible error.

If the controller disappears, the sheet and CLI reconstruct status from the three journals.
`archi handover status` says whether Abort or Resume is safe. A stale pre-commit transaction may be
aborted after confirming that the authority still names the source at the expected generation.

Concurrent handovers are rejected by the authority compare-and-swap. A force-owner recovery is a
separate, deliberately alarming disaster-recovery command and never part of ordinary retry.

---

# Stable phone gateway

The gateway serves a fleet at a stable path on its Tailscale HTTPS origin:

```text
https://<gateway>.<tailnet>.ts.net/f/<fleet-id>/
```

One `tailscale serve` mapping fronts the gateway service, so fleets are not limited to the three
special HTTPS ports. Each fleet's PWA manifest and service-worker scope are rooted under its path.

The phone always connects to the gateway. The current owner maintains an outbound authenticated
WebSocket relay to the gateway:

- when the gateway owns the fleet, the relay is loopback;
- when the Mac owns it, archid opens `wss` over Tailscale to the gateway;
- a per-fleet relay secret, provisioned mode 0600, authenticates the owner connection;
- the gateway authenticates the phone's `Tailscale-User-Login`, enforces `mobile.logins`, and passes
  a signed viewer identity to the owner;
- the owner accepts a forwarded identity only on the authenticated relay, never on its normal API.

The gateway creates the relay secret when a fleet first enables mobile. The controller installs it
on the current owner, and Prepare installs it mode 0600 on a destination before Commit. It is not
part of `fleet.json`, state snapshots or repository rsync.

RPC, terminal streams and state events are multiplexed through the relay. The gateway holds VAPID
keys and push subscriptions permanently and derives push notifications from owner status events,
so a handover does not require re-subscription. If the owner sleeps or loses its relay, the phone
shows the same fleet URL as offline and reconnects there later.

`archi mobile on` enables the fleet route and prints its stable URL. `mobile off` disables that
route but does not remove the gateway or other fleets. Phone-initiated handover is not in version 1.

---

# Port forwarding

Port discovery is useful but not part of the ownership transaction. A resumed dev server is a new
process and is discovered after it starts.

On Linux, archid samples `ss -ltnpH` while a desktop viewer is connected and attributes sockets to
a character when the listener belongs to its pane process tree. Ports are runtime data and are
cleared when the process disappears; they are not transferred as durable fleet state.

For a remote owner, the Mac connection manager adds forwards through the existing SSH master. It
binds only `127.0.0.1`. The local port equals the remote port when free and otherwise uses a free
port recorded in the app's runtime mapping.

A `:5173` chip opens the mapped local URL. If the port was remapped, the chip displays
`:5173 → :5174`. In-app localhost links are rewritten through the known mapping when opened.
External applications cannot use the original printed port when it collides, so the product makes
no promise that every literal `localhost` URL remains unchanged.

`archi forward <char> <port>` creates a manual forward and `archi forward --list` reports mappings.
Forwards reconnect with the SSH master and close when the fleet connection closes. Multiple
characters reporting the same remote listener share one tunnel.

---

# User interface and commands

`Handover` sits beside the fleet/owner badge. The destination menu contains **This Mac** and the
configured gateway. The sheet has five user-facing sections backed by the transaction phases:

1. Checks
2. Resting characters
3. Transferring files and sessions
4. Verifying and committing
5. Resuming characters

Before commit the sheet offers Abort. After commit it offers Retry for failed activation and never
offers an unsafe rollback. Closing the app does not cancel the transaction; reopening reconstructs
the sheet from journals.

On successful activation the app reconnects to the new owner and keeps its locally selected
character, open card and pane layout. Those presentation choices are device-local. Another Mac sees
the same fleet and browser tab URLs but not the first Mac's editor layout, WebKit cookies or logged-in
browser sessions.

CLI commands:

```text
archi host add <name> --ssh <destination>
archi host list
archi host doctor <name>
archi host upgrade <name>
archi host remove <name>

archi handover <host|local>
archi handover status
archi handover --resume
archi handover --abort
archi handover <host> --interrupt-after 30s --terminate-shells
```

`--json` emits newline-delimited phase and entity events suitable for automation.

## Protocol surface

Fleet RPC additions:

```text
system.info            {} -> { machineId, release, protocol, stateSchema,
                               transferSchema, platform, arch, agentAdapters }
ownership.get          {} -> { fleetId, generation, ownerMachineId, frozen, transaction? }
handover.preflight     { toMachineId } -> { manifestSummary, blockers, warnings }
handover.freeze        { transactionId, generation, choices } -> { manifest }
handover.prepare       { transactionId, generation, snapshot, manifestDigest } -> {}
handover.activate      { transactionId, generation } -> { characters: [...] }
handover.abort         { transactionId, generation } -> {}
handover.status        {} -> { transaction?, characters, roots }
```

Gateway authority operations are available only through the authenticated controller SSH command
or its local Unix socket:

```text
owner.get       { fleetId }
owner.create    { fleetId, initialOwnerMachineId }
owner.begin     { fleetId, expectedGeneration, fromMachineId, toMachineId }
owner.ready     { fleetId, transactionId, expectedGeneration }
owner.commit    { fleetId, transactionId, expectedGeneration }
owner.abort     { fleetId, transactionId, expectedGeneration }
owner.complete  { fleetId, transactionId, generation }
```

Host discovery, SSH lifecycle, rsync and top-level handover orchestration belong to a shared
TypeScript controller package used by the CLI. The native app invokes the bundled `archi` helper,
reads its newline-delimited JSON events and forwards them to the web UI. They are not daemon RPCs,
because routes and SSH aliases are controller-local.

Events:

```text
event ownership.changed  { generation, ownerMachineId }
event handover.changed   { transactionId, phase }
event handover.entity    { transactionId, kind, id, phase, done?, total?, error? }
event ports.changed      { characterId, ports }
```

---

# Implementation sequence

## Code map

Implementation follows these ownership boundaries:

- `packages/protocol/src/state.ts`, `migrate.ts` and `messages.ts`: schema v7, ids, ownership,
  handover RPCs and events;
- `packages/archid/src/config.ts` and `paths.ts`: `fleet.json`/`node.json` migration and new durable
  paths;
- `packages/archid/src/ownership/`: owner guards, cached generation and freeze state;
- `packages/archid/src/handover/`: manifests, path mapping, Git graphs, replica records, journals,
  prepare/activate and agent-session adapters;
- `packages/archid/src/gateway/`: authority compare-and-swap, mobile relay, stable PWA routes and
  push store;
- `packages/cli/src/controller/`: SSH master, companion install, rsync orchestration and transaction
  recovery shared by host and handover commands;
- `packages/cli/src/commands/host.ts` and `handover.ts`: human and NDJSON command surfaces;
- `apps/desktop/mac/Sources/Archipelago/`: bundled-helper process management, remote connection
  routing and SSH terminal commands;
- `apps/desktop/web/src/`: host setup and handover sheet driven only by bridge events;
- `scripts/` and release CI: reproducible Mac helper and Linux companion archives, manifests,
  checksums and fresh-machine smoke tests.

New modules have unit tests beside the existing package test suites. End-to-end fixtures and fault
injection live under `packages/archid/test/handover/`; published-install smoke tests run in release
CI rather than on ordinary local test runs.

## Phase 0 — schemas and ownership fencing

1. Add `MachineId`, `FleetId`, schema-v7 resumable second terminals and path-field classification.
2. Split and migrate portable `fleet.json` from machine-local `node.json`.
3. Add machine registry and stable local machine identity.
4. Add owner/generation checks around every mutating API and background state writer.
5. Implement atomic transaction journals and Store snapshot replacement.

Exit criterion: an inactive or frozen daemon cannot mutate fleet state, files or tmux through any
API, and schema migration preserves existing fleets.

## Phase 1 — published Linux companion and remote viewing

1. Produce signed x86-64 and arm64 companion archives with pinned runtime.
2. Implement Add Machine, systemd install, linger diagnosis, doctor, upgrade and rollback.
3. Implement controller-owned SSH master and loopback API forwarding.
4. Teach the Mac surface manager to attach remote tmux through the existing SSH master.
5. Exercise reconnect and multiple simultaneous terminal surfaces.

Exit criterion: a new supported Ubuntu machine can go from SSH access to a usable remote fleet
without cloning Archipelago or installing a JavaScript toolchain.

## Phase 2 — gateway authority and handover

1. Implement gateway ownership compare-and-swap and recovery inspection.
2. Implement preflight inventory, named path roots and destination replica markers.
3. Implement Git graph transfer/repair and source/destination verification.
4. Implement versioned Claude/Codex session adapters.
5. Implement freeze/rest choices, durable transfer progress, prepare, commit and activation.
6. Implement handover CLI and sheet, including crash reconstruction.

Exit criterion: fault injection at every await and process boundary cannot produce two active
owners or silently lose source/destination work.

## Phase 3 — stable phone relay

1. Move mobile assets, VAPID keys and subscriptions to the gateway service.
2. Add per-fleet path-scoped PWAs and authenticated owner relay.
3. Proxy phone RPC/terminal streams and status events to the current owner.
4. Verify that handover in both directions preserves URL, installed PWA and push subscription.

Exit criterion: the same phone URL controls the fleet before and after both directions of handover,
and shows an offline state when the owner is unreachable.

## Phase 4 — port discovery and forwarding

1. Add Linux listener/process-tree discovery.
2. Add SSH control-master forward lifecycle and collision mapping.
3. Add chips, manual forwards and in-app localhost-link rewriting.

Exit criterion: a remote dev server opens from the Mac, reconnects after SSH loss, and reports an
honest remapped URL when its preferred local port is occupied.

---

# Verification

## Automated tests

- Unit-test every ownership transition, compare-and-swap failure and restart state.
- Run fault injection before and after every transaction write, rsync pass, state install, commit
  and character activation.
- Assert that pre-commit abort revives only the source and post-commit retry activates only the
  destination.
- Enumerate all RPC handlers and prove every mutator is fenced.
- Transfer Git fixtures containing staged changes, untracked files, ignored files, stashes,
  submodules and linked worktrees inside and outside the main checkout.
- Verify destination divergence blocks and explicit archive preserves a recovery path.
- Test case-colliding paths and escaping symlinks.
- Keep versioned real-session fixtures for every supported Claude Code and Codex release; import and
  run their resume command in an isolated account.
- Test source changes during rsync and bounded stabilization retry.
- Test protocol/release/adapter mismatch before freeze.
- Integration-test local-to-Linux and Linux-to-local with two disposable machines or containers,
  mocked agents and real tmux/SSH/rsync.
- Test gateway phone routing and pushes across owner changes and relay loss.
- Test fresh Ubuntu x86-64 and arm64 provisioning from the published Mac artifact.

## Manual acceptance

- Twelve characters across five islands hand over in both directions; working agents finish or are
  explicitly interrupted, and foreground shells block visibly.
- The initiating Mac returns to the same selected character and browser tab URLs.
- A linked worktree retains branch, index, staged/unstaged/untracked changes and resumes its agent.
- Pulling the network during every displayed phase produces the documented Abort or Resume action.
- Killing the controller before and after commit reconstructs the correct sheet on relaunch.
- A failed destination agent login before freeze blocks; a resume failure after commit leaves one
  dormant, retryable character without reactivating the source.
- The phone's installed app and push subscription work before and after both owner changes.
- A destination file edited while inactive is never overwritten without explicit archive approval.

## Release gate

The feature is ready to ship only when the fault-injection suite demonstrates the single-owner
invariant, every supported agent fixture resumes on both platforms, and fresh-machine provisioning
passes on both supported Linux architectures.

---

# Not in version 1

- arbitrary process or memory migration;
- unattended or phone-initiated handover;
- remote-to-remote transfer or more than one gateway per fleet;
- continuous background repository sync;
- simultaneous writable copies or conflict merging;
- per-character or per-island handover;
- Linux or Windows desktop apps;
- browser cookie/login migration between Macs;
- a guarantee that a colliding local port keeps its original number;
- unsupported Linux distributions, containers or agent CLI versions;
- machines outside the user's tailnet.
