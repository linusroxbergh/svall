# Blockers, warnings and errors

Every code a handover, `svall host` or `svall fleet recover` can report: what it means and the safe way on. The test
`packages/cli/test/error-catalogue.test.ts` reads each list below from the code, and fails when the code has one this
page lacks or this page names one the code no longer has.

Where codes show up:

- **The handover sheet** shows the message the machine wrote with its code beside it and, for every code that blocks, a
  line on what to do.
- **`svall handover`** prints a blocker as `✗ <who>: <message> (<code>)` and a warning with `!`. With `--json`, each
  blocker or warning carries `code`, `message` and, when it is about one thing, `entity` (`character`, `root`,
  `session` or `git`, with its id).
- **`svall host …`** prints one line per step, and `--json` one object per step with `step`, `status`, `detail`,
  `action` and, when a command typed on the machine starts the fix, `run`.

## Before and after the commit

Two rules decide every recovery:

- **Before the commit**, the source machine still owns the fleet. Nothing runs on the destination, and Abort (or
  `svall handover --abort`) gives the fleet back to the source and reopens only the terminals the handover stopped.
  Files already copied stay on the destination as a replica for the next try.
- **At and after the commit**, the destination owns the fleet. Abort is refused, the source stays fenced, and only
  Resume (Retry in the sheet, `svall handover --resume`) goes on, on the destination. A character that fails to
  resume stays dormant with its transcript and says why.

`svall handover status` reads all four journals (this Mac's controller, the gateway's record and both daemons) and
says which of the two is safe. It changes nothing.

## Handover phases

What `handover.changed` and `status` report, in order.

| Phase | Sheet section | What happens | If it stops here |
| --- | --- | --- | --- |
| `begin` | Checks | The gateway opens the handover at the fleet's generation. | Resume or Abort. |
| `freeze` | Resting characters | The source fences every change, rests its terminals and writes the manifest. | Resume or Abort. |
| `transfer` | Transferring files and sessions | The destination claims each folder, then rsync copies folders and sessions. | Resume or Abort; a resume copies only what changed. |
| `verify` | Verifying | The copy is checked against the source. | Resume or Abort. |
| `prepare` | Verifying | The destination proves what landed and flushes it to disk, imports Git, places the sessions, flushes what the import wrote and writes the state it would run. Asked again after its Git import, it proves each folder again: against what that import left there, or what landed where the folder was copied again since. | Resume or Abort. |
| `ready` | Verifying | The gateway records that the source is frozen and the destination prepared. | Resume or Abort. |
| `commit` | Committing | The gateway moves the fleet to the destination at the next generation. | Only the gateway knows whether it landed: `status` once it answers. |
| `activate` | Resuming characters | The destination runs the fleet and resumes the terminals the handover rested. | Resume (Retry). |
| `complete` | Resuming characters | Both machines and the gateway close the handover. | Resume finishes what is left. |
| `aborted` | the section it stopped in | An abort is letting go on both machines. The source takes its fleet back first, and a machine that cannot be reached lets go at the next Abort. | Abort again finishes it. |

## Blockers and warnings

A blocker stops the handover where it is found; a warning only informs. When a blocker turns up during Checks,
nothing has started and the fleet stays where it is. One found later (while resting, transferring or verifying)
opens a decision in the sheet: fix the cause and choose Try again, pick the choice it offers, or Abort. One found
while resting gives the fleet back to the source, with the terminals the handover stopped reopened, while the
handover stays open at the gateway for the answer; later ones wait with the fleet frozen. A run in the foreground
with no terminal to ask in (`--json`, or stdin not a terminal) stops with `blocked` and gives the fleet back. A
`--detach` helper waits instead, until someone answers or cancels through `svall handover attach` or the app;
`svall handover status` names it while it runs, and offers Resume or Abort if the helper dies while it waits.

