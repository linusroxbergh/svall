# Blockers, warnings and errors

Every code a handover, `archi host` or `archi fleet recover` can report: what it means and the safe way on. The test
`packages/cli/test/error-catalogue.test.ts` reads each list below from the code, and fails when the code has one this
page lacks or this page names one the code no longer has.

Where codes show up:

- **The handover sheet** shows the message the machine wrote and, for many codes, a line on what to do.
- **`archi handover`** prints a blocker as `✗ <who>: <message> (<code>)` and a warning with `!`. With `--json`, each
  blocker or warning carries `code`, `message` and, when it is about one thing, `entity` (`character`, `root`,
  `session` or `git`, with its id).
- **`archi host …`** prints one line per step, and `--json` one object per step with `step`, `status`, `detail` and
  `action`.

## Before and after the commit

Two rules decide every recovery:

- **Before the commit**, the source machine still owns the fleet. Nothing runs on the destination, and Abort (or
  `archi handover --abort`) gives the fleet back to the source and reopens only the terminals the handover stopped.
  Files already copied stay on the destination as a replica for the next try.
- **At and after the commit**, the destination owns the fleet. Abort is refused, the source stays fenced, and only
  Resume (Retry in the sheet, `archi handover --resume`) goes on, on the destination. A character that fails to
  resume stays dormant with its transcript and says why.

`archi handover status` reads all four journals (this Mac's controller, the gateway's record and both daemons) and
says which of the two is safe. It changes nothing.

## Handover phases

What `handover.changed` and `status` report, in order.

| Phase | Sheet section | What happens | If it stops here |
| --- | --- | --- | --- |
| `begin` | Checks | The gateway opens the handover at the fleet's generation. | Resume or Abort. |
| `freeze` | Resting characters | The source fences every change, rests its terminals and writes the manifest. | Resume or Abort. |
| `transfer` | Transferring files and sessions | The destination claims each folder, then rsync copies folders and sessions. | Resume or Abort; a resume copies only what changed. |
| `verify` | Verifying and committing | The copy is checked against the source. | Resume or Abort. |
| `prepare` | Verifying and committing | The destination proves what landed, imports Git, places the sessions and writes the state it would run. | Resume or Abort. |
| `ready` | Verifying and committing | The gateway records that the source is frozen and the destination prepared. | Resume or Abort. |
| `commit` | Verifying and committing | The gateway moves the fleet to the destination at the next generation. | Only the gateway knows whether it landed: `status` once it answers. |
| `activate` | Resuming characters | The destination runs the fleet and resumes the terminals the handover rested. | Resume (Retry). |
| `complete` | Resuming characters | Both machines and the gateway close the handover. | Resume finishes what is left. |
| `aborted` | the section it stopped in | An abort is letting go on both machines. | Abort again finishes it. |

## Blockers and warnings

A blocker stops the handover where it is found; a warning only informs. When a blocker turns up during Checks,
nothing has started and the fleet stays where it is. One found later (while resting, transferring or verifying)
opens a decision in the sheet: fix the cause and choose Try again, pick the choice it offers, or Abort. Without a
person to ask (`--json`, `--detach` with nobody attached), the run stops with `blocked` and gives the fleet back.

