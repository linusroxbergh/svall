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
| An alias that now reaches another machine | A daemon is used only once `connection-info` answers with the registry's machine id and the fleet's id. The gateway is asked nothing until `archi version --json` there names its registry id: once per master from the controller, and in the same ssh as each question from a daemon; preflight blocks with `identity_mismatch` otherwise. `host upgrade`, `host remove` and `host enable` first ask `archi version --json` and stop on another machine id; `host enable` then makes the record and the fleet's copy over that one master. Every command on a master names the host `archi-remote.invalid`, so one whose master has died fails rather than opening a connection no check covered. | `cli/test/controller/connection.test.ts`; `cli/test/host.test.ts` "uninstalls nothing…", "uploads and installs nothing…", "asks for and makes no ownership record on a machine that answers as another…", "makes the record and the copy of the fleet over the one master whose machine it checked"; `cli/test/controller/ssh.test.ts` "never lets a command fall back to a connection of its own once its master has gone"; `cli/test/controller/handover.test.ts` "asks a far gateway nothing once its ssh destination answers as another machine", "blocks at once on a gateway whose ssh destination now reaches another machine"; `connection.test.ts` "never takes the word of a gateway whose ssh destination now reaches another machine"; `archid/test/gateway/server.test.ts` "refuses the answer of a machine the gateway's ssh route now reaches in its place"; `source.test.ts` "blocks with identity_mismatch when the route to its gateway now reaches another machine" |
| A remote argument split or expanded by the far login shell | Every word that is not a literal flag goes through `shellQuote`. Scripts run as `sh -c '<literal>' <name> <args…>`. rsync gets `-s` (protected arguments) and escapes `*?[` in far paths. | `cli/test/controller/install.test.ts` "streams the archive into a path the far shell never splits", "hands the far check…as words of their own"; `cli/test/controller/transfer.test.ts` "refuses a far path rsync would expand…" |
| RSYNC_* settings turning argument protection off | `runRsync` drops every `RSYNC_*` variable, and openrsync or an rsync before 3.2.3 is refused. | `cli/test/controller/rsync.test.ts`; `transfer.test.ts` "refuses a far rsync that is missing, too old or openrsync…" |
| Hostile file names: a leading `-`, spaces, unicode | rsync takes names from its own file list, never argv; roots are absolute paths after `--`. | `transfer.test.ts` "mirrors a root with spaces, unicode and hostile names…", "mirrors a hostile tree to the Linux rsync and back…" |
| A newline or control character, non-UTF-8 | Preflight blocks the name (`path_unsupported`) and carries none of it, as rsync's output is read a line at a time. | `archid/test/handover/manifest.test.ts` "blocks a file name with a control character…", "blocks a name that is not UTF-8…", "blocks a link whose text holds a control character…" |
| Names that differ only by case or by Unicode normalization | The destination reports whether each landing folder folds case; the controller blocks a collision (`path_collision`), folding NFC and NFD forms together as APFS does. | `archid/test/handover/probe.test.ts` "names the paths that differ only by case", "names the paths that differ only by Unicode normalization…"; `cli/test/controller/handover.test.ts` |
| A character folder reached through a symlink | A root travels at its real path; a recorded path that is not real blocks (`path_symlinked`), at preflight and again at freeze. | `inventory.test.ts` "blocks a graph root reached through a link…"; `source.test.ts` "refuses a cwd the fence finds reached through a link…" |
| A link inside a root, or one pointing out of it | Carried as a link (`-l`), never followed. A link that dangles on the destination is reported (`symlink_dangling`). | `manifest.test.ts` "lists each carried file once…and a link as its text"; `destination.test.ts` |
| A manifest path that climbs out of its root, or a session file out of its agent home | Refused before a path is built from it. | `replicas.test.ts` "refuses manifest paths that could leave their root"; `transfer.test.ts` "refuses a session file whose name climbs out of its agent home…" |
| A root that holds a fleet home, whose token, keys and journal stay on their machine | Blocked on both machines, by lexical and real path. | `inventory.test.ts` "blocks a root that holds or lies in either fleet home…"; `replicas.test.ts` "refuses a root that reaches the fleet home through a symlink or holds it…" |
| A root that holds an agent's login or config, the ssh folder, or Archipelago's own install | Blocked on both machines: `.credentials.json`, `.claude.json`, Codex's `auth.json`, both where `CLAUDE_CONFIG_DIR` and `CODEX_HOME` put them and in the default homes; `~/.ssh`; `~/.local/share/archipelago` (releases and the gateway's records), `~/.config/archipelago` (the machine id and registry), `~/.config/systemd/user` and the `archi` shims. The source checks by real path on its own disk; the destination checks its own by real path when it claims or archives a root. | `inventory.test.ts` "blocks a root that holds an agent's credentials or config…", "blocks the default agent homes beside the configured ones, and Archipelago's own install…"; `source.test.ts` "blocks a character working in the folder this daemon's Claude keeps its login in…"; `replicas.test.ts` "refuses, by real path on this machine, a root that holds or lies in its ssh folder, an agent login or its Archipelago install" |
| A stale authority record | The gateway swaps only on the expected generation and owner. A reachable gateway's record wins over a daemon's cached one. A frozen or surrendered source starts read-only. A prepare or activation for another generation, transaction or manifest is refused. | `archid/test/gateway/authority.test.ts`; `archid/test/ownership.test.ts`; `destination.test.ts` "refuses a prepare meant for another machine, fleet, generation, transaction or manifest…", "waits for the gateway to commit this handover at the next generation…" |
| Destination path confusion | Both machines must share the home path (`home_mismatch`). A root lands only at the real path its claim checked, and never over a folder no handover left there (`destination_occupied`). | `inventory.test.ts`; `source.test.ts` "blocks a destination whose home is not this machine's…"; `replicas.test.ts` |