### Identity, versions and reaching the machines

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `identity_mismatch` | blocks | A machine, fleet or gateway is not the one the handover expects: the fleet names no gateway, the destination already runs the fleet, a machine or the gateway answered with another machine id, the gateway holds no record of this fleet, the destination's companion runs another fleet under this fleet's name, the gateway refused to begin from a machine that does not own the fleet, or the fleet the destination would prepare names another fleet id or gateway. | Follow the message. No gateway: `svall host enable <host> --fleet <fleet>`. Another fleet on the destination: the same command gives it a copy of this one. A machine set up again, with a new machine id, or a gateway with no record of the fleet: [A gateway set up again](handover.md#a-gateway-set-up-again). Run handovers from the Mac. |
| `generation_mismatch` | blocks | The source's copy of the ownership record and the gateway's name different generations: another handover or a recovery moved the fleet since the source last heard, or the gateway's record was made again. | `svall handover status`. With nothing open and the gateway ahead, restart the source's daemon: it takes a record with a higher generation as it starts, never a lower one. One naming another machine it also takes within five minutes while it runs. A gateway behind the source, as one [set up again](handover.md#a-gateway-set-up-again) is, needs `svall fleet recover --force-owner <machine>` naming the machine that runs the fleet (`local` for this Mac), which writes a record above both. |
| `transaction_open` | blocks | A handover of this fleet is already open: at the gateway (also when Begin finds another handover there, this one driven by another machine's controller, which the message names, or past preparing), as a journal on the destination, or as a source frozen for a handover the gateway no longer holds. | `svall handover status`, then `svall handover --resume` or `--abort`, whichever it says is safe. The sheet reads that status itself for this blocker, `generation_mismatch` and `identity_mismatch`, and when its status finds one open, offers Resume, Abort or Forget in place of a new start. |
| `incompatible_release` | blocks | The two machines run different Svall releases. A handover needs the same release on both. | `svall host upgrade <host>` installs this Mac's release there. If the host is newer, update Svall on the Mac first. |
| `incompatible_protocol` | blocks | The two machines speak different RPC protocols, or the gateway keeps its ownership records under another authority schema than this Mac's release. | As for `incompatible_release`, on the machine the message names. |
| `incompatible_schema` | blocks | The two machines read different fleet state or transfer manifest versions. | As for `incompatible_release`. |
| `linger_off` | blocks | The destination, or the source when it is the fleet's gateway, is a Linux machine whose account has lingering off: its services stop when you log out and stay down after a restart until you log in, and the fleet or its gateway with them. A gateway on neither machine is not checked here; `svall host doctor <gateway>` checks it. | Run what the message names, as `ssh <host>, then sudo loginctl enable-linger <user>`, then try again. |
| `ssh_interactive` | blocks | ssh would have to ask something (a new host key, a password, a key passphrase), and a handover asks nothing. Also raised when the source's daemon's ssh to its gateway would have to ask, refused every key it offered, or waits for a Tailscale SSH check. | Run `ssh <destination>` once in a terminal and answer it, or for the gateway, `ssh <gateway>` on the source machine. Keep a key with a passphrase in the agent (`ssh-add --apple-use-keychain` on a Mac), or install one there with `ssh-copy-id <gateway>`. For a Tailscale check, approve it in the browser. Then try again. |
| `authority_unreachable` | blocks | The source's daemon could not ask the gateway who owns the fleet, as Freeze must: its ssh or socket did not answer, its registry names no ssh route to the gateway, or the gateway failed while it began the handover. | `svall host doctor <gateway>` (**Check** in the app); on the gateway, `systemctl --user status svall-gateway`. With no route, `svall host add <gateway> --ssh <destination>`. Then try again. |
| `authority_corrupt` | blocks | The gateway cannot read its record of this fleet (see [`authority_corrupt`](#gateway-answers) under Gateway answers). Nothing can begin until it can. | Put a readable record back on the gateway (the `.broken` copy if it is valid JSON), or replace the gateway with `svall fleet recover --force-owner <machine> --gateway <other machine>` ([When the gateway is lost](handover.md#when-the-gateway-is-lost)). |

### Agents

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `agent_cli_missing` | blocks | The destination has no CLI for an agent the fleet runs, or no home to keep its sessions in, or keeps them somewhere other than where the checks found them. For OpenCode, also: either machine's daemon cannot start OpenCode, the source's to export a session (at the checks and while resting) or the destination's to check, remove or import its copy (while preparing). The message's "this machine" is that daemon's. Anything else that stops OpenCode is `transcript_missing`. | Install Claude Code, Codex or OpenCode where its daemon finds it, on the destination or, for OpenCode, on the machine that could not start it (`svall host doctor <host>` shows what a host's daemon sees), then try again. |
| `agent_logged_out` | both | The agent is not logged in on the destination: for OpenCode, `opencode auth list` there names no model provider (an MCP server's login does not count). The check runs in the destination daemon's environment with its fleet's `.env` keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) added, as a character and `svall doctor` get them; an API key exported only in a shell startup file does not reach it. Logins never move with a fleet. A warning instead for an OpenCode logged in on neither machine whose agent has answered on the source, as one on OpenCode Zen's free models does with no login. The plugin's log keeps no times, so an answer given before a logout, or on another machine, counts too; such an agent then fails its first turn on the destination as it would on the source. | `ssh <host>`, then `claude auth login`, `codex login` or `opencode auth login`, then try again: the checks ask the destination's login afresh each time. For an API key, see [An API key in your shell](setup.md#an-api-key-in-your-shell). For the warning, nothing, unless a character uses a provider's model: then `opencode auth login` there. |
| `agent_hooks_missing` | blocks | Svall's hooks, or for OpenCode Svall's plugin, are not installed for that agent on the destination, so a resumed agent could not report back. | Run `svall setup` on the destination (on Linux, `~/.local/bin/svall setup`), then trust the hooks in Codex with `/hooks`. |
| `incompatible_adapter` | blocks | An agent CLI is older than the oldest release a handover carries sessions for (Claude Code 2.1.251, Codex 0.156.0, OpenCode 2.0.22), the destination's is older than the source's (a prerelease counts as older than its release), which may write sessions it cannot read, the two machines read sessions differently, or a session holds a file that is not a regular file. | Update the CLI on the machine the message names. For a file in a session, move the file it names out of that session's folder. |
| `transcript_missing` | blocks | An agent session recorded no transcript, or its transcript is not there or is not that session's. For OpenCode, also: its OpenCode could not export the session on the source, or could not remove its earlier copy or import the session on the destination. An OpenCode session with an undo pending blocks here too, at the checks and at rest, since its import would bring the undone turns back. | An agent that never reported a transcript has no working hooks: `svall doctor`. For OpenCode, the message ends with what OpenCode said; for an undo pending, send a message or /redo in that agent, then hand over. To move without that conversation, exit the agent (it stays on this machine) and try again. |

### Terminals

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `character_pinned` | blocks | A character is marked Keep on this machine. | Turn it off on the character's card, or `svall char update <id> --no-keep-here`. |
| `shell_busy` | blocks | A terminal's shell is running a command in the foreground: a build, a server, a REPL. Also raised for a command or an agent suspended with ctrl+z, and when that command outlives Terminate and carry. | Let it finish or stop it, or bring a suspended one back with `fg`, after which an agent is waited for as usual; or choose Terminate and carry (`--terminate-shells`), which ends it; the shell reopens in its folder on the destination. |
| `agent_working` | blocks | An agent is still in its turn after resting waited three minutes. | Continue waiting, or Interrupt and carry (`--interrupt-after <duration>`), which sends Escape; the agent resumes from its transcript. |
| `agent_blocked` | blocks | An agent is waiting on an answer, such as a permission prompt. | Answer it in its terminal and try again, or Interrupt and carry. |
| `agent_unsettled` | blocks | An agent did not come to rest within ten seconds of an interrupt or a terminate: a command it started, or a hook of your own, still runs. Also raised for an idle agent that left a command running in the background, named in the message. | Let the command finish, or Terminate and carry (`--terminate-shells`), which ends what still runs in that terminal; the agent resumes from its transcript. |

### Paths and the destination

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `home_mismatch` | blocks | The destination account's home is not the one the handover was sent to, as when the machine was added at another account, or the destination cannot read its own home. | `svall host doctor <host>`; when its `home` check fails, `svall host remove <host>`, add it again and make it the gateway again, as [A gateway set up again](handover.md#a-gateway-set-up-again) describes, then start a new handover. |
| `parent_missing` | blocks | A folder outside the home lands at the same path on the destination, and the folder that holds it is missing there. | Create that folder on the destination, owned by the account, and try again. |
| `path_symlinked` | blocks | A folder is reached through a symbolic link, or is named in another case or Unicode form than the disk spells it (a Mac's disk does not tell those apart). A handover carries each folder at its real path, the one Git and the agents record; on the destination, a link on the way would send it elsewhere. | On the source, use the real path the message names: `cd` there in the character's terminal, or change the context item or `home.cwd` that names the link or the other spelling. On the destination, remove the link, or rename the folder there to the path the handover gives it, as the message says. |
| `path_unsupported` | blocks | A path cannot travel as it is: it is not absolute or holds a control character, it overlaps a fleet home (whose token and keys stay on their machine), it holds an agent's login or config (`~/.claude.json`, Claude's `.credentials.json`, Codex's `auth.json`, in the default or configured agent home) or lies in or holds an OpenCode folder (`~/.local/share/opencode`, `~/.config/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`, or where the daemon's `XDG_DATA_HOME` and `XDG_CONFIG_HOME` put them) outside the `worktree` folder in OpenCode's data folder, whose worktrees travel like any other, `~/.ssh` or Svall's own install (`~/.local/share/svall`, `~/.config/svall`, `~/.config/systemd/user`) on either machine, a `handover.exclude` pattern is one rsync cannot read, an exclude would leave a tracked file behind or part of a Git directory inside a carried folder (a branch under `build/`, a worktree named `dist`), the destination keeps this fleet's docs, agent profiles or `.env` at another path, or a destination folder cannot be written. Between different homes, also a folder in the destination's home but not this one's, a repository Git cannot move by itself ([what moves](handover.md#what-moves-and-what-stays)) or whose old place is still on the destination, or docs that already hold a repository's docs folder under the name it gets there. | Follow the message: rename the file, move the character's folder out of the fleet home, the agent's folder, OpenCode's folders or `~/.ssh`, move a repository out of the folder that carries it, fix `handover.exclude` in `fleet.json`, make the destination folder writable, make the Git path it names relative, or move the old place or docs folder it names aside. |
| `mission_control_shared` | blocks | Mission control's folder (`home.cwd`, `~/.svall/home` unless `fleet.json` says otherwise) is also another fleet's on this machine. A fleet that still has only its `config.json`, or a `fleet.json` that cannot be read, counts as using `~/.svall/home`. A handover would move it with this fleet and take it from the other. | Give one of the fleets a folder of its own: set `home.cwd` in its `fleet.json`, such as `~/.svall-work/home` for a fleet named work. Start a fleet that has only its `config.json` once so it gets a `fleet.json`, or repair the one that cannot be read. |
| `repository_unused` | blocks | A terminal is in a folder, outside any repository, that holds Git repositories no character works in, such as a shell opened in `~/Developer`. A handover would carry them with the folder. | Choose Carry the folder whole (`--carry-unused`) if they belong on the destination. Otherwise `cd` that terminal to `~` or into the repository it works on, close the character, or leave them out with `handover.exclude` in `fleet.json`, as a pattern relative to the folder such as `/old-stuff/`. |
| `destination_occupied` | blocks | A folder already exists on the destination and no handover left it there, or the record a handover left for it cannot be used. It is never overwritten. A folder that already holds exactly what the handover brings is taken as it is instead. With Archive chosen it shows as a warning instead. | Choose Archive and carry (`--archive <root>`): the folder moves to a timestamped sibling first and nothing is deleted. Or move it aside yourself. |
| `destination_diverged` | blocks | A copy on the destination changed while that machine did not own the fleet: files added, removed or changed, or a session continued there. Files an OS or editor writes on its own, such as `.DS_Store`, Git packing its refs, and a file's group or other permission bits alone, which each machine's umask sets, do not count. It is never overwritten. With Archive chosen, a changed folder shows as a warning instead; a session always blocks. | For a folder, copy what you want to keep back to the source by hand and try again, or choose Archive and carry (`--archive <root>`) to set the changed files aside, or the whole copy when more than 20 differ or one lies in a repository's `.git`. For a session, on the destination, move the file the message names aside; for an OpenCode session, run `opencode session export --standalone <id> > keep.json` to keep it, then `opencode session delete --standalone <id>`. Then try again. |
| `destination_no_space` | blocks | The destination has too little free space for what has to be copied. | Free space there, or leave build output out with `handover.exclude`. |
| `path_collision` | blocks | Names that differ only by case, or only by Unicode normalization (a composed and a decomposed `é`), would land on a destination that does not tell them apart (a Mac): two names in one folder, or two carried folders, which would land in one folder or one inside the other there. Or a folder on the way is a file there. | Rename one of the files or folders on the source, or move the file out of the way on the destination. |
| `platform_unsupported` | blocks | A repository's `.svall/handover.json` names platforms without the destination's, or cannot be read as `{ "platforms": ["darwin", "linux"] }`. | If the repository runs there, add the platform to the file. Otherwise close the characters working in it before a handover. |
| `rsync_unsupported` | blocks | This Mac has no rsync a handover can drive (the release's own is missing), or the other machine has none, openrsync, or one older than 3.2.3. | On the Mac, `svall doctor` checks the bundled rsync, and reinstalling Svall puts it back. On Linux, install rsync 3.2.3 or newer: `sudo apt install rsync` on Ubuntu 22.04 and later. |
| `manifest_too_large` | blocks | The list of files to carry comes to more than 128 MiB. | Leave generated folders out with `handover.exclude` in `fleet.json`. |
| `too_many_files` | blocks | The handover carries more files than the daemon with the smaller Node heap holds through one: half its heap at 8 KiB a file. The message names that machine, its heap and the most it holds. Node sizes the heap from the machine's memory: a Mac with 48 GB holds 274,432 files, a Linux machine with 2 GB 68,832. | Leave generated folders out with `handover.exclude` in `fleet.json`. |

### Git

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `worktree_unresolved` | blocks | A character's Git checkout is gone, Git cannot read it, or a repository folder has no graph that describes it. | Put the folder back or close the character; `git status` in it says what Git sees. |
| `worktree_unused` | both | A warning: a registered worktree no character uses is not carried; its branch and stash travel, and its registration is left out on the destination. A blocker: that worktree holds work nothing else keeps (changes, a detached commit no branch reaches, or a lock), or a worktree that stays on the destination sits at a commit the fleet's copy would not hold. | Commit or stash its work on a branch, unlock it, or `git worktree remove` it. |
| `git_mismatch` | blocks | After the copy, the destination's Git state (worktree list, HEAD, branch, status, index or stash) differs from what the source left. Nothing has committed. | Try again, which copies again. If it repeats, compare `git status` on both machines, and `git --version` on the destination. When the status differs at a file a clean filter handles (Git LFS, git-crypt, nbstripout), the destination's git lacks that filter: set it up there, such as with `git lfs install`, then Try again. |
| `git_extension` | blocks | A repository uses a Git extension the destination's git is too old for, or the destination has no git. | Update or install git on the destination. |
| `remote_local` | warns | A repository's `origin` names a path on the source machine. It travels as it is. | Nothing, unless you push or pull there; then point `origin` somewhere both machines reach. |
| `git_config_command` | both | A repository's own config names a command git runs: a clean, smudge or process filter, an fsmonitor hook, or `core.sshCommand`, in its config, a file that includes, a worktree's config or the config of any submodule a checkout holds, a linked worktree's and a nested one's included. A warning: it travels with the repository, and git on the other machine runs it there. A blocker, at the checks and again before any git runs in the copy: the machine the fleet goes to does not set the same filter or fsmonitor hook in its global or system config (an ssh command only warns, as the handover never fetches or pushes). The checks read that config in the repository already there, so an include conditional on its path applies; for one not there yet they cannot, and say so, and prepare checks again once it lands. The handover's own git runs no fsmonitor or hook. | For the warning, make sure the command is one you want run on the other machine. For the blocker, set each command up the same in that machine's global config (`git config --global <key> '<command>'`, as `git lfs install` does for Git LFS), then Try again; or abort, remove it from the repository with `git config --unset <key>`, and hand over again. `nbstripout --install` writes the path of its own Python into the repository's config, which no global config on the other machine matches: run `nbstripout --uninstall` in the repository and `nbstripout --install --global` on both machines. |

### Copying

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `external_writer` | blocks | A carried folder's or an agent session's files kept changing through three copy passes, on the source or in the destination's copy: an editor, a build or a watcher still writes there. What a pass after the first replaced or deleted in a folder's copy is kept beside it in `<folder>.overwritten-<handover id>`, a subfolder for each pass. | Close whatever writes there, then Try again (or `svall handover --resume`). For a carried folder, also choose Archive and carry (`--archive <root>`): its copy on the destination holds what no pass verified, so Try again alone reports `destination_diverged` for it. A session needs no Archive. |

### Warnings

| Code | Kind | What it means | What to do |
| --- | --- | --- | --- |
| `env_file` | warns | A carried folder holds `.env` files, which may hold secrets, or the fleet's own `.env` is copied because `handover.transferFleetEnv` is on. | Nothing, if they belong on the destination. Otherwise exclude them. |
| `credential_file` | warns | A carried folder holds, or a carried file is, a login another tool keeps in plain text: `.netrc`, `.git-credentials`, gh's `hosts.yml`, AWS's `credentials` or Docker's `config.json`. It is copied to the destination as it is. | Nothing, if that login belongs on the destination. Otherwise exclude it, or work from a folder that does not hold it. |
| `platform_heuristic` | warns | A folder holds an Xcode project and the destination is Linux. | Nothing; mark the repository's platforms in `.svall/handover.json` to make it a blocker. |
| `symlink_dangling` | warns | Links in a carried folder will point at nothing on the destination. They are carried as they are. | Nothing, or create what they point to on the destination. |
| `config_difference` | warns | An agent CLI runs at a newer release on the destination than on the source (an older one blocks with `incompatible_adapter`). Each machine keeps its own login, settings, skills and MCP servers; none of them move. | Nothing; update the source to match if a session depends on it. |
| `codex_trust` | warns | Codex asks whether to trust a moved folder the first time it resumes on the destination. | Answer it in that character's terminal. |
| `codex_sandbox` | warns | Codex on the destination cannot sandbox the commands it runs, so a Codex character there asks before each command. Usually AppArmor keeps bwrap from making the user namespace Codex runs each command in, as Ubuntu 24.04 does by default; any other failure of `codex sandbox -- true` there is named as it is. | For AppArmor, run the commands the message names on the destination, which install Codex's documented AppArmor profile for bwrap; `svall host doctor <host>` names them too. Otherwise run `codex sandbox -- true` there to see why. |
| `claude_trust` | warns | Claude asks whether to trust a moved folder the first time it resumes on the destination, with "No, exit" preselected. | Choose "Yes, I trust this folder" in that terminal. |
| `claude_bypass` | warns | A character resumes Claude in Bypass Permissions mode, and Claude on the destination has not accepted it yet; it warns with "No, exit" preselected. | Choose "Yes, I accept" in that terminal, once for that machine. |

## Daemon refusals

What a machine's daemon answers when it will not do a call. A run shows them in its `interrupted` error; other
`svall` commands print the message.

| Code | What it means | What to do |
| --- | --- | --- |
| `not_owner` | This machine does not own the fleet; it keeps a read-only copy. A machine whose `~/.config/svall/machine.json` was made on other hardware, as a backup restore, Migration Assistant or a dotfile sync copies it, shares that machine's id: while a gateway holds the fleet its daemon starts read-only, asks the gateway nothing, and answers this to every change, handover and recovery, with a message naming the file. | `svall` sends commands to the owner by itself (`--host` picks a machine). If this machine should own it, `svall handover status`. A message naming `machine.json`: move that file aside and restart svalld, so this machine mints its own id, then `svall host add` it again from the controller. On the controller Mac itself, as after Migration Assistant, `svall fleet recover --force-owner local` then runs the fleet there. On the machine the file was made on, after its hardware changed (a new logic board, Linux reinstalled with `/home` kept), `svall doctor --rebind` at a terminal binds the file to it instead. |
| `frozen` | The fleet is frozen for a handover, so nothing may change it. | Wait for the handover, or `svall handover status` and then `--resume` or `--abort`. |
| `handover_committed` | A handover has committed the fleet to another machine, and this machine stays fenced with a read-only copy. A machine a handover moved the fleet away from answers this rather than `not_owner`. | As for `not_owner`. While that handover is still open, `svall handover --resume` finishes it on the destination. |
| `not_ready` | The step is not ready: the gateway still holds the handover open, the copy of a folder is not verified, or a freeze was asked again with other choices. | Usually passes on its own. Otherwise `svall handover status`. |
| `generation_mismatch` | The call names another generation than this machine holds: the fleet moved on. | `svall handover status`. |
| `transaction_mismatch` | The call names another handover than the one this machine or the gateway holds, or one being aborted, or a claim or prepare comes from another controller than the one driving the handover, which the message names. | `svall handover status`; `svall handover --forget` when it says superseded. A handover another machine's controller drives goes on there. |
| `blocked` | The call found blockers, listed with it. | See [Blockers and warnings](#blockers-and-warnings). |
| `authority_unreachable` | The daemon could not ask the gateway, so nothing that needs its word was done. | Check the link to the gateway (`svall host doctor <gateway>`), then do what `svall handover status` says. |

## Gateway answers

What the gateway's ownership authority answers. They appear in handover messages ("the gateway would not …"), in
`svall host enable`, `svall fleet recover` and `svall gateway owner`.

| Code | What it means | What to do |
| --- | --- | --- |
| `not_found` | The gateway holds no record of this fleet. | `svall host enable <host> --fleet <fleet>` creates it. |
| `already_exists` | The gateway already holds this fleet for another machine or at a later generation. | `svall handover status`; bring the fleet back with `svall handover local` if that is what you meant. |
| `not_owner` | The handover names a source that does not own the fleet. | `svall handover status`. |
| `generation_mismatch` | The fleet is at another generation than the request expects. | `svall handover status`. |
| `transaction_mismatch` | The fleet has another handover open, or none; a Begin finds it driven by another machine's controller, which the message names; or a Begin arrives for a handover already let go. | `svall handover status`. |
| `handover_committed` | The handover has committed; only its activation can go on. | `svall handover --resume`. |
| `invalid_phase` | The handover is at a step other than the one the request needs, such as ready on a different prepared state. | `svall handover status`. |
| `invalid_request` | The request is malformed, names an unknown operation or the machine that already holds the fleet, or the registry names no ssh route to the gateway. | Check `svall host list`; `svall host doctor <gateway>`. |
| `identity_mismatch` | The registry's ssh route to the gateway now reaches another machine, one whose `svall version --json` names another machine id or none. Nothing it answers is taken. | Point the ssh destination back at the gateway. A gateway set up again, with a new machine id: [A gateway set up again](handover.md#a-gateway-set-up-again). |
| `authority_corrupt` | The gateway cannot read its record of this fleet. It moves the file aside to `<file>.broken-<time>` and refuses the fleet until a readable record is back at `~/.local/share/svall/gateway/fleets/<fleet id>.json` on the gateway machine. | Put a readable record back (the `.broken` copy if it is valid JSON), or replace the gateway with `svall fleet recover --force-owner <machine> --gateway <other machine>`. |
| `record_changed` | `svall fleet recover` wrote against the record it showed you, and the record changed meanwhile. Nothing was written. | Run it again to see the record as it stands. |
| `internal` | The gateway failed unexpectedly. | Read `~/.local/share/svall/log/svall-gateway.log` on the gateway machine. |
| `timeout` | The gateway's socket did not answer in time. | `svall host doctor <gateway>`; `systemctl --user status svall-gateway` there. |
| `disconnected` | The gateway could not be reached: ssh ended without an answer, or the registry cannot be read. | Check the link, then do what `svall handover status` says. |

## How a run ends

The `handover.result` line, and what `svall handover` prints last. The command exits 0 when it did what it was asked
(a start or `--resume` that completed, an `--abort` that aborted, a `--check` that found nothing in the way) and 1 otherwise. `--detach` exits 0 once the helper
listens, or as the run did if it ended first. `attach` exits 0 once the run it follows ends, whatever its result.
`status` exits 0 whenever it could say where the handover stands, `unknown` included. `--forget` exits 0 only when it
dropped the journal.

| Status | What it means | What to do |
| --- | --- | --- |
| `complete` | The fleet runs on the destination at the next generation. A character that failed to resume stays dormant with its transcript and error. `pending` names the source or the gateway when it has not yet heard that the handover finished. | Retry a failed character from its row (or revive it). With `pending`, `svall handover --resume` finishes it; a source the machine that ran it has no route to, as the Linux machine has none to the Mac, finishes from its own `svall handover --resume`. |
| `none` | There was no handover to resume or abort. | Nothing. |
| `blocked` | Nothing committed, and the fleet stays where it was. The blockers are listed. | Settle them and start again; flags such as `--interrupt-after`, `--terminate-shells` and `--archive` answer the choices a person would make. |
| `aborted` | Nothing committed, and the fleet runs on the source again with the terminals the handover stopped reopened. | Start again when ready. |
| `interrupted` | The run stopped part way. `safe` lists what may follow: `resume`, `abort` or both; when it lists neither, `stop` says why (below). Where `error` says it plainly, `detail` keeps what the journals said. | Do what `safe` says, or what the `stop` row says. |
| `detached` | You cancelled after the commit: the move goes on without anyone watching. | `svall handover attach` follows it; `svall handover status` says where it stands. |
| `ready` | A `--check` found nothing that stops a handover, and began nothing. | `svall handover <machine>` moves the fleet; in the app, Move. |

## Why nothing is safe

The `stop` of an `interrupted` run whose `safe` is empty.

| Stop | What it means | What to do |
| --- | --- | --- |
| `commit_unknown` | The commit was sent and no answer settled whether it landed. The source stays frozen. | `svall handover status` once the gateway answers; it then offers resume or abort. |
| `gateway_unknown` | The gateway could not be asked, so whether the handover committed is unknown. | Check the link to the gateway (`svall host doctor <gateway>`), then `svall handover status`. |
| `journal_lost` | After the commit, the destination's handover journal could not be read, so whether it activated is unknown. `detail` names the file it was moved to. | On the destination, put the file back and restart the fleet's daemon, then `svall handover --resume`; or `svall fleet recover --force-owner <machine>`. |
| `superseded` | The gateway has moved the fleet on past this handover, through another handover or a recovery. | `svall handover --forget`. |
| `elsewhere` | The handover is between two other machines, or names one this machine has no route to. | `--resume` or `--abort` on the machine the error names. |
| `running` | Another run of a handover of this fleet holds this machine. | `svall handover attach` follows it. |
| `not_begun` | The checks failed before Begin, such as a machine or the gateway that did not answer, so nothing is open. | Fix what the error names, then start again. |
| `invalid` | The command could not run as asked: its arguments, a fleet that names no gateway, or a machine not in the registry. | Fix what the error names and run it again. |
| `unexpected` | Something no step expects failed. | `svall handover status` says where it stands. |

## What `svall handover status` says

`status` prints one `handover.status` line: the standing, the phase each journal is at, what is safe and why. When a
handover helper is running on this Mac, it names its pid instead; `svall handover attach` follows it.

### Standing

| Standing | What it means | Safe |
| --- | --- | --- |
| `none` | No handover of this fleet is open anywhere. A controller journal whose Begin the gateway never took offers `--abort` to clear it. | nothing, or abort |
| `open` | A handover is open and has not committed. On the machine whose controller did not begin it, the reason names the one that did, where it goes on. | resume or abort; on the Linux machine, for a handover the Mac began, nothing |
| `committed` | The gateway has committed; the fleet belongs to the destination and only its activation goes on. With the destination's journal unreadable, nothing is safe: the reason names the file it was moved to and the ways out. On a source with no route to the destination, as the Linux machine has none to the Mac, nothing is safe there either: the reason names the destination, where it goes on. | resume, or nothing |
| `moved` | The gateway closed the handover after the commit; what is left (the source's or the destination's close) only needs finishing. With the destination's journal unreadable, as for `committed`. Once three resumes could not reach a source that is all that is left, the reason offers `svall handover --forget --source`, which gives up its side. | resume, or nothing |
| `returned` | The gateway no longer holds the handover and the source owns the fleet at its generation; an abort only needs finishing. | abort |
| `superseded` | The gateway has moved on past the handover this Mac's journal names, through another handover or a recovery. | `svall handover --forget` |
| `unknown` | The gateway cannot say whether the handover committed, or could not be asked and no journal here names a handover. Nothing is safe until it answers: `svall host doctor <gateway>` says why it does not, and for one gone for good, [When the gateway is lost](handover.md#when-the-gateway-is-lost). | nothing |

### Action

What a `--resume` or `--abort` would do, in the `action` field.

| Action | What it does |
| --- | --- |
| `none` | Nothing: there is nothing safe to do, or nothing open. |
| `continue` | Runs the handover on from where the journals stand. |
| `finish` | Completes what a moved fleet left open. |
| `finish-abort` | Lets go of what an abort the gateway already made left behind. |

## Events

What `svall handover --json` prints, one per line. The app reads the same stream.

| Event | What it carries |
| --- | --- |
| `handover.preflight` | The checks: what the manifest holds, the blockers, the warnings and the names of the characters, folders and sessions. |
| `handover.changed` | The step the controller has moved to. |
| `handover.entity` | One character, folder or session row: its progress, a notice, its error, for an archived folder where the old copy is kept (`archivedTo`), and for a folder or session the destination has verified, `verified`. |
| `handover.blocked` | A decision that waits for an answer, with the choices the run holds so far, which an answer builds on. |
| `handover.retry` | A call that did not answer and is being asked again. |
| `handover.result` | The last line: how the run ended. |
| `handover.status` | Where the handover stands, from `status`, or from `attach` when no helper runs. |
| `handover.detached` | The only line of a `--detach` launcher: the helper's pid. |

## Connection errors

The app and `svall` reach a fleet on another machine through ssh. When that fails, the error names one of these, and
the banner says it in one sentence naming the machine, with what it said under **Details**. Only `unreachable` and
`daemon_down` are retried by themselves: the app backs off to every 16 seconds for as long as the window is open, and
a `svall` command tries five times, waiting up to 8 seconds between tries. The others wait for **Reconnect** in the
banner, for the window to be reopened or for the command to run again. The banner offers **Check**
(`svall host doctor`) for a machine whose daemon is down or that failed for another reason, and says so too when the
far daemon has not answered a minute after its route opened. When the gateway or the app's connection helper did not
answer and the gateway has never named an owner to this Mac, the banner offers **Open this Mac's copy**, while this
Mac's daemon runs; that daemon takes a change only while its own record says this Mac owns the fleet, and
**Reconnect** keeps the copy open until the fleet is found. When the app's own connection helper stops, cannot start or
has not answered, the banner says it has not said where the fleet runs, with **Reconnect**.

| Kind | What it means | What to do |
| --- | --- | --- |
| `auth` | ssh was refused: no key it accepts, a password it cannot ask for, or a Tailscale SSH check waiting on the browser. | `ssh <host>` once in Terminal; add the key to the agent, or approve Tailscale's check; then **Reconnect**. |
| `host_key` | The host key is unknown or has changed. | `ssh <host>` once in Terminal and check the key, then **Reconnect**. A changed key needs a look before you trust it. |
| `unreachable` | The machine did not answer, refused the connection, or the link dropped. | Check Tailscale and the machine; it reconnects by itself. |
| `version` | `svall` is missing there, cannot run, or speaks another protocol. | `svall host upgrade <host>`. |
| `daemon_down` | The fleet's daemon is not running there. | `svall host doctor <host>`; on Linux, `systemctl --user status svall-svalld@<fleet>`. |
| `other` | Anything else, such as a machine that answers with another fleet or machine id. | Follow the message. |

A window opens a fleet with no gateway in `fleet.json` on this Mac at once. For one with a gateway, it waits up to 10
seconds for the connection helper to say where the fleet is; a helper that has not answered by then, as one stuck on
ssh, leaves the window on this Mac when the route `svall` last cached names this Mac at the generation its daemon
holds, and otherwise shows kind `helper`: "the connection helper has not answered in 10 s". A window left on this
Mac shows none of the helper's retries, and moves, terminals and all, once the helper names where the fleet is.

## Host commands

`svall host add`, `upgrade` (and `upgrade --rollback`), `remove` and `enable` run their steps in order and stop at the
first that fails. Each
step's `action` is something for you to do; the run ends with a line saying what it did (`enable` with **ready for
handover**) or a list of what is still to do, and exits 1 unless nothing is left.

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
| `name` | add | The machine name (lowercase letters, digits and dashes, starting with a letter, and not `local`, `on`, `off`, `status` or `attach`, which `svall handover` takes as its own) and the ssh destination. | Pick another name, or `svall host remove` the machine that holds it. |
| `machine` | upgrade, upgrade --rollback, remove, enable | The machine is in the registry with an ssh destination. For enable, the fleet's `fleet.json` names no other gateway the registry still holds, since that one may still hold the fleet, and a fleet with no gateway has an `owner.json` naming this Mac: a daemon that could not read `~/.config/svall` runs as the machine its `owner.json` names. | `svall host list`; `svall host add` it. If the gateway it names is gone for good, `svall fleet recover --force-owner local --gateway <name>` makes that machine the gateway, or `svall fleet recover --force-owner local` leaves the fleet with none; then enable again. For an `owner.json` naming another machine, quit Svall and open it on the fleet again, so its daemon starts as this Mac; then enable again. |
| `ssh` | add | An interactive ssh, so you can accept the host key and log in. A failure names ssh's exit and the last of what it said. | `ssh <destination>` once in Terminal and complete it, then add the machine again. |
| `master` | add, upgrade, upgrade --rollback | One ssh control connection for the rest of the steps, which asks nothing: Svall needs a key ssh can use without asking, and a password gets only past the `ssh` step. For an upgrade, with or without `--rollback`, and an add of a name already in the registry, the machine it reaches must be the one the registry names. | `ssh <destination>` and see what it answers. A refused login: install a key with `ssh-copy-id <destination>` and keep its passphrase in the agent (`ssh-add --apple-use-keychain`), then add the machine again. A destination that now reaches another machine: point it back, or `svall host remove <name> --forget`. |
| `os` | add, upgrade | Linux on x86-64 or arm64, running Ubuntu 22.04 or newer. A release other than an LTS is a warning. | Use a supported machine ([setup](setup.md#supported-machines)). |
| `home` | add | The account's home is short enough for the gateway's socket (at most 65 bytes). | Use an account with a shorter home ([setup](setup.md#home-paths)) and add it again. |
| `tools` | add | Tailscale, Git, rsync and systemd user services. | Run the `apt install` command the action names; without systemd the machine is not supported. |
| `rsync` | add | The rsync version. Openrsync or one older than 3.2.3 is a warning, and a handover then stops with `rsync_unsupported`. | Install rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship (`sudo apt install rsync`). |
| `space` | add | Free space in the home. Under 5 GiB is a warning. | Free space. |
| `linger` | add | Whether the account's services keep running after you log out. Off, `host add` turns it on; where the system refuses, it is a warning here, and blocks a handover to the machine, or from it while it is the gateway, with `linger_off`. | Run the `sudo loginctl enable-linger <user>` the action names. |
| `release` | add, upgrade | The companion release for the machine's architecture: the one Svall.app carries or its release names, checked against the digest this Mac's release pins, or the archive `--release` names, with its signature. | Name an archive with `--release`; an unsigned development build needs `--allow-unsigned`. |
| `upload` | add, upgrade | Copies the companion archive to the machine. | Check free space and the link. |
| `install` | add, upgrade | The machine checks the archive against its manifest and, where a release is installed, the signers that release pins, then installs it under `~/.local/share/svall`. | Read the message; `svall host doctor <host>`. |
| `tmux` | add | The tmux the units start, on their `PATH`: the one the release brings, or for a release that carries none, the machine's. Older than 3.5 is a warning: Shift+Enter does not reach the agents. None at all stops the add. | For a release that carries none, `sudo apt install tmux`, as the action names. |
| `service` | add | The daemon and gateway units run. | Read the units' logs under `~/.local/share/svall/log` there. |
| `identity` | add | The machine's id, that it runs the release just installed, and that it speaks this Mac's protocol. For a name already in the registry, the id must be the one it records, which catches a machine that had no `svall` for the `master` step to ask. | `ssh <destination>` and run `~/.local/bin/svall version --json` to see what it answers, then add the machine again. Another machine at the destination: point it back, or `svall host remove <name> --forget` and add it again. Another release than the one installed: its setup went back to the release it ran, as the new release's daemon did not answer. Read the daemon log there, then `svall host upgrade <name>` for a machine already in the registry, or add the machine again. |
| `claude` | add | Claude Code on the PATH the daemon uses, its version (2.1.251 or newer), its login, and, once logged in, Svall's hooks as the machine's doctor finds them. Each finding is a warning with an action. | Install, update, log in or set up the hooks as the action says. |
| `codex` | add | The same for Codex (0.156.0 or newer). When it is not logged in, the action also says to trust Svall's hooks once with `/hooks`. | As for `claude`. |
| `opencode` | add | The same for OpenCode (2.0.22 or newer), its login a model provider's that `opencode auth list` names, with Svall's OpenCode plugin as the machine's doctor finds it. | As for `claude`. |
| `probe` | add, upgrade, upgrade --rollback | add: the machine's own fleet answers through a forwarded port from the release just installed, its gateway authority answers, and tmux opens a window, on a socket of its own with the units' PATH, and closes it. upgrade, with or without `--rollback`: the machine's doctor answers with its daemon and gateway units running, and its fleet answers from the release now current. | An add stops here. An upgrade whose probe fails goes back to the release before (`rollback`). After `--rollback`, read the daemon log there; the action names the release it runs now. |
| `rollback` | upgrade, upgrade --rollback | Puts back the release the machine ran before, or the kept release `--rollback <release>` names. The machine's own `svall setup --rollback` restarts its units and checks each fleet's daemon answers from that release. `--rollback` first refuses, changing nothing, when a fleet's `state.json` there is at a newer state schema than that release reads, whose daemon would then refuse to start; or, for a release whose `svall version --json` names no schema, newer than the oldest any release has read. It refuses too when that release carries no tmux and a fleet's tmux server there runs another version than the machine's own tmux, which that release would run and which cannot reach it. | Read the daemon log there; the action names the release it runs now, and when the rollback failed, `svall host upgrade <host> --rollback <release>` to put back another release kept there. Refused for a newer state, or for a tmux server, the machine stays on the release it runs: keep it, or go back to a release that reads that schema or carries a tmux. |
| `registry` | add, remove | Writes or drops the machine in this Mac's registry. | Check `~/.config/svall` is writable. |
| `fleet` | remove, enable | remove: the fleets that name this machine as their gateway, which must all be on this Mac, no fleet this machine owns through any gateway, and no handover open on any fleet here, whatever its gateway. enable: gives the machine its copy of the fleet. | remove: bring each fleet back with `svall handover local` and settle open handovers first. enable: if the machine already holds another fleet under that name, move its fleet home aside and run enable again. |
| `uninstall` | remove | Runs `svall uninstall` on the machine, once it has checked the ssh destination reaches the machine the registry names, with `--force-fleet` for each fleet the `fleet` step found naming it as their gateway. That passes only those fleets' gateway records, so the machine still refuses, and the step fails with its reason, for anything else uninstalling would strand: another Mac's fleet records, a record left by a fleet that no longer names it, a fleet it runs for its gateway, or an open handover. Its fleets, their files and the gateway's records stay there. With `--forget` it is skipped and the machine is left untouched. | Another failure names the exit and what `svall uninstall` said: `ssh <destination>` and run it to see what stops it. A refusal: on each other Mac whose fleet it names, bring that fleet home with `svall handover local` and run `svall host remove <host> --forget`; then `ssh <destination>`, run `svall uninstall --force`, and `svall host remove <host> --forget` here. `svall host remove <host> --forget` drops the route when the machine cannot be reached, or the destination now reaches another machine. |
| `authority` | enable | Checks the ssh destination reaches the machine the registry names, then creates the gateway's record naming this Mac as the owner, or finds it there already. | A record held by another machine: `svall handover status`. An unreadable one: see `authority_corrupt`. Another machine at the destination: as for `master`. |

### Doctor checks

`svall doctor` checks the machine it runs on; `svall host doctor <host>` runs the companion's doctor on that machine
and adds what only this Mac can check. A check that fails makes the command exit 1.

| Check | Where | What it checks |
| --- | --- | --- |
| `tmux` | both | tmux is there, and 3.5 or newer for Shift+Enter. |
| `node` | both | Node 24 or newer runs `svall`. |
| `claude` | both | Claude Code's login, and for a fleet that hands over its version: 2.1.251 or newer. A fleet hands over once its `fleet.json` names a gateway or turns handover on, and every fleet on Linux does. |
| `codex` | both | Codex's version and login. |
| `opencode` | both | OpenCode's version and login: a model provider's login or key, as `opencode auth list` names it and a handover's checks read it. |
| `agents` | both | No agent CLI is installed (a failure on a Mac, a warning on Linux). |
| `path` | both | `~/.local/bin` is on your PATH. |
| `shims` | both | The `svall` in `~/.local/bin` runs this build. |
| `gh` | both | The GitHub CLI is logged in, for pull request links. |
| `config` | both | `fleet.json` and `node.json` parse, and no `config.json.bak` is in the way of a split. It warns of a `config.json` beside `fleet.json`, which the daemon moves aside unread as it starts. |
| `machine id` | both | `~/.config/svall/machine.json` was made on this machine's hardware (the Mac's IOPlatformUUID, Linux's `/etc/machine-id`, both kept as a hash). It warns of one copied from another machine, which gives this one that machine's id. `svall doctor --rebind`, at a terminal outside any fleet's panes, binds the file to this machine after its own hardware changed. |
| `svalld` | both | The fleet's daemon runs and answers. |
| `hook receiver` | both | The daemon's hook socket answers. |
| `hooks` | both | Claude Code's settings hold Svall's hooks. |
| `codex hooks` | both | Codex's hooks are installed, current and trusted. |
| `opencode plugin` | both | Svall's OpenCode plugin is installed and current, in the config folder the daemon's `XDG_CONFIG_HOME` names. |
| `systemd` | Linux | The fleet's `svall-svalld@<fleet>` unit runs. |
| `gateway` | Linux | The `svall-gateway` unit runs, and names the cause when a home too long for its socket keeps it restarting. |
| `linger` | Linux, host doctor | The account's services keep running after you log out. |
| `launchd` | Mac | The fleet's launchd agent is loaded. |
| `launchd plist` | Mac | The fleet's launchd plist runs this build. |
| `daemon node` | Mac | The Node the launchd agent runs is still there. |
| `daemon path` | Mac | The launchd agent's program is there and its PATH finds the agents. |
| `daemon env` | both | The fleet's launchd agent, or on Linux its systemd unit, has the `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` your login shell sets. |
| `rsync` | Mac | For a fleet that hands over, the rsync the release bundles, which a handover needs. |
| `doctor` | host doctor | The companion's doctor answered. |
| `release` | host doctor | The machine runs this Mac's release and protocol. |
| `space` | host doctor | Free space in the home. |
| `home` | host doctor | The machine's home is still the one the registry records. |

## Disaster recovery

`svall fleet recover --force-owner <machine>` writes a new ownership record at the gateway when the ordinary ways
cannot, or with the only gateway gone, this Mac's own record with no gateway: see
[When the gateway is lost](handover.md#when-the-gateway-is-lost). It first shows what the gateway and every machine
hold.

### What the gateway holds

| State | What it means |
| --- | --- |
| `record` | The gateway answered with its record: who owns the fleet, at which generation, and any open handover. |
| `absent` | The gateway holds no record of this fleet. |
| `corrupt` | The gateway cannot read its record (see `authority_corrupt`). |
| `refused` | The machine answered and its authority refused or did not answer. One that did not answer is down, not lost: `systemctl --user start svall-gateway` there starts it. |
| `unreachable` | The gateway could not be reached at all. `--force-owner local` then runs the fleet on this Mac alone, with no gateway; `--gateway <machine>` names another machine to take its place. |

### Results

| Result | What it means | What to do |
| --- | --- | --- |
| `recovered` | The record is written and the machine you named took it: it owns the fleet at the new generation, or with no gateway, runs it alone. | Follow any `next` lines for machines that were not reached. |
| `incomplete` | The record is written, and the machine you named has not taken it yet. Run alone with this Mac's daemon down, `owner.json` and `fleet.json` are written and the daemon takes them when it starts; with another machine holding a handover that did not take the record, this Mac is not yet told; with `fleet.json` that could not be changed to name no gateway, this Mac runs the record and `fleet.json` still names the lost gateway. A machine that cannot reach the gateway itself never takes a record that makes it the owner. | Follow the `next` lines: stop the fleet where it still runs, or start this Mac's daemon, then run the command again where it says so. |
| `refused` | Nothing was written. | Follow the message: a gateway that answered is not lost, a replacement gateway must hold no record, a machine that answers that it runs the fleet is not lost either, a handover journal on this Mac waits for its daemon, a fleet that names no gateway needs `--gateway <machine>`, one that answers, and the fleet id must be typed to confirm, by a person at a terminal outside any fleet's agents and tmux panes. |
