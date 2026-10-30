# Workers: security and limits

What a worker and a robot move trust, what they refuse, what they delete and on whose authority, what a release
carries and under which licences, and which risks are accepted. Tests are named by file under `packages/` or `test/`.

## Trust model

- **Trusted:** the user's account on both machines, their ssh configuration and keys, and their tailnet. A process
  running as that user can read and write everything a move can, so it is not defended against.
- **The home** decides where each robot runs. A move commits when this Mac's daemon writes the robot's new machine to
  `state.json`, and the worker starts the robot only once it holds that record. Before the commit the robot reopens
  where it was; after it, it never reopens on the machine it left.
- **A worker's token.** `svall host add` issues each worker a token of its own, kept in the fleet home's
  `workers.json`, and hands it to `svall worker enroll` there on stdin. The worker keeps it in `worker.json` with this
  Mac's machine id and the fleet's id, and takes only the link whose hello holds it. The home closes a link whose
  worker answers as another machine than the registry names. Over the link, the worker passes on to the home each
  change a `svall` on the worker asks for, which the home's API takes as the user's.
- **The daemon's ssh master.** The home's daemon reaches each worker through one ssh control master, with
  `BatchMode=yes`, whose socket is in a folder of the user's own at 0700. The link runs `svall worker link` over it,
  and the app's terminals on the worker attach through it.
- **Not trusted:**
  - other accounts on either machine;
  - a companion archive until it is authenticated;
  - what a move carries: file names, links and whatever the agent wrote;
  - any machine an ssh destination reaches until it answers with the registry's machine id.
- **Nothing listens past loopback.**
  - The daemon API binds `node.json`'s `host`, `127.0.0.1` unless the user sets another.
  - A host command reaches a far daemon through `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>` on its master.
  - The worker's end of the link (`link.sock`) and the hook receiver (`hooks.sock`) are Unix sockets at 0600 in the
    0700 fleet home.
  - A terminal the Machines panel opens for `codex login` or an MCP server's login forwards `127.0.0.1:1455`, or
    3118 or the server's own callback port, to the machine while it is open.
  - The phone link is the only thing served past loopback: `tailscale serve`, and only when the user turns it on.
    A move never turns it on, on either machine.

## Threat model

