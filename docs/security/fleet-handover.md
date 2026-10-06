# Fleet handover: security and limits

What a fleet handover trusts, what it refuses, what it deletes and on whose authority, what a release carries and
under which licences, and which risks are accepted. Tests are named by file under `packages/` or `test/`.

## Trust model

- **Trusted:** the user's account on both machines, their ssh configuration and keys, and their tailnet. A process
  running as that user can read and write everything a handover can, so it is not defended against.
- **Not trusted:**
  - other accounts on either machine;
  - a companion archive until it is authenticated;
  - the content of carried folders, including file names and links;
  - any machine an ssh destination reaches until it answers with the registry's machine id.
- **Nothing listens past loopback.**
  - The daemon API binds `node.json`'s `host`, `127.0.0.1` unless the user sets another.
  - A remote daemon is reached through `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>`.
  - The gateway authority, the handover helper and the hook receiver are Unix sockets at 0600 in 0700 folders.
  - The phone link is the only thing served past loopback: `tailscale serve`, and only when the user turns it on.
    A handover never turns it on, on either machine.

## Threat model

| Threat | What stops it | Tests |
| --- | --- | --- |
| An ssh destination read as an option, such as `-oProxyCommand=…` | The registry holds a destination to `[A-Za-z0-9][A-Za-z0-9._@:[\]-]*`, and every ssh argv puts `--` before it. | `protocol/test/handover.test.ts` "refuses an ssh destination a command would read as an option"; `cli/test/controller/ssh.test.ts` "carries a hostile destination as one argument after the option terminator"; `cli/test/controller/rsync.test.ts` |
| A user or host name that a `ProxyCommand`'s `%r` or `%h` hands a shell (CVE-2023-51385) | The same pattern allows no shell metacharacter. | `protocol/test/handover.test.ts` "refuses a user or host name a ProxyCommand's %r or %h would hand a shell to expand" |
| An alias that now reaches another machine | A daemon is used only once `connection-info` answers with the registry's machine id and the fleet's id. The gateway is asked nothing until `svall version --json` there names its registry id: once per master from the controller, and in the same ssh as each question from a daemon; preflight blocks with `identity_mismatch` otherwise. Both read the id past anything the far login shell prints, with one parser, and both take an `svall` that answers without naming a machine for another machine. `host upgrade`, `host remove` and `host enable` first ask `svall version --json` and stop on another machine id; `host enable` then makes the record and the fleet's copy over that one master. Every command on a master names the host `svall-remote.invalid`, so one whose master has died fails rather than opening a connection no check covered. The app's terminals attach through the helper's master only while it answers on its socket, with `ControlMaster=no` and `BatchMode=yes`; while it does not, a terminal waits for the helper to report the fleet online again. Only a master that dies in the tens of milliseconds between that check and the attach leaves ssh to log in on its own, which it does without a prompt, as for terminals past `MaxSessions` (see Limits). | `cli/test/controller/connection.test.ts`; `cli/test/host.test.ts` "uninstalls nothing…", "uploads and installs nothing…", "asks for and makes no ownership record on a machine that answers as another…", "makes the record and the copy of the fleet over the one master whose machine it checked"; `cli/test/controller/ssh.test.ts` "never lets a command fall back to a connection of its own once its master has gone"; `cli/test/controller/handover.test.ts` "asks a far gateway nothing once its ssh destination answers as another machine", "blocks at once on a gateway whose ssh destination now reaches another machine"; `connection.test.ts` "never takes the word of a gateway whose ssh destination now reaches another machine", "reads which machine a gateway is past whatever its login shell prints first", "takes no ownership answer from a gateway whose svall answers without naming its machine"; `host.test.ts` "reads which machine answers past whatever its login shell prints first, and makes no record on another"; `apps/desktop/mac/Tests/SvallTests/AttachCommandTests.swift` `testNoCommandIsBuiltWhileTheMasterDoesNotAnswer`, `testAMasterAnswersOnlyWhileSomethingListensOnItsSocket`; `svalld/test/gateway/server.test.ts` "refuses the answer of a machine the gateway's ssh route now reaches in its place", "refuses an answer whose svall names no machine, as the controller does"; `source.test.ts` "blocks with identity_mismatch when the route to its gateway now reaches another machine" |
| A remote argument split or expanded by the far login shell | Every word that is not a literal flag goes through `shq` (`svalld/src/text.ts`), which the daemon's gateway query uses too. Scripts run as `sh -c '<literal>' <name> <args…>`. rsync gets `-s` (protected arguments) and escapes `*?[` in far paths. | `cli/test/controller/install.test.ts` "streams the archive into a path the far shell never splits", "hands the far check…as words of their own"; `cli/test/controller/transfer.test.ts` "refuses a far path rsync would expand…" |
| RSYNC_* settings turning argument protection off | `runRsync` drops every `RSYNC_*` variable, and openrsync or an rsync before 3.2.3 is refused. | `cli/test/controller/rsync.test.ts`; `transfer.test.ts` "refuses a far rsync that is missing, too old or openrsync…" |
| Hostile file names: a leading `-`, spaces, unicode | rsync takes names from its own file list, never argv; roots are absolute paths after `--`. | `transfer.test.ts` "mirrors a root with spaces, unicode and hostile names…", "mirrors a hostile tree to the Linux rsync and back…" |
| A newline or control character, non-UTF-8 | Preflight blocks the name (`path_unsupported`) and carries none of it, as rsync's output is read a line at a time. | `svalld/test/handover/manifest.test.ts` "blocks a file name with a control character…", "blocks a name that is not UTF-8…", "blocks a link whose text holds a control character…" |
| Names that differ only by case or by Unicode normalization | The destination reports whether each landing folder folds case; the controller blocks a collision (`path_collision`), folding NFC and NFD forms together as APFS does. | `svalld/test/handover/probe.test.ts` "names the paths that differ only by case", "names the paths that differ only by Unicode normalization…"; `cli/test/controller/handover.test.ts` |
| A character folder reached through a symlink, or named in another case than the disk spells it | A root travels at its real path, spelled as the disk spells it; a recorded path that is not real blocks (`path_symlinked`), at preflight and again at freeze. The destination blocks a root it reaches through a link or spells another way. | `inventory.test.ts` "blocks a graph root reached through a link…", "blocks a folder named in another case than the disk spells it…"; `source.test.ts` "refuses a cwd the fence finds reached through a link…"; `destination.test.ts` "names a root the disk here spells in another case, as a Mac finds it" |
| A link inside a root, or one pointing out of it | Carried as a link (`-l`), never followed. A link that dangles on the destination is reported (`symlink_dangling`). | `manifest.test.ts` "lists each carried file once…and a link as its text"; `destination.test.ts` |
| A manifest path that climbs out of its root, or a session file out of its agent home | Refused before a path is built from it. | `replicas.test.ts` "refuses manifest paths that could leave their root"; `transfer.test.ts` "refuses a session file whose name climbs out of its agent home…" |
| A root that holds a fleet home, whose token, keys and journal stay on their machine | Blocked on both machines, by lexical and real path. | `inventory.test.ts` "blocks a root that holds or lies in either fleet home…"; `replicas.test.ts` "refuses a root that reaches the fleet home through a symlink or holds it…" |
| A root that holds an agent's login or config, the ssh folder, or Svall's own install | Blocked on both machines: `.credentials.json`, `.claude.json`, Codex's `auth.json`, both where `CLAUDE_CONFIG_DIR` and `CODEX_HOME` put them and in the default homes; OpenCode's data, config, state and cache folders whole, which hold its database and login, in the default places and where each machine's `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` put them; `~/.ssh`; `~/.local/share/svall` (releases and the gateway's records), `~/.config/svall` (the machine id and registry), `~/.config/systemd/user` and the `svall` shims. The source checks by real path on its own disk; the destination checks its own by real path when it claims or archives a root. | `inventory.test.ts` "blocks a root that holds an agent's credentials or config…", "blocks the default agent homes beside the configured ones, and Svall's own install…", "blocks a root that holds or lies in OpenCode's data, config, state or cache folder…"; `source.test.ts` "blocks a character working in the folder this daemon's Claude keeps its login in…", "blocks a character working in this daemon's OpenCode data folder…"; `destination.test.ts` "refuses a claim of a root in this machine's OpenCode state folder…"; `replicas.test.ts` "refuses, by real path on this machine, a root that holds or lies in its ssh folder, an agent login or its Svall install" |
| A stale authority record | The gateway swaps only on the expected generation and owner. A reachable gateway's record wins over a daemon's cached one: a starting daemon waits up to 10 s for it, asking again while the gateway on its own machine is not yet listening. A frozen or surrendered source starts read-only. A prepare or activation for another generation, transaction or manifest is refused. | `svalld/test/gateway/authority.test.ts`; `svalld/test/ownership.test.ts`; `svalld/test/handover/service.test.ts` "asks the gateway on this machine again until it listens, and takes its record"; `destination.test.ts` "refuses a prepare meant for another machine, fleet, generation, transaction or manifest…", "waits for the gateway to commit this handover at the next generation…" |
| An OpenCode session revived as an empty one, or over a copy the destination went on with | The destination exports any copy of the id its OpenCode holds and blocks (`destination_diverged`) unless that copy's messages are a prefix of the incoming ones; it imports with `--directory` set to the terminal's folder and refuses to prepare unless the import names the id, since `-s` on an id OpenCode lacks starts an empty session. The CLI runs with `--standalone`, never the user's shared service, and without `SVALL_CHAR_ID` or `SVALL_TERM`, so Svall's plugin does not take the run for a character's. | `destination.test.ts` "refuses to prepare while OpenCode has not imported the session…"; `sessions.test.ts` "refuses to replace a copy this machine went on with outside Svall, and keeps it", "refuses an import OpenCode answers with…", "hands a session to another machine and back…" |
| Destination path confusion | Both machines must share the home path (`home_mismatch`). A root lands only at the real path its claim checked, and never over a folder no handover left there (`destination_occupied`). | `inventory.test.ts`; `source.test.ts` "blocks a destination whose home is not this machine's…"; `replicas.test.ts` |

