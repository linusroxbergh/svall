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
fails. Each step's `action` is something for you to do. An add or an upgrade ends in one line, "<name> is ready. Robots
you move there keep working while this Mac sleeps." or "<name> has <N> things to fix:" with the list, then any parts
of [your agent setup](setup.md#your-agent-setup-on-the-machine) that will not work there yet; the others say what they
did or what is still to do. Each exits 1 while something is left to fix; the agent setup never stops a robot moving
there, so it leaves the exit at 0. The JSON result's `actions` are the things to fix, and its `setup` the
`mirror:<key>` steps of what will not work there.

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
| `name` | add | The machine name (lowercase letters, digits and dashes, starting with a letter, and not `local`, the alias for the machine in hand) and the ssh destination. | Pick another name, or `svall host remove` the machine that holds it. |
| `machine` | upgrade, upgrade --rollback, remove | The machine is in the registry with an ssh destination. For remove without `--forget`, no robot of a fleet here runs on it or is moving to it. | `svall host list`; `svall host add` it. A robot there: `svall robot move <id> --machine local` for each robot it names. |
| `ssh` | add | An interactive ssh, so you can accept the host key and log in. A failure names ssh's exit and the last of what it said. | `ssh <destination>` once in Terminal and complete it, then add the machine again. |
| `master` | add, upgrade, upgrade --rollback | One ssh control connection for the rest of the steps, which asks nothing: Svall needs a key ssh can use without asking, and a password gets only past the `ssh` step. For an upgrade, with or without `--rollback`, and an add of a name already in the registry, the machine it reaches must be the one the registry names. | `ssh <destination>` and see what it answers. A refused login: install a key with `ssh-copy-id <destination>`, keep its passphrase in the keychain (`ssh-add --apple-use-keychain`) and add `UseKeychain yes` and `AddKeysToAgent yes` to `~/.ssh/config` so ssh still finds it after a restart, then add the machine again. A destination that now reaches another machine: point it back, or `svall host remove <name> --forget`. |
| `os` | add, upgrade | Linux on x86-64 or arm64, running Ubuntu 22.04 or newer. A release other than an LTS is a warning. | Use a supported machine ([setup](setup.md#supported-machines)). |
| `home` | add | The account's home is short enough for the fleet's hook socket there, `hooks.sock` in its fleet home, which a Unix socket path holds at 107 bytes (a home of at most 89 bytes for the private fleet). | Use an account with a shorter home ([setup](setup.md#home-paths)) and add it again. |
| `tools` | add | Tailscale, Git and systemd user services. | Run the `apt install` command the action names; without systemd the machine is not supported. |
| `space` | add | Free space in the home. Under 5 GiB is a warning. | Free space. |
| `linger` | add | Whether the account's services keep running after you log out. Off, `host add` turns it on; where the system refuses, it is a warning: the fleet's robots there stop when you log out. | Run the `sudo loginctl enable-linger <user>` the action names. |
| `release` | add, upgrade | The companion release for the machine's architecture: the one Svall.app carries or its release names, checked against the digest this Mac's release pins, or the archive `--release` names, with its signature. Where `svall` is installed there already, it refuses before anything is uploaded a machine this Mac already lists under another name ("<destination> reaches <name>, a machine already in this Mac's list"), a machine that runs a newer release, which installing would take back ("<host> runs release <there>, newer than <this>, the one this Mac would install"), and a fleet home there that serves another Mac as a worker ("<host> already serves <Mac> as a worker; remove it from that Mac first"). | Name an archive with `--release`; an unsigned development build needs `--allow-unsigned`. A machine already in the list: `svall host upgrade <name>`, or `svall host remove <name> --forget` and add it under the new name. A newer release there: update Svall on this Mac. Another Mac's worker: on that Mac, `svall host remove <host>`. |
| `upload` | add, upgrade | Copies the companion archive to the machine. | Check free space and the link. |
| `install` | add, upgrade | The machine checks the archive against its manifest and, where a release is installed, the signers that release pins, then installs it under `~/.local/share/svall`. | Read the message; `svall host doctor <host>`. |
| `tmux` | add | The tmux the units start, on their `PATH`: the one the release brings, or for a release that carries none, the machine's. Older than 3.5 is a warning: Shift+Enter does not reach the agents. None at all stops the add. | For a release that carries none, `sudo apt install tmux`, as the action names. |
| `service` | add | The fleet's daemon unit runs. | Read the units' logs under `~/.local/share/svall/log` there. |
| `identity` | add | The machine's id, that it runs the release just installed, and that it speaks this Mac's protocol. For a name already in the registry, the id must be the one it records, which catches a machine that had no `svall` for the `master` step to ask. A machine this Mac already lists under another name, which had no `svall` for the `release` step to ask, stops here, before it is enrolled. | `ssh <destination>` and run `~/.local/bin/svall version --json` to see what it answers, then add the machine again. Another machine at the destination: point it back, or `svall host remove <name> --forget` and add it again. Another release than the one installed: its setup went back to the release it ran, as the new release's daemon did not answer. Read the daemon log there, then `svall host upgrade <name>` for a machine already in the registry, or add the machine again. A machine already in the list: `svall host upgrade <name>`, or `svall host remove <name> --forget` and add it under the new name. |
| `enrol` | add, upgrade | Stops and removes the `svall-gateway` unit an older release left there, then makes the machine a worker of this fleet: a new token on this Mac, and `svall worker enroll` there, which writes `worker.json` in the fleet's home there and writes its `svall-svalld@<fleet>` unit again with `--worker`, and restarts it. The detail ends in "; svall-gateway.service is stopped and removed" when it removed that unit. It refuses, changing nothing, when that fleet home serves another Mac as a worker ("<host> already serves <Mac> as a worker; remove it from that Mac first"). An upgrade enrols nothing on a machine that is this fleet's worker already (`skip`, or `ok` when it removed the gateway unit there), and enrols every other, one with no unit of this fleet there included. | Read the message; `svall host doctor <host>`. Another Mac's worker: on that Mac, `svall host remove <host>`. A gateway unit that would not stop: `systemctl --user status svall-gateway.service` there. |
| `claude` | add | Claude Code on the PATH the daemon uses, its version (2.1.251 or newer), its login, and, once logged in, Svall's hooks as the machine's doctor finds them. Each finding is a warning with an action. | Install, update, log in or set up the hooks as the action says. |
| `codex` | add | The same for Codex (0.156.0 or newer). When it is not logged in, the action also says to trust Svall's hooks once with `/hooks`. | As for `claude`. |
| `opencode` | add | The same for OpenCode (2.0.22 or newer), its login a model provider's that `opencode auth list` names, with Svall's OpenCode plugin as the machine's doctor finds it. | As for `claude`. |
| `gh` | add | The GitHub CLI's login there, as the machine's doctor finds it with the daemon's PATH. Not installed or not logged in is a warning that names the command to run there and has no action, so it is advice and never a thing left; a doctor that reports no `gh` check skips it. | Run the `sudo apt install gh` or `gh auth login` it names. |
| `versions` | add | Each agent's release there against this Mac's, as this Mac's own daemon finds it, since a move each way needs the destination's at least the source's. A difference is a warning naming the side behind. An agent below Svall's floor there is left to its own row. Skipped when this Mac's own daemon cannot be asked, as when it is not running or speaks another protocol, or when no agent CLI is left to compare. | Run the update the action names on the side behind: `claude update`, `codex update` or `opencode upgrade`. |
| `probe` | add, upgrade, upgrade --rollback | add: the machine's own fleet answers through a forwarded port from the release just installed, `svall version --json` there says this fleet runs as a worker, and tmux opens a window, on a socket of its own with the units' PATH, and closes it. upgrade, with or without `--rollback`: the machine's doctor answers with its daemon unit running, and its fleet answers from the release now current. | An add stops here. An upgrade whose probe fails goes back to the release before (`rollback`). After `--rollback`, read the daemon log there; the action names the release it runs now. |
| `rollback` | upgrade, upgrade --rollback | Puts back the release the machine ran before, or the kept release `--rollback <release>` names. The machine's own `svall setup --rollback` restarts its units and checks each fleet's daemon answers from that release. `--rollback` first refuses, changing nothing, when a fleet's `state.json` there is at a newer state schema than that release reads, whose daemon would then refuse to start; or, for a release whose `svall version --json` names no schema, newer than the oldest any release has read. It refuses too when that release carries no tmux and a fleet's tmux server there runs another version than the machine's own tmux, which that release would run and which cannot reach it. | Read the daemon log there; the action names the release it runs now, and when the rollback failed, `svall host upgrade <host> --rollback <release>` to put back another release kept there. Refused for a newer state, or for a tmux server, the machine stays on the release it runs: keep it, or go back to a release that reads that schema or carries a tmux. |
| `registry` | add, remove | Writes or drops the machine in this Mac's registry. | Check `~/.config/svall` is writable. |
| `uninstall` | remove | Runs `svall uninstall` on the machine, once it has checked the ssh destination reaches the machine the registry names. Its fleets and their files stay there. It refuses, uninstalling nothing, while a fleet home there serves another Mac as a worker or its `worker.json` cannot be read, as `svall uninstall` there stops every fleet on the machine. With `--forget` it is skipped and the machine is left untouched. | A failure names the exit and what `svall uninstall` said: `ssh <destination>` and run it to see what stops it. `svall host remove <host> --forget` drops the route when the machine cannot be reached, the destination now reaches another machine, or the machine serves another Mac too; once no other Mac uses it, `ssh <destination>` and run `svall uninstall`. |
| `keys` | remove | What the `svall uninstall` there did with the keys [your agent setup](setup.md#your-agent-setup-on-the-machine) copied to the machine: each file it took them out of, each it could not read or change, and each copy it left as it changed there since. Listed only when that uninstall named one, after `registry`. | A warning: `ssh <destination>` and take the keys the mirror copied out of the files it names, or delete those files. |

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
| `path` | both | `~/.local/bin` is on your PATH. |
| `shims` | both | The `svall` in `~/.local/bin` runs this build. |
| `gh` | both | The GitHub CLI is logged in, for pull request links. |
| `config` | both | `fleet.json` and `node.json` parse, and no `config.json.bak` is in the way of a split. It warns of a `config.json` beside `fleet.json`, which the daemon moves aside unread as it starts. |
| `machine id` | both | `~/.config/svall/machine.json` was made on this machine's hardware (the Mac's IOPlatformUUID, Linux's `/etc/machine-id`, both kept as a hash). It warns of one copied from another machine, which gives this one that machine's id. `svall doctor --rebind`, at a terminal outside any fleet's panes, binds the file to this machine after its own hardware changed. |
| `svalld` | both | The fleet's daemon runs and answers. |
| `hook receiver` | both | The daemon's hook socket answers. |
| `hooks` | both | Claude Code's settings hold Svall's hooks. |
| `codex hooks` | both | Codex's hooks are installed, current and trusted. |
| `codex sandbox` | Linux | Where AppArmor restricts user namespaces, `codex sandbox -- true` runs. It warns when AppArmor keeps bwrap from making Codex's user namespace, so a Codex robot asks before each command, and names the commands that install Codex's AppArmor profile for bwrap. |
| `opencode plugin` | both | Svall's OpenCode plugin is installed and current, in the config folder the daemon's `XDG_CONFIG_HOME` names. |
| `systemd` | Linux | The fleet's `svall-svalld@<fleet>` unit runs. |
| `linger` | Linux, host doctor | The account's services keep running after you log out. |
| `launchd` | Mac | The fleet's launchd agent is loaded. |
| `launchd plist` | Mac | The fleet's launchd plist runs this build. |
| `daemon node` | Mac | The Node the launchd agent runs is still there. |
| `daemon path` | Mac | The launchd agent's program is there and its PATH finds the agents. |
| `daemon env` | both | The fleet's launchd agent, or on Linux its systemd unit, has the `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` your login shell sets. |
| `doctor` | host doctor | The companion's doctor answered. |
| `release` | host doctor | The machine runs this Mac's release and protocol. |
| `worker` | host doctor | This fleet runs there as a worker, as `svall version --json` there says: its `worker.json` names this Mac and this fleet. It fails with the `enrol` step's refusal for a fleet home that serves another Mac. |
| `versions` | host doctor | Each agent there runs this Mac's release of it, as for `host add`, one below Svall's floor included. |
| `space` | host doctor | Free space in the home. |
| `home` | host doctor | The machine's home is still the one the registry records. |

`host doctor` ends with the same `mirror:<key>` rows as `host add` lists ([above](#steps)). They are never things to
fix: each row that names a `gap` is a part of your agent setup that will not work there yet, listed after the things
to fix with its name, what it lacks and the one thing to do.