### Identity, versions and reaching the machines

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `identity_mismatch` | blocks | A machine, fleet or gateway is not the one the handover expects: the fleet names no gateway, the destination already runs the fleet, a machine answered with another machine id, the destination's companion runs another fleet under this fleet's name, the gateway refused to begin, or the fleet the destination would prepare names another fleet id or gateway. | Follow the message. No gateway: `archi host enable <host> --fleet <fleet>`. Another fleet on the destination: the same command gives it a copy of this one. A machine id that changed (a reinstalled machine): `archi host remove <host> --forget`, then `archi host add` again. Run handovers from the Mac. |
| `generation_mismatch` | blocks | The source's copy of the ownership record and the gateway's name different generations: another handover or a recovery moved the fleet since the source last heard. | `archi handover status`. With nothing open, restart the source's daemon: on start it takes the gateway's record. |
| `transaction_open` | blocks | A handover of this fleet is already open: at the gateway, as a journal on the destination, or as a source frozen for a handover the gateway no longer holds. | `archi handover status`, then `archi handover --resume` or `--abort`, whichever it says is safe. |
| `incompatible_release` | blocks | The two machines run different Archipelago releases. A handover needs the same release on both. | `archi host upgrade <host>` installs this Mac's release there. If the host is newer, update the Mac first (`pnpm desktop:install`). |
| `incompatible_protocol` | blocks | The two machines speak different RPC protocols. | As for `incompatible_release`. |
| `incompatible_schema` | blocks | The two machines read different fleet state or transfer manifest versions. | As for `incompatible_release`. |
| `ssh_interactive` | blocks | ssh would have to ask something (a new host key, a password, a key passphrase), and a handover asks nothing. Also raised when the source's daemon cannot ask its gateway without a prompt. | Run `ssh <destination>` once in a terminal and answer it. Keep a key with a passphrase in the agent (`ssh-add --apple-use-keychain` on a Mac). Then try again. |

### Agents

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `agent_cli_missing` | blocks | The destination has no CLI for an agent the fleet runs, or no home to keep its sessions in, or keeps them somewhere other than where the checks found them. | Install Claude Code or Codex on the destination where its daemon finds it (`archi host doctor <host>` shows what it sees), then try again. |
| `agent_logged_out` | blocks | The agent is not logged in on the destination. Logins never move with a fleet. | `ssh <host>`, then `claude auth login` or `codex login`. |
| `agent_hooks_missing` | blocks | Archipelago's hooks are not installed for that agent on the destination, so a resumed agent could not report back. | Run `archi setup` on the destination (on Linux, `~/.local/bin/archi setup`), then trust the hooks in Codex with `/hooks`. |
| `incompatible_adapter` | blocks | An agent CLI is older than the oldest release a handover carries sessions for (Claude Code 2.1.251, Codex 0.155.0), the two machines read sessions differently, or a session holds a file that is not a regular file. | Update the CLI on the machine the message names. For a file in a session, move the file it names out of that session's folder. |
| `transcript_missing` | blocks | An agent session recorded no transcript, or its transcript is not there or is not that session's. | An agent that never reported a transcript has no working hooks: `archi doctor`. To move without that conversation, exit the agent (it stays on this machine) and try again. |

### Terminals

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `character_pinned` | blocks | A character is marked Keep on this machine. | Turn it off on the character's card, or `archi char update <id> --no-keep-here`. |
| `shell_busy` | blocks | A terminal's shell is running a command in the foreground: a build, a server, a REPL. Also raised when that command outlives Terminate and carry. | Let it finish or stop it, or choose Terminate and carry (`--terminate-shells`), which ends it; the shell reopens in its folder on the destination. |
| `agent_working` | blocks | An agent is still in its turn after resting waited three minutes. | Continue waiting, or Interrupt and carry (`--interrupt-after <duration>`), which sends Escape; the agent resumes from its transcript. |
| `agent_blocked` | blocks | An agent is waiting on an answer, such as a permission prompt. | Answer it in its terminal and try again, or Interrupt and carry. |
| `agent_unsettled` | blocks | An agent did not come to rest within ten seconds of an interrupt or a terminate: a command it started, or a hook of your own, still runs. | Terminate and carry (`--terminate-shells`) ends what still runs in that terminal; the agent resumes from its transcript. |