## Release integrity

- **Signing.** A release's `SHA256SUMS` covers every file, `release.json` included, and is signed with
  `ssh-keygen -Y sign` under the `svall-release` namespace. `release.json` describes every entry in both
  directions. The release workflow hands the key only to the steps that check it, sign and publish, never to the
  build; see `docs/integration.md`. (`test/release-stage.test.ts` "hands the signing key only to the steps that check
  it and sign…", "%s runs every action at a commit, never at a tag that can move")
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

  (`cli/test/host.test.ts` "checks the new release against the signers the installed release pins…", "holds a repeat
  host add over an installed release to the signers that release pins…", "says when a machine has no release installed
  to pin a signer…", "refuses a release the installed release's signers do not vouch for, before anything it carries
  runs", "checks the signature over an upgrade's SHA256SUMS before it unpacks anything else the archive holds",
  "refuses a release the pinned key signed that arrives under another release's name…", "refuses an archive that gives
  the far check one SHA256SUMS to verify and another to check the files by…", "checks with the system's own
  tools, whatever a relative entry in the far PATH finds in the upload first", "refuses a release when the installed
  release has lost its signers file…", "says when the installed release pins no signer…", "checks an unsigned release
  with --allow-unsigned by its digests alone…"). The Mac's bsdtar matches every spelling of a name and refuses to
  write under a link, so the far check also runs under GNU tar in a Linux image: `SVALL_TEST_GNU_TAR=svall-it:machine`
  with `DOCKER_HOST` naming the engine's socket runs `host.test.ts` "checks the files against the SHA256SUMS the pinned
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

The secrets: the daemon token, the phone key, the VAPID keys, the fleet `.env`, agent logins and ssh keys.

| Channel | What keeps secrets out | Tests |
| --- | --- | --- |
| argv | The token travels in `connection-info`'s stdout and a WebSocket hello, never in argv. rsync and ssh carry paths only. | `connection.test.ts`, `connect.test.ts` (ssh argv never holds the token) |
| Logs | The daemon's API never logs a token, its own or one a client offered. The helper's log and output are scrubbed of every token held. The units' logs sit in a 0700 folder. | `svalld/test/api.test.ts` "never writes the daemon token, or one a client offered, to its log"; `cli/test/handover.test.ts`; `linux-setup.test.ts` |
| NDJSON events | Each event is scrubbed before it is written, sent or kept. | `host.test.ts` (host add and upgrade events); `cli/test/handover.test.ts`; `cli/test/controller/handover.test.ts`; `connect.test.ts` |
| State and journals | The controller journal, progress journal and route cache hold ids, paths and digests. A failure recorded there is scrubbed of tokens and of the values in carried `.env` files. | `cli/test/controller/handover.test.ts`; `transfer.test.ts` "keeps tokens and .env values out of everything it records"; `connect.test.ts` |
| Manifests | A manifest names files by hash, never content. No fleet key is a root, and a carried `.env`, repository or fleet, appears only as its digest. | `manifest.test.ts` "holds no fleet key, and no secret a carried .env holds…" |
| Repository roots | Replica records, filter files and progress live under the fleet home or the controller's state folder, never in a root. A root holding a fleet home, an agent login or `~/.ssh` is blocked. | `replicas.test.ts` "keeps each record under the fleet home…"; `inventory.test.ts` |

- **Repository `.env` files** are working-tree data and travel, with a warning. The fleet's own `.env` travels only
  with `handover.transferFleetEnv`, with a warning.
- **Other tools' plaintext logins** in a carried folder (`.netrc`, `.git-credentials`, gh's `hosts.yml`, AWS's
  `credentials`, Docker's `config.json`) travel with a `credential_file` warning. Agent logins and `~/.ssh` never
  travel. (`manifest.test.ts` "warns that the logins other tools keep in plain text travel with a folder that holds
  them")

## Destructive operations

Every delete, rename and archive a handover or its install makes, with the record that authorises it.

| Site | What it removes or moves | Authorised by | Refusal tested by |
| --- | --- | --- | --- |
| `rsync --delete` (`controller/transfer.ts`) | Files in a destination root the source no longer has | An ok claim from the destination's replica store: absent and reserved by this transaction, this transaction's own partial copy (holding only what its claim knew there, brought, its own Git import wrote, or its transfer verified there, as the controller's progress journal kept it), or a replica proven to hold only what a handover left, where a copy another handover was let go with may also hold what this one brings. Folders the claim keeps and excluded paths are spared. rsync runs on the controller, which has to be one end of the copy: a resume or abort from a machine that is neither source nor destination stops before anything is copied. | `handover.test.ts` "resumed or aborted from a machine that is neither source nor destination…", "never runs a transfer whose parties are both reached over ssh…"; `transfer.test.ts` "writes a root only where its claim says…", "never writes a root the destination did not claim…", "leaves a folder the claim keeps as the far side has it…"; `replicas.test.ts` "is refused when no handover left it there…", "blocks, and is left as it was, when it changed…", "is taken over by a later transaction that brings a file the aborted copy wrote there…"; `destination.test.ts` "…and not an edit made here", "takes as its own only what a prepare that proved what landed recorded, never an edit made here since"; `svalld/test/handover/faults.test.ts` "refuses ada again, for … made in its copy after the transfer verified it…" (an edit, a removal or an added file) |
| Archiving a root (`ReplicaStore.archive`) | Renames a diverged or occupied root to a timestamped sibling | A choice that names the root, and a root that neither holds nor lies in the fleet home, the ssh folder or Svall's install, and holds no agent login, each by real path. The sibling is made exclusively and never replaces anything. | `replicas.test.ts` "moves a root aside only when the choice names it…", "never replaces a sibling that holds the name already…", "refuses to move the fleet home or anything holding it"; `destination.test.ts` "…archives it aside only when asked to" |
| Worktree registrations (`handover/git-import.ts`) | `<common dir>/worktrees/<id>` entries the manifest does not carry, except one whose worktree folder is on the destination; branch refs stay | The manifest's graph, in a root this transaction claimed. The folder must be a real one, and no git refusal may stand. | `git-import.test.ts` "removes each registration the manifest leaves out…", "keeps a worktree no character uses registered on the machine it stays on…", "refuses a worktrees folder carried as a link…", "turns a git that refuses into a blocker…and removes no registration" |
| Session stages, prepared state, seals (`handover/destination.ts`) | `handover/{sessions,prepared,seal}-<tx>` in the fleet home | The destination journal's transaction id, or the claimed transaction's, encoded to one path segment, after the gateway let the handover go or it completed. Each root prepare recorded is sealed first, as its Git import left it; a root prepare never read stays receiving. A root that cannot be sealed keeps the record and the journal for another try, unless a forced gateway record supersedes the handover, which leaves that root receiving. | `destination.test.ts` "drops the session stage of a handover it never prepared…and nothing else", "keeps the session stage of a handover it never prepared while the gateway cannot say it let go…", "discards what it prepared once the gateway no longer holds the handover, and not before", "leaves each root it claimed receiving once the handover is let go before prepare…", "keeps its journal and what it would seal when a root cannot be sealed as it lets go…", "lets its handover go for a record naming another machine even when a root cannot be sealed" |
| A kept manifest (`handover/source.ts`) | `handover/manifest-<tx>.json` | The source journal's transaction | `source.test.ts` "…replacing a manifest no journal names" |
| Controller journal and transaction folder (`controller/recovery.ts`) | `controller/handover.json`, `controller/handover/<tx>` | The journal's own transaction id, encoded to one path segment, `.` and `..` included | `recovery.test.ts` "keeps each transaction's folder one name under its own, so clearing a transaction named . or .. removes nothing else" |
| Unreadable records set aside | A daemon journal, gateway record, owner cache, registry or controller journal is renamed to `*.broken-*` | The record failed to parse. Nothing is deleted, and a quarantined gateway record refuses its fleet until repaired. | `journal.test.ts`; `gateway/authority.test.ts` "quarantines a record it cannot read…"; `ownership.test.ts` |
| A far fleet copy re-keyed (`linux/provision.ts`) | The copy's `owner.json` | Only a home `host add` made that has never run a fleet; one in use is refused | `linux-provision.test.ts` "refuses a home whose fleet has been used…and changes nothing" |
| Seeded folders at a re-key (`linux/provision.ts`) | The copy's mission control folder (`home.cwd`) and `agent-profiles` | The same re-key, and a folder that holds exactly what this release's seed writes, name for name and byte for byte; a mission control folder another fleet home on the machine names is kept | `linux-provision.test.ts` "drops the mission control folder and agent profiles a standalone start seeded, and keeps each once anything in it has changed", "keeps a seeded mission control folder that another fleet home on the machine names as its own" |
| Upload leftovers (`controller/install.ts`) | `~/.cache/svall/staging-<v>` and `companion-<v>.tar.gz` on the far machine | Paths built from the registry's home and the archive's one release name, which must be a name the installer takes (`[A-Za-z0-9._+-]+`, not `.` or `..`), each passed as one word | `install.test.ts` "refuses a release name no installer takes before anything is uploaded…" |
| Session files on the destination (`handover/sessions/registry.ts`) | Files in the destination's agent home | Each path lies in the agent home and is one of that session's own files. An existing file is replaced only by one it is a strict prefix of, or left when equal; a session the destination continued is refused. | `sessions.test.ts` "refuses a copy the destination continued on its own, and writes nothing", "refuses a manifest that names a file outside the agent home" |
| `opencode session delete` at prepare (`handover/sessions/opencode.ts`) | The destination OpenCode's copy of a carried session id | That id only, from the manifest, after this machine's export of it proved its messages a prefix of the incoming export's; a copy it went on with is refused (`destination_diverged`) | `destination.test.ts` "imports an OpenCode session into this machine's OpenCode…over the copy an earlier handover left…"; `sessions.test.ts` "refuses to replace a copy this machine went on with outside Svall, and keeps it", "hands a session to another machine and back…" |
| Activation's `fleet.json` and `state.json` (`handover/destination.ts`, `Store.promote`) | Replaces both with the prepared ones | The gateway's commit of this transaction, at the next generation, over the prepared digest this machine holds | `destination.test.ts` "waits for the gateway to commit this handover at the next generation before it touches anything" |
| `tmux kill-window` at rest (`handover/rest.ts`) | The windows of the fleet's terminals | Only terminals the recheck finds at rest, or whose job the choices let it end. A window still open after its kill stops the rest with that terminal live, never marked dormant | `rest.test.ts` "refuses a foreground job nobody chose to end at the recheck, before it interrupts, signals or closes anything", "stops with the journal open and the slot live when a window is still open after its kill…" |
| SIGKILL of a private OpenCode server at rest (`handover/rest.ts`) | The process groups of the server's tree | Only the `serve --stdio` server a rested OpenCode TUI started, never the user's `serve --service`, once it outlasts its closed window by the settle time; journaled as terminated first, and the rest fails if any of it survives | `rest.test.ts` "kills a private OpenCode server that outlasts its closed window…", "fails the rest when a private OpenCode server outlives its SIGKILL"; `processes.test.ts` "neither waits on nor reaches the user's shared service…" |
| `tmux kill-window` at activation (`handover/destination.ts`) | A terminal's window whose agent did not come up | The window the terminal's own record names; one whose agent started since is kept | `destination.test.ts` "judges each window a dead daemon left by its pane…, never closing an agent started since" |
| `svall fleet recover --force-owner` (`commands/fleet-recover.ts`) | Replaces the gateway's ownership record | The fleet id typed back exactly, or `--confirm` naming it, and a swap against the record shown | `fleet-recover.test.ts` "writes nothing when the fleet id typed is not exactly this fleet's…", "writes nothing when the gateway's record changes while the user reads it" |
| Release install and rollback (`scripts/install-release.mjs`) | The staging folder; a same-named release it replaces; `current`; once `current` has moved, every release but the new one and the one to go back to (the one `current` named before, or after a same-named reinstall the newest other) | A version name matching `[A-Za-z0-9._+-]+` that stays under `releases/`; `current` moves by an atomic rename; folders whose names start with `.` are left alone | `svalld/test/release.test.ts`; `test/install-release.test.ts` |
| `svall host remove` (remote `svall uninstall`) | Everything setup added on the far machine, below | The registry record, and a far machine that answers with its id. It never runs while a handover holds any fleet here open, whatever its gateway, while a fleet naming this gateway is owned elsewhere, while the machine owns a fleet through any gateway, or with `--purge`. Having checked that, it runs `svall uninstall` there with `--force-fleet` for each fleet naming that gateway, which passes only those fleets' records; the far machine still refuses for anything else it would strand, and the step fails with that reason. | `host.test.ts` "uninstalls nothing on a machine that answers as another…", "refuses to strand a fleet another machine owns…", "refuses to uninstall a machine that owns a fleet through another gateway…", "refuses while a handover through another gateway holds a fleet open…", "forces the far uninstall past the gateway records of only the fleets it checked…", "reports the far refusal, with its reason, of what this Mac cannot see…" |
| `svall uninstall` (`svalld/src/uninstall.ts`) | Units named `svall-svalld@*.service` and `svall-gateway.service`; plists with the Svall labels; `releases`, `current`, `companions` and `log` under the prefix; shims that point into a release or run a checkout; only Svall's hook entries | Each is recognised as Svall's by name, link target or content. Unless `--force`, it refuses while a fleet home holds a handover journal, while this machine runs a fleet for its gateway, or while the prefix holds a gateway's fleet records; `--force-fleet <id>` passes only that fleet's record | `uninstall.test.ts` "on Linux removes only Svall units and the releases, and keeps the fleet", "leaves an svall on PATH that setup did not write", "removes only Svall entries…", "refuses, unless forced, while a handover is open…", "lets go only of the gateway records of the fleets it is told to…" |
| `svall uninstall --purge` | Fleet homes, the app, and macOS data under the app's ids | A folder counts as a fleet home only if it holds a `fleet.json` or `config.json`. Asked for or confirmed. | `uninstall.test.ts` "finds every fleet home…and deletes only those", "leaves a folder of yours that is only named like a fleet…" |

## Licences

- **Companion and controller archives.** Each carries `licenses/NOTICE`, naming every component with its version,
  licence and the file holding the licence text:
  - Svall;
  - the Node runtime, whose licence file covers what Node bundles;
  - each npm package esbuild bundled;
  - each package the phone page can bundle, which is the web app's production dependency closure;
  - the phone page's fonts (OFL) and art.
- **When a package has no licence file.** The build stops at a bundled package that ships no licence file, unless
  `scripts/release/licenses/<name>-LICENSE` holds its upstream text. `http_ece`'s is kept there.
  (`svalld/test/release.test.ts` "stops the build at a bundled package that ships no licence file…", "a release built
  by the build scripts")
- **rsync (GPL-3.0-or-later).** The controller archive carries rsync's source tarball, the pinned one, beside its
  licence. The NOTICE line names the configure flags and the `strip -S`. (`release.test.ts` "carries the source of the
  rsync it ships…")
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
  - **Flaticon art.** The animal portraits and the lighthouse are Flaticon Premium icons whose licence does not allow
    redistributing the files (`web-mobile/animals/LICENSE`, `resources/LICENSE`). The companion archive, which is
    published, carries them as files. So does the app.
  - **The object check's generic names.** `app-notice.test.ts` attributes objects named `log`, `version`, `timer`,
    `print`, `st` or `empty` to the component that brings one today, so a new dependency with an object of such a name
    would be counted as that component.

## Service and file permissions

- **Units.** `svall-svalld@<fleet>.service` and `svall-gateway.service` are user units that hold paths
  only. They run as the user with `Restart=always`. Their logs are in `~/.local/share/svall/log`, at 0700.
  (`linux-setup.test.ts` "keeps the units' logs in a folder only this account opens…")
- **Fleet home** 0700, made so at every daemon start. Its contents:
  - `token`, `mobile-key`, `vapid.json` and `push.json` at 0600;
  - `hooks.sock` at 0600;
  - tmux's socket, inside the 0700 home.

  (`daemon.test.ts` "keeps the fleet home, its keys and its hook socket to this account…"; `push.test.ts`;
  `mobileControl.test.ts`)
- **Durable records** are written through a same-folder temp, fsynced and renamed, at 0600 unless named otherwise:
  - ownership (`owner.json`) and the daemon journal;
  - replica records, prepared state, seals and manifests;
  - `fleet.json` and `node.json`; a change to an existing `fleet.json` keeps its mode and writes through a link to
    the file it names;
  - the gateway's records (folder 0700);
  - the controller's journal and progress (folder 0700);
  - the registry `machines.json` and `machine.json` (folder 0700).

  (`ownership.test.ts`, `journal.test.ts`, `replicas.test.ts`, `destination.test.ts`, `manifest.test.ts`,
  `config-migration.test.ts`, `gateway/authority.test.ts`, `recovery.test.ts`, `registry.test.ts`, `machine.test.ts`)
- **Sockets.**
  - The gateway authority: 0600 in a 0700 folder (`gateway/server.test.ts`).
  - The handover helper: 0600, with its events at 0600 (`cli/test/handover.test.ts`).
  - ssh control sockets: in a folder the controller refuses unless it is the user's own at 0700 (`ssh.test.ts`
    "refuses a socket directory another user could reach").
- **Home length.** A Linux home over 65 bytes cannot hold the gateway's socket, which is 42 bytes past it, under the
  107 bytes a socket path takes. `host add` stops at its `home` step with that cause. On a machine already set up,
  `doctor` names the `listen EINVAL` of a gateway that keeps restarting. (`host.test.ts` "stops at a home too long for
  the gateway's socket…"; `doctor.test.ts`)
- **Tailscale.** A handover and its install add no `tailscale serve` or `funnel` mapping. The fleet's
  `mobile.logins` travel in `fleet.json`, and a phone link on the destination starts only when the user turns it on
  there.

## What uninstall keeps and deletes

| | `svall host remove <name>` (runs `svall uninstall --force-fleet <id>…` there) | `svall uninstall` | `svall uninstall --purge` |
| --- | --- | --- | --- |
| Svall's hooks in Claude's settings and Codex's hooks file, and Svall's OpenCode plugin (on Linux also under the login shell's `XDG_CONFIG_HOME`) | removed | removed | removed |
| Phone links that proxy to a fleet's key | turned off | turned off | turned off |
| systemd units / launchd agents | stopped and removed | stopped and removed | stopped and removed |
| Every fleet's tmux server | stopped | stopped | stopped |
| `releases/`, `current`, `companions/`, `log/`, and the shims | removed | removed | removed |
| Fleet homes: state, `fleet.json`, `node.json`, ownership, journals, replica records, keys | kept | kept | deleted |
| The gateway's ownership records (`<prefix>/gateway`) | kept | kept | kept |
| `machine.json` and the controller's `machines.json` | kept | kept | kept |
| The app and macOS data under its ids | n/a | kept | deleted |
| The controller's registry entry for the machine | dropped once the far uninstall succeeds, or with `--forget` | n/a | n/a |

The gateway's records outlive a purge, so a fleet handed back from a backup still finds its generation. A new fleet
has a new id and never meets them.

## Agent versions

- **The range.** A session adapter has a minimum and no maximum: Claude Code 2.1.251, Codex 0.155.0, OpenCode 2.0.22.
  A handover copies session files byte for byte, so it depends only on where each CLI keeps a session and on its
  resume command; for OpenCode, on `session export`, `session import --directory`, the `Imported session: <id>` line
  that import prints, and `-s`.
- **What a new release can break.** A release that moves a session's files, or changes `--resume` or `resume`, fails
  to resume on the destination. The character stays dormant with its transcript and the error, and ownership stays
  where it moved. An OpenCode release that changes its export or import blocks at prepare with `transcript_missing`,
  before the commit. A release that changes how it records folder trust or bypass acceptance changes the `claude_trust`,
  `codex_trust` and `claude_bypass` warnings, not the move.
- **The process for each new Claude Code or Codex release:**
  1. record a fixture from it under `packages/svalld/test/fixtures/handover/<agent>/<version>`;
  2. run the live probe (`packages/svalld/test/handover/sessions-live.test.ts` with `SVALL_LIVE_REMOTE`) between two
     machines with the same home;
  3. raise the adapter's minimum only when an older release stops working.

  Until the probe passes, the release is untested with handover, not refused. OpenCode has no fixture or live probe;
  the integration run's mock follows 2.0.22.

## Performance and limits

### Measured

`scripts/bench/handover.sh` runs the benchmark on two containers the integration run sets up for it (see
`docs/integration.md`), over real sshd and rsync, with the controller on `svall-bench-local`. Each repository gets its
own shell character, then four handovers: a first one to the machine that has never held it, two incremental ones
each after ten changed files and one new one, and one after the character is closed that carries only the integration
fixture. Every handover also carries that fixture: 86 files, 17 MB.

The machines: colima on an M-series Mac, 2 vCPUs and 2 GiB of memory shared by both containers, arm64, the docker
network as the link; each daemon's heap is 1,076 MiB, as the last two runs recorded. The ranges cover five recorded
runs: three on the build that added the benchmark (two of all three repositories, one of the many-file repository
alone), a fourth on the build with the file bound and, last, one on the build that counts files from their names
before reading them (both of all three). Before and after every handover the Mac was on AC
power at 100% charge with no thermal or performance warning recorded; each row of `bench.json` keeps what
`pmset -g batt` and `pmset -g therm` said. Memory is peak RSS, and a daemon's growth is its peak above what it held
when the handover began. The manifest and prepare sizes are computed from the compact JSON of the controller's copies
of the manifest and of what landed, not read off the wire.

| Repository | Carried | First | Incremental | Controller peak | Daemon growth | Manifest | Prepare | Replica record |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small: 200 tracked files | 316 files, 17 MB | 2.8–2.9 s | 2.3–3.0 s | 88.4–98.1 MiB | up to 28.5 MiB | 61–62 kB | 0.1 MB | 40 kB |
| large-file: 200 tracked files and 1 GiB of ignored data in 4 files | 320 files, 1.09 GB | 8.4–14.7 s | 7.3–11.3 s | 138.7–154.3 MiB | up to 55.6 MiB | 61–63 kB | 0.1 MB | 40 kB |
| many-file: 50,000 tracked files, packed | 50,116 files, 83 MB | 26.0–57.0 s | 39.5–179.6 s | 291.5–355.8 MiB | 193.2–297.7 MiB first, 32.9–120.1 MiB incremental | 8.7 MB | 17.4 MB in 5 parts | 8.7 MB |

- **Where the time goes** for 50,000 files, in the fastest recorded handovers (both in the fourth run): first,
  26.0 s (preflight 3.7 s, freeze 5.2 s, claim, copy and verify 7.9 s, prepare 7.7 s); incremental, 39.5 s (8.3, 5.9,
  12.9 and 10.6 s). Counting the names first made the last run's preflight 5.4 s first and 10.1–10.6 s incremental.
  The slow runs lost their time to IO: the 2 GiB machine cannot keep both copies in its page cache beside the
  daemons, and a run that waited 17.2 s on IO took 132.2 s. The last three runs record those seconds (`IO stall s`)
  and the Mac's load with each handover.
- **What grows with the number of files:** the manifest (173 bytes a file here), the replica records (one file list
  each, two while a root is receiving), the memory of the daemons and the controller, and the time. The event stream
  and rsync's memory do not: every handover wrote 34 to 44 events, 6.1 to 8.1 kB, no line over 842 bytes, and no
  rsync went past 7.7 MiB.
- **Each side reads every carried file several times.** The source walks the names at preflight and at freeze, then
  hashes each file at both, and again in the controller's verify when the controller runs there. The destination
  hashes a replica at preflight, again at the claim, then what landed at prepare, and once more after the Git import
  each root that holds or lies in a carried Git directory. The seal is what landed, with only what the import writes
  taken from that last read: each carried graph's `config`, and the worktree registrations it removes. rsync's
  checksum compare reads both sides. Each proof guards a different moment (before any write, before `--delete`, after
  the copy, after the import), so none is reused: a replica can change between preflight and the claim. Files are
  hashed eight at a time.

### Bounds

| What | Bound | Test |
| --- | --- | --- |
| Progress events | One per entry per new state, and its counts at most once a second, whatever rsync itemizes | `cli/test/controller/transfer.test.ts` "tells a watcher of a 50,000-file copy as often as of a one-file copy…" |
| Blocker and warning text | Each names a few paths and counts the rest | `handover.test.ts` "names a few of a root's names that differ only by case…"; `divergence.ts` and `listed` in `manifest.ts` preview 5 to 10 |
| The manifest | 128 MiB (`manifest_too_large`, at preflight and freeze). A file the scanner lists takes under 160 bytes beyond its path, so the cap holds 128 MiB / (160 B + path) files: over 500,000 with paths up to 100 bytes | `source.test.ts`; `manifest.test.ts` "lists a file the scanner reads in under 160 bytes beyond its path…" |
| Files a handover carries | Half the smaller daemon's heap at 8 KiB a file (`too_many_files`, at preflight and freeze) | `source.test.ts` "refuses at preflight, with nothing frozen, more files than the smaller of the two heaps holds…" |
| A request to a daemon | 8 MiB a WebSocket frame; a larger one goes in 4 MiB parts, 256 MiB in all | `cli/test/client.test.ts`, `svalld/test/api.test.ts` |
| An answer to the controller | 256 MiB a frame; the preflight and freeze answers carry the manifest whole, 8.7 MB at 50,000 files as computed from its compact JSON | `client.test.ts` "reads an answer as large as a request may be…" |
| Hashing | Eight files at once, each streamed a chunk at a time; a Git index is read whole, one at a time, up to 256 MiB | `manifest.test.ts` "hashes several files at once, never more than eight…", "reads a session file a chunk at a time…" |
| Where carried links lead | One lookup per link in its root's paths | `handover.test.ts` "reads a root's file list a few times over to judge its links…" |
| A terminal viewer on the daemon's socket | No more output once 1 MB waits unsent on its socket, then the screen afresh once 250 kB or less waits | `svalld/test/terminals.test.ts` "sends a viewer no more output once a megabyte waits unsent…", "lets a viewer that fell behind back in once a quarter of a megabyte or less waits…", "resumes a paused pane for the viewers that keep up…" |

Other caps: a notification's POST body 64 KiB, a gateway line and a helper control line 1 MiB, a far command's output
1 MiB, a far release listing 16 MiB.

### Terminal output faster than the link

- **The app's terminals** attach with `ssh -tt … tmux attach`, so a link slower than the terminal backs up into tmux,
  which stops drawing to a client that falls behind and redraws it once it catches up. Nothing passes through the
  daemon. The benchmark does not measure this path.
- **A viewer on the daemon's socket**, such as the phone page, stops getting output once 1 MB waits unsent, and gets
  the screen afresh once 250 kB or less waits, so the resync (2,000 lines) fits under the mark with room to spare. In
  the benchmark (`--flood`, four runs), a terminal printed 22.9 to 23.7 MB a second to a viewer that then read
  nothing for 20 s, and the daemon grew by under 1 MiB. Without the bound the daemon queued every byte printed,
  base64-encoded, until the socket closed.
- **tmux** pauses a pane whose output the daemon's own control client lags 3 s behind (`pause-after=3`). The daemon
  resumes it once every viewer that keeps up has drained; one that fell behind holds nothing up.

### Limits

- **A handover carries at most as many files as the smaller daemon's heap holds** (`too_many_files`), which comes
  well before the manifest cap. A daemon's peak grew by up to 297.7 MiB on a first 50,116-file copy, 6.2 KB a file:
  the manifest and what landed, their JSON and the scans. The bound gives each file 8 KiB of heap and a handover half
  the heap, leaving the rest for the daemon's own state and for the garbage collector to work in:
  files ≤ heap / 2 / 8 KiB, the heap being the smaller of the two daemons' V8 `heap_size_limit` (the destination
  reports its own in `system.info`). Node sizes that heap from the machine's memory: 4,288 MiB on a 48 GB Mac holds
  274,432 files, and the benchmark's 1,076 MiB 68,832 (`host.json`). The source counts the files from their names
  before it reads any: at preflight, which then answers without its file lists, and at freeze before any terminal
  rests. A fleet however far past the bound is refused that way, never hashed; freeze checks the read manifest again.
  Tried by hand in the benchmark's containers, a 250,116-file fleet was refused in 11 s, and the source daemon's peak
  grew by 92 MiB. The controller asks the destination nothing about the roots of a preflight answered without its
  file lists. It runs on one of the two machines with that machine's default heap, and grew by less a file than a
  daemon: its peak was at most 355.8 MiB for 50,000 files and at least 87.8 MiB for the small repository.
- **More than ten terminals on one remote machine** go past sshd's default `MaxSessions 10` on the shared master.
  Each one past the tenth prints one "Session open refused by peer" line and opens its own login, and while the master
  is full the helper's 30-second check does too. That login runs with `BatchMode=yes`, as the master does, so it
  asks for nothing and logs in only with the keys ssh can use without a prompt. Measured by hand between the
  containers, not by the benchmark: a command on the master 3–4 ms, a login 161–178 ms. A master per ten surfaces
  would need the app to choose a socket for each surface; one login per extra terminal does not justify that before
  the release.
- **Folders are not listed in the manifest.** rsync carries them, empty ones and their modes included (`-rlpt`), and
  its checksum compare itemizes a folder's mode as it does a file's, so a copy that differs there does not verify
  (`transfer.test.ts` "carries empty folders and each folder's mode…"). A folder made or re-moded on the destination
  while it did not own the fleet is not a divergence: `--delete` removes an empty one and the copy resets a mode.
  Neither holds work.

### Run it again

```sh
colima start                                           # if Docker is not already running
scripts/bench/handover.sh --out /tmp/handover-bench --flood
```

| Option | What it does |
| --- | --- |
| `--repos small,large,many` | Which repositories to measure, in that order; `none` for only the flood. |
| `--files <n>`, `--large-mib <n>` | The many-file repository's files (50,000) and the large-file repository's data (1024 MiB). |
| `--flood` | Also measure a terminal printing to a viewer that reads nothing. |
| `--archive <file>` | Use this companion archive instead of building one from the checkout. |
| `--keep`, `--reuse` | Leave the containers running; measure on containers a `--keep` run left. |
| `--prefix <name>` | Name the containers `<name>-local` and `<name>-remote` (default `svall-bench`). |

The folder holds `bench.md` (the table), `bench.json` (every measure of every handover), each handover's NDJSON,
`flood.json`, `host.json` (each daemon's heap and the files a handover between them may carry) and the integration
run's logs under `setup/`. Its containers are not the integration run's (`svall-local`, `svall-remote`), so the two
can share a Docker host. The last run took under four minutes, the companion build included.

## Accepted risks

- **A root swapped for a symlink during the transfer.**
  - On the source, rsync follows it. Verification then finds the content differs from the manifest and blocks, but
    the copy has landed in the inactive destination root.
  - On the destination, `--delete` follows the link.

  Both need a process running as the user on that machine, which could read or delete those files directly.
- **Another account can squat the daemon's lock name on Linux.** The lock is an abstract socket named from the home's
  real path, so another account can bind it first and hold the daemon in a restart loop. Mixing a 0600 key from the
  fleet home into the name would stop it. It is left for version 1: it needs a second account on the machine, and it
  only keeps the daemon from starting, reading and changing nothing.
- **A far machine with no release of its own to pin a signer**, a first install or a release built before the first
  signing key, unpacks the upload before any check of its own. It rests on the controller's check against its own
  pinned signers, made before the upload and before the controller unpacked anything, and the `install` step says so.
- **The phone page's package list is the web app's whole production closure** (161 packages), not only what Vite
  inlined. Listing more than was bundled is harmless in a NOTICE; a list from the Vite build would need `dist-mobile`
  rebuilt before every release build.
- **`svall setup` replaces `~/.local/bin/svall`** whatever it was. It is setup's own name.
- **An upgrade restarts a fleet daemon the user disabled but whose unit file remains.** A rollback must not leave a
  failed daemon down, so it restarts every unit.
- **An install can remove a release a process still runs from.** Each install keeps only the new release and the one
  to go back to. A daemon left running by `--no-launchctl`, or a long-lived `svall`, started from an older release
  loses its files. Setup restarts the daemons it moves.
- **`svall host remove` forces the far uninstall past its own fleets' gateway records.** The far machine takes the
  Mac's word for the fleets it names, which rests on the owners the Mac last cached. Anything else there still refuses,
  so removing a gateway two Macs use takes `svall uninstall --force` on it once the other Mac has forgotten it.
