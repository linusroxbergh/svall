# Blockers, warnings and errors

Every code `svall host`, `svall doctor` and a command run with `--host` can report: what it means and the safe way
on. The test `packages/cli/test/error-catalogue.test.ts` reads each list below from the code, and fails when the code
has one this page lacks or this page names one the code does not have. What stops a move is in [the
checks](placement.md#the-checks).

`svall host …` prints one line per step, and `--json` one object per step with `step`, `status`, `detail`, `action`
and, when a command typed on the machine starts the fix, `run`.

## Connection errors

`svall --host <machine> <command>` runs the command against the fleet's daemon on that machine, reached through ssh.
When that fails, the error names one of these. Only `unreachable` and `daemon_down` are retried by themselves: `svall`
tries five times, waiting up to 8 seconds between tries. The others wait for the command to run again.

| Kind | What it means | What to do |
| --- | --- | --- |
| `auth` | ssh was refused: no key it accepts, a password it cannot ask for, or a Tailscale SSH check waiting on the browser. | `ssh <host>` once in Terminal; add the key to the agent, or approve Tailscale's check; then run the command again. |
| `host_key` | The host key is unknown or has changed. | `ssh <host>` once in Terminal and check the key, then run the command again. A changed key needs a look before you trust it. |
| `unreachable` | The machine did not answer, refused the connection, or the link dropped. | Check Tailscale and the machine; `svall` tries again by itself. |
| `version` | `svall` is missing there, cannot run, or speaks another protocol. | `svall host upgrade <host>`. |
| `daemon_down` | The fleet's daemon is not running there. | `svall host doctor <host>`; on Linux, `systemctl --user status svall-svalld@<fleet>`. |
| `other` | Anything else, such as a machine that answers with another fleet or machine id. | Follow the message. |

## Host commands

`svall host add`, `upgrade` (and `upgrade --rollback`) and `remove` run their steps in order and stop at the first that
fails. Each step's line says how a thing stands; its `action` is something for you to do, and its `raw` what a tool
said, which a terminal prints dim under a step that failed or warned. A run ends in three tiers: the rows that need you,
in full, then "! <N> notes" and "✓ <N> checks fine", a line each. A row needs you when it failed; of the warnings, in an
add those on `linger`, `release`, `worker`, `service`, `systemd`, `versions`, `hooks`, `codex hooks` and `opencode plugin`,
and on an agent the fleet runs (its main agent, its scribe's or a robot's); in an upgrade, rollback or remove every one.
Then one line: "<name> is ready" or "<name> has <N> things to fix" for an add or an upgrade, the latter too for an
upgrade that stopped or an add that stopped once the machine was listed; "Add machine did not finish" (or Upgrade, Roll
back, Remove) for any other run that stopped, else what it did; an add or an upgrade then
counts the parts of [your agent setup](setup.md#your-agent-setup-on-the-machine) not on the machine yet, which `svall
host doctor <host> --all` lists. Each exits 1 while a row needs you; the agent setup never stops a robot moving there,
so it leaves the exit at 0. The JSON result's `actions` are each step's action, and its `setup` the `mirror:<key>` steps
of what will not work there.

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
| `relay` | add, doctor, consent, upgrade, upgrade --rollback, remove | A worker of a far home goes by way of that home. This step ends a run the home did not take: it did not answer, it answered as another machine or as no home of this fleet, it has no Svall, it did not take the archive this CLI carries for another architecture, it runs another release than this CLI's archive, the connection went away (what it was doing may still finish there), or the command died with nothing said, whose stderr it quotes. On a run that copies that archive, an `ok` row says it is on the home. | Try again once it answers. Another machine or fleet: check where the `homeSsh` of this fleet's `worker.json` leads and which machine holds the fleet. Another release: upgrade the home under Machines, or update Svall on this Mac. |
| `name` | add | The machine name (lowercase letters, digits and dashes, starting with a letter, and neither `local`, the alias for the machine in hand, nor this Mac's own name) and the ssh destination. On a machine that is itself a worker of this fleet, or is leaving it for another, it refuses before anything is reached: only the home takes or removes a worker. While another add, upgrade, rollback or remove of that machine runs here, it refuses: "is being added or upgraded by another run". | Pick another name; `svall host remove` frees a name another machine holds. A worker or leaving machine: run it on the home it names, or finish or call off the move with `svall fleet home retry` or `abort`. Another run: try again once it ends. |
| `machine` | upgrade, upgrade --rollback, remove | The machine is in the registry with an ssh destination, or for remove one that dials in. For remove without `--forget`, no robot of a fleet here runs on it or is moving to it. An upgrade on a machine that is itself a worker of this fleet, or is leaving it, refuses here as add does; a remove refuses while this home is enrolling a worker or moving the fleet, before anything there changes. Each refuses while another add, upgrade, rollback or remove of that machine runs here. | `svall host list`; `svall host add` it. A robot there: `svall robot move <id> --machine local` for each robot it names. Run it on the home, or try again in a moment, or once the other run ends. |
| `tailscale` | add `--as-home` | This Mac's Tailscale, before anything is installed: a fleet on a server needs it on both machines. It says "Tailscale is not running on this Mac", "Tailscale on this Mac is signed out" or "this Mac has no Tailscale". | Open the Tailscale app and sign in, or install it from https://tailscale.com/download, then add the machine again. |
| `ssh` | add | An interactive ssh, so you can accept the host key and log in: "logs in". A failure says this Mac cannot log in to the destination, or that it is not reachable from this Mac, with ssh's exit and the last of what it said behind it. | `ssh <destination>` once in Terminal and complete it, then add the machine again. |
| `master` | add, upgrade, upgrade --rollback | One ssh control connection for the rest of the steps, which asks nothing: Svall needs a key ssh can use without asking, and a password gets only past the `ssh` step. It fails as "this Mac cannot log in to <host>" only for a refused login; else "<host> is not reachable from this Mac", or "<host> did not answer in 20 s". For an upgrade, with or without `--rollback`, and an add of a name already in the registry, the machine it reaches must be the one the registry names. | A refused login: install a key with `ssh-copy-id <destination>` (on a Mac, keep its passphrase in the keychain with `ssh-add --apple-use-keychain` and add `UseKeychain yes` and `AddKeysToAgent yes` to `~/.ssh/config` so ssh still finds it after a restart), then add the machine again; for an upgrade, `ssh <destination>` once in a terminal and answer what it asks. Not reachable or no answer: check that it is on and on Tailscale. A destination that now reaches another machine: point it back, or `svall host remove <name> --forget`. |
| `os` | add, upgrade | Linux on x86-64 or arm64, running Ubuntu 22.04 or newer. A release other than an LTS is a warning. | Use a supported machine ([setup](setup.md#supported-machines)). |
| `home` | add | The account's home is short enough for the fleet's hook socket there, `hooks.sock` in its fleet home, which a Unix socket path holds at 107 bytes (a home of at most 89 bytes for the private fleet). | Use an account with a shorter home ([setup](setup.md#home-paths)) and add it again. |
| `tools` | add | Tailscale, Git and systemd user services. | Run the `apt install` command the action names; without systemd the machine is not supported. |
| `space` | add | Free space in the home. Under 5 GiB is a warning. | Free space. |
| `linger` | add | Whether the account's services keep running after you log out. Off, `host add` turns it on; where the system refuses, it is a warning: the fleet's robots there stop when you log out. | Run the `sudo loginctl enable-linger <user>` the action names. |
| `release` | add, upgrade | The companion release for the machine's architecture: the one Svall.app carries or its release names, checked against the digest this Mac's release pins, or the archive `--release` names, with its signature. Where `svall` is installed there already, it refuses before anything is uploaded a machine this Mac already lists under another name ("<destination> reaches <name>, a machine already in this Mac's list"), a machine that runs a newer release, which installing would take back ("<host> runs release <there>, newer than <this>, the one this Mac would install"), and a fleet home there that serves another Mac as a worker ("<host> already serves <Mac> as a worker; remove it from <Mac> first"). | Name an archive with `--release`; an unsigned development build needs `--allow-unsigned`. A machine already in the list: `svall host upgrade <name>`, or `svall host remove <name> --forget` and add it under the new name. A newer release there: update Svall on this Mac. Another Mac's worker: on that Mac, `svall host remove <host>`. |
| `upload` | add, upgrade | Copies the companion archive to the machine. | Check free space and the link. |
| `install` | add, upgrade | The machine checks the archive against its manifest and, where a release is installed, the signers that release pins, then installs it under `~/.local/share/svall`. | Read the message; `svall host doctor <host>`. |
| `tmux` | add | The tmux the units start, on their `PATH`: the one the release brings, or for a release that carries none, the machine's. Older than 3.5 is a warning: Shift+Enter does not reach the agents. None at all stops the add. | For a release that carries none, `sudo apt install tmux`, as the action names. |
| `service` | add | The fleet's daemon unit runs. | Read the units' logs under `~/.local/share/svall/log` there. |
| `identity` | add | The machine's id, that it runs the release just installed, and that it speaks this Mac's protocol. For a name already in the registry, the id must be the one it records, which catches a machine that had no `svall` for the `master` step to ask. A machine this Mac already lists under another name, which had no `svall` for the `release` step to ask, stops here, before it is enrolled. | `ssh <destination>` and run `~/.local/bin/svall version --json` to see what it answers, then add the machine again. Another machine at the destination: point it back, or `svall host remove <name> --forget` and add it again. Another release than the one installed: its setup went back to the release it ran, as the new release's daemon did not answer. Read the daemon log there, then `svall host upgrade <name>` for a machine already in the registry, or add the machine again. A machine already in the list: `svall host upgrade <name>`, or `svall host remove <name> --forget` and add it under the new name. |
| `enrol` | add, upgrade | Stops and removes the `svall-gateway` unit an older release left there, then makes the machine a worker of this fleet: a new token on the home, and `svall worker enroll` there, which writes `worker.json` in the fleet's home there and writes its `svall-svalld@<fleet>` unit again with `--worker`, and restarts it: "joined this fleet", whose `raw` ends in "; svall-gateway.service is stopped and removed" when it removed that unit. It refuses, changing nothing, when that fleet home serves another Mac as a worker ("<host> already serves <Mac> as a worker; remove it from <Mac> first"). An upgrade enrols nothing on a machine that is this fleet's worker already (`skip`, or `ok` when it removed the gateway unit there), nor on the fleet's home that this machine serves as a worker, whose install restarted it as the home and which takes none of this machine's agent setup (`skip`), and enrols every other, one with no unit of this fleet there included. | Read the message; `svall host doctor <host>`. Another Mac's worker: on that Mac, `svall host remove <host>`. A gateway unit that would not stop: `systemctl --user status svall-gateway.service` there. |
| `limits` | add | What the fleet may use of the machine: a limit it holds is shown; with none, `--limits` or your answer in a terminal sets one. A warning when none is set and no one was asked, with the command that sets one, or when the machine refuses the limit, with why. It never stops the run. | Run the `svall host limits` command the step names, or set it under Settings → Machines. |
| `claude` | add | Claude Code on the PATH the daemon uses, its version (2.1.251 or newer), its login, and, once logged in, Svall's hooks as the machine's doctor finds them. Each finding is a warning with an action. | Install, update, log in or set up the hooks as the action says. |
| `codex` | add | The same for Codex (0.156.0 or newer). When it is not logged in, the action also says to trust Svall's hooks once with `/hooks`. | As for `claude`. |
| `opencode` | add | The same for OpenCode (2.0.22 or newer), its login a model provider's that `opencode auth list` names, with Svall's OpenCode plugin as the machine's doctor finds it. | As for `claude`. |
| `gh` | add | The GitHub CLI's login there, as the machine's doctor finds it with the daemon's PATH. Not installed or not logged in is a note, which says pull request links stay unresolved until it is, and never a thing to fix; a doctor that reports no `gh` check skips it. | Run the `sudo apt install gh` or `gh auth login` it names. |
| `versions` | add | Each agent's release there against this Mac's, as this Mac's own daemon finds it, since a move each way needs the destination's at least the source's. A difference is a warning naming the side behind. An agent below Svall's floor there is left to its own row. Skipped when this Mac's own daemon cannot be asked, as when it is not running or speaks another protocol, or when no agent CLI is left to compare. | Run the update the action names on the side behind: `claude update`, `codex update` or `opencode upgrade`. |
| `probe` | add, upgrade, upgrade --rollback | add: the machine's own fleet answers through a forwarded port from the release just installed, `svall version --json` there says this fleet runs as a worker, and tmux opens a window, on a socket of its own with the units' PATH, and closes it. upgrade, with or without `--rollback`: the machine's doctor answers with its daemon unit running, and its fleet answers from the release now current. It says "answers" or "does not answer". | An add stops here. An upgrade whose probe fails goes back to the release before (`rollback`). After `--rollback`, `svall host doctor <host>` says why. |
| `rollback` | upgrade, upgrade --rollback | Puts back the release the machine ran before, or the kept release `--rollback <release>` names: "back on <release>", "on <release>; <before> could not be put back", or, where the install replaced a release of its own name, "stays on <release>: no earlier release is kept there". The machine's own `svall setup --rollback` restarts its units and checks each fleet's daemon answers from that release. `--rollback` first refuses, changing nothing, when a fleet's `state.json` there is at a newer state schema than that release reads ("cannot go back to <release>: the fleet's state is newer than that release reads"), or, for a release whose `svall version --json` names no schema, newer than the oldest any release has read. It refuses too when that release carries no tmux and a fleet's tmux server there runs another version than the machine's own tmux, which that release would run and which cannot reach it ("cannot go back to <release>: its robots' terminals run on a tmux that release lacks"). The files and schema numbers behind a refusal are its `raw`. | `svall host doctor <host>` says why; the `raw` holds the long form, with `svall host upgrade <host> --rollback <release>` to put back another release kept there. Refused for a newer state, or for a tmux server, the machine stays on the release it runs: keep it, or go back to a release that reads that schema or carries a tmux. |
| `registry` | add, remove | Writes or drops the machine in this Mac's registry. | Check `~/.config/svall` is writable. |
| `uninstall` | remove | Skipped for a worker that dials in, which nothing here can reach, whose token goes with its record ("not reached from here; run svall uninstall on <host> to remove Svall"). Otherwise runs `svall uninstall` on the machine, once it has checked the ssh destination reaches the machine the registry names: "Svall removed". Its fleets and their files stay there. It refuses, uninstalling nothing, while a fleet home there runs robots for another Mac ("<host> also runs robots for <Mac>; uninstalling stops them too") or its `worker.json` cannot be read ("cannot tell whether <host> runs another fleet; uninstalling stops every fleet there"), as `svall uninstall` there stops every fleet on the machine. With `--forget` it is skipped: "left as it is; Svall stays on <host>". | A failure, "stopped with an error", holds the exit and what `svall uninstall` said: `ssh <destination>` and run it to see what stops it. `svall host remove <host> --forget` drops it from the list when the machine is not reachable, the destination now reaches another machine, or the machine serves another Mac too; once nothing else uses it, `ssh <destination>` and run `svall uninstall`. |
| `keys` | remove | What the `svall uninstall` there did with the keys [your agent setup](setup.md#your-agent-setup-on-the-machine) copied to the machine: "copied keys removed from <N> files", or "copied keys left in <N> files" for those it could not read or change, or left as they changed there since; each file's line is its `raw`. Listed only when that uninstall named one, after `registry`. | A warning: `ssh <destination>`, then remove them by hand from the files its `raw` names, or delete those files. |

After `registry`, `host add` and, after `enrol`, `host upgrade` list each row of [your agent setup
there](setup.md#your-agent-setup-on-the-machine) as a step `mirror:<key>`: a server or file whose keys you tick (`claude:mcp:<name>`, `claude:settings`, `codex:config`,
`opencode:config`, `claude:plugin:<name>`, `claude:marketplace:<name>`, `claude:agent:<file>`), `var:<VAR>`,
`oauth:<item>`, `runtime:<command>`,
`maconly:<agent>:<name>`, `unreadable:<path>`, or `unchecked` when this Mac's daemon could not be asked. None fails; a
warning's action says what to do: tick the box (`svall host consent`), set the variable there (`svall worker env`),
log in, install the program, or check the machine again. A row of something that will not work there yet carries a
`gap`: its `name` and `what` it lacks, as the list at the end of the run shows them.

### Doctor checks

`svall doctor` checks the machine it runs on; `svall host doctor <host>` runs the companion's doctor on that machine
and adds what only this Mac can check. A check that fails makes the command exit 1.

| Check | Where | What it checks |
| --- | --- | --- |
| `tmux` | both | tmux is there, and 3.5 or newer for Shift+Enter. |
| `node` | both | Node 24 or newer runs `svall`. |
| `claude` | both | Claude Code's login, and where robots move its version: 2.1.251 or newer. Robots move on Linux, and on a Mac whose `~/.config/svall/machines.json` lists a machine reached over ssh or cannot be read. |
| `codex` | both | Codex's version and login. |
| `opencode` | both | OpenCode's version and login: a model provider's login or key, as `opencode auth list` names it and a move's checks read it. |
| `agents` | both | No agent CLI is installed (a failure on a Mac, a warning on Linux). |
| `path` | both | `~/.local/bin` is on your PATH: "svall is not on PATH in your shell", and from `svall host doctor` "svall is not on PATH in a shell there". |
| `shims` | both | The `svall` in `~/.local/bin` runs this build. |
| `gh` | both | The GitHub CLI is logged in, for pull request links. |
| `config` | both | `fleet.json` and `node.json` parse, and no `config.json.bak` is in the way of a split. It warns of a `config.json` beside `fleet.json`, which the daemon moves aside unread as it starts. |
| `machine id` | both | `~/.config/svall/machine.json` was made on this machine's hardware (the Mac's IOPlatformUUID, Linux's `/etc/machine-id`, both kept as a hash). It warns of one copied from another machine, which gives this one that machine's id. `svall doctor --rebind`, at a terminal outside any fleet's panes, binds the file to this machine after its own hardware changed. |
| `master` | host doctor | The ssh control connection to the machine. One that does not open is the report's one row, in the words a home with no one at its ssh uses ("<home> cannot log in to <destination>" or "cannot reach"), so a run relayed for a Mac ends on it. |
| `svalld` | both | The fleet's daemon runs and answers. |
| `hook receiver` | both | The daemon's hook socket answers. |
| `hooks` | both | Claude Code's settings hold Svall's hooks. |
| `codex hooks` | both | Codex's hooks are installed, current and trusted. |
| `codex sandbox` | Linux | Where AppArmor restricts user namespaces, `codex sandbox -- true` runs. It warns when AppArmor keeps bwrap from making Codex's user namespace, so a Codex robot asks before each command, and names the commands that install Codex's AppArmor profile for bwrap. |
| `opencode plugin` | both | Svall's OpenCode plugin is installed and current, in the config folder the daemon's `XDG_CONFIG_HOME` names. |
| `systemd` | Linux | The fleet's `svall-svalld@<fleet>` unit runs. |
| `linger` | Linux, host doctor | The account's services keep running after you log out. |
| `limits` | Linux, host doctor | The cores and memory the fleet may use of the machine. A warning when a limit does not hold, with why, or when the fleet reached its memory limit since its daemon started. |
| `launchd` | Mac | The fleet's launchd agent is loaded. |
| `launchd plist` | Mac | The fleet's launchd plist runs this build. |
| `daemon node` | Mac | The Node the launchd agent runs is still there. |
| `daemon path` | both | The launchd agent's program is there and its PATH finds the agents; on Linux, the unit's PATH holds the folders your login shell finds the agents in, which setup writes. |
| `daemon env` | both | The fleet's launchd agent, or on Linux its systemd unit, has the `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` your login shell sets. |
| `doctor` | host doctor | The companion's doctor answered. |
| `release` | host doctor | The machine runs this Mac's release and protocol. |
| `worker` | host doctor | This fleet runs there as a worker, as `svall version --json` there says: its `worker.json` names the home and this fleet. It fails with the `enrol` step's refusal for a fleet home that serves another Mac. On the fleet's home, which this machine serves as a worker, it says "home of this fleet", and no rows of the agent setup follow. A worker a move left owed a re-enrol is tried again first, for up to 30 s; one that still has not joined is a warning, "has not joined … yet", with the row's reason. |
| `versions` | host doctor | Each agent there runs this Mac's release of it, as for `host add`, one below Svall's floor included. |
| `space` | host doctor | Free space in the home. |
| `home` | host doctor | The machine's home is still the one the registry records. |

`host doctor` prints its checks in the three tiers a run ends in ([above](#host-commands)), then its verdict, then the
same `mirror:<key>` rows as `host add` lists ([above](#steps)), counted on one line. They are never things to fix:
each row that names a `gap` is a part of your agent setup that will not work there yet. `--all` prints every check,
and lists each of those rows with its name, what it lacks and the one thing to do.

## Taking a worker that dials in

`svall fleet enroll-worker` on the home and `svall worker enroll` on the worker refuse in a sentence on stderr and exit
1, issuing no token and writing no `worker.json`.

| Refusal | Runs on | What to do |
| --- | --- | --- |
| Is a worker's fleet home | home | Run it on the fleet's home. |
| Not a machine id, or not enrolled for a field it names | home | Give the worker's id from `svall version --json` there, and a field as the sentence says. |
| The socket is past what a Unix socket path holds | home | Use an account whose home is as many bytes shorter as it says; a Mac on either end holds 103 bytes, Linux 107. |
| The socket holds a colon | home | Use a fleet home with none in its path. |
| Another fleet reaches the machine over ssh | home | `svall host remove <name> --forget` first: it drops that route for every fleet here, as the machine's record is the account's, and leaves the machine as it is. |
| A run without `--json` | home | Run it with `--json`: each run issues a new token, which only `worker enroll` should read, but with `--keep-token` where the home holds one. |
| The machine is the home itself | home | Give the worker's id: the home is no worker of its own fleet. |
| The name is another machine's | home | Give another `--name`, or `svall host remove` the machine holding it. |
| `--home-ssh` and `--home-socket` go together, or one is not what `worker.json` holds | worker | Give both, the destination an ssh destination and the socket the path `fleet enroll-worker` printed. |
| Not this machine's socket | worker | Run `fleet enroll-worker` again with this machine's id. |
| `--home-svall-base`, `--home-platform`, `--home-arch` and `--home-path` missing beside `--home-ssh`, or given without it | worker | Give what `fleet enroll-worker` printed. |
| `host remove` or `--forget` of a fleet's home, here or in another fleet on this account, Svall's or Svall Dev's | worker | It stays listed, as the far uninstall would stop that home. Bring that fleet back first: `svall fleet home set local` in it. |
| `host remove` or `--forget`: cannot read a fleet's `worker.json`, which may name this machine | worker | Fix that file, then remove the machine: an unreadable file holds back every machine, as it may name any of them. |
| A machine of the home's name already in this machine's registry | worker | Give `worker enroll` another `--home-name`, or `svall host remove` the one in the way. |
| Already serves another fleet's home, with a dial-out on either side | worker | `svall -p <empty fleet> worker enroll`: the new home would close every robot here it does not know. The same fleet enrols again, as after a new token. A worker its home dials follows that home's `host add` or `host upgrade`, as a fleet made anew needs. |
| `worker.json` put back after a start as a home, so its daemon holds back | worker | A new token from `svall fleet enroll-worker` on the home, then `svall worker enroll` for the same fleet, after which the daemon starts as a worker. |
| A fleet's home holding robots, fleet or repo notes, workers whose machine is in the registry, or an island, mission control included, with a description, instructions, context or notes | worker | `svall -p <empty fleet> worker enroll`: the home's first snapshot would erase them. A fleet opened once holds its first robot until that closes. A `worker.json` written by hand on such a fleet holds its daemon back for the same reason, until the file goes; one that has already started as a worker here boots whatever it holds. |
| `link.sock` holds a colon | worker | Use a fleet home with none in its path. |
| No private fleet yet | worker | `svall setup`, which owns the hooks and shims. A named fleet's launchd job is set up and loaded by the enrolment itself. |
