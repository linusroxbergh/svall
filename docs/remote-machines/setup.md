# Setting up a Linux machine

An always-on Linux machine can be a **worker** of your fleet: robots you [move there](placement.md) keep working
while your Mac sleeps. The fleet itself stays on the Mac, its **home**: islands, map, notes, phone and mission
control. A fleet can have several workers, and a machine can be a worker of several fleets. This page covers what the
machine needs, how to add it, and how to look after it.

## Supported machines

| | Mac | Linux machine |
| --- | --- | --- |
| System | macOS 15 or newer | Ubuntu LTS 22.04 or newer, x86-64 or arm64. Ubuntu 24.04 is the tested release; a release other than an LTS is a warning, and an older Ubuntu or any other system is refused. |
| Svall | The app (see the [README](../../README.md#quickstart)) | Installed by `svall host add` from the Mac. It brings its own Node and tmux and needs no clone, pnpm or build tools. |
| Services | launchd, as for any fleet | systemd user services, with lingering on so the fleet keeps running after you log out; `svall host add` turns it on |
| Tools | tmux, Git | Git, rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship (`sudo apt install git rsync`) |
| Network | Tailscale, and OpenSSH to the Linux account with a key ssh can use without asking (Tailscale SSH works); a password gets only past the first login | Tailscale |
| Agents | Claude Code 2.1.251 or newer, Codex 0.156.0 or newer and OpenCode 2.0.22 or newer, for the agents your fleet runs, each logged in on each machine | the same, each at the Mac's release or newer, since a move refuses a machine whose agent is older |

On the Mac, tmux 3.5 or newer is recommended, because Shift+Enter needs it. The Linux machine runs the tmux 3.7c Svall
brings, as Ubuntu 24.04 ships 3.4.

## Home paths

The Linux account's home need not be your home on the Mac. A move puts each of a robot's paths under the home it
leaves at the same place under the home it lands in, so `/Users/ada/code/app` on the Mac is `/home/ada/code/app` on
Linux, and `/Users/ada/code/app` again once the robot comes back. A robot's repository lands at its main checkout's
place there, as the worker's own clone. A path outside your home, such as `/Volumes/work/repo`, keeps its path.

The home path can be at most 65 bytes long, because a Unix socket Svall keeps under it holds at most 107 bytes.
`svall host add` checks it.

## Adding the machine

In the app, open Settings → Machines → **Add machine**, give the machine a name (lowercase letters, digits and dashes,
such as `studio`) and its ssh destination (such as `ada@studio`), and choose **Add machine**. From a terminal:

```sh
svall host add studio --ssh ada@studio
```

Both run the same steps and show each as it finishes:

1. **Reaching the machine.** One interactive ssh, so you can accept the host key and log in, then one control
   connection for the rest, which needs a key ssh can use without asking. From the app, ssh asks in a dialog.
2. **What the machine needs.** Ubuntu (a release other than an LTS is a warning) and its architecture, the home path,
   Tailscale, Git, rsync (older than 3.2.3 is a warning), systemd, free space (5 GiB or more) and lingering,
   which it turns on where it is off.
3. **Svall on the machine.** The Linux release matching this Mac's own release, checked against the digest this
   Mac's release pins and against its signature, copied over ssh and installed under `~/.local/share/svall` there,
   and the tmux it brings checked.
4. **Running Svall there.** `svall-svalld@private.service` as a systemd user unit, its machine id, and the release
   it answers from. Then **Worker**: the machine becomes this fleet's worker, with a token this Mac issues, and the
   unit restarts as `svalld --worker`, which accepts this Mac alone.
5. **Agent CLIs.** Claude Code, Codex and OpenCode on the machine: installed, Claude Code 2.1.251 or newer, Codex
   0.156.0 or newer and OpenCode 2.0.22 or newer, logged in (for OpenCode, `opencode auth list` names a model provider),
   and with Svall's hooks in place (for OpenCode, Svall's plugin), and for Codex a sandbox that starts, as the machine's
   own `svall doctor` finds them. Each agent is asked on the `PATH` and with the `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
   `XDG_*` folders the Svall daemon runs with, which setup takes from your login shell there. **Agent versions**
   compares each with this Mac's, as its own daemon finds it.
6. **Trying it out.** The machine's own fleet answers through a forwarded port, says it serves this fleet as a
   worker, and tmux opens and closes a window there.
7. **This Mac's list of machines.** The machine is added to this Mac's list in `~/.config/svall/machines.json`, and
   this Mac's daemon links to it.

It ends in one line: "studio is ready. Robots you move there keep working while this Mac sleeps.", or "studio needs
2 things before robots can move there", followed by them. In the app, a step that failed with nothing named to do
offers **Try again** (**Check again** after a check). Svall never runs `sudo`, never runs an agent's installer and
never copies a login, so these are yours.

In the app, each of them that is one command offers **Open terminal**: a terminal on the machine opens in the panel,
over an ssh of its own that asks nothing and forwards no ssh agent, with the command typed at its prompt. Press Return
to run it, or change it first; ⌘-click a link it prints to open it in your browser. When you exit or choose **Done**,
or close the panel with ×, the terminal hangs up and the panel checks the machine again, once it is in this Mac's
list. **Terminal** beside **Check** opens one with
nothing typed. From a terminal on the Mac, each action names the command and the machine to run it on:

- A missing package: the action names the `apt` command, as `ssh ada@studio, then sudo apt install rsync`. An rsync
  older than 3.2.3 needs a newer one, which Ubuntu 22.04 and later ship.
- Lingering the system would not turn on: `ssh ada@studio, then sudo loginctl enable-linger ada`. Svall turns it on
  itself where polkit lets an account do so, as on Ubuntu Server; a machine without polkit refuses. Without it the
  fleet's robots there stop when you log out.
- An agent not installed that no fleet on this Mac runs, as a robot's, mission control's or the scribe's agent,
  is only noted, once every fleet here has started at least once.
- An agent not installed or not logged in: `ssh ada@studio`, install it with its vendor's command and run
  `svall setup`, which writes Svall's hooks for an agent installed since, then `claude auth login`, `codex login` or
  `opencode auth login`. Claude Code prints a link and asks for the code the browser then shows. Codex's login waits
  for the browser on port 1455 of the machine: its terminal in the app forwards port 1455 of this Mac there, and
  quits saying so when another program holds that port; over your own ssh, use `ssh -L 1455:localhost:1455`, or
  `codex login --device-auth`. OpenCode runs OpenCode Zen's free models with no login. A move to the machine needs a
  model provider's login or key there, as `opencode auth list` shows, unless OpenCode on this Mac has none either.
  Codex also asks once to trust Svall's hooks: start `codex` there and choose "Trust all and continue", or trust
  them with `/hooks`.
- An agent at another release than this Mac's: the side behind, and the vendor's update to run there,
  `ssh ada@studio, then claude update`, or `on this Mac, run claude update`. `codex update` and `opencode upgrade` do
  the same for Codex and OpenCode. An update goes to the latest release, so the other machine may then be behind.
- Svall's hooks not installed, out of date, turned off or not trusted: the action names what the machine's own
  `svall doctor` says to do there.
- Codex's sandbox kept from starting by AppArmor, as on Ubuntu 24.04, where a Codex robot would ask before each
  command: the action installs the AppArmor profile that lets `bwrap` make its user namespace,
  `sudo apt install bubblewrap apparmor-profiles`, then
  `sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/` and
  `sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`, which the app types as one line for you to run
  with your own `sudo` password. A sandbox that fails for another reason names it;
  run `codex sandbox -- true` there to see it.

Adding the same machine again runs every check again and changes nothing that is already right. For another fleet,
add the machine from that fleet: `svall -p work host add studio --ssh ada@studio` makes it a worker of `work` too, with
its own `svall-svalld@work.service`.

### An API key in your shell

A move checks each agent's login in the Svall daemon's systemd environment, with the fleet's `.env` keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) added as a robot gets them, not in your shell. An agent's terminal starts
your shell, so an API key exported only in `~/.bashrc` or `~/.profile` works for the agent while the check says it is
not logged in. Put the key in the fleet's `.env`, which the checks read each time, or in
`~/.config/environment.d/agents.conf` as `NAME=value` lines and then run `systemctl --user daemon-reload` and
`systemctl --user restart svall-svalld@private`.

### The companion release

`svall host add` installs the companion matching the Mac's release exactly: a move needs the same release on both
machines. It takes the one Svall.app carries for the machine's architecture, x86-64 or arm64, checks it against the
digest the app's release pins, and checks its signature against the keys the app's release lists. The `release` step
says whether the companion is signed, and `svall host doctor` says it of the machine's release and the Mac's.

- `--release <archive>` installs that archive instead. A signed one must be signed by a key the Mac's release lists;
  `--allow-unsigned` accepts one without a signature. See [the security notes](../security/fleet-handover.md) for how
  releases are checked.
- Svall Dev runs release `dev` and carries no companion, so its worker runs one built from the same checkout as
  release `dev`: `node scripts/build-companion.mjs --out <dir> --arch x64 --version dev`, then
  `svall-dev host add studio --ssh ada@studio --release <dir>/svall-companion-dev-linux-x64.tar.gz --allow-unsigned`.

## A machine that was a fleet's gateway

A machine an earlier release made a fleet's gateway becomes its worker with **Upgrade** under Settings → Machines, or:

```sh
svall host upgrade studio
```

It installs this Mac's release there and goes on:

1. **Worker.** The fleet's unit there restarts as `svalld --worker`, a worker of this Mac, in place of the fleet's
   read-only copy.
2. **Fleets.** `fleet.json` names no gateway any more, and the machine's gateway mark in this Mac's list goes once no
   fleet on this Mac names it.
3. **Gateway.** `svall-gateway.service` is stopped and removed there. While another fleet on this Mac still names the
   machine as its gateway, the unit keeps running, and the upgrade ends with that fleet's own `host upgrade` to run.
4. **Earlier handovers.** Each folder an earlier handover copied there is named with its size, such as "22 GB from an
   earlier handover is in /home/ada/code; delete it when you no longer need it". Nothing there is deleted.

It refuses while a fleet runs on the machine, as one an earlier handover moved there does: bring it back with
`svall handover local` first. Until the upgrade, no robot of a fleet that names a gateway moves: "this fleet has a
gateway; svall host upgrade studio makes it this fleet's worker".

## Looking after it

Settings → Machines lists every machine with its ssh destination, any fleets on this Mac that still name it as their
gateway, and the release and result of its last check, each with the buttons below.

| Command | In the app | What it does |
| --- | --- | --- |
| `svall host list` | Settings → Machines | Every machine in the registry, with its id, any fleets on this Mac that name it as their gateway, and its last check. |
| `svall host doctor <name>` | Check | The machine's own checks, plus whether it runs this Mac's release, whether it serves this fleet as a worker, its free space and its home path; `host list` shows when it last ran and what it found. A check marked ✗ fails and makes it exit 1; one marked ! is a warning. It ends in the same one line as `host add`: ready, or the number of failed checks before robots can move there, with their names. A fresh Ubuntu 24.04 warns on `gh` and `path`, and where Codex is installed on `codex sandbox`; none of these stops a move. |
| `svall host upgrade <name>` | Upgrade | Installs this Mac's release there, restarts every fleet's daemon, and checks each answers from the new release. If one does not, it goes back to the release before. A machine that was a fleet's gateway then becomes its worker ([above](#a-machine-that-was-a-fleets-gateway)). On an Ubuntu older than 22.04 it installs nothing. A fleet's tmux server running through the upgrade, such as one on Ubuntu's own tmux, keeps its tmux until it ends, as at a reboot. Robots running there keep running. |
| `svall host upgrade <name> --rollback [release]` | Roll back, after an upgrade that failed | Puts the machine back on the release before, or on the kept release named, restarts its units, and checks each fleet's daemon answers from it. It refuses, changing nothing, while a fleet there keeps its state at a newer schema than that release reads, or runs a tmux server that release could not reach. |
| `svall host remove <name>` | Remove | Runs `svall uninstall` there and drops the machine from the registry and its last check from `checks.json`. It refuses while the machine is the gateway of a fleet this Mac does not own, while it owns a fleet through any gateway, and while a handover holds any fleet here open, whatever its gateway; bring each back with `svall handover local` first. The uninstall there passes only the gateway records of this Mac's fleets, so the machine still refuses for anything else, such as another Mac's fleet. Its fleets and their files stay on that machine. |
| `svall host remove <name> --forget` | Forget | Drops the machine and its last check without reaching it, when it is gone. |

After you update Svall on the Mac, run `svall host upgrade <name>`: until both machines run the same release, a move
refuses with "studio runs X, this Mac Y; upgrade it under Machines". Robots already there keep running meanwhile.

On the Linux machine itself:

- `svall setup --rollback [release]` puts the release before back, or the kept release named, restarts the units and
  checks each fleet's daemon answers from it. `svall setup` sets the machine up again from the release `current`
  names.
- `svall uninstall` refuses while the machine is a fleet's gateway, runs a fleet for its gateway, or holds a handover
  journal, since that would strand the fleet. Uninstalling a worker ends the robots that run there, so move them back
  first. `svall host remove` from the Mac checks the fleets that Mac knows of, then runs it with `--force-fleet` for
  each of them that names the machine as its gateway, so it still refuses for a fleet another Mac keeps there. To remove a machine two Macs use, bring the other Mac's fleet home and run
  `svall host remove <name> --forget` there, then `svall uninstall --force` here and
  `svall host remove <name> --forget` on the first Mac.
- Each fleet's own log is `svalld.log` in its fleet home (`~/.svall` for the private fleet), beside the units'
  logs in `~/.local/share/svall/log`.
- `systemctl --user status svall-svalld@private` shows the fleet's unit.

## What is installed where

On the Linux machine, all under the account:

- `~/.local/share/svall/releases/<version>` and `current`, the release, with the tmux the fleet's terminals run in
  (`bin/tmux`); `~/.local/bin/svall` points into it. Each install keeps the release before it, for a rollback, and
  removes older ones.
- `~/.config/systemd/user/svall-svalld@<fleet>.service`, one per fleet the machine is a worker of, running
  `svalld --worker`, and `svall-gateway.service` on a machine that is still a fleet's gateway. Each fleet's unit
  carries the `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `OPENCODE_DB` the
  account's login shell sets. Its `PATH` holds the release's `bin`, `~/.local/bin` and `~/.opencode/bin`, where
  OpenCode's installer puts it.
- `~/.config/opencode/plugins/svall.js` (under `XDG_CONFIG_HOME` when the login shell sets it), Svall's OpenCode
  plugin, when OpenCode is installed and the fleet does not turn it off.
- `~/.local/share/svall/log`, the units' logs.
- `~/.cache/svall`, where `svall host add` and `upgrade` upload and unpack a release.
- `~/.svall` (and `~/.svall-<name>`), each fleet's home there: `worker.json`, which names this Mac, the fleet and
  the token this Mac issued; `cache/docs`, a copy of the fleet's notes; `journal/`, what happened there that this Mac
  has not taken yet, and each move's journal; `mirror-overrides/`, settings of the
  machine's own that the agent configuration this Mac copies there never replaces; and the robots' tmux server,
  hooks socket and transcripts. The clones the robots work in are under the account's home, at each main checkout's
  place.

On the Mac:

- `~/.config/svall/machine.json`, this Mac's machine id, `machines.json`, the registry, and `checks.json`, each
  machine's last check. A registry that cannot be read is moved aside to `machines.json.broken-<time>` with a
  warning, and a command that then misses a machine names that copy.
- In each fleet home: `workers.json`, the token each worker was issued, and `journal/moves/`, each move's journal.