### Paths and the destination

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `home_mismatch` | blocks | The destination account's home path is not the Mac's. Every path a fleet records travels unchanged, so both homes must be the same path. | Make an account there whose home is the Mac's path ([setup](setup.md#the-same-home-path)), `archi host remove <host>`, then `archi host add` at that account. |
| `parent_missing` | blocks | A folder outside the home lands at the same path on the destination, and the folder that holds it is missing there. | Create that folder on the destination, owned by the account, and try again. |
| `path_symlinked` | blocks | A folder is reached through a symbolic link. A handover carries each folder at its real path, the one Git and the agents record; on the destination, a link on the way would send it elsewhere. | On the source, use the real path the message names: `cd` there in the character's terminal, or change the context item or `home.cwd` that names the link. On the destination, remove the link. |
| `path_unsupported` | blocks | A path cannot travel as it is: it is not absolute or holds a control character, it overlaps a fleet home (whose token and keys stay on their machine), a `handover.exclude` pattern is one rsync cannot read, an exclude would leave a tracked file behind, the destination keeps this fleet's docs, agent profiles or `.env` at another path, or a destination folder cannot be written. | Follow the message: rename the file, move the character's folder out of the fleet home, fix `handover.exclude` in `fleet.json`, or make the destination folder writable. |
| `destination_occupied` | blocks | A folder already exists on the destination and no handover left it there, or the record a handover left for it cannot be used. It is never overwritten. With Archive chosen it shows as a warning instead. | Choose Archive and carry (`--archive <root>`): the folder moves to a timestamped sibling first and nothing is deleted. Or move it aside yourself. |
| `destination_diverged` | blocks | A copy on the destination changed while that machine did not own the fleet: files added, removed or changed, or a session continued there. It is never overwritten. With Archive chosen it shows as a warning instead. | Copy what you want to keep back to the source by hand and try again, or choose Archive and carry (`--archive <root>`) to set the changed copy aside. For a session, move its transcript aside on the destination. |
| `destination_no_space` | blocks | The destination has too little free space for what has to be copied. | Free space there, or leave build output out with `handover.exclude`. |
| `path_collision` | blocks | Names that differ only by case would land on a destination that does not tell them apart (a Mac), or a folder on the way is a file there. | Rename one of the files on the source, or move the file out of the way on the destination. |
| `platform_unsupported` | blocks | A repository's `.archipelago/handover.json` names platforms without the destination's, or cannot be read as `{ "platforms": ["darwin", "linux"] }`. | If the repository runs there, add the platform to the file. Otherwise close the characters working in it before a handover. |
| `rsync_unsupported` | blocks | This Mac has no rsync a handover can drive (the release's own is missing), or the other machine has none or one older than 3.x. | On the Mac, `archi doctor` checks the bundled rsync, and `pnpm desktop:install` puts it back. On Linux, `sudo apt install rsync`. |
| `manifest_too_large` | blocks | The list of files to carry comes to more than 128 MiB. | Leave generated folders out with `handover.exclude` in `fleet.json`. |

### Git

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `worktree_unresolved` | blocks | A character's Git checkout is gone, Git cannot read it, or a repository folder has no graph that describes it. | Put the folder back or close the character; `git status` in it says what Git sees. |
| `worktree_unused` | both | A warning: a registered worktree no character uses is not carried; its branch and stash travel, and its registration is left out on the destination. A blocker: that worktree holds work nothing else keeps (changes, a detached commit no branch reaches, or a lock), or a worktree that stays on the destination sits at a commit the fleet's copy would not hold. | Commit or stash its work on a branch, unlock it, or `git worktree remove` it. |
| `git_mismatch` | blocks | After the copy, the destination's Git state (worktree list, HEAD, branch, status, index or stash) differs from what the source left. Nothing has committed. | Try again, which copies again. If it repeats, compare `git status` on both machines and check the destination's git with `archi host doctor <host>`. |
| `git_extension` | blocks | A repository uses a Git extension the destination's git is too old for, or the destination has no git. | Update or install git on the destination. |
| `remote_local` | warns | A repository's `origin` names a path on the source machine. It travels as it is. | Nothing, unless you push or pull there; then point `origin` somewhere both machines reach. |

### Copying

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `external_writer` | blocks | Files kept changing through three copy passes, on the source or in the destination's copy: an editor, a build or a watcher still writes there. | Close whatever writes there, then Try again (or `archi handover --resume`). |

### Warnings

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `env_file` | warns | A carried folder holds `.env` files, which may hold secrets, or the fleet's own `.env` is copied because `handover.transferFleetEnv` is on. | Nothing, if they belong on the destination. Otherwise exclude them. |
| `platform_heuristic` | warns | A folder holds an Xcode project and the destination is Linux. | Nothing; mark the repository's platforms in `.archipelago/handover.json` to make it a blocker. |
| `symlink_dangling` | warns | Links in a carried folder will point at nothing on the destination. They are carried as they are. | Nothing, or create what they point to on the destination. |
| `config_difference` | warns | An agent CLI runs at different versions on the two machines. Each machine keeps its own login, settings, skills and MCP servers; none of them move. | Nothing; update one side to match if a session depends on it. |
| `codex_trust` | warns | Codex asks whether to trust a moved folder the first time it resumes on the destination. | Answer it in that character's terminal. |
| `claude_trust` | warns | Claude asks whether to trust a moved folder the first time it resumes on the destination, with "No, exit" preselected. | Choose "Yes, I trust this folder" in that terminal. |
| `claude_bypass` | warns | A character resumes Claude in Bypass Permissions mode, and Claude on the destination has not accepted it yet; it warns with "No, exit" preselected. | Choose "Yes, I accept" in that terminal, once for that machine. |

## Daemon refusals

What a machine's daemon answers when it will not do a call. A run shows them in its `interrupted` error; other
`archi` commands print the message.

| Code | What it means | What to do |
| --- | --- | --- |
| `not_owner` | This machine does not own the fleet; it keeps a read-only copy. | `archi` sends commands to the owner by itself (`--host` picks a machine). If this machine should own it, `archi handover status`. |
| `frozen` | The fleet is frozen for a handover, so nothing may change it. | Wait for the handover, or `archi handover status` and then `--resume` or `--abort`. |
| `handover_committed` | The handover has committed: the fleet is the destination's, and this machine stays fenced. | `archi handover --resume` finishes it on the destination. |
| `not_ready` | The step is not ready: the gateway still holds the handover open, the copy of a folder is not verified, or a freeze was asked again with other choices. | Usually passes on its own. Otherwise `archi handover status`. |
| `generation_mismatch` | The call names another generation than this machine holds: the fleet moved on. | `archi handover status`. |
| `transaction_mismatch` | The call names another handover than the one this machine or the gateway holds, or one being aborted. | `archi handover status`; `archi handover --forget` when it says superseded. |
| `blocked` | The call found blockers, listed with it. | See [Blockers and warnings](#blockers-and-warnings). |
| `authority_unreachable` | The daemon could not ask the gateway, so nothing that needs its word was done. | Check the link to the gateway (`archi host doctor <gateway>`), then do what `archi handover status` says. |

## Gateway answers

What the gateway's ownership authority answers. They appear in handover messages ("the gateway would not …"), in
`archi host enable`, `archi fleet recover` and `archi gateway owner`.

| Code | What it means | What to do |
| --- | --- | --- |
| `not_found` | The gateway holds no record of this fleet. | `archi host enable <host> --fleet <fleet>` creates it. |
| `already_exists` | The gateway already holds this fleet for another machine or at a later generation. | `archi handover status`; bring the fleet back with `archi handover local` if that is what you meant. |
| `not_owner` | The handover names a source that does not own the fleet. | `archi handover status`. |
| `generation_mismatch` | The fleet is at another generation than the request expects. | `archi handover status`. |
| `transaction_mismatch` | The fleet has another handover open, or none. | `archi handover status`. |
| `handover_committed` | The handover has committed; only its activation can go on. | `archi handover --resume`. |
| `invalid_phase` | The handover is at a step other than the one the request needs, such as ready on a different prepared state. | `archi handover status`. |
| `invalid_request` | The request is malformed, names an unknown operation or the machine that already holds the fleet, or the registry names no ssh route to the gateway. | Check `archi host list`; `archi host doctor <gateway>`. |
| `authority_corrupt` | The gateway cannot read its record of this fleet. It moves the file aside to `<file>.broken-<time>` and refuses the fleet until a readable record is back at `~/.local/share/archipelago/gateway/fleets/<fleet id>.json` on the gateway machine. | Put a readable record back (the `.broken` copy if it is valid JSON), or replace the gateway with `archi fleet recover --force-owner <machine> --gateway <other machine>`. |
| `record_changed` | `archi fleet recover` wrote against the record it showed you, and the record changed meanwhile. Nothing was written. | Run it again to see the record as it stands. |
| `internal` | The gateway failed unexpectedly. | Read `~/.local/share/archipelago/log/archipelago-gateway.log` on the gateway machine. |
| `timeout` | The gateway's socket did not answer in time. | `archi host doctor <gateway>`; `systemctl --user status archipelago-gateway` there. |
| `disconnected` | The gateway could not be reached: ssh ended without an answer, or the registry cannot be read. | Check the link, then do what `archi handover status` says. |

## How a run ends

The `handover.result` line, and what `archi handover` prints last. The command exits 0 when it did what it was asked
(a start or `--resume` that completed, an `--abort` that aborted) and 1 otherwise.

| Status | What it means | What to do |
| --- | --- | --- |
| `complete` | The fleet runs on the destination at the next generation. A character that failed to resume stays dormant with its transcript and error. `pending` names the source or the gateway when it has not yet heard that the handover finished. | Retry a failed character from its row (or revive it). With `pending`, `archi handover --resume` finishes it. |
| `none` | There was no handover to resume or abort. | Nothing. |
| `blocked` | Nothing committed, and the fleet stays where it was. The blockers are listed. | Settle them and start again; flags such as `--interrupt-after`, `--terminate-shells` and `--archive` answer the choices a person would make. |
| `aborted` | Nothing committed, and the fleet runs on the source again with the terminals the handover stopped reopened. | Start again when ready. |
| `interrupted` | The run stopped part way. `safe` lists what may follow: `resume`, `abort`, both, or neither when only the gateway can say whether the commit landed. | Do what `safe` says, or `archi handover status` once the gateway answers. |
| `detached` | You cancelled after the commit: the move goes on without anyone watching. | `archi handover attach` follows it; `archi handover status` says where it stands. |

## What `archi handover status` says

`status` prints one `handover.status` line: the standing, the phase each journal is at, what is safe and why. When a
handover helper is running on this Mac, it names its pid instead; `archi handover attach` follows it.

### Standing

| Standing | What it means | Safe |
| --- | --- | --- |
| `none` | No handover of this fleet is open anywhere. A controller journal whose Begin the gateway never took offers `--abort` to clear it. | nothing, or abort |
| `open` | A handover is open and has not committed. | resume or abort |
| `committed` | The gateway has committed; the fleet belongs to the destination and only its activation goes on. | resume |
| `moved` | The gateway closed the handover after the commit; what is left (the source's or the destination's close) only needs finishing. | resume |
| `returned` | The gateway no longer holds the handover and the source owns the fleet at its generation; an abort only needs finishing. | abort |
| `superseded` | The gateway has moved on past the handover this Mac's journal names, through another handover or a recovery. | `archi handover --forget` |
| `unknown` | The gateway cannot say whether the handover committed, or the destination's journal could not be read. Nothing is safe until the gateway answers or someone looks at that machine. | nothing |

### Action

What a `--resume` or `--abort` would do, in the `action` field.

| Action | What it does |
| --- | --- |
| `none` | Nothing: there is nothing safe to do, or nothing open. |
| `continue` | Runs the handover on from where the journals stand. |
| `finish` | Completes what a moved fleet left open. |
| `finish-abort` | Lets go of what an abort the gateway already made left behind. |

## Events

What `archi handover --json` prints, one per line. The app reads the same stream.

| Event | What it carries |
| --- | --- |
| `handover.preflight` | The checks: what the manifest holds, the blockers, the warnings and the names of the characters, folders and sessions. |
| `handover.changed` | The step the controller has moved to. |
| `handover.entity` | One character, folder or session row: its progress, a notice, or its error. |
| `handover.blocked` | A decision that waits for an answer. |
| `handover.retry` | A call that did not answer and is being asked again. |
| `handover.result` | The last line: how the run ended. |
| `handover.status` | Where the handover stands, from `status`, or from `attach` when no helper runs. |
| `handover.detached` | The only line of a `--detach` launcher: the helper's pid. |

## Connection errors

The app and `archi` reach a fleet on another machine through ssh. When that fails, the banner and the error name one of
these. Only `unreachable` and `daemon_down` are retried by themselves, backing off to every 16 seconds; the others
wait until the window is reopened.

| Kind | What it means | What to do |
| --- | --- | --- |
| `auth` | ssh was refused: no key it accepts, or a password it cannot ask for. | `ssh <host>` in a terminal; add the key to the agent. |
| `host_key` | The host key is unknown or has changed. | `ssh <host>` once and check the key. A changed key needs a look before you trust it. |
| `unreachable` | The machine did not answer, refused the connection, or the link dropped. | Check Tailscale and the machine; it reconnects by itself. |
| `version` | `archi` is missing there, cannot run, or speaks another protocol. | `archi host upgrade <host>`. |
| `daemon_down` | The fleet's daemon is not running there. | `archi host doctor <host>`; on Linux, `systemctl --user status archipelago-archid@<fleet>`. |
| `other` | Anything else, such as a machine that answers with another fleet or machine id. | Follow the message. |

## Host commands

`archi host add`, `upgrade`, `remove` and `enable` run their steps in order and stop at the first that fails. Each
step's `action` is something for you to do; the run ends with **ready for handover** or a list of what is still to
do, and exits 1 unless it is ready.

### Step statuses

| Status | What it means |
| --- | --- |
| `start` | The step began. |
| `ok` | It passed. |
| `warn` | It passed with something to do, named in its `action`. |
| `fail` | It failed; the run stops here. |
| `skip` | It did not apply. |

### Steps

| Step | Command | What it checks or does | When it fails |
| --- | --- | --- | --- |
| `name` | add | The machine name (lowercase letters, digits and dashes, starting with a letter) and the ssh destination. | Pick another name, or `archi host remove` the machine that holds it. |
| `machine` | upgrade, remove, enable | The machine is in the registry with an ssh destination. | `archi host list`; `archi host add` it. |
| `ssh` | add | An interactive ssh, so you can accept the host key and log in. | `ssh <destination>` in a terminal and complete it. |
| `master` | add, upgrade | One ssh control connection for the rest of the steps. | `ssh <destination>` and see what it answers. |
| `os` | add | Linux on x86-64 or arm64, running Ubuntu. A release other than an LTS is a warning. | Use a supported machine ([setup](setup.md#supported-machines)). |
| `home` | add | The account's home is the Mac's home path, and short enough for the gateway's socket (at most 59 bytes). | Make an account with the right home ([setup](setup.md#the-same-home-path)) and add it again. |
| `tools` | add | Tailscale, tmux, Git, rsync and systemd user services. | Run the `apt install` command the action names; without systemd the machine is not supported. |
| `tmux` | add | The tmux version. Older than 3.5 is a warning: Shift+Enter does not reach the agents. | Nothing, or install tmux 3.5 or newer. |
| `rsync` | add | The rsync version. | `sudo apt install rsync`. |
| `space` | add | Free space in the home. Under 5 GiB is a warning. | Free space. |
| `linger` | add | Whether the account's services keep running after you log out. Off is a warning. | Run the `loginctl enable-linger <user>` the action names. |
| `release` | add, upgrade | The companion release for the machine's architecture: downloaded and checked against the digest this Mac's release pins, or the archive `--release` names, with its signature. | Name an archive with `--release`; an unsigned development build needs `--allow-unsigned`. |
| `upload` | add, upgrade | Copies the companion archive to the machine. | Check free space and the link. |
| `install` | add, upgrade | The machine checks the archive against its manifest and signers, then installs it under `~/.local/share/archipelago`. | Read the message; `archi host doctor <host>`. |
| `service` | add | The daemon and gateway units run. | Read the units' logs under `~/.local/share/archipelago/log` there. |
| `identity` | add | The machine's id and protocol. | `archi host upgrade <host>` when the protocol differs. |
| `claude` | add | Claude Code on the PATH the daemon uses, its version and its login. Each finding is a warning with an action. | Install or log in as the action says. |
| `codex` | add | The same for Codex, including trusting its hooks. | As for `claude`. |
| `probe` | add, upgrade | The machine's own fleet answers through a forwarded port, from the release just installed. | An upgrade whose probe fails goes back to the release before (`rollback`). |
| `rollback` | upgrade | Puts back the release the machine ran before. | Read the daemon log there; the action names the release it runs now. |
| `registry` | add, remove | Writes or drops the machine in this Mac's registry. | Check `~/.config/archipelago` is writable. |
| `fleet` | remove, enable | remove: the fleets that name this machine as their gateway, which must all be on this Mac with no handover open. enable: gives the machine its copy of the fleet. | remove: bring each fleet back with `archi handover local` and settle open handovers first. enable: if the machine already holds another fleet under that name, move its fleet home aside and run enable again. |
| `uninstall` | remove | Runs `archi uninstall` on the machine. Its fleets and their files stay there. | `archi host remove <host> --forget` drops the route when the machine cannot be reached. |
| `authority` | enable | Creates the gateway's record naming this Mac as the owner, or finds it there already. | A record held by another machine: `archi handover status`. An unreadable one: see `authority_corrupt`. |

### Doctor checks

`archi doctor` checks the machine it runs on; `archi host doctor <host>` runs the companion's doctor on that machine
and adds what only this Mac can check. A check that fails makes the command exit 1.

| Check | Where | What it checks |
| --- | --- | --- |
| `tmux` | both | tmux is there, and 3.5 or newer for Shift+Enter. |
| `node` | both | Node 24 or newer runs `archi`. |
| `claude` | both | Claude Code's version and login. |
| `codex` | both | Codex's version and login. |
| `agents` | both | Neither agent CLI is installed (a failure on a Mac, a warning on Linux). |
| `path` | both | `~/.local/bin` is on your PATH. |
| `gh` | both | The GitHub CLI is logged in, for pull request links. |
| `config` | both | `fleet.json` and `node.json` parse, and no `config.json` is left beside them. |
| `archid` | both | The fleet's daemon runs and answers. |
| `hook receiver` | both | The daemon's hook socket answers. |
| `hooks` | both | Claude Code's settings hold Archipelago's hooks. |
| `codex hooks` | both | Codex's hooks are installed, current and trusted. |
| `systemd` | Linux | The fleet's `archipelago-archid@<fleet>` unit runs. |
| `gateway` | Linux | The `archipelago-gateway` unit runs, and names the cause when a home too long for its socket keeps it restarting. |
| `linger` | Linux, host doctor | The account's services keep running after you log out. |
| `launchd` | Mac | The fleet's launchd agent is loaded. |
| `daemon node` | Mac | The Node the launchd agent runs is still there. |
| `daemon path` | Mac | The launchd agent's program is there and its PATH finds the agents. |
| `daemon env` | Mac | The launchd agent has the `CLAUDE_CONFIG_DIR` and `CODEX_HOME` your shell sets. |
| `rsync` | Mac | The rsync the release bundles, which a handover needs. |
| `doctor` | host doctor | The companion's doctor answered. |
| `release` | host doctor | The machine runs this Mac's release and protocol. |
| `space` | host doctor | Free space in the home. |
| `home` | host doctor | The machine's home is still the Mac's home path and the one the registry records. |

## Disaster recovery

`archi fleet recover --force-owner <machine>` writes a new ownership record at the gateway when the ordinary ways
cannot: see [Recovering a fleet](handover.md#when-the-gateway-is-lost). It first shows what the gateway and every
machine hold.

### What the gateway holds

| State | What it means |
| --- | --- |
| `record` | The gateway answered with its record: who owns the fleet, at which generation, and any open handover. |
| `absent` | The gateway holds no record of this fleet. |
| `corrupt` | The gateway cannot read its record (see `authority_corrupt`). |
| `refused` | The machine answered and its authority refused or did not answer. |
| `unreachable` | The gateway could not be reached at all. |

### Results

| Result | What it means | What to do |
| --- | --- | --- |
| `recovered` | The record is written and the machine you named took it: it owns the fleet at the new generation. | Follow any `next` lines for machines that were not reached. |
| `incomplete` | The record is written, and the machine you named has not taken it yet. | Follow the `next` lines: stop the fleet where it still runs, then run the command again. |
| `refused` | Nothing was written. | Follow the message: a gateway that answered is not lost, a replacement gateway must hold no record, and the fleet id must be typed to confirm. |