| Threat | What stops it | Tests |
| --- | --- | --- |
| An ssh destination read as an option, such as `-oProxyCommand=…` | The registry holds a destination to `[A-Za-z0-9][A-Za-z0-9._@:[\]-]*`, and every ssh argv puts `--` before it. | `protocol/test/machines.test.ts` "refuses an ssh destination a command would read as an option"; `cli/test/controller/ssh.test.ts` "carries a hostile destination as one argument after the option terminator, to the master alone" |
| A user or host name that a `ProxyCommand`'s `%r` or `%h` hands a shell (CVE-2023-51385) | The same pattern allows no shell metacharacter. | `protocol/test/machines.test.ts` "refuses a user or host name a ProxyCommand's %r or %h would hand a shell to expand" |
| A terminal the Machines panel opens on the machine running what the user did not choose, or carrying the Mac's keys there | It is an ssh of its own to the registry's destination, or the one an add not yet in the registry was given, held to the same pattern after `--`, with `BatchMode=yes`, `ForwardAgent=no` and `ControlPath=none`, so it neither joins nor leaves behind a master that would keep its forward. A step's command is pasted once the screen has shown more than login's banner and stopped changing, and only one line without control characters, so it runs only when the user presses Return. Its screen is read only to tell when the prompt is up and, for an ssh that ends before that, for its last line; neither is logged. A link opens only when the user clicks it. | `apps/desktop/mac/Tests/SvallTests/MachineCommandTests.swift`; `apps/desktop/web/e2e/host.spec.ts` "a fix the machine leaves to the user opens a terminal there with its command typed…" |
| An alias that now reaches another machine | `host add` of a name already in the registry, `host upgrade`, `host upgrade --rollback` and `host remove` first ask `svall version --json` there and stop on another machine id, and `host add` asks again once it has installed, for a machine that had no `svall` to ask, keeping the registry's record either way. A far daemon is used only once `connection-info` answers with the registry's machine id and the fleet's id. Every command on a master names the host `svall-remote.invalid`, so one whose master has died fails rather than opening a connection no check covered. The app's terminals attach through the master only while it answers on its socket, with `ControlMaster=no` and `BatchMode=yes`. | `cli/test/host-add.test.ts` "installs nothing on a machine that answers as another than the registry names, and keeps its record", "stops at identity on a machine with no svall to ask that installs as another, and keeps its record"; `cli/test/host-upgrade.test.ts` "uploads and installs nothing on a machine that answers as another than the registry names"; `cli/test/host-remove.test.ts` "uninstalls nothing on a machine that answers as another than the registry names, as an alias that now leads elsewhere"; `cli/test/controller/connection.test.ts` "refuses a description naming another machine as a machine mismatch, which no retry changes"; `cli/test/controller/ssh.test.ts` "never lets a command fall back to a connection of its own once its master has gone"; `apps/desktop/mac/Tests/SvallTests/AttachCommandTests.swift` `testNoCommandIsBuiltWhileTheMasterDoesNotAnswer`, `testAMasterAnswersOnlyWhileSomethingListensOnItsSocket` |
| A link that does not hold the worker's token | The worker compares the hello's token with `worker.json`'s in constant time and closes any other link. `svall host add` run again issues a new token, which replaces the old one. | `svalld/test/link/link.test.ts` "the worker refuses a hello whose token is wrong and closes", "holds a token per machine, readable by its owner alone"; `cli/test/host-add.test.ts` "enrols a fleet home there that already serves this Mac as a worker again, with a new token" |
| A machine that serves another Mac | `host add` and `host upgrade` upload and install nothing where `svall` there says the fleet's home there serves another Mac, and enrol nothing in a fleet home whose `worker.json` names another Mac; `host remove` uninstalls nothing while any fleet home there has one or one cannot be read. `host add` refuses a machine this Mac already lists under another name before it enrols it. | `cli/test/host-add.test.ts` "uploads and enrols nothing over a fleet home there that serves another Mac as a worker, and registers nothing", "enrols nothing on a machine this Mac already lists under another name, and keeps its one record"; `cli/test/host-upgrade.test.ts` "uploads, installs and enrols nothing over a fleet home there that serves another Mac as a worker, and changes nothing there"; `cli/test/host-remove.test.ts` "uninstalls nothing on a machine where a fleet home serves another Mac, or whose fleet homes cannot be read, as svall uninstall there stops every fleet on it" |
| A remote argument split or expanded by the far login shell | Every word that is not a literal flag goes through `shq` (`svalld/src/text.ts`). Scripts run as `sh -c '<literal>' <name> <args…>`. A terminal's tmux, socket and session are quoted once more for the far shell. | `cli/test/controller/install.test.ts` "streams the archive into a path the far shell never splits", "hands the far check the archive, the staging folder, the release and the far svallBase as words of their own"; `cli/test/controller/connection.test.ts` "quotes a base the far shell would otherwise read as more than one word"; `AttachCommandTests.swift` `testTheFarShellGetsTheTmuxSocketAndSessionAsOneWordEach` |
| A carried file name or link that tar or git would misread | The untracked files travel in a ustar archive built from a NUL-separated list, each name after `./`, and a name or link target ustar cannot hold refuses the move before anything is packed. The patches are git's own, with no external diff, text conversion or colour. Each file is checked by content and mode once it lands, and the worktree against the fingerprint the move recorded. | `svalld/test/placement/bundle.test.ts` "round-trips staged, unstaged, untracked, modes, a symlink and a binary, and the fingerprint matches", "refuses an untracked path or link target ustar cannot hold, which bsdtar would leave out, before packing" |
| A path that lands somewhere else than it left from | A path under the source's home lands under the destination's by one swap on whole path components, and comes back where it left. A repository lands at its main checkout's place, and a path outside the home keeps its path. | `svalld/test/placement/relocate.test.ts` "moves the home and each path under it, on a component boundary, and leaves any other path where it is", "comes back to the path it left from" |
| A move that writes over work on the destination | A path in the way refuses, and nothing is reset or deleted to make room. A branch of the robot's branch's name there that holds commits the robot's lacks refuses, at the check and again where the bundle applies. A worktree the robot left there is taken back only while its branch and files are as the move recorded. | `svalld/test/placement/checks.test.ts` "check 4: a clone of the same repository is warm and builds on its refs; a folder or another repository there is in the way"; `move.test.ts` "a move refuses a branch of its name on the worker holding commits the robot's lacks, at the check and at the apply, and takes one it holds whole", "refuses a return when the Mac branch moved, and when the Mac worktree changed, with the exact sentences", "a robot back from a worker goes there again into the worktree it left, and is refused when that changed since" |
| An OpenCode session read in over a copy the destination went on with | The destination refuses ("OpenCode went on with session … since the move") unless its copy's messages are a prefix of the incoming ones, and keeps that copy. It imports with `--directory` set to the terminal's folder, with `--standalone`, never the user's shared service, and puts its earlier copy back if the import fails. | `move.test.ts` "a return refuses an OpenCode session this Mac went on with meanwhile before it touches the Mac worktree, and its copy stays", "a move refuses an OpenCode session the worker went on with since the robot came back, before anything moves, and its copy stays", "a return whose OpenCode import fails puts back the copy this Mac held, and keeps no other" |
| A robot started on two machines | A robot has one machine in the home's state, and the destination starts it only from the home's record of the commit. A crash at any step of a move leaves it on one machine. | `svalld/test/placement/faults.test.ts` "a … that dies at …:… moving … ends with the move done or aborted and the robot on exactly one machine"; `move.test.ts` "a crash after commit and before activate resumes from the journal: activate runs on the worker, the source is never reopened" |
| A program in a robot's pane on a worker reading back what the user copied | On tmux 3.7 or newer the worker's tmux answers no OSC 52 query (`get-clipboard off`), so a program that reaches only its terminal, in a container or past another ssh, gets no copy back; an older one still serving there, such as Ubuntu's 3.4, answers it from its top paste buffer. A process running as the user there reads tmux's paste buffers through its socket, as on the Mac. | `svalld/test/tmux.test.ts` "hands a copy on Linux, made by tmux or by the app in the pane, to the terminal attached as OSC 52" |