## Release integrity

- **Signing.** A release's `SHA256SUMS` covers every file, `release.json` included, and is signed with
  `ssh-keygen -Y sign` under the `archipelago-release` namespace. `release.json` describes every entry in both
  directions.
- **On the controller**, before any upload:
  - a downloaded companion must match the digest the controller's own manifest pins;
  - an archive's `SHA256SUMS` must verify against the controller's `release/allowed_signers` before anything else is
    unpacked from it, and the tree must then match its manifest;
  - it must be this controller's release and protocol, built for the machine's architecture.

  (`cli/test/controller/install.test.ts` "checks the signature over an archive's SHA256SUMS before it unpacks anything
  else from it")
- **On the far machine**, the uploaded release is checked before anything it carries runs, on an upgrade and on a
  `host add` run again over an installed release alike:
  - `ssh-keygen -Y verify` of its `SHA256SUMS`, unpacked alone, against the installed release's
    `current/release/allowed_signers`, before the rest of the archive is unpacked;
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
  host add over an installed release to the signers that release pins…", "says when a machine has no release
  installed to pin a signer…", "refuses a
  release the installed release's signers do not vouch for, before anything it carries runs", "checks the signature
  over an upgrade's SHA256SUMS before it unpacks anything else the archive holds", "refuses a release the pinned key
  signed that arrives under another release's name…", "checks with the system's own tools, whatever a relative entry
  in the far PATH finds in the upload first", "refuses a release when the installed release has lost its signers
  file…", "says when the installed release pins no signer…", "checks an unsigned release with --allow-unsigned by its
  digests alone…")
- **`archi setup --release <archive>`**, the installer on each machine, checks the signature over the archive's
  `SHA256SUMS` before it unpacks the rest, then every digest and the tree. (`archid/test/release.test.ts` "checks the
  signature over an archive's SHA256SUMS before it unpacks anything else from it")
- **Unpacking.** Once its signature has passed, or when none is asked for, an archive is unpacked into a staging
  folder by the system's tar, which strips absolute and `..` members. Nothing in the staging folder runs until the
  digests pass, and it is removed afterwards.
- **What a release loads.** The bundles resolve `bufferutil`, `utf-8-validate` and `supports-color`, which their
  dependencies only try for, to a module that throws. Node therefore never searches a folder above the release, such
  as a staging folder, `~/node_modules` or `/Applications/node_modules`, for code to run. The scan fails a bundle
  that requires any module the release does not carry. (`archid/test/release.test.ts` "a release built by the build
  scripts"; `test/release-scan.test.ts`)
- **The archive scan.** `scripts/release-scan.mjs` fails a build on secrets, developer paths or checkout
  dependencies; see `docs/integration.md`.

## Secrets

The secrets: the daemon token, the relay secret, the phone key, the VAPID keys, the fleet `.env`, agent logins and
ssh keys.

| Channel | What keeps secrets out | Tests |
| --- | --- | --- |
| argv | The token travels in `connection-info`'s stdout and a WebSocket hello, never in argv. rsync and ssh carry paths only. | `connection.test.ts`, `connect.test.ts` (ssh argv never holds the token) |
| Logs | The daemon's API never logs a token, its own or one a client offered. The helper's log and output are scrubbed of every token held. The units' logs sit in a 0700 folder. | `archid/test/api.test.ts` "never writes the daemon token, or one a client offered, to its log"; `cli/test/handover.test.ts`; `linux-setup.test.ts` |
| NDJSON events | Each event is scrubbed before it is written, sent or kept. | `host.test.ts` (host add and upgrade events); `cli/test/handover.test.ts`; `cli/test/controller/handover.test.ts`; `connect.test.ts` |
| State and journals | The controller journal, progress journal and route cache hold ids, paths and digests. A failure recorded there is scrubbed of tokens and of the values in carried `.env` files. | `cli/test/controller/handover.test.ts`; `transfer.test.ts` "keeps tokens and .env values out of everything it records"; `connect.test.ts` |
| Manifests | A manifest names files by hash, never content. No fleet key is a root, and a carried `.env`, repository or fleet, appears only as its digest. | `manifest.test.ts` "holds no fleet key, and no secret a carried .env holds…" |
| Repository roots | Replica records, filter files and progress live under the fleet home or the controller's state folder, never in a root. A root holding a fleet home, an agent login or `~/.ssh` is blocked. | `replicas.test.ts` "keeps each record under the fleet home…"; `inventory.test.ts` |

- **The relay secret.** It is written at 0600 in the fleet home when a prepare carries one. The controller sends
  none in version 1.
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
| `rsync --delete` (`controller/transfer.ts`) | Files in a destination root the source no longer has | An ok claim from the destination's replica store: absent and reserved by this transaction, this transaction's own partial copy, or a replica proven to hold only what a handover left. Folders the claim keeps and excluded paths are spared. | `transfer.test.ts` "writes a root only where its claim says…", "never writes a root the destination did not claim…", "leaves a folder the claim keeps as the far side has it…"; `replicas.test.ts` "is refused when no handover left it there…", "blocks, and is left as it was, when it changed…" |
| Archiving a root (`ReplicaStore.archive`) | Renames a diverged or occupied root to a timestamped sibling | A choice that names the root, and a root that neither holds nor lies in the fleet home, the ssh folder or Archipelago's install, and holds no agent login, each by real path. The sibling is made exclusively and never replaces anything. | `replicas.test.ts` "moves a root aside only when the choice names it…", "never replaces a sibling that holds the name already…", "refuses to move the fleet home or anything holding it"; `destination.test.ts` "…archives it aside only when asked to" |
| Worktree registrations (`handover/git-import.ts`) | `<common dir>/worktrees/<id>` entries the manifest does not carry; branch refs stay | The manifest's graph, in a root this transaction claimed. The folder must be a real one, and no git refusal may stand. | `git-import.test.ts` "removes each registration the manifest leaves out…", "refuses a worktrees folder carried as a link…", "turns a git that refuses into a blocker…and removes no registration" |
| Session stages, prepared state, seals (`handover/destination.ts`) | `handover/{sessions,prepared,seal}-<tx>` in the fleet home | The destination journal's transaction id, encoded to one path segment, after the gateway let the handover go or it completed | `destination.test.ts` "drops the session stage of a handover it never prepared…and nothing else", "discards what it prepared once the gateway no longer holds the handover, and not before" |
| A kept manifest (`handover/source.ts`) | `handover/manifest-<tx>.json` | The source journal's transaction | `source.test.ts` "…replacing a manifest no journal names" |
| Controller journal and transaction folder (`controller/recovery.ts`) | `controller/handover.json`, `controller/handover/<tx>` | The journal's own transaction id, encoded to one path segment, `.` and `..` included | `recovery.test.ts` "keeps each transaction's folder one name under its own, so clearing a transaction named . or .. removes nothing else" |
| Unreadable records set aside | A daemon journal, gateway record, owner cache, registry or controller journal is renamed to `*.broken-*` | The record failed to parse. Nothing is deleted, and a quarantined gateway record refuses its fleet until repaired. | `journal.test.ts`; `gateway/authority.test.ts` "quarantines a record it cannot read…"; `ownership.test.ts` |
| A far fleet copy re-keyed (`linux/provision.ts`) | The copy's `owner.json` | Only a home `host add` made that has never run a fleet; one in use is refused | `linux-provision.test.ts` "refuses a home whose fleet has been used…and changes nothing" |
| Upload leftovers (`controller/install.ts`) | `~/.cache/archipelago/staging-<v>` and `companion-<v>.tar.gz` on the far machine | Paths built from the registry's home and the archive's one release name, each passed as one word | `host.test.ts` "deletes the archive it uploaded and the release it unpacked…" |
| Release install and rollback (`scripts/install-release.mjs`) | The staging folder; a same-named release it replaces; `current` | A version name matching `[A-Za-z0-9._+-]+` that stays under `releases/`; `current` moves by an atomic rename | `archid/test/release.test.ts` |
| `archi host remove` (remote `archi uninstall`) | Everything setup added on the far machine, below | The registry record, and a far machine that answers with its id. It never runs while a fleet naming this gateway is open or owned elsewhere, while the machine owns a fleet through any gateway, or with `--purge`. | `host.test.ts` "uninstalls nothing on a machine that answers as another…", "refuses to strand a fleet another machine owns…", "refuses to uninstall a machine that owns a fleet through another gateway…" |
| `archi uninstall` (`archid/src/uninstall.ts`) | Units named `archipelago-archid@*.service` and `archipelago-gateway.service`; plists with the Archipelago labels; `releases`, `current`, `companions` and `log` under the prefix; shims that point into a release or run a checkout; only Archipelago's hook entries | Each is recognised as Archipelago's by name, link target or content | `uninstall.test.ts` "on Linux removes only Archipelago units and the releases, and keeps the fleet", "leaves an archi on PATH that setup did not write", "removes only Archipelago entries…" |
| `archi uninstall --purge` | Fleet homes, the app, and macOS data under the app's ids | A folder counts as a fleet home only if it holds a `fleet.json` or `config.json`. Asked for or confirmed. | `uninstall.test.ts` "finds every fleet home…and deletes only those", "leaves a folder of yours that is only named like a fleet…" |

## Licences

- **Companion and controller archives.** Each carries `licenses/NOTICE`, naming every component with its version,
  licence and the file holding the licence text:
  - Archipelago;
  - the Node runtime, whose licence file covers what Node bundles;
  - each npm package esbuild bundled;
  - each package the phone page can bundle, which is the web app's production dependency closure;
  - the phone page's fonts (OFL) and art.
- **When a package has no licence file.** The build stops at a bundled package that ships no licence file, unless
  `scripts/release/licenses/<name>-LICENSE` holds its upstream text. `http_ece`'s is kept there.
  (`archid/test/release.test.ts` "stops the build at a bundled package that ships no licence file…", "a release built
  by the build scripts")
- **rsync (GPL-3.0-or-later).** The controller archive carries rsync's source tarball, the pinned one, beside its
  licence. The NOTICE line names the configure flags and the `strip -S`. (`release.test.ts` "carries the source of the
  rsync it ships…")
- **The app.** It carries `LICENSE.ghostty` and `apps/desktop/mac/NOTICE` in `Contents/Resources/licenses`. The NOTICE
  names every component GhosttyKit links, with its licence and upstream. A test fails on any object file in the kit
  that no named component accounts for. (`test/app-notice.test.ts`)
- **Open items for the release:**
  - **GhosttyKit's own licence texts.** Only Ghostty's text ships. FreeType's FTL asks for its credit line in the
    documentation. MIT, BSD, zlib, libpng and Apache-2.0 ask for their texts. They are best collected when the kit is
    built, from zig's package cache.
  - **libintl** (GNU gettext, LGPL-2.1-or-later) is linked statically. The LGPL asks that a user can relink against a
    changed library. The app's source and the kit's build script meet that only once the repository is public.
  - **Flaticon art.** The animal portraits and the lighthouse are Flaticon Premium icons whose licence does not allow
    redistributing the files (`web-mobile/animals/LICENSE`, `resources/LICENSE`). The companion archive, which is
    published, carries them as files. So does the app.

## Service and file permissions

- **Units.** `archipelago-archid@<fleet>.service` and `archipelago-gateway.service` are user units that hold paths
  only. They run as the user with `Restart=always`. Their logs are in `~/.local/share/archipelago/log`, at 0700.
  (`linux-setup.test.ts` "keeps the units' logs in a folder only this account opens…")
- **Fleet home** 0700, made so at every daemon start. Its contents:
  - `token`, `mobile-key`, `vapid.json`, `push.json` and `relay-secret` at 0600;
  - `hooks.sock` at 0600;
  - tmux's socket, inside the 0700 home.

  (`daemon.test.ts` "keeps the fleet home, its keys and its hook socket to this account…"; `push.test.ts`;
  `mobileControl.test.ts`)
- **Durable records** are written through a same-folder temp, fsynced and renamed, at 0600 unless named otherwise:
  - ownership (`owner.json`) and the daemon journal;
  - replica records, prepared state, seals and manifests;
  - `fleet.json` and `node.json`;
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
- **Home length.** A Linux home over 59 bytes cannot hold the gateway's socket, which is 48 bytes past it, under the
  107 bytes a socket path takes. `host add` stops at its `home` step with that cause. On a machine already set up,
  `doctor` names the `listen EINVAL` of a gateway that keeps restarting. (`host.test.ts` "stops at a home too long for
  the gateway's socket…"; `doctor.test.ts`)
- **Tailscale.** A handover and its install add no `tailscale serve` or `funnel` mapping. The fleet's
  `mobile.logins` travel in `fleet.json`, and a phone link on the destination starts only when the user turns it on
  there.

## What uninstall keeps and deletes

| | `archi host remove <name>` (runs `archi uninstall` there) | `archi uninstall` | `archi uninstall --purge` |
| --- | --- | --- | --- |
| Archipelago's hooks in Claude's settings and Codex's hooks file | removed | removed | removed |
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

- **The range.** A session adapter has a minimum and no maximum: Claude Code 2.1.251, Codex 0.155.0. A handover copies
  session files byte for byte, so it depends only on where each CLI keeps a session and on its resume command.
- **What a new release can break.** A release that moves a session's files, or changes `--resume` or `resume`, fails
  to resume on the destination. The character stays dormant with its transcript and the error, and ownership stays
  where it moved. A release that changes how it records folder trust or bypass acceptance changes the `claude_trust`,
  `codex_trust` and `claude_bypass` warnings, not the move.
- **The process for each new Claude Code or Codex release:**
  1. record a fixture from it under `packages/archid/test/fixtures/handover/<agent>/<version>`;
  2. run the live probe (`packages/archid/test/handover/sessions-live.test.ts` with `ARCHI_LIVE_REMOTE`) between two
     machines with the same home;
  3. raise the adapter's minimum only when an older release stops working.

  Until the probe passes, the release is untested with handover, not refused.

## Accepted risks

- **A root swapped for a symlink during the transfer.**
  - On the source, rsync follows it. Verification then finds the content differs from the manifest and blocks, but
    the copy has landed in the inactive destination root.
  - On the destination, `--delete` follows the link.

  Both need a process running as the user on that machine, which could read or delete those files directly.
- **Another account can squat the daemon's lock name on Linux.** The lock is an abstract socket named from the home's
  real path, so another account can bind it first and hold the daemon in a restart loop. Mixing a 0600 key from the
  fleet home into the name would stop it. It is left because a daemon of an earlier release, still running under the
  old name, would then not exclude a new one during an upgrade.
- **`archi setup` replaces `~/.local/bin/archi` and `archipelago`** whatever they were. They are setup's own names.
- **An upgrade restarts a fleet daemon the user disabled but whose unit file remains.** A rollback must not leave a
  failed daemon down, so it restarts every unit.