## Release integrity

- **Signing.** A release's `SHA256SUMS` covers every file, `release.json` included, and is signed with
  `ssh-keygen -Y sign` under the `svall-release` namespace. `release.json` describes every entry in both
  directions. The release workflow hands the key only to the steps that check it, sign and publish, never to the
  build; see `docs/integration.md`. (`test/release-stage.test.ts` "hands the signing key only to the steps that check
  it and sign…", "%s runs every action at a commit, never at a tag that can move")
- **Release keys.** `scripts/release/allowed_signers` lists two ed25519 keys under the principal `svall-release`: the
  release key, which the `SVALL_RELEASE_KEY` secret and the publishing Mac hold, and a backup key kept offline. Every
  release carries the file. The controller checks a companion against its own copy, and a machine checks an upgrade
  against the copy its installed release carries. A build given `SVALL_RELEASE_KEY` refuses, before it builds
  any archive, a key the committed file does not list, and `pnpm release` refuses to run without one.
  (`test/release-stage.test.ts` "refuses a key the signers do not list…", "is either key the signers list…";
  `svalld/test/release.test.ts` "refuses a release signed by a key the committed signers do not list")
- **Retiring a key**, lost or leaked: sign the next release with the backup key, and in that release list a new backup
  in place of the retired key. A machine on any signed release takes it, as its installed signers list the backup, and
  from then on refuses the retired key. A machine not yet upgraded still trusts the retired key, but its controller
  hands it only releases the controller's own signers vouch for. Losing both keys leaves every machine refusing new
  releases until `svall host remove` and `svall host add` install it afresh.
- **On the controller**, before any upload:
  - a companion the controller's own manifest names, carried in its release or downloaded, must match the digest
    that manifest pins;
  - every member of the archive must be a path in `releases/<v>`, with no empty, `.` or `..` segment, and listed once;
  - an archive's `SHA256SUMS` must verify against the controller's `release/allowed_signers` before anything else is
    unpacked from it, still be that file once the rest is, and the tree must then match its manifest, staged by the
    installer's own `stageArchive`;
  - it must be this controller's release and protocol, built for the machine's architecture.

  (`cli/test/controller/install.test.ts` "checks the signature over an archive's SHA256SUMS before it unpacks anything
  else from it", "refuses an archive holding a member outside its release, spelled other than as a path in it, or
  twice, before anything is uploaded")
- **On the far machine**, the uploaded release is checked before anything it carries runs, on an upgrade and on a
  `host add` run again over an installed release alike:
  - every member must be a path in `releases/<v>`, spelled one way and listed once, as on the controller;
  - `ssh-keygen -Y verify` of its `SHA256SUMS`, unpacked alone, against the installed release's
    `current/release/allowed_signers`, before the rest of the archive is unpacked;
  - the same check again once the rest is unpacked, since GNU tar writes a member under a link inside the release
    over the `SHA256SUMS` it extracted by name;
  - then `sha256sum -c --strict`;
  - then `release.json`, which the digests cover, must name the release asked for, so a signed older release cannot
    be replayed under a newer one's name.

  The check sets its own `PATH` of system folders, so a relative entry in the login shell's `PATH` never runs a tool
  the upload carries. The result appears in the `install` step. An `--allow-unsigned` upgrade checks the digests alone
  and says so. An installed release whose signers file pins no key (every release before the first signing key)
  leaves the controller's check as the only one, and says that too. An installed release that has lost its signers
  file refuses the install. A machine with no release installed has no signer of its own, so the controller's check
  is the one a first install rests on, and the step says so.

  (`cli/test/host-upgrade.test.ts` "checks the new release against the signers the installed release pins…", "holds a repeat
  host add over an installed release to the signers that release pins…", "says when a machine has no release installed
  to pin a signer…", "refuses a release the installed release's signers do not vouch for, before anything it carries
  runs", "checks the signature over an upgrade's SHA256SUMS before it unpacks anything else the archive holds",
  "refuses a release the pinned key signed that arrives under another release's name…", "refuses an archive that gives
  the far check one SHA256SUMS to verify and another to check the files by…", "checks with the system's own
  tools, whatever a relative entry in the far PATH finds in the upload first", "refuses a release when the installed
  release has lost its signers file…", "says when the installed release pins no signer…", "checks an unsigned release
  with --allow-unsigned by its digests alone…"). The Mac's bsdtar matches every spelling of a name and refuses to
  write under a link, so the far check also runs under GNU tar in a Linux image: `SVALL_TEST_GNU_TAR=svall-it:machine`
  with `DOCKER_HOST` naming the engine's socket runs `host-upgrade.test.ts` "checks the files against the SHA256SUMS the pinned
  key signed, whatever the archive writes over it".
- **`svall setup --release <archive>`**, the installer on the Linux machine, refuses the same members and a release
  name it would not take, checks the signature over the archive's `SHA256SUMS` before it unpacks the rest, then that
  the unpacked `SHA256SUMS` is byte for byte the one it checked, then every digest and the tree.
  (`svalld/test/release.test.ts` "checks the signature over an archive's SHA256SUMS before it unpacks anything else
  from it", "refuses an archive holding a member outside its release, spelled other than as a path in it, or twice";
  `test/install-release.test.ts` "checks the signature over its SHA256SUMS once…", "refuses an archive whose members
  write over the SHA256SUMS its signature was checked over…", which runs under GNU tar with
  `SVALL_TEST_GNU_TAR=svall-it:machine`)
- **Unpacking.** Once its members and its signature have passed, or its members when no signature is asked for, an
  archive is unpacked into a staging folder by the system's tar. It keeps each member's mode, which `release.json`
  records, whatever the account's umask. On a Mac it lays down no ACL, file flag or extended attribute, which nothing
  signed describes. Nothing in the staging folder runs until the digests pass, and it is removed afterwards.
  (`test/install-release.test.ts` "lays the release down with the modes its release.json records…", "lays down no
  ACL a signed archive carries…")
- **What a release loads.** The bundles resolve `bufferutil`, `utf-8-validate` and `supports-color`, which their
  dependencies only try for, to a module that throws. Node therefore never searches a folder above the release, such
  as a staging folder, `~/node_modules` or `/Applications/node_modules`, for code to run. The scan fails a bundle
  that requires any module the release does not carry. (`svalld/test/release.test.ts` "a release built by the build
  scripts"; `test/release-scan.test.ts`)
- **The archive scan.** `scripts/release-scan.mjs` fails a build on secrets, developer paths or checkout
  dependencies; see `docs/integration.md`.

## Secrets

The secrets: the daemon token, each worker's token, the phone key, the phone pass, the VAPID keys, the fleet `.env`,
the keys in your agent setup, agent logins and ssh keys.

| Channel | What keeps secrets out | Tests |
| --- | --- | --- |
| argv | A worker's token reaches `svall worker enroll` on stdin and travels in the link's hello. The daemon token travels in `connection-info`'s stdout and a WebSocket hello. `svall worker env` reads its value from stdin or a prompt that does not echo it. ssh carries none in its arguments. | `cli/test/controller/connection.test.ts` "connects a client through the forward without the token touching disk", "keeps the token out of the human reading" |
| Logs and events | The daemon's API never logs a token, its own or one a client offered. A host command's events are scrubbed of tokens. The units' logs sit in a 0700 folder. | `svalld/test/api.test.ts` "never writes the daemon token, or one a client offered, to its log"; `cli/test/host-add.test.ts` "never lets the companion token out in an event"; `linux-setup.test.ts` |
| A remote's URL | An origin that carries a token reaches the worker and the move's plan without it. | `svalld/test/placement/checks.test.ts` "an origin carrying a token reaches the worker and the plan without it; an ssh user and an scp-style remote stay" |
| Your agent setup | Logins never travel. Credential files and folders (`.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `.env*`, `*.pem`, `*.key`, Docker's `config.json`, gh's `hosts.yml`, `.aws`, `.ssh`, `.gnupg`) stay on the Mac, under a copied folder or behind a link. A key travels only once ticked for that machine, field by field; unticked, it arrives as the agent's reference to a variable, or emptied, and an untick empties it there at the next copy. A file there that holds a ticked key is the user's alone (0600). | `svalld/test/placement/mirror-plan.test.ts` "the common credential files and folders stay on the Mac, under a mirrored root or through a link into a dotfiles tree", "a link to a login file, and a key by any of its names, stays on the Mac; a link into plugins and to a plain file travels"; `svalld/test/placement/mirror.test.ts` "consent is per field: …", "a ticked field travels, an unticked one arrives emptied, and unticking later empties it on the next push", "a config file or plugin server file holding a ticked key is written for its owner alone" |
| The consent list | `mirror-consent.json` in the fleet home, at 0600, holds which fields are ticked for each machine, never a value; the rows show a key masked. `svall host remove` clears the machine's ticks. | `mirror.test.ts` "consent is per field: …" |

- **Credential files in a worktree.** An untracked file named like a credential (`.env*`, `*.pem`, `id_rsa*`,
  `*.tfvars`, `*.key`, `.netrc`) stays where it is unless ticked in the sheet; a tracked one that changed, or that a
  carried commit holds, refuses the move. A robot given its own worktree off a main checkout carries none of main's
  changes, so there only a carried commit holding one refuses. One that stays is left on that machine, as a worktree a move takes back is
  cleaned but for such files. One ticked travels, and stays on the destination when the robot leaves again.
  (`bundle.test.ts` "an unticked .env stays behind and is named; a ticked one travels; a tracked changed .env is
  reported by trackedCredentials"; `checks.test.ts` "check 6: …")
- **Keys a machine keeps.** What the mirror copied with a ticked key stays on the machine until it is unticked or
  `svall uninstall` runs there, which takes back each copy still as the mirror wrote it. `svall host remove --forget`
  leaves them there. (`mirror-apply.test.ts` "takeBackCopies empties each value the record holds as copied while it is
  still the copy, as an untick leaves it, and leaves a value the worker set itself")
- **Keys inside a carried transcript.** The conversation travels whole: anything the agent pasted or printed in it, a
  key included, is in the transcript on both machines.
- **The fleet's own `.env`** never travels. Each machine has its own; `svall worker env` sets a worker's, at 0600.

## Destructive operations

A move deletes none of the robot's work on the machine it leaves: its worktree stays there, locked. Every delete,
reset and kill a move, a worker or an install makes, with what authorises it:

| Site | What it removes or changes | Authorised by | Refusal tested by |
| --- | --- | --- | --- |
| The worktree the robot leaves (`placement/move-steps.ts`) | Nothing: it is locked with `git worktree lock`, reason `moved to <machine> <move id>` | The move's commit | `move.test.ts` "moves a dirty worktree robot: the worker holds the branch, the split state, the session; the source is locked and left as it was" |
| A main checkout converted (`placement/convert.ts`) | Main's staged, unstaged and untracked changes move to a new worktree `.claude/worktrees/<slug>` on a new branch, and main is reset to its HEAD and cleaned of what moved. The stash list is never touched. | The sheet's conversion, confirmed. Main is reset only while it and the new worktree both hold exactly what was carried, and never while a merge, cherry-pick, revert or rebase is under way or a file is marked assume-unchanged. A failure before the reset removes the worktree and its branch again. | `convert.test.ts` "refuses, touching nothing, while an assume-unchanged file or a merge in progress would be lost", "one that fails once its worktree is made takes the worktree and its branch away again, and main keeps every change", "a clean main with an older stash on the stack converts without touching the stash list" |
| A worktree a robot left, taken back (`takeBack`, `leaveAgain`) | Unlocked, `git reset --hard` to the commit it was left at and `git clean -f -d` but for files named like credentials, then the carried work applied. After an abort it is reset, cleaned and locked again. | Its branch's commit and its files' fingerprint equal what the move recorded when the robot left | `move.test.ts` "refuses a return when the Mac branch moved, and when the Mac worktree changed, with the exact sentences", "an abort the worker answers again holds the fingerprint of the worktree it left again, so the next move there passes its checks" |
| A prepare undone before the commit (`placement/prepare.ts`) | The worktree the move added (`git worktree remove --force`), a branch it made where none was, and the session files it wrote; a branch it moved goes back to its commit, and a main checkout it detached checks the branch out again | The destination's journal, which records each of these as it makes it | `move.test.ts` "a failure in prepare reopens the robot at home with its window and the worker has nothing left", "an abort after a worktree in the way leaves that worktree and its branch on the worker as they were" |
| `opencode session delete --standalone` at prepare (`sessions/opencode.ts`) | The destination OpenCode's copy of a carried session id | That id only, once its messages are a prefix of the incoming session's. The copy is kept until the import succeeds, and put back if it fails. | `move.test.ts` "a move refuses an OpenCode session the worker went on with since the robot came back, before anything moves, and its copy stays", "a return whose OpenCode import fails puts back the copy this Mac held, and keeps no other" |
| `tmux kill-window` at rest (`placement/rest.ts`) | The windows of the robot's terminals | Only terminals the recheck finds at rest, or whose job the choices let it end. A window still open after its kill stops the rest with that terminal live, never marked dormant. | `rest.test.ts` "refuses a foreground job nobody chose to end at the recheck, before it interrupts, signals or closes anything", "stops with the journal open and the slot live when a window is still open after its kill, laying only the ones closed before it dormant" |
| SIGTERM, then SIGKILL, at rest (`placement/rest.ts`) | A job in a robot's terminal | The choice that lets it end, for that terminal alone, journaled before the signal | `rest.test.ts` "ends a job only in the terminal the choice names, journaling it before the signal, and follows an ignored SIGTERM with SIGKILL" |
| SIGKILL of a private OpenCode server at rest (`placement/rest.ts`) | The process groups of the server's tree | Only the `serve --stdio` server a rested OpenCode started, never the user's `serve --service`, once it outlasts its closed window by the settle time; journaled first, and the rest fails if any of it survives | `rest-opencode.test.ts` "kills a private OpenCode server that outlasts its closed window by the settle time, with what it runs, journaled first, and sees them gone", "fails the rest when a private OpenCode server outlives its SIGKILL" |
| A robot closed on a worker (`worker/mutations.ts`) | Its window; its worktree is locked `closed robot <id>`, not removed | The close, made there or from the home | `svalld/test/worker/mutations.test.ts` "robot.close of a robot here kills its window, locks its worktree "closed robot <id>" and journals…" |
| `host add` and `host upgrade` enrol (`controller/host.ts`) | A `svall-gateway.service` unit an older release left: stopped, disabled and its file removed | Its name in the account's unit folder | `cli/test/host-add.test.ts` "add stops and removes a gateway unit it finds there, and enrols the fleet's unit as the worker"; `cli/test/host-upgrade.test.ts` "enrols nothing while the gateway unit there will not stop, and a run again makes the machine the worker" |
| Unreadable records set aside | `machines.json` is renamed to `machines.json.broken-<time>`, and a fresh one of this machine alone begins | The record failed to parse. Nothing is deleted, and every lookup that misses a machine names the copy. | `cli/test/controller/registry.test.ts` "moves a registry it cannot read aside and starts a fresh one", "says where a registry it could not read went…" |
| Release install and rollback (`scripts/install-release.mjs`) | The staging folder; a same-named release it replaces; `current`; once `current` has moved, every release but the new one and the one to go back to (the one `current` named before, or after a same-named reinstall the newest other) | A version name matching `[A-Za-z0-9._+-]+` that stays under `releases/`; `current` moves by an atomic rename; folders whose names start with `.` are left alone | `svalld/test/release.test.ts`; `test/install-release.test.ts` |
| Upload leftovers (`controller/install.ts`) | `~/.cache/svall/staging-<v>` and `companion-<v>.tar.gz` on the far machine | Paths built from the registry's home and the archive's one release name, which must be a name the installer takes (`[A-Za-z0-9._+-]+`, not `.` or `..`), each passed as one word | `install.test.ts` "refuses a release name no installer takes before anything is uploaded…" |
| `svall host remove` (remote `svall uninstall`) | What `svall uninstall` removes on the far machine, below | The registry record, a far machine that answers with its id, no robot of a fleet here on it or moving to it, and no fleet home there serving another Mac. It runs `svall uninstall` there with no flag, never `--purge`. | `host-remove.test.ts` "uninstalls nothing while a robot of a fleet here is on the machine or moving to it, and names them; --forget still drops the route", "remove runs svall uninstall there with no flag before it drops the registry entry…", "uninstalls nothing on a machine that answers as another than the registry names…", "uninstalls nothing on a machine where a fleet home serves another Mac…" |
| `svall uninstall` (`svalld/src/uninstall.ts`) | Units named `svall-svalld@*.service` and `svall-gateway.service`; plists with the Svall labels; `releases`, `current`, `companions` and `log` under the prefix, and `~/.cache/svall` on Linux; shims that point into a release or run a checkout; only Svall's hook entries; each key or file the mirror copied, while it is as the mirror wrote it | Each is recognised as Svall's by name, link target, content or the mirror's record of what it wrote. It refuses from a terminal inside a fleet's tmux server, which it stops. | `uninstall.test.ts` "on Linux removes only Svall units and the releases, and keeps the fleet", "leaves an svall on PATH that setup did not write", "removes only Svall entries…", "refuses from a terminal inside a fleet's…"; `mirror-apply.test.ts` "takeBackCopies removes a server copied whole, a plugin file holding a ticked key while each is still the copy…" |
| `svall uninstall --purge` | Fleet homes, the app, and macOS data under the app's ids | A folder counts as a fleet home only if it holds a `fleet.json` or `config.json`. Asked for or confirmed. | `uninstall.test.ts` "finds every fleet home, the app and what macOS keeps under the app id, and deletes only those" |

## Licences

- **Companion and controller archives.** Each carries `licenses/NOTICE`, naming every component with its version,
  licence and the file holding the licence text:
  - Svall;
  - the Node runtime, whose licence file covers what Node bundles;
  - each npm package esbuild bundled;
  - each package the phone page can bundle, which is the web app's production dependency closure;
  - the phone page's fonts (OFL) and art;
  - in a companion, its tmux (ISC) and the libevent (BSD-3-Clause), utf8proc (MIT) and ncurses (X11) linked into it.
- **When a package has no licence file.** The build stops at a bundled package that ships no licence file, unless
  `scripts/release/licenses/<name>-LICENSE` holds its upstream text. `http_ece`'s is kept there.
  (`svalld/test/release.test.ts` "stops the build at a bundled package that ships no licence file…", "a release built
  by the build scripts")
- **The app.** It carries `apps/desktop/mac/NOTICE` in `Contents/Resources/Licenses`, beside the licence texts
  `scripts/licenses.mjs` collects there, with `LICENSE.ghostty`, the GPL-3.0 text (`LICENSE.gpl-3.0`) and
  bash-preexec's MIT text (`LICENSE.bash-preexec`). The NOTICE names every
  component GhosttyKit links, and every one whose files the app copies from Ghostty's resources: the themes, Ghostty's
  bash and zsh shell integration (GPL-3.0-or-later, derived from Kitty's; the scripts are their own source) and
  bash-preexec. One test fails on any object file in the kit that no named component accounts for; another on any file
  under the copied resources that no named component accounts for, or whose header names a licence that component's
  line does not. (`test/app-notice.test.ts`)
- **Open items for the release:**
  - **GhosttyKit's own licence texts.** Only Ghostty's text ships. MIT, BSD and Apache-2.0 ask that a binary copy
    carry their text, and FreeType's FTL a credit line in the documentation; zlib, libpng and BSL-1.0 (utfcpp) ask
    nothing of a binary copy. The texts are best collected when the kit is built, from zig's package cache.
  - **libintl** (GNU gettext, LGPL-2.1-or-later) is linked statically. The LGPL asks that the app ship with the LGPL's
    text and libintl's source, or a written offer of it, and with what a recipient needs to relink the app against a
    changed libintl: the app's object files or source and the kit's build script. That has to reach whoever receives
    the app, whether or not the repository is public.
  - **The object check's generic names.** `app-notice.test.ts` attributes objects named `log`, `version`, `timer`,
    `print`, `st` or `empty` to the component that brings one today, so a new dependency with an object of such a name
    would be counted as that component.

## Service and file permissions

- **Units.** `svall-svalld@<fleet>.service` is a user unit that holds paths only. It runs as the user with
  `Restart=always`. The units' logs are in `~/.local/share/svall/log`, at 0700. (`linux-setup.test.ts` "keeps the
  units' logs in a folder only this account opens…")
- **Fleet home** 0700, made so at every daemon start. Its contents:
  - `token`, `mobile-key`, `mobile-pass`, `vapid.json` and `push.json` at 0600;
  - a worker's `worker.json` and `.env`, and the home's `workers.json` and `mirror-consent.json`, at 0600;
  - `hooks.sock` and a worker's `link.sock` at 0600;
  - tmux's socket, inside the 0700 home.

  (`daemon.test.ts` "keeps the fleet home, its keys and its hook socket to this account…"; `link.test.ts` "holds a
  token per machine, readable by its owner alone"; `push.test.ts`; `mobileControl.test.ts`)
- **Durable records** are written through a same-folder temp, fsynced and renamed, at 0600 unless named otherwise:
  - `state.json`, `fleet.json` and `node.json`; a change to an existing `fleet.json` keeps its mode and writes through
    a link to the file it names;
  - each move's journal on either machine, and a worker's outbox, its epoch and what the home acknowledged;
  - `worker.json`, `workers.json`, `mirror-consent.json` and the mirror's record of what it wrote;
  - the registry `machines.json`, `machine.json` and `checks.json` (folder 0700).
- **ssh control sockets** are in a folder the daemon and `svall` refuse unless it is the user's own at 0700.
  (`ssh.test.ts` "refuses a socket directory another user could reach")
- **Home length.** A Linux home over 89 bytes cannot hold the private fleet's hook socket under the 107 bytes a socket
  path takes, and `host add` stops at its `home` step with that cause. (`host-add-checks.test.ts` "add refuses a machine whose
  home makes the fleet socket too long, naming the listen EINVAL it would otherwise crash on")
- **Tailscale.** A move, `host add` and `host upgrade` add no `tailscale serve` or `funnel` mapping.

## What uninstall keeps and deletes

| | `svall host remove <name>` (runs `svall uninstall` there) | `svall uninstall` | `svall uninstall --purge` |
| --- | --- | --- | --- |
| Svall's hooks in Claude's settings and Codex's hooks file, and Svall's OpenCode plugin (on Linux also under the login shell's `XDG_CONFIG_HOME`) | removed | removed | removed |
| Keys and files the mirror copied with a tick, while each is as it wrote it | taken back | taken back | taken back |
| Phone links that proxy to a fleet's key | turned off | turned off | turned off |
| systemd units / launchd agents | stopped and removed | stopped and removed | stopped and removed |
| Every fleet's tmux server, and the robots in it | stopped | stopped | stopped |
| `releases/`, `current`, `companions/`, `log/`, the shims, and on Linux `~/.cache/svall` | removed | removed | removed |
| Fleet homes: state, `fleet.json`, `node.json`, journals, `worker.json`, `.env`, `mirror-overrides/`, keys | kept | kept | deleted |
| The clones robots worked in on a worker | kept | kept | kept |
| `machine.json`, and on the Mac `machines.json` and `checks.json` | kept | kept | kept |
| The app and macOS data under its ids | n/a | kept | deleted |
| This Mac's registry entry for the machine, its last check and its ticks | dropped once the far uninstall succeeds, or with `--forget` | n/a | n/a |

`svall uninstall` on the Mac leaves every worker as it is: its Svall, its fleets and the robots running there.

## Agent versions

- **The range.** A session adapter has a minimum and no maximum: Claude Code 2.1.251, Codex 0.156.0, OpenCode 2.0.22.
  A move copies Claude Code's and Codex's session files byte for byte, so it depends only on where each CLI keeps a
  session and on its resume command; for OpenCode, on `session export`, `session import --directory`, the
  `Imported session: <id>` line that import prints, and `-s`. The destination's release of the robot's agent must be
  at least the source's, since an older one may not read what a newer one wrote.
- **What a new release can break.** A release that moves a session's files, or changes `--resume` or `resume`, fails
  to resume on the destination: the robot shows the error on its card with **Retry**, its transcript kept. An
  OpenCode release that changes its export or import fails the move before its commit, and the robot reopens where it
  was.
- **For each new Claude Code, Codex or OpenCode release:** record a fixture from it under
  `packages/svalld/test/fixtures/sessions/<agent>/<version>`, run `pnpm compat`, which checks the newest release's
  session layout, hooks and flags, and raise the adapter's minimum only when an older release stops working. Until
  then the release is untested with moves, not refused.

## Limits

| What | Bound | Test |
| --- | --- | --- |
| What a move carries | 100 MB: the patches, untracked files and carried commits, refused before anything is hashed or packed and again once packed | `bundle.test.ts` "refuses past BUNDLE_MAX with the size" |
| The agent setup copied | A file over 5 MB or a tree over 200 MB is left out, each with a line | `mirror-plan.test.ts` "a file over 5 MB and a tree over 200 MB are left out, each with a line" |
| The link | A JSON line of at most 2 MiB; a reply over 1 MiB in 768 KiB parts; a file in 1 MiB parts, checked by sha256 | `svalld/test/link/stream.test.ts` "replies whole up to 1 MiB of JSON, in parts past it, on lines of at most 2 MiB", "carries a 3 MiB blob in 1 MiB parts and verifies its sha256 on arrival" |
| Robots a worker starts while this Mac is away | Five, until it answers again | `svalld/test/worker/mutations.test.ts` "a cwd outside the clones is refused with its path; mission control is refused; the sixth create since the last ack is refused with the quota sentence" |
| A terminal viewer on the daemon's socket | No more output once 1 MB waits unsent on its socket, then the screen afresh once 250 kB or less waits | `svalld/test/terminals.test.ts` "sends a viewer no more output once a megabyte waits unsent…", "lets a viewer that fell behind back in once a quarter of a megabyte or less waits…" |
| A far command's output | 1 MiB | `cli/test/controller/ssh.test.ts` "bounds how much output it keeps" |

- **More than ten sessions on one worker** go past sshd's default `MaxSessions 10` on the daemon's master: the link's
  stream, each terminal and each file read share it. Each session past the tenth prints one "Session open refused by
  peer" line and opens its own login to the machine's ssh destination. That login runs with `BatchMode=yes`, as the
  master does, so it asks for nothing and logs in only with the keys ssh can use without a prompt; with none, ssh
  quits at once and the terminal shows "ssh quit as soon as it started".
- **The app's terminals** attach with `ssh -tt … tmux attach`, so a link slower than the terminal backs up into tmux,
  which stops drawing to a client that falls behind and redraws it once it catches up. Nothing passes through the
  daemon.

## Accepted risks

- **The link hands a worker its token before the worker names itself.** An ssh destination that now reaches another
  of the user's machines gets that token, and the home closes the link once the machine there answers as another.
  Only the user can read it there.
- **A program in a robot's pane on a worker can set the Mac's clipboard.** The worker's tmux passes a pane's OSC 52 on
  to the Mac's terminal (`set-clipboard on`), as Claude Code copies its own selection that way, and Ghostty writes it
  under the user's `clipboard-write`, `allow` unless their config says otherwise, as over a plain ssh. Each copy also
  stays one of tmux's paste buffers there, at most 50, while the server runs.
- **A worker can drive the home.** The link passes on any change a `svall` on the worker asks for, so a process
  running as the user there can do on the Mac what the API lets it. Both accounts are the user's.
- **Another account can squat the daemon's lock name on Linux.** The lock is an abstract socket named from the home's
  real path, so another account can bind it first and hold the daemon in a restart loop. Mixing a 0600 key from the
  fleet home into the name would stop it. It needs a second account on the machine, and it only keeps the daemon from
  starting, reading and changing nothing.
- **A far machine with no release of its own to pin a signer**, a first install or a release built before the first
  signing key, unpacks the upload before any check of its own. It rests on the controller's check against its own
  pinned signers, made before the upload and before the controller unpacked anything, and the `install` step says so.
- **The phone page's package list is the web app's whole production closure**, not only what Vite inlined. Listing
  more than was bundled is harmless in a NOTICE; a list from the Vite build would need `dist-mobile` rebuilt before
  every release build.
- **The hardware tie of `machine.json` fails open**: where the hardware id cannot be read (no `ioreg` answer, neither
  `/etc/machine-id` nor `/var/lib/dbus/machine-id`), the daemon takes the file's id unchecked, as the tie is there to
  catch a copy a backup restore or Migration Assistant made by mistake.
- **`svall setup` replaces `~/.local/bin/svall`** whatever it was. It is setup's own name.
- **An upgrade restarts a fleet daemon the user disabled but whose unit file remains.** A rollback must not leave a
  failed daemon down, so it restarts every fleet's unit.
- **An install can remove a release a process still runs from.** Each install keeps only the new release and the one
  to go back to. A daemon left running by `--no-launchctl`, or a long-lived `svall`, started from an older release
  loses its files. Setup restarts the daemons it moves.
